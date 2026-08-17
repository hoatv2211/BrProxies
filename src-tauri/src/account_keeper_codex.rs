use crate::account_keeper_store::CodexOAuthCredential;
use anyhow::{bail, Context, Result};
use base64::Engine;
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::{form_urlencoded, Url};

pub const CODEX_ISSUER: &str = "https://auth.openai.com";
pub const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_EXPORT_LIFETIME_SECONDS: u64 = 864_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthCallback {
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexIdClaims {
    pub email: String,
    pub account_id: String,
    pub plan_type: Option<String>,
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCodexOAuth {
    pub state: String,
    pub verifier: String,
    pub authorize_url: Url,
    pub redirect_uri: Url,
}

pub fn create_pending_oauth(port: u16) -> Result<PendingCodexOAuth> {
    let state = random_urlsafe(32)?;
    let verifier = random_urlsafe(48)?;
    let redirect_uri = Url::parse(&format!("http://localhost:{port}/auth/callback"))?;
    let mut authorize_url = Url::parse(&format!("{CODEX_ISSUER}/oauth/authorize"))?;
    authorize_url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CODEX_CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri.as_str())
        .append_pair("scope", "openid profile email offline_access api.connectors.read api.connectors.invoke")
        .append_pair("code_challenge", &pkce_challenge(&verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("state", &state)
        .append_pair("originator", "codex_cli_rs");
    Ok(PendingCodexOAuth { state, verifier, authorize_url, redirect_uri })
}

fn random_urlsafe(size: usize) -> Result<String> {
    let mut bytes = vec![0_u8; size];
    getrandom::getrandom(&mut bytes).map_err(|_| anyhow::anyhow!("codex_oauth_failed"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

pub fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn parse_callback_query(query: &str, expected_state: &str) -> Result<OAuthCallback> {
    let values = form_urlencoded::parse(query.as_bytes()).collect::<std::collections::HashMap<_, _>>();
    if values.get("state").map(|value| value.as_ref()) != Some(expected_state) {
        bail!("codex_oauth_failed");
    }
    if values.contains_key("error") {
        bail!("codex_oauth_failed");
    }
    let code = values.get("code").map(|value| value.to_string()).filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("codex_oauth_failed"))?;
    Ok(OAuthCallback { code })
}

pub fn parse_id_token_claims(token: &str, expected_issuer: &str) -> Result<CodexIdClaims> {
    let value = decode_jwt_payload(token)?;
    if value.get("iss").and_then(Value::as_str) != Some(expected_issuer) {
        bail!("codex_oauth_failed");
    }
    let audience_matches = match value.get("aud") {
        Some(Value::String(audience)) => audience == CODEX_CLIENT_ID,
        Some(Value::Array(audiences)) => audiences.iter().any(|audience| audience.as_str() == Some(CODEX_CLIENT_ID)),
        _ => false,
    };
    if !audience_matches {
        bail!("codex_oauth_failed");
    }
    let email = value.get("email").and_then(Value::as_str).filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("codex_oauth_failed"))?.to_string();
    let auth = value.get("https://api.openai.com/auth").and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("codex_oauth_failed"))?;
    let account_id = auth.get("chatgpt_account_id").and_then(Value::as_str).filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("codex_oauth_failed"))?.to_string();
    let plan_type = auth.get("chatgpt_plan_type").and_then(Value::as_str).map(str::to_string);
    let expires_at = value.get("exp").and_then(Value::as_u64).ok_or_else(|| anyhow::anyhow!("codex_oauth_failed"))?;
    Ok(CodexIdClaims { email, account_id, plan_type, expires_at })
}

fn decode_jwt_payload(token: &str) -> Result<Value> {
    let payload = token.split('.').nth(1).ok_or_else(|| anyhow::anyhow!("codex_oauth_failed"))?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .context("codex_oauth_failed")?;
    serde_json::from_slice(&decoded).context("codex_oauth_failed")
}

fn access_token_export_expiry(token: &str) -> (u64, String) {
    let timing = decode_jwt_payload(token).ok().and_then(|value| {
        let expires_at = value.get("exp")?.as_u64()?;
        let issued_at = value.get("iat").and_then(Value::as_u64);
        let lifetime = issued_at
            .and_then(|issued_at| expires_at.checked_sub(issued_at))
            .filter(|lifetime| *lifetime > 0)
            .unwrap_or(DEFAULT_EXPORT_LIFETIME_SECONDS);
        let timestamp = i64::try_from(expires_at).ok()?;
        let expires_at = Utc.timestamp_opt(timestamp, 0).single()?
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        Some((lifetime, expires_at))
    });
    timing.unwrap_or_else(|| (
        DEFAULT_EXPORT_LIFETIME_SECONDS,
        expires_at_rfc3339(DEFAULT_EXPORT_LIFETIME_SECONDS),
    ))
}

pub fn needs_refresh(expires_at: &str, now: &str) -> bool {
    let Ok(expires_at) = DateTime::parse_from_rfc3339(expires_at) else { return true; };
    let Ok(now) = DateTime::parse_from_rfc3339(now) else { return true; };
    expires_at <= now + ChronoDuration::minutes(5)
}

pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn expires_at_rfc3339(expires_in: u64) -> String {
    (Utc::now() + ChronoDuration::seconds(expires_in.min(i64::MAX as u64) as i64))
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn safe_error_code(_error: &anyhow::Error) -> &'static str {
    "codex_oauth_failed"
}

#[derive(serde::Deserialize)]
struct InitialTokenResponse {
    access_token: String,
    refresh_token: String,
    id_token: String,
}

#[derive(serde::Deserialize)]
struct RefreshTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
}

pub async fn bind_callback() -> Result<(TcpListener, u16)> {
    for port in [1455_u16, 1457_u16] {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
            return Ok((listener, port));
        }
    }
    bail!("codex_oauth_failed")
}

pub async fn wait_for_callback(listener: TcpListener, expected_state: &str) -> Result<OAuthCallback> {
    let (mut stream, _) = tokio::time::timeout(std::time::Duration::from_secs(300), listener.accept())
        .await.map_err(|_| anyhow::anyhow!("codex_oauth_failed"))??;
    let mut buffer = vec![0_u8; 16 * 1024];
    let size = tokio::time::timeout(std::time::Duration::from_secs(10), stream.read(&mut buffer))
        .await.map_err(|_| anyhow::anyhow!("codex_oauth_failed"))??;
    let request = std::str::from_utf8(&buffer[..size]).context("codex_oauth_failed")?;
    let target = request.lines().next().and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| anyhow::anyhow!("codex_oauth_failed"))?;
    let url = Url::parse(&format!("http://localhost{target}")).context("codex_oauth_failed")?;
    if url.path() != "/auth/callback" { bail!("codex_oauth_failed"); }
    let result = parse_callback_query(url.query().unwrap_or_default(), expected_state);
    let body = if result.is_ok() { "Codex authorization completed. You can close this tab." } else { "Codex authorization failed." };
    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(response.as_bytes()).await;
    result
}

pub async fn exchange_code(pending: &PendingCodexOAuth, code: &str) -> Result<(String, CodexOAuthCredential)> {
    exchange_at(CODEX_ISSUER, &pending.redirect_uri, &pending.verifier, code).await
}

async fn exchange_at(issuer: &str, redirect_uri: &Url, verifier: &str, code: &str) -> Result<(String, CodexOAuthCredential)> {
    let response = reqwest::Client::new().post(format!("{}/oauth/token", issuer.trim_end_matches('/')))
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CODEX_CLIENT_ID),
            ("code", code),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_verifier", verifier),
        ]).send().await.map_err(|_| anyhow::anyhow!("codex_oauth_failed"))?;
    if !response.status().is_success() { bail!("codex_oauth_failed"); }
    let tokens: InitialTokenResponse = response.json().await.map_err(|_| anyhow::anyhow!("codex_oauth_failed"))?;
    credential_from_initial_tokens(issuer, tokens)
}

pub async fn refresh_credential(credential: &CodexOAuthCredential) -> Result<(String, CodexOAuthCredential)> {
    let response = reqwest::Client::new().post(format!("{CODEX_ISSUER}/oauth/token"))
        .header("Accept", "application/json")
        .json(&json!({
            "grant_type": "refresh_token",
            "client_id": CODEX_CLIENT_ID,
            "refresh_token": credential.refresh_token,
        })).send().await.map_err(|_| anyhow::anyhow!("codex_reconnect_required"))?;
    if !response.status().is_success() { bail!("codex_reconnect_required"); }
    let tokens: RefreshTokenResponse = response.json().await.map_err(|_| anyhow::anyhow!("codex_reconnect_required"))?;
    credential_from_refresh_tokens(CODEX_ISSUER, credential, tokens)
        .map_err(|_| anyhow::anyhow!("codex_reconnect_required"))
}

fn credential_from_initial_tokens(issuer: &str, tokens: InitialTokenResponse) -> Result<(String, CodexOAuthCredential)> {
    let claims = parse_id_token_claims(&tokens.id_token, issuer)?;
    let last_refresh_at = now_rfc3339();
    let (expires_in, expires_at) = access_token_export_expiry(&tokens.access_token);
    Ok((claims.email, CodexOAuthCredential {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        id_token: tokens.id_token,
        account_id: claims.account_id,
        plan_type: claims.plan_type,
        last_refresh_at,
        expires_at,
        expires_in,
    }))
}

fn credential_from_refresh_tokens(
    issuer: &str,
    credential: &CodexOAuthCredential,
    tokens: RefreshTokenResponse,
) -> Result<(String, CodexOAuthCredential)> {
    let access_token = tokens.access_token.filter(|token| !token.is_empty())
        .ok_or_else(|| anyhow::anyhow!("codex_reconnect_required"))?;
    let id_token = tokens.id_token.filter(|token| !token.is_empty())
        .unwrap_or_else(|| credential.id_token.clone());
    let refresh_token = tokens.refresh_token.filter(|token| !token.is_empty())
        .unwrap_or_else(|| credential.refresh_token.clone());
    let claims = parse_id_token_claims(&id_token, issuer)?;
    let (expires_in, expires_at) = access_token_export_expiry(&access_token);
    Ok((claims.email, CodexOAuthCredential {
        access_token,
        refresh_token,
        id_token,
        account_id: claims.account_id,
        plan_type: claims.plan_type,
        last_refresh_at: now_rfc3339(),
        expires_at,
        expires_in,
    }))
}

pub fn nine_router_accounts(accounts: &[(&str, &CodexOAuthCredential)]) -> Vec<Value> {
    accounts
        .iter()
        .map(|(email, credential)| {
            json!({
                "accessToken": credential.access_token,
                "refreshToken": credential.refresh_token,
                "idToken": credential.id_token,
                "expiresIn": credential.expires_in,
                "expiresAt": credential.expires_at,
                "lastRefreshAt": credential.last_refresh_at,
                "email": email,
                "name": email,
                "providerSpecificData": {
                    "chatgptAccountId": credential.account_id,
                    "chatgptPlanType": credential.plan_type,
                },
                "testStatus": "active",
                "isActive": true,
            })
        })
        .collect()
}

pub fn cockpit_accounts(accounts: &[(&str, &CodexOAuthCredential)]) -> Vec<Value> {
    accounts
        .iter()
        .map(|(email, credential)| {
            json!({
                "type": "codex",
                "id_token": credential.id_token,
                "access_token": credential.access_token,
                "refresh_token": credential.refresh_token,
                "account_id": credential.account_id,
                "last_refresh": credential.last_refresh_at,
                "email": email,
                "expired": credential.expires_at,
                "account_note": email,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account_keeper_store::VaultFile;
    use base64::Engine;

    fn synthetic_credential() -> CodexOAuthCredential {
        CodexOAuthCredential {
            access_token: "synthetic-access".to_string(),
            refresh_token: "synthetic-refresh".to_string(),
            id_token: "synthetic-id".to_string(),
            account_id: "synthetic-account-id".to_string(),
            plan_type: Some("plus".to_string()),
            last_refresh_at: "2026-08-17T03:00:00Z".to_string(),
            expires_at: "2026-08-27T03:00:00Z".to_string(),
            expires_in: 864_000,
        }
    }

    fn synthetic_jwt(value: Value) -> String {
        let body = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&value).unwrap());
        format!("synthetic-header.{body}.synthetic-signature")
    }

    #[test]
    fn initial_token_payload_derives_export_lifetime_from_access_token() {
        let id_token = synthetic_jwt(serde_json::json!({
            "iss": CODEX_ISSUER,
            "aud": CODEX_CLIENT_ID,
            "email": "owner@example.test",
            "exp": 1_800_003_600_u64,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "synthetic-account-id",
                "chatgpt_plan_type": "plus"
            }
        }));
        let access_token = synthetic_jwt(serde_json::json!({
            "iat": 1_800_000_000_u64,
            "exp": 1_800_864_000_u64
        }));

        let (_, credential) = credential_from_initial_tokens(
            CODEX_ISSUER,
            InitialTokenResponse {
                access_token,
                refresh_token: "synthetic-refresh".to_string(),
                id_token,
            },
        ).unwrap();

        assert_eq!(credential.expires_in, 864_000);
        assert_eq!(
            DateTime::parse_from_rfc3339(&credential.expires_at).unwrap().timestamp(),
            1_800_864_000
        );
    }

    #[test]
    fn refresh_payload_keeps_tokens_omitted_by_codex() {
        let mut existing = synthetic_credential();
        existing.id_token = synthetic_jwt(serde_json::json!({
            "iss": CODEX_ISSUER,
            "aud": CODEX_CLIENT_ID,
            "email": "owner@example.test",
            "exp": 1_800_003_600_u64,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "synthetic-account-id",
                "chatgpt_plan_type": "plus"
            }
        }));
        let new_access = synthetic_jwt(serde_json::json!({
            "iat": 1_800_000_000_u64,
            "exp": 1_800_864_000_u64
        }));

        let (email, refreshed) = credential_from_refresh_tokens(
            CODEX_ISSUER,
            &existing,
            RefreshTokenResponse {
                access_token: Some(new_access.clone()),
                refresh_token: None,
                id_token: None,
            },
        ).unwrap();

        assert_eq!(email, "owner@example.test");
        assert_eq!(refreshed.access_token, new_access);
        assert_eq!(refreshed.refresh_token, existing.refresh_token);
        assert_eq!(refreshed.id_token, existing.id_token);
        assert_eq!(refreshed.expires_in, 864_000);
    }

    #[test]
    fn old_vault_without_codex_oauth_remains_readable() {
        let json = r#"{
            "schema_version":1,
            "accounts":[],
            "pending_security_changes":{}
        }"#;

        let vault: VaultFile = serde_json::from_str(json).unwrap();

        assert!(vault.codex_oauth.is_empty());
    }

    #[test]
    fn formats_exact_9router_bulk_import_shape() {
        let credential = synthetic_credential();

        let accounts = nine_router_accounts(&[("owner@example.test", &credential)]);

        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0]["accessToken"], "synthetic-access");
        assert_eq!(accounts[0]["refreshToken"], "synthetic-refresh");
        assert_eq!(accounts[0]["idToken"], "synthetic-id");
        assert_eq!(accounts[0]["email"], "owner@example.test");
        assert_eq!(accounts[0]["name"], "owner@example.test");
        assert_eq!(
            accounts[0]["providerSpecificData"]["chatgptAccountId"],
            "synthetic-account-id"
        );
        assert_eq!(accounts[0]["testStatus"], "active");
        assert_eq!(accounts[0]["isActive"], true);
        assert!(accounts[0].get("id").is_none());
        assert!(accounts[0].get("provider").is_none());
        assert!(accounts[0].get("authType").is_none());
    }

    #[test]
    fn formats_exact_cockpit_bulk_import_shape() {
        let credential = synthetic_credential();

        let accounts = cockpit_accounts(&[("owner@example.test", &credential)]);

        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0]["type"], "codex");
        assert_eq!(accounts[0]["id_token"], "synthetic-id");
        assert_eq!(accounts[0]["access_token"], "synthetic-access");
        assert_eq!(accounts[0]["refresh_token"], "synthetic-refresh");
        assert_eq!(accounts[0]["account_id"], "synthetic-account-id");
        assert_eq!(accounts[0]["email"], "owner@example.test");
        assert_eq!(accounts[0]["account_note"], "owner@example.test");
        assert_eq!(accounts[0]["expired"], "2026-08-27T03:00:00Z");
        assert_eq!(accounts[0]["last_refresh"], "2026-08-17T03:00:00Z");
    }

    #[test]
    fn derives_rfc7636_s256_challenge() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn parses_only_matching_oauth_callback_state() {
        let callback = parse_callback_query("code=synthetic-code&state=expected", "expected")
            .unwrap();
        assert_eq!(callback.code, "synthetic-code");

        let error = parse_callback_query("code=synthetic-code&state=wrong", "expected")
            .unwrap_err();
        assert_eq!(safe_error_code(&error), "codex_oauth_failed");
        assert!(!error.to_string().contains("synthetic-code"));
    }

    #[test]
    fn maps_synthetic_id_token_claims() {
        let payload = serde_json::json!({
            "iss": "https://auth.openai.com",
            "aud": "app_EMoamEEZ73f0CkXaXp7hrann",
            "email": "owner@example.test",
            "exp": 1_800_000_000_u64,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "synthetic-account-id",
                "chatgpt_plan_type": "plus"
            }
        });
        let body = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        let token = format!("synthetic-header.{body}.synthetic-signature");

        let claims = parse_id_token_claims(&token, "https://auth.openai.com").unwrap();

        assert_eq!(claims.email, "owner@example.test");
        assert_eq!(claims.account_id, "synthetic-account-id");
        assert_eq!(claims.plan_type.as_deref(), Some("plus"));
        assert_eq!(claims.expires_at, 1_800_000_000);
    }

    #[test]
    fn refreshes_when_expiry_is_within_five_minutes() {
        assert!(needs_refresh(
            "2026-08-17T03:04:59Z",
            "2026-08-17T03:00:00Z"
        ));
        assert!(!needs_refresh(
            "2026-08-17T03:05:01Z",
            "2026-08-17T03:00:00Z"
        ));
    }
}
