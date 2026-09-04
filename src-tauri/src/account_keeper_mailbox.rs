use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Serialize)]
struct VerificationRequest<'a> {
    provider: &'a str,
    job_id: &'a str,
    recipient: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum VerificationResponse {
    Code { code: String },
    Pending,
    Manual,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connector_accepts_only_exact_loopback_http() {
        assert!(parse_connector_endpoint("http://127.0.0.1:40328/code").is_some());
        for endpoint in [
            "https://127.0.0.1:40328/code",
            "http://localhost:40328/code",
            "http://user@127.0.0.1:40328/code",
            "not-a-url",
        ] {
            assert!(parse_connector_endpoint(endpoint).is_none());
        }
    }
}

pub async fn fetch_code(job_id: &str, recipient: &str) -> Result<Option<String>> {
    let Ok(settings) = crate::settings::load() else {
        return Ok(None);
    };
    if settings.account_keeper_mailbox_endpoint.trim().is_empty() {
        return Ok(None);
    }
    let Some(endpoint) = parse_connector_endpoint(&settings.account_keeper_mailbox_endpoint) else {
        return Ok(None);
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    else {
        return Ok(None);
    };
    let deadline = tokio::time::Instant::now()
        + Duration::from_secs(
            settings
                .account_keeper_mailbox_timeout_seconds
                .clamp(1, 300),
        );
    loop {
        let mut request = client.post(endpoint.clone()).json(&VerificationRequest {
            provider: "openai",
            job_id,
            recipient,
        });
        if !settings.account_keeper_mailbox_token.is_empty() {
            request = request.bearer_auth(&settings.account_keeper_mailbox_token);
        }
        let response = request.send().await;
        if let Ok(response) = response {
            if response.status().is_success() {
                match response.json::<VerificationResponse>().await {
                    Ok(VerificationResponse::Code { code })
                        if code.len() == 6 && code.bytes().all(|byte| byte.is_ascii_digit()) =>
                    {
                        return Ok(Some(code))
                    }
                    Ok(VerificationResponse::Manual) => return Ok(None),
                    Ok(VerificationResponse::Pending)
                    | Err(_)
                    | Ok(VerificationResponse::Code { .. }) => {}
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(None);
        }
        tokio::time::sleep(Duration::from_millis(
            settings
                .account_keeper_mailbox_poll_interval_ms
                .clamp(100, 10_000),
        ))
        .await;
    }
}

fn parse_connector_endpoint(value: &str) -> Option<url::Url> {
    let endpoint = url::Url::parse(value).ok()?;
    (endpoint.scheme() == "http"
        && endpoint.host_str() == Some("127.0.0.1")
        && endpoint.username().is_empty()
        && endpoint.password().is_none())
    .then_some(endpoint)
}
