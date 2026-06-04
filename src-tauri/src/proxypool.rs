use crate::{settings, store};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::OnceLock;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn child_slot() -> &'static Mutex<Option<Child>> {
    CHILD.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Clone, Serialize)]
pub struct ProxyPoolStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub base_url: String,
    pub config_path: String,
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

fn service_workdir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("proxypool_service");
            if bundled.exists() {
                return bundled;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("proxypool_service"))
        .unwrap_or_else(|| PathBuf::from("proxypool_service"))
}

fn write_config(s: &settings::Settings) -> Result<PathBuf, String> {
    let path = store::proxypool_config_path().map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "host": s.proxypool_host,
        "port": s.proxypool_port,
        "redis_url": s.proxypool_redis_url,
        "disabled_sources": s.proxypool_disabled_sources,
        "collect_interval_seconds": s.proxypool_collect_interval_seconds,
        "check_interval_seconds": s.proxypool_check_interval_seconds,
        "timeout_seconds": s.proxypool_timeout_seconds,
        "max_concurrency": s.proxypool_max_concurrency,
        "failure_threshold": 2,
        "initial_collect": true,
    });
    std::fs::write(&path, serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub async fn proxypool_start() -> Result<ProxyPoolStatus, String> {
    let s = settings::load().map_err(|e| e.to_string())?;
    let mut guard = child_slot().lock().await;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return status_with(&s, guard.as_ref());
        }
        *guard = None;
    }

    let config_path = write_config(&s)?;
    let mut cmd = Command::new("python");
    cmd.arg("-m")
        .arg("proxypool_service")
        .arg("serve")
        .arg("--config")
        .arg(config_path)
        .current_dir(service_workdir())
        .kill_on_drop(false);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    let child = cmd.spawn().map_err(|e| format!("failed to start ProxyPool: {e}"))?;
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
pub async fn proxypool_delete(proxy: String) -> Result<Value, String> {
    proxypool_request("DELETE", &format!("/proxy/{}", path_encode(&proxy))).await
}

async fn proxypool_request(method: &str, path: &str) -> Result<Value, String> {
    let s = settings::load().map_err(|e| e.to_string())?;
    let clean_path = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };
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
