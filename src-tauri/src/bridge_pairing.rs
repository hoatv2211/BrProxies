//! One-shot, in-memory approval for external Chrome OAuth export. Not an API JWT.
use axum::{
    http::{header::CACHE_CONTROL, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Default)]
struct Pairing {
    nonce: String,
    approved: bool,
    denied: bool,
    operation: Option<String>,
    starting: bool,
    created: Option<Instant>,
}
impl Pairing {
    fn valid(&self, nonce: &str) -> bool {
        self.nonce == nonce
            && self
                .created
                .is_some_and(|t| t.elapsed() < Duration::from_secs(600))
    }
    fn authorized(&self, nonce: &str) -> bool {
        self.valid(nonce) && self.approved && !self.denied
    }
}
fn state() -> &'static Mutex<Pairing> {
    static STATE: OnceLock<Mutex<Pairing>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Pairing::default()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    nonce: String,
    format: Option<String>,
}
type Reply = Result<Response, StatusCode>;
fn reply(value: Value) -> Response {
    ([(CACHE_CONTROL, "no-store")], Json(value)).into_response()
}
fn validate(headers: &HeaderMap, request: &Request) -> Result<(), StatusCode> {
    if request.nonce.len() != 64 || !request.nonce.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    // Browser websites cannot use these endpoints. Local clients still require native approval.
    if let Some(origin) = headers.get("origin") {
        let origin = origin.to_str().map_err(|_| StatusCode::FORBIDDEN)?;
        let id = origin
            .strip_prefix("chrome-extension://")
            .ok_or(StatusCode::FORBIDDEN)?;
        if id.len() != 32 || !id.bytes().all(|c| (b'a'..=b'p').contains(&c)) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(())
}
async fn begin(headers: HeaderMap, Json(request): Json<Request>) -> Reply {
    validate(&headers, &request)?;
    let app = crate::app_handle().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    {
        let mut s = state()
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if s.created
            .is_some_and(|t| t.elapsed() < Duration::from_secs(600))
        {
            if s.valid(&request.nonce) {
                return Ok(reply(json!({"status":"pending"})));
            }
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        *s = Pairing {
            nonce: request.nonce.clone(),
            created: Some(Instant::now()),
            ..Default::default()
        };
    }
    let code = request.nonce[..8].to_uppercase();
    app.dialog().message(format!("Chrome requests ONE current-session Codex OAuth export.\n\nMatching code: {code}\n\nApprove only if you just clicked Connect & Export and this code matches the extension page. No profile or cookie access is granted. Permission expires in 10 minutes.\n\nAllow?"))
        .title("BrProxies - approve Chrome export")
        .buttons(MessageDialogButtons::YesNo)
        .show(move |approved| {
            if let Ok(mut s) = state().lock() {
                if s.valid(&request.nonce) { s.approved = approved; s.denied = !approved; }
            }
        });
    Ok(reply(json!({"status":"pending"})))
}
async fn status(headers: HeaderMap, Json(request): Json<Request>) -> Reply {
    validate(&headers, &request)?;
    let operation = {
        let s = state()
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if !s.valid(&request.nonce) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        if s.denied {
            return Ok(reply(
                json!({"status":"failed", "error_code":"pairing_denied"}),
            ));
        }
        if !s.approved {
            return Ok(reply(json!({"status":"pending"})));
        }
        s.operation.clone()
    };
    match operation {
        Some(id) => crate::account_keeper::codex_oauth_browser_session_status(&id)
            .await
            .map(|v| reply(serde_json::to_value(v).unwrap_or(Value::Null)))
            .map_err(|_| StatusCode::CONFLICT),
        None => Ok(reply(json!({"status":"approved"}))),
    }
}
async fn oauth(headers: HeaderMap, Json(request): Json<Request>) -> Reply {
    validate(&headers, &request)?;
    {
        let mut s = state()
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if !s.authorized(&request.nonce) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        if s.operation.is_some() || s.starting {
            return Err(StatusCode::CONFLICT);
        }
        s.starting = true;
    }
    let result = crate::account_keeper::start_codex_oauth_browser_session(
        crate::account_keeper::OpenProfileRequest {
            profile_id: String::new(),
        },
    )
    .await;
    let mut s = state()
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !s.authorized(&request.nonce) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    s.starting = false;
    match result {
        Ok(operation) => {
            s.operation = Some(operation.operation_id.clone());
            Ok(reply(
                serde_json::to_value(operation).unwrap_or(Value::Null),
            ))
        }
        Err(_) => {
            s.denied = true;
            Err(StatusCode::CONFLICT)
        }
    }
}
async fn export(headers: HeaderMap, Json(request): Json<Request>) -> Reply {
    validate(&headers, &request)?;
    let format = request.format.as_deref().ok_or(StatusCode::BAD_REQUEST)?;
    if !matches!(format, "nine_router" | "cockpit") {
        return Err(StatusCode::BAD_REQUEST);
    }
    let id = {
        let s = state()
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if !s.authorized(&request.nonce) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        s.operation.clone().ok_or(StatusCode::CONFLICT)?
    };
    let (accounts, _) = crate::account_keeper::account_keeper_codex_export_external(&id, format)
        .await
        .map_err(|_| StatusCode::CONFLICT)?;
    if let Ok(mut s) = state().lock() {
        if s.valid(&request.nonce) {
            *s = Pairing::default();
        }
    }
    Ok(reply(
        json!({"format":format,"accounts":accounts,"exportedCount":1,"skippedCount":0,"refreshedCount":0}),
    ))
}
pub fn routes() -> Router {
    Router::new()
        .route("/bridge/pair", post(begin))
        .route("/bridge/status", post(status))
        .route("/bridge/oauth", post(oauth))
        .route("/bridge/export", post(export))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approval_nonce_and_expiry_are_all_required() {
        let mut s = Pairing {
            nonce: "a".repeat(64),
            created: Some(Instant::now()),
            ..Default::default()
        };
        assert!(!s.authorized(&s.nonce));
        s.approved = true;
        assert!(s.authorized(&s.nonce));
        assert!(!s.authorized(&"b".repeat(64)));
        s.created = Some(Instant::now() - Duration::from_secs(601));
        assert!(!s.authorized(&s.nonce));
    }
    #[test]
    fn websites_and_bad_nonces_are_rejected() {
        let r = Request {
            nonce: "a".repeat(64),
            format: None,
        };
        let mut h = HeaderMap::new();
        h.insert("origin", "https://chatgpt.com".parse().unwrap());
        assert!(validate(&h, &r).is_err());
        h.insert(
            "origin",
            format!("chrome-extension://{}", "a".repeat(32))
                .parse()
                .unwrap(),
        );
        assert!(validate(&h, &r).is_ok());
        assert!(validate(
            &h,
            &Request {
                nonce: "short".into(),
                format: None
            }
        )
        .is_err());
    }
    #[tokio::test]
    async fn protected_actions_reject_unapproved_wrong_and_expired_capabilities() {
        let nonce = "b".repeat(64);
        *state().lock().unwrap() = Pairing {
            nonce: nonce.clone(),
            created: Some(Instant::now()),
            ..Default::default()
        };
        let request = || {
            Json(Request {
                nonce: nonce.clone(),
                format: Some("cockpit".into()),
            })
        };
        assert_eq!(
            oauth(HeaderMap::new(), request()).await.unwrap_err(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            export(HeaderMap::new(), request()).await.unwrap_err(),
            StatusCode::UNAUTHORIZED
        );
        state().lock().unwrap().approved = true;
        assert_eq!(
            export(
                HeaderMap::new(),
                Json(Request {
                    nonce: "c".repeat(64),
                    format: Some("cockpit".into())
                })
            )
            .await
            .unwrap_err(),
            StatusCode::UNAUTHORIZED
        );
        // Even approved callers cannot choose another operation or access profile APIs.
        assert_eq!(
            export(HeaderMap::new(), request()).await.unwrap_err(),
            StatusCode::CONFLICT
        );
        state().lock().unwrap().created = Some(Instant::now() - Duration::from_secs(601));
        assert_eq!(
            status(HeaderMap::new(), request()).await.unwrap_err(),
            StatusCode::UNAUTHORIZED
        );
        *state().lock().unwrap() = Pairing::default();
    }
}
