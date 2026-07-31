use crate::account_keeper::{
    self, AccountStage, HeadlessRecoveryState, InputSource, JobStatus, JobView, StartRequest,
};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentArgs {
    pub input_path: PathBuf,
    pub output_path: Option<PathBuf>,
    pub template: Option<String>,
    pub keep_profile_running: bool,
    pub timeout_seconds: u64,
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentAccountSummary {
    pub stage: AccountStage,
    pub attempts: u32,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentSummary {
    pub status: String,
    pub output_path: String,
    pub valid_count: usize,
    pub stopped_for_manual: bool,
    pub timed_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<HeadlessRecoveryState>,
    pub accounts: Vec<AgentAccountSummary>,
}

impl AgentSummary {
    pub fn succeeded(&self) -> bool {
        self.status == JobStatus::Completed.as_str()
            && !self.accounts.is_empty()
            && self
                .accounts
                .iter()
                .all(|account| account.stage == AccountStage::Success)
    }
}

pub fn parse_agent_args<I, S>(args: I) -> Result<AgentArgs>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut input_path = None;
    let mut output_path = None;
    let mut template = None;
    let mut keep_profile_running = true;
    let mut timeout_seconds = 600;
    let mut dry_run = false;
    let mut values = args.into_iter().map(Into::into);

    while let Some(argument) = values.next() {
        match argument.as_str() {
            "--input" => {
                let value = values
                    .next()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| anyhow::anyhow!("--input requires a file path"))?;
                if input_path.replace(PathBuf::from(value)).is_some() {
                    bail!("--input may be provided only once");
                }
            }
            "--output" => {
                let value = values
                    .next()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| anyhow::anyhow!("--output requires a file path"))?;
                if output_path.replace(PathBuf::from(value)).is_some() {
                    bail!("--output may be provided only once");
                }
            }
            "--template" => {
                let value = values
                    .next()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| anyhow::anyhow!("--template requires a value"))?;
                if template.replace(value).is_some() {
                    bail!("--template may be provided only once");
                }
            }
            "--timeout-seconds" => {
                let value = values
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--timeout-seconds requires a value"))?;
                timeout_seconds = value
                    .parse::<u64>()
                    .context("--timeout-seconds must be an integer")?;
                if !(30..=3600).contains(&timeout_seconds) {
                    bail!("--timeout-seconds must be between 30 and 3600");
                }
            }
            "--keep-profile-running" => keep_profile_running = true,
            "--close-profile" => keep_profile_running = false,
            "--dry-run" => dry_run = true,
            _ => bail!("unsupported Account Keeper agent argument"),
        }
    }

    Ok(AgentArgs {
        input_path: input_path.ok_or_else(|| anyhow::anyhow!("--input is required"))?,
        output_path,
        template,
        keep_profile_running,
        timeout_seconds,
        dry_run,
    })
}

pub async fn run_agent(args: AgentArgs) -> Result<AgentSummary> {
    let defaults = account_keeper::account_keeper_defaults().map_err(anyhow::Error::msg)?;
    let input_path = std::fs::canonicalize(&args.input_path)
        .context("Account Keeper input file could not be resolved")?;
    let output_path = absolute_path(
        args.output_path
            .unwrap_or_else(|| PathBuf::from(defaults.output_path)),
    )?;
    let template = args.template.unwrap_or(defaults.template);
    let source = InputSource::File {
        path: path_string(&input_path, "input")?,
    };
    let validation = account_keeper::validate_input_source(&source)?;
    account_keeper::validate_template_value(&template)?;
    let output_path_string = path_string(&output_path, "output")?;

    if args.dry_run {
        return Ok(AgentSummary {
            status: "validated".to_string(),
            output_path: output_path_string,
            valid_count: validation.valid_count,
            stopped_for_manual: false,
            timed_out: false,
            recovery: account_keeper::inspect_headless_recovery(&source)?,
            accounts: Vec::new(),
        });
    }

    let request = StartRequest {
            source: source.clone(),
            output_path: output_path_string.clone(),
            template,
            adapter_id: "openai-chatgpt-v1".to_string(),
            keep_profile_running: args.keep_profile_running,
            pause_after_current: false,
        };
    let mut result = match account_keeper::run_headless_batch(
        request.clone(),
        args.timeout_seconds,
    )
    .await
    {
        Ok(result) => result,
        Err(error)
            if validation.valid_count == 1
                && error
                    .to_string()
                    .contains("credential recovery is required") =>
        {
            let recovery = account_keeper::inspect_headless_recovery(&source)?;
            if recovery.is_some_and(|state| state.has_pending_password) {
                account_keeper::HeadlessRunResult {
                    job: account_keeper::recover_headless_pending_credentials(
                        &source,
                        args.timeout_seconds,
                    )
                    .await?,
                    stopped_for_manual: false,
                    timed_out: false,
                }
            } else {
                account_keeper::recover_headless_credentials(&source, args.timeout_seconds).await?;
                account_keeper::run_headless_batch(request, args.timeout_seconds).await?
            }
        }
        Err(error) => return Err(error),
    };
    if result.job.status == JobStatus::Critical
        && account_keeper::inspect_headless_recovery(&source)?
            .is_some_and(|state| state.has_pending_password)
    {
        result = account_keeper::HeadlessRunResult {
            job: account_keeper::recover_headless_pending_credentials(
                &source,
                args.timeout_seconds,
            )
            .await?,
            stopped_for_manual: false,
            timed_out: false,
        };
    }

    Ok(summary_from_job(
        &result.job,
        validation.valid_count,
        result.stopped_for_manual,
        result.timed_out,
    ))
}

fn summary_from_job(
    job: &JobView,
    valid_count: usize,
    stopped_for_manual: bool,
    timed_out: bool,
) -> AgentSummary {
    AgentSummary {
        status: job.status.as_str().to_string(),
        output_path: job.output_path.clone(),
        valid_count,
        stopped_for_manual,
        timed_out,
        recovery: None,
        accounts: job
            .accounts
            .iter()
            .map(|account| AgentAccountSummary {
                stage: account.stage,
                attempts: account.attempts,
                error_code: account.error_code.clone(),
            })
            .collect(),
    }
}

fn absolute_path(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path);
    }
    Ok(std::env::current_dir()
        .context("Account Keeper working directory is unavailable")?
        .join(path))
}

fn path_string(path: &std::path::Path, kind: &str) -> Result<String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow::anyhow!("Account Keeper {kind} path is not valid Unicode"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_file_only_workflow_arguments() {
        let args = parse_agent_args([
            "--input",
            "C:\\private\\account-keeper-input.txt",
            "--output",
            "C:\\private\\account-keeper-result.json",
            "--template",
            "BrP@{random:20}!",
            "--timeout-seconds",
            "900",
            "--keep-profile-running",
            "--dry-run",
        ])
        .unwrap();

        assert_eq!(
            args.input_path,
            PathBuf::from("C:\\private\\account-keeper-input.txt")
        );
        assert_eq!(
            args.output_path,
            Some(PathBuf::from("C:\\private\\account-keeper-result.json"))
        );
        assert_eq!(args.template.as_deref(), Some("BrP@{random:20}!"));
        assert_eq!(args.timeout_seconds, 900);
        assert!(args.keep_profile_running);
        assert!(args.dry_run);
    }

    #[test]
    fn defaults_are_safe_for_autonomous_runs() {
        let args = parse_agent_args(["--input", "input.txt"]).unwrap();

        assert_eq!(args.output_path, None);
        assert_eq!(args.template, None);
        assert_eq!(args.timeout_seconds, 600);
        assert!(args.keep_profile_running);
        assert!(!args.dry_run);
    }

    #[test]
    fn rejects_inline_credentials_and_unknown_flags() {
        assert!(parse_agent_args(["--inline", "secret"]).is_err());
        assert!(parse_agent_args(["--input", "input.txt", "--password", "secret"]).is_err());
        assert!(parse_agent_args(["--input"]).is_err());
    }

    #[test]
    fn summary_serialization_contains_no_identity_or_secret_fields() {
        let job = JobView {
            batch_id: "batch".to_string(),
            status: JobStatus::Completed,
            updated_at: "@1".to_string(),
            output_path: "result.json".to_string(),
            keep_profile_running: true,
            pause_after_current: false,
            accounts: vec![crate::account_keeper::AccountView {
                account_key: "secret-key".to_string(),
                masked_account: "s***@example.test".to_string(),
                profile_id: Some("profile-secret".to_string()),
                stage: AccountStage::Success,
                attempts: 1,
                updated_at: "@1".to_string(),
                error_code: None,
            }],
        };

        let json = serde_json::to_string(&summary_from_job(&job, 1, false, false)).unwrap();

        assert!(!json.contains("secret-key"));
        assert!(!json.contains("example.test"));
        assert!(!json.contains("profile-secret"));
        assert!(json.contains("success"));
    }
}
