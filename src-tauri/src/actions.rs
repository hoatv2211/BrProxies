use crate::{process::Tracker, profile, store};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, process::Stdio};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ActionsConfig {
    #[serde(default)]
    pub actions: Vec<ActionConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionConfig {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub commands: Vec<ActionCommandConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionCommandConfig {
    pub id: String,
    pub label: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub requires_running: bool,
    #[serde(default)]
    pub requires_stopped: bool,
    #[serde(default = "default_run_mode")]
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileActionCommand {
    pub action_id: String,
    pub command_id: String,
    pub label: String,
    pub description: String,
    pub requires_running: bool,
    pub requires_stopped: bool,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionRunResult {
    pub success: bool,
    pub message: String,
    pub stdout: String,
    pub stderr: String,
}

struct ActionContext {
    profile: profile::ProfileMeta,
    user_data_dir: String,
    pid: Option<u32>,
}

fn default_enabled() -> bool {
    true
}

fn default_run_mode() -> String {
    "detached".into()
}

pub fn actions_path() -> Result<std::path::PathBuf> {
    Ok(store::config_root()?.join("actions.json"))
}

pub fn config_path_string() -> Result<String> {
    Ok(actions_path()?.display().to_string())
}

pub fn ensure_config() -> Result<()> {
    let path = actions_path()?;
    if path.exists() {
        return Ok(());
    }
    let body = serde_json::to_string_pretty(&default_config())?;
    fs::write(path, body)?;
    Ok(())
}

pub fn load_config() -> Result<ActionsConfig> {
    ensure_config()?;
    let path = actions_path()?;
    let body = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    Ok(serde_json::from_str(&body).context("parse actions.json")?)
}

pub fn list_for_profile(profile_id: &str) -> Result<Vec<ProfileActionCommand>> {
    let ctx = action_context(profile_id)?;
    let is_running = ctx.pid.is_some();
    let cfg = load_config()?;
    let mut out = Vec::new();
    for action in cfg.actions.into_iter().filter(|a| a.enabled) {
        for command in action.commands {
            if command.requires_running && !is_running {
                continue;
            }
            if command.requires_stopped && is_running {
                continue;
            }
            out.push(ProfileActionCommand {
                action_id: action.id.clone(),
                command_id: command.id.clone(),
                label: format!("{}: {}", action.label, command.label),
                description: action.description.clone(),
                requires_running: command.requires_running,
                requires_stopped: command.requires_stopped,
                mode: command.mode.clone(),
            });
        }
    }
    Ok(out)
}

pub fn run(profile_id: &str, action_id: &str, command_id: &str) -> Result<ActionRunResult> {
    let ctx = action_context(profile_id)?;
    let is_running = ctx.pid.is_some();
    let cfg = load_config()?;
    let action = cfg
        .actions
        .into_iter()
        .find(|a| a.enabled && a.id == action_id)
        .context("action not found")?;
    let command = action
        .commands
        .into_iter()
        .find(|c| c.id == command_id)
        .context("command not found")?;
    if command.requires_running && !is_running {
        anyhow::bail!("profile must be running");
    }
    if command.requires_stopped && is_running {
        anyhow::bail!("profile must be stopped");
    }

    let args = resolve_args(&command.args, &ctx);
    if command.mode.eq_ignore_ascii_case("wait") {
        let output = std::process::Command::new(&command.command)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .with_context(|| format!("run {}", command.command))?;
        return Ok(ActionRunResult {
            success: output.status.success(),
            message: if output.status.success() {
                format!("{} finished", command.label)
            } else {
                format!("{} exited with {}", command.label, output.status)
            },
            stdout: truncate_output(String::from_utf8_lossy(&output.stdout).to_string()),
            stderr: truncate_output(String::from_utf8_lossy(&output.stderr).to_string()),
        });
    }

    spawn_detached(&command.command, &args)?;
    Ok(ActionRunResult {
        success: true,
        message: format!("{} started", command.label),
        stdout: String::new(),
        stderr: String::new(),
    })
}

fn action_context(profile_id: &str) -> Result<ActionContext> {
    let profile = profile::list_all()?
        .into_iter()
        .find(|p| p.id == profile_id)
        .context("profile not found")?;
    let user_data_dir = profile::user_data_dir(profile_id)?.display().to_string();
    let pid = Tracker::shared()
        .running()
        .into_iter()
        .find(|r| r.profile_id == profile_id)
        .map(|r| r.pid);
    Ok(ActionContext {
        profile,
        user_data_dir,
        pid,
    })
}

fn resolve_args(args: &[String], ctx: &ActionContext) -> Vec<String> {
    args.iter().map(|arg| interpolate(arg, ctx)).collect()
}

fn interpolate(template: &str, ctx: &ActionContext) -> String {
    template
        .replace("{profile.id}", &ctx.profile.id)
        .replace("{profile.name}", &ctx.profile.name)
        .replace("{profile.folder}", &ctx.profile.folder)
        .replace(
            "{profile.proxy_id}",
            ctx.profile.proxy_id.as_deref().unwrap_or(""),
        )
        .replace("{profile.user_data_dir}", &ctx.user_data_dir)
        .replace(
            "{browser.pid}",
            &ctx.pid.map(|p| p.to_string()).unwrap_or_default(),
        )
}

fn truncate_output(mut value: String) -> String {
    const MAX: usize = 8 * 1024;
    if value.len() > MAX {
        value.truncate(MAX);
        value.push_str("\n... truncated ...");
    }
    value
}

fn spawn_detached(command: &str, args: &[String]) -> Result<()> {
    let mut cmd = std::process::Command::new(command);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.spawn().with_context(|| format!("spawn {command}"))?;
    Ok(())
}

fn default_config() -> ActionsConfig {
    #[cfg(target_os = "windows")]
    let open_command = ActionCommandConfig {
        id: "open-user-data".into(),
        label: "Open user data dir".into(),
        command: "explorer".into(),
        args: vec!["{profile.user_data_dir}".into()],
        requires_running: false,
        requires_stopped: false,
        mode: "detached".into(),
    };
    #[cfg(target_os = "macos")]
    let open_command = ActionCommandConfig {
        id: "open-user-data".into(),
        label: "Open user data dir".into(),
        command: "open".into(),
        args: vec!["{profile.user_data_dir}".into()],
        requires_running: false,
        requires_stopped: false,
        mode: "detached".into(),
    };
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let open_command = ActionCommandConfig {
        id: "open-user-data".into(),
        label: "Open user data dir".into(),
        command: "xdg-open".into(),
        args: vec!["{profile.user_data_dir}".into()],
        requires_running: false,
        requires_stopped: false,
        mode: "detached".into(),
    };

    ActionsConfig {
        actions: vec![ActionConfig {
            id: "profile-tools".into(),
            label: "Profile tools".into(),
            description: "Quick local tools for a selected BrProxies profile".into(),
            enabled: true,
            commands: vec![open_command],
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(running: bool) -> ActionContext {
        ActionContext {
            profile: profile::ProfileMeta {
                id: "p1".into(),
                name: "Main Profile".into(),
                notes: String::new(),
                proxy_id: Some("proxy-1".into()),
                last_launched_at: None,
                created_at: None,
                pinned: false,
                folder: "team-a".into(),
                total_runtime_ms: 0,
            },
            user_data_dir: "C:\\data\\p1".into(),
            pid: running.then_some(4242),
        }
    }

    #[test]
    fn interpolates_profile_and_browser_variables() {
        let args = vec![
            "{profile.id}".into(),
            "{profile.name}".into(),
            "{profile.proxy_id}".into(),
            "{profile.folder}".into(),
            "{profile.user_data_dir}".into(),
            "{browser.pid}".into(),
        ];

        assert_eq!(
            resolve_args(&args, &ctx(true)),
            vec![
                "p1",
                "Main Profile",
                "proxy-1",
                "team-a",
                "C:\\data\\p1",
                "4242"
            ]
        );
    }

    #[test]
    fn default_config_has_profile_actions() {
        let cfg = default_config();
        assert!(cfg.actions.iter().any(|a| a.id == "profile-tools"));
        assert!(cfg
            .actions
            .iter()
            .flat_map(|a| &a.commands)
            .any(|c| c.id == "open-user-data"));
    }
}
