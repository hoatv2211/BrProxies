use crate::{settings, store};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn child_slot() -> &'static Mutex<Option<Child>> {
    CHILD.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Clone, Serialize)]
pub struct AndroidManagerStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub base_url: String,
    pub config_path: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AndroidPostBody {
    #[serde(default)]
    body: Value,
}

fn base_url(s: &settings::Settings) -> String {
    format!("http://{}:{}", s.android_manager_host, s.android_manager_port)
}

fn status_with(s: &settings::Settings, child: Option<&Child>) -> Result<AndroidManagerStatus, String> {
    Ok(AndroidManagerStatus {
        running: child.is_some(),
        pid: child.and_then(|c| c.id()),
        base_url: base_url(s),
        config_path: store::android_manager_config_path()
            .map_err(|e| e.to_string())?
            .display()
            .to_string(),
    })
}

fn service_workdir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("android_manager");
            if bundled.exists() {
                return bundled;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("android_manager"))
        .unwrap_or_else(|| PathBuf::from("android_manager"))
}

fn write_config(s: &settings::Settings) -> Result<PathBuf, String> {
    let path = store::android_manager_config_path().map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "host": s.android_manager_host,
        "port": s.android_manager_port,
        "data_dir": store::android_manager_dir().map_err(|e| e.to_string())?.display().to_string(),
        "fake_runtime": s.android_manager_fake_runtime,
    });
    std::fs::write(&path, serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(path)
}

async fn spawn_sidecar(config_path: PathBuf) -> Result<Child, String> {
    let workdir = service_workdir();
    let mut attempts: Vec<(String, Vec<String>)> = Vec::new();
    if let Ok(python) = std::env::var("ANDROID_MANAGER_PYTHON") {
        if !python.trim().is_empty() {
            attempts.push((python, Vec::new()));
        }
    }
    attempts.extend([
        ("python".to_string(), Vec::new()),
        ("py".to_string(), vec!["-3.11".to_string()]),
        ("py".to_string(), vec!["-3".to_string()]),
        ("python3".to_string(), Vec::new()),
    ]);

    let mut last_error = String::new();
    for (program, prefix_args) in attempts {
        let mut cmd = Command::new(&program);
        cmd.args(prefix_args)
            .arg("-m")
            .arg("android_manager")
            .arg("serve")
            .arg("--config")
            .arg(&config_path)
            .current_dir(&workdir)
            .env("PYTHONUNBUFFERED", "1")
            .kill_on_drop(false);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x00000010);
        }

        match cmd.spawn() {
            Ok(mut child) => {
                tokio::time::sleep(Duration::from_millis(800)).await;
                match child.try_wait().map_err(|e| e.to_string())? {
                    Some(status) => last_error = format!("{program} exited early with {status}"),
                    None => return Ok(child),
                }
            }
            Err(err) => last_error = format!("{program}: {err}"),
        }
    }
    Err(format!("failed to start Android Manager sidecar ({last_error})"))
}

#[tauri::command]
pub async fn android_start() -> Result<AndroidManagerStatus, String> {
    let s = settings::load().map_err(|e| e.to_string())?;
    let mut guard = child_slot().lock().await;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return status_with(&s, guard.as_ref());
        }
        *guard = None;
    }
    let child = spawn_sidecar(write_config(&s)?).await?;
    *guard = Some(child);
    status_with(&s, guard.as_ref())
}

#[tauri::command]
pub async fn android_stop() -> Result<AndroidManagerStatus, String> {
    let s = settings::load().map_err(|e| e.to_string())?;
    let mut guard = child_slot().lock().await;
    if let Some(mut child) = guard.take() {
        let _ = child.kill().await;
    }
    status_with(&s, None)
}

#[tauri::command]
pub async fn android_status() -> Result<AndroidManagerStatus, String> {
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
pub async fn android_validate() -> Result<Value, String> {
    android_get("/validate".into()).await
}

#[tauri::command]
pub async fn android_get(path: String) -> Result<Value, String> {
    let (value, _) = android_request_json("GET", &path, None).await?;
    Ok(value)
}

#[tauri::command]
pub async fn android_post(path: String, body: Value) -> Result<Value, String> {
    let (value, _) = android_request_json("POST", &path, Some(body)).await?;
    Ok(value)
}

#[tauri::command]
pub async fn android_delete(path: String) -> Result<Value, String> {
    let (value, _) = android_request_json("DELETE", &path, None).await?;
    Ok(value)
}

#[tauri::command]
pub fn android_config_path() -> Result<String, String> {
    store::android_manager_config_path()
        .map(|p| p.display().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn android_screenshot(path: String) -> Result<String, String> {
    let (bytes, _, content_type) = android_request_raw("GET", &path, None).await?;
    if !content_type.contains("image/png") {
        return Err(format!("Android Manager returned non-PNG content-type: {content_type}"));
    }
    let dir = store::android_manager_dir()
        .map_err(|e| e.to_string())?
        .join("screenshots");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = path
        .split('/')
        .filter(|part| !part.is_empty() && *part != "instances" && *part != "screenshot")
        .last()
        .unwrap_or("android")
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect::<String>();
    let out = dir.join(format!("{name}.png"));
    fs::write(&out, bytes).map_err(|e| e.to_string())?;
    Ok(out.display().to_string())
}

pub async fn android_request_json(method: &str, path: &str, body: Option<Value>) -> Result<(Value, reqwest::StatusCode), String> {
    let (bytes, status, content_type) = android_request_raw(method, path, body).await?;
    if !content_type.contains("application/json") {
        return Err(format!("Android Manager returned non-JSON content-type: {content_type}"));
    }
    let value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok((value, status))
}

pub async fn android_request_raw(method: &str, path: &str, body: Option<Value>) -> Result<(Vec<u8>, reqwest::StatusCode, String), String> {
    let s = settings::load().map_err(|e| e.to_string())?;
    let clean = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };
    let url = format!("{}{}", base_url(&s), clean);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let req = match method {
        "POST" => client.post(url),
        "DELETE" => client.delete(url),
        _ => client.get(url),
    };
    let req = if let Some(token) = (!s.android_manager_token.is_empty()).then_some(s.android_manager_token) {
        req.bearer_auth(token)
    } else {
        req
    };
    let req = if let Some(body) = body { req.json(&body) } else { req };
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    if !status.is_success() {
        return Err(format!("Android Manager API {status}: {}", String::from_utf8_lossy(&bytes)));
    }
    Ok((bytes, status, content_type))
}

pub fn unwrap_post_body(value: Option<Value>) -> Option<Value> {
    value.map(|v| match serde_json::from_value::<AndroidPostBody>(v.clone()) {
        Ok(wrapper) => wrapper.body,
        Err(_) => v,
    })
}
