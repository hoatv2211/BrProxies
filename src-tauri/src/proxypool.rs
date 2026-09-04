use crate::{settings, store};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Manager;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static REDIS_CHILD: OnceLock<Mutex<Option<ManagedRedisChild>>> = OnceLock::new();

fn child_slot() -> &'static Mutex<Option<Child>> {
    CHILD.get_or_init(|| Mutex::new(None))
}

fn redis_child_slot() -> &'static Mutex<Option<ManagedRedisChild>> {
    REDIS_CHILD.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Clone, Serialize)]
pub struct ProxyPoolStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub base_url: String,
    pub config_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProxyPoolSourceCreate {
    pub id: String,
    pub url: String,
    pub parser: String,
}

fn base_url(s: &settings::Settings) -> String {
    format!("http://{}:{}", s.proxypool_host, s.proxypool_port)
}

fn status_with(s: &settings::Settings, child: Option<&Child>) -> Result<ProxyPoolStatus, String> {
    Ok(ProxyPoolStatus {
        running: child.is_some(),
        pid: child.and_then(|c| c.id()),
        base_url: base_url(s),
        config_path: store::proxypool_config_path()
            .map_err(|e| e.to_string())?
            .display()
            .to_string(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SidecarLaunch {
    program: PathBuf,
    args: Vec<String>,
    working_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalRedisSpec {
    host: String,
    port: u16,
    sidecar_url: String,
}

struct ManagedRedisChild {
    child: Child,
    host: String,
    port: u16,
}

struct LocalRedisOutcome {
    managed_url: Option<String>,
    started_now: bool,
}

fn source_service_workdir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("proxypool_service"))
        .unwrap_or_else(|| PathBuf::from("proxypool_service"))
}

fn resolve_bundled_sidecar_from(
    resource_root: &Path,
    config_path: &Path,
) -> Result<SidecarLaunch, String> {
    let working_dir = resource_root.join("proxypool");
    let program = if cfg!(target_os = "windows") {
        working_dir.join("brproxies-proxypool.exe")
    } else {
        working_dir.join("brproxies-proxypool")
    };
    if !program.is_file() {
        return Err(format!(
            "bundled ProxyPool sidecar is missing at {}; reinstall BrProxies",
            program.display()
        ));
    }
    Ok(SidecarLaunch {
        program,
        args: vec![
            "serve".to_string(),
            "--config".to_string(),
            config_path.display().to_string(),
        ],
        working_dir,
    })
}

fn resolve_bundled_redis_from(resource_root: &Path) -> Result<PathBuf, String> {
    let server = resource_root
        .join("proxypool")
        .join("redis")
        .join("redis-server.exe");
    if !server.is_file() {
        return Err(format!(
            "bundled ProxyPool Redis is missing at {}; reinstall BrProxies",
            server.display()
        ));
    }
    Ok(server)
}

fn parse_local_redis_url(value: &str) -> Option<LocalRedisSpec> {
    let mut parsed = url::Url::parse(value).ok()?;
    if parsed.scheme() != "redis" {
        return None;
    }
    let host = parsed.host_str()?.to_string();
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1") {
        return None;
    }
    let port = parsed.port().unwrap_or(6379);
    parsed.set_password(None).ok()?;
    parsed.set_username("").ok()?;
    Some(LocalRedisSpec {
        host,
        port,
        sidecar_url: parsed.to_string(),
    })
}

fn python_launch(
    program: impl Into<PathBuf>,
    prefix_args: Vec<String>,
    config_path: &Path,
) -> SidecarLaunch {
    let working_dir = source_service_workdir();
    let mut args = prefix_args;
    args.extend([
        "-m".to_string(),
        "proxypool_service".to_string(),
        "serve".to_string(),
        "--config".to_string(),
        config_path.display().to_string(),
    ]);
    SidecarLaunch {
        program: program.into(),
        args,
        working_dir,
    }
}

fn sidecar_attempts(
    resource_root: Option<&Path>,
    config_path: &Path,
) -> Result<Vec<SidecarLaunch>, String> {
    let mut attempts = Vec::new();
    if let Ok(python) = std::env::var("PROXYPOOL_PYTHON") {
        if !python.trim().is_empty() {
            attempts.push(python_launch(python, Vec::new(), config_path));
        }
    }

    if let Some(root) = resource_root {
        match resolve_bundled_sidecar_from(root, config_path) {
            Ok(launch) => attempts.push(launch),
            Err(error)
                if cfg!(target_os = "windows")
                    && !cfg!(debug_assertions)
                    && attempts.is_empty() =>
            {
                return Err(error)
            }
            Err(_) => {}
        }
    } else if cfg!(target_os = "windows") && !cfg!(debug_assertions) && attempts.is_empty() {
        return Err("ProxyPool resource directory is unavailable; reinstall BrProxies".to_string());
    }

    // Keep the source/Python fallback for dev and non-Windows targets. A
    // Windows release must use the bundled executable so it never guesses a
    // working directory that is absent from the installed app.
    if cfg!(debug_assertions) || !cfg!(target_os = "windows") {
        let workdir = source_service_workdir();
        let venv_python = if cfg!(target_os = "windows") {
            workdir.join(".venv").join("Scripts").join("python.exe")
        } else {
            workdir.join(".venv").join("bin").join("python")
        };
        if venv_python.is_file() {
            attempts.push(python_launch(venv_python, Vec::new(), config_path));
        }
        attempts.extend([
            python_launch("python", Vec::new(), config_path),
            python_launch("py", vec!["-3.11".to_string()], config_path),
            python_launch("py", vec!["-3".to_string()], config_path),
            python_launch("python3", Vec::new(), config_path),
        ]);
    }
    Ok(attempts)
}

fn write_config(s: &settings::Settings, redis_url: &str) -> Result<PathBuf, String> {
    let path = store::proxypool_config_path().map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "host": s.proxypool_host,
        "port": s.proxypool_port,
        "redis_url": redis_url,
        "disabled_sources": s.proxypool_disabled_sources,
        "custom_sources": s.proxypool_custom_sources,
        "collect_interval_seconds": s.proxypool_collect_interval_seconds,
        "check_interval_seconds": s.proxypool_check_interval_seconds,
        "timeout_seconds": s.proxypool_timeout_seconds,
        "max_concurrency": s.proxypool_max_concurrency,
        "failure_threshold": 2,
        "initial_collect": true,
    });
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(path)
}

async fn spawn_sidecar(
    resource_root: Option<&Path>,
    config_path: PathBuf,
) -> Result<Child, String> {
    let log_path = store::proxypool_dir()
        .map_err(|e| e.to_string())?
        .join("sidecar.log");
    let attempts = sidecar_attempts(resource_root, &config_path)?;

    let mut last_error = String::new();
    for launch in attempts {
        let mut cmd = Command::new(&launch.program);
        cmd.args(&launch.args)
            .current_dir(&launch.working_dir)
            .env("PYTHONUNBUFFERED", "1")
            .kill_on_drop(false);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x00000010);
        }
        {
            use std::fs::OpenOptions;
            use std::process::Stdio;

            let log = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .map_err(|e| e.to_string())?;
            let err_log = log.try_clone().map_err(|e| e.to_string())?;
            cmd.stdout(Stdio::from(log)).stderr(Stdio::from(err_log));
        }

        match cmd.spawn() {
            Ok(mut child) => {
                tokio::time::sleep(Duration::from_millis(800)).await;
                match child.try_wait().map_err(|e| e.to_string())? {
                    Some(status) => {
                        last_error =
                            format!("{} exited early with {status}", launch.program.display());
                    }
                    None => return Ok(child),
                }
            }
            Err(err) => {
                last_error = format!("{}: {err}", launch.program.display());
            }
        }
    }

    Err(format!(
        "failed to start ProxyPool sidecar ({last_error}). See {}",
        log_path.display()
    ))
}

async fn redis_port_open(spec: &LocalRedisSpec) -> bool {
    TcpStream::connect((spec.host.as_str(), spec.port))
        .await
        .is_ok()
}

#[cfg(target_os = "windows")]
async fn ensure_local_redis(
    resource_root: Option<&Path>,
    redis_url: &str,
) -> Result<LocalRedisOutcome, String> {
    let Some(spec) = parse_local_redis_url(redis_url) else {
        return Ok(LocalRedisOutcome {
            managed_url: None,
            started_now: false,
        });
    };
    if redis_port_open(&spec).await {
        let mut guard = redis_child_slot().lock().await;
        if let Some(managed) = guard.as_mut() {
            if managed
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                *guard = None;
            } else if managed.host == spec.host && managed.port == spec.port {
                return Ok(LocalRedisOutcome {
                    managed_url: Some(spec.sidecar_url),
                    started_now: false,
                });
            }
        }
        return Ok(LocalRedisOutcome {
            managed_url: None,
            started_now: false,
        });
    }

    let Some(root) = resource_root else {
        if cfg!(debug_assertions) {
            return Ok(LocalRedisOutcome {
                managed_url: None,
                started_now: false,
            });
        }
        return Err("ProxyPool resource directory is unavailable; reinstall BrProxies".to_string());
    };
    let server = match resolve_bundled_redis_from(root) {
        Ok(server) => server,
        Err(_) if cfg!(debug_assertions) => {
            return Ok(LocalRedisOutcome {
                managed_url: None,
                started_now: false,
            })
        }
        Err(error) => return Err(error),
    };

    let mut guard = redis_child_slot().lock().await;
    if let Some(managed) = guard.as_mut() {
        if managed
            .child
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Ok(LocalRedisOutcome {
                managed_url: None,
                started_now: false,
            });
        }
        *guard = None;
    }

    let data_dir = store::proxypool_dir().map_err(|e| e.to_string())?;
    let log_path = data_dir.join("redis.log");
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    let err_log = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&server);
    cmd.arg("--bind")
        .arg(&spec.host)
        .arg("--protected-mode")
        .arg("yes")
        .arg("--port")
        .arg(spec.port.to_string())
        .arg("--dir")
        .arg(&data_dir)
        .arg("--dbfilename")
        .arg("redis.rdb")
        .arg("--save")
        .arg("")
        .arg("--appendonly")
        .arg("no")
        .current_dir(&data_dir)
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(err_log))
        .kill_on_drop(false)
        .creation_flags(0x08000000);

    let mut child = cmd.spawn().map_err(|error| {
        format!(
            "failed to start bundled ProxyPool Redis ({}: {error}). See {}",
            server.display(),
            log_path.display()
        )
    })?;
    for _ in 0..40 {
        if redis_port_open(&spec).await {
            *guard = Some(ManagedRedisChild {
                child,
                host: spec.host,
                port: spec.port,
            });
            return Ok(LocalRedisOutcome {
                managed_url: Some(spec.sidecar_url),
                started_now: true,
            });
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "bundled ProxyPool Redis exited early with {status}. See {}",
                log_path.display()
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = child.kill().await;
    Err(format!(
        "bundled ProxyPool Redis did not open {}:{} in time. See {}",
        spec.host,
        spec.port,
        log_path.display()
    ))
}

#[cfg(not(target_os = "windows"))]
async fn ensure_local_redis(
    _resource_root: Option<&Path>,
    _redis_url: &str,
) -> Result<LocalRedisOutcome, String> {
    Ok(LocalRedisOutcome {
        managed_url: None,
        started_now: false,
    })
}

async fn stop_managed_redis() {
    let mut guard = redis_child_slot().lock().await;
    if let Some(mut managed) = guard.take() {
        let _ = managed.child.kill().await;
        let _ = managed.child.wait().await;
    }
}

#[tauri::command]
pub async fn proxypool_start(app: tauri::AppHandle) -> Result<ProxyPoolStatus, String> {
    let s = settings::load().map_err(|e| e.to_string())?;
    let resource_root = app.path().resource_dir().ok();
    let redis_outcome =
        ensure_local_redis(resource_root.as_deref(), &s.proxypool_redis_url).await?;
    let mut guard = child_slot().lock().await;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return status_with(&s, guard.as_ref());
        }
        *guard = None;
    }

    let effective_redis_url = redis_outcome
        .managed_url
        .as_deref()
        .unwrap_or(&s.proxypool_redis_url);
    let config_path = write_config(&s, effective_redis_url)?;
    let child = match spawn_sidecar(resource_root.as_deref(), config_path).await {
        Ok(child) => child,
        Err(error) => {
            if redis_outcome.started_now {
                stop_managed_redis().await;
            }
            return Err(error);
        }
    };
    *guard = Some(child);
    status_with(&s, guard.as_ref())
}

#[tauri::command]
pub async fn proxypool_stop() -> Result<ProxyPoolStatus, String> {
    let s = settings::load().map_err(|e| e.to_string())?;
    let mut guard = child_slot().lock().await;
    if let Some(mut child) = guard.take() {
        let _ = child.kill().await;
    }
    drop(guard);
    stop_managed_redis().await;
    status_with(&s, None)
}

#[tauri::command]
pub async fn proxypool_status() -> Result<ProxyPoolStatus, String> {
    let s = settings::load().map_err(|e| e.to_string())?;
    let mut guard = child_slot().lock().await;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            *guard = None;
        }
    }
    status_with(&s, guard.as_ref())
}

#[tauri::command]
pub async fn proxypool_health() -> Result<Value, String> {
    proxypool_request("GET", "/health").await
}

#[tauri::command]
pub async fn proxypool_get(path: String) -> Result<Value, String> {
    proxypool_request("GET", &path).await
}

#[tauri::command]
pub async fn proxypool_post(path: String) -> Result<Value, String> {
    proxypool_request("POST", &path).await
}

#[tauri::command]
pub async fn proxypool_add_source(source: ProxyPoolSourceCreate) -> Result<Value, String> {
    proxypool_request_json(
        "POST",
        "/sources",
        serde_json::to_value(source).map_err(|e| e.to_string())?,
    )
    .await
}

#[tauri::command]
pub async fn proxypool_job(path: String) -> Result<Value, String> {
    proxypool_request("POST", &path).await
}

#[tauri::command]
pub async fn proxypool_delete(proxy: String) -> Result<Value, String> {
    proxypool_request("DELETE", &format!("/proxy/{}", path_encode(&proxy))).await
}

async fn proxypool_request(method: &str, path: &str) -> Result<Value, String> {
    let s = settings::load().map_err(|e| e.to_string())?;
    let clean_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let url = format!("{}{}", base_url(&s), clean_path);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let req = match method {
        "POST" => client.post(url),
        "DELETE" => client.delete(url),
        _ => client.get(url),
    };
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("ProxyPool API {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

async fn proxypool_request_json(method: &str, path: &str, body: Value) -> Result<Value, String> {
    let s = settings::load().map_err(|e| e.to_string())?;
    let clean_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let url = format!("{}{}", base_url(&s), clean_path);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let req = match method {
        "POST" => client.post(url).json(&body),
        _ => return Err(format!("unsupported JSON method: {method}")),
    };
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("ProxyPool API {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn path_encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':') {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "brproxies-proxypool-{label}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn bundled_sidecar_uses_packaged_executable_without_python() {
        let root = test_dir("sidecar");
        let sidecar = root.join("proxypool/brproxies-proxypool.exe");
        std::fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        std::fs::write(&sidecar, b"synthetic-sidecar").unwrap();
        let config = root.join("config.json");

        let launch = resolve_bundled_sidecar_from(&root, &config).unwrap();

        assert_eq!(launch.program, sidecar);
        assert_eq!(
            launch.args,
            vec![
                "serve".to_string(),
                "--config".to_string(),
                config.display().to_string(),
            ]
        );
        assert_eq!(launch.working_dir, root.join("proxypool"));
    }

    #[test]
    fn bundled_sidecar_rejects_missing_executable() {
        let root = test_dir("missing-sidecar");
        let error = resolve_bundled_sidecar_from(&root, &root.join("config.json")).unwrap_err();
        assert!(error.contains("bundled ProxyPool sidecar is missing"));
    }

    #[test]
    fn bundled_sidecar_attempt_has_one_config_argument() {
        let root = test_dir("sidecar-attempt");
        let sidecar = root.join("proxypool/brproxies-proxypool.exe");
        std::fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        std::fs::write(&sidecar, b"synthetic-sidecar").unwrap();
        let config = root.join("config.json");

        let attempts = sidecar_attempts(Some(&root), &config).unwrap();
        let launch = attempts
            .iter()
            .find(|attempt| attempt.program == sidecar)
            .unwrap();

        assert_eq!(
            launch.args,
            vec![
                "serve".to_string(),
                "--config".to_string(),
                config.display().to_string(),
            ]
        );
    }

    #[test]
    fn bundled_redis_resolves_packaged_server() {
        let root = test_dir("redis");
        let server = root.join("proxypool/redis/redis-server.exe");
        std::fs::create_dir_all(server.parent().unwrap()).unwrap();
        std::fs::write(&server, b"synthetic-redis").unwrap();

        assert_eq!(resolve_bundled_redis_from(&root).unwrap(), server);
    }

    #[test]
    fn local_redis_urls_are_sanitized_for_bundled_startup() {
        let spec = parse_local_redis_url("redis://user:p%40ss@127.0.0.1:6380/2").unwrap();
        assert_eq!(spec.host, "127.0.0.1");
        assert_eq!(spec.port, 6380);
        assert_eq!(spec.sidecar_url, "redis://127.0.0.1:6380/2");

        assert!(parse_local_redis_url("redis://localhost:6379/0").is_some());
        assert!(parse_local_redis_url("redis://10.0.0.5:6379/0").is_none());
        assert!(parse_local_redis_url("rediss://127.0.0.1:6380/0").is_none());
    }
}
