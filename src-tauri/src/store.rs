// Persistent storage layout under the user's config dir:
//   $CONFIG/brproxies-launcher/
//     profiles/                   ← fingerprint profile JSON files
//     proxies.json                ← saved proxy list
//     user-data/<profile-id>/     ← per-profile user-data-dir for BrProxies
//     settings.json               ← global app settings

use anyhow::{Context, Result};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn config_root() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var_os("BRPROXIES_QA_CONFIG_ROOT") {
        let root = PathBuf::from(value);
        if !root.is_absolute() {
            return Err(anyhow::anyhow!(
                "BRPROXIES_QA_CONFIG_ROOT must be an absolute path"
            ));
        }
        std::fs::create_dir_all(&root)?;
        return Ok(root);
    }

    let base = dirs::config_dir().context("OS config dir unavailable")?;
    let root = base.join("brproxies-launcher");
    let legacy = base.join("shardx-launcher");
    if !root.exists() && legacy.exists() {
        std::fs::rename(&legacy, &root).or_else(|_| {
            std::fs::create_dir_all(&root)?;
            Ok::<(), std::io::Error>(())
        })?;
    }
    std::fs::create_dir_all(&root)?;
    Ok(root)
}

pub fn profiles_dir() -> Result<PathBuf> {
    let p = config_root()?.join("profiles");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn fingerprints_dir() -> Result<PathBuf> {
    let p = config_root()?.join("fingerprints");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

/// Cached Widevine CDM, seeded from a host Chrome install (or
/// downloaded from the project's git LFS bucket for end users).  When
/// present, every freshly-created profile's user-data-dir gets a
/// pre-warmed `WidevineCdm/` copy so the browser doesn't sit waiting
/// on the component updater the first time a DRM page (Netflix /
/// Spotify / etc.) loads.
pub fn widevine_cache_dir() -> Result<PathBuf> {
    Ok(config_root()?.join("widevine-cdm"))
}

pub fn user_data_root() -> Result<PathBuf> {
    let p = config_root()?.join("user-data");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn proxies_path() -> Result<PathBuf> {
    Ok(config_root()?.join("proxies.json"))
}

pub fn settings_path() -> Result<PathBuf> {
    Ok(config_root()?.join("settings.json"))
}

/// ProxyShard billing-API config (Bearer key). Kept in its own file so the
/// Settings page (which round-trips the whole Settings struct) can never
/// clobber the saved key.
pub fn psapi_path() -> Result<PathBuf> {
    Ok(config_root()?.join("psapi.json"))
}

/// 5SIM SMS-verification API config (Bearer token). Kept in its own file so
/// the Settings page (which round-trips the whole Settings struct) can never
/// clobber the saved token.
pub fn sms5sim_path() -> Result<PathBuf> {
    Ok(config_root()?.join("sms5sim.json"))
}

pub fn proxypool_dir() -> Result<PathBuf> {
    let p = config_root()?.join("proxypool");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn proxypool_config_path() -> Result<PathBuf> {
    Ok(proxypool_dir()?.join("config.json"))
}

pub fn android_manager_dir() -> Result<PathBuf> {
    let p = config_root()?.join("android-manager");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn android_manager_config_path() -> Result<PathBuf> {
    Ok(android_manager_dir()?.join("config.json"))
}

pub fn account_keeper_dir() -> Result<PathBuf> {
    let path = config_root()?.join("account-keeper");
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn account_keeper_vault_path() -> Result<PathBuf> {
    Ok(account_keeper_dir()?.join("vault.bin"))
}

pub fn account_keeper_jobs_dir() -> Result<PathBuf> {
    let path = account_keeper_dir()?.join("jobs");
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn account_keeper_worker_dir() -> Result<PathBuf> {
    let path = account_keeper_dir()?.join("worker");
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn account_keeper_daemon_path() -> Result<PathBuf> {
    Ok(account_keeper_dir()?.join("daemon.bin"))
}

pub fn atomic_write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).context("serialize atomic JSON")?;
    atomic_write_bytes(path, &bytes)
}

pub(crate) fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("atomic destination has no parent")?;
    std::fs::create_dir_all(parent).context("create atomic destination directory")?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("atomic destination has an invalid file name")?;
    let mut random = [0u8; 8];
    getrandom::getrandom(&mut random)
        .map_err(|_| anyhow::anyhow!("generate atomic temp name failed"))?;
    let suffix = u64::from_le_bytes(random);
    let temp_path = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        suffix
    ));

    let write_result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .context("create atomic temp file")?;
        file.write_all(bytes).context("write atomic temp file")?;
        file.sync_all().context("flush atomic temp file")?;
        replace_file(&temp_path, path).context("replace atomic destination")?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    write_result
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let succeeded = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<()> {
    std::fs::rename(source, destination)?;
    Ok(())
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn debug_qa_config_root_override_is_used() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous = std::env::var_os("BRPROXIES_QA_CONFIG_ROOT");
        let expected =
            std::env::temp_dir().join(format!("brproxies-config-root-qa-{}", std::process::id()));
        std::env::set_var("BRPROXIES_QA_CONFIG_ROOT", &expected);

        let actual = config_root().unwrap();

        if let Some(value) = previous {
            std::env::set_var("BRPROXIES_QA_CONFIG_ROOT", value);
        } else {
            std::env::remove_var("BRPROXIES_QA_CONFIG_ROOT");
        }
        assert_eq!(actual, expected);
        let _ = std::fs::remove_dir_all(expected);
    }
}
