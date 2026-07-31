// Write the MCP server source embedded in the BrProxies executable into a
// user-chosen folder. The app does not run or manage this Node process; the
// user installs dependencies and registers it with an MCP client.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// MCP source files compiled into the BrProxies executable.
const EMBEDDED_MCP_FILES: &[(&str, &str)] = &[
    ("index.js", include_str!("../../mcp/index.js")),
    (
        "account-keeper-tools.js",
        include_str!("../../mcp/account-keeper-tools.js"),
    ),
    ("package.json", include_str!("../../mcp/package.json")),
    ("README.md", include_str!("../../mcp/README.md")),
];

fn write_embedded_mcp(dest: &Path) -> Result<()> {
    std::fs::create_dir_all(dest).context("create MCP destination")?;
    for (name, contents) in EMBEDDED_MCP_FILES {
        std::fs::write(dest.join(name), contents)
            .with_context(|| format!("write embedded MCP file {name}"))?;
    }
    Ok(())
}

/// Download the MCP server into `<dir>/mcp` and return that path.
pub async fn download_mcp(dir: &Path) -> Result<PathBuf> {
    let dest = dir.join("mcp");
    write_embedded_mcp(&dest)?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_bundle_contains_account_keeper_tools() {
        let root = std::env::temp_dir().join(format!("brproxies-mcp-test-{}", uuid::Uuid::new_v4()));
        let dest = root.join("mcp");

        write_embedded_mcp(&dest).unwrap();

        let index = std::fs::read_to_string(dest.join("index.js")).unwrap();
        let tools = std::fs::read_to_string(dest.join("account-keeper-tools.js")).unwrap();
        assert!(index.contains("registerAccountKeeperTools"));
        assert!(tools.contains("account_keeper_create_job"));
        let _ = std::fs::remove_dir_all(root);
    }
}
