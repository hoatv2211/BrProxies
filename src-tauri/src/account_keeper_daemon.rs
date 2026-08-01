use crate::account_keeper::{
    self, AccountStage, BatchRequest, InputSource, JobStatus, ManualControlRequest, StartRequest,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tokio::sync::Mutex;

const DAEMON_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct DaemonJob {
    id: String,
    input_path: String,
    output_path: String,
    template: String,
    keep_profile_running: bool,
    status: String,
    batch_id: Option<String>,
    stage: Option<AccountStage>,
    error_code: Option<String>,
    account_count: usize,
    has_last_verified_at: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DaemonState {
    schema_version: u32,
    jobs: VecDeque<DaemonJob>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateJobRequest {
    pub input_path: String,
    pub output_path: Option<String>,
    pub template: Option<String>,
    #[serde(default = "default_true")]
    pub keep_profile_running: bool,
    pub authorize_password_change: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DaemonJobView {
    pub id: String,
    pub status: String,
    pub batch_id: Option<String>,
    pub stage: Option<AccountStage>,
    pub error_code: Option<String>,
    pub account_count: usize,
    pub has_last_verified_at: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DaemonStatus {
    pub running: bool,
    pub queued: usize,
    pub active_job_id: Option<String>,
}

fn default_true() -> bool {
    true
}

fn state_cell() -> &'static Mutex<DaemonState> {
    static STATE: OnceLock<Mutex<DaemonState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(load_state().unwrap_or_default()))
}

fn now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

fn load_state() -> Result<DaemonState> {
    let path = crate::store::account_keeper_daemon_path()?;
    if !path.exists() {
        return Ok(DaemonState::default());
    }
    let protected = std::fs::read(path).context("read Account Keeper daemon state")?;
    let mut plaintext = crate::dpapi::unprotect(&protected)?;
    let decoded = serde_json::from_slice(&plaintext).context("parse Account Keeper daemon state");
    plaintext.fill(0);
    let state: DaemonState = decoded?;
    if state.schema_version != DAEMON_SCHEMA_VERSION {
        bail!("unsupported Account Keeper daemon schema");
    }
    Ok(state)
}

fn save_state(state: &DaemonState) -> Result<()> {
    let mut plaintext = serde_json::to_vec(state)?;
    let protected_result = crate::dpapi::protect(&plaintext);
    plaintext.fill(0);
    crate::store::atomic_write_bytes(
        &crate::store::account_keeper_daemon_path()?,
        &protected_result?,
    )
}

fn view(job: &DaemonJob) -> DaemonJobView {
    DaemonJobView {
        id: job.id.clone(),
        status: job.status.clone(),
        batch_id: job.batch_id.clone(),
        stage: job.stage,
        error_code: job.error_code.clone(),
        account_count: job.account_count,
        has_last_verified_at: job.has_last_verified_at,
        created_at: job.created_at.clone(),
        updated_at: job.updated_at.clone(),
    }
}

impl Default for DaemonState {
    fn default() -> Self {
        Self {
            schema_version: DAEMON_SCHEMA_VERSION,
            jobs: VecDeque::new(),
        }
    }
}

fn recover_after_restart(state: &mut DaemonState) {
    for job in &mut state.jobs {
        if matches!(job.status.as_str(), "running" | "waiting_manual") {
            job.status = "recovery_required".into();
        }
    }
}

fn next_queued_job(state: &DaemonState) -> Option<String> {
    if state.jobs.iter().any(|job| {
        matches!(
            job.status.as_str(),
            "running" | "waiting_manual" | "recovery_required"
        )
    }) {
        return None;
    }
    state
        .jobs
        .iter()
        .find(|job| job.status == "queued")
        .map(|job| job.id.clone())
}

pub async fn create_job(request: CreateJobRequest) -> std::result::Result<DaemonJobView, String> {
    if !request.authorize_password_change {
        return Err("password change authorization is required".into());
    }
    let defaults = account_keeper::account_keeper_defaults().map_err(|error| error.to_string())?;
    let output_path = request.output_path.unwrap_or(defaults.output_path);
    let template = request.template.unwrap_or(defaults.template);
    let source = InputSource::File {
        path: request.input_path.clone(),
    };
    account_keeper::validate_start_request(&StartRequest {
        source: source.clone(),
        output_path: output_path.clone(),
        template: template.clone(),
        adapter_id: "openai-chatgpt-v1".into(),
        operation: "change_password".into(),
        keep_profile_running: request.keep_profile_running,
        pause_after_current: false,
    })
    .map_err(|error| error.to_string())?;
    let validation = account_keeper::validate_input_source(&source)
        .map_err(|error| error.to_string())?;
    let created_at = now();
    let job = DaemonJob {
        id: uuid::Uuid::new_v4().to_string(),
        input_path: request.input_path,
        output_path,
        template,
        keep_profile_running: request.keep_profile_running,
        status: "queued".into(),
        account_count: validation.valid_count,
        created_at: created_at.clone(),
        updated_at: created_at,
        ..DaemonJob::default()
    };
    let result = view(&job);
    let mut state = state_cell().lock().await;
    state.jobs.push_back(job);
    save_state(&state).map_err(|error| error.to_string())?;
    Ok(result)
}

pub async fn list_jobs() -> Vec<DaemonJobView> {
    state_cell().lock().await.jobs.iter().map(view).collect()
}

pub async fn get_job(id: &str) -> std::result::Result<DaemonJobView, String> {
    state_cell()
        .lock()
        .await
        .jobs
        .iter()
        .find(|job| job.id == id)
        .map(view)
        .ok_or_else(|| "Account Keeper daemon job was not found".into())
}

pub async fn status() -> DaemonStatus {
    let state = state_cell().lock().await;
    DaemonStatus {
        running: true,
        queued: state.jobs.iter().filter(|job| job.status == "queued").count(),
        active_job_id: state
            .jobs
            .iter()
            .find(|job| matches!(job.status.as_str(), "running" | "waiting_manual"))
            .map(|job| job.id.clone()),
    }
}

pub async fn continue_job(id: &str) -> std::result::Result<DaemonJobView, String> {
    let job = get_job(id).await?;
    if job.status != "waiting_manual" {
        return Err("Account Keeper daemon job is not waiting for manual action".into());
    }
    let batch_id = job.batch_id.ok_or_else(|| "Account Keeper batch is unavailable".to_string())?;
    let current = account_keeper::account_keeper_get_job(BatchRequest { batch_id: batch_id.clone() })?;
    let account_key = current.accounts.iter().find(|account| account.stage == AccountStage::WaitingManual)
        .map(|account| account.account_key.clone())
        .ok_or_else(|| "Account Keeper waiting account is unavailable".to_string())?;
    account_keeper::account_keeper_continue_manual(ManualControlRequest { batch_id, account_key }).await?;
    Ok(get_job(id).await?)
}

pub async fn cancel_job(id: &str) -> std::result::Result<DaemonJobView, String> {
    let job = get_job(id).await?;
    if job.status == "queued" {
        let mut state = state_cell().lock().await;
        let result = {
            let item = state.jobs.iter_mut().find(|candidate| candidate.id == id).unwrap();
            item.status = "cancelled".into();
            item.updated_at = now();
            view(item)
        };
        save_state(&state).map_err(|error| error.to_string())?;
        return Ok(result);
    }
    let batch_id = job.batch_id.ok_or_else(|| "Account Keeper batch is unavailable".to_string())?;
    account_keeper::account_keeper_cancel_batch(BatchRequest { batch_id }).await?;
    Ok(get_job(id).await?)
}

pub async fn resume_job(id: &str) -> std::result::Result<DaemonJobView, String> {
    let job = get_job(id).await?;
    if job.status != "recovery_required" {
        return Err("Account Keeper daemon job does not require recovery".into());
    }
    let batch_id = job.batch_id.ok_or_else(|| "Account Keeper batch is unavailable".to_string())?;
    let app = crate::app_handle().cloned().ok_or_else(|| "BrProxies app is unavailable".to_string())?;
    let window = crate::main_window().ok_or_else(|| "BrProxies window is unavailable".to_string())?;
    account_keeper::account_keeper_resume_job(app, window, BatchRequest { batch_id }).await?;
    update_job_status(id, "running", None, None)
        .await
        .map_err(|error| error.to_string())?;
    get_job(id).await
}

pub fn start() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        {
            let mut state = state_cell().lock().await;
            recover_after_restart(&mut state);
            let _ = save_state(&state);
        }
        loop {
            let _ = tick().await;
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    });
}

async fn tick() -> Result<()> {
    let active = {
        let state = state_cell().lock().await;
        state.jobs.iter().find(|job| matches!(job.status.as_str(), "running" | "waiting_manual"))
            .map(|job| (job.id.clone(), job.batch_id.clone()))
    };
    if let Some((id, Some(batch_id))) = active {
        if let Ok(batch) = account_keeper::account_keeper_get_job(BatchRequest { batch_id }) {
            sync_batch(&id, &batch).await?;
        }
        return Ok(());
    }
    let next = {
        let state = state_cell().lock().await;
        next_queued_job(&state)
    };
    let Some(id) = next else { return Ok(()); };
    start_queued_job(&id).await
}

async fn start_queued_job(id: &str) -> Result<()> {
    let job = {
        let state = state_cell().lock().await;
        state.jobs.iter().find(|job| job.id == id).cloned().context("daemon job missing")?
    };
    let app = crate::app_handle().cloned().context("BrProxies app unavailable")?;
    let window = crate::main_window().context("BrProxies window unavailable")?;
    let request = StartRequest {
        source: InputSource::File { path: job.input_path },
        output_path: job.output_path,
        template: job.template,
        adapter_id: "openai-chatgpt-v1".into(),
        operation: "change_password".into(),
        keep_profile_running: job.keep_profile_running,
        pause_after_current: false,
    };
    match account_keeper::account_keeper_start_batch(app, window, request).await {
        Ok(batch) => {
            let mut state = state_cell().lock().await;
            let item = state.jobs.iter_mut().find(|candidate| candidate.id == id).context("daemon job missing")?;
            item.batch_id = Some(batch.batch_id.clone());
            item.status = "running".into();
            item.updated_at = now();
            save_state(&state)
        }
        Err(error) if error.contains("already active") => Ok(()),
        Err(_) => update_job_status(id, "failed", None, Some("start_failed".into())).await.map(|_| ()),
    }
}

async fn sync_batch(id: &str, batch: &account_keeper::JobView) -> Result<()> {
    let status = match batch.status {
        JobStatus::Queued | JobStatus::Running | JobStatus::Paused => "running",
        JobStatus::WaitingManual => "waiting_manual",
        JobStatus::Completed => "completed",
        JobStatus::Failed => "failed",
        JobStatus::Critical => "critical",
        JobStatus::Cancelled | JobStatus::Abandoned => "cancelled",
    };
    let stage = batch.accounts.iter().find(|account| account.stage != AccountStage::Success)
        .or_else(|| batch.accounts.last()).map(|account| account.stage);
    let error = batch.accounts.iter().find_map(|account| account.error_code.clone());
    update_job_status(id, status, stage, error).await?;
    Ok(())
}

async fn update_job_status(id: &str, status: &str, stage: Option<AccountStage>, error: Option<String>) -> Result<DaemonJobView> {
    let mut state = state_cell().lock().await;
    let item = state.jobs.iter_mut().find(|job| job.id == id).context("daemon job missing")?;
    item.status = status.into();
    item.stage = stage;
    item.error_code = error;
    item.has_last_verified_at = status == "completed" && item.account_count > 0;
    item.updated_at = now();
    let result = view(item);
    save_state(&state)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_marks_active_job_for_manual_recovery() {
        let mut state = DaemonState::default();
        state.jobs.push_back(test_job("active", "running"));
        state.jobs.push_back(test_job("queued", "queued"));

        recover_after_restart(&mut state);

        assert_eq!(state.jobs[0].status, "recovery_required");
        assert_eq!(state.jobs[1].status, "queued");
    }

    #[test]
    fn next_job_uses_fifo_and_one_active_slot() {
        let mut state = DaemonState::default();
        state.jobs.push_back(test_job("first", "queued"));
        state.jobs.push_back(test_job("second", "queued"));

        assert_eq!(next_queued_job(&state).as_deref(), Some("first"));
        state.jobs[0].status = "running".into();
        assert_eq!(next_queued_job(&state), None);
    }

    #[test]
    fn public_job_view_omits_secret_bearing_request_fields() {
        let mut job = test_job("job-1", "queued");
        job.input_path = "C:/synthetic/private-input.txt".into();
        job.output_path = "C:/synthetic/private-output.json".into();
        job.template = "Synthetic-{random:16}".into();

        let serialized = serde_json::to_string(&view(&job)).unwrap();

        assert!(!serialized.contains("private-input"));
        assert!(!serialized.contains("private-output"));
        assert!(!serialized.contains("Synthetic-"));
    }

    #[test]
    fn create_request_rejects_inline_credential_fields() {
        let decoded = serde_json::from_value::<CreateJobRequest>(serde_json::json!({
            "input_path": "C:/synthetic/input.txt",
            "authorize_password_change": true,
            "password": "synthetic-not-accepted"
        }));

        assert!(decoded.is_err());
    }

    fn test_job(id: &str, status: &str) -> DaemonJob {
        DaemonJob {
            id: id.into(),
            status: status.into(),
            ..DaemonJob::default()
        }
    }
}
