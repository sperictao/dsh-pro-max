//! Internal secret resolution for Launcher-originated provider probes.
//! No function in this module is a Tauri command; secret values never cross IPC.

use serde_yaml::Value as Yaml;
use std::fs;
use std::path::{Path, PathBuf};

fn valid_ref(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn dsh_dir() -> Result<PathBuf, String> {
    Ok(crate::config::home_dir()?.join(".dsh"))
}

#[cfg(unix)]
fn assert_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 == 0 {
        Ok(())
    } else {
        Err(
            "Credentials file is readable beyond its owner; run chmod 600 before continuing"
                .to_string(),
        )
    }
}

#[cfg(not(unix))]
fn assert_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn file_value(path: &Path, name: &str) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    assert_owner_only(path)?;
    let text = fs::read_to_string(path)
        .map_err(|_| "Failed to read the credentials file".to_string())?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    let root: Yaml = serde_yaml::from_str(&text)
        .map_err(|_| "Failed to parse the credentials file".to_string())?;
    let map = root
        .as_mapping()
        .ok_or_else(|| "Credentials file must be a mapping".to_string())?;
    let version_key = Yaml::String("version".into());
    let version = map.get(&version_key);
    if version.is_none() {
        return Ok(map
            .get(Yaml::String(name.into()))
            .and_then(Yaml::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string));
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
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("export ") {
            line = rest.trim_start();
        }
        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key_matches = if cfg!(windows) {
            key.trim().eq_ignore_ascii_case(name)
        } else {
            key.trim() == name
        };
        if !key_matches {
            continue;
        }
        let value = raw_value.trim();
        let value = if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            &value[1..value.len() - 1]
        } else {
            value
        };
        return (!value.is_empty()).then(|| value.to_string());
    }
    None
}

fn resolve_from_sources(
    raw: &str,
    credentials: &Path,
    project_env: Option<&Path>,
    user_env: &Path,
) -> Result<Option<String>, String> {
    let name = raw.trim();
    if !valid_ref(name) {
        return Err(
            "Credential reference must be a POSIX-style environment variable name".to_string(),
        );
    }
    if let Ok(value) = std::env::var(name) {
        if !value.is_empty() {
            return Ok(Some(value));
        }
    }
    if let Some(value) = file_value(credentials, name)? {
        return Ok(Some(value));
    }
    if let Some(path) = project_env {
        if let Some(value) = dotenv_value(path, name) {
            return Ok(Some(value));
        }
    }
    if let Some(value) = dotenv_value(user_env, name) {
        return Ok(Some(value));
    }
    Ok(None)
}

pub(crate) fn resolve(raw: &str) -> Result<Option<String>, String> {
    let home = dsh_dir()?;
    let project_env = std::env::current_dir().ok().map(|cwd| cwd.join(".env"));
    resolve_from_sources(
        raw,
        &home.join(".credentials.yaml"),
        project_env.as_deref(),
        &home.join(".env"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "dsh-pro-max-resolver-{label}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn reads_versioned_managed_refs_without_exposing_other_values() {
        let dir = temp_dir("managed");
        let file = dir.join(".credentials.yaml");
        fs::write(
            &file,
            "version: 1\nrefs:\n  CUTOVER_TEST_KEY: secret-value\n",
        )
        .expect("seed credentials");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).expect("chmod");
        }
        assert_eq!(
            file_value(&file, "CUTOVER_TEST_KEY")
                .expect("read")
                .as_deref(),
            Some("secret-value")
        );
        assert_eq!(file_value(&file, "OTHER_KEY").expect("read"), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn managed_updates_reach_the_next_resolution_and_preserve_precedence() {
        let dir = temp_dir("lifecycle");
        let credentials = dir.join(".credentials.yaml");
        let project_env = dir.join("project.env");
        let user_env = dir.join("user.env");
        let name = "DSH_PRO_MAX_RESOLVER_LIFECYCLE_KEY";
        fs::write(&project_env, format!("{name}=project-secret\n")).expect("project env");
        fs::write(&user_env, format!("{name}=user-secret\n")).expect("user env");

        let write_managed = |value: &str| {
            fs::write(
                &credentials,
                format!("version: 1\nrefs:\n  {name}: {value}\n"),
            )
            .expect("managed credentials");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&credentials, fs::Permissions::from_mode(0o600))
                    .expect("chmod");
            }
        };

        write_managed("managed-one");
        assert_eq!(
            resolve_from_sources(name, &credentials, Some(&project_env), &user_env)
                .expect("first resolve")
                .as_deref(),
            Some("managed-one")
        );
        write_managed("managed-two");
        assert_eq!(
            resolve_from_sources(name, &credentials, Some(&project_env), &user_env)
                .expect("hot resolve")
                .as_deref(),
            Some("managed-two")
        );

        fs::remove_file(&credentials).expect("remove managed");
        assert_eq!(
            resolve_from_sources(name, &credentials, Some(&project_env), &user_env)
                .expect("project fallback")
                .as_deref(),
            Some("project-secret")
        );
        fs::remove_file(&project_env).expect("remove project env");
        assert_eq!(
            resolve_from_sources(name, &credentials, Some(&project_env), &user_env)
                .expect("user fallback")
                .as_deref(),
            Some("user-secret")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn dotenv_scan_skips_unrelated_non_assignment_lines() {
        let dir = temp_dir("dotenv");
        let file = dir.join(".env");
        fs::write(
            &file,
            "not an assignment\n# comment\nOTHER=value\nTARGET_KEY=secret-value\n",
        )
        .expect("seed dotenv");
        assert_eq!(dotenv_value(&file, "TARGET_KEY").as_deref(), Some("secret-value"));
        let _ = fs::remove_dir_all(dir);
    }
}
