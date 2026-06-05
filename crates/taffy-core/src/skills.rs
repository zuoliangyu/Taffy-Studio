//! Local "skills" — Claude-Code-style SKILL.md capability packages.
//!
//! A skill is a directory under the skills root holding `SKILL.md` (YAML
//! frontmatter: `name`, `description`, optional `compatibility` /
//! `allowed-tools`) plus any referenced files. Skills are **not executed** — the
//! agentic loop surfaces a single `use_skill` tool that reads SKILL.md (or a
//! referenced file) on demand and injects it as context; the model then acts
//! using its other tools (MCP / built-ins). That's why skills work on every
//! platform (no sandbox needed). Modeled on rikkahub's design.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Tauri bundle id — the app config subdir both shells share.
const APP_DIR: &str = "com.taffy.studio";

/// Parsed `SKILL.md` frontmatter (camelCase to match the frontend's shape).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility: Option<String>,
    /// Tools this skill is allowed to use (space-separated `allowed-tools`).
    #[serde(default)]
    pub allowed_tools: Vec<String>,
}

/// Default skills root, sibling to the shared DB:
/// `config_dir/com.taffy.studio/skills`.
pub fn default_skills_root() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_DIR).join("skills")
}

/// Filesystem-backed skill store. One directory per skill under `root`.
pub struct SkillStore {
    root: PathBuf,
}

impl SkillStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let _ = std::fs::create_dir_all(&root);
        Self { root }
    }

    /// Every skill (a subdir with a parseable `SKILL.md`), sorted by name.
    pub fn list(&self) -> Vec<SkillMeta> {
        let mut out = Vec::new();
        let Ok(rd) = std::fs::read_dir(&self.root) else {
            return out;
        };
        for entry in rd.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(dir.join("SKILL.md")) {
                if let Some(meta) = parse_skill(&content) {
                    out.push(meta);
                }
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// `SKILL.md` body (after the frontmatter) for `name`.
    pub fn read_body(&self, name: &str) -> Option<String> {
        let dir = self.skill_dir(name)?;
        let content = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
        Some(split_frontmatter(&content).1.to_string())
    }

    /// Read a file inside a skill directory, refusing paths that escape it.
    pub fn read_file(&self, name: &str, rel: &str) -> Result<String, String> {
        let dir = self
            .skill_dir(name)
            .ok_or_else(|| format!("unknown skill '{name}'"))?;
        let target = resolve_within(&dir, rel)
            .ok_or_else(|| format!("path '{rel}' is outside skill '{name}'"))?;
        std::fs::read_to_string(&target).map_err(|e| e.to_string())
    }

    /// Create/replace a skill from a single `SKILL.md` document.
    pub fn import_markdown(&self, content: &str) -> Result<SkillMeta, String> {
        let meta = parse_skill(content)
            .ok_or_else(|| "SKILL.md is missing a name/description frontmatter".to_string())?;
        let mut files = HashMap::new();
        files.insert("SKILL.md".to_string(), content.as_bytes().to_vec());
        self.write_atomic(&meta.name, files)?;
        Ok(meta)
    }

    /// Create/replace a skill from a ZIP. `SKILL.md` may sit at the root or one
    /// level down (a single wrapping folder); everything beside it is kept.
    pub fn import_zip(&self, bytes: &[u8]) -> Result<SkillMeta, String> {
        let mut zip =
            zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
        let mut raw: Vec<(String, Vec<u8>)> = Vec::new();
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
            if f.is_dir() {
                continue;
            }
            // zip-slip guard: drop anything with `..` / absolute / drive parts.
            let Some(name) = sanitize_rel_path(f.name()) else {
                continue;
            };
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut f, &mut buf).map_err(|e| e.to_string())?;
            raw.push((name, buf));
        }
        // Find SKILL.md and the prefix (allow one wrapping directory).
        let prefix = raw
            .iter()
            .map(|(n, _)| n)
            .find(|n| *n == "SKILL.md" || n.ends_with("/SKILL.md"))
            .map(|n| n.strip_suffix("SKILL.md").unwrap_or("").to_string())
            .ok_or_else(|| "zip has no SKILL.md".to_string())?;

        let mut files = HashMap::new();
        for (n, b) in raw {
            if let Some(rel) = n.strip_prefix(&prefix) {
                if !rel.is_empty() {
                    files.insert(rel.to_string(), b);
                }
            }
        }
        let content = files
            .get("SKILL.md")
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .ok_or_else(|| "zip SKILL.md is nested too deeply".to_string())?;
        let meta = parse_skill(&content)
            .ok_or_else(|| "SKILL.md is missing a name/description frontmatter".to_string())?;
        self.write_atomic(&meta.name, files)?;
        Ok(meta)
    }

    pub fn delete(&self, name: &str) -> Result<(), String> {
        let Some(dir) = self.skill_dir(name) else {
            return Ok(());
        };
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Write all files to a staging dir, then swap it into place — so a failed
    /// import can't leave a half-written skill.
    fn write_atomic(&self, name: &str, files: HashMap<String, Vec<u8>>) -> Result<(), String> {
        let target = self
            .skill_dir(name)
            .ok_or_else(|| format!("invalid skill name '{name}'"))?;
        let safe = sanitize_name(name).unwrap_or_default();
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
            if !staging.join("SKILL.md").exists() {
                return Err("no SKILL.md after staging".to_string());
            }
            let _ = std::fs::remove_dir_all(&target);
            std::fs::rename(&staging, &target).map_err(|e| e.to_string())
        })();

        if result.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        result
    }

    fn skill_dir(&self, name: &str) -> Option<PathBuf> {
        Some(self.root.join(sanitize_name(name)?))
    }
}

/// A skill name must be one safe path segment (no separators, `..`, or hidden).
/// Shared with `mcp_import` (managed MCP-server dir names).
pub(crate) fn sanitize_name(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty()
        || name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains(':')
    {
        return None;
    }
    Some(name.to_string())
}

/// Normalize a zip entry / relative path to a safe forward-slash path (rejects
/// absolute, `..`, and drive/scheme parts — the zip-slip guard). Shared with
/// `mcp_import`.
pub(crate) fn sanitize_rel_path(path: &str) -> Option<String> {
    let mut parts = Vec::new();
    for seg in path.replace('\\', "/").split('/') {
        match seg {
            "" | "." => continue,
            ".." => return None,
            s if s.contains(':') => return None,
            s => parts.push(s.to_string()),
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// Resolve `rel` under `base`, guaranteeing the result stays within `base`.
/// Shared with `mcp_import`.
pub(crate) fn resolve_within(base: &Path, rel: &str) -> Option<PathBuf> {
    Some(base.join(sanitize_rel_path(rel)?))
}

// ---------- frontmatter ----------

fn parse_skill(content: &str) -> Option<SkillMeta> {
    let (fm, _) = split_frontmatter(content);
    let map = parse_yaml_kv(fm);
    let name = map
        .get("name")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())?;
    let description = map
        .get("description")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())?;
    Some(SkillMeta {
        name: name.to_string(),
        description: description.to_string(),
        compatibility: map.get("compatibility").cloned(),
        allowed_tools: map
            .get("allowed-tools")
            .map(|s| s.split_whitespace().map(|x| x.to_string()).collect())
            .unwrap_or_default(),
    })
}

/// Split `---\n…\n---\n<body>` into (frontmatter, body). Returns ("", content)
/// when there's no frontmatter.
fn split_frontmatter(content: &str) -> (&str, &str) {
    let Some(rest) = content.strip_prefix("---") else {
        return ("", content);
    };
    let mut from = 0;
    while let Some(idx) = rest[from..].find("\n---") {
        let abs = from + idx;
        let tail = &rest[abs + 4..]; // after "\n---"
        if tail.is_empty() || tail.starts_with(['\n', '\r']) {
            let body = tail.trim_start_matches(['\r', '\n']);
            return (&rest[..abs], body);
        }
        from = abs + 1;
    }
    ("", content)
}

/// Parse simple `key: value` lines (quotes stripped). Good enough for the flat
/// frontmatter skills use; not a full YAML parser.
fn parse_yaml_kv(yaml: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in yaml.lines() {
        if let Some(idx) = line.find(':') {
            let key = line[..idx].trim();
            let val = line[idx + 1..].trim().trim_matches('"');
            if !key.is_empty() && !val.is_empty() {
                out.insert(key.to_string(), val.to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn store() -> (tempfile::TempDir, SkillStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SkillStore::new(dir.path());
        (dir, store)
    }

    const SKILL: &str = "---\nname: greet\ndescription: Say hello nicely\nallowed-tools: web_search use_skill\n---\n# Greeting\nBe warm and concise.\n";

    #[test]
    fn frontmatter_and_body() {
        let meta = parse_skill(SKILL).unwrap();
        assert_eq!(meta.name, "greet");
        assert_eq!(meta.description, "Say hello nicely");
        assert_eq!(meta.allowed_tools, vec!["web_search", "use_skill"]);
        let (_, body) = split_frontmatter(SKILL);
        assert!(body.starts_with("# Greeting"));
        // no frontmatter → whole content is body
        assert_eq!(split_frontmatter("plain").1, "plain");
    }

    #[test]
    fn import_markdown_list_read() {
        let (_d, s) = store();
        let meta = s.import_markdown(SKILL).unwrap();
        assert_eq!(meta.name, "greet");
        assert_eq!(s.list().len(), 1);
        assert!(s.read_body("greet").unwrap().starts_with("# Greeting"));
        s.delete("greet").unwrap();
        assert!(s.list().is_empty());
    }

    #[test]
    fn import_zip_with_extra_file_and_wrapping_dir() {
        let (_d, s) = store();
        // zip with a single wrapping folder + an extra reference file.
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opt = zip::write::SimpleFileOptions::default();
            zw.start_file("greet/SKILL.md", opt).unwrap();
            zw.write_all(SKILL.as_bytes()).unwrap();
            zw.start_file("greet/reference.md", opt).unwrap();
            zw.write_all(b"extra notes").unwrap();
            zw.finish().unwrap();
        }
        let meta = s.import_zip(&buf).unwrap();
        assert_eq!(meta.name, "greet");
        assert_eq!(s.read_file("greet", "reference.md").unwrap(), "extra notes");
        // path traversal is refused
        assert!(s.read_file("greet", "../../secret").is_err());
    }

    #[test]
    fn zip_slip_entries_are_dropped() {
        assert!(sanitize_rel_path("../evil").is_none());
        assert!(sanitize_rel_path("/abs/path").is_some()); // leading slash stripped to relative
        assert_eq!(sanitize_rel_path("/abs/path").unwrap(), "abs/path");
        assert!(sanitize_rel_path("C:/x").is_none());
        assert!(sanitize_name("..").is_none());
        assert!(sanitize_name("a/b").is_none());
        assert!(sanitize_name(".hidden").is_none());
        assert_eq!(sanitize_name(" greet ").unwrap(), "greet");
    }
}
