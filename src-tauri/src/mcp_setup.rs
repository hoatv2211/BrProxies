// Download the MCP server source from our R2 CDN into a user-chosen
// folder.  The app does NOT run or manage it — the user installs deps
// + registers it with their MCP client themselves (see
// rust/shardx-launcher/mcp/README.md).
//
// The bundle ships pre-packed at ~12 KB (just index.js + package.json
// + README.md), so the download is instant and contains no
// node_modules / .gitignore noise.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Public R2.dev URL for the MCP server bundle (matches the launcher's
/// runtime bucket — same CDN as the browser, Widevine and fingerprint
/// library archives).
const MCP_ARCHIVE_URL: &str =
    "https://pub-e57a7c60f6934eb09a6600bf2fc59cdc.r2.dev/ShardX-MCP.tar.gz";

/// Top-level directory inside the tarball that wraps the actual files.
const MCP_TOP_DIR: &str = "ShardX-MCP";

/// Download the MCP server into `<dir>/mcp` and return that path.
pub async fn download_mcp(dir: &Path) -> Result<PathBuf> {
    let dest = dir.join("mcp");
    let bytes = reqwest::get(MCP_ARCHIVE_URL)
        .await
        .context("download MCP archive")?
        .error_for_status()
        .context("MCP archive request failed")?
        .bytes()
        .await
        .context("read MCP archive")?;

    let gz = flate2::read::GzDecoder::new(&bytes[..]);
    let mut archive = tar::Archive::new(gz);
    std::fs::create_dir_all(&dest)?;
    let mut extracted = 0usize;

    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        // Strip the single top-level wrapper dir ("ShardX-MCP/") so files
        // land directly under dest/.
        let rel: PathBuf = path
            .strip_prefix(MCP_TOP_DIR)
            .unwrap_or(&path)
            .to_path_buf();
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = dest.join(&rel);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&out)?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            entry.unpack(&out)?;
            extracted += 1;
        }
    }
    if extracted == 0 {
        anyhow::bail!("MCP archive contained no files (CDN delivered an empty bundle?)");
    }
    Ok(dest)
}
