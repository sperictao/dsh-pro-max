//! DSH 凭据桥：对齐 dsh 0.1.5-alpha.1 的 `ctx.credentials` 语义。
//!
//! `apiKeyEnv` 只是 CredentialRef（POSIX 环境变量形状的引用名），secret 不进入
//! settings.yaml。dsh web 运行时优先调用其官方 credentials/describe|set|unset RPC，
//! 由 dsh 自己处理 precedence、writer lock、热更新事件；dsh 未运行时才直接读写
//! `$DSH_HOME/.credentials.yaml`，并复用 dsh 的 `<file>.lock` 协议，保证与下一次
//! dsh 启动/其他 writer 不会发生 read-modify-write 覆盖。

use super::components::dsh_dir;
use super::process::port_listening;
use super::WEB_PORT;
use crate::i18n::keyf;
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_yaml::{Mapping, Value as Yaml};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CREDENTIALS_FILENAME: &str = ".credentials.yaml";
const DOCUMENT_VERSION: i64 = 1;
const LOCK_WAIT_MS: u64 = 2_000;
const LOCK_RETRY_INITIAL_MS: u64 = 20;
const LOCK_RETRY_MAX_MS: u64 = 200;
const RPC_TIMEOUT_SECS: u64 = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct ModelCredentialInfo {
    /// 当前按 DSH precedence 解析是否能得到非空值。
    pub configured: bool,
    /// env | file | project-env | user-env；未配置时为 null。
    #[serde(default)]
    pub source: Option<String>,
    /// inherited process env 是只读，其余层可由 managed file 覆盖。
    pub writable: bool,
}

fn credentials_path() -> Result<PathBuf, String> {
    Ok(dsh_dir()?.join(CREDENTIALS_FILENAME))
}

fn valid_credential_ref(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn checked_ref(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if valid_credential_ref(name) {
        Ok(name.to_string())
    } else {
        Err("Credential reference must be a POSIX-style environment variable name".to_string())
    }
}

fn non_empty_process_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn mapping_key(name: &str) -> Yaml {
    Yaml::String(name.to_string())
}

fn document_from_text(text: &str, filename: &Path) -> Result<Mapping, String> {
    if text.trim().is_empty() {
        return Ok(Mapping::new());
    }
    let root: Yaml = serde_yaml::from_str(text).map_err(|error| {
        crate::logging::warn("解析 credentials 文件失败", &error.to_string());
        keyf("Failed to parse the credentials file", &[])
    })?;
    let mut root = root.as_mapping().cloned().ok_or_else(|| {
        format!("Credentials file {} must be a mapping", filename.display())
    })?;

    // dsh 0.1.5-alpha.1 仍接受并在启动时迁移预发布 flat layout：
    // `OPENAI_API_KEY: sk-...` -> `version: 1 / refs:`。离线写入同样接受，
    // 下一次提交直接渲染成正式 v1，避免 Launcher 制造与 dsh 不同的兼容边界。
    if !root.contains_key(mapping_key("version")) && !root.is_empty() {
        let mut refs = Mapping::new();
        let flat = root.clone();
        for (key, value) in flat {
            let Some(name) = key.as_str() else {
                return Err("Credentials file uses an unsupported unversioned layout".to_string());
            };
            let Some(secret) = value.as_str() else {
                return Err("Credentials file uses an unsupported unversioned layout".to_string());
            };
            if !valid_credential_ref(name) || secret.is_empty() {
                return Err("Credentials file uses an unsupported unversioned layout".to_string());
            }
            refs.insert(Yaml::String(name.to_string()), Yaml::String(secret.to_string()));
        }
        root = Mapping::new();
        root.insert(mapping_key("version"), Yaml::Number(DOCUMENT_VERSION.into()));
        root.insert(mapping_key("refs"), Yaml::Mapping(refs));
        return Ok(root);
    }

    if root.is_empty() {
        return Ok(root);
    }

    let version = root
        .get(mapping_key("version"))
        .and_then(Yaml::as_i64)
        .ok_or_else(|| "Credentials file is missing a numeric version".to_string())?;
    if version != DOCUMENT_VERSION {
        return Err(format!(
            "Credentials file declares unsupported version {version}; expected {DOCUMENT_VERSION}"
        ));
    }
    for key in root.keys() {
        let Some(name) = key.as_str() else {
            return Err("Credentials file contains a non-string top-level key".to_string());
        };
        if !matches!(name, "version" | "refs" | "records") {
            return Err(format!("Credentials file contains unknown top-level key \"{name}\""));
        }
    }
    validate_refs(root.get(mapping_key("refs")))?;
    if let Some(records) = root.get(mapping_key("records")) {
        if !records.is_null() && records.as_mapping().is_none() {
            return Err("Credentials file records section must be a mapping".to_string());
        }
    }
    Ok(root)
}

fn validate_refs(value: Option<&Yaml>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    let refs = value
        .as_mapping()
        .ok_or_else(|| "Credentials file refs section must be a mapping".to_string())?;
    for (key, value) in refs {
        let name = key
            .as_str()
            .ok_or_else(|| "Credential reference names must be strings".to_string())?;
        if !valid_credential_ref(name) {
            return Err(format!("Credential reference \"{name}\" is invalid"));
        }
        let secret = value
            .as_str()
            .ok_or_else(|| format!("Credential \"{name}\" must contain a string value"))?;
        if secret.is_empty() {
            return Err(format!("Credential \"{name}\" is empty; remove it instead"));
        }
    }
    Ok(())
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
        Err(format!(
            "Credentials file {} is readable beyond its owner (mode {:o}); run chmod 600 before continuing",
            path.display(),
            mode
        ))
    }
}

#[cfg(not(unix))]
fn assert_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn load_document(path: &Path) -> Result<Mapping, String> {
    if !path.exists() {
        return Ok(Mapping::new());
    }
    assert_owner_only(path)?;
    let text = fs::read_to_string(path).map_err(|error| {
        crate::logging::warn("读取 credentials 文件失败", &error.to_string());
        keyf("Failed to read the credentials file", &[])
    })?;
    document_from_text(&text, path)
}

fn file_ref_value(path: &Path, name: &str) -> Result<Option<String>, String> {
    let root = load_document(path)?;
    Ok(root
        .get(mapping_key("refs"))
        .and_then(Yaml::as_mapping)
        .and_then(|refs| refs.get(mapping_key(name)))
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

fn offline_describe_one(name: &str, path: &Path) -> Result<ModelCredentialInfo, String> {
    if non_empty_process_env(name).is_some() {
        return Ok(ModelCredentialInfo {
            configured: true,
            source: Some("env".to_string()),
            writable: false,
        });
    }
    if file_ref_value(path, name)?.is_some() {
        return Ok(ModelCredentialInfo {
            configured: true,
            source: Some("file".to_string()),
            writable: true,
        });
    }
    if let Ok(cwd) = std::env::current_dir() {
        if dotenv_value(&cwd.join(".env"), name).is_some() {
            return Ok(ModelCredentialInfo {
                configured: true,
                source: Some("project-env".to_string()),
                writable: true,
            });
        }
    }
    if let Some(parent) = path.parent() {
        if dotenv_value(&parent.join(".env"), name).is_some() {
            return Ok(ModelCredentialInfo {
                configured: true,
                source: Some("user-env".to_string()),
                writable: true,
            });
        }
    }
    Ok(ModelCredentialInfo {
        configured: false,
        source: None,
        writable: true,
    })
}

fn private_create_dir_all(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        return builder.create(path).map_err(|error| error.to_string());
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path).map_err(|error| error.to_string())
    }
}

fn private_open_new(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

struct CredentialLock {
    path: PathBuf,
}

impl Drop for CredentialLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn acquire_writer_lock(path: &Path) -> Result<CredentialLock, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Credentials file has no parent directory".to_string())?;
    private_create_dir_all(parent)?;
    let lock_path = PathBuf::from(format!("{}.lock", path.display()));
    let deadline = Instant::now() + Duration::from_millis(LOCK_WAIT_MS);
    let mut delay = LOCK_RETRY_INITIAL_MS;
    loop {
        match private_open_new(&lock_path) {
            Ok(mut file) => {
                file.write_all(format!("{}\n", std::process::id()).as_bytes())
                    .map_err(|error| error.to_string())?;
                let _ = file.sync_all();
                return Ok(CredentialLock { path: lock_path });
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    || (error.kind() == std::io::ErrorKind::PermissionDenied
                        && lock_path.exists()) =>
            {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "Timed out waiting for the credentials writer lock at {}",
                        lock_path.display()
                    ));
                }
                thread::sleep(Duration::from_millis(delay));
                delay = (delay * 2).min(LOCK_RETRY_MAX_MS);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn temp_sibling(path: &Path, attempt: u32) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    PathBuf::from(format!(
        "{}.{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        stamp,
        attempt
    ))
}

#[cfg(windows)]
fn replace_file(temp: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|error| error.to_string())
    }
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, target: &Path) -> Result<(), String> {
    fs::rename(temp, target).map_err(|error| error.to_string())
}

fn write_private_atomic(path: &Path, text: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Credentials file has no parent directory".to_string())?;
    private_create_dir_all(parent)?;
    let mut last_error = None;
    for attempt in 0..8 {
        let temp = temp_sibling(path, attempt);
        match private_open_new(&temp) {
            Ok(mut file) => {
                let result = (|| {
                    file.write_all(text.as_bytes()).map_err(|error| error.to_string())?;
                    file.sync_all().map_err(|error| error.to_string())?;
                    drop(file);
                    replace_file(&temp, path)
                })();
                if result.is_err() {
                    let _ = fs::remove_file(&temp);
                }
                return result;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_error = Some(error.to_string());
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(last_error.unwrap_or_else(|| "Cannot allocate an atomic credentials temp file".to_string()))
}

fn mutate_credential_ref_at(path: &Path, name: &str, value: Option<&str>) -> Result<(), String> {
    if non_empty_process_env(name).is_some() {
        return Err(format!(
            "Credential {name} is supplied by the launch environment and is read-only; update the environment and restart DSH"
        ));
    }
    if value == Some("") {
        return Err("Credential value cannot be empty; remove the credential instead".to_string());
    }
    let _lock = acquire_writer_lock(path)?;
    let mut root = load_document(path)?;
    if root.is_empty() {
        root.insert(mapping_key("version"), Yaml::Number(DOCUMENT_VERSION.into()));
    }
    let refs_key = mapping_key("refs");
    let mut refs = root
        .remove(&refs_key)
        .and_then(|value| value.as_mapping().cloned())
        .unwrap_or_default();
    match value {
        Some(secret) => {
            refs.insert(mapping_key(name), Yaml::String(secret.to_string()));
        }
        None => {
            refs.remove(mapping_key(name));
        }
    }
    if !refs.is_empty() {
        root.insert(refs_key, Yaml::Mapping(refs));
    }
    let text = serde_yaml::to_string(&Yaml::Mapping(root)).map_err(|error| {
        crate::logging::error("序列化 credentials 文件失败", &error.to_string());
        keyf("Failed to serialize the credentials file", &[])
    })?;
    write_private_atomic(path, &text)
}

fn rpc_call(method: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(RPC_TIMEOUT_SECS))
        .build()
        .map_err(|_| keyf("Cannot initialize the HTTP client", &[]))?;
    let url = format!("http://127.0.0.1:{WEB_PORT}/api/{method}");
    let response = client
        .post(&url)
        .json(&json!({
            "type": "client-request",
            "rpcId": "dsh-pro-max-credentials",
            "method": method,
            "payload": { "args": args }
        }))
        .send()
        .map_err(|_| "Cannot reach the running DSH credential service".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Running DSH rejected the credential request (HTTP {})",
            response.status().as_u16()
        ));
    }
    let body: serde_json::Value = response
        .json()
        .map_err(|_| "Running DSH returned an invalid credential response".to_string())?;
    let result = body
        .get("result")
        .ok_or_else(|| "Running DSH returned an invalid credential response".to_string())?;
    if result.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(result.get("value").cloned().unwrap_or(serde_json::Value::Null));
    }
    let message = result
        .pointer("/error/message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Running DSH rejected the credential request");
    Err(message.to_string())
}

fn rpc_describe(names: &[String]) -> Result<BTreeMap<String, ModelCredentialInfo>, String> {
    let value = rpc_call("credentials/describe", json!({ "refs": names }))?;
    serde_json::from_value(value)
        .map_err(|_| "Running DSH returned an invalid credential description".to_string())
}

fn rpc_set(name: &str, value: &str) -> Result<(), String> {
    rpc_call("credentials/set", json!({ "ref": name, "value": value })).map(|_| ())
}

fn rpc_unset(name: &str) -> Result<(), String> {
    rpc_call("credentials/unset", json!({ "ref": name })).map(|_| ())
}

fn describe_many(names: Vec<String>) -> Result<BTreeMap<String, ModelCredentialInfo>, String> {
    let names = names
        .into_iter()
        .map(|name| checked_ref(&name))
        .collect::<Result<Vec<_>, _>>()?;
    if names.is_empty() {
        return Ok(BTreeMap::new());
    }
    if port_listening(WEB_PORT) {
        return rpc_describe(&names);
    }
    let path = credentials_path()?;
    names
        .into_iter()
        .map(|name| Ok((name.clone(), offline_describe_one(&name, &path)?)))
        .collect()
}

fn set_one(name: String, value: String) -> Result<ModelCredentialInfo, String> {
    let name = checked_ref(&name)?;
    if value.is_empty() {
        return Err("Credential value cannot be empty".to_string());
    }
    if port_listening(WEB_PORT) {
        rpc_set(&name, &value)?;
        return rpc_describe(&[name.clone()])?
            .remove(&name)
            .ok_or_else(|| "Running DSH did not describe the stored credential".to_string());
    }
    let path = credentials_path()?;
    mutate_credential_ref_at(&path, &name, Some(&value))?;
    offline_describe_one(&name, &path)
}

fn unset_one(name: String) -> Result<ModelCredentialInfo, String> {
    let name = checked_ref(&name)?;
    if port_listening(WEB_PORT) {
        rpc_unset(&name)?;
        return rpc_describe(&[name.clone()])?
            .remove(&name)
            .ok_or_else(|| "Running DSH did not describe the removed credential".to_string());
    }
    let path = credentials_path()?;
    mutate_credential_ref_at(&path, &name, None)?;
    offline_describe_one(&name, &path)
}

#[tauri::command]
pub async fn model_credential_describe(
    names: Vec<String>,
) -> Result<BTreeMap<String, ModelCredentialInfo>, String> {
    super::ipc_blocking(move || describe_many(names)).await
}

#[tauri::command]
pub async fn model_credential_set(
    name: String,
    value: String,
) -> Result<ModelCredentialInfo, String> {
    super::ipc_blocking(move || set_one(name, value)).await
}

#[tauri::command]
pub async fn model_credential_unset(name: String) -> Result<ModelCredentialInfo, String> {
    super::ipc_blocking(move || unset_one(name)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "dsh-pro-max-{label}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temp dir");
        path
    }

    #[test]
    fn validates_same_reference_shape_as_dsh() {
        for valid in ["OPENAI_API_KEY", "_PRIVATE", "A1"] {
            assert!(valid_credential_ref(valid), "{valid}");
        }
        for invalid in ["", "1KEY", "bad-key", "HAS SPACE"] {
            assert!(!valid_credential_ref(invalid), "{invalid}");
        }
    }

    #[test]
    fn migrates_flat_layout_and_preserves_records_when_setting_ref() {
        let dir = temp_dir("credentials-set");
        let path = dir.join(CREDENTIALS_FILENAME);
        fs::write(
            &path,
            "version: 1\nrefs:\n  OLD_KEY: old\nrecords:\n  llm-pi-ai/openai-codex:\n    kind: grant\n    payload:\n      token: keep-me\n",
        )
        .expect("seed");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod");
        }
        mutate_credential_ref_at(&path, "NEW_KEY", Some("new-secret")).expect("set");
        let root = load_document(&path).expect("read");
        let refs = root
            .get(mapping_key("refs"))
            .and_then(Yaml::as_mapping)
            .expect("refs");
        assert_eq!(refs.get(mapping_key("OLD_KEY")).and_then(Yaml::as_str), Some("old"));
        assert_eq!(
            refs.get(mapping_key("NEW_KEY")).and_then(Yaml::as_str),
            Some("new-secret")
        );
        assert_eq!(
            root.get(mapping_key("records"))
                .and_then(|records| records.get("llm-pi-ai/openai-codex"))
                .and_then(|record| record.get("payload"))
                .and_then(|payload| payload.get("token"))
                .and_then(Yaml::as_str),
            Some("keep-me")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn unsetting_ref_keeps_document_valid_and_idempotent() {
        let dir = temp_dir("credentials-unset");
        let path = dir.join(CREDENTIALS_FILENAME);
        mutate_credential_ref_at(&path, "API_KEY", Some("secret")).expect("set");
        mutate_credential_ref_at(&path, "API_KEY", None).expect("unset");
        mutate_credential_ref_at(&path, "API_KEY", None).expect("unset again");
        assert_eq!(file_ref_value(&path, "API_KEY").expect("read"), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn flat_pre_release_document_is_accepted_and_upgraded_on_write() {
        let dir = temp_dir("credentials-flat");
        let path = dir.join(CREDENTIALS_FILENAME);
        fs::write(&path, "OPENAI_API_KEY: old\n").expect("seed");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod");
        }
        mutate_credential_ref_at(&path, "ANTHROPIC_API_KEY", Some("new")).expect("upgrade");
        let root = load_document(&path).expect("read");
        assert_eq!(
            root.get(mapping_key("version")).and_then(Yaml::as_i64),
            Some(DOCUMENT_VERSION)
        );
        assert_eq!(file_ref_value(&path, "OPENAI_API_KEY").expect("old"), Some("old".into()));
        assert_eq!(
            file_ref_value(&path, "ANTHROPIC_API_KEY").expect("new"),
            Some("new".into())
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_unknown_document_shape_instead_of_overwriting_it() {
        let error = document_from_text("version: 1\nother: secret\n", Path::new("credentials.yaml"))
            .expect_err("must reject");
        assert!(error.contains("unknown top-level key"));
    }

    #[cfg(unix)]
    #[test]
    fn managed_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("credentials-mode");
        let path = dir.join(CREDENTIALS_FILENAME);
        mutate_credential_ref_at(&path, "API_KEY", Some("secret")).expect("set");
        let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = fs::remove_dir_all(dir);
    }
}
