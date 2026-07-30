use crate::account_keeper_format::{
    mask_account, normalize_account, parse_input, totp_now, ImportedAccount, OsRandom,
    PasswordTemplate,
};
use crate::account_keeper_store::{
    AccountCheckpoint, BatchOutput, JobCheckpoint, OutputAccount, PasswordState, VaultAccount,
    VaultFile, SCHEMA_VERSION,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, Mutex};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

const ACCOUNT_KEEPER_INPUT_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountStage {
    Queued,
    Launching,
    LoggingIn,
    SubmittingTotp,
    ChangingPassword,
    VerifyingNewPassword,
    WaitingManual,
    Success,
    Failed,
    Critical,
    Cancelled,
}

impl AccountStage {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Success | Self::Failed | Self::Critical | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountEvent {
    LaunchStarted,
    LoginStarted,
    TotpRequested,
    PasswordChangeStarted,
    PasswordAccepted,
    PasswordChanged,
    VerificationStarted,
    ManualRequired,
    Resumed,
    Verified,
    Failed,
    VerificationFailed,
    CredentialStateUnknown,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRunState {
    pub account_key: String,
    pub stage: AccountStage,
    pub password_state: PasswordState,
    pub attempts: u32,
}

impl AccountRunState {
    pub fn new(account_key: impl Into<String>) -> Self {
        Self {
            account_key: account_key.into(),
            stage: AccountStage::Queued,
            password_state: PasswordState::Original,
            attempts: 0,
        }
    }

    pub fn transition(&mut self, event: AccountEvent) -> Result<()> {
        if self.stage.is_terminal() {
            bail!("Account Keeper account is already terminal");
        }
        match event {
            AccountEvent::LaunchStarted => self.stage = AccountStage::Launching,
            AccountEvent::LoginStarted => self.stage = AccountStage::LoggingIn,
            AccountEvent::TotpRequested => self.stage = AccountStage::SubmittingTotp,
            AccountEvent::PasswordChangeStarted => self.stage = AccountStage::ChangingPassword,
            AccountEvent::PasswordAccepted
            | AccountEvent::PasswordChanged
            | AccountEvent::VerificationStarted => {
                self.stage = AccountStage::VerifyingNewPassword;
                self.password_state = PasswordState::Unknown;
            }
            AccountEvent::ManualRequired => self.stage = AccountStage::WaitingManual,
            AccountEvent::Resumed => self.stage = AccountStage::LoggingIn,
            AccountEvent::Verified => {
                if !is_verification_stage(self.stage)
                    || self.password_state != PasswordState::Unknown
                {
                    bail!("Account Keeper verified event arrived outside verification state");
                }
                self.stage = AccountStage::Success;
                self.password_state = PasswordState::Changed;
            }
            AccountEvent::VerificationFailed => {
                if self.password_state == PasswordState::Unknown {
                    self.stage = AccountStage::Critical;
                } else {
                    self.stage = AccountStage::Failed;
                }
            }
            AccountEvent::CredentialStateUnknown => {
                self.stage = AccountStage::Critical;
                self.password_state = PasswordState::Unknown;
            }
            AccountEvent::Failed => {
                self.stage = if self.password_state == PasswordState::Unknown {
                    AccountStage::Critical
                } else {
                    AccountStage::Failed
                };
            }
            AccountEvent::Cancelled => {
                self.stage = if self.password_state == PasswordState::Unknown {
                    AccountStage::Critical
                } else {
                    AccountStage::Cancelled
                };
            }
        }
        Ok(())
    }
}

fn is_verification_stage(stage: AccountStage) -> bool {
    matches!(
        stage,
        AccountStage::VerifyingNewPassword
            | AccountStage::SubmittingTotp
            | AccountStage::WaitingManual
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobRunState {
    pub accounts: Vec<AccountRunState>,
}

impl JobRunState {
    pub fn can_process_next(&self) -> bool {
        !self
            .accounts
            .iter()
            .any(|account| account.stage == AccountStage::Critical)
    }

    #[cfg(test)]
    fn synthetic(count: usize) -> Self {
        Self {
            accounts: (0..count)
                .map(|index| AccountRunState::new(format!("account-{index}")))
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountView {
    pub account_key: String,
    pub masked_account: String,
    pub profile_id: Option<String>,
    pub stage: AccountStage,
    pub attempts: u32,
    pub updated_at: String,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Paused,
    WaitingManual,
    Completed,
    Failed,
    Critical,
    Cancelled,
    Abandoned,
}

impl JobStatus {
    fn from_checkpoint(value: &str) -> Self {
        match value {
            "running" => Self::Running,
            "paused" => Self::Paused,
            "waiting_manual" => Self::WaitingManual,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "critical" => Self::Critical,
            "cancelled" => Self::Cancelled,
            "abandoned" => Self::Abandoned,
            _ => Self::Queued,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::WaitingManual => "waiting_manual",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Critical => "critical",
            Self::Cancelled => "cancelled",
            Self::Abandoned => "abandoned",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobView {
    pub batch_id: String,
    pub status: JobStatus,
    pub updated_at: String,
    pub output_path: String,
    pub keep_profile_running: bool,
    pub pause_after_current: bool,
    pub accounts: Vec<AccountView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProgressEvent {
    pub revision: u64,
    pub job: JobView,
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputSource {
    Inline { text: String },
    File { path: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRequest {
    pub source: InputSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRequest {
    pub template: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRequest {
    pub source: InputSource,
    pub output_path: String,
    pub template: String,
    pub adapter_id: String,
    pub keep_profile_running: bool,
    pub pause_after_current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputValidationDto {
    pub valid_count: usize,
    pub masked_accounts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateValidationDto {
    pub valid: bool,
    pub final_length: usize,
    pub has_uppercase: bool,
    pub has_lowercase: bool,
    pub has_digit: bool,
    pub has_symbol: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerEvent {
    Stage(AccountStage),
    TotpRequired,
    ManualRequired { reason: String },
    PasswordSubmitRequired,
    PasswordChanged,
    Verified,
    Failed { code: String },
}

#[derive(Debug, Clone)]
pub struct WorkerStart {
    pub request_id: String,
    pub adapter_id: String,
    pub cdp_endpoint: String,
    pub account: String,
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerCommand {
    TotpCode(String),
    SubmitPassword,
    Resume,
    Cancel,
}

pub trait WorkerSession: Send {
    fn next_event<'a>(&'a mut self) -> BoxFuture<'a, Result<Option<WorkerEvent>>>;
    fn send<'a>(&'a mut self, command: WorkerCommand) -> BoxFuture<'a, Result<()>>;
    fn finish<'a>(&'a mut self) -> BoxFuture<'a, Result<()>>;
}

pub trait WorkerTransport: Send + Sync {
    fn spawn<'a>(&'a self, start: WorkerStart) -> BoxFuture<'a, Result<Box<dyn WorkerSession>>>;
}

pub trait Clock: Send + Sync {
    fn now(&self) -> String;
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: &ProgressEvent) -> Result<()>;
}

#[derive(Default)]
struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> String {
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        format!("@{seconds}")
    }
}

struct TauriEventSink {
    app: tauri::AppHandle,
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: &ProgressEvent) -> Result<()> {
        self.app
            .emit("account-keeper:progress", event)
            .map_err(|error| anyhow::anyhow!(error.to_string()))
    }
}

const MAX_WORKER_LINE_BYTES: usize = 64 * 1024;

struct NodeWorkerTransport {
    resource_root: Option<PathBuf>,
}

struct NodeWorkerSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    request_id: String,
}

impl WorkerTransport for NodeWorkerTransport {
    fn spawn<'a>(&'a self, start: WorkerStart) -> BoxFuture<'a, Result<Box<dyn WorkerSession>>> {
        Box::pin(async move {
            let request_id = start.request_id.clone();
            let resources =
                crate::account_keeper_worker::resolve_worker(self.resource_root.as_deref())?;
            let node_executable = node_command_path(&resources.node_executable);
            let worker_script = node_command_path(&resources.worker_script);
            let working_dir = node_command_path(&resources.working_dir);
            let mut command = Command::new(node_executable);
            command
                .arg(worker_script)
                .current_dir(working_dir)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = command.spawn().context("spawn Account Keeper worker")?;
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| anyhow::anyhow!("Account Keeper worker stdin unavailable"))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| anyhow::anyhow!("Account Keeper worker stdout unavailable"))?;
            write_worker_value(
                &mut stdin,
                &serde_json::json!({
                    "protocol_version": 1,
                    "type": "start",
                    "request_id": start.request_id,
                    "adapter_id": start.adapter_id,
                    "cdp_endpoint": start.cdp_endpoint,
                    "account": start.account,
                    "current_password": start.current_password,
                    "new_password": start.new_password,
                }),
            )
            .await?;
            let session: Box<dyn WorkerSession> = Box::new(NodeWorkerSession {
                child,
                stdin,
                stdout: BufReader::new(stdout),
                request_id,
            });
            Ok(session)
        })
    }
}

#[cfg(windows)]
fn node_command_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

#[cfg(not(windows))]
fn node_command_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

impl WorkerSession for NodeWorkerSession {
    fn next_event<'a>(&'a mut self) -> BoxFuture<'a, Result<Option<WorkerEvent>>> {
        Box::pin(async move {
            let Some(line) = read_worker_line(&mut self.stdout).await? else {
                return Ok(None);
            };
            let safe = crate::account_keeper_worker::redact_line(&line);
            if safe == "[redacted worker message]" {
                bail!("Account Keeper worker message rejected");
            }
            let value: serde_json::Value = serde_json::from_str(&safe)?;
            if value.get("request_id").and_then(|value| value.as_str())
                != Some(self.request_id.as_str())
            {
                bail!("Account Keeper worker request ID mismatch");
            }
            Ok(Some(parse_worker_line(&safe)?))
        })
    }

    fn send<'a>(&'a mut self, command: WorkerCommand) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let value = worker_command_value(&self.request_id, command);
            write_worker_value(&mut self.stdin, &value).await
        })
    }

    fn finish<'a>(&'a mut self) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            if self.child.try_wait()?.is_some() {
                return Ok(());
            }
            if tokio::time::timeout(Duration::from_secs(2), self.child.wait())
                .await
                .is_err()
            {
                let _ = self.child.kill().await;
                let _ = self.child.wait().await;
            }
            Ok(())
        })
    }
}

fn worker_command_value(request_id: &str, command: WorkerCommand) -> serde_json::Value {
    match command {
        WorkerCommand::TotpCode(code) => serde_json::json!({
            "protocol_version": 1,
            "type": "totp_code",
            "request_id": request_id,
            "code": code,
        }),
        WorkerCommand::SubmitPassword => serde_json::json!({
            "protocol_version": 1,
            "type": "submit_password",
            "request_id": request_id,
        }),
        WorkerCommand::Resume => serde_json::json!({
            "protocol_version": 1,
            "type": "resume",
            "request_id": request_id,
        }),
        WorkerCommand::Cancel => serde_json::json!({
            "protocol_version": 1,
            "type": "cancel",
            "request_id": request_id,
        }),
    }
}

async fn write_worker_value(stdin: &mut ChildStdin, value: &serde_json::Value) -> Result<()> {
    let mut encoded = serde_json::to_vec(value)?;
    if encoded.len() > MAX_WORKER_LINE_BYTES {
        encoded.fill(0);
        bail!("Account Keeper worker command exceeds 64 KiB");
    }
    encoded.push(b'\n');
    let result = stdin.write_all(&encoded).await;
    encoded.fill(0);
    result.context("write Account Keeper worker command")?;
    stdin.flush().await?;
    Ok(())
}

async fn read_worker_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<String>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            break;
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map(|index| index + 1).unwrap_or(available.len());
        if bytes.len() + take > MAX_WORKER_LINE_BYTES + 1 {
            bail!("Account Keeper worker line exceeds 64 KiB");
        }
        bytes.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            break;
        }
    }
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    if bytes.is_empty() {
        bail!("Account Keeper worker emitted an empty line");
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| anyhow::anyhow!("Account Keeper worker emitted invalid UTF-8"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobControl {
    PauseAfterCurrent,
    Continue { account_key: String },
    MarkFailed { account_key: String },
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRequest {
    pub batch_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualControlRequest {
    pub batch_id: String,
    pub account_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub batch_id: String,
    pub output_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub batch_id: String,
    pub output_path: String,
    pub exported_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbandonResult {
    pub batch_id: String,
    pub abandoned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProfileRequest {
    pub profile_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProfileResult {
    pub profile_id: String,
    pub launched: bool,
    pub already_running: bool,
}

#[derive(Default)]
struct ActiveBatch {
    batch_id: Option<String>,
    control_sender: Option<mpsc::Sender<JobControl>>,
}

fn active_batch() -> &'static Mutex<ActiveBatch> {
    static ACTIVE: OnceLock<Mutex<ActiveBatch>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(ActiveBatch::default()))
}

async fn claim_active_batch(batch_id: &str) -> Result<mpsc::Receiver<JobControl>> {
    let mut active = active_batch().lock().await;
    if let Some(current) = active.batch_id.as_deref() {
        bail!("Account Keeper batch {current} is already active");
    }
    let (sender, receiver) = mpsc::channel(32);
    active.batch_id = Some(batch_id.to_string());
    active.control_sender = Some(sender);
    Ok(receiver)
}

async fn release_active_batch(batch_id: &str) {
    let mut active = active_batch().lock().await;
    if active.batch_id.as_deref() == Some(batch_id) {
        active.batch_id = None;
        active.control_sender = None;
    }
}

async fn send_active_control(batch_id: &str, control: JobControl) -> Result<()> {
    let sender = {
        let active = active_batch().lock().await;
        if active.batch_id.as_deref() != Some(batch_id) {
            bail!("Account Keeper batch is not active; resume it explicitly");
        }
        active
            .control_sender
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Account Keeper control channel unavailable"))?
    };
    sender
        .send(control)
        .await
        .map_err(|_| anyhow::anyhow!("Account Keeper batch is no longer active"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManualDecision {
    Continue,
    MarkFailed,
    Cancel,
}

pub fn route_manual_control(account_key: &str, control: &JobControl) -> Option<ManualDecision> {
    match control {
        JobControl::Continue {
            account_key: target,
        } if target == account_key => Some(ManualDecision::Continue),
        JobControl::MarkFailed {
            account_key: target,
        } if target == account_key => Some(ManualDecision::MarkFailed),
        JobControl::Cancel => Some(ManualDecision::Cancel),
        JobControl::PauseAfterCurrent
        | JobControl::Continue { .. }
        | JobControl::MarkFailed { .. } => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FingerprintCandidate {
    pub id: String,
    pub label: String,
    pub platform: String,
}

impl FingerprintCandidate {
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        platform: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            platform: platform.into(),
        }
    }
}

pub trait ProfileRuntime: Send + Sync {
    fn profile_exists(&self, profile_id: &str) -> bool;
    fn list_fingerprints(&self) -> Result<Vec<FingerprintCandidate>>;
    fn create_profile(&self, fingerprint_id: &str, name: &str) -> Result<String>;
    fn set_folder(&self, profile_id: &str, folder: &str) -> Result<()>;

    fn is_running(&self, _profile_id: &str) -> bool {
        false
    }

    fn cdp_http_url(&self, _profile_id: &str) -> Option<String> {
        None
    }

    fn launch_with_cdp<'a>(
        &'a self,
        _profile_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>>> {
        Box::pin(async { bail!("profile launch is unavailable") })
    }

    fn kill_profile<'a>(&'a self, _profile_id: &'a str) -> BoxFuture<'a, Result<bool>> {
        Box::pin(async { Ok(false) })
    }
}

#[derive(Clone)]
struct TauriProfileRuntime {
    window: tauri::WebviewWindow,
}

impl ProfileRuntime for TauriProfileRuntime {
    fn profile_exists(&self, profile_id: &str) -> bool {
        crate::profile::load_raw(profile_id).is_ok()
    }

    fn list_fingerprints(&self) -> Result<Vec<FingerprintCandidate>> {
        Ok(crate::fingerprints::list_all()?
            .into_iter()
            .map(|entry| FingerprintCandidate::new(entry.id, entry.label, entry.platform))
            .collect())
    }

    fn create_profile(&self, fingerprint_id: &str, name: &str) -> Result<String> {
        let mut payload =
            crate::merge_library_fingerprint(fingerprint_id).map_err(anyhow::Error::msg)?;
        payload.insert(
            "name".to_string(),
            serde_json::Value::String(name.to_string()),
        );
        let value = serde_json::Value::Object(payload);
        if !value.is_object() {
            bail!("Account Keeper fingerprint payload is not an object");
        }
        let profile = crate::save_profile_core(Some(&self.window), value, true)
            .map_err(anyhow::Error::msg)?;
        Ok(profile.id)
    }

    fn set_folder(&self, profile_id: &str, folder: &str) -> Result<()> {
        crate::profile::set_folder(profile_id, folder)
    }

    fn is_running(&self, profile_id: &str) -> bool {
        crate::process::Tracker::shared()
            .running()
            .iter()
            .any(|profile| profile.profile_id == profile_id)
    }

    fn cdp_http_url(&self, profile_id: &str) -> Option<String> {
        crate::process::Tracker::shared()
            .cdp(profile_id)
            .map(|cdp| cdp.http_url)
    }

    fn launch_with_cdp<'a>(&'a self, profile_id: &'a str) -> BoxFuture<'a, Result<Option<String>>> {
        Box::pin(async move {
            let outcome = crate::launch::launch_profile(profile_id, true, false).await?;
            Ok(outcome.cdp.map(|cdp| cdp.http_url))
        })
    }

    fn kill_profile<'a>(&'a self, profile_id: &'a str) -> BoxFuture<'a, Result<bool>> {
        Box::pin(async move { crate::process::Tracker::shared().kill(profile_id).await })
    }
}

pub fn stable_account_key(account: &str) -> String {
    let normalized = normalize_account(account);
    let digest = Sha256::digest(normalized.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn opaque_profile_name(account_key: &str) -> String {
    let prefix: String = account_key.chars().take(8).collect();
    format!("acct-{prefix}")
}

fn validate_input_source_shape(source: &InputSource) -> Result<()> {
    match source {
        InputSource::Inline { text } => {
            if text.trim().is_empty() {
                bail!("Account Keeper input is required");
            }
            if text.len() > ACCOUNT_KEEPER_INPUT_LIMIT {
                bail!("Account Keeper input is too large");
            }
        }
        InputSource::File { path } => {
            if path.trim().is_empty() {
                bail!("Account Keeper input path is required");
            }
        }
    }
    Ok(())
}

fn read_input_accounts(source: &InputSource) -> Result<Vec<ImportedAccount>> {
    validate_input_source_shape(source)?;
    match source {
        InputSource::Inline { text } => parse_input(text),
        InputSource::File { path } => {
            let file = std::fs::File::open(Path::new(path))
                .map_err(|_| anyhow::anyhow!("Account Keeper input file could not be opened"))?;
            let metadata = file
                .metadata()
                .map_err(|_| anyhow::anyhow!("Account Keeper input file could not be inspected"))?;
            if metadata.len() > ACCOUNT_KEEPER_INPUT_LIMIT as u64 {
                bail!("Account Keeper input is too large");
            }

            let mut bytes = Vec::with_capacity(metadata.len() as usize);
            file.take((ACCOUNT_KEEPER_INPUT_LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| anyhow::anyhow!("Account Keeper input file could not be read"))?;
            if bytes.len() > ACCOUNT_KEEPER_INPUT_LIMIT {
                bail!("Account Keeper input is too large");
            }

            let text = String::from_utf8(bytes)
                .map_err(|_| anyhow::anyhow!("Account Keeper input is not valid UTF-8"))?;
            parse_input(&text)
        }
    }
}

pub fn validate_input_source(source: &InputSource) -> Result<InputValidationDto> {
    let accounts = read_input_accounts(source)?;
    Ok(InputValidationDto {
        valid_count: accounts.len(),
        masked_accounts: accounts
            .iter()
            .map(|account| mask_account(&account.account))
            .collect(),
    })
}

pub fn validate_template_value(template: &str) -> Result<TemplateValidationDto> {
    let parsed = PasswordTemplate::parse(template)?;
    Ok(TemplateValidationDto {
        valid: true,
        final_length: parsed.final_len(),
        has_uppercase: true,
        has_lowercase: true,
        has_digit: true,
        has_symbol: true,
    })
}

pub fn validate_cdp_http_url(value: &str) -> Result<String> {
    let url = url::Url::parse(value)?;
    let valid = url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none();
    if !valid {
        bail!("invalid Account Keeper CDP endpoint");
    }
    Ok(url.to_string())
}

pub fn merge_imports_and_checkpoint(
    runtime: &dyn ProfileRuntime,
    vault: &mut VaultFile,
    imports: &[ImportedAccount],
    request: &StartRequest,
    batch_id: &str,
    now: &str,
) -> Result<JobCheckpoint> {
    PasswordTemplate::parse(&request.template)?;
    let mut accounts = Vec::with_capacity(imports.len());

    for imported in imports {
        let account_key = stable_account_key(&imported.normalized_account);
        let existing_index = vault
            .accounts
            .iter()
            .position(|account| account.account_key == account_key);
        if existing_index
            .and_then(|index| vault.accounts.get(index))
            .is_some_and(|account| account.password_state == PasswordState::Unknown)
        {
            bail!("Account Keeper credential recovery is required before importing this account");
        }
        let existing_profile = existing_index
            .and_then(|index| vault.accounts.get(index))
            .map(|account| account.profile_id.as_str());
        let profile_id = ensure_profile_mapping(runtime, &account_key, existing_profile)?;

        let account = if let Some(index) = existing_index {
            &mut vault.accounts[index]
        } else {
            vault.accounts.push(VaultAccount {
                account_key: account_key.clone(),
                account: imported.account.clone(),
                current_password: imported.current_password.clone(),
                pending_password: None,
                totp_secret: None,
                profile_id: profile_id.clone(),
                password_state: PasswordState::Original,
                last_verified_at: None,
                last_job_id: None,
                last_status: None,
            });
            vault.accounts.last_mut().expect("vault account inserted")
        };
        account.account = imported.account.clone();
        account.current_password = imported.current_password.clone();
        account.totp_secret =
            (!imported.totp_secret.is_empty()).then(|| imported.totp_secret.clone());
        account.profile_id = profile_id.clone();
        account.password_state = PasswordState::Original;
        account.last_job_id = Some(batch_id.to_string());
        account.last_status = Some("queued".to_string());

        accounts.push(AccountCheckpoint {
            account_key,
            profile_id: Some(profile_id),
            state: "queued".to_string(),
            attempts: 0,
            updated_at: now.to_string(),
            error: None,
        });
    }

    Ok(JobCheckpoint {
        schema_version: SCHEMA_VERSION,
        batch_id: batch_id.to_string(),
        output_path: request.output_path.clone(),
        template: request.template.clone(),
        adapter_id: request.adapter_id.clone(),
        keep_profile_running: request.keep_profile_running,
        pause_after_current: request.pause_after_current,
        status: "queued".to_string(),
        updated_at: now.to_string(),
        accounts,
    })
}

pub fn parse_worker_line(line: &str) -> Result<WorkerEvent> {
    let redacted = crate::account_keeper_worker::redact_line(line);
    if redacted == "[redacted worker message]" {
        bail!("Account Keeper worker message rejected");
    }
    let value: serde_json::Value = serde_json::from_str(&redacted)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("invalid Account Keeper worker message"))?;
    if object
        .get("protocol_version")
        .and_then(|value| value.as_u64())
        != Some(1)
    {
        bail!("unsupported Account Keeper worker protocol");
    }
    let request_id = object
        .get("request_id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing Account Keeper worker request ID"))?;
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        bail!("invalid Account Keeper worker request ID");
    }
    let message_type = object
        .get("type")
        .and_then(|value| value.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing Account Keeper worker message type"))?;

    match message_type {
        "stage" => {
            ensure_worker_fields(object, &["protocol_version", "type", "request_id", "stage"])?;
            let stage = match object.get("stage").and_then(|value| value.as_str()) {
                Some("launching") => AccountStage::Launching,
                Some("logging_in") => AccountStage::LoggingIn,
                Some("submitting_totp") => AccountStage::SubmittingTotp,
                Some("changing_password") => AccountStage::ChangingPassword,
                Some("verifying_new_password") => AccountStage::VerifyingNewPassword,
                Some("waiting_manual") => AccountStage::WaitingManual,
                _ => bail!("invalid Account Keeper worker stage"),
            };
            Ok(WorkerEvent::Stage(stage))
        }
        "totp_required" => {
            ensure_worker_fields(object, &["protocol_version", "type", "request_id"])?;
            Ok(WorkerEvent::TotpRequired)
        }
        "manual_required" => {
            ensure_worker_fields(
                object,
                &["protocol_version", "type", "request_id", "reason", "url"],
            )?;
            let reason = object
                .get("reason")
                .and_then(|value| value.as_str())
                .filter(|reason| {
                    matches!(
                        *reason,
                        "captcha"
                            | "email_verification"
                            | "security_challenge"
                            | "unknown_challenge"
                            | "unusual_login"
                    )
                })
                .ok_or_else(|| anyhow::anyhow!("invalid Account Keeper manual reason"))?;
            let manual_url = object
                .get("url")
                .and_then(|value| value.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing Account Keeper manual URL"))?;
            let parsed = url::Url::parse(manual_url)?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.username() != ""
                || parsed.password().is_some()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                bail!("invalid Account Keeper manual URL");
            }
            Ok(WorkerEvent::ManualRequired {
                reason: reason.to_string(),
            })
        }
        "password_submit_required" => {
            ensure_worker_fields(object, &["protocol_version", "type", "request_id"])?;
            Ok(WorkerEvent::PasswordSubmitRequired)
        }
        "password_changed" => {
            ensure_worker_fields(object, &["protocol_version", "type", "request_id"])?;
            Ok(WorkerEvent::PasswordChanged)
        }
        "verified" => {
            ensure_worker_fields(object, &["protocol_version", "type", "request_id"])?;
            Ok(WorkerEvent::Verified)
        }
        "failed" => {
            ensure_worker_fields(
                object,
                &["protocol_version", "type", "request_id", "code", "message"],
            )?;
            let code = object
                .get("code")
                .and_then(|value| value.as_str())
                .filter(|code| {
                    matches!(
                        *code,
                        "browser_crashed"
                            | "cancelled"
                            | "credential_state_unknown"
                            | "flow_changed"
                            | "invalid_credentials"
                            | "navigation_failed"
                            | "password_change_failed"
                            | "protocol_error"
                            | "totp_rejected"
                            | "unsupported_login_method"
                            | "verification_failed"
                            | "worker_not_ready"
                    )
                })
                .ok_or_else(|| anyhow::anyhow!("invalid Account Keeper failure code"))?;
            Ok(WorkerEvent::Failed {
                code: code.to_string(),
            })
        }
        _ => bail!("unsupported Account Keeper worker message"),
    }
}

fn ensure_worker_fields(
    object: &serde_json::Map<String, serde_json::Value>,
    allowed: &[&str],
) -> Result<()> {
    if object
        .keys()
        .any(|field| !allowed.contains(&field.as_str()))
    {
        bail!("unexpected Account Keeper worker field");
    }
    Ok(())
}

#[tauri::command]
pub fn account_keeper_validate_input(
    request: PreviewRequest,
) -> std::result::Result<InputValidationDto, String> {
    validate_input_source(&request.source).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn account_keeper_validate_template(
    request: TemplateRequest,
) -> std::result::Result<TemplateValidationDto, String> {
    validate_template_value(&request.template).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn account_keeper_start_batch(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: StartRequest,
) -> std::result::Result<JobView, String> {
    start_batch(app, window, request)
        .await
        .map_err(|error| error.to_string())
}

async fn start_batch(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: StartRequest,
) -> Result<JobView> {
    ensure_account_keeper_supported()?;
    validate_start_request(&request)?;
    let batch_id = uuid::Uuid::new_v4().to_string();
    let receiver = claim_active_batch(&batch_id).await?;
    let setup = (|| -> Result<(JobCheckpoint, VaultFile)> {
        let imports = read_input_accounts(&request.source)?;
        if imports.is_empty() {
            bail!("Account Keeper input contains no accounts");
        }
        let mut vault = crate::account_keeper_store::load_vault()?;
        let runtime = TauriProfileRuntime {
            window: window.clone(),
        };
        let now = SystemClock.now();
        let checkpoint = merge_imports_and_checkpoint(
            &runtime, &mut vault, &imports, &request, &batch_id, &now,
        )?;
        crate::account_keeper_store::save_vault(&vault)?;
        crate::account_keeper_store::save_job(&checkpoint)?;
        Ok((checkpoint, vault))
    })();

    let (checkpoint, vault) = match setup {
        Ok(value) => value,
        Err(error) => {
            release_active_batch(&batch_id).await;
            return Err(error);
        }
    };
    let view = job_view_from_checkpoint(&checkpoint, &vault);
    spawn_batch(app, window, batch_id, receiver);
    Ok(view)
}

#[tauri::command]
pub fn account_keeper_list_jobs() -> std::result::Result<Vec<JobView>, String> {
    let vault = crate::account_keeper_store::load_vault().map_err(|error| error.to_string())?;
    crate::account_keeper_store::list_jobs()
        .map(|jobs| {
            jobs.iter()
                .map(|checkpoint| job_view_from_checkpoint(checkpoint, &vault))
                .collect()
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn account_keeper_get_job(request: BatchRequest) -> std::result::Result<JobView, String> {
    load_job_view(&request.batch_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn account_keeper_pause_after_current(
    request: BatchRequest,
) -> std::result::Result<JobView, String> {
    let mut checkpoint = crate::account_keeper_store::load_job(&request.batch_id)
        .map_err(|error| error.to_string())?;
    checkpoint.pause_after_current = true;
    checkpoint.updated_at = SystemClock.now();
    crate::account_keeper_store::save_job(&checkpoint).map_err(|error| error.to_string())?;
    let _ = send_active_control(&request.batch_id, JobControl::PauseAfterCurrent).await;
    load_job_view(&request.batch_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn account_keeper_cancel_batch(
    request: BatchRequest,
) -> std::result::Result<JobView, String> {
    if send_active_control(&request.batch_id, JobControl::Cancel)
        .await
        .is_err()
    {
        cancel_inactive_job(&request.batch_id).map_err(|error| error.to_string())?;
    }
    load_job_view(&request.batch_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn account_keeper_continue_manual(
    request: ManualControlRequest,
) -> std::result::Result<JobView, String> {
    send_active_control(
        &request.batch_id,
        JobControl::Continue {
            account_key: request.account_key,
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    load_job_view(&request.batch_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn account_keeper_mark_failed(
    request: ManualControlRequest,
) -> std::result::Result<JobView, String> {
    send_active_control(
        &request.batch_id,
        JobControl::MarkFailed {
            account_key: request.account_key,
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    load_job_view(&request.batch_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn account_keeper_resume_job(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: BatchRequest,
) -> std::result::Result<JobView, String> {
    resume_job(app, window, request)
        .await
        .map_err(|error| error.to_string())
}

async fn resume_job(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: BatchRequest,
) -> Result<JobView> {
    ensure_account_keeper_supported()?;
    let receiver = claim_active_batch(&request.batch_id).await?;
    let setup = (|| -> Result<(JobCheckpoint, VaultFile)> {
        let mut checkpoint = crate::account_keeper_store::load_job(&request.batch_id)?;
        let mut vault = crate::account_keeper_store::load_vault()?;
        if checkpoint.status == "critical"
            || checkpoint
                .accounts
                .iter()
                .any(|account| account.state == "critical")
            || checkpoint.accounts.iter().any(|checkpoint_account| {
                vault.accounts.iter().any(|vault_account| {
                    vault_account.account_key == checkpoint_account.account_key
                        && vault_account.password_state == PasswordState::Unknown
                })
            })
        {
            bail!("critical Account Keeper jobs cannot be resumed");
        }
        if checkpoint.status == "completed" {
            bail!("completed Account Keeper jobs do not need resume");
        }
        let runtime = TauriProfileRuntime {
            window: window.clone(),
        };
        let now = SystemClock.now();
        let mut resumable = false;
        for account in &mut checkpoint.accounts {
            let vault_account = vault
                .accounts
                .iter_mut()
                .find(|candidate| candidate.account_key == account.account_key)
                .ok_or_else(|| anyhow::anyhow!("Account Keeper vault mapping is missing"))?;
            let Some(resume_state) =
                resume_state_after_restart(&account.state, vault_account.password_state)?
            else {
                continue;
            };
            resumable = true;
            let profile_id = ensure_profile_mapping(
                &runtime,
                &account.account_key,
                Some(&vault_account.profile_id),
            )?;
            vault_account.profile_id = profile_id.clone();
            vault_account.last_job_id = Some(request.batch_id.clone());
            vault_account.last_status = Some(resume_state.to_string());
            account.profile_id = Some(profile_id);
            account.state = resume_state.to_string();
            if resume_state == "queued" {
                account.error = None;
            }
            account.updated_at = now.clone();
        }
        if !resumable {
            bail!("Account Keeper job has no resumable accounts");
        }
        checkpoint.pause_after_current = false;
        checkpoint.status = if checkpoint
            .accounts
            .iter()
            .any(|account| account.state == "waiting_manual")
        {
            "waiting_manual"
        } else {
            "queued"
        }
        .to_string();
        checkpoint.updated_at = now;
        crate::account_keeper_store::save_vault(&vault)?;
        crate::account_keeper_store::save_job(&checkpoint)?;
        Ok((checkpoint, vault))
    })();
    let (checkpoint, vault) = match setup {
        Ok(value) => value,
        Err(error) => {
            release_active_batch(&request.batch_id).await;
            return Err(error);
        }
    };
    let view = job_view_from_checkpoint(&checkpoint, &vault);
    spawn_batch(app, window, request.batch_id, receiver);
    Ok(view)
}

fn resume_state_after_restart(
    state: &str,
    password_state: PasswordState,
) -> Result<Option<&'static str>> {
    if password_state == PasswordState::Unknown || state == "critical" {
        bail!("critical Account Keeper jobs cannot be resumed");
    }
    match state {
        "success" | "failed" | "cancelled" | "waiting_manual" => Ok(None),
        "queued"
        | "launching"
        | "logging_in"
        | "submitting_totp"
        | "changing_password"
        | "verifying_new_password" => Ok(Some("queued")),
        _ => bail!("invalid Account Keeper checkpoint state"),
    }
}

#[tauri::command]
pub async fn account_keeper_abandon_job(
    request: BatchRequest,
) -> std::result::Result<AbandonResult, String> {
    let active = active_batch().lock().await;
    if active.batch_id.as_deref() == Some(request.batch_id.as_str()) {
        return Err("cancel the active Account Keeper batch before abandoning it".to_string());
    }
    drop(active);
    crate::account_keeper_store::load_job(&request.batch_id).map_err(|error| error.to_string())?;
    crate::account_keeper_store::delete_job(&request.batch_id)
        .map_err(|error| error.to_string())?;
    Ok(AbandonResult {
        batch_id: request.batch_id,
        abandoned: true,
    })
}

#[tauri::command]
pub fn account_keeper_export_result(
    request: ExportRequest,
) -> std::result::Result<ExportResult, String> {
    export_result(request).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn account_keeper_open_profile(
    request: OpenProfileRequest,
) -> std::result::Result<OpenProfileResult, String> {
    ensure_account_keeper_supported().map_err(|error| error.to_string())?;
    crate::profile::load_raw(&request.profile_id).map_err(|error| error.to_string())?;
    let already_running = crate::process::Tracker::shared()
        .running()
        .iter()
        .any(|profile| profile.profile_id == request.profile_id);
    if already_running {
        return Ok(OpenProfileResult {
            profile_id: request.profile_id,
            launched: false,
            already_running: true,
        });
    }
    crate::launch::launch_profile(&request.profile_id, false, false)
        .await
        .map_err(|error| error.to_string())?;
    Ok(OpenProfileResult {
        profile_id: request.profile_id,
        launched: true,
        already_running: false,
    })
}

fn ensure_account_keeper_supported() -> Result<()> {
    #[cfg(windows)]
    {
        Ok(())
    }
    #[cfg(not(windows))]
    {
        bail!("Account Keeper is supported on Windows only")
    }
}

fn validate_start_request(request: &StartRequest) -> Result<()> {
    validate_input_source_shape(&request.source)?;
    if request.output_path.trim().is_empty() {
        bail!("Account Keeper output path is required");
    }
    if let InputSource::File { path } = &request.source {
        if Path::new(path) == Path::new(&request.output_path) {
            bail!("Account Keeper input and output paths must differ");
        }
    }
    if !matches!(
        request.adapter_id.as_str(),
        "fixture-v1" | "openai-chatgpt-v1"
    ) {
        bail!("unsupported Account Keeper adapter");
    }
    PasswordTemplate::parse(&request.template)?;
    Ok(())
}

fn load_job_view(batch_id: &str) -> Result<JobView> {
    let checkpoint = crate::account_keeper_store::load_job(batch_id)?;
    let vault = crate::account_keeper_store::load_vault()?;
    Ok(job_view_from_checkpoint(&checkpoint, &vault))
}

fn cancel_inactive_job(batch_id: &str) -> Result<()> {
    let mut checkpoint = crate::account_keeper_store::load_job(batch_id)?;
    let mut vault = crate::account_keeper_store::load_vault()?;
    let now = SystemClock.now();
    let mut critical = false;
    for account in &mut checkpoint.accounts {
        if matches!(
            account.state.as_str(),
            "success" | "failed" | "critical" | "cancelled"
        ) {
            critical |= account.state == "critical";
            continue;
        }
        let unknown = vault
            .accounts
            .iter()
            .find(|candidate| candidate.account_key == account.account_key)
            .map(|candidate| candidate.password_state == PasswordState::Unknown)
            .unwrap_or(false);
        if unknown {
            account.state = "critical".to_string();
            account.error = Some("credential_state_unknown".to_string());
            critical = true;
        } else {
            account.state = "cancelled".to_string();
            account.error = Some("cancelled".to_string());
        }
        account.updated_at = now.clone();
        if let Some(vault_account) = vault
            .accounts
            .iter_mut()
            .find(|candidate| candidate.account_key == account.account_key)
        {
            vault_account.last_status = Some(account.state.clone());
        }
    }
    checkpoint.status = if critical { "critical" } else { "cancelled" }.to_string();
    checkpoint.updated_at = now;
    crate::account_keeper_store::save_vault(&vault)?;
    crate::account_keeper_store::save_job(&checkpoint)
}

fn export_result(request: ExportRequest) -> Result<ExportResult> {
    let checkpoint = crate::account_keeper_store::load_job(&request.batch_id)?;
    let vault = crate::account_keeper_store::load_vault()?;
    let output_path = request
        .output_path
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| checkpoint.output_path.clone());
    if output_path.trim().is_empty() {
        bail!("Account Keeper output path is required");
    }
    let output = build_output(&checkpoint, &vault, &SystemClock.now())?;
    crate::account_keeper_store::write_output(Path::new(&output_path), &output)?;
    Ok(ExportResult {
        batch_id: request.batch_id,
        output_path,
        exported_count: output.accounts.len(),
    })
}

fn build_output(checkpoint: &JobCheckpoint, vault: &VaultFile, now: &str) -> Result<BatchOutput> {
    let mut accounts = Vec::with_capacity(checkpoint.accounts.len());
    for account in &checkpoint.accounts {
        let vault_account = vault
            .accounts
            .iter()
            .find(|candidate| candidate.account_key == account.account_key)
            .ok_or_else(|| anyhow::anyhow!("Account Keeper vault mapping is missing"))?;
        accounts.push(OutputAccount {
            account: vault_account.account.clone(),
            password: vault_account.current_password.clone(),
            password_state: vault_account.password_state,
            totp_secret: vault_account.totp_secret.clone(),
            profile_id: vault_account.profile_id.clone(),
            status: account.state.clone(),
            last_verified_at: vault_account.last_verified_at.clone(),
            error: account.error.as_deref().map(safe_error_code),
        });
    }
    Ok(BatchOutput {
        schema_version: SCHEMA_VERSION,
        batch_id: checkpoint.batch_id.clone(),
        updated_at: now.to_string(),
        accounts,
    })
}

struct Coordinator {
    clock: Arc<dyn Clock>,
    profiles: Arc<dyn ProfileRuntime>,
    workers: Arc<dyn WorkerTransport>,
    events: Arc<dyn EventSink>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AccountOutcome {
    Success,
    Failed,
    Critical,
    Cancelled,
}

fn terminal_outcome(state: &AccountRunState) -> AccountOutcome {
    match state.stage {
        AccountStage::Critical => AccountOutcome::Critical,
        AccountStage::Cancelled => AccountOutcome::Cancelled,
        _ => AccountOutcome::Failed,
    }
}

fn spawn_batch(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    batch_id: String,
    receiver: mpsc::Receiver<JobControl>,
) {
    let resource_root = app.path().resource_dir().ok();
    let coordinator = Coordinator {
        clock: Arc::new(SystemClock),
        profiles: Arc::new(TauriProfileRuntime { window }),
        workers: Arc::new(NodeWorkerTransport { resource_root }),
        events: Arc::new(TauriEventSink { app }),
    };
    tauri::async_runtime::spawn(async move {
        if let Err(error) = coordinator.run_batch(&batch_id, receiver).await {
            let _ = mark_job_run_error(
                &batch_id,
                &error.to_string(),
                coordinator.clock.as_ref(),
                coordinator.events.as_ref(),
            );
        }
        release_active_batch(&batch_id).await;
    });
}

impl Coordinator {
    async fn run_batch(
        &self,
        batch_id: &str,
        mut controls: mpsc::Receiver<JobControl>,
    ) -> Result<()> {
        let mut checkpoint = crate::account_keeper_store::load_job(batch_id)?;
        let mut vault = crate::account_keeper_store::load_vault()?;
        let template = PasswordTemplate::parse(&checkpoint.template)?;
        let mut random = OsRandom;
        let mut used_passwords: HashSet<String> = vault
            .accounts
            .iter()
            .map(|account| account.current_password.clone())
            .collect();

        checkpoint.status = "running".to_string();
        persist_snapshot(
            &mut checkpoint,
            &vault,
            self.clock.as_ref(),
            self.events.as_ref(),
        )?;

        for account_index in 0..checkpoint.accounts.len() {
            match checkpoint.accounts[account_index].state.as_str() {
                "success" | "failed" | "cancelled" | "waiting_manual" => continue,
                "critical" => {
                    checkpoint.status = "critical".to_string();
                    persist_snapshot(
                        &mut checkpoint,
                        &vault,
                        self.clock.as_ref(),
                        self.events.as_ref(),
                    )?;
                    return Ok(());
                }
                _ => {}
            }

            while let Ok(control) = controls.try_recv() {
                match control {
                    JobControl::PauseAfterCurrent => checkpoint.pause_after_current = true,
                    JobControl::Cancel => {
                        cancel_remaining_accounts(
                            &mut checkpoint,
                            &mut vault,
                            account_index,
                            self.clock.now(),
                        );
                        persist_snapshot(
                            &mut checkpoint,
                            &vault,
                            self.clock.as_ref(),
                            self.events.as_ref(),
                        )?;
                        return Ok(());
                    }
                    JobControl::Continue { .. } | JobControl::MarkFailed { .. } => {}
                }
            }

            let pending_password = template.generate(&mut random, &mut used_passwords)?;
            let outcome = self
                .process_account(
                    &mut checkpoint,
                    &mut vault,
                    account_index,
                    &pending_password,
                    &mut controls,
                )
                .await?;

            match outcome {
                AccountOutcome::Critical => {
                    checkpoint.status = "critical".to_string();
                    persist_snapshot(
                        &mut checkpoint,
                        &vault,
                        self.clock.as_ref(),
                        self.events.as_ref(),
                    )?;
                    return Ok(());
                }
                AccountOutcome::Cancelled => {
                    cancel_remaining_accounts(
                        &mut checkpoint,
                        &mut vault,
                        account_index + 1,
                        self.clock.now(),
                    );
                    persist_snapshot(
                        &mut checkpoint,
                        &vault,
                        self.clock.as_ref(),
                        self.events.as_ref(),
                    )?;
                    return Ok(());
                }
                AccountOutcome::Success | AccountOutcome::Failed => {}
            }

            if checkpoint.pause_after_current {
                checkpoint.status = "paused".to_string();
                persist_snapshot(
                    &mut checkpoint,
                    &vault,
                    self.clock.as_ref(),
                    self.events.as_ref(),
                )?;
                return Ok(());
            }
        }

        checkpoint.status = final_job_status(&checkpoint).to_string();
        persist_snapshot(
            &mut checkpoint,
            &vault,
            self.clock.as_ref(),
            self.events.as_ref(),
        )?;
        if !checkpoint.output_path.trim().is_empty() {
            let output = build_output(&checkpoint, &vault, &self.clock.now())?;
            crate::account_keeper_store::write_output(Path::new(&checkpoint.output_path), &output)?;
        }
        Ok(())
    }
}

impl Coordinator {
    async fn process_account(
        &self,
        checkpoint: &mut JobCheckpoint,
        vault: &mut VaultFile,
        account_index: usize,
        pending_password: &str,
        controls: &mut mpsc::Receiver<JobControl>,
    ) -> Result<AccountOutcome> {
        let account_key = checkpoint.accounts[account_index].account_key.clone();
        let vault_index = vault
            .accounts
            .iter()
            .position(|account| account.account_key == account_key)
            .ok_or_else(|| anyhow::anyhow!("Account Keeper vault mapping is missing"))?;
        let profile_id = vault.accounts[vault_index].profile_id.clone();
        let mut state = AccountRunState {
            account_key: account_key.clone(),
            stage: account_stage_from_checkpoint(&checkpoint.accounts[account_index].state),
            password_state: vault.accounts[vault_index].password_state,
            attempts: checkpoint.accounts[account_index].attempts,
        };
        if state.stage.is_terminal() {
            state.stage = AccountStage::Queued;
        }
        let mut navigation_retries = 0usize;
        let mut crash_restarts = 0usize;
        let mut totp_requests = 0usize;

        'attempt: loop {
            state.stage = AccountStage::Queued;
            state.transition(AccountEvent::LaunchStarted)?;
            state.attempts += 1;
            record_account_state(checkpoint, account_index, &state, None, &self.clock.now());
            checkpoint.status = "running".to_string();
            persist_snapshot(checkpoint, vault, self.clock.as_ref(), self.events.as_ref())?;

            let cdp_endpoint = match prepare_profile_cdp(self.profiles.as_ref(), &profile_id).await
            {
                Ok(endpoint) => endpoint,
                Err(_) => {
                    apply_worker_event(
                        &mut state,
                        &mut vault.accounts[vault_index],
                        pending_password,
                        WorkerEvent::Failed {
                            code: "launch_failed".to_string(),
                        },
                        &self.clock.now(),
                    )?;
                    record_account_state(
                        checkpoint,
                        account_index,
                        &state,
                        Some("launch_failed"),
                        &self.clock.now(),
                    );
                    persist_snapshot(checkpoint, vault, self.clock.as_ref(), self.events.as_ref())?;
                    return Ok(AccountOutcome::Failed);
                }
            };

            let request_id = uuid::Uuid::new_v4().to_string();
            let start = WorkerStart {
                request_id,
                adapter_id: checkpoint.adapter_id.clone(),
                cdp_endpoint,
                account: vault.accounts[vault_index].account.clone(),
                current_password: vault.accounts[vault_index].current_password.clone(),
                new_password: pending_password.to_string(),
            };
            let mut session = match self.workers.spawn(start).await {
                Ok(session) => session,
                Err(_) => {
                    apply_worker_event(
                        &mut state,
                        &mut vault.accounts[vault_index],
                        pending_password,
                        WorkerEvent::Failed {
                            code: "worker_not_ready".to_string(),
                        },
                        &self.clock.now(),
                    )?;
                    record_account_state(
                        checkpoint,
                        account_index,
                        &state,
                        Some("worker_not_ready"),
                        &self.clock.now(),
                    );
                    persist_snapshot(checkpoint, vault, self.clock.as_ref(), self.events.as_ref())?;
                    stop_profile_unless_kept(
                        self.profiles.as_ref(),
                        &profile_id,
                        checkpoint.keep_profile_running,
                    )
                    .await;
                    return Ok(AccountOutcome::Failed);
                }
            };

            let mut waiting_manual = false;
            let mut controls_open = true;
            loop {
                tokio::select! {
                    event_result = session.next_event() => {
                        let event = match event_result {
                            Ok(Some(event)) => event,
                            Ok(None) => WorkerEvent::Failed { code: "browser_crashed".to_string() },
                            Err(_) => WorkerEvent::Failed {
                                code: if state.password_state == PasswordState::Unknown {
                                    "credential_state_unknown"
                                } else {
                                    "protocol_error"
                                }.to_string(),
                            },
                        };
                        match event {
                            WorkerEvent::Stage(stage) => {
                                state.stage = stage;
                                record_account_state(
                                    checkpoint,
                                    account_index,
                                    &state,
                                    None,
                                    &self.clock.now(),
                                );
                                persist_snapshot(
                                    checkpoint,
                                    vault,
                                    self.clock.as_ref(),
                                    self.events.as_ref(),
                                )?;
                            }
                            WorkerEvent::TotpRequired => {
                                apply_worker_event(
                                    &mut state,
                                    &mut vault.accounts[vault_index],
                                    pending_password,
                                    WorkerEvent::TotpRequired,
                                    &self.clock.now(),
                                )?;
                                record_account_state(
                                    checkpoint,
                                    account_index,
                                    &state,
                                    None,
                                    &self.clock.now(),
                                );
                                persist_snapshot(
                                    checkpoint,
                                    vault,
                                    self.clock.as_ref(),
                                    self.events.as_ref(),
                                )?;
                                if totp_requests > 0 {
                                    let unix_seconds = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .map(|duration| duration.as_secs())
                                        .unwrap_or(0);
                                    tokio::time::sleep(totp_retry_delay(unix_seconds)).await;
                                }
                                totp_requests += 1;
                                let secret = vault.accounts[vault_index]
                                    .totp_secret
                                    .as_deref()
                                    .filter(|secret| !secret.is_empty())
                                    .ok_or_else(|| anyhow::anyhow!("Account Keeper TOTP is required but unavailable"))?;
                                session.send(WorkerCommand::TotpCode(totp_now(secret)?)).await?;
                            }
                            WorkerEvent::ManualRequired { reason } => {
                                apply_worker_event(
                                    &mut state,
                                    &mut vault.accounts[vault_index],
                                    pending_password,
                                    WorkerEvent::ManualRequired { reason: reason.clone() },
                                    &self.clock.now(),
                                )?;
                                waiting_manual = true;
                                checkpoint.status = "waiting_manual".to_string();
                                record_account_state(
                                    checkpoint,
                                    account_index,
                                    &state,
                                    Some(&reason),
                                    &self.clock.now(),
                                );
                                persist_snapshot(
                                    checkpoint,
                                    vault,
                                    self.clock.as_ref(),
                                    self.events.as_ref(),
                                )?;
                            }
                            WorkerEvent::PasswordSubmitRequired => {
                                apply_worker_event(
                                    &mut state,
                                    &mut vault.accounts[vault_index],
                                    pending_password,
                                    WorkerEvent::PasswordSubmitRequired,
                                    &self.clock.now(),
                                )?;
                                record_account_state(
                                    checkpoint,
                                    account_index,
                                    &state,
                                    None,
                                    &self.clock.now(),
                                );
                                persist_snapshot(
                                    checkpoint,
                                    vault,
                                    self.clock.as_ref(),
                                    self.events.as_ref(),
                                )?;
                                session.send(WorkerCommand::SubmitPassword).await?;
                            }
                            WorkerEvent::PasswordChanged => {
                                apply_worker_event(
                                    &mut state,
                                    &mut vault.accounts[vault_index],
                                    pending_password,
                                    WorkerEvent::PasswordChanged,
                                    &self.clock.now(),
                                )?;
                                record_account_state(
                                    checkpoint,
                                    account_index,
                                    &state,
                                    None,
                                    &self.clock.now(),
                                );
                                persist_snapshot(
                                    checkpoint,
                                    vault,
                                    self.clock.as_ref(),
                                    self.events.as_ref(),
                                )?;
                            }
                            WorkerEvent::Verified => {
                                apply_worker_event(
                                    &mut state,
                                    &mut vault.accounts[vault_index],
                                    pending_password,
                                    WorkerEvent::Verified,
                                    &self.clock.now(),
                                )?;
                                checkpoint.status = "running".to_string();
                                record_account_state(
                                    checkpoint,
                                    account_index,
                                    &state,
                                    None,
                                    &self.clock.now(),
                                );
                                persist_snapshot(
                                    checkpoint,
                                    vault,
                                    self.clock.as_ref(),
                                    self.events.as_ref(),
                                )?;
                                if !checkpoint.output_path.trim().is_empty() {
                                    let output = build_output(checkpoint, vault, &self.clock.now())?;
                                    crate::account_keeper_store::write_output(Path::new(&checkpoint.output_path), &output)?;
                                }
                                let _ = session.finish().await;
                                stop_profile_unless_kept(
                                    self.profiles.as_ref(),
                                    &profile_id,
                                    checkpoint.keep_profile_running,
                                ).await;
                                return Ok(AccountOutcome::Success);
                            }
                            WorkerEvent::Failed { code } => {
                                let retry_navigation = code == "navigation_failed"
                                    && state.password_state != PasswordState::Unknown
                                    && navigation_retries < 2;
                                let retry_crash = code == "browser_crashed"
                                    && state.password_state != PasswordState::Unknown
                                    && crash_restarts < 1;
                                if retry_navigation || retry_crash {
                                    if retry_navigation {
                                        navigation_retries += 1;
                                    }
                                    if retry_crash {
                                        crash_restarts += 1;
                                    }
                                    state.stage = AccountStage::Queued;
                                    record_account_state(
                                        checkpoint,
                                        account_index,
                                        &state,
                                        Some(&code),
                                        &self.clock.now(),
                                    );
                                    persist_snapshot(
                                        checkpoint,
                                        vault,
                                        self.clock.as_ref(),
                                        self.events.as_ref(),
                                    )?;
                                    let _ = session.finish().await;
                                    stop_profile_unless_kept(self.profiles.as_ref(), &profile_id, false).await;
                                    continue 'attempt;
                                }
                                apply_worker_event(
                                    &mut state,
                                    &mut vault.accounts[vault_index],
                                    pending_password,
                                    WorkerEvent::Failed { code: code.clone() },
                                    &self.clock.now(),
                                )?;
                                let critical = state.stage == AccountStage::Critical;
                                record_account_state(
                                    checkpoint,
                                    account_index,
                                    &state,
                                    Some(&code),
                                    &self.clock.now(),
                                );
                                checkpoint.status = if critical { "critical" } else { "running" }.to_string();
                                persist_snapshot(
                                    checkpoint,
                                    vault,
                                    self.clock.as_ref(),
                                    self.events.as_ref(),
                                )?;
                                let _ = session.finish().await;
                                if !critical {
                                    stop_profile_unless_kept(
                                        self.profiles.as_ref(),
                                        &profile_id,
                                        checkpoint.keep_profile_running,
                                    ).await;
                                }
                                return Ok(terminal_outcome(&state));
                            }
                        }
                    }
                    control = controls.recv(), if controls_open => {
                        let Some(control) = control else {
                            controls_open = false;
                            continue;
                        };
                        match control {
                            JobControl::PauseAfterCurrent => {
                                checkpoint.pause_after_current = true;
                                persist_snapshot(
                                    checkpoint,
                                    vault,
                                    self.clock.as_ref(),
                                    self.events.as_ref(),
                                )?;
                            }
                            JobControl::Continue { .. } if waiting_manual => {
                                if route_manual_control(&account_key, &control) == Some(ManualDecision::Continue) {
                                    session.send(WorkerCommand::Resume).await?;
                                    state.transition(AccountEvent::Resumed)?;
                                    waiting_manual = false;
                                    checkpoint.status = "running".to_string();
                                    record_account_state(
                                        checkpoint,
                                        account_index,
                                        &state,
                                        None,
                                        &self.clock.now(),
                                    );
                                    persist_snapshot(
                                        checkpoint,
                                        vault,
                                        self.clock.as_ref(),
                                        self.events.as_ref(),
                                    )?;
                                }
                            }
                            JobControl::MarkFailed { .. } if waiting_manual => {
                                if route_manual_control(&account_key, &control) == Some(ManualDecision::MarkFailed) {
                                    let _ = session.send(WorkerCommand::Cancel).await;
                                    apply_worker_event(
                                        &mut state,
                                        &mut vault.accounts[vault_index],
                                        pending_password,
                                        WorkerEvent::Failed { code: "manual_marked_failed".to_string() },
                                        &self.clock.now(),
                                    )?;
                                    let outcome = terminal_outcome(&state);
                                    let critical = outcome == AccountOutcome::Critical;
                                    record_account_state(
                                        checkpoint,
                                        account_index,
                                        &state,
                                        Some("manual_marked_failed"),
                                        &self.clock.now(),
                                    );
                                    checkpoint.status = if critical { "critical" } else { "running" }.to_string();
                                    persist_snapshot(
                                        checkpoint,
                                        vault,
                                        self.clock.as_ref(),
                                        self.events.as_ref(),
                                    )?;
                                    let _ = session.finish().await;
                                    if !critical {
                                        stop_profile_unless_kept(
                                            self.profiles.as_ref(),
                                            &profile_id,
                                            checkpoint.keep_profile_running,
                                        ).await;
                                    }
                                    return Ok(outcome);
                                }
                            }
                            JobControl::Cancel => {
                                let _ = session.send(WorkerCommand::Cancel).await;
                                let code = if state.password_state == PasswordState::Unknown {
                                    "credential_state_unknown"
                                } else {
                                    "cancelled"
                                };
                                apply_worker_event(
                                    &mut state,
                                    &mut vault.accounts[vault_index],
                                    pending_password,
                                    WorkerEvent::Failed { code: code.to_string() },
                                    &self.clock.now(),
                                )?;
                                let critical = state.stage == AccountStage::Critical;
                                record_account_state(
                                    checkpoint,
                                    account_index,
                                    &state,
                                    Some(code),
                                    &self.clock.now(),
                                );
                                checkpoint.status = if critical { "critical" } else { "cancelled" }.to_string();
                                persist_snapshot(
                                    checkpoint,
                                    vault,
                                    self.clock.as_ref(),
                                    self.events.as_ref(),
                                )?;
                                let _ = session.finish().await;
                                if !critical {
                                    stop_profile_unless_kept(
                                        self.profiles.as_ref(),
                                        &profile_id,
                                        checkpoint.keep_profile_running,
                                    ).await;
                                }
                                return Ok(terminal_outcome(&state));
                            }
                            JobControl::Continue { .. } | JobControl::MarkFailed { .. } => {}
                        }
                    }
                }
            }
        }
    }
}

fn next_revision() -> u64 {
    static REVISION: AtomicU64 = AtomicU64::new(0);
    REVISION.fetch_add(1, Ordering::Relaxed) + 1
}

fn account_stage_name(stage: AccountStage) -> &'static str {
    match stage {
        AccountStage::Queued => "queued",
        AccountStage::Launching => "launching",
        AccountStage::LoggingIn => "logging_in",
        AccountStage::SubmittingTotp => "submitting_totp",
        AccountStage::ChangingPassword => "changing_password",
        AccountStage::VerifyingNewPassword => "verifying_new_password",
        AccountStage::WaitingManual => "waiting_manual",
        AccountStage::Success => "success",
        AccountStage::Failed => "failed",
        AccountStage::Critical => "critical",
        AccountStage::Cancelled => "cancelled",
    }
}

fn record_account_state(
    checkpoint: &mut JobCheckpoint,
    account_index: usize,
    state: &AccountRunState,
    error_code: Option<&str>,
    now: &str,
) {
    let account = &mut checkpoint.accounts[account_index];
    account.state = account_stage_name(state.stage).to_string();
    account.attempts = state.attempts;
    account.updated_at = now.to_string();
    account.error = error_code
        .map(safe_error_code)
        .filter(|code| !code.is_empty());
}

fn cancel_remaining_accounts(
    checkpoint: &mut JobCheckpoint,
    vault: &mut VaultFile,
    start_index: usize,
    now: String,
) {
    let mut critical = checkpoint.status == "critical";
    for account in checkpoint.accounts.iter_mut().skip(start_index) {
        if matches!(
            account.state.as_str(),
            "success" | "failed" | "critical" | "cancelled"
        ) {
            critical |= account.state == "critical";
            continue;
        }
        let vault_account = vault
            .accounts
            .iter_mut()
            .find(|candidate| candidate.account_key == account.account_key);
        let unknown = vault_account
            .as_ref()
            .map(|candidate| candidate.password_state == PasswordState::Unknown)
            .unwrap_or(false);
        if unknown {
            account.state = "critical".to_string();
            account.error = Some("credential_state_unknown".to_string());
            critical = true;
        } else {
            account.state = "cancelled".to_string();
            account.error = Some("cancelled".to_string());
        }
        account.updated_at = now.clone();
        if let Some(vault_account) = vault_account {
            vault_account.last_status = Some(account.state.clone());
        }
    }
    checkpoint.status = if critical { "critical" } else { "cancelled" }.to_string();
    checkpoint.updated_at = now;
}

async fn stop_profile_unless_kept(
    profiles: &dyn ProfileRuntime,
    profile_id: &str,
    keep_profile_running: bool,
) {
    if keep_profile_running || !profiles.is_running(profile_id) {
        return;
    }
    if profiles.kill_profile(profile_id).await.is_ok() {
        let _ = wait_profile_absent(profiles, profile_id).await;
    }
}

fn mark_job_run_error(
    batch_id: &str,
    _error: &str,
    clock: &dyn Clock,
    events: &dyn EventSink,
) -> Result<()> {
    let mut checkpoint = crate::account_keeper_store::load_job(batch_id)?;
    let mut vault = crate::account_keeper_store::load_vault()?;
    let now = clock.now();
    let mut critical = checkpoint.status == "critical";
    if let Some(account) = checkpoint.accounts.iter_mut().find(|account| {
        !matches!(
            account.state.as_str(),
            "success" | "failed" | "critical" | "cancelled"
        )
    }) {
        let vault_account = vault
            .accounts
            .iter_mut()
            .find(|candidate| candidate.account_key == account.account_key);
        let unknown = vault_account
            .as_ref()
            .map(|candidate| candidate.password_state == PasswordState::Unknown)
            .unwrap_or(false);
        if unknown {
            account.state = "critical".to_string();
            account.error = Some("credential_state_unknown".to_string());
            critical = true;
        } else {
            account.state = "failed".to_string();
            account.error = Some("coordinator_error".to_string());
        }
        account.updated_at = now.clone();
        if let Some(vault_account) = vault_account {
            vault_account.last_status = Some(account.state.clone());
        }
    }
    checkpoint.status = if critical { "critical" } else { "failed" }.to_string();
    checkpoint.updated_at = now;
    persist_snapshot(&mut checkpoint, &vault, clock, events)
}

fn persist_snapshot(
    checkpoint: &mut JobCheckpoint,
    vault: &VaultFile,
    clock: &dyn Clock,
    events: &dyn EventSink,
) -> Result<()> {
    checkpoint.updated_at = clock.now();
    crate::account_keeper_store::save_vault(vault)?;
    crate::account_keeper_store::save_job(checkpoint)?;
    write_terminal_output(checkpoint, vault, &checkpoint.updated_at)?;
    events.emit(&ProgressEvent {
        revision: next_revision(),
        job: job_view_from_checkpoint(checkpoint, vault),
    })
}

fn write_terminal_output(checkpoint: &JobCheckpoint, vault: &VaultFile, now: &str) -> Result<bool> {
    if checkpoint.output_path.trim().is_empty()
        || !checkpoint.accounts.iter().any(|account| {
            matches!(
                account.state.as_str(),
                "success" | "failed" | "critical" | "cancelled"
            )
        })
    {
        return Ok(false);
    }
    let output = build_output(checkpoint, vault, now)?;
    crate::account_keeper_store::write_output(Path::new(&checkpoint.output_path), &output)?;
    Ok(true)
}

fn totp_retry_delay(unix_seconds: u64) -> Duration {
    Duration::from_secs(30 - (unix_seconds % 30))
}

fn final_job_status(checkpoint: &JobCheckpoint) -> &'static str {
    if checkpoint
        .accounts
        .iter()
        .any(|account| account.state == "critical")
    {
        "critical"
    } else if checkpoint
        .accounts
        .iter()
        .any(|account| account.state == "waiting_manual")
    {
        "waiting_manual"
    } else if checkpoint
        .accounts
        .iter()
        .any(|account| account.state == "failed")
    {
        "failed"
    } else {
        "completed"
    }
}

pub fn ensure_profile_mapping(
    runtime: &dyn ProfileRuntime,
    account_key: &str,
    current_profile_id: Option<&str>,
) -> Result<String> {
    if let Some(profile_id) = current_profile_id.filter(|value| !value.is_empty()) {
        if runtime.profile_exists(profile_id) {
            return Ok(profile_id.to_string());
        }
    }

    let mut candidates = runtime.list_fingerprints()?;
    candidates.sort_by(|left, right| {
        left.label
            .cmp(&right.label)
            .then_with(|| left.id.cmp(&right.id))
    });
    let candidate = candidates
        .into_iter()
        .find(|candidate| candidate.platform.eq_ignore_ascii_case("windows"))
        .ok_or_else(|| anyhow::anyhow!("no Windows fingerprint is available"))?;
    let profile_id = runtime.create_profile(&candidate.id, &opaque_profile_name(account_key))?;
    runtime.set_folder(&profile_id, "Account Keeper")?;
    Ok(profile_id)
}

pub async fn prepare_profile_cdp(runtime: &dyn ProfileRuntime, profile_id: &str) -> Result<String> {
    if runtime.is_running(profile_id) {
        if let Some(endpoint) = runtime.cdp_http_url(profile_id) {
            return validate_cdp_http_url(&endpoint);
        }
        runtime.kill_profile(profile_id).await?;
        wait_profile_absent(runtime, profile_id).await?;
    }

    let mut last_error = None;
    for attempt in 0..2 {
        match runtime.launch_with_cdp(profile_id).await {
            Ok(Some(endpoint)) => return validate_cdp_http_url(&endpoint),
            Ok(None) => last_error = Some("CDP endpoint was not available".to_string()),
            Err(error) => {
                if let Some(endpoint) = runtime.cdp_http_url(profile_id) {
                    return validate_cdp_http_url(&endpoint);
                }
                last_error = Some(error.to_string());
            }
        }

        if let Some(endpoint) = wait_for_cdp(runtime, profile_id).await? {
            return validate_cdp_http_url(&endpoint);
        }
        runtime.kill_profile(profile_id).await?;
        wait_profile_absent(runtime, profile_id).await?;
        if attempt == 1 {
            break;
        }
    }

    bail!(
        "Account Keeper profile launch failed: {}",
        last_error.unwrap_or_else(|| "CDP endpoint unavailable".to_string())
    )
}

async fn wait_for_cdp(runtime: &dyn ProfileRuntime, profile_id: &str) -> Result<Option<String>> {
    for _ in 0..10 {
        if let Some(endpoint) = runtime.cdp_http_url(profile_id) {
            return Ok(Some(endpoint));
        }
        if !runtime.is_running(profile_id) {
            return Ok(None);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(None)
}

async fn wait_profile_absent(runtime: &dyn ProfileRuntime, profile_id: &str) -> Result<()> {
    for _ in 0..50 {
        if !runtime.is_running(profile_id) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("Account Keeper profile did not stop")
}

fn account_stage_from_checkpoint(value: &str) -> AccountStage {
    match value {
        "launching" => AccountStage::Launching,
        "logging_in" => AccountStage::LoggingIn,
        "submitting_totp" => AccountStage::SubmittingTotp,
        "changing_password" => AccountStage::ChangingPassword,
        "verifying_new_password" => AccountStage::VerifyingNewPassword,
        "waiting_manual" => AccountStage::WaitingManual,
        "success" => AccountStage::Success,
        "failed" => AccountStage::Failed,
        "critical" => AccountStage::Critical,
        "cancelled" => AccountStage::Cancelled,
        _ => AccountStage::Queued,
    }
}

fn safe_error_code(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_lowercase() || *character == '_')
        .take(64)
        .collect()
}

pub fn job_view_from_checkpoint(checkpoint: &JobCheckpoint, vault: &VaultFile) -> JobView {
    let accounts = checkpoint
        .accounts
        .iter()
        .map(|account| {
            let vault_account = vault
                .accounts
                .iter()
                .find(|candidate| candidate.account_key == account.account_key);
            AccountView {
                account_key: account.account_key.clone(),
                masked_account: vault_account
                    .map(|candidate| mask_account(&candidate.account))
                    .unwrap_or_else(|| "***".to_string()),
                profile_id: account
                    .profile_id
                    .clone()
                    .or_else(|| vault_account.map(|candidate| candidate.profile_id.clone())),
                stage: account_stage_from_checkpoint(&account.state),
                attempts: account.attempts,
                updated_at: account.updated_at.clone(),
                error_code: account.error.as_deref().map(safe_error_code),
            }
        })
        .collect();

    JobView {
        batch_id: checkpoint.batch_id.clone(),
        status: JobStatus::from_checkpoint(&checkpoint.status),
        updated_at: checkpoint.updated_at.clone(),
        output_path: checkpoint.output_path.clone(),
        keep_profile_running: checkpoint.keep_profile_running,
        pause_after_current: checkpoint.pause_after_current,
        accounts,
    }
}

pub fn apply_worker_event(
    state: &mut AccountRunState,
    vault: &mut VaultAccount,
    pending_password: &str,
    event: WorkerEvent,
    now: &str,
) -> Result<()> {
    match event {
        WorkerEvent::Stage(stage) => {
            state.stage = stage;
        }
        WorkerEvent::TotpRequired => state.transition(AccountEvent::TotpRequested)?,
        WorkerEvent::ManualRequired { .. } => state.transition(AccountEvent::ManualRequired)?,
        WorkerEvent::PasswordSubmitRequired => {
            if state.password_state == PasswordState::Unknown
                || vault.password_state == PasswordState::Unknown
                || vault.pending_password.is_some()
            {
                bail!("Account Keeper password submit authorization already recorded");
            }
            state.transition(AccountEvent::PasswordAccepted)?;
            vault.pending_password = Some(pending_password.to_string());
            vault.password_state = PasswordState::Unknown;
            vault.last_status = Some("credential_state_unknown".to_string());
        }
        WorkerEvent::PasswordChanged => {
            if state.password_state != PasswordState::Unknown
                || vault.password_state != PasswordState::Unknown
                || vault.pending_password.is_none()
            {
                bail!("Account Keeper password changed event arrived before password submit authorization");
            }
            state.transition(AccountEvent::PasswordChanged)?;
            vault.last_status = Some("credential_state_unknown".to_string());
        }
        WorkerEvent::Verified => {
            if !is_verification_stage(state.stage)
                || state.password_state != PasswordState::Unknown
                || vault.password_state != PasswordState::Unknown
            {
                bail!("Account Keeper verified event arrived outside verification state");
            }
            let Some(verified_password) = vault.pending_password.as_ref().cloned() else {
                bail!("Account Keeper verified event arrived without pending password");
            };
            state.transition(AccountEvent::Verified)?;
            vault.current_password = verified_password;
            vault.pending_password = None;
            vault.password_state = PasswordState::Changed;
            vault.last_verified_at = Some(now.to_string());
            vault.last_status = Some("success".to_string());
        }
        WorkerEvent::Failed { code } => {
            if code == "credential_state_unknown"
                || (code == "verification_failed" && state.password_state == PasswordState::Unknown)
            {
                state.transition(AccountEvent::CredentialStateUnknown)?;
                vault.password_state = PasswordState::Unknown;
                vault.last_status = Some("critical".to_string());
            } else if code == "cancelled" {
                state.transition(AccountEvent::Cancelled)?;
                vault.password_state = state.password_state;
                vault.last_status = Some(
                    if state.stage == AccountStage::Critical {
                        "critical"
                    } else {
                        "cancelled"
                    }
                    .to_string(),
                );
            } else {
                state.transition(AccountEvent::Failed)?;
                vault.password_state = state.password_state;
                vault.last_status = Some(
                    if state.stage == AccountStage::Critical {
                        "critical"
                    } else {
                        "failed"
                    }
                    .to_string(),
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account_keeper_store::{AccountCheckpoint, JobCheckpoint, VaultAccount, VaultFile};
    use std::sync::Mutex as StdMutex;

    fn test_dir(label: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "brproxies-account-keeper-coordinator-{label}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn input_source_deserializes_inline_and_file_variants() {
        let inline: InputSource = serde_json::from_value(serde_json::json!({
            "kind": "inline",
            "text": "owner@example.test|current-password|JBSWY3DPEHPK3PXP"
        }))
        .unwrap();
        assert!(matches!(
            inline,
            InputSource::Inline { text }
                if text == "owner@example.test|current-password|JBSWY3DPEHPK3PXP"
        ));

        let file: InputSource = serde_json::from_value(serde_json::json!({
            "kind": "file",
            "path": "C:\\fixtures\\batch.txt"
        }))
        .unwrap();
        assert!(matches!(
            file,
            InputSource::File { path } if path == "C:\\fixtures\\batch.txt"
        ));
    }

    #[test]
    fn input_source_rejects_missing_unknown_and_mixed_payloads() {
        for payload in [
            serde_json::json!({}),
            serde_json::json!({ "kind": "inline" }),
            serde_json::json!({ "kind": "file" }),
            serde_json::json!({ "kind": "unknown", "text": "synthetic" }),
            serde_json::json!({ "kind": "inline", "text": "synthetic", "path": "C:\\mixed.txt" }),
            serde_json::json!({ "kind": "file", "path": "C:\\batch.txt", "text": "synthetic" }),
        ] {
            assert!(serde_json::from_value::<InputSource>(payload).is_err());
        }
    }

    #[test]
    fn preview_request_rejects_legacy_and_unknown_outer_fields() {
        for payload in [
            serde_json::json!({
                "inputPath": "C:\\synthetic\\batch.txt"
            }),
            serde_json::json!({
                "source": { "kind": "inline", "text": "synthetic" },
                "inputPath": "C:\\synthetic\\batch.txt"
            }),
            serde_json::json!({
                "source": { "kind": "inline", "text": "synthetic" },
                "unexpected": true
            }),
        ] {
            assert!(serde_json::from_value::<PreviewRequest>(payload).is_err());
        }
    }

    #[test]
    fn start_request_rejects_legacy_and_unknown_outer_fields() {
        let legacy = serde_json::json!({
            "source": { "kind": "inline", "text": "synthetic" },
            "inputPath": "C:\\synthetic\\batch.txt",
            "outputPath": "C:\\synthetic\\result.json",
            "template": "Local-{random:16}",
            "adapterId": "fixture-v1",
            "keepProfileRunning": false,
            "pauseAfterCurrent": false
        });
        let unknown = serde_json::json!({
            "source": { "kind": "inline", "text": "synthetic" },
            "outputPath": "C:\\synthetic\\result.json",
            "template": "Local-{random:16}",
            "adapterId": "fixture-v1",
            "keepProfileRunning": false,
            "pauseAfterCurrent": false,
            "unexpected": true
        });

        assert!(serde_json::from_value::<StartRequest>(legacy).is_err());
        assert!(serde_json::from_value::<StartRequest>(unknown).is_err());
    }

    #[test]
    fn inline_and_file_sources_parse_identically() {
        let text = "owner@example.test|part|two|JBSWY3DPEHPK3PXP\n";
        let path = test_dir("input-source-equivalence").join("batch.txt");
        std::fs::write(&path, text).unwrap();

        let inline = read_input_accounts(&InputSource::Inline {
            text: text.to_string(),
        })
        .unwrap();
        let file = read_input_accounts(&InputSource::File {
            path: path.to_string_lossy().to_string(),
        })
        .unwrap();

        assert_eq!(inline, file);
        assert_eq!(inline[0].current_password, "part|two");
    }

    #[test]
    fn input_sources_reject_empty_and_oversized_values_without_echoing_secrets() {
        let empty = read_input_accounts(&InputSource::Inline {
            text: String::new(),
        })
        .unwrap_err()
        .to_string();
        assert!(empty.contains("required"));

        let secret = "SYNTHETIC_SECRET_FRAGMENT";
        let oversized = format!("{secret}{}", "x".repeat(ACCOUNT_KEEPER_INPUT_LIMIT));
        let error = read_input_accounts(&InputSource::Inline { text: oversized })
            .unwrap_err()
            .to_string();
        assert_eq!(error, "Account Keeper input is too large");
        assert!(!error.contains(secret));
    }

    #[test]
    fn oversized_file_is_rejected_with_generic_error() {
        let path = test_dir("oversized-input").join("batch.txt");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len((ACCOUNT_KEEPER_INPUT_LIMIT + 1) as u64)
            .unwrap();

        let error = read_input_accounts(&InputSource::File {
            path: path.to_string_lossy().to_string(),
        })
        .unwrap_err()
        .to_string();

        assert_eq!(error, "Account Keeper input is too large");
    }

    #[test]
    fn invalid_utf8_file_is_rejected_without_exposing_content_or_path() {
        let path_secret = "SYNTHETIC_PATH_SECRET";
        let byte_secret = "SYNTHETIC_BYTE_SECRET";
        let path = test_dir("invalid-utf8").join(format!("{path_secret}.txt"));
        let mut bytes = byte_secret.as_bytes().to_vec();
        bytes.push(0xff);
        std::fs::write(&path, bytes).unwrap();

        let error = read_input_accounts(&InputSource::File {
            path: path.to_string_lossy().to_string(),
        })
        .unwrap_err()
        .to_string();

        assert_eq!(error, "Account Keeper input is not valid UTF-8");
        assert!(!error.contains(path_secret));
        assert!(!error.contains(byte_secret));
    }

    #[test]
    fn start_request_rejects_empty_output_and_same_file_paths() {
        let inline = StartRequest {
            source: InputSource::Inline {
                text: "owner@example.test|current-password|JBSWY3DPEHPK3PXP".into(),
            },
            output_path: String::new(),
            template: "Local-{random:16}".into(),
            adapter_id: "fixture-v1".into(),
            keep_profile_running: false,
            pause_after_current: false,
        };
        assert!(validate_start_request(&inline).is_err());

        let file = StartRequest {
            source: InputSource::File {
                path: "C:/synthetic/batch.txt".into(),
            },
            output_path: "C:/synthetic/batch.txt".into(),
            ..inline
        };
        assert!(validate_start_request(&file).is_err());
    }

    #[test]
    fn inline_source_is_absent_from_checkpoint_and_job_view() {
        let source_text = "owner@example.test|current-password|JBSWY3DPEHPK3PXP";
        let imports = read_input_accounts(&InputSource::Inline {
            text: source_text.into(),
        })
        .unwrap();
        let runtime = FakeProfileRuntime {
            fingerprints: vec![FingerprintCandidate::new("windows-a", "Alpha", "Windows")],
            ..Default::default()
        };
        let mut vault = VaultFile::default();
        let request = StartRequest {
            source: InputSource::Inline {
                text: source_text.into(),
            },
            output_path: "C:/synthetic/result.json".into(),
            template: "Local-{random:16}".into(),
            adapter_id: "fixture-v1".into(),
            keep_profile_running: false,
            pause_after_current: false,
        };
        let checkpoint = merge_imports_and_checkpoint(
            &runtime,
            &mut vault,
            &imports,
            &request,
            "batch-inline",
            "2026-07-30T00:00:00Z",
        )
        .unwrap();
        let view = job_view_from_checkpoint(&checkpoint, &vault);
        let persisted = format!(
            "{} {}",
            serde_json::to_string(&checkpoint).unwrap(),
            serde_json::to_string(&view).unwrap()
        )
        .to_lowercase();

        for forbidden in [
            "owner@example.test",
            "current-password",
            "jbswy3dpehpk3pxp",
            "source_text",
            "inputsource",
        ] {
            assert!(!persisted.contains(forbidden));
        }
    }

    #[test]
    fn password_submission_then_failed_verification_becomes_critical() {
        let mut state = AccountRunState::new("account-key");
        state.transition(AccountEvent::PasswordAccepted).unwrap();
        state.transition(AccountEvent::VerificationFailed).unwrap();
        assert_eq!(state.stage, AccountStage::Critical);
        assert_eq!(state.password_state, PasswordState::Unknown);
    }

    #[test]
    fn critical_account_stops_the_batch() {
        let mut job = JobRunState::synthetic(2);
        job.accounts[0].stage = AccountStage::Critical;
        assert!(!job.can_process_next());
    }

    #[test]
    fn resume_policy_preserves_terminal_and_manual_states() {
        for terminal in ["success", "failed", "cancelled"] {
            assert_eq!(
                resume_state_after_restart(terminal, PasswordState::Original).unwrap(),
                None
            );
        }
        assert_eq!(
            resume_state_after_restart("waiting_manual", PasswordState::Original).unwrap(),
            None
        );
        assert_eq!(
            resume_state_after_restart("logging_in", PasswordState::Original).unwrap(),
            Some("queued")
        );
        assert!(resume_state_after_restart("critical", PasswordState::Original).is_err());
        assert!(resume_state_after_restart("queued", PasswordState::Unknown).is_err());
    }

    #[test]
    fn final_status_preserves_manual_accounts() {
        assert_eq!(final_job_status(&synthetic_checkpoint()), "waiting_manual");
    }

    #[test]
    fn account_view_serialization_contains_only_masked_identity() {
        let view = AccountView {
            account_key: "stable-key".into(),
            masked_account: "o***r@example.test".into(),
            profile_id: Some("profile-1".into()),
            stage: AccountStage::WaitingManual,
            attempts: 1,
            updated_at: "2026-07-29T00:00:00Z".into(),
            error_code: Some("captcha".into()),
        };
        let serialized = serde_json::to_string(&view).unwrap();
        assert!(serialized.contains("o***r@example.test"));
        for forbidden in ["password", "totp", "secret", "token", "owner@example.test"] {
            assert!(!serialized.to_lowercase().contains(forbidden));
        }
    }

    #[test]
    fn unknown_failure_and_cancel_are_critical() {
        for event in [AccountEvent::Failed, AccountEvent::Cancelled] {
            let mut state = AccountRunState::new("account-key");
            state.transition(AccountEvent::PasswordChanged).unwrap();
            state.transition(event).unwrap();
            assert_eq!(state.stage, AccountStage::Critical);
            assert_eq!(state.password_state, PasswordState::Unknown);
        }
    }

    #[test]
    fn credential_state_unknown_is_critical_until_verified() {
        let mut state = AccountRunState::new("account-key");
        state
            .transition(AccountEvent::CredentialStateUnknown)
            .unwrap();
        assert_eq!(state.stage, AccountStage::Critical);
        assert_eq!(state.password_state, PasswordState::Unknown);
    }

    #[test]
    fn stable_keys_and_profile_names_are_deterministic() {
        let first = stable_account_key("owner@example.test");
        let second = stable_account_key("  OWNER@example.test ");
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert_eq!(opaque_profile_name(&first), format!("acct-{}", &first[..8]));
    }

    #[derive(Default)]
    struct FakeProfileRuntime {
        fingerprints: Vec<FingerprintCandidate>,
        created: StdMutex<Vec<(String, String)>>,
        folders: StdMutex<Vec<(String, String)>>,
    }

    impl ProfileRuntime for FakeProfileRuntime {
        fn profile_exists(&self, _profile_id: &str) -> bool {
            false
        }

        fn list_fingerprints(&self) -> Result<Vec<FingerprintCandidate>> {
            Ok(self.fingerprints.clone())
        }

        fn create_profile(&self, fingerprint_id: &str, name: &str) -> Result<String> {
            self.created
                .lock()
                .unwrap()
                .push((fingerprint_id.to_string(), name.to_string()));
            Ok("profile-created".to_string())
        }

        fn set_folder(&self, profile_id: &str, folder: &str) -> Result<()> {
            self.folders
                .lock()
                .unwrap()
                .push((profile_id.to_string(), folder.to_string()));
            Ok(())
        }
    }

    #[test]
    fn profile_mapping_selects_first_label_sorted_windows_fingerprint() {
        let runtime = FakeProfileRuntime {
            fingerprints: vec![
                FingerprintCandidate::new("windows-z", "Zulu", "Windows"),
                FingerprintCandidate::new("linux-a", "Alpha", "Linux"),
                FingerprintCandidate::new("windows-a", "Alpha", "Windows"),
            ],
            ..Default::default()
        };
        let key = stable_account_key("owner@example.test");
        let profile_id = ensure_profile_mapping(&runtime, &key, Some("missing")).unwrap();

        assert_eq!(profile_id, "profile-created");
        assert_eq!(
            runtime.created.into_inner().unwrap(),
            vec![("windows-a".to_string(), opaque_profile_name(&key))]
        );
        assert_eq!(
            runtime.folders.into_inner().unwrap(),
            vec![("profile-created".to_string(), "Account Keeper".to_string())]
        );
    }

    #[test]
    fn manual_control_routes_only_to_matching_account() {
        assert_eq!(
            route_manual_control(
                "account-key",
                &JobControl::Continue {
                    account_key: "account-key".into(),
                },
            ),
            Some(ManualDecision::Continue)
        );
        assert_eq!(
            route_manual_control(
                "account-key",
                &JobControl::MarkFailed {
                    account_key: "other-key".into(),
                },
            ),
            None
        );
        assert_eq!(
            route_manual_control("account-key", &JobControl::Cancel),
            Some(ManualDecision::Cancel)
        );
    }

    fn synthetic_vault() -> VaultFile {
        VaultFile::single(VaultAccount {
            account_key: "account-key".into(),
            account: "owner@example.test".into(),
            current_password: "old-password".into(),
            pending_password: None,
            totp_secret: Some("JBSWY3DPEHPK3PXP".into()),
            profile_id: "profile-1".into(),
            password_state: PasswordState::Original,
            last_verified_at: None,
            last_job_id: Some("batch-1".into()),
            last_status: Some("queued".into()),
        })
    }

    fn synthetic_checkpoint() -> JobCheckpoint {
        JobCheckpoint {
            schema_version: 1,
            batch_id: "batch-1".into(),
            output_path: "C:/synthetic/result.json".into(),
            template: "Local-{random:16}".into(),
            adapter_id: "fixture-v1".into(),
            keep_profile_running: false,
            pause_after_current: false,
            status: "waiting_manual".into(),
            updated_at: "2026-07-29T00:00:00Z".into(),
            accounts: vec![AccountCheckpoint {
                account_key: "account-key".into(),
                profile_id: Some("profile-1".into()),
                state: "waiting_manual".into(),
                attempts: 1,
                updated_at: "2026-07-29T00:00:00Z".into(),
                error: Some("captcha".into()),
            }],
        }
    }

    #[test]
    fn checkpoint_conversion_masks_identity_and_redacts_job_dto() {
        let view = job_view_from_checkpoint(&synthetic_checkpoint(), &synthetic_vault());
        assert_eq!(view.accounts[0].masked_account, "o***r@example.test");
        let serialized = serde_json::to_string(&view).unwrap().to_lowercase();
        for forbidden in [
            "owner@example.test",
            "old-password",
            "jbswy3dpehpk3pxp",
            "cookie",
            "token",
            "html",
            "?query=",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn terminal_checkpoint_writes_output_immediately() {
        let output_path = test_dir("terminal-output").join("result.json");
        let mut checkpoint = synthetic_checkpoint();
        checkpoint.output_path = output_path.to_string_lossy().to_string();
        checkpoint.accounts[0].state = "failed".into();
        checkpoint.accounts[0].error = Some("invalid_credentials".into());
        let vault = synthetic_vault();

        assert!(write_terminal_output(&checkpoint, &vault, "2026-07-29T00:01:00Z").unwrap());

        let output: BatchOutput =
            serde_json::from_str(&std::fs::read_to_string(output_path).unwrap()).unwrap();
        assert_eq!(output.accounts[0].status, "failed");
        assert_eq!(
            output.accounts[0].error.as_deref(),
            Some("invalid_credentials")
        );
    }

    #[test]
    fn worker_events_persist_pending_password_before_submission() {
        let mut vault = synthetic_vault().accounts.remove(0);
        let mut state = AccountRunState::new("account-key");

        apply_worker_event(
            &mut state,
            &mut vault,
            "new-password",
            WorkerEvent::PasswordSubmitRequired,
            "2026-07-29T00:00:00Z",
        )
        .unwrap();
        assert_eq!(vault.current_password, "old-password");
        assert_eq!(vault.pending_password.as_deref(), Some("new-password"));
        assert_eq!(vault.password_state, PasswordState::Unknown);

        apply_worker_event(
            &mut state,
            &mut vault,
            "ignored-password",
            WorkerEvent::PasswordChanged,
            "2026-07-29T00:00:30Z",
        )
        .unwrap();

        apply_worker_event(
            &mut state,
            &mut vault,
            "ignored-password",
            WorkerEvent::Verified,
            "2026-07-29T00:01:00Z",
        )
        .unwrap();
        assert_eq!(vault.current_password, "new-password");
        assert_eq!(vault.pending_password, None);
        assert_eq!(vault.password_state, PasswordState::Changed);
        assert_eq!(
            vault.last_verified_at.as_deref(),
            Some("2026-07-29T00:01:00Z")
        );
    }

    #[test]
    fn password_changed_requires_prior_submit_authorization() {
        let mut vault = synthetic_vault().accounts.remove(0);
        let mut state = AccountRunState::new("account-key");

        let error = apply_worker_event(
            &mut state,
            &mut vault,
            "new-password",
            WorkerEvent::PasswordChanged,
            "2026-07-29T00:00:00Z",
        )
        .unwrap_err();

        assert!(error.to_string().contains("password submit authorization"));
        assert_eq!(vault.current_password, "old-password");
        assert_eq!(vault.pending_password, None);
        assert_eq!(vault.password_state, PasswordState::Original);
    }

    #[test]
    fn rejected_verified_event_preserves_pending_password() {
        let mut vault = synthetic_vault().accounts.remove(0);
        vault.pending_password = Some("new-password".into());
        vault.password_state = PasswordState::Unknown;
        let mut state = AccountRunState::new("account-key");
        state.password_state = PasswordState::Unknown;
        state.stage = AccountStage::LoggingIn;

        assert!(apply_worker_event(
            &mut state,
            &mut vault,
            "ignored-password",
            WorkerEvent::Verified,
            "2026-07-29T00:01:00Z",
        )
        .is_err());

        assert_eq!(vault.current_password, "old-password");
        assert_eq!(vault.pending_password.as_deref(), Some("new-password"));
        assert_eq!(vault.password_state, PasswordState::Unknown);
    }

    #[test]
    fn verified_event_accepts_verification_totp_stage() {
        let mut vault = synthetic_vault().accounts.remove(0);
        let mut state = AccountRunState::new("account-key");
        apply_worker_event(
            &mut state,
            &mut vault,
            "new-password",
            WorkerEvent::PasswordSubmitRequired,
            "2026-07-29T00:00:00Z",
        )
        .unwrap();
        state.stage = AccountStage::SubmittingTotp;

        apply_worker_event(
            &mut state,
            &mut vault,
            "ignored-password",
            WorkerEvent::Verified,
            "2026-07-29T00:01:00Z",
        )
        .unwrap();

        assert_eq!(state.stage, AccountStage::Success);
        assert_eq!(vault.current_password, "new-password");
        assert_eq!(vault.pending_password, None);
    }

    #[test]
    fn terminal_outcome_is_critical_after_submit_authorization() {
        let mut state = AccountRunState::new("account-key");
        state.transition(AccountEvent::PasswordAccepted).unwrap();
        state.transition(AccountEvent::Failed).unwrap();

        assert_eq!(terminal_outcome(&state), AccountOutcome::Critical);
    }

    #[cfg(windows)]
    #[test]
    fn backend_support_guard_allows_windows() {
        ensure_account_keeper_supported().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn node_command_path_strips_windows_verbatim_prefix() {
        assert_eq!(
            node_command_path(Path::new(r"\\?\C:\repo\worker.mjs")),
            PathBuf::from(r"C:\repo\worker.mjs")
        );
        assert_eq!(
            node_command_path(Path::new(r"\\?\UNC\server\share\worker.mjs")),
            PathBuf::from(r"\\server\share\worker.mjs")
        );
    }

    #[test]
    fn verified_event_requires_password_submission_state() {
        let mut vault = synthetic_vault().accounts.remove(0);
        let original_password = vault.current_password.clone();
        let mut state = AccountRunState::new("account-key");

        let error = apply_worker_event(
            &mut state,
            &mut vault,
            "new-password",
            WorkerEvent::Verified,
            "2026-07-29T00:01:00Z",
        )
        .unwrap_err();

        assert!(error.to_string().contains("verification state"));
        assert_eq!(vault.current_password, original_password);
        assert_eq!(vault.password_state, PasswordState::Original);
    }

    #[test]
    fn credential_unknown_worker_event_never_commits_pending_password() {
        let mut vault = synthetic_vault().accounts.remove(0);
        let mut state = AccountRunState::new("account-key");
        apply_worker_event(
            &mut state,
            &mut vault,
            "new-password",
            WorkerEvent::Failed {
                code: "credential_state_unknown".into(),
            },
            "2026-07-29T00:00:00Z",
        )
        .unwrap();
        assert_eq!(vault.current_password, "old-password");
        assert_eq!(vault.password_state, PasswordState::Unknown);
        assert_eq!(state.stage, AccountStage::Critical);
    }

    #[test]
    fn input_preview_reads_file_and_returns_only_masked_accounts() {
        let path = test_dir("preview").join("accounts.txt");
        std::fs::write(
            &path,
            "owner@example.test|old-password|JBSWY3DPEHPK3PXP\nsecond@example.test|other-password|",
        )
        .unwrap();
        let preview = validate_input_source(&InputSource::File {
            path: path.to_string_lossy().to_string(),
        })
        .unwrap();
        assert_eq!(preview.valid_count, 2);
        assert_eq!(
            preview.masked_accounts,
            vec!["o***r@example.test", "s***d@example.test"]
        );
        let serialized = serde_json::to_string(&preview).unwrap().to_lowercase();
        for forbidden in ["old-password", "other-password", "jbswy3dpehpk3pxp"] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn template_preview_reports_only_shape() {
        let preview = validate_template_value("Local-{random:16}").unwrap();
        assert_eq!(preview.final_length, 22);
        assert!(preview.valid);
    }

    #[test]
    fn totp_retry_waits_for_next_counter_window() {
        assert_eq!(totp_retry_delay(60), Duration::from_secs(30));
        assert_eq!(totp_retry_delay(61), Duration::from_secs(29));
        assert_eq!(totp_retry_delay(89), Duration::from_secs(1));
    }

    #[test]
    fn cdp_endpoint_requires_exact_loopback_http_origin() {
        assert_eq!(
            validate_cdp_http_url("http://127.0.0.1:9222").unwrap(),
            "http://127.0.0.1:9222/"
        );
        for invalid in [
            "http://localhost:9222",
            "https://127.0.0.1:9222",
            "http://127.0.0.1:9222/path",
            "http://127.0.0.1:9222/?token=x",
        ] {
            assert!(validate_cdp_http_url(invalid).is_err());
        }
    }

    #[test]
    fn worker_parser_accepts_only_redacted_approved_fields() {
        let event = parse_worker_line(
            r#"{"protocol_version":1,"type":"manual_required","request_id":"req_1","reason":"captcha","url":"https://example.test/challenge"}"#,
        )
        .unwrap();
        assert_eq!(
            event,
            WorkerEvent::ManualRequired {
                reason: "captcha".into()
            }
        );
        assert!(parse_worker_line(r#"{"type":"failed","password":"secret"}"#).is_err());
    }

    #[test]
    fn worker_parser_accepts_password_submit_handshake() {
        assert_eq!(
            parse_worker_line(
                r#"{"protocol_version":1,"type":"password_submit_required","request_id":"req_1"}"#,
            )
            .unwrap(),
            WorkerEvent::PasswordSubmitRequired
        );
    }

    #[test]
    fn worker_command_serializes_password_submit_authorization() {
        assert_eq!(
            worker_command_value("req_1", WorkerCommand::SubmitPassword),
            serde_json::json!({
                "protocol_version": 1,
                "type": "submit_password",
                "request_id": "req_1",
            })
        );
    }

    #[test]
    fn import_merge_keeps_checkpoint_credential_field_free() {
        let imports = crate::account_keeper_format::parse_input(
            "owner@example.test|old-password|JBSWY3DPEHPK3PXP",
        )
        .unwrap();
        let runtime = FakeProfileRuntime {
            fingerprints: vec![FingerprintCandidate::new("windows-a", "Alpha", "Windows")],
            ..Default::default()
        };
        let mut vault = VaultFile::default();
        let checkpoint = merge_imports_and_checkpoint(
            &runtime,
            &mut vault,
            &imports,
            &StartRequest {
                source: InputSource::File {
                    path: "C:/synthetic/accounts.txt".into(),
                },
                output_path: "C:/synthetic/output.json".into(),
                template: "Local-{random:16}".into(),
                adapter_id: "fixture-v1".into(),
                keep_profile_running: false,
                pause_after_current: false,
            },
            "batch-1",
            "2026-07-29T00:00:00Z",
        )
        .unwrap();
        let checkpoint_json = serde_json::to_string(&checkpoint).unwrap().to_lowercase();
        for forbidden_field in ["password", "totp"] {
            assert!(!checkpoint_json.contains(forbidden_field));
        }
        assert_eq!(vault.accounts.len(), 1);
        assert_eq!(vault.accounts[0].profile_id, "profile-created");
    }

    #[test]
    fn import_rejects_unknown_credential_state_without_overwrite() {
        let imports = crate::account_keeper_format::parse_input(
            "owner@example.test|replacement-password|JBSWY3DPEHPK3PXP",
        )
        .unwrap();
        let runtime = FakeProfileRuntime {
            fingerprints: vec![FingerprintCandidate::new("windows-a", "Alpha", "Windows")],
            ..Default::default()
        };
        let mut vault = synthetic_vault();
        vault.accounts[0].account_key = stable_account_key("owner@example.test");
        vault.accounts[0].password_state = PasswordState::Unknown;
        let original_password = vault.accounts[0].current_password.clone();

        let error = merge_imports_and_checkpoint(
            &runtime,
            &mut vault,
            &imports,
            &StartRequest {
                source: InputSource::File {
                    path: "C:/synthetic/accounts.txt".into(),
                },
                output_path: "C:/synthetic/output.json".into(),
                template: "Local-{random:16}".into(),
                adapter_id: "fixture-v1".into(),
                keep_profile_running: false,
                pause_after_current: false,
            },
            "batch-2",
            "2026-07-29T00:00:00Z",
        )
        .unwrap_err();

        assert!(error.to_string().contains("credential recovery"));
        assert_eq!(vault.accounts[0].current_password, original_password);
        assert_eq!(vault.accounts[0].password_state, PasswordState::Unknown);
        assert!(runtime.created.lock().unwrap().is_empty());
    }

    struct LifecycleProfileRuntime {
        running: StdMutex<bool>,
        launch_results: StdMutex<std::collections::VecDeque<Option<String>>>,
        launches: StdMutex<usize>,
        kills: StdMutex<usize>,
    }

    impl ProfileRuntime for LifecycleProfileRuntime {
        fn profile_exists(&self, _profile_id: &str) -> bool {
            true
        }

        fn list_fingerprints(&self) -> Result<Vec<FingerprintCandidate>> {
            Ok(Vec::new())
        }

        fn create_profile(&self, _fingerprint_id: &str, _name: &str) -> Result<String> {
            unreachable!()
        }

        fn set_folder(&self, _profile_id: &str, _folder: &str) -> Result<()> {
            Ok(())
        }

        fn is_running(&self, _profile_id: &str) -> bool {
            *self.running.lock().unwrap()
        }

        fn cdp_http_url(&self, _profile_id: &str) -> Option<String> {
            None
        }

        fn launch_with_cdp<'a>(
            &'a self,
            _profile_id: &'a str,
        ) -> BoxFuture<'a, Result<Option<String>>> {
            Box::pin(async move {
                *self.launches.lock().unwrap() += 1;
                *self.running.lock().unwrap() = true;
                Ok(self.launch_results.lock().unwrap().pop_front().flatten())
            })
        }

        fn kill_profile<'a>(&'a self, _profile_id: &'a str) -> BoxFuture<'a, Result<bool>> {
            Box::pin(async move {
                *self.kills.lock().unwrap() += 1;
                *self.running.lock().unwrap() = false;
                Ok(true)
            })
        }
    }

    #[tokio::test]
    async fn lifecycle_kills_stale_profile_and_retries_missing_cdp_once() {
        let runtime = LifecycleProfileRuntime {
            running: StdMutex::new(true),
            launch_results: StdMutex::new(std::collections::VecDeque::from([
                None,
                Some("http://127.0.0.1:9222".into()),
            ])),
            launches: StdMutex::new(0),
            kills: StdMutex::new(0),
        };
        let endpoint = prepare_profile_cdp(&runtime, "profile-1").await.unwrap();
        assert_eq!(endpoint, "http://127.0.0.1:9222/");
        assert_eq!(*runtime.launches.lock().unwrap(), 2);
        assert_eq!(*runtime.kills.lock().unwrap(), 2);
    }
}
