//! Internal secret resolution for Launcher-originated provider probes.
//! No function in this module is a Tauri command; secret values never cross IPC.

use serde_yaml::Value as Yaml;
use std::fs;
use std::path::{Path, PathBuf};

fn valid_ref(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else { return false };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn dsh_dir() -> Result<PathBuf, String> {
    Ok(crate::config::home_dir()?.join(".dsh"))
}

#[cfg(unix)]
fn assert_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let Ok(metadata) = fs::metadata(path) else { return Ok(()) };
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 == 0 { Ok(()) } else {
        Err("Credentials file is readable beyond its owner; run chmod 600 before continuing".to_string())
    }
}
#[cfg(not(unix))]
fn assert_owner_only(_path: &Path) -> Result<(), String> { Ok(()) }

fn file_value(path: &Path, name: &str) -> Result<Option<String>, String> {
    if !path.exists() { return Ok(None) }
    assert_owner_only(path)?;
    let text = fs::read_to_string(path).map_err(|_| "Failed to read the credentials file".to_string())?;
    if text.trim().is_empty() { return Ok(None) }
    let root: Yaml = serde_yaml::from_str(&text).map_err(|_| "Failed to parse the credentials file".to_string())?;
    let map = root.as_mapping().ok_or_else(|| "Credentials file must be a mapping".to_string())?;
    let version = map.get(Yaml::String("version".into()));
    if version.is_none() {
        return Ok(map.get(Yaml::String(name.into())).and_then(Yaml::as_str).filter(|v| !v.is_empty()).map(str::to_string));
    }
    if version.and_then(Yaml::as_i64) != Some(1) {
        return Err("Credentials file declares an unsupported version".to_string());
    }
    Ok(map
        .get(Yaml::String("refs".into()))
        .and_then(Yaml::as_mapping)
        .and_then(|refs| refs.get(Yaml::String(name.into())))
        .and_then(Yaml::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string))
}

fn dotenv_value(path: &Path, name: &str) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    for raw in text.lines() {
        let mut line = raw.trim();
        if line.is_empty() || line.starts_with('#') { continue }
        if let Some(rest) = line.strip_prefix("export ") { line = rest.trim_start() }
        let (key, raw_value) = line.split_once('=')?;
        let key_matches = if cfg!(windows) { key.trim().eq_ignore_ascii_case(name) } else { key.trim() == name };
        if !key_matches { continue }
        let value = raw_value.trim();
        let value = if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')))
        { &value[1..value.len() - 1] } else { value };
        return (!value.is_empty()).then(|| value.to_string());
    }
    None
}

pub(crate) fn resolve(raw: &str) -> Result<Option<String>, String> {
    let name = raw.trim();
    if !valid_ref(name) { return Err("Credential reference must be a POSIX-style environment variable name".to_string()) }
    if let Ok(value) = std::env::var(name) {
        if !value.is_empty() { return Ok(Some(value)) }
    }
    let home = dsh_dir()?;
    if let Some(value) = file_value(&home.join(".credentials.yaml"), name)? { return Ok(Some(value)) }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(value) = dotenv_value(&cwd.join(".env"), name) { return Ok(Some(value)) }
    }
    if let Some(value) = dotenv_value(&home.join(".env"), name) { return Ok(Some(value)) }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_versioned_managed_refs_without_exposing_other_values() {
        let dir = std::env::temp_dir().join(format!("dsh-pro-max-resolver-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".credentials.yaml");
        fs::write(&file, "version: 1\nrefs:\n  CUTOVER_TEST_KEY: secret-value\n").unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(file_value(&file, "CUTOVER_TEST_KEY").unwrap().as_deref(), Some("secret-value"));
        assert_eq!(file_value(&file, "OTHER_KEY").unwrap(), None);
        let _ = fs::remove_dir_all(dir);
    }
}
