use crate::{proxy, settings, store};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProxySelection {
    #[default]
    None,
    Random,
    Specific { proxy: String },
}

impl ProxySelection {
    pub fn assigns_proxy(&self) -> bool {
        !matches!(self, Self::None)
    }
}

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

async fn spawn_sidecar(config_path: PathBuf) -> Result<Child, String> {
    let workdir = service_workdir();
    let log_path = store::proxypool_dir()
        .map_err(|e| e.to_string())?
        .join("sidecar.log");
    let mut attempts: Vec<(String, Vec<String>)> = Vec::new();
    if let Ok(python) = std::env::var("PROXYPOOL_PYTHON") {
        if !python.trim().is_empty() {
            attempts.push((python, Vec::new()));
        }
    }
    let venv_python = if cfg!(target_os = "windows") {
        workdir.join(".venv").join("Scripts").join("python.exe")
    } else {
        workdir.join(".venv").join("bin").join("python")
    };
    if venv_python.exists() {
        attempts.push((venv_python.display().to_string(), Vec::new()));
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
            .arg("proxypool_service")
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
                        last_error = format!("{program} exited early with {status}");
                    }
                    None => return Ok(child),
                }
            }
            Err(err) => {
                last_error = format!("{program}: {err}");
            }
        }
    }

    Err(format!(
        "failed to start ProxyPool sidecar ({last_error}). See {}",
        log_path.display()
    ))
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
    let child = spawn_sidecar(config_path).await?;
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

pub async fn resolve_proxy_entry(
    selection: &ProxySelection,
) -> Result<Option<proxy::ProxyEntry>, String> {
    let active = proxy::active_entries().map_err(|error| error.to_string())?;
    let random_index = uuid::Uuid::new_v4().as_u128() as usize;
    select_active_proxy(selection, active, random_index)
}

fn select_active_proxy(
    selection: &ProxySelection,
    active: Vec<proxy::ProxyEntry>,
    random_index: usize,
) -> Result<Option<proxy::ProxyEntry>, String> {
    match selection {
        ProxySelection::None => Ok(None),
        ProxySelection::Random => {
            if active.is_empty() {
                return Err(
                "no active launcher proxies available; test proxies in Proxies and resume the job"
                    .to_string(),
                );
            }
            Ok(active.get(random_index % active.len()).cloned())
        }
        ProxySelection::Specific { proxy } => active
            .into_iter()
            .find(|entry| {
                entry.id == *proxy || format!("{}:{}", entry.host, entry.port) == *proxy
            })
            .map(Some)
            .ok_or_else(|| "selected launcher proxy is missing or no longer active".to_string()),
    }
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

    fn launcher_proxy(id: &str, host: &str, port: u16) -> proxy::ProxyEntry {
        proxy::ProxyEntry {
            id: id.to_string(),
            name: id.to_string(),
            kind: proxy::ProxyKind::Http,
            host: host.to_string(),
            port,
            username: String::new(),
            password: String::new(),
            country: String::new(),
            notes: String::new(),
        }
    }

    #[test]
    fn random_selection_uses_an_active_launcher_proxy() {
        let selected = select_active_proxy(
            &ProxySelection::Random,
            vec![
                launcher_proxy("proxy-a", "1.2.3.4", 8080),
                launcher_proxy("proxy-b", "5.6.7.8", 3128),
            ],
            1,
        )
        .unwrap()
        .unwrap();

        assert_eq!(selected.id, "proxy-b");
    }

    #[test]
    fn specific_selection_uses_the_launcher_proxy_id() {
        let selected = select_active_proxy(
            &ProxySelection::Specific {
                proxy: "proxy-a".to_string(),
            },
            vec![launcher_proxy("proxy-a", "1.2.3.4", 8080)],
            0,
        )
        .unwrap()
        .unwrap();

        assert_eq!(selected.host, "1.2.3.4");
        assert_eq!(selected.port, 8080);
    }

}
