use crate::{
    process::{self, Tracker},
    profile, proxy, settings, store,
};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::Manager;

const BRIDGE_EXTENSION_DIR: &str = "bridge-extension";

/// Launch result: OS pid plus CDP endpoint when remote-debugging is on.
pub struct LaunchOutcome {
    pub pid: u32,
    pub cdp: Option<process::CdpInfo>,
}

/// Resolve the BrProxies browser executable from settings, runtime cache, or dev guess.
pub fn resolve_binary() -> Result<PathBuf> {
    if let Some(p) = settings::load()?.browser_path {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Ok(pb);
        }
    }
    if let Ok(pb) = crate::runtime::binary_path() {
        if pb.exists() {
            return Ok(pb);
        }
    }
    #[cfg(target_os = "macos")]
    let guess = "/Users/kritos/Documents/GitHub/BrProxiesBrowser/build/src/out/Release_GN_arm64/BrProxies.app/Contents/MacOS/BrProxies";
    #[cfg(target_os = "windows")]
    let guess = "C:\\Program Files\\BrProxies\\BrProxies.exe";
    #[cfg(target_os = "linux")]
    let guess = "/opt/brproxies/brproxies";
    let pb = PathBuf::from(guess);
    if pb.exists() {
        return Ok(pb);
    }
    anyhow::bail!("BrProxies browser not installed yet - open Settings to download, or configure Browser path manually")
}

fn resolve_bridge_extension_dir() -> Result<PathBuf> {
    let resource_root = crate::app_handle().and_then(|app| app.path().resource_dir().ok());
    let executable_root = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let dev_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("extension");

    resolve_bridge_extension_dir_from(
        resource_root.as_deref(),
        executable_root.as_deref(),
        &dev_root,
    )
}

fn resolve_bridge_extension_dir_from(
    resource_root: Option<&Path>,
    executable_root: Option<&Path>,
    dev_root: &Path,
) -> Result<PathBuf> {
    let candidates = resource_root
        .into_iter()
        .map(|root| root.join(BRIDGE_EXTENSION_DIR))
        .chain(
            executable_root
                .into_iter()
                .map(|root| root.join(BRIDGE_EXTENSION_DIR)),
        )
        .chain(std::iter::once(dev_root.to_path_buf()));

    for candidate in candidates {
        if candidate.join("manifest.json").is_file() {
            return Ok(candidate);
        }
    }

    anyhow::bail!(
        "BrProxies Bridge files are missing; reinstall BrProxies or disable BrProxies Bridge for this profile"
    )
}

pub async fn launch_profile(
    profile_id: &str,
    enable_cdp: bool,
    headless: bool,
) -> Result<LaunchOutcome> {
    let bin = resolve_binary()?;
    let stored = profile::load_raw(profile_id)?;
    let udd = profile::user_data_dir(profile_id)?;

    // Stored proxy by id, else ephemeral inline (quick profiles, not in store).
    let bound_proxy: Option<proxy::ProxyEntry> = stored
        .meta
        .proxy_id
        .as_deref()
        .and_then(|pid| proxy::get(pid).ok().flatten())
        .or_else(|| stored.meta.inline_proxy.clone());

    // Live UDP probe; QUIC/WebRTC gating uses current capability not stale cache.
    let proxy_udp_ok = if let Some(p) = bound_proxy.as_ref() {
        if matches!(p.kind, proxy::ProxyKind::Socks5) {
            match proxy::probe_udp(p).await {
                Ok(ms) => {
                    eprintln!("[launcher] UDP relay OK ({ms} ms) for proxy {}", p.host);
                    true
                }
                Err(e) => {
                    let cached = proxy::latest_test(&p.id).and_then(|s| s.udp_ms).is_some();
                    eprintln!(
                        "[launcher] UDP probe failed for proxy {} ({e}); using cached={cached}",
                        p.host
                    );
                    cached
                }
            }
        } else {
            false
        }
    } else {
        false
    };

    // Strip `_meta` wrapper and resolve "auto" sentinels before serialising.
    let mut raw = stored.config.clone();
    raw.remove("_meta");
    resolve_auto_fields(&mut raw, bound_proxy.as_ref()).await;
    let json = serde_json::to_string(&raw).context("serialize profile")?;

    // Pass fingerprint by file path — inline JSON overflows Windows' 32767-char CreateProcess limit.
    let fp_file = udd.join("fingerprint.json");
    std::fs::write(&fp_file, &json).context("write fingerprint.json")?;

    // Pre-warm Widevine CDM to avoid first-DRM-page component-updater stall.
    if let Err(e) = install_widevine(&udd) {
        eprintln!("[launcher] widevine pre-warm skipped: {e}");
    }

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg(format!("--fingerprint-profile={}", fp_file.display()));
    cmd.arg(format!("--user-data-dir={}", udd.display()));
    cmd.arg("--no-first-run");

    // Disable WebGPU when profile omits `webgpu` (matches real Linux Chrome).
    let webgpu_present = raw.get("webgpu").map(|v| !v.is_null()).unwrap_or(false);
    if !webgpu_present {
        cmd.arg("--disable-features=WebGPU");
    }

    // Interactive launches: suppress crash bubble. Do not restore the previous
    // session because the patched browser injects its upstream welcome tab.
    if !headless && !enable_cdp {
        cmd.arg("--hide-crash-restore-bubble");
        if stored.meta.bridge_enabled {
            let extension_dir = resolve_bridge_extension_dir()?;
            if bridge_profile_needs_load(&udd, &extension_dir)? {
                cmd.arg(format!("--load-extension={}", extension_dir.display()));
                eprintln!("[launcher] BrProxies Bridge update/load: {}", extension_dir.display());
            } else {
                eprintln!("[launcher] BrProxies Bridge already current; skipping duplicate load");
            }
        }
    }

    if let Some(p) = bound_proxy.as_ref() {
        cmd.arg(format!("--proxy-server={}", p.to_proxy_server_arg()));

        // QUIC: enable only when proxy UDP relay verified; rely on Alt-Svc upgrade path.
        if proxy_udp_ok {
            cmd.arg("--enable-quic");
            eprintln!(
                "[launcher] QUIC enabled (Alt-Svc upgrade path): proxy {} UDP relay verified",
                p.host
            );
        } else {
            cmd.arg("--disable-quic");
            eprintln!(
                "[launcher] QUIC disabled: proxy {} has no working UDP relay",
                p.host
            );
        }
    }

    // WebRTC IP policy: block / tcp_only / auto (auto = relay if UDP, else tcp_only).
    let webrtc_mode = raw.get("webrtc").and_then(|v| v.as_str()).unwrap_or("auto");
    let latest = bound_proxy.as_ref().and_then(|p| proxy::latest_test(&p.id));
    // Live geo for ICE-candidate spoofing, cached snapshot as fallback.
    let proxy_public_ip: Option<String> = if let Some(p) = bound_proxy.as_ref() {
        match proxy::geo_check(p, None).await {
            Ok(g) if !g.ip.is_empty() => Some(g.ip),
            _ => latest
                .as_ref()
                .map(|s| s.ip.clone())
                .filter(|ip| !ip.is_empty()),
        }
    } else {
        None
    };
    match webrtc_mode {
        "block" => {
            cmd.arg("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
            cmd.arg("--shardx-webrtc-policy=block");
            eprintln!("[launcher] WebRTC blocked (servers stripped, relay-only, UDP off)");
        }
        "tcp_only" => {
            cmd.arg("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
            cmd.arg("--shardx-webrtc-policy=tcp_only");
            if let Some(ip) = proxy_public_ip.as_deref() {
                cmd.arg(format!("--shardx-webrtc-public-ip={ip}"));
            }
            eprintln!("[launcher] WebRTC: TCP-only (servers stripped, mDNS host only, UDP off)");
        }
        _ => {
            if bound_proxy.is_none() {
                // No proxy bound — let WebRTC use the host network natively
                // (real IP shows in ICE candidates, which is what the user wants
                // when they explicitly didn't bind a proxy).
                eprintln!("[launcher] WebRTC auto -> native (no proxy bound)");
            } else if !proxy_udp_ok {
                cmd.arg("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
                cmd.arg("--shardx-webrtc-policy=tcp_only");
                if let Some(ip) = proxy_public_ip.as_deref() {
                    cmd.arg(format!("--shardx-webrtc-public-ip={ip}"));
                }
                eprintln!("[launcher] WebRTC auto -> TCP-only (no proxied UDP available)");
            } else {
                eprintln!("[launcher] WebRTC auto -> through proxy UDP relay");
            }
        }
    }

    // Screen resolution mode: presence-only switch to use host monitor.
    let s = settings::load()?;
    if s.screen_resolution_mode.as_deref() == Some("real") {
        cmd.arg("--shardx-real-screen");
    }

    // CDP: port=0 makes Chrome pick free port and write DevToolsActivePort.
    if enable_cdp {
        let _ = std::fs::remove_file(udd.join("DevToolsActivePort"));
        cmd.arg("--remote-debugging-port=0");
        cmd.arg("--remote-allow-origins=*");

        // Automation runs (Account Keeper) never use browser extensions, and on
        // Windows the engine picks up externally-registered extensions from the
        // registry (e.g. "Application Launcher For Drive"). Those inject content
        // scripts into every page — breaking fingerprint isolation and stalling
        // SPA renders the flow waits on (surfaced as navigation_failed). Block
        // all extension loading for the automation session. This is session-only
        // (no policy/registry writes) and does not touch interactive launches,
        // where the user may deliberately install extensions into the profile.
        cmd.arg("--disable-extensions");
    }

    if headless {
        cmd.arg("--headless=new");
    }

    if !headless && !enable_cdp {
        cmd.arg("chrome://newtab//");
    }

    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // 0x08000000 = CREATE_NO_WINDOW — suppress the brief console flash
        // when a Tauri GUI app spawns the engine binary.
        cmd.creation_flags(0x08000000);
    }
    let child = cmd.spawn().context("spawn BrProxies browser")?;
    let pid = Tracker::shared().track(profile_id.to_string(), child, stored.meta.temporary);

    profile::touch_launched(profile_id, None)?;

    let cdp = if enable_cdp {
        match read_devtools_endpoint(&udd).await {
            Some(c) => {
                eprintln!(
                    "[launcher] CDP ready for {profile_id}: {}",
                    c.web_socket_debugger_url
                );
                Tracker::shared().set_cdp(profile_id, c.clone());
                Some(c)
            }
            None => {
                eprintln!("[launcher] CDP: DevToolsActivePort not found within timeout");
                None
            }
        }
    } else {
        None
    };

    Ok(LaunchOutcome { pid, cdp })
}

fn bridge_profile_needs_load(user_data_dir: &Path, source_dir: &Path) -> Result<bool> {
    let Ok(source_manifest) = std::fs::read_to_string(source_dir.join("manifest.json")) else { return Ok(true) };
    let Ok(source) = serde_json::from_str::<serde_json::Value>(&source_manifest) else { return Ok(true) };
    let source_name = source.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let source_version = source.get("version").and_then(|v| v.as_str()).unwrap_or("");
    let source_path = source_dir.canonicalize().unwrap_or_else(|_| source_dir.to_path_buf());
    let profile_name = std::fs::read_to_string(user_data_dir.join("Local State"))
        .ok()
        .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
        .and_then(|value| value.get("profile")?.get("last_used")?.as_str().map(str::to_string))
        .unwrap_or_else(|| "Default".to_string());
    let profile_dir = user_data_dir.join(profile_name);
    let mut current_bridge_found = false;
    for filename in ["Preferences", "Secure Preferences"] {
        let Ok(body) = std::fs::read_to_string(profile_dir.join(filename)) else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) else { continue };
        let Some(settings) = value.pointer("/extensions/settings").and_then(|v| v.as_object()) else { continue };
        for item in settings.values() {
            if let Some(path) = item.get("path").and_then(|v| v.as_str()).filter(|p| Path::new(p).exists()) {
                let installed_path = Path::new(path).canonicalize().unwrap_or_else(|_| PathBuf::from(path));
                let installed_manifest = std::fs::read_to_string(installed_path.join("manifest.json"))
                    .ok().and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok());
                let installed_name = item.pointer("/manifest/name").and_then(|v| v.as_str())
                    .or_else(|| installed_manifest.as_ref().and_then(|v| v.get("name").and_then(|v| v.as_str())))
                    .unwrap_or("");
                let installed_version = item.pointer("/manifest/version").and_then(|v| v.as_str())
                    .or_else(|| installed_manifest.as_ref().and_then(|v| v.get("version").and_then(|v| v.as_str())))
                    .unwrap_or("");
                if installed_path != source_path && installed_name == source_name
                    && compare_versions(installed_version, source_version) < std::cmp::Ordering::Equal {
                    // Unpacked extension IDs depend on their path. Loading the new
                    // directory cannot replace an older identity at another path.
                    // Do not edit Chrome's protected preferences or external files.
                    anyhow::bail!("An older BrProxies Bridge is installed at another location. Disable Bridge auto-load for this profile, launch it, remove the old Bridge at chrome://extensions, then close it and enable Bridge auto-load again.");
                }
                if installed_path == source_path || (installed_name == source_name && compare_versions(installed_version, source_version) >= std::cmp::Ordering::Equal) {
                    current_bridge_found = true;
                }
            }
        }
    }
    Ok(!current_bridge_found)
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parse = |v: &str| v.split('.').map(|part| part.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let mut a = parse(left); let mut b = parse(right);
    a.resize(4, 0); b.resize(4, 0); a.cmp(&b)
}

/// Poll `<udd>/DevToolsActivePort` for ~6s; line 1 = port, line 2 = ws path.
async fn read_devtools_endpoint(udd: &Path) -> Option<process::CdpInfo> {
    let file = udd.join("DevToolsActivePort");
    for _ in 0..60 {
        if let Ok(txt) = std::fs::read_to_string(&file) {
            let mut lines = txt.lines();
            if let (Some(port_s), Some(path)) = (lines.next(), lines.next()) {
                if let Ok(port) = port_s.trim().parse::<u16>() {
                    return Some(process::CdpInfo {
                        port,
                        http_url: format!("http://127.0.0.1:{port}"),
                        web_socket_debugger_url: format!("ws://127.0.0.1:{port}{}", path.trim()),
                    });
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    None
}

/// Resolve "auto" sentinels in profile JSON; with proxy: live → cached → country tag → host warn.
async fn resolve_auto_fields(
    cfg: &mut serde_json::Map<String, serde_json::Value>,
    proxy_opt: Option<&proxy::ProxyEntry>,
) {
    let want_tz_auto = cfg.get("timezone").and_then(|v| v.as_str()) == Some("auto");
    let want_lang_auto = cfg
        .get("navigator")
        .and_then(|n| n.get("language"))
        .and_then(|v| v.as_str())
        == Some("auto");
    let want_geo_auto = matches!(
        cfg.get("geolocation")
            .and_then(|g| g.get("mode"))
            .and_then(|v| v.as_str()),
        Some("auto")
    );

    if !(want_tz_auto || want_lang_auto || want_geo_auto) {
        return;
    }

    eprintln!(
        "[launcher] resolving auto fields (tz={} lang={} geo={} proxy={})",
        want_tz_auto,
        want_lang_auto,
        want_geo_auto,
        proxy_opt
            .map(|p| format!("{}:{}", p.host, p.port))
            .unwrap_or_else(|| "(direct)".into()),
    );

    // ---- geo source ----
    let mut source = "";
    let geo: Option<proxy::GeoInfo> = match proxy_opt {
        Some(p) => match proxy::geo_check_via(Some(p), None).await {
            Ok(g) => {
                source = "proxy-live";
                Some(g)
            }
            Err(e) => {
                eprintln!("[launcher] proxy geo failed: {e} — falling back to cached snapshot");
                if let Some(snap) = proxy::latest_test(&p.id) {
                    if !snap.country_code.is_empty() || !snap.timezone.is_empty() {
                        source = "cached-snapshot";
                        Some(proxy::GeoInfo {
                            ip: snap.ip,
                            country: snap.country,
                            country_code: snap.country_code,
                            region: snap.region,
                            city: snap.city,
                            isp: snap.isp,
                            timezone: snap.timezone,
                            latitude: snap.latitude,
                            longitude: snap.longitude,
                            provider: snap.provider,
                        })
                    } else {
                        None
                    }
                } else {
                    None
                }
                .or_else(|| {
                    if !p.country.is_empty() {
                        source = "country-tag";
                        Some(proxy::GeoInfo {
                            ip: String::new(),
                            country: String::new(),
                            country_code: p.country.clone(),
                            region: String::new(),
                            city: String::new(),
                            isp: String::new(),
                            timezone: String::new(),
                            latitude: 0.0,
                            longitude: 0.0,
                            provider: String::new(),
                        })
                    } else {
                        None
                    }
                })
            }
        },
        None => match proxy::geo_check_via(None, None).await {
            Ok(g) => {
                source = "direct-live";
                Some(g)
            }
            Err(e) => {
                eprintln!("[launcher] direct geo failed: {e} — falling back to host TZ/locale");
                None
            }
        },
    };

    let host_warn = || {
        if proxy_opt.is_some() {
            eprintln!(
                "[launcher] WARNING: proxy is bound but every geo source failed; \
                 using the LAUNCHER HOST's TZ/locale.  This will leak your real \
                 timezone — re-test the proxy or set the timezone manually."
            );
        }
    };

    // ---- concrete tz/locale/lat/lng ----
    let (resolved_tz, resolved_locale, resolved_lat, resolved_lng) = match geo {
        Some(ref g) => {
            let tz = if !g.timezone.is_empty() {
                g.timezone.clone()
            } else {
                proxy::country_to_timezone(&g.country_code).to_string()
            };
            let locale = proxy::country_to_locale(&g.country_code).to_string();
            let lat = if g.latitude != 0.0 {
                Some(g.latitude)
            } else {
                None
            };
            let lng = if g.longitude != 0.0 {
                Some(g.longitude)
            } else {
                None
            };
            (tz, locale, lat, lng)
        }
        None => {
            host_warn();
            (
                host_timezone().unwrap_or_else(|| "UTC".into()),
                host_locale().unwrap_or_else(|| "en-US".into()),
                None,
                None,
            )
        }
    };

    eprintln!("[launcher] resolved tz={resolved_tz} locale={resolved_locale} (source={source})");

    if want_tz_auto {
        cfg.insert(
            "timezone".into(),
            serde_json::Value::String(resolved_tz.clone()),
        );
    }

    if want_lang_auto {
        let base = resolved_locale
            .split('-')
            .next()
            .unwrap_or(&resolved_locale)
            .to_string();
        let accept = if resolved_locale == "en-US" {
            "en-US,en;q=0.9".to_string()
        } else {
            format!("{resolved_locale},{base};q=0.9,en-US;q=0.8,en;q=0.7")
        };
        let languages = if resolved_locale == "en-US" {
            vec![
                serde_json::Value::String("en-US".into()),
                serde_json::Value::String("en".into()),
            ]
        } else {
            vec![
                serde_json::Value::String(resolved_locale.clone()),
                serde_json::Value::String(base),
                serde_json::Value::String("en-US".into()),
                serde_json::Value::String("en".into()),
            ]
        };
        if let Some(nav) = cfg.get_mut("navigator").and_then(|v| v.as_object_mut()) {
            nav.insert(
                "language".into(),
                serde_json::Value::String(resolved_locale.clone()),
            );
            nav.insert("accept_language".into(), serde_json::Value::String(accept));
            nav.insert("languages".into(), serde_json::Value::Array(languages));
        }
        // Always overwrite icu_locale so it matches resolved navigator.language.
        cfg.insert(
            "icu_locale".into(),
            serde_json::Value::String(resolved_locale),
        );
    }

    if want_geo_auto {
        if let (Some(lat), Some(lng)) = (resolved_lat, resolved_lng) {
            cfg.insert(
                "geolocation".into(),
                serde_json::json!({
                    "mode": "manual",
                    "latitude": lat,
                    "longitude": lng,
                    "accuracy": 50.0,
                }),
            );
        } else {
            cfg.remove("geolocation");
        }
    }
}

/// Copy cached Widevine CDM into `<udd>/WidevineCdm/<version>/` (versioned layout
/// required by Chromium's DefaultComponentInstaller). No-op if cache absent.
fn install_widevine(udd: &Path) -> Result<()> {
    let src = store::widevine_cache_dir()?;
    if !src.exists() {
        anyhow::bail!("cache dir absent ({})", src.display());
    }
    let manifest_path = src.join("manifest.json");
    if !manifest_path.exists() {
        anyhow::bail!("cache missing manifest.json — re-seed from a real Chrome");
    }
    let manifest_text = std::fs::read_to_string(&manifest_path)?;
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest_text).context("parse widevine manifest.json")?;
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("widevine manifest missing `version`"))?;

    let widevine_root = udd.join("WidevineCdm");
    let versioned = widevine_root.join(version);
    if versioned.exists() {
        return Ok(());
    }
    // Clean up any stale flat layout from older launcher versions.
    let flat_manifest = widevine_root.join("manifest.json");
    if flat_manifest.exists() {
        for stray in ["manifest.json", "LICENSE", "_platform_specific"] {
            let p = widevine_root.join(stray);
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            } else if p.exists() {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    copy_dir_recursive(&src, &versioned)
        .with_context(|| format!("copy {} → {}", src.display(), versioned.display()))?;
    // Chromium reads this single-line marker on startup.
    std::fs::write(
        widevine_root.join("latest-component-updated-version"),
        version,
    )?;
    eprintln!("[launcher] widevine pre-warmed: {}", versioned.display());
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ty.is_symlink() {
            // Resolve symlinks so dst tree stays portable across hosts.
            let target = std::fs::read_link(&from)?;
            let resolved = if target.is_absolute() {
                target
            } else {
                from.parent().unwrap().join(target)
            };
            if resolved.is_dir() {
                copy_dir_recursive(&resolved, &to)?;
            } else {
                std::fs::copy(&resolved, &to)?;
            }
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Read host TZ from /etc/localtime symlink, fall back to $TZ.
fn host_timezone() -> Option<String> {
    if let Ok(target) = std::fs::read_link("/etc/localtime") {
        let path = target.to_string_lossy().into_owned();
        for prefix in ["/usr/share/zoneinfo/", "/var/db/timezone/zoneinfo/"] {
            if let Some(tz) = path.strip_prefix(prefix) {
                return Some(tz.to_string());
            }
        }
    }
    std::env::var("TZ").ok().filter(|s| !s.is_empty())
}

/// Extract BCP-47 locale from $LANG/$LC_ALL ("en_US.UTF-8" → "en-US").
fn host_locale() -> Option<String> {
    for var in ["LANG", "LC_ALL", "LC_MESSAGES"] {
        if let Ok(v) = std::env::var(var) {
            let stripped = v.split('.').next().unwrap_or("").replace('_', "-");
            if stripped.contains('-') {
                return Some(stripped);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::resolve_bridge_extension_dir_from;

    #[test]
    fn older_bridge_at_another_path_requires_explicit_migration() {
        let root = temp_root("bridge-upgrade");
        let source = root.join("bundled");
        let old = root.join("old");
        let profile = root.join("user/Default");
        for dir in [&source, &old, &profile] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(source.join("manifest.json"), r#"{"name":"BrProxies Bridge","version":"0.3.2"}"#).unwrap();
        let prefs = serde_json::json!({"extensions":{"settings":{"old-id":{
            "path":old,"state":1,"manifest":{"name":"BrProxies Bridge","version":"0.3.0"}
        }}}});
        std::fs::write(profile.join("Preferences"), prefs.to_string()).unwrap();
        let result = super::bridge_profile_needs_load(&root.join("user"), &source);
        std::fs::remove_dir_all(&root).unwrap();
        assert!(result.is_err(), "must not add a second unpacked extension identity");
        assert!(result.unwrap_err().to_string().contains("chrome://extensions"));
    }

    #[test]
    fn bridge_load_decision_preserves_current_and_unrelated_extensions() {
        let root = temp_root("bridge-load");
        let source = root.join("bundled");
        let installed = root.join("installed");
        let user = root.join("user");
        let profile = user.join("Profile 2");
        for dir in [&source, &installed, &profile] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(source.join("manifest.json"), r#"{"name":"BrProxies Bridge","version":"0.3.2"}"#).unwrap();
        std::fs::write(user.join("Local State"), r#"{"profile":{"last_used":"Profile 2"}}"#).unwrap();
        assert!(super::bridge_profile_needs_load(&user, &source).unwrap());
        for (path, name, version, want_load) in [
            (&source, "BrProxies Bridge", "0.3.1", false),
            (&installed, "BrProxies Bridge", "0.3.2", false),
            (&installed, "BrProxies Bridge", "0.4.0", false),
            (&installed, "Other extension", "0.1.0", true),
        ] {
            let prefs = serde_json::json!({"extensions":{"settings":{"id":{
                "path":path,"manifest":{"name":name,"version":version}
            }}}});
            let file = profile.join("Secure Preferences");
            std::fs::write(&file, prefs.to_string()).unwrap();
            assert_eq!(super::bridge_profile_needs_load(&user, &source).unwrap(), want_load);
            assert_eq!(std::fs::read_to_string(&file).unwrap(), prefs.to_string());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    fn temp_root(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("brproxies-{label}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn bundled_bridge_wins_over_development_copy() {
        let root = temp_root("bridge-resolve");
        let resource_root = root.join("resources");
        let bundled = resource_root.join("bridge-extension");
        let dev = root.join("extension");
        std::fs::create_dir_all(&bundled).expect("create bundled bridge dir");
        std::fs::create_dir_all(&dev).expect("create development bridge dir");
        std::fs::write(bundled.join("manifest.json"), "{}").expect("write bundled manifest");
        std::fs::write(dev.join("manifest.json"), "{}").expect("write development manifest");

        let resolved = resolve_bridge_extension_dir_from(Some(&resource_root), None, &dev)
            .expect("resolve bundled bridge");

        assert_eq!(resolved, bundled);
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn missing_bridge_has_an_actionable_error() {
        let root = temp_root("bridge-missing");
        let error = resolve_bridge_extension_dir_from(None, None, &root)
            .expect_err("missing bridge should fail")
            .to_string();

        assert!(error.contains("disable BrProxies Bridge"));
    }
}
