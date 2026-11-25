use anyhow::Result;

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn concurrent_first_use_keeps_one_key() {
        use std::sync::{Arc, Barrier, Mutex};
        let path = std::env::temp_dir().join(format!("brkeeper-lock-{}", uuid::Uuid::new_v4()));
        let barrier = Arc::new(Barrier::new(2));
        let store = Arc::new(Mutex::new(None::<Vec<u8>>));
        let writes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let (barrier, store, writes, path) =
                    (barrier.clone(), store.clone(), writes.clone(), path.clone());
                std::thread::spawn(move || {
                    let mut first = true;
                    vault_key_with_store(
                        true,
                        &path,
                        || {
                            let value = store.lock().unwrap().clone();
                            if first {
                                first = false;
                                barrier.wait();
                            }
                            Ok(value)
                        },
                        |key| {
                            writes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            *store.lock().unwrap() = Some(key.to_vec());
                            Ok(())
                        },
                    )
                    .unwrap()
                    .to_vec()
                })
            })
            .collect();
        let keys: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(writes.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(keys[0], keys[1]);
        assert_eq!(store.lock().unwrap().as_ref().unwrap(), &keys[0]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn store_failures_never_create_or_expose_a_key() {
        let path = std::env::temp_dir().join(format!("brkeeper-lock-{}", uuid::Uuid::new_v4()));
        for create in [false, true] {
            let error = vault_key_with_store(
                create,
                &path,
                || bail!("sensitive-provider-details"),
                |_| panic!("must not write after read failure"),
            )
            .unwrap_err();
            assert!(!format!("{error:#}").contains("sensitive-provider-details"));
        }
        assert!(!path.exists());
        assert!(vault_key_with_store(
            false,
            &path,
            || Ok(None),
            |_| panic!("must not replace missing key")
        )
        .is_err());
        assert!(vault_key_with_store(
            true,
            &path,
            || Ok(Some(vec![7; 31])),
            |_| panic!("must not replace invalid key")
        )
        .is_err());
        let error = vault_key_with_store(
            true,
            &path,
            || Ok(None),
            |_| bail!("sensitive-provider-details"),
        )
        .unwrap_err();
        assert!(!format!("{error:#}").contains("sensitive-provider-details"));
        let mut reads = 0;
        assert!(vault_key_with_store(
            true,
            &path,
            || {
                reads += 1;
                if reads == 1 {
                    Ok(None)
                } else {
                    bail!("locked store")
                }
            },
            |_| panic!("must not write after locked reread fails")
        )
        .is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unsafe_lock_fails_closed() {
        use std::os::unix::fs::symlink;
        let path = std::env::temp_dir().join(format!("brkeeper-lock-{}", uuid::Uuid::new_v4()));
        let target = path.with_extension("target");
        std::fs::write(&target, b"unchanged").unwrap();
        symlink(&target, &path).unwrap();
        assert!(vault_key_with_store(
            true,
            &path,
            || Ok(None),
            |_| panic!("unsafe lock must not write")
        )
        .is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"unchanged");
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(target).unwrap();
    }

    // Run by the parent test in independent processes, with a synthetic on-disk
    // credential store. Neither this nor any other test opens the real keyring.
    #[test]
    fn concurrent_process_child() {
        let Some(directory) = std::env::var_os("BRKEEPER_TEST_STORE") else {
            return;
        };
        let directory = std::path::PathBuf::from(directory);
        let id = std::env::var("BRKEEPER_TEST_CHILD").unwrap();
        let mut first = true;
        let key = vault_key_with_store(
            true,
            &directory.join("lock"),
            || {
                let value = match std::fs::read(directory.join("key")) {
                    Ok(value) => Some(value),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(error.into()),
                };
                if first {
                    first = false;
                    std::fs::write(directory.join(format!("ready-{id}")), b"")?;
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                    while !(directory.join("ready-0").exists()
                        && directory.join("ready-1").exists())
                    {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "other child did not arrive"
                        );
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                }
                Ok(value)
            },
            |key| {
                use std::io::Write;
                // Any second creation is a deterministic test failure.
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(directory.join("key"))?;
                file.write_all(key)?;
                Ok(())
            },
        )
        .unwrap();
        std::fs::write(directory.join(format!("result-{id}")), &*key).unwrap();
    }

    #[test]
    fn concurrent_processes_keep_one_key() {
        let directory =
            std::env::temp_dir().join(format!("brkeeper-process-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut children: Vec<_> = (0..2)
            .map(|id| {
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "dpapi::tests::concurrent_process_child",
                        "--nocapture",
                    ])
                    .env("BRKEEPER_TEST_STORE", &directory)
                    .env("BRKEEPER_TEST_CHILD", id.to_string())
                    .spawn()
                    .unwrap()
            })
            .collect();
        let statuses: Vec<_> = children
            .iter_mut()
            .map(|child| child.wait().unwrap())
            .collect();
        assert!(statuses.iter().all(|status| status.success()));
        let key = std::fs::read(directory.join("key")).unwrap();
        assert_eq!(key.len(), 32);
        for id in 0..2 {
            assert_eq!(
                std::fs::read(directory.join(format!("result-{id}"))).unwrap(),
                key
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn native_vault_encryption_is_authenticated_and_randomized() {
        let secret = b"synthetic-account-keeper-secret";
        let first = protect(secret).expect("encrypt with test-only credential store");
        let second = protect(secret).unwrap();
        assert_ne!(first, second);
        assert!(!first.windows(secret.len()).any(|part| part == secret));
        assert_eq!(unprotect(&first).unwrap(), secret);
        let mut damaged = first.clone();
        *damaged.last_mut().unwrap() ^= 1;
        assert!(unprotect(&damaged).is_err());
        assert!(unprotect(b"plaintext is never a vault").is_err());
        for length in 0..first.len() {
            assert!(unprotect(&first[..length]).is_err());
        }
    }
}

#[cfg(not(windows))]
use anyhow::bail;

#[cfg(windows)]
use anyhow::anyhow;
#[cfg(windows)]
use windows_sys::Win32::Foundation::LocalFree;
#[cfg(windows)]
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};

#[cfg(windows)]
pub(crate) fn protect(input: &[u8]) -> Result<Vec<u8>> {
    unsafe { transform(input, true) }
}

#[cfg(windows)]
pub(crate) fn unprotect(input: &[u8]) -> Result<Vec<u8>> {
    unsafe { transform(input, false) }
}

#[cfg(windows)]
unsafe fn transform(input: &[u8], protect: bool) -> Result<Vec<u8>> {
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut output_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let succeeded = if protect {
        CryptProtectData(
            &input_blob,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            0,
            &mut output_blob,
        )
    } else {
        CryptUnprotectData(
            &input_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            0,
            &mut output_blob,
        )
    };
    if succeeded == 0 {
        return Err(anyhow!(
            "DPAPI {} failed",
            if protect { "protect" } else { "unprotect" }
        ));
    }
    let output =
        std::slice::from_raw_parts(output_blob.pbData, output_blob.cbData as usize).to_vec();
    if !output_blob.pbData.is_null() {
        if !protect {
            std::ptr::write_bytes(output_blob.pbData, 0, output_blob.cbData as usize);
        }
        LocalFree(output_blob.pbData as _);
    }
    Ok(output)
}

// Versioned, authenticated envelope. The key exists only in the OS credential
// store (Keychain / Secret Service), never beside the encrypted data.
#[cfg(not(windows))]
const ENVELOPE: &[u8] = b"BRKEEPER\x01";

#[cfg(not(windows))]
pub(crate) fn protect(input: &[u8]) -> Result<Vec<u8>> {
    use aes_gcm::{
        aead::{Aead, KeyInit, Payload},
        Aes256Gcm, Nonce,
    };
    let key = vault_key(true)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key[..]).map_err(|_| anyhow::anyhow!("invalid vault key"))?;
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce).map_err(|_| anyhow::anyhow!("generate vault nonce"))?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: input,
                aad: ENVELOPE,
            },
        )
        .map_err(|_| anyhow::anyhow!("vault encryption failed"))?;
    let mut output = ENVELOPE.to_vec();
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

#[cfg(not(windows))]
pub(crate) fn unprotect(input: &[u8]) -> Result<Vec<u8>> {
    use aes_gcm::{
        aead::{Aead, KeyInit, Payload},
        Aes256Gcm, Nonce,
    };
    if !input.starts_with(ENVELOPE) || input.len() < ENVELOPE.len() + 12 + 16 {
        bail!("invalid Account Keeper encrypted envelope");
    }
    // Never generate a replacement key while reading existing data.
    let key = vault_key(false)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key[..]).map_err(|_| anyhow::anyhow!("invalid vault key"))?;
    cipher
        .decrypt(
            Nonce::from_slice(&input[ENVELOPE.len()..ENVELOPE.len() + 12]),
            Payload {
                msg: &input[ENVELOPE.len() + 12..],
                aad: ENVELOPE,
            },
        )
        .map_err(|_| anyhow::anyhow!("vault authentication failed"))
}

// Tests must never open the developer's real credential store.
#[cfg(all(test, not(windows)))]
fn vault_key(_create: bool) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    Ok(zeroize::Zeroizing::new(vec![0x42; 32]))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn vault_key_with_store(
    create: bool,
    lock_path: &std::path::Path,
    mut read: impl FnMut() -> Result<Option<Vec<u8>>>,
    mut write: impl FnMut(&[u8]) -> Result<()>,
) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    // Fast reads need no lock. A missing entry must be checked again while
    // holding the same advisory lock in every launcher/headless process.
    let existing = read().map_err(|_| anyhow::anyhow!("OS credential store unavailable"))?;
    let key = match existing {
        Some(key) => zeroize::Zeroizing::new(key),
        None if create => {
            let _lock = lock_vault_key(lock_path)?;
            match read().map_err(|_| anyhow::anyhow!("OS credential store unavailable"))? {
                Some(key) => zeroize::Zeroizing::new(key),
                None => {
                    let mut key = zeroize::Zeroizing::new(vec![0u8; 32]);
                    getrandom::getrandom(&mut key)
                        .map_err(|_| anyhow::anyhow!("generate vault key"))?;
                    write(&key).map_err(|_| {
                        anyhow::anyhow!(
                            "save vault key in OS credential store (no plaintext fallback)"
                        )
                    })?;
                    key
                }
            }
        }
        None => bail!("missing original vault key in OS credential store"),
    };
    if key.len() != 32 {
        bail!("invalid Account Keeper key in OS credential store");
    }
    Ok(key)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn lock_vault_key(path: &std::path::Path) -> Result<std::fs::File> {
    use std::os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| anyhow::anyhow!("open vault key lock failed"))?;
    let metadata = file
        .metadata()
        .map_err(|_| anyhow::anyhow!("inspect vault key lock failed"))?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o600
        || metadata.nlink() != 1
    {
        bail!("unsafe vault key lock file");
    }
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
            break;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            bail!("acquire vault key lock failed");
        }
    }
    // Closing the descriptor releases the advisory lock, even on error/panic.
    // Never unlink: all processes must continue to lock the same inode.
    Ok(file)
}

#[cfg(all(not(test), any(target_os = "macos", target_os = "linux")))]
fn vault_key(create: bool) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    // Shared per-user location, independent of profile/data directory and cwd.
    // This directory contains only a lock file, never credential material.
    let directory = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("locate vault key lock directory"))?
        .join(".brproxies-vault");
    match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(_) => bail!("create vault key lock directory failed"),
    }
    let metadata = std::fs::symlink_metadata(&directory)
        .map_err(|_| anyhow::anyhow!("inspect vault key lock directory failed"))?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o700
    {
        bail!("unsafe vault key lock directory");
    }
    // Never attach provider errors: they can contain credential details.
    let entry = keyring::Entry::new("com.brproxies.account-keeper", "vault-key-v1")
        .map_err(|_| anyhow::anyhow!("initialize OS credential store failed"))?;
    vault_key_with_store(
        create,
        &directory.join("vault-key-v1.lock"),
        || match entry.get_secret() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => bail!("OS credential store unavailable"),
        },
        |key| {
            entry
                .set_secret(key)
                .map_err(|_| anyhow::anyhow!("OS credential store write failed"))
        },
    )
}

#[cfg(all(not(test), not(any(windows, target_os = "macos", target_os = "linux"))))]
fn vault_key(_create: bool) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    bail!("Account Keeper requires Windows, macOS, or Linux")
}
