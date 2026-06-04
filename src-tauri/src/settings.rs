use crate::store;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProxyPoolCustomSource {
    pub id: String,
    pub url: String,
    #[serde(default = "default_source_parser")]
    pub parser: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    /// Absolute path to the ShardX executable.
    pub browser_path: Option<String>,
    /// Theme: "dark" (default) or "light".
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Geo-IP checker provider used by the proxy "Test" button.
    /// One of "ip-api.com" | "ipapi.co" | "ipwho.is".
    #[serde(default)]
    pub geo_checker: Option<String>,
    /// "fingerprint" (use the screen from the bound fingerprint) or
    /// "real" (let ShardX use the host's real screen).
    #[serde(default)]
    pub screen_resolution_mode: Option<String>,

    // ---- Local automation HTTP API (axum + JWT bearer) ----
    /// Whether the local API server listens on 127.0.0.1:`api_port`.
    #[serde(default = "default_api_enabled")]
    pub api_enabled: bool,
    /// Port the API binds on 127.0.0.1.
    #[serde(default = "default_api_port")]
    pub api_port: u16,
    /// HS256 signing key for API JWTs.  Auto-generated on first run
    /// (see `ensure_secret`); rotating it invalidates issued tokens.
    #[serde(default)]
    pub api_secret: String,

    // ---- ProxyPool sidecar ----
    #[serde(default = "default_proxypool_host")]
    pub proxypool_host: String,
    #[serde(default = "default_proxypool_port")]
    pub proxypool_port: u16,
    #[serde(default = "default_proxypool_redis_url")]
    pub proxypool_redis_url: String,
    #[serde(default)]
    pub proxypool_disabled_sources: Vec<String>,
    #[serde(default)]
    pub proxypool_custom_sources: Vec<ProxyPoolCustomSource>,
    #[serde(default = "default_proxypool_collect_interval")]
    pub proxypool_collect_interval_seconds: u64,
    #[serde(default = "default_proxypool_check_interval")]
    pub proxypool_check_interval_seconds: u64,
    #[serde(default = "default_proxypool_timeout")]
    pub proxypool_timeout_seconds: f64,
    #[serde(default = "default_proxypool_concurrency")]
    pub proxypool_max_concurrency: u64,
}

fn default_theme() -> String {
    "dark".into()
}

fn default_api_enabled() -> bool {
    true
}

fn default_api_port() -> u16 {
    40325
}

fn default_proxypool_host() -> String { "127.0.0.1".into() }
fn default_proxypool_port() -> u16 { 40326 }
fn default_proxypool_redis_url() -> String { "redis://127.0.0.1:6379/0".into() }
fn default_proxypool_collect_interval() -> u64 { 900 }
fn default_proxypool_check_interval() -> u64 { 300 }
fn default_proxypool_timeout() -> f64 { 8.0 }
fn default_proxypool_concurrency() -> u64 { 50 }
fn default_source_parser() -> String { "text".into() }

pub fn load() -> Result<Settings> {
    let path = store::settings_path()?;
    if !path.exists() {
        return Ok(Settings {
            browser_path: None,
            theme: default_theme(),
            geo_checker: Some("ip-api.com".into()),
            screen_resolution_mode: Some("fingerprint".into()),
            api_enabled: default_api_enabled(),
            api_port: default_api_port(),
            api_secret: String::new(),
            proxypool_host: default_proxypool_host(),
            proxypool_port: default_proxypool_port(),
            proxypool_redis_url: default_proxypool_redis_url(),
            proxypool_disabled_sources: Vec::new(),
            proxypool_custom_sources: Vec::new(),
            proxypool_collect_interval_seconds: default_proxypool_collect_interval(),
            proxypool_check_interval_seconds: default_proxypool_check_interval(),
            proxypool_timeout_seconds: default_proxypool_timeout(),
            proxypool_max_concurrency: default_proxypool_concurrency(),
        });
    }
    let body = fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&body).unwrap_or_default())
}

/// Load settings, generating + persisting the API JWT secret if it's
/// still empty.  Call once at startup before the server reads it.
pub fn ensure_secret() -> Result<Settings> {
    let mut s = load()?;
    if s.api_secret.is_empty() {
        s.api_secret = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        save(&s)?;
    }
    Ok(s)
}

pub fn save(s: &Settings) -> Result<()> {
    let body = serde_json::to_string_pretty(s)?;
    fs::write(store::settings_path()?, body)?;
    Ok(())
}
