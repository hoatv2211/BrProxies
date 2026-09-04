use crate::store;
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};

const MAX_PROTOCOL_LINE_BYTES: usize = 64 * 1024;
const REDACTED_WORKER_MESSAGE: &str = "[redacted worker message]";
const EMBEDDED_PACKAGE_JSON: &str = include_str!("../../automation/package.json");
const EMBEDDED_PROTOCOL: &str = include_str!("../../automation/account-keeper-protocol.mjs");
const EMBEDDED_FLOW: &str = include_str!("../../automation/account-keeper-flow.mjs");
const EMBEDDED_WORKER: &str = include_str!("../../automation/account-keeper-worker.mjs");
const EMBEDDED_WORKER_RUNTIME: &str =
    include_str!("../../automation/account-keeper-worker-runtime.mjs");
const EMBEDDED_ADAPTER_REGISTRY: &str = include_str!("../../automation/adapters/registry.mjs");
const EMBEDDED_OPENAI_ADAPTER: &str =
    include_str!("../../automation/adapters/openai-chatgpt-v1.mjs");
const EMBEDDED_FIXTURE_ADAPTER: &str = include_str!("../../automation/adapters/fixture-v1.mjs");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerResources {
    pub node_executable: PathBuf,
    pub worker_script: PathBuf,
    pub working_dir: PathBuf,
}

pub fn resolve_worker(resource_root: Option<&Path>) -> Result<WorkerResources> {
    if let Some(root) = resource_root {
        if let Ok(resources) = resolve_bundled_worker_from(root) {
            return Ok(resources);
        }
    }

    #[cfg(debug_assertions)]
    {
        return resolve_debug_worker();
    }

    #[cfg(not(debug_assertions))]
    bail!("Account Keeper worker resources are missing; reinstall BrProxies")
}

pub fn resolve_bundled_worker_from(resource_root: &Path) -> Result<WorkerResources> {
    let account_keeper_root = resource_root.join("account-keeper");
    let node_executable = account_keeper_root.join("node").join("node.exe");
    let working_dir = account_keeper_root.join("worker");
    let worker_script = working_dir.join("account-keeper-worker.mjs");
    let worker_runtime = working_dir.join("account-keeper-worker-runtime.mjs");
    let protocol_script = working_dir.join("account-keeper-protocol.mjs");
    let flow_script = working_dir.join("account-keeper-flow.mjs");
    let adapter_registry = working_dir.join("adapters").join("registry.mjs");
    let openai_adapter = working_dir.join("adapters").join("openai-chatgpt-v1.mjs");
    let fixture_adapter = working_dir.join("adapters").join("fixture-v1.mjs");
    let manifest = account_keeper_root.join("manifest.json");
    let patchright_package = working_dir
        .join("node_modules")
        .join("patchright")
        .join("package.json");
    let patchright_core_package = working_dir
        .join("node_modules")
        .join("patchright-core")
        .join("package.json");

    if !node_executable.is_file() {
        bail!("Account Keeper bundled Node runtime is missing");
    }
    if !worker_script.is_file() {
        bail!("Account Keeper bundled worker is missing");
    }
    if !protocol_script.is_file() {
        bail!("Account Keeper bundled protocol is missing");
    }
    if !worker_runtime.is_file()
        || !flow_script.is_file()
        || !adapter_registry.is_file()
        || !openai_adapter.is_file()
        || !fixture_adapter.is_file()
    {
        bail!("Account Keeper bundled semantic flow is missing");
    }
    if !manifest.is_file() {
        bail!("Account Keeper bundled manifest is missing");
    }
    if !patchright_package.is_file() {
        bail!("Account Keeper bundled Patchright dependency is missing");
    }
    if !patchright_core_package.is_file() {
        bail!("Account Keeper bundled Patchright Core dependency is missing");
    }

    Ok(WorkerResources {
        node_executable,
        worker_script,
        working_dir,
    })
}

pub fn provision_worker_to(directory: &Path) -> Result<()> {
    std::fs::create_dir_all(directory).context("create Account Keeper worker directory")?;
    write_embedded(
        &directory.join("account-keeper-worker.mjs"),
        EMBEDDED_WORKER,
    )?;
    write_embedded(
        &directory.join("account-keeper-worker-runtime.mjs"),
        EMBEDDED_WORKER_RUNTIME,
    )?;
    write_embedded(
        &directory.join("account-keeper-protocol.mjs"),
        EMBEDDED_PROTOCOL,
    )?;
    write_embedded(&directory.join("account-keeper-flow.mjs"), EMBEDDED_FLOW)?;
    let adapters = directory.join("adapters");
    std::fs::create_dir_all(&adapters).context("create Account Keeper adapter directory")?;
    write_embedded(&adapters.join("registry.mjs"), EMBEDDED_ADAPTER_REGISTRY)?;
    write_embedded(
        &adapters.join("openai-chatgpt-v1.mjs"),
        EMBEDDED_OPENAI_ADAPTER,
    )?;
    write_embedded(&adapters.join("fixture-v1.mjs"), EMBEDDED_FIXTURE_ADAPTER)?;
    write_embedded(&directory.join("package.json"), EMBEDDED_PACKAGE_JSON)?;
    Ok(())
}

pub fn redact_line(line: &str) -> String {
    if line.len() > MAX_PROTOCOL_LINE_BYTES {
        return REDACTED_WORKER_MESSAGE.to_string();
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return REDACTED_WORKER_MESSAGE.to_string();
    };
    if contains_forbidden_field(&value) {
        return REDACTED_WORKER_MESSAGE.to_string();
    }
    if !has_canonical_failure_message(&value) {
        return REDACTED_WORKER_MESSAGE.to_string();
    }
    line.to_string()
}

fn write_embedded(path: &Path, contents: &str) -> Result<()> {
    store::atomic_write_bytes(path, contents.as_bytes()).context("write embedded worker resource")
}

fn contains_forbidden_field(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(contains_forbidden_field),
        Value::Object(fields) => fields
            .iter()
            .any(|(field, value)| is_forbidden_field(field) || contains_forbidden_field(value)),
        _ => false,
    }
}

fn is_forbidden_field(field: &str) -> bool {
    let normalized: String = field
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    [
        "account",
        "authorization",
        "authheader",
        "cookie",
        "email",
        "formvalue",
        "html",
        "identifier",
        "password",
        "secret",
        "storage",
        "token",
    ]
    .iter()
    .any(|part| normalized.contains(part))
}

fn has_canonical_failure_message(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    if fields.get("type").and_then(Value::as_str) != Some("failed") {
        return true;
    }
    let Some(code) = fields.get("code").and_then(Value::as_str) else {
        return false;
    };
    let Some(message) = fields.get("message").and_then(Value::as_str) else {
        return false;
    };
    canonical_failure_message(code) == Some(message)
}

fn canonical_failure_message(code: &str) -> Option<&'static str> {
    match code {
        "browser_crashed" => Some("Browser connection closed"),
        "cancelled" => Some("Operation cancelled"),
        "credential_state_unknown" => {
            Some("Password submission outcome is unknown; verify credentials manually")
        }
        "flow_changed" => Some("Supported page structure changed"),
        "invalid_credentials" => Some("Current credentials were rejected"),
        "navigation_failed" => Some("Navigation failed"),
        "password_change_failed" => Some("Password change failed"),
        "protocol_error" => Some("Worker protocol failed"),
        "totp_rejected" => Some("TOTP verification failed"),
        "unsupported_login_method" => Some("Account uses an unsupported login method"),
        "verification_failed" => Some("New password verification failed"),
        "worker_not_ready" => Some("Browser flow is not provisioned"),
        _ => None,
    }
}

#[cfg(debug_assertions)]
fn resolve_debug_worker() -> Result<WorkerResources> {
    let working_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../automation");
    let worker_script = working_dir.join("account-keeper-worker.mjs");
    let worker_runtime = working_dir.join("account-keeper-worker-runtime.mjs");
    let package_json = working_dir.join("package.json");
    if !worker_script.is_file() || !worker_runtime.is_file() || !package_json.is_file() {
        bail!("Account Keeper debug worker files are missing");
    }
    if !system_node_available() {
        bail!("Account Keeper debug mode requires Node.js on PATH");
    }
    Ok(WorkerResources {
        node_executable: PathBuf::from("node"),
        worker_script,
        working_dir,
    })
}

#[cfg(debug_assertions)]
fn system_node_available() -> bool {
    let mut command = std::process::Command::new("node");
    command.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
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
            "brproxies-account-worker-{label}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn provision_writes_embedded_worker_files() {
        let dir = test_dir("provision");
        provision_worker_to(&dir).unwrap();
        assert!(dir.join("account-keeper-worker.mjs").exists());
        assert!(dir.join("account-keeper-worker-runtime.mjs").exists());
        assert!(dir.join("account-keeper-protocol.mjs").exists());
        assert!(dir.join("account-keeper-flow.mjs").exists());
        assert!(dir.join("adapters/registry.mjs").exists());
        assert!(dir.join("adapters/openai-chatgpt-v1.mjs").exists());
        assert!(dir.join("adapters/fixture-v1.mjs").exists());
        assert!(dir.join("package.json").exists());
    }

    #[test]
    fn redactor_removes_protocol_secrets() {
        assert_eq!(
            redact_line(r#"{"password":"x","type":"failed"}"#),
            "[redacted worker message]"
        );
        assert_eq!(
            redact_line(r#"{"type":"failed","nested":{"access_token":"x"}}"#),
            "[redacted worker message]"
        );
    }

    #[test]
    fn redactor_keeps_normalized_safe_messages() {
        let line = r#"{"protocol_version":1,"type":"failed","request_id":"req_1","code":"flow_changed","message":"Supported page structure changed"}"#;
        assert_eq!(redact_line(line), line);
    }

    #[test]
    fn redactor_allows_exact_totp_enrollment_event() {
        let line = r#"{"protocol_version":1,"type":"totp_enrollment_secret","request_id":"req_1","value":"JBSWY3DPEHPK3PXP"}"#;
        assert_eq!(redact_line(line), line);
    }

    #[test]
    fn redactor_rejects_noncanonical_failure_messages() {
        let line = r#"{"protocol_version":1,"type":"failed","request_id":"req_1","code":"flow_changed","message":"synthetic-password"}"#;
        assert_eq!(redact_line(line), "[redacted worker message]");
    }

    #[test]
    fn resolves_expected_bundled_resource_layout() {
        let root = test_dir("resources");
        let node = root.join("account-keeper/node/node.exe");
        let worker = root.join("account-keeper/worker/account-keeper-worker.mjs");
        let runtime = root.join("account-keeper/worker/account-keeper-worker-runtime.mjs");
        let protocol = root.join("account-keeper/worker/account-keeper-protocol.mjs");
        let flow = root.join("account-keeper/worker/account-keeper-flow.mjs");
        let registry = root.join("account-keeper/worker/adapters/registry.mjs");
        let openai = root.join("account-keeper/worker/adapters/openai-chatgpt-v1.mjs");
        let fixture = root.join("account-keeper/worker/adapters/fixture-v1.mjs");
        let manifest = root.join("account-keeper/manifest.json");
        let patchright = root.join("account-keeper/worker/node_modules/patchright/package.json");
        let patchright_core =
            root.join("account-keeper/worker/node_modules/patchright-core/package.json");
        std::fs::create_dir_all(node.parent().unwrap()).unwrap();
        std::fs::create_dir_all(worker.parent().unwrap()).unwrap();
        std::fs::create_dir_all(patchright.parent().unwrap()).unwrap();
        std::fs::create_dir_all(patchright_core.parent().unwrap()).unwrap();
        std::fs::write(&node, b"synthetic-node").unwrap();
        std::fs::write(&worker, b"synthetic-worker").unwrap();
        std::fs::write(&runtime, b"synthetic-runtime").unwrap();
        std::fs::write(&protocol, b"synthetic-protocol").unwrap();
        std::fs::create_dir_all(registry.parent().unwrap()).unwrap();
        std::fs::write(&flow, b"synthetic-flow").unwrap();
        std::fs::write(&registry, b"synthetic-registry").unwrap();
        std::fs::write(&openai, b"synthetic-openai").unwrap();
        std::fs::write(&fixture, b"synthetic-fixture").unwrap();
        std::fs::write(&manifest, b"{}").unwrap();
        std::fs::write(&patchright, b"{}").unwrap();
        std::fs::write(&patchright_core, b"{}").unwrap();

        let resolved = resolve_bundled_worker_from(&root).unwrap();
        assert_eq!(resolved.node_executable, node);
        assert_eq!(resolved.worker_script, worker);
        assert_eq!(resolved.working_dir, root.join("account-keeper/worker"));
    }

    #[test]
    fn bundled_layout_rejects_missing_semantic_flow() {
        let root = test_dir("missing-flow");
        let node = root.join("account-keeper/node/node.exe");
        let worker_root = root.join("account-keeper/worker");
        std::fs::create_dir_all(worker_root.join("node_modules/patchright")).unwrap();
        std::fs::create_dir_all(worker_root.join("node_modules/patchright-core")).unwrap();
        std::fs::create_dir_all(node.parent().unwrap()).unwrap();
        std::fs::write(&node, b"synthetic-node").unwrap();
        std::fs::write(worker_root.join("account-keeper-worker.mjs"), b"worker").unwrap();
        std::fs::write(worker_root.join("account-keeper-protocol.mjs"), b"protocol").unwrap();
        std::fs::write(
            worker_root.join("node_modules/patchright/package.json"),
            b"{}",
        )
        .unwrap();
        std::fs::write(
            worker_root.join("node_modules/patchright-core/package.json"),
            b"{}",
        )
        .unwrap();
        std::fs::write(root.join("account-keeper/manifest.json"), b"{}").unwrap();

        assert!(resolve_bundled_worker_from(&root)
            .unwrap_err()
            .to_string()
            .contains("semantic flow"));
    }
}
