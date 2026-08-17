use crate::{dpapi, store};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PasswordState {
    Original,
    Changed,
    Unknown,
}

impl Default for PasswordState {
    fn default() -> Self {
        Self::Original
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultAccount {
    pub account_key: String,
    pub account: String,
    pub current_password: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_secret: Option<String>,
    pub profile_id: String,
    pub password_state: PasswordState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_verified_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexOAuthCredential {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    pub last_refresh_at: String,
    pub expires_at: String,
    pub expires_in: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultFile {
    pub schema_version: u32,
    pub accounts: Vec<VaultAccount>,
    #[serde(default)]
    pub pending_security_changes: HashMap<String, PendingSecurityChange>,
    #[serde(default)]
    pub codex_oauth: HashMap<String, CodexOAuthCredential>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct PendingSecurityChange {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_totp_secret: Option<String>,
}

impl Default for VaultFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            accounts: Vec::new(),
            pending_security_changes: HashMap::new(),
            codex_oauth: HashMap::new(),
        }
    }
}

impl VaultFile {
    pub fn single(account: VaultAccount) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            accounts: vec![account],
            pending_security_changes: HashMap::new(),
            codex_oauth: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobCheckpoint {
    pub schema_version: u32,
    pub batch_id: String,
    #[serde(default)]
    pub output_path: String,
    #[serde(default)]
    pub template: String,
    #[serde(default = "default_adapter_id")]
    pub adapter_id: String,
    #[serde(default)]
    pub keep_profile_running: bool,
    #[serde(default)]
    pub pause_after_current: bool,
    #[serde(default = "default_checkpoint_operation")]
    pub operation: String,
    #[serde(default)]
    pub status: String,
    pub updated_at: String,
    pub accounts: Vec<AccountCheckpoint>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountCheckpoint {
    pub account_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    pub state: String,
    pub attempts: u32,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn default_adapter_id() -> String {
    "openai-chatgpt-v1".to_string()
}

fn default_checkpoint_operation() -> String {
    "change_password".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchOutput {
    pub schema_version: u32,
    pub batch_id: String,
    pub updated_at: String,
    pub accounts: Vec<OutputAccount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutputAccount {
    pub account: String,
    pub password: String,
    /// The password the keeper attempted to switch to. Present when a rotation
    /// was submitted (pending or verified) so operators can see which new
    /// password was tried even if verification later failed (Critical).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_password: Option<String>,
    pub password_state: PasswordState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_secret: Option<String>,
    pub profile_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_verified_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn load_vault() -> Result<VaultFile> {
    load_vault_from(&store::account_keeper_vault_path()?)
}

pub fn save_vault(vault: &VaultFile) -> Result<()> {
    save_vault_to(&store::account_keeper_vault_path()?, vault)
}

pub fn load_job(batch_id: &str) -> Result<JobCheckpoint> {
    load_job_from(&job_path(batch_id)?)
}

pub fn save_job(checkpoint: &JobCheckpoint) -> Result<()> {
    save_job_to(&job_path(&checkpoint.batch_id)?, checkpoint)
}

pub fn delete_job(batch_id: &str) -> Result<()> {
    delete_job_from(&job_path(batch_id)?)
}

fn delete_job_from(path: &Path) -> Result<()> {
    if path.exists() {
        std::fs::remove_file(path).context("delete Account Keeper checkpoint")?;
    }
    Ok(())
}

pub fn list_jobs() -> Result<Vec<JobCheckpoint>> {
    let mut jobs = Vec::new();
    for entry in std::fs::read_dir(store::account_keeper_jobs_dir()?)? {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        jobs.push(load_job_from(&path)?);
    }
    jobs.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(jobs)
}

pub fn write_output(path: &Path, output: &BatchOutput) -> Result<()> {
    write_output_to(path, output)
}

fn save_vault_to(path: &Path, vault: &VaultFile) -> Result<()> {
    ensure_schema(vault.schema_version, "vault")?;
    let mut plaintext = serde_json::to_vec(vault).context("serialize Account Keeper vault")?;
    let protected_result = dpapi::protect(&plaintext);
    plaintext.fill(0);
    let protected = protected_result.context("encrypt Account Keeper vault")?;
    store::atomic_write_bytes(path, &protected).context("save Account Keeper vault")
}

fn load_vault_from(path: &Path) -> Result<VaultFile> {
    if !path.exists() {
        return Ok(VaultFile::default());
    }
    let protected = std::fs::read(path).context("read Account Keeper vault")?;
    let mut plaintext = dpapi::unprotect(&protected).context("decrypt Account Keeper vault")?;
    let decoded: Result<VaultFile> =
        serde_json::from_slice(&plaintext).context("parse Account Keeper vault");
    plaintext.fill(0);
    let vault = decoded?;
    ensure_schema(vault.schema_version, "vault")?;
    Ok(vault)
}

fn save_job_to(path: &Path, checkpoint: &JobCheckpoint) -> Result<()> {
    ensure_schema(checkpoint.schema_version, "checkpoint")?;
    let mut plaintext =
        serde_json::to_vec(checkpoint).context("serialize Account Keeper checkpoint")?;
    let protected_result = dpapi::protect(&plaintext);
    plaintext.fill(0);
    let protected = protected_result.context("encrypt Account Keeper checkpoint")?;
    store::atomic_write_bytes(path, &protected).context("save Account Keeper checkpoint")
}

fn load_job_from(path: &Path) -> Result<JobCheckpoint> {
    let protected = std::fs::read(path).context("read Account Keeper checkpoint")?;
    let mut plaintext =
        dpapi::unprotect(&protected).context("decrypt Account Keeper checkpoint")?;
    let decoded: Result<JobCheckpoint> =
        serde_json::from_slice(&plaintext).context("parse Account Keeper checkpoint");
    plaintext.fill(0);
    let checkpoint = decoded?;
    ensure_schema(checkpoint.schema_version, "checkpoint")?;
    Ok(checkpoint)
}

fn write_output_to(path: &Path, output: &BatchOutput) -> Result<()> {
    ensure_schema(output.schema_version, "output")?;
    store::atomic_write_json(path, output).context("write Account Keeper output")
}

fn ensure_schema(actual: u32, kind: &str) -> Result<()> {
    if actual != SCHEMA_VERSION {
        bail!("unsupported Account Keeper {kind} schema");
    }
    Ok(())
}

fn job_path(batch_id: &str) -> Result<PathBuf> {
    if batch_id.is_empty()
        || !batch_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("invalid Account Keeper batch ID");
    }
    Ok(store::account_keeper_jobs_dir()?.join(format!("{batch_id}.json")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_dir(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "brproxies-account-keeper-{label}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn synthetic_vault_account() -> VaultAccount {
        VaultAccount {
            account_key: "acct-key".to_string(),
            account: "synthetic@example.test".to_string(),
            current_password: "synthetic-password".to_string(),
            pending_password: Some("pending-synthetic-password".to_string()),
            totp_secret: Some("JBSWY3DPEHPK3PXP".to_string()),
            profile_id: "profile-id".to_string(),
            password_state: PasswordState::Original,
            last_verified_at: None,
            last_job_id: Some("job-id".to_string()),
            last_status: Some("queued".to_string()),
        }
    }

    fn synthetic_checkpoint() -> JobCheckpoint {
        JobCheckpoint {
            schema_version: 1,
            batch_id: "batch-id".to_string(),
            output_path: "C:/synthetic/result.json".to_string(),
            template: "Local-{random:16}".to_string(),
            adapter_id: "fixture-v1".to_string(),
            keep_profile_running: false,
            pause_after_current: false,
            operation: "change_password".to_string(),
            status: "waiting_manual".to_string(),
            updated_at: "2026-07-29T00:00:00Z".to_string(),
            accounts: vec![AccountCheckpoint {
                account_key: "acct-key".to_string(),
                profile_id: Some("profile-id".to_string()),
                state: "waiting_manual".to_string(),
                attempts: 1,
                updated_at: "2026-07-29T00:00:00Z".to_string(),
                error: Some("manual_required".to_string()),
            }],
        }
    }

    #[test]
    fn checkpoint_without_operation_defaults_to_change_password() {
        // A checkpoint JSON persisted before the operation field existed.
        let legacy = serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "batch_id": "legacy-batch",
            "output_path": "C:/synthetic/result.json",
            "template": "Local-{random:16}",
            "adapter_id": "openai-chatgpt-v1",
            "keep_profile_running": false,
            "pause_after_current": false,
            "status": "queued",
            "updated_at": "@1",
            "accounts": []
        });
        let checkpoint: JobCheckpoint = serde_json::from_value(legacy).unwrap();
        assert_eq!(checkpoint.operation, "change_password");
    }

    #[test]
    fn atomic_json_write_replaces_destination() {
        let path = test_dir("output").join("result.json");
        crate::store::atomic_write_json(&path, &serde_json::json!({"version": 1})).unwrap();
        crate::store::atomic_write_json(&path, &serde_json::json!({"version": 2})).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(value["version"], 2);
    }

    #[test]
    fn checkpoint_json_contains_no_password_or_totp_fields() {
        // `operation: "change_password"` is a benign enum token, not a credential;
        // strip it so the broad substring guard still catches any real leak.
        let text = serde_json::to_string(&synthetic_checkpoint())
            .unwrap()
            .replace("change_password", "");
        assert!(!text.contains("password"));
        assert!(!text.contains("totp_secret"));
        assert!(!text.contains("synthetic@example.test"));
    }

    #[test]
    fn checkpoint_preserves_safe_resume_metadata() {
        let checkpoint = synthetic_checkpoint();
        assert_eq!(checkpoint.output_path, "C:/synthetic/result.json");
        assert_eq!(checkpoint.template, "Local-{random:16}");
        assert_eq!(checkpoint.adapter_id, "fixture-v1");
        assert!(!checkpoint.keep_profile_running);
        assert_eq!(checkpoint.status, "waiting_manual");
    }

    #[test]
    #[cfg(windows)]
    fn dpapi_vault_round_trips_without_plaintext_on_disk() {
        let path = test_dir("vault").join("vault.bin");
        let vault = VaultFile::single(synthetic_vault_account());
        save_vault_to(&path, &vault).unwrap();
        let disk = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&disk).contains("synthetic-password"));
        assert!(!String::from_utf8_lossy(&disk).contains("pending-synthetic-password"));
        assert!(!String::from_utf8_lossy(&disk).contains("synthetic@example.test"));
        assert_eq!(load_vault_from(&path).unwrap(), vault);
    }

    #[test]
    fn pending_password_defaults_and_skips_none() {
        let mut account = synthetic_vault_account();
        account.pending_password = None;
        let serialized = serde_json::to_value(&account).unwrap();
        assert!(serialized.get("pending_password").is_none());
        let decoded: VaultAccount = serde_json::from_value(serialized).unwrap();
        assert_eq!(decoded.pending_password, None);
    }

    #[test]
    fn output_preserves_current_known_credentials_and_state() {
        let path = test_dir("batch-output").join("result.json");
        let output = BatchOutput {
            schema_version: 1,
            batch_id: "batch-id".to_string(),
            updated_at: "2026-07-29T00:00:00Z".to_string(),
            accounts: vec![OutputAccount {
                account: "synthetic@example.test".to_string(),
                password: "synthetic-password".to_string(),
                new_password: None,
                password_state: PasswordState::Changed,
                totp_secret: Some("JBSWY3DPEHPK3PXP".to_string()),
                profile_id: "profile-id".to_string(),
                status: "success".to_string(),
                last_verified_at: Some("2026-07-29T00:00:00Z".to_string()),
                error: None,
            }],
        };
        write_output_to(&path, &output).unwrap();
        let loaded: BatchOutput =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(loaded, output);
        assert_eq!(loaded.accounts[0].password_state, PasswordState::Changed);
    }

    #[test]
    #[cfg(windows)]
    fn dpapi_job_checkpoint_round_trips_without_plaintext_on_disk() {
        let path = test_dir("checkpoint").join("job.json");
        let checkpoint = synthetic_checkpoint();
        save_job_to(&path, &checkpoint).unwrap();
        let disk = std::fs::read(&path).unwrap();
        let disk_text = String::from_utf8_lossy(&disk);
        assert!(!disk_text.contains("C:/synthetic/result.json"));
        assert!(!disk_text.contains("Local-{random:16}"));
        assert!(!disk_text.contains("acct-key"));
        assert!(!disk_text.contains("profile-id"));
        assert!(!disk_text.contains("waiting_manual"));
        assert_eq!(load_job_from(&path).unwrap(), checkpoint);
    }

    #[test]
    fn deleting_checkpoint_is_idempotent() {
        let path = test_dir("delete-checkpoint").join("job.json");
        save_job_to(&path, &synthetic_checkpoint()).unwrap();
        assert!(load_job_from(&path).is_ok());
        delete_job_from(&path).unwrap();
        delete_job_from(&path).unwrap();
        assert!(load_job_from(&path).is_err());
    }

    #[test]
    #[cfg(windows)]
    fn job_checkpoint_rejects_unknown_schema() {
        let path = test_dir("checkpoint-schema").join("job.json");
        let mut checkpoint = synthetic_checkpoint();
        checkpoint.schema_version = SCHEMA_VERSION + 1;
        let mut plaintext = serde_json::to_vec(&checkpoint).unwrap();
        let protected = crate::dpapi::protect(&plaintext).unwrap();
        plaintext.fill(0);
        crate::store::atomic_write_bytes(&path, &protected).unwrap();
        assert!(load_job_from(&path)
            .unwrap_err()
            .to_string()
            .contains("unsupported Account Keeper checkpoint schema"));
    }

    #[test]
    #[cfg(windows)]
    fn vault_rejects_unknown_schema() {
        let path = test_dir("vault-schema").join("vault.bin");
        let mut vault = VaultFile::single(synthetic_vault_account());
        vault.schema_version = SCHEMA_VERSION + 1;
        let plaintext = serde_json::to_vec(&vault).unwrap();
        let protected = crate::dpapi::protect(&plaintext).unwrap();
        crate::store::atomic_write_bytes(&path, &protected).unwrap();
        assert!(load_vault_from(&path)
            .unwrap_err()
            .to_string()
            .contains("unsupported Account Keeper vault schema"));
    }
}
