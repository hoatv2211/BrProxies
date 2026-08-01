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
    LoginVerified,
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
            AccountEvent::LoginVerified => {
                if !is_verification_stage(self.stage) {
                    bail!(
                        "Account Keeper login verified event arrived outside verification state"
                    );
                }
                self.stage = AccountStage::Success;
                // Login mode does not rotate — password stays Original.
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

    pub fn as_str(self) -> &'static str {
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

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRequest {
    pub source: InputSource,
    pub output_path: String,
    pub template: String,
    pub adapter_id: String,
    #[serde(default = "default_batch_operation")]
    pub operation: String,
    pub keep_profile_running: bool,
    pub pause_after_current: bool,
}

fn default_batch_operation() -> String {
    "change_password".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchOperation {
    Login,
    ChangePassword,
}

pub(crate) fn account_keeper_batch_operation(request: &StartRequest) -> BatchOperation {
    match request.operation.as_str() {
        "login" => BatchOperation::Login,
        _ => BatchOperation::ChangePassword,
    }
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountKeeperDefaultsDto {
    pub template: String,
    pub output_path: String,
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
    pub operation: String,
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
                .kill_on_drop(true);
            // When BRPROXIES_AK_DEBUG points at a log file, route the worker's
            // stderr to a sibling `.stderr` file so patchright crashes/timeouts
            // are visible. Off by default: without the env var, stderr stays
            // discarded exactly as before.
            match std::env::var("BRPROXIES_AK_DEBUG").ok().filter(|value| !value.is_empty()) {
                Some(debug_path) => {
                    let stderr_path = format!("{debug_path}.stderr");
                    match std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&stderr_path)
                    {
                        Ok(file) => {
                            command.stderr(Stdio::from(file));
                        }
                        Err(_) => {
                            command.stderr(Stdio::null());
                        }
                    }
                }
                None => {
                    command.stderr(Stdio::null());
                }
            }
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
                    "operation": start.operation,
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
struct NullEventSink;

impl EventSink for NullEventSink {
    fn emit(&self, _event: &ProgressEvent) -> Result<()> {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedProfileImportPayload {
    pub schema_version: u32,
    pub kind: String,
    pub profile_id: String,
    pub account_status: String,
    pub last_verified_at: Option<String>,
    pub api_base_url: String,
    pub vault_ref: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedProfileView {
    pub profile_id: String,
    pub masked_account: String,
    pub status: String,
    pub rotated: bool,
    pub last_verified_at: Option<String>,
    pub running: bool,
    pub import_payload: ManagedProfileImportPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanProgressResult {
    pub batch_id: String,
    pub cleaned: bool,
    pub forgotten_recovery_accounts: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteManagedProfileResult {
    pub profile_id: String,
    pub deleted: bool,
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

    /// Label a profile after a verified rotation (visible name + Notes line).
    /// Default no-op so test doubles need not implement it.
    fn set_label(&self, _profile_id: &str, _name: &str, _notes: &str) -> Result<()> {
        Ok(())
    }

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

#[derive(Clone, Default)]
struct HeadlessProfileRuntime;

fn local_profile_exists(profile_id: &str) -> bool {
    crate::profile::load_raw(profile_id).is_ok()
}

fn local_fingerprints() -> Result<Vec<FingerprintCandidate>> {
    Ok(crate::fingerprints::list_all()?
        .into_iter()
        .map(|entry| FingerprintCandidate::new(entry.id, entry.label, entry.platform))
        .collect())
}

fn create_local_profile(
    window: Option<&tauri::WebviewWindow>,
    fingerprint_id: &str,
    name: &str,
) -> Result<String> {
    let mut payload = crate::merge_library_fingerprint(fingerprint_id)
        .map_err(anyhow::Error::msg)?;
    payload.insert(
        "name".to_string(),
        serde_json::Value::String(name.to_string()),
    );
    let value = serde_json::Value::Object(payload);
    if !value.is_object() {
        bail!("Account Keeper fingerprint payload is not an object");
    }
    let profile = crate::save_profile_core(window, value, true).map_err(anyhow::Error::msg)?;
    Ok(profile.id)
}

fn profile_cdp_from_disk(profile_id: &str) -> Option<String> {
    let path = crate::profile::user_data_dir(profile_id)
        .ok()?
        .join("DevToolsActivePort");
    let contents = std::fs::read_to_string(path).ok()?;
    let port = contents.lines().next()?.trim().parse::<u16>().ok()?;
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&address, Duration::from_millis(200)).ok()?;
    Some(format!("http://127.0.0.1:{port}"))
}

fn local_profile_running(profile_id: &str) -> bool {
    crate::process::Tracker::shared()
        .running()
        .iter()
        .any(|profile| profile.profile_id == profile_id)
        || profile_cdp_from_disk(profile_id).is_some()
}

fn local_profile_cdp(profile_id: &str) -> Option<String> {
    crate::process::Tracker::shared()
        .cdp(profile_id)
        .map(|cdp| cdp.http_url)
        .or_else(|| profile_cdp_from_disk(profile_id))
}

impl ProfileRuntime for TauriProfileRuntime {
    fn profile_exists(&self, profile_id: &str) -> bool {
        local_profile_exists(profile_id)
    }

    fn list_fingerprints(&self) -> Result<Vec<FingerprintCandidate>> {
        local_fingerprints()
    }

    fn create_profile(&self, fingerprint_id: &str, name: &str) -> Result<String> {
        create_local_profile(Some(&self.window), fingerprint_id, name)
    }

    fn set_folder(&self, profile_id: &str, folder: &str) -> Result<()> {
        crate::profile::set_folder(profile_id, folder)
    }

    fn set_label(&self, profile_id: &str, name: &str, notes: &str) -> Result<()> {
        crate::profile::set_account_keeper_label(profile_id, name, notes)
    }

    fn is_running(&self, profile_id: &str) -> bool {
        local_profile_running(profile_id)
    }

    fn cdp_http_url(&self, profile_id: &str) -> Option<String> {
        local_profile_cdp(profile_id)
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

impl ProfileRuntime for HeadlessProfileRuntime {
    fn profile_exists(&self, profile_id: &str) -> bool {
        local_profile_exists(profile_id)
    }

    fn list_fingerprints(&self) -> Result<Vec<FingerprintCandidate>> {
        local_fingerprints()
    }

    fn create_profile(&self, fingerprint_id: &str, name: &str) -> Result<String> {
        create_local_profile(None, fingerprint_id, name)
    }

    fn set_folder(&self, profile_id: &str, folder: &str) -> Result<()> {
        crate::profile::set_folder(profile_id, folder)
    }

    fn set_label(&self, profile_id: &str, name: &str, notes: &str) -> Result<()> {
        crate::profile::set_account_keeper_label(profile_id, name, notes)
    }

    fn is_running(&self, profile_id: &str) -> bool {
        local_profile_running(profile_id)
    }

    fn cdp_http_url(&self, profile_id: &str) -> Option<String> {
        local_profile_cdp(profile_id)
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

fn default_config_for(base_dir: &Path) -> Result<AccountKeeperDefaultsDto> {
    let template = "BrP@{random:16}!".to_string();
    validate_template_value(&template)?;
    let output_path = base_dir.join("output").join("account-keeper-result.json");
    let output_path = output_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Account Keeper output path is not valid Unicode"))?
        .to_owned();
    Ok(AccountKeeperDefaultsDto {
        template,
        output_path,
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
    if account_keeper_batch_operation(request) == BatchOperation::ChangePassword {
        PasswordTemplate::parse(&request.template)?;
    }
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

        // Label the profile at import time so operators can identify it from the
        // browser list before the rotation runs. SECURITY: writes the plaintext
        // credential line into unencrypted profile JSON immediately on import, by
        // operator request. Best-effort — a labeling failure must not abort the
        // import.
        label_account_profile(runtime, account);

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
        operation: request.operation.clone(),
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
pub fn account_keeper_defaults() -> std::result::Result<AccountKeeperDefaultsDto, String> {
    let base_dir = std::env::current_dir()
        .ok()
        .or_else(dirs::document_dir)
        .ok_or_else(|| "Account Keeper base directory is not available".to_string())?;
    default_config_for(&base_dir).map_err(|error| error.to_string())
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
    let runtime = TauriProfileRuntime {
        window: window.clone(),
    };
    let setup = prepare_new_batch(&runtime, &request, &batch_id);

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

fn prepare_new_batch(
    runtime: &dyn ProfileRuntime,
    request: &StartRequest,
    batch_id: &str,
) -> Result<(JobCheckpoint, VaultFile)> {
    let imports = read_input_accounts(&request.source)?;
    if imports.is_empty() {
        bail!("Account Keeper input contains no accounts");
    }
    let mut vault = crate::account_keeper_store::load_vault()?;
    let now = SystemClock.now();
    let checkpoint = merge_imports_and_checkpoint(
        runtime,
        &mut vault,
        &imports,
        request,
        batch_id,
        &now,
    )?;
    crate::account_keeper_store::save_vault(&vault)?;
    crate::account_keeper_store::save_job(&checkpoint)?;
    Ok((checkpoint, vault))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadlessRunResult {
    pub job: JobView,
    pub stopped_for_manual: bool,
    pub timed_out: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HeadlessRecoveryState {
    pub password_state: String,
    pub has_pending_password: bool,
    pub has_last_verified_at: bool,
    pub last_status: Option<String>,
    pub profile_running: bool,
    pub latest_stage: Option<AccountStage>,
    pub latest_error_code: Option<String>,
}

pub fn inspect_headless_recovery(source: &InputSource) -> Result<Option<HeadlessRecoveryState>> {
    let imports = read_input_accounts(source)?;
    if imports.len() != 1 {
        return Ok(None);
    }
    let account_key = stable_account_key(&imports[0].normalized_account);
    let vault = crate::account_keeper_store::load_vault()?;
    let Some(account) = vault
        .accounts
        .iter()
        .find(|account| account.account_key == account_key)
    else {
        return Ok(None);
    };
    let mut latest = None;
    for checkpoint in crate::account_keeper_store::list_jobs()? {
        if let Some(candidate) = checkpoint
            .accounts
            .iter()
            .find(|candidate| candidate.account_key == account_key)
        {
            let replace = latest
                .as_ref()
                .is_none_or(|(updated_at, _, _): &(String, String, Option<String>)| {
                    checkpoint.updated_at > *updated_at
                });
            if replace {
                latest = Some((
                    checkpoint.updated_at.clone(),
                    candidate.state.clone(),
                    candidate.error.clone(),
                ));
            }
        }
    }
    let (latest_stage, latest_error_code) = latest
        .map(|(_, state, error)| {
            (
                Some(account_stage_from_checkpoint(&state)),
                error.as_deref().map(safe_error_code),
            )
        })
        .unwrap_or((None, None));
    Ok(Some(HeadlessRecoveryState {
        password_state: match account.password_state {
            PasswordState::Original => "original",
            PasswordState::Changed => "changed",
            PasswordState::Unknown => "unknown",
        }
        .to_string(),
        has_pending_password: account.pending_password.is_some(),
        has_last_verified_at: account.last_verified_at.is_some(),
        last_status: account.last_status.as_deref().map(safe_error_code),
        profile_running: local_profile_running(&account.profile_id),
        latest_stage,
        latest_error_code,
    }))
}

fn headless_worker_resource_root_from(executable: &Path) -> Option<PathBuf> {
    executable.parent().map(Path::to_path_buf)
}

fn headless_worker_resource_root() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|executable| headless_worker_resource_root_from(&executable))
}

pub async fn run_headless_batch(
    request: StartRequest,
    timeout_seconds: u64,
) -> Result<HeadlessRunResult> {
    ensure_account_keeper_supported()?;
    validate_start_request(&request)?;
    let batch_id = uuid::Uuid::new_v4().to_string();
    let receiver = claim_active_batch(&batch_id).await?;
    let runtime = HeadlessProfileRuntime;
    if let Err(error) = prepare_new_batch(&runtime, &request, &batch_id) {
        release_active_batch(&batch_id).await;
        return Err(error);
    }

    let coordinator = Coordinator {
        clock: Arc::new(SystemClock),
        profiles: Arc::new(runtime),
        workers: Arc::new(NodeWorkerTransport {
            resource_root: headless_worker_resource_root(),
        }),
        events: Arc::new(NullEventSink),
    };
    let mut run = Box::pin(coordinator.run_batch(&batch_id, receiver));
    let deadline = tokio::time::Instant::now()
        + Duration::from_secs(timeout_seconds.clamp(30, 3600));
    let mut poll = tokio::time::interval(Duration::from_millis(250));
    let mut stopped_for_manual = false;
    let mut timed_out = false;

    let run_result = loop {
        tokio::select! {
            result = &mut run => break result,
            _ = poll.tick() => {
                if let Ok(view) = load_job_view(&batch_id) {
                    if view.status == JobStatus::WaitingManual {
                        stopped_for_manual = true;
                        let _ = send_active_control(&batch_id, JobControl::Cancel).await;
                        break match tokio::time::timeout(Duration::from_secs(15), &mut run).await {
                            Ok(result) => result,
                            Err(_) => Err(anyhow::anyhow!("Account Keeper manual stop timed out")),
                        };
                    }
                }
                if tokio::time::Instant::now() >= deadline {
                    timed_out = true;
                    let _ = send_active_control(&batch_id, JobControl::Cancel).await;
                    break match tokio::time::timeout(Duration::from_secs(15), &mut run).await {
                        Ok(result) => result,
                        Err(_) => Err(anyhow::anyhow!("Account Keeper timeout cancellation failed")),
                    };
                }
            }
        }
    };

    if let Err(error) = run_result {
        let _ = mark_job_run_error(
            &batch_id,
            &error.to_string(),
            coordinator.clock.as_ref(),
            coordinator.events.as_ref(),
        );
    }
    release_active_batch(&batch_id).await;
    let job = load_job_view(&batch_id)?;
    Ok(HeadlessRunResult {
        job,
        stopped_for_manual,
        timed_out,
    })
}

fn ensure_recovery_profile<F>(
    runtime: &dyn ProfileRuntime,
    account_key: &str,
    vault: &mut VaultFile,
    vault_index: usize,
    persist: F,
) -> Result<String>
where
    F: FnOnce(&VaultFile) -> Result<()>,
{
    let current_profile_id = vault.accounts[vault_index].profile_id.clone();
    let profile_id = ensure_profile_mapping(runtime, account_key, Some(&current_profile_id))?;
    if profile_id != current_profile_id {
        vault.accounts[vault_index].profile_id = profile_id.clone();
        persist(vault)?;
    }
    Ok(profile_id)
}

pub async fn recover_headless_credentials(
    source: &InputSource,
    timeout_seconds: u64,
) -> Result<()> {
    let imports = read_input_accounts(source)?;
    if imports.len() != 1 {
        bail!("Account Keeper credential recovery requires exactly one account");
    }
    let imported = &imports[0];
    let account_key = stable_account_key(&imported.normalized_account);
    let mut vault = crate::account_keeper_store::load_vault()?;
    let vault_index = vault
        .accounts
        .iter()
        .position(|account| account.account_key == account_key)
        .ok_or_else(|| anyhow::anyhow!("Account Keeper recovery mapping is missing"))?;
    if vault.accounts[vault_index].password_state != PasswordState::Unknown {
        return Ok(());
    }
    let runtime = HeadlessProfileRuntime;
    let profile_id = ensure_recovery_profile(
        &runtime,
        &account_key,
        &mut vault,
        vault_index,
        crate::account_keeper_store::save_vault,
    )?;
    let now = verify_headless_password(
        imported,
        &profile_id,
        &imported.current_password,
        timeout_seconds,
    )
    .await?;
    let account = &mut vault.accounts[vault_index];
    account.current_password = imported.current_password.clone();
    account.pending_password = None;
    account.totp_secret = Some(imported.totp_secret.clone());
    account.password_state = PasswordState::Original;
    account.last_verified_at = Some(now);
    account.last_status = Some("recovered".to_string());
    crate::account_keeper_store::save_vault(&vault)?;
    Ok(())
}

pub async fn recover_headless_pending_credentials(
    source: &InputSource,
    timeout_seconds: u64,
) -> Result<JobView> {
    let imports = read_input_accounts(source)?;
    if imports.len() != 1 {
        bail!("Account Keeper pending recovery requires exactly one account");
    }
    let imported = &imports[0];
    let account_key = stable_account_key(&imported.normalized_account);
    let mut vault = crate::account_keeper_store::load_vault()?;
    let vault_index = vault
        .accounts
        .iter()
        .position(|account| account.account_key == account_key)
        .ok_or_else(|| anyhow::anyhow!("Account Keeper pending recovery mapping is missing"))?;
    let vault_account = &vault.accounts[vault_index];
    if vault_account.password_state != PasswordState::Unknown {
        bail!("Account Keeper pending recovery is not required");
    }
    let pending_password = vault_account
        .pending_password
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Account Keeper pending recovery password is unavailable"))?;
    let batch_id = vault_account
        .last_job_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Account Keeper pending recovery checkpoint is unavailable"))?;
    let runtime = HeadlessProfileRuntime;
    let profile_id = ensure_recovery_profile(
        &runtime,
        &account_key,
        &mut vault,
        vault_index,
        crate::account_keeper_store::save_vault,
    )?;
    let now = verify_headless_password(
        imported,
        &profile_id,
        &pending_password,
        timeout_seconds,
    )
    .await?;

    let mut checkpoint = crate::account_keeper_store::load_job(&batch_id)?;
    let checkpoint_account = checkpoint
        .accounts
        .iter_mut()
        .find(|account| account.account_key == account_key)
        .ok_or_else(|| anyhow::anyhow!("Account Keeper pending recovery account is unavailable"))?;
    if checkpoint_account.state != "critical" {
        bail!("Account Keeper pending recovery checkpoint is not critical");
    }
    checkpoint_account.state = "success".to_string();
    checkpoint_account.error = None;
    checkpoint_account.updated_at = now.clone();
    checkpoint.status = final_job_status(&checkpoint).to_string();

    let account = &mut vault.accounts[vault_index];
    account.current_password = pending_password;
    account.pending_password = None;
    account.totp_secret = Some(imported.totp_secret.clone());
    account.password_state = PasswordState::Changed;
    account.last_verified_at = Some(now);
    account.last_status = Some("success".to_string());
    persist_snapshot(
        &mut checkpoint,
        &vault,
        &SystemClock,
        &NullEventSink,
    )?;
    Ok(job_view_from_checkpoint(&checkpoint, &vault))
}

async fn verify_headless_password(
    imported: &ImportedAccount,
    profile_id: &str,
    candidate_password: &str,
    timeout_seconds: u64,
) -> Result<String> {
    let runtime = HeadlessProfileRuntime;
    let cdp_endpoint = prepare_profile_cdp(&runtime, &profile_id).await?;
    let transport = NodeWorkerTransport {
        resource_root: headless_worker_resource_root(),
    };
    let mut session = transport
        .spawn(WorkerStart {
            request_id: uuid::Uuid::new_v4().to_string(),
            operation: "verify_credentials".to_string(),
            adapter_id: "openai-chatgpt-v1".to_string(),
            cdp_endpoint,
            account: imported.account.clone(),
            current_password: candidate_password.to_string(),
            new_password: String::new(),
        })
        .await?;

    let verification = async {
        loop {
            match session.next_event().await? {
                Some(WorkerEvent::Stage(_)) => {}
                Some(WorkerEvent::TotpRequired) => {
                    session
                        .send(WorkerCommand::TotpCode(totp_now(&imported.totp_secret)?))
                        .await?;
                }
                Some(WorkerEvent::Verified) => return Ok(()),
                Some(WorkerEvent::ManualRequired { .. }) => {
                    let _ = session.send(WorkerCommand::Cancel).await;
                    bail!("Account Keeper credential recovery requires manual action");
                }
                Some(WorkerEvent::Failed { code }) => {
                    bail!("Account Keeper credential recovery failed: {}", safe_error_code(&code));
                }
                Some(WorkerEvent::PasswordSubmitRequired | WorkerEvent::PasswordChanged) => {
                    bail!("Account Keeper recovery worker attempted a password change");
                }
                None => bail!("Account Keeper credential recovery worker stopped"),
            }
        }
    };
    let verified = match tokio::time::timeout(
        Duration::from_secs(timeout_seconds.clamp(30, 3600)),
        verification,
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            let _ = session.send(WorkerCommand::Cancel).await;
            Err(anyhow::anyhow!("Account Keeper credential recovery timed out"))
        }
    };
    let _ = session.finish().await;
    verified?;
    Ok(SystemClock.now())
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
pub fn account_keeper_list_profiles() -> std::result::Result<Vec<ManagedProfileView>, String> {
    let vault = crate::account_keeper_store::load_vault().map_err(|error| error.to_string())?;
    let running = crate::process::Tracker::shared()
        .running()
        .into_iter()
        .map(|profile| profile.profile_id)
        .collect::<HashSet<_>>();
    let settings = crate::settings::load().map_err(|error| error.to_string())?;
    Ok(managed_profile_views(
        &vault,
        &running,
        &format!("http://127.0.0.1:{}", settings.api_port),
    ))
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
        "success" | "failed" | "cancelled" => Ok(None),
        "waiting_manual" => Ok(Some("queued")),
        "queued"
        | "launching"
        | "logging_in"
        | "submitting_totp"
        | "changing_password"
        | "verifying_new_password" => Ok(Some("queued")),
        _ => bail!("invalid Account Keeper checkpoint state"),
    }
}

/// Resolve a Critical account after the operator has confirmed (or completed)
/// the password change manually. Re-verifies the attempted (`pending_password`)
/// against the live login: on success it promotes the pending password to the
/// current one, flips the account to `success`, labels the browser profile, and
/// rewrites the output. The credentials never leave the DPAPI vault — the UI
/// passes only batch_id + account_key.
pub async fn resolve_critical(request: ManualControlRequest) -> Result<JobView> {
    ensure_account_keeper_supported()?;
    {
        let active = active_batch().lock().await;
        if active.batch_id.is_some() {
            bail!("finish the active Account Keeper batch before resolving a critical account");
        }
    }

    let mut vault = crate::account_keeper_store::load_vault()?;
    let vault_index = vault
        .accounts
        .iter()
        .position(|account| account.account_key == request.account_key)
        .ok_or_else(|| anyhow::anyhow!("Account Keeper critical account is unavailable"))?;
    if vault.accounts[vault_index].password_state != PasswordState::Unknown {
        bail!("Account Keeper account does not need critical recovery");
    }
    let pending_password = vault.accounts[vault_index]
        .pending_password
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Account Keeper attempted password is unavailable"))?;
    let account = vault.accounts[vault_index].account.clone();
    let totp_secret = vault.accounts[vault_index]
        .totp_secret
        .clone()
        .unwrap_or_default();

    let mut checkpoint = crate::account_keeper_store::load_job(&request.batch_id)?;
    let checkpoint_index = checkpoint
        .accounts
        .iter()
        .position(|candidate| candidate.account_key == request.account_key)
        .ok_or_else(|| anyhow::anyhow!("Account Keeper critical checkpoint is unavailable"))?;
    if checkpoint.accounts[checkpoint_index].state != "critical" {
        bail!("Account Keeper account is not critical");
    }

    let runtime = HeadlessProfileRuntime;
    let profile_id = ensure_recovery_profile(
        &runtime,
        &request.account_key,
        &mut vault,
        vault_index,
        crate::account_keeper_store::save_vault,
    )?;
    let imported = ImportedAccount {
        line: 0,
        account: account.clone(),
        normalized_account: normalize_account(&account),
        current_password: pending_password.clone(),
        totp_secret,
    };
    let now = verify_headless_password(&imported, &profile_id, &pending_password, 300).await?;

    let account_entry = &mut vault.accounts[vault_index];
    account_entry.current_password = pending_password;
    account_entry.pending_password = None;
    account_entry.password_state = PasswordState::Changed;
    account_entry.last_verified_at = Some(now.clone());
    account_entry.last_status = Some("success".to_string());

    let checkpoint_account = &mut checkpoint.accounts[checkpoint_index];
    checkpoint_account.state = "success".to_string();
    checkpoint_account.error = None;
    checkpoint_account.updated_at = now.clone();
    checkpoint.status = final_job_status(&checkpoint).to_string();

    label_account_profile(&runtime, &vault.accounts[vault_index]);
    persist_snapshot(&mut checkpoint, &vault, &SystemClock, &NullEventSink)?;
    Ok(job_view_from_checkpoint(&checkpoint, &vault))
}

#[tauri::command]
pub async fn account_keeper_resolve_critical(
    request: ManualControlRequest,
) -> std::result::Result<JobView, String> {
    resolve_critical(request)
        .await
        .map_err(|error| error.to_string())
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

fn can_clean_checkpoint_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "abandoned")
}

fn forget_unknown_recovery_accounts(vault: &mut VaultFile, checkpoint: &JobCheckpoint) -> usize {
    let account_keys = checkpoint
        .accounts
        .iter()
        .map(|account| account.account_key.as_str())
        .collect::<HashSet<_>>();
    let before = vault.accounts.len();
    vault.accounts.retain(|account| {
        account.password_state != PasswordState::Unknown
            || !account_keys.contains(account.account_key.as_str())
    });
    before.saturating_sub(vault.accounts.len())
}

#[tauri::command]
pub async fn account_keeper_clean_progress(
    request: BatchRequest,
) -> std::result::Result<CleanProgressResult, String> {
    let active = active_batch().lock().await;
    if active.batch_id.as_deref() == Some(request.batch_id.as_str()) {
        return Err("active Account Keeper progress cannot be cleaned".to_string());
    }
    drop(active);
    let checkpoint = crate::account_keeper_store::load_job(&request.batch_id)
        .map_err(|error| error.to_string())?;
    if !can_clean_checkpoint_status(&checkpoint.status) {
        return Err("only terminal Account Keeper progress can be cleaned".to_string());
    }
    let mut vault =
        crate::account_keeper_store::load_vault().map_err(|error| error.to_string())?;
    let forgotten_recovery_accounts = forget_unknown_recovery_accounts(&mut vault, &checkpoint);
    if forgotten_recovery_accounts > 0 {
        crate::account_keeper_store::save_vault(&vault).map_err(|error| error.to_string())?;
    }
    crate::account_keeper_store::delete_job(&request.batch_id)
        .map_err(|error| error.to_string())?;
    Ok(CleanProgressResult {
        batch_id: request.batch_id,
        cleaned: true,
        forgotten_recovery_accounts,
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

#[tauri::command]
pub async fn account_keeper_delete_profile(
    request: OpenProfileRequest,
) -> std::result::Result<DeleteManagedProfileResult, String> {
    let active = active_batch().lock().await;
    if active.batch_id.is_some() {
        return Err("finish the active Account Keeper batch before deleting a profile".to_string());
    }
    drop(active);

    let mut vault = crate::account_keeper_store::load_vault().map_err(|error| error.to_string())?;
    let index = vault
        .accounts
        .iter()
        .position(|account| {
            account.profile_id == request.profile_id
                && account.password_state == PasswordState::Changed
                && account.last_status.as_deref() == Some("success")
        })
        .ok_or_else(|| "Account Keeper managed profile was not found".to_string())?;

    if crate::process::Tracker::shared()
        .kill(&request.profile_id)
        .await
        .map_err(|error| error.to_string())?
    {
        for _ in 0..60 {
            if !crate::process::Tracker::shared()
                .running()
                .iter()
                .any(|profile| profile.profile_id == request.profile_id)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    crate::profile::delete(&request.profile_id).map_err(|error| error.to_string())?;
    vault.accounts.remove(index);
    crate::account_keeper_store::save_vault(&vault).map_err(|error| error.to_string())?;
    Ok(DeleteManagedProfileResult {
        profile_id: request.profile_id,
        deleted: true,
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

pub(crate) fn validate_start_request(request: &StartRequest) -> Result<()> {
    validate_input_source_shape(&request.source)?;
    if !matches!(request.operation.as_str(), "login" | "change_password") {
        bail!("unsupported Account Keeper operation");
    }
    if !matches!(
        request.adapter_id.as_str(),
        "fixture-v1" | "openai-chatgpt-v1"
    ) {
        bail!("unsupported Account Keeper adapter");
    }
    let operation = account_keeper_batch_operation(request);
    if operation == BatchOperation::ChangePassword {
        if request.output_path.trim().is_empty() {
            bail!("Account Keeper output path is required");
        }
        if let InputSource::File { path } = &request.source {
            if Path::new(path) == Path::new(&request.output_path) {
                bail!("Account Keeper input and output paths must differ");
            }
        }
        PasswordTemplate::parse(&request.template)?;
    } else if let InputSource::File { path } = &request.source {
        // Login mode may still specify an output path; if it does, guard the
        // same input==output collision.
        if !request.output_path.trim().is_empty()
            && Path::new(path) == Path::new(&request.output_path)
        {
            bail!("Account Keeper input and output paths must differ");
        }
    }
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
            new_password: vault_account.pending_password.clone(),
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

/// Label a profile: visible name = the account, Notes =
/// `account|password|totp_secret`. Best-effort — a labeling failure must not
/// abort import or undo a successful rotation, so errors are swallowed.
/// SECURITY: writes the plaintext credential line into the unencrypted profile
/// JSON by operator request. Called at import time (original credentials) and
/// again after a verified rotation (rotated credentials).
fn label_account_profile(runtime: &dyn ProfileRuntime, vault_account: &VaultAccount) {
    let notes = account_keeper_profile_notes(vault_account);
    let _ = runtime.set_label(&vault_account.profile_id, &vault_account.account, &notes);
}

fn account_keeper_profile_notes(vault_account: &VaultAccount) -> String {
    match vault_account.totp_secret.as_deref() {
        Some(secret) if !secret.is_empty() => format!(
            "{}|{}|{}",
            vault_account.account, vault_account.current_password, secret
        ),
        _ => format!("{}|{}", vault_account.account, vault_account.current_password),
    }
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
        let template = if checkpoint.operation == "login" {
            None
        } else {
            Some(PasswordTemplate::parse(&checkpoint.template)?)
        };
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

            let pending_password = if checkpoint.operation == "login" {
                String::new()
            } else {
                template
                    .as_ref()
                    .expect("change_password requires template")
                    .generate(&mut random, &mut used_passwords)?
            };
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
            let worker_operation = if checkpoint.operation == "login" {
                "verify_credentials"
            } else {
                "change_password"
            };
            let start = WorkerStart {
                request_id,
                operation: worker_operation.to_string(),
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
                                if checkpoint.operation == "login" {
                                    apply_login_verified(
                                        &mut state,
                                        &mut vault.accounts[vault_index],
                                        &self.clock.now(),
                                    )?;
                                } else {
                                    apply_worker_event(
                                        &mut state,
                                        &mut vault.accounts[vault_index],
                                        pending_password,
                                        WorkerEvent::Verified,
                                        &self.clock.now(),
                                    )?;
                                }
                                label_account_profile(
                                    self.profiles.as_ref(),
                                    &vault.accounts[vault_index],
                                );
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

fn managed_profile_views(
    vault: &VaultFile,
    running: &HashSet<String>,
    api_base_url: &str,
) -> Vec<ManagedProfileView> {
    let mut profiles = vault
        .accounts
        .iter()
        .filter(|account| {
            account.last_status.as_deref() == Some("success")
                && account.last_verified_at.is_some()
        })
        .map(|account| {
            let last_verified_at = account.last_verified_at.clone();
            ManagedProfileView {
                profile_id: account.profile_id.clone(),
                masked_account: mask_account(&account.account),
                status: "success".to_string(),
                rotated: account.password_state == PasswordState::Changed,
                last_verified_at: last_verified_at.clone(),
                running: running.contains(&account.profile_id),
                import_payload: ManagedProfileImportPayload {
                    schema_version: SCHEMA_VERSION,
                    kind: "brproxies-account-keeper-profile".to_string(),
                    profile_id: account.profile_id.clone(),
                    account_status: "success".to_string(),
                    last_verified_at,
                    api_base_url: api_base_url.to_string(),
                    vault_ref: format!("account-keeper://vault/{}", account.account_key),
                },
            }
        })
        .collect::<Vec<_>>();
    profiles.sort_by(|left, right| {
        right
            .last_verified_at
            .cmp(&left.last_verified_at)
            .then_with(|| left.masked_account.cmp(&right.masked_account))
    });
    profiles
}

/// Login-only success: the account signed in with its existing credentials.
/// Marks the profile a verified success WITHOUT rotating — password_state stays
/// Original. Separate from the rotation `Verified` path, which asserts a pending
/// password and moves to Changed.
pub fn apply_login_verified(
    state: &mut AccountRunState,
    vault: &mut VaultAccount,
    now: &str,
) -> Result<()> {
    state.transition(AccountEvent::LoginVerified)?;
    vault.pending_password = None;
    vault.password_state = PasswordState::Original;
    vault.last_verified_at = Some(now.to_string());
    vault.last_status = Some("success".to_string());
    Ok(())
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

    #[cfg(windows)]
    fn non_unicode_document_dir() -> PathBuf {
        use std::os::windows::ffi::OsStringExt;

        PathBuf::from(std::ffi::OsString::from_wide(&[0xD800]))
    }

    #[cfg(unix)]
    fn non_unicode_document_dir() -> PathBuf {
        use std::os::unix::ffi::OsStringExt;

        PathBuf::from(std::ffi::OsString::from_vec(vec![0xFF]))
    }

    #[test]
    fn defaults_use_valid_template_and_documents_output_path() {
        let document_dir = test_dir("defaults").join("Documents");
        let expected_output_path = document_dir.join("output").join("account-keeper-result.json");

        let defaults = default_config_for(&document_dir).unwrap();

        assert_eq!(defaults.template, "BrP@{random:16}!");
        assert_eq!(PathBuf::from(&defaults.output_path), expected_output_path);
        assert!(validate_template_value(&defaults.template).is_ok());
        assert_eq!(
            serde_json::to_value(&defaults).unwrap(),
            serde_json::json!({
                "template": "BrP@{random:16}!",
                "outputPath": expected_output_path.to_str().unwrap(),
            })
        );
    }

    #[test]
    fn defaults_reject_non_unicode_output_path() {
        let error = default_config_for(&non_unicode_document_dir()).unwrap_err();

        assert_eq!(
            error.to_string(),
            "Account Keeper output path is not valid Unicode"
        );
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
            operation: "change_password".into(),
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
    fn start_request_rejects_unknown_operation() {
        let request = StartRequest {
            source: InputSource::Inline { text: "a@b.test|pw|".into() },
            output_path: "C:/synthetic/result.json".into(),
            template: "Local-{random:16}".into(),
            adapter_id: "fixture-v1".into(),
            operation: "delete_account".into(),
            keep_profile_running: false,
            pause_after_current: false,
        };
        assert!(validate_start_request(&request).is_err());
    }

    #[test]
    fn start_request_login_operation_skips_template_and_output() {
        let request = StartRequest {
            source: InputSource::Inline { text: "a@b.test|pw|".into() },
            output_path: String::new(),
            template: String::new(),
            adapter_id: "fixture-v1".into(),
            operation: "login".into(),
            keep_profile_running: false,
            pause_after_current: false,
        };
        assert!(validate_start_request(&request).is_ok());
        assert_eq!(account_keeper_batch_operation(&request), BatchOperation::Login);
    }

    #[test]
    fn start_request_change_password_still_requires_template_and_output() {
        let request = StartRequest {
            source: InputSource::Inline { text: "a@b.test|pw|".into() },
            output_path: String::new(),
            template: "Local-{random:16}".into(),
            adapter_id: "fixture-v1".into(),
            operation: "change_password".into(),
            keep_profile_running: false,
            pause_after_current: false,
        };
        assert!(validate_start_request(&request).is_err());
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
            operation: "change_password".into(),
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
    fn import_labels_new_profile_with_account_name_and_credential_notes() {
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
            operation: "change_password".into(),
            keep_profile_running: false,
            pause_after_current: false,
        };
        merge_imports_and_checkpoint(
            &runtime,
            &mut vault,
            &imports,
            &request,
            "batch-label",
            "2026-07-30T00:00:00Z",
        )
        .unwrap();

        let labels = runtime.labels.into_inner().unwrap();
        assert_eq!(
            labels,
            vec![(
                "profile-created".to_string(),
                "owner@example.test".to_string(),
                "owner@example.test|current-password|JBSWY3DPEHPK3PXP".to_string(),
            )]
        );
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
            Some("queued")
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
    fn managed_profiles_include_only_verified_successes_without_secrets() {
        let vault = VaultFile {
            schema_version: crate::account_keeper_store::SCHEMA_VERSION,
            accounts: vec![
                VaultAccount {
                    account_key: "success-key".into(),
                    account: "owner@example.test".into(),
                    current_password: "secret-current-password".into(),
                    pending_password: None,
                    totp_secret: Some("JBSWY3DPEHPK3PXP".into()),
                    profile_id: "profile-success".into(),
                    password_state: PasswordState::Changed,
                    last_verified_at: Some("2026-07-31T03:00:00Z".into()),
                    last_job_id: Some("job-success".into()),
                    last_status: Some("success".into()),
                },
                VaultAccount {
                    account_key: "failed-key".into(),
                    account: "failed@example.test".into(),
                    current_password: "failed-password".into(),
                    pending_password: None,
                    totp_secret: None,
                    profile_id: "profile-failed".into(),
                    password_state: PasswordState::Original,
                    last_verified_at: None,
                    last_job_id: Some("job-failed".into()),
                    last_status: Some("failed".into()),
                },
            ],
        };
        let running = std::collections::HashSet::from(["profile-success".to_string()]);

        let profiles = managed_profile_views(
            &vault,
            &running,
            "http://127.0.0.1:40325",
        );

        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].profile_id, "profile-success");
        assert!(profiles[0].running);
        assert_eq!(profiles[0].import_payload.account_status, "success");
        let serialized = serde_json::to_string(&profiles).unwrap().to_lowercase();
        for forbidden in [
            "owner@example.test",
            "secret-current-password",
            "jbswy3dpehpk3pxp",
            "failed-password",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn managed_profiles_include_login_only_with_rotated_false() {
        let vault = VaultFile {
            schema_version: SCHEMA_VERSION,
            accounts: vec![
                VaultAccount {
                    account_key: "rotated-key".into(),
                    account: "rot@example.test".into(),
                    current_password: "new".into(),
                    pending_password: None,
                    totp_secret: None,
                    profile_id: "profile-rotated".into(),
                    password_state: PasswordState::Changed,
                    last_verified_at: Some("2026-08-01T02:00:00Z".into()),
                    last_job_id: None,
                    last_status: Some("success".into()),
                },
                VaultAccount {
                    account_key: "login-key".into(),
                    account: "log@example.test".into(),
                    current_password: "current".into(),
                    pending_password: None,
                    totp_secret: None,
                    profile_id: "profile-login".into(),
                    password_state: PasswordState::Original,
                    last_verified_at: Some("2026-08-01T01:00:00Z".into()),
                    last_job_id: None,
                    last_status: Some("success".into()),
                },
            ],
        };
        let running: HashSet<String> = HashSet::new();
        let profiles =
            managed_profile_views(&vault, &running, "http://127.0.0.1:40325/");
        assert_eq!(profiles.len(), 2);
        let login = profiles
            .iter()
            .find(|p| p.profile_id == "profile-login")
            .unwrap();
        assert!(!login.rotated);
        let rotated = profiles
            .iter()
            .find(|p| p.profile_id == "profile-rotated")
            .unwrap();
        assert!(rotated.rotated);
    }

    #[test]
    fn defaults_output_path_is_in_project_output_dir() {
        let defaults = account_keeper_defaults().unwrap();
        assert!(
            defaults
                .output_path
                .replace('\\', "/")
                .ends_with("/output/account-keeper-result.json"),
            "unexpected output path: {}",
            defaults.output_path
        );
    }

    #[test]
    fn clean_progress_accepts_safe_terminal_statuses_only() {
        for status in ["completed", "failed", "cancelled", "abandoned"] {
            assert!(can_clean_checkpoint_status(status));
        }
        for status in ["queued", "running", "paused", "waiting_manual", "critical"] {
            assert!(!can_clean_checkpoint_status(status));
        }
    }

    #[test]
    fn clean_progress_forgets_only_matching_unknown_recovery_accounts() {
        let mut vault = VaultFile {
            schema_version: 1,
            accounts: vec![
                VaultAccount {
                    account_key: "unknown-key".into(),
                    account: "unknown@example.test".into(),
                    current_password: "synthetic-current".into(),
                    pending_password: Some("synthetic-pending".into()),
                    totp_secret: Some("JBSWY3DPEHPK3PXP".into()),
                    profile_id: "unknown-profile".into(),
                    password_state: PasswordState::Unknown,
                    last_verified_at: None,
                    last_job_id: Some("batch-id".into()),
                    last_status: Some("critical".into()),
                },
                VaultAccount {
                    account_key: "verified-key".into(),
                    account: "verified@example.test".into(),
                    current_password: "synthetic-verified".into(),
                    pending_password: None,
                    totp_secret: Some("JBSWY3DPEHPK3PXP".into()),
                    profile_id: "verified-profile".into(),
                    password_state: PasswordState::Changed,
                    last_verified_at: Some("2026-07-31T00:00:00Z".into()),
                    last_job_id: Some("batch-id".into()),
                    last_status: Some("success".into()),
                },
                VaultAccount {
                    account_key: "unrelated-key".into(),
                    account: "unrelated@example.test".into(),
                    current_password: "synthetic-unrelated".into(),
                    pending_password: Some("synthetic-pending".into()),
                    totp_secret: Some("JBSWY3DPEHPK3PXP".into()),
                    profile_id: "unrelated-profile".into(),
                    password_state: PasswordState::Unknown,
                    last_verified_at: None,
                    last_job_id: Some("other-batch".into()),
                    last_status: Some("critical".into()),
                },
            ],
        };
        let checkpoint = JobCheckpoint {
            schema_version: 1,
            batch_id: "batch-id".into(),
            output_path: String::new(),
            template: String::new(),
            adapter_id: "openai-chatgpt-v1".into(),
            keep_profile_running: true,
            pause_after_current: false,
            operation: "change_password".to_string(),
            status: "failed".into(),
            updated_at: "2026-07-31T00:00:00Z".into(),
            accounts: vec![
                AccountCheckpoint {
                    account_key: "unknown-key".into(),
                    profile_id: Some("unknown-profile".into()),
                    state: "failed".into(),
                    attempts: 1,
                    updated_at: "2026-07-31T00:00:00Z".into(),
                    error: Some("launch_failed".into()),
                },
                AccountCheckpoint {
                    account_key: "verified-key".into(),
                    profile_id: Some("verified-profile".into()),
                    state: "success".into(),
                    attempts: 1,
                    updated_at: "2026-07-31T00:00:00Z".into(),
                    error: None,
                },
            ],
        };

        let forgotten = forget_unknown_recovery_accounts(&mut vault, &checkpoint);

        assert_eq!(forgotten, 1);
        assert_eq!(vault.accounts.len(), 2);
        assert!(vault
            .accounts
            .iter()
            .any(|account| account.account_key == "verified-key"));
        assert!(vault
            .accounts
            .iter()
            .any(|account| account.account_key == "unrelated-key"));
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
        existing_profiles: HashSet<String>,
        created: StdMutex<Vec<(String, String)>>,
        folders: StdMutex<Vec<(String, String)>>,
        labels: StdMutex<Vec<(String, String, String)>>,
    }

    impl ProfileRuntime for FakeProfileRuntime {
        fn profile_exists(&self, profile_id: &str) -> bool {
            self.existing_profiles.contains(profile_id)
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

        fn set_label(&self, profile_id: &str, name: &str, notes: &str) -> Result<()> {
            self.labels.lock().unwrap().push((
                profile_id.to_string(),
                name.to_string(),
                notes.to_string(),
            ));
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

    #[test]
    fn recovery_profile_replaces_missing_mapping_before_verification() {
        let runtime = FakeProfileRuntime {
            fingerprints: vec![FingerprintCandidate::new("windows-a", "Alpha", "Windows")],
            ..Default::default()
        };
        let mut vault = synthetic_vault();
        vault.accounts[0].profile_id = "missing-profile".into();
        vault.accounts[0].password_state = PasswordState::Unknown;
        vault.accounts[0].pending_password = Some("synthetic-pending".into());
        let mut persisted_profile_id = None;

        let profile_id = ensure_recovery_profile(&runtime, "account-key", &mut vault, 0, |saved| {
            persisted_profile_id = Some(saved.accounts[0].profile_id.clone());
            Ok(())
        })
        .unwrap();

        assert_eq!(profile_id, "profile-created");
        assert_eq!(persisted_profile_id.as_deref(), Some("profile-created"));
        assert_eq!(vault.accounts[0].password_state, PasswordState::Unknown);
        assert_eq!(
            vault.accounts[0].pending_password.as_deref(),
            Some("synthetic-pending")
        );
    }

    #[test]
    fn recovery_profile_reuses_existing_mapping_without_persisting() {
        let runtime = FakeProfileRuntime {
            existing_profiles: HashSet::from(["profile-1".to_string()]),
            ..Default::default()
        };
        let mut vault = synthetic_vault();
        vault.accounts[0].password_state = PasswordState::Unknown;
        vault.accounts[0].pending_password = Some("synthetic-pending".into());
        let mut persisted = false;

        let profile_id = ensure_recovery_profile(&runtime, "account-key", &mut vault, 0, |_| {
            persisted = true;
            Ok(())
        })
        .unwrap();

        assert_eq!(profile_id, "profile-1");
        assert!(!persisted);
        assert!(runtime.created.into_inner().unwrap().is_empty());
        assert_eq!(vault.accounts[0].password_state, PasswordState::Unknown);
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
            operation: "change_password".to_string(),
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
    fn login_verified_marks_success_without_rotating_password() {
        let mut state = AccountRunState::new("account-key");
        // Simulate a login flow that has reached the verification stage.
        state.stage = AccountStage::VerifyingNewPassword;
        let mut vault = VaultAccount {
            account_key: "account-key".into(),
            account: "owner@example.test".into(),
            current_password: "current-password".into(),
            pending_password: None,
            totp_secret: None,
            profile_id: "profile-login".into(),
            password_state: PasswordState::Original,
            last_verified_at: None,
            last_job_id: Some("batch-login".into()),
            last_status: Some("running".into()),
        };
        apply_login_verified(&mut state, &mut vault, "2026-08-01T00:00:00Z").unwrap();
        assert_eq!(state.stage, AccountStage::Success);
        assert_eq!(vault.password_state, PasswordState::Original);
        assert_eq!(vault.current_password, "current-password");
        assert!(vault.pending_password.is_none());
        assert_eq!(vault.last_status.as_deref(), Some("success"));
        assert_eq!(
            vault.last_verified_at.as_deref(),
            Some("2026-08-01T00:00:00Z")
        );
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
    fn headless_agent_resolves_worker_resources_beside_executable() {
        let executable = Path::new(r"C:\BrProxies\account-keeper-agent.exe");

        assert_eq!(
            headless_worker_resource_root_from(executable),
            Some(PathBuf::from(r"C:\BrProxies")),
        );
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
                operation: "change_password".into(),
                keep_profile_running: false,
                pause_after_current: false,
            },
            "batch-1",
            "2026-07-29T00:00:00Z",
        )
        .unwrap();
        // `operation: "change_password"` is a benign enum token, not a credential;
        // strip it so the broad substring guard still catches any real leak.
        let checkpoint_json = serde_json::to_string(&checkpoint)
            .unwrap()
            .to_lowercase()
            .replace("change_password", "");
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
                operation: "change_password".into(),
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
