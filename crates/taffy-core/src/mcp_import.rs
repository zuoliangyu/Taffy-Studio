//! Import a user-authored **stdio** MCP server from a ZIP (desktop / server-
//! side — you can't spawn a process on native mobile).
//!
//! The zip carries the server's code plus a `taffy-mcp.json` manifest:
//!
//! ```json
//! { "name": "My Server", "command": "node", "args": ["${dir}/server.js"],
//!   "env": ["FOO=bar"] }
//! ```
//!
//! We unpack it (zip-slip guarded, sharing `skills`' path helpers) into a
//! managed dir `<config>/com.taffy.studio/mcp-servers/<name>/`, then resolve the
//! `${dir}` token in `command`/`args` to that absolute dir so the result is
//! ready to spawn. The caller turns the returned `McpImportResult` into a
//! stdio `McpServerConfig`. Nothing is executed here.

use crate::skills::{resolve_within, sanitize_name, sanitize_rel_path};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Tauri bundle id — the app config subdir both shells share.
const APP_DIR: &str = "com.taffy.studio";

/// The `taffy-mcp.json` manifest at the zip root (or one wrapping dir down).
#[derive(Debug, Deserialize)]
struct Manifest {
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: Vec<String>,
}

/// A ready-to-spawn stdio config derived from an imported zip. `command`/`args`
/// have their `${dir}` tokens resolved to the absolute install dir.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpImportResult {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<String>,
}

/// Default managed-MCP root, sibling to the skills dir:
/// `config_dir/com.taffy.studio/mcp-servers`.
pub fn default_mcp_root() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_DIR).join("mcp-servers")
}

/// Filesystem store for imported stdio MCP servers. One dir per server.
pub struct McpImportStore {
    root: PathBuf,
}

impl McpImportStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let _ = std::fs::create_dir_all(&root);
        Self { root }
    }

    /// Unpack `bytes`, read its `taffy-mcp.json`, install it, and return the
    /// resolved spawn config.
    pub fn import_zip(&self, bytes: &[u8]) -> Result<McpImportResult, String> {
        let raw = read_zip(bytes)?;
        // Locate the manifest at the root or one wrapping folder down.
        let prefix = raw
            .iter()
            .map(|(n, _)| n)
            .find(|n| *n == "taffy-mcp.json" || n.ends_with("/taffy-mcp.json"))
            .map(|n| n.strip_suffix("taffy-mcp.json").unwrap_or("").to_string())
            .ok_or_else(|| "zip has no taffy-mcp.json manifest".to_string())?;

        let mut files = HashMap::new();
        for (n, b) in raw {
            if let Some(rel) = n.strip_prefix(&prefix) {
                if !rel.is_empty() {
                    files.insert(rel.to_string(), b);
                }
            }
        }
        let manifest_bytes = files
            .get("taffy-mcp.json")
            .ok_or_else(|| "manifest is nested too deeply".to_string())?;
        let manifest: Manifest = serde_json::from_slice(manifest_bytes)
            .map_err(|e| format!("invalid taffy-mcp.json: {e}"))?;
        if manifest.command.trim().is_empty() {
            return Err("taffy-mcp.json: 'command' is required".to_string());
        }

        let dir = self.write_atomic(&manifest.name, files)?;
        let dir_str = dir.to_string_lossy().to_string();
        let subst = |s: &str| s.replace("${dir}", &dir_str);

        Ok(McpImportResult {
            name: manifest.name,
            command: subst(&manifest.command),
            args: manifest.args.iter().map(|a| subst(a)).collect(),
            env: manifest.env,
        })
    }

    /// Write all files to a staging dir, then swap it into place — a failed
    /// import can't leave a half-written server. Returns the final dir.
    fn write_atomic(
        &self,
        name: &str,
        files: HashMap<String, Vec<u8>>,
    ) -> Result<PathBuf, String> {
        let safe = sanitize_name(name).ok_or_else(|| format!("invalid server name '{name}'"))?;
        let target = self.root.join(&safe);
        let staging = self.root.join(format!(".{safe}.staging"));
        let _ = std::fs::remove_dir_all(&staging);

        let result = (|| {
            for (rel, bytes) in &files {
                let dest =
                    resolve_within(&staging, rel).ok_or_else(|| format!("bad path '{rel}'"))?;
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
            }
            if !staging.join("taffy-mcp.json").exists() {
                return Err("no taffy-mcp.json after staging".to_string());
            }
            let _ = std::fs::remove_dir_all(&target);
            std::fs::rename(&staging, &target).map_err(|e| e.to_string())
        })();

        if result.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        result.map(|_| target)
    }
}

/// Read every file entry of a zip into `(safe_rel_path, bytes)`, dropping
/// directories and zip-slip entries.
fn read_zip(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let Some(name) = sanitize_rel_path(f.name()) else {
            continue;
        };
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut f, &mut buf).map_err(|e| e.to_string())?;
        raw.push((name, buf));
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const MANIFEST: &str =
        r#"{"name":"echo","command":"node","args":["${dir}/server.js","--flag"],"env":["X=1"]}"#;

    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opt = zip::write::SimpleFileOptions::default();
            for (n, b) in entries {
                zw.start_file(*n, opt).unwrap();
                zw.write_all(b).unwrap();
            }
            zw.finish().unwrap();
        }
        buf
    }

    #[test]
    fn imports_manifest_and_resolves_dir_token() {
        let dir = tempfile::tempdir().unwrap();
        let store = McpImportStore::new(dir.path());
        let zip = zip_with(&[
            ("echo/taffy-mcp.json", MANIFEST.as_bytes()),
            ("echo/server.js", b"console.log('hi')"),
        ]);
        let res = store.import_zip(&zip).unwrap();
        assert_eq!(res.name, "echo");
        assert_eq!(res.command, "node");
        assert_eq!(res.env, vec!["X=1"]);
        // ${dir} resolved to the absolute install dir; server.js sits inside it.
        assert!(res.args[0].ends_with("server.js"));
        assert!(res.args[0].contains("echo"));
        assert_eq!(res.args[1], "--flag");
        assert!(std::path::Path::new(&res.args[0]).exists());
    }

    #[test]
    fn missing_manifest_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let store = McpImportStore::new(dir.path());
        let zip = zip_with(&[("server.js", b"x")]);
        assert!(store.import_zip(&zip).is_err());
    }

    #[test]
    fn zip_slip_entries_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let store = McpImportStore::new(dir.path());
        // An escaping entry rides alongside a valid manifest; it must not land
        // outside the managed dir.
        let zip = zip_with(&[
            ("taffy-mcp.json", MANIFEST.as_bytes()),
            ("../escape.js", b"evil"),
        ]);
        store.import_zip(&zip).unwrap();
        assert!(!dir.path().parent().unwrap().join("escape.js").exists());
    }
}
