use crate::account_keeper_format::{decode_base32, totp_from_bytes_at};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpCode {
    code: String,
    expires_at: u64,
}

fn generate_at(secret: &str, timestamp: u64) -> Result<TotpCode, String> {
    if secret.len() > 1024 {
        return Err("Invalid 2FA secret.".into());
    }
    let bytes = decode_base32(secret.trim()).map_err(|_| "Invalid 2FA secret.".to_string())?;
    let code = totp_from_bytes_at(&bytes, timestamp, 6)
        .map_err(|_| "Could not generate a 2FA code.".to_string())?;
    Ok(TotpCode {
        code,
        expires_at: timestamp - timestamp % 30 + 30,
    })
}

// No store, network, or job access: the secret lives only for this request.
#[tauri::command]
pub fn account_keeper_generate_totp(secret: String) -> Result<TotpCode, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Check your system clock.".to_string())?
        .as_secs();
    generate_at(&secret, timestamp)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Public RFC 6238 test vector, not an account credential.
    const RFC_SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn six_digit_code_and_expiry_share_the_same_time_step() {
        let result = generate_at(RFC_SECRET, 59).unwrap();
        assert_eq!(result.code, "287082");
        assert_eq!(result.expires_at, 60);
        assert_eq!(generate_at(RFC_SECRET, 60).unwrap().expires_at, 90);
        assert_eq!(
            generate_at(RFC_SECRET, 1_111_111_109).unwrap().code,
            "081804"
        );
    }

    #[test]
    fn trims_input_and_returns_only_generic_validation_errors() {
        assert_eq!(
            generate_at(&format!("  {RFC_SECRET}\n"), 59).unwrap().code,
            "287082"
        );
        for invalid in ["", "invalid!", "A", &"A".repeat(1025)] {
            assert_eq!(
                generate_at(invalid, 59).err().unwrap(),
                "Invalid 2FA secret."
            );
        }
    }
}
