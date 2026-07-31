use anyhow::Result;

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

#[cfg(not(windows))]
pub(crate) fn protect(_input: &[u8]) -> Result<Vec<u8>> {
    bail!("Account Keeper is supported on Windows only")
}

#[cfg(not(windows))]
pub(crate) fn unprotect(_input: &[u8]) -> Result<Vec<u8>> {
    bail!("Account Keeper is supported on Windows only")
}
