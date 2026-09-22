//! DSH 模型凭据桥：对齐 dsh `ctx.credentials` 语义（0.1.7 实测同一份 v1 文件与
//! 0600 属主门槛）。
//!
//! `apiKeyEnv` 只是 CredentialRef（POSIX 环境变量形状的引用名），secret 不进入
//! profile 补丁。dsh web 运行时优先调用官方 credentials/describe|set|unset RPC，
//! 由 dsh 自己处理 precedence、writer lock 与热更新；dsh 未运行时才直接读写
//! `~/.dsh/.credentials.yaml`，并复用 dsh 的 `<file>.lock` writer 协议。
//!
//! 无授权插件的 web（本地模式不依赖授权插件、Windows 等原生 token 环境）对
//! `/api` 一律要会话 cookie，裸请求 401：凭据 RPC 因此经 `dsh::session` 用原生
//! launch token 换一次本机会话 cookie，被拒再重试一次（见 rpc_with_native_auth）。

use crate::dsh::{
    cached_session_cookie, invalidate_session_cookie, session_cookie, LOOPBACK_HTTP_TIMEOUT_SECS,
};
use crate::i18n::Message;
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_yaml::{Mapping, Value as Yaml};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WEB_PORT: u16 = 3899;
const CREDENTIALS_FILENAME: &str = ".credentials.yaml";
const DOCUMENT_VERSION: i64 = 1;
/// 凭据文档的跨进程写锁等待预算。**必须跟 `dsh-credentials-local` 的
/// `DOCUMENT_LOCK_WAIT_MS`（30s），而不是 `dsh-atomic-write` 的通用默认
/// `DEFAULT_LOCK_WAIT_MS`（2s）**：同一把 `.credentials.yaml.lock`，宿主为
/// 「持锁期间还要跑调用方决策」的记录写入显式放宽到 30s，Launcher 沿用通用
/// 默认会在 dsh 正在启动或写记录时把自己的写入误判成超时。重试节奏
/// （20ms 起步、×2、200ms 封顶）与宿主逐字一致，无需另设
const LOCK_WAIT_MS: u64 = 30_000;
const LOCK_RETRY_INITIAL_MS: u64 = 20;
const LOCK_RETRY_MAX_MS: u64 = 200;

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

fn dsh_dir() -> Result<PathBuf, Message> {
    Ok(crate::config::home_dir()?.join(".dsh"))
}

fn credentials_path() -> Result<PathBuf, Message> {
    Ok(dsh_dir()?.join(CREDENTIALS_FILENAME))
}

fn port_listening(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        Duration::from_millis(300),
    )
    .is_ok()
}

fn valid_credential_ref(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn checked_ref(raw: &str) -> Result<String, Message> {
    let name = raw.trim();
    if valid_credential_ref(name) {
        Ok(name.to_string())
    } else {
        Err(Message::key("Credential reference must be a POSIX-style environment variable name"))
    }
}

fn non_empty_process_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn mapping_key(name: &str) -> Yaml {
    Yaml::String(name.to_string())
}

fn document_from_text(text: &str, filename: &Path) -> Result<Mapping, Message> {
    if text.trim().is_empty() {
        return Ok(Mapping::new());
    }
    let root: Yaml = serde_yaml::from_str(text).map_err(|error| {
        crate::logging::warn("解析 credentials 文件失败", &error.to_string());
        Message::key("Failed to parse the credentials file")
    })?;
    let mut root = root
        .as_mapping()
        .cloned()
        .ok_or_else(|| format!("Credentials file {} must be a mapping", filename.display()))?;

    // dsh（0.1.6 与 0.1.7 同）在启动时直接拒收预发布 flat layout 并拒绝启动，
    // 报错要求补上 `version: 1` 并把条目嵌到 `refs:` 下。这里仍按扁平形态读入以便
    // 迁移存量文件，但落盘一律是 v1（下一条分支）。
    if !root.contains_key(mapping_key("version")) && !root.is_empty() {
        let mut refs = Mapping::new();
        for (key, value) in root.clone() {
            let Some(name) = key.as_str() else {
                return Err(Message::key("Credentials file uses an unsupported unversioned layout"));
            };
            let Some(secret) = value.as_str() else {
                return Err(Message::key("Credentials file uses an unsupported unversioned layout"));
            };
            if !valid_credential_ref(name) || secret.is_empty() {
                return Err(Message::key("Credentials file uses an unsupported unversioned layout"));
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
        .ok_or_else(|| Message::key("Credentials file is missing a numeric version"))?;
    if version != DOCUMENT_VERSION {
        return Err(Message::localized(
            "Credentials file declares unsupported version {{version}}; expected {{expected}}",
            &[
                ("version", version.to_string()),
                ("expected", DOCUMENT_VERSION.to_string()),
            ],
        ));
    }
    for key in root.keys() {
        let Some(name) = key.as_str() else {
            return Err(Message::key("Credentials file contains a non-string top-level key"));
        };
        if !matches!(name, "version" | "refs" | "records") {
            return Err(Message::localized(
                "Credentials file contains unknown top-level key \"{{name}}\"",
                &[("name", name.to_string())],
            ));
        }
    }
    validate_refs(root.get(mapping_key("refs")))?;
    if let Some(records) = root.get(mapping_key("records")) {
        if !records.is_null() && records.as_mapping().is_none() {
            return Err(Message::key("Credentials file records section must be a mapping"));
        }
    }
    Ok(root)
}

fn validate_refs(value: Option<&Yaml>) -> Result<(), Message> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    let refs = value
        .as_mapping()
        .ok_or_else(|| Message::key("Credentials file refs section must be a mapping"))?;
    for (key, value) in refs {
        let name = key
            .as_str()
            .ok_or_else(|| Message::key("Credential reference names must be strings"))?;
        if !valid_credential_ref(name) {
            return Err(Message::localized(
                "Credential reference \"{{name}}\" is invalid",
                &[("name", name.to_string())],
            ));
        }
        let secret = value.as_str().ok_or_else(|| {
            Message::localized(
                "Credential \"{{name}}\" must contain a string value",
                &[("name", name.to_string())],
            )
        })?;
        if secret.is_empty() {
            return Err(Message::localized(
                "Credential \"{{name}}\" is empty; remove it instead",
                &[("name", name.to_string())],
            ));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn assert_owner_only(path: &Path) -> Result<(), Message> {
    use std::os::unix::fs::PermissionsExt;
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 == 0 {
        Ok(())
    } else {
        Err(Message::localized(
            "Credentials file {{path}} is readable beyond its owner (mode {{mode}}); run chmod 600 before continuing",
            &[
                ("path", path.display().to_string()),
                ("mode", format!("{mode:o}")),
            ],
        ))
    }
}

#[cfg(not(unix))]
fn assert_owner_only(_path: &Path) -> Result<(), Message> {
    Ok(())
}

fn load_document(path: &Path) -> Result<Mapping, Message> {
    if !path.exists() {
        return Ok(Mapping::new());
    }
    assert_owner_only(path)?;
    let text = fs::read_to_string(path).map_err(|error| {
        crate::logging::warn("读取 credentials 文件失败", &error.to_string());
        Message::key("Failed to read the credentials file")
    })?;
    document_from_text(&text, path)
}

fn file_ref_value(path: &Path, name: &str) -> Result<Option<String>, Message> {
    let root = load_document(path)?;
    Ok(root
        .get(mapping_key("refs"))
        .and_then(Yaml::as_mapping)
        .and_then(|refs| refs.get(mapping_key(name)))
        .and_then(Yaml::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string))
}

// Offline describe 只需判断常见 dotenv 形态是否提供值；真正运行时由 DSH 自己的
// launch-environment snapshot 解析完整 dotenv 语义，因此 Launcher 不成为运行时真源。
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

fn offline_describe_one(name: &str, path: &Path) -> Result<ModelCredentialInfo, Message> {
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

#[cfg(unix)]
fn private_create_dir_all(path: &Path) -> Result<(), Message> {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder.create(path).map_err(|error| Message::key(error.to_string()))
}

#[cfg(not(unix))]
fn private_create_dir_all(path: &Path) -> Result<(), Message> {
    fs::create_dir_all(path).map_err(|error| Message::key(error.to_string()))
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

fn acquire_writer_lock(path: &Path) -> Result<CredentialLock, Message> {
    let parent = path
        .parent()
        .ok_or_else(|| Message::key("Credentials file has no parent directory"))?;
    private_create_dir_all(parent)?;
    let lock_path = PathBuf::from(format!("{}.lock", path.display()));
    let deadline = Instant::now() + Duration::from_millis(LOCK_WAIT_MS);
    let mut delay = LOCK_RETRY_INITIAL_MS;
    loop {
        match private_open_new(&lock_path) {
            Ok(mut file) => {
                file.write_all(format!("{}\n", std::process::id()).as_bytes())
                    .map_err(|error| Message::key(error.to_string()))?;
                let _ = file.sync_all();
                return Ok(CredentialLock { path: lock_path });
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    || (error.kind() == std::io::ErrorKind::PermissionDenied
                        && lock_path.exists()) =>
            {
                if Instant::now() >= deadline {
                    return Err(Message::localized(
                        "Timed out waiting for the credentials writer lock at {{path}}",
                        &[("path", lock_path.display().to_string())],
                    ));
                }
                thread::sleep(Duration::from_millis(delay));
                delay = (delay * 2).min(LOCK_RETRY_MAX_MS);
            }
            Err(error) => return Err(Message::key(error.to_string())),
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
fn replace_file(temp: &Path, target: &Path) -> Result<(), Message> {
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
        .map_err(|error| Message::key(error.to_string()))
    }
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, target: &Path) -> Result<(), Message> {
    fs::rename(temp, target).map_err(|error| Message::key(error.to_string()))
}

fn write_private_atomic(path: &Path, text: &str) -> Result<(), Message> {
    let parent = path
        .parent()
        .ok_or_else(|| Message::key("Credentials file has no parent directory"))?;
    private_create_dir_all(parent)?;
    let mut last_error = None;
    for attempt in 0..8 {
        let temp = temp_sibling(path, attempt);
        match private_open_new(&temp) {
            Ok(mut file) => {
                let result = (|| {
                    file.write_all(text.as_bytes())
                        .map_err(|error| Message::key(error.to_string()))?;
                    file.sync_all()
                        .map_err(|error| Message::key(error.to_string()))?;
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
            Err(error) => return Err(Message::key(error.to_string())),
        }
    }
    Err(Message::key(
        last_error.unwrap_or_else(|| "Cannot allocate an atomic credentials temp file".to_string()),
    ))
}

fn mutate_credential_ref_at(path: &Path, name: &str, value: Option<&str>) -> Result<(), Message> {
    if non_empty_process_env(name).is_some() {
        return Err(Message::localized(
            "Credential {{name}} is supplied by the launch environment and is read-only; update the environment and restart DSH",
            &[("name", name.to_string())],
        ));
    }
    if value == Some("") {
        return Err(Message::key("Credential value cannot be empty; remove the credential instead"));
    }

    let _lock = acquire_writer_lock(path)?;
    let mut root = load_document(path)?;
    let refs_key = mapping_key("refs");
    let mut refs = root
        .remove(&refs_key)
        .and_then(|entry| entry.as_mapping().cloned())
        .unwrap_or_default();

    if value.is_none() && !refs.contains_key(mapping_key(name)) {
        return Ok(());
    }
    if root.is_empty() {
        root.insert(mapping_key("version"), Yaml::Number(DOCUMENT_VERSION.into()));
    }
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
        Message::key("Failed to serialize the credentials file")
    })?;
    write_private_atomic(path, &text)
}

fn rpc_call(port: u16, method: &str, args: serde_json::Value) -> Result<serde_json::Value, Message> {
    rpc_with_native_auth(
        cached_session_cookie(),
        |cookie| rpc_post(port, method, &args, cookie),
        || {
            // 被拒说明缓存里的 cookie 已经不作数（web 换了实例或轮换了签名
            // 密钥）：先作废，再按当前 launch token 重取一次（mint 契约）
            invalidate_session_cookie();
            session_cookie(port)
        },
        invalidate_session_cookie,
    )
}

/// 一次特权 RPC 的回答。401 不是普通失败，而是「dsh 要求本机会话」的信号：
/// 决策核据此换一次会话 cookie 再试，其余错误原样上抛
#[derive(Debug)]
enum RpcError {
    Unauthorized,
    Failed(Message),
}

/// 特权 RPC 的本机会话编排（决策核）：先用手上已有的 cookie 发一次；被 dsh
/// 以 401 拒绝时换一次会话 cookie 再试；换来或重试后仍 401 就把原因与下一步
/// 摆给用户、并作废已经不作数的缓存，绝不无限重试。
/// post / mint / forget 是注入口，薄壳接真实 IO；mint 的契约是「绕开并作废
/// 缓存后重取」，forget 只用于重试仍被拒的那次清理
fn rpc_with_native_auth(
    initial: Option<String>,
    mut post: impl FnMut(Option<&str>) -> Result<serde_json::Value, RpcError>,
    mut mint: impl FnMut() -> Option<String>,
    mut forget: impl FnMut(),
) -> Result<serde_json::Value, Message> {
    match post(initial.as_deref()) {
        Ok(value) => Ok(value),
        Err(RpcError::Failed(message)) => Err(message),
        Err(RpcError::Unauthorized) => match mint() {
            Some(cookie) => match post(Some(&cookie)) {
                Ok(value) => Ok(value),
                Err(RpcError::Failed(message)) => Err(message),
                Err(RpcError::Unauthorized) => {
                    forget();
                    Err(local_session_missing())
                }
            },
            None => Err(local_session_missing()),
        },
    }
}

/// 401 且拿不到（或换不到）本机会话：说明原因并给出下一步，不让用户对着
/// dsh 的 401 页面猜。覆盖的实况：web 由外部手工启动、token 只落在终端，
/// 日志里没有可换的本机 launch token
fn local_session_missing() -> Message {
    Message::key("Running DSH rejected the credential request (HTTP 401) and DSH Pro Max could not obtain the local dsh session credential; start dsh web again from DSH Pro Max, then retry")
}

fn rpc_post(
    port: u16,
    method: &str,
    args: &serde_json::Value,
    cookie: Option<&str>,
) -> Result<serde_json::Value, RpcError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(LOOPBACK_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|_| RpcError::Failed(Message::key("Cannot initialize the HTTP client")))?;
    let url = format!("http://127.0.0.1:{port}/api/{method}");
    let mut request = client.post(&url).json(&json!({
        "type": "client-request",
        "rpcId": "dsh-pro-max-credentials",
        "method": method,
        "payload": { "args": args }
    }));
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let response = request
        .send()
        .map_err(|_| RpcError::Failed(Message::key("Cannot reach the running DSH credential service")))?;
    // 无授权插件的 web 以会话 cookie 鉴权（令牌交换见 dsh::session）：裸请求
    // 到 /api 一律 401，这里把它当「需要本机会话」的信号而不是终点
    if response.status().as_u16() == 401 {
        return Err(RpcError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(RpcError::Failed(Message::localized(
            "Running DSH rejected the credential request (HTTP {{status}})",
            &[("status", response.status().as_u16().to_string())],
        )));
    }
    let body: serde_json::Value = response
        .json()
        .map_err(|_| RpcError::Failed(Message::key("Running DSH returned an invalid credential response")))?;
    let result = body.get("result").ok_or_else(|| {
        RpcError::Failed(Message::key("Running DSH returned an invalid credential response"))
    })?;
    if result.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(result
            .get("value")
            .cloned()
            .unwrap_or(serde_json::Value::Null));
    }
    let message = result
        .pointer("/error/message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Running DSH rejected the credential request");
    // 文本来自运行中的 DSH（另一个进程的错误原文），无法本地化，整串当 key
    Err(RpcError::Failed(message.into()))
}

fn rpc_describe(port: u16, names: &[String]) -> Result<BTreeMap<String, ModelCredentialInfo>, Message> {
    let value = rpc_call(port, "credentials/describe", json!({ "refs": names }))?;
    serde_json::from_value(value)
        .map_err(|_| Message::key("Running DSH returned an invalid credential description"))
}

fn rpc_set(port: u16, name: &str, value: &str) -> Result<(), Message> {
    rpc_call(
        port,
        "credentials/set",
        json!({ "ref": name, "value": value }),
    )
    .map(|_| ())
}

fn rpc_unset(port: u16, name: &str) -> Result<(), Message> {
    rpc_call(port, "credentials/unset", json!({ "ref": name })).map(|_| ())
}

fn describe_many(
    port: u16,
    names: Vec<String>,
) -> Result<BTreeMap<String, ModelCredentialInfo>, Message> {
    let names = names
        .into_iter()
        .map(|name| checked_ref(&name))
        .collect::<Result<Vec<_>, _>>()?;
    if names.is_empty() {
        return Ok(BTreeMap::new());
    }
    if port_listening(port) {
        return rpc_describe(port, &names);
    }
    let path = credentials_path()?;
    names
        .into_iter()
        .map(|name| Ok((name.clone(), offline_describe_one(&name, &path)?)))
        .collect()
}

fn set_one(port: u16, name: String, value: String) -> Result<ModelCredentialInfo, Message> {
    let name = checked_ref(&name)?;
    if value.is_empty() {
        return Err(Message::key("Credential value cannot be empty"));
    }
    if port_listening(port) {
        rpc_set(port, &name, &value)?;
        return rpc_describe(port, std::slice::from_ref(&name))?
            .remove(&name)
            .ok_or_else(|| Message::key("Running DSH did not describe the stored credential"));
    }
    let path = credentials_path()?;
    mutate_credential_ref_at(&path, &name, Some(&value))?;
    offline_describe_one(&name, &path)
}

fn unset_one(port: u16, name: String) -> Result<ModelCredentialInfo, Message> {
    let name = checked_ref(&name)?;
    if port_listening(port) {
        rpc_unset(port, &name)?;
        return rpc_describe(port, std::slice::from_ref(&name))?
            .remove(&name)
            .ok_or_else(|| Message::key("Running DSH did not describe the removed credential"));
    }
    let path = credentials_path()?;
    mutate_credential_ref_at(&path, &name, None)?;
    offline_describe_one(&name, &path)
}

#[tauri::command]
pub async fn model_credential_describe(
    names: Vec<String>,
) -> Result<BTreeMap<String, ModelCredentialInfo>, Message> {
    crate::dsh::ipc_blocking(move || describe_many(WEB_PORT, names)).await
}

#[tauri::command]
pub async fn model_credential_set(
    name: String,
    value: String,
) -> Result<ModelCredentialInfo, Message> {
    crate::dsh::ipc_blocking(move || set_one(WEB_PORT, name, value)).await
}

#[tauri::command]
pub async fn model_credential_unset(name: String) -> Result<ModelCredentialInfo, Message> {
    crate::dsh::ipc_blocking(move || unset_one(WEB_PORT, name)).await
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
    fn rpc_prefers_the_cached_session_cookie() {
        let mut posts = Vec::new();
        let value = rpc_with_native_auth(
            Some("dsh-auth-x=v1".to_string()),
            |cookie| {
                posts.push(cookie.map(str::to_string));
                Ok(json!({ "configured": true }))
            },
            || panic!("a cached cookie that works must never be re-minted"),
            || panic!("a working cookie must never be forgotten"),
        )
        .expect("accepted");
        assert_eq!(value, json!({ "configured": true }));
        assert_eq!(posts, vec![Some("dsh-auth-x=v1".to_string())]);
    }

    #[test]
    fn rpc_mints_a_session_cookie_after_401_and_retries_once() {
        // 无授权插件的 web：裸请求 401 → 用 launch token 换 cookie → 重试成功
        let mut posts = Vec::new();
        let mut mints = 0;
        let value = rpc_with_native_auth(
            None,
            |cookie| {
                posts.push(cookie.map(str::to_string));
                match cookie {
                    None => Err(RpcError::Unauthorized),
                    Some(_) => Ok(json!({ "configured": true })),
                }
            },
            || {
                mints += 1;
                Some("dsh-auth-new=v1".to_string())
            },
            || panic!("a retry that succeeded must not forget the cookie"),
        )
        .expect("retry with the native session succeeds");
        assert_eq!(value, json!({ "configured": true }));
        assert_eq!(posts, vec![None, Some("dsh-auth-new=v1".to_string())]);
        assert_eq!(mints, 1);
    }

    #[test]
    fn rpc_does_not_loop_when_the_minted_cookie_is_rejected_too() {
        let mut posts = 0;
        let mut mints = 0;
        let mut forgotten = 0;
        let error = rpc_with_native_auth(
            None,
            |_| {
                posts += 1;
                Err(RpcError::Unauthorized)
            },
            || {
                mints += 1;
                Some("dsh-auth-stale=v1".to_string())
            },
            || forgotten += 1,
        )
        .expect_err("two 401s must surface as an error");
        assert_eq!(posts, 2);
        assert_eq!(mints, 1);
        // 重试也被拒：换来的 cookie 同样不作数，必须清掉，别让下一次调用
        // 先拿这颗死 cookie 白跑一轮
        assert_eq!(forgotten, 1);
        assert!(error.contains("HTTP 401"), "{error}");
    }

    #[test]
    fn rpc_reports_the_local_session_gap_without_a_launch_token() {
        let error = rpc_with_native_auth(
            None,
            |_| Err(RpcError::Unauthorized),
            || None,
            || panic!("nothing was minted, so nothing needs forgetting"),
        )
        .expect_err("no native token means no retry");
        assert!(error.contains("local dsh session credential"), "{error}");
        assert!(error.contains("start dsh web again from DSH Pro Max"), "{error}");
    }

    #[test]
    fn rpc_passes_other_failures_through_without_minting() {
        let error = rpc_with_native_auth(
            None,
            |_| {
                Err(RpcError::Failed(Message::localized(
                    "Running DSH rejected the credential request (HTTP {{status}})",
                    &[("status", "403".to_string())],
                )))
            },
            || panic!("only a 401 asks for the native session"),
            || panic!("a non-401 failure must not touch the session cache"),
        )
        .expect_err("403 stays a plain failure");
        assert!(error.contains("HTTP 403"), "{error}");
    }

    #[test]
    fn rpc_post_attaches_the_session_cookie_and_reads_the_envelope() {
        let body = r#"{"type":"server-response","rpcId":"dsh-pro-max-credentials","result":{"ok":true,"value":{"configured":true,"source":"file","writable":true}}}"#;
        let (port, request) = crate::test_http::one_shot(&format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        ));
        let value = rpc_post(
            port,
            "credentials/describe",
            &json!({ "refs": ["OPENAI_API_KEY"] }),
            Some("dsh-auth-sig=v1.body.sig"),
        )
        .expect("ok envelope");
        assert_eq!(
            value,
            json!({ "configured": true, "source": "file", "writable": true })
        );
        let request = request.recv().expect("request captured");
        assert!(
            request.starts_with("POST /api/credentials/describe HTTP/1.1\r\n"),
            "{request}"
        );
        let request_lower = request.to_ascii_lowercase();
        assert!(
            request_lower.contains("cookie: dsh-auth-sig=v1.body.sig"),
            "{request}"
        );
        assert!(
            request_lower.contains(r#""method":"credentials/describe""#),
            "{request}"
        );
    }

    #[test]
    fn rpc_post_maps_401_to_the_session_signal() {
        // dsh 浏览器鉴权门的真实回包：401 + text/plain "unauthorized"
        let (port, _request) = crate::test_http::one_shot(
            "HTTP/1.1 401 Unauthorized\r\ncontent-type: text/plain\r\ncontent-length: 12\r\nconnection: close\r\n\r\nunauthorized",
        );
        match rpc_post(port, "credentials/describe", &json!({ "refs": ["A"] }), None) {
            Err(RpcError::Unauthorized) => {}
            other => panic!("expected Unauthorized, got {other:?}"),
        }
    }

    #[test]
    fn rpc_post_reports_other_statuses_with_the_http_code() {
        let (port, _request) = crate::test_http::one_shot(
            "HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: 9\r\nconnection: close\r\n\r\nforbidden",
        );
        match rpc_post(port, "credentials/describe", &json!({ "refs": ["A"] }), None) {
            Err(RpcError::Failed(message)) => assert!(message.contains("HTTP 403"), "{message}"),
            other => panic!("expected a plain 403 failure, got {other:?}"),
        }
    }

    /// 真机链路回归（依赖本机真实进程，默认 ignore，只跑这一个用例）。适合在
    /// 「本地模式不装授权插件」的机器上手动跑，验证的是整条原生链路而不是打桩：
    ///
    /// 1. 用独立 DSH_HOME 起一个**无授权插件**的 dsh web（启动日志会打印
    ///    带 launch token 的地址）：
    ///    `DSH_HOME=/tmp/dsh-stock dsh web --port 3898 --no-open`
    /// 2. 让 Launcher 侧拿到同一个 token：HOME 指向临时目录（本测试会**覆盖**
    ///    `$HOME/.dsh/dsh-web.log`，故必须显式声明隔离）：
    ///    `HOME=/tmp/live-home DSH_PROBE_ISOLATED_HOME=1 DSH_PROBE_PORT=3898 \
    ///     DSH_PROBE_TOKEN=<token> cargo test live_native_session -- --ignored --nocapture`
    ///
    /// 断言：裸 RPC 401 → launch token 换会话 cookie → 重试成功 → 凭据由 dsh
    /// 自己落盘（`$DSH_HOME/.credentials.yaml`）→ unset 生效。
    /// 装了授权插件的实例（如本机 3899）同样可跑：loopback 直放、不需要 cookie，
    /// 用来确认这条修复没有改动插件在场时的行为
    #[ignore] // 需要本机跑着无授权插件的 dsh web，仅手动验证链路时跑
    #[test]
    fn live_native_session_authenticates_privileged_rpc() {
        let port: u16 = std::env::var("DSH_PROBE_PORT")
            .expect("set DSH_PROBE_PORT to a running stock dsh web port")
            .parse()
            .expect("DSH_PROBE_PORT must be a port number");
        let token = std::env::var("DSH_PROBE_TOKEN")
            .expect("set DSH_PROBE_TOKEN to that instance's launch token");
        // 隔离闸门：本测试要覆盖 $HOME/.dsh/dsh-web.log，误在真实 HOME 下跑会把
        // Launcher 交给浏览器的 token 行清掉。探针 HOME 由运行者显式声明
        assert!(
            std::env::var("DSH_PROBE_ISOLATED_HOME").is_ok(),
            "refusing to run: this test overwrites $HOME/.dsh/dsh-web.log; point HOME at a scratch directory and set DSH_PROBE_ISOLATED_HOME=1"
        );
        let log = dsh_dir().expect("dsh dir").join("dsh-web.log");
        fs::create_dir_all(log.parent().expect("parent")).expect("create .dsh");
        fs::write(
            &log,
            format!("dsh web: http://127.0.0.1:{port}/?token={token}\n"),
        )
        .expect("seed dsh-web.log");
        invalidate_session_cookie();

        let name = "DSH_PRO_MAX_LIVE_PROBE_KEY";
        let stored = set_one(port, name.to_string(), "live-probe-secret".to_string())
            .expect("set through the native session");
        assert!(stored.configured, "dsh must report the stored credential");
        let described = describe_many(port, vec![name.to_string()]).expect("describe");
        assert!(described[name].configured);
        let removed = unset_one(port, name.to_string()).expect("unset");
        assert!(!removed.configured);
        // 授权插件在场时 loopback 直放，全程不需要会话 cookie；插件不在场时
        // 每一步都靠换来的 cookie 才拿到 200——两种情况都由同一条链路覆盖
        println!(
            "live ok on port {port}: dsh stored and removed {name}; native session cookie {}",
            if cached_session_cookie().is_some() {
                "minted (launch token → 303 → cookie)"
            } else {
                "not needed (authz plugin allows loopback)"
            }
        );
    }

    #[test]
    fn setting_ref_preserves_other_refs_and_records() {
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
        assert_eq!(
            refs.get(mapping_key("OLD_KEY")).and_then(Yaml::as_str),
            Some("old")
        );
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
    fn unsetting_ref_is_idempotent() {
        let dir = temp_dir("credentials-unset");
        let path = dir.join(CREDENTIALS_FILENAME);
        mutate_credential_ref_at(&path, "API_KEY", Some("secret")).expect("set");
        mutate_credential_ref_at(&path, "API_KEY", None).expect("unset");
        mutate_credential_ref_at(&path, "API_KEY", None).expect("unset again");
        assert_eq!(file_ref_value(&path, "API_KEY").expect("read"), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn managed_credential_lifecycle_set_replace_and_unset() {
        let dir = temp_dir("credentials-lifecycle");
        let path = dir.join(CREDENTIALS_FILENAME);
        let name = "DSH_PRO_MAX_LIFECYCLE_KEY";

        let initial = offline_describe_one(name, &path).expect("initial describe");
        assert!(!initial.configured);
        assert!(initial.writable);

        mutate_credential_ref_at(&path, name, Some("secret-one")).expect("set first");
        let stored = offline_describe_one(name, &path).expect("stored describe");
        assert!(stored.configured);
        assert_eq!(stored.source.as_deref(), Some("file"));
        assert!(stored.writable);

        mutate_credential_ref_at(&path, name, Some("secret-two")).expect("replace");
        assert_eq!(
            file_ref_value(&path, name).expect("read replacement").as_deref(),
            Some("secret-two")
        );

        mutate_credential_ref_at(&path, name, None).expect("unset");
        let removed = offline_describe_one(name, &path).expect("removed describe");
        assert!(!removed.configured);
        assert!(removed.writable);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn launch_environment_is_read_only_and_shadows_managed_file() {
        let dir = temp_dir("credentials-env-shadow");
        let path = dir.join(CREDENTIALS_FILENAME);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let name = format!("DSH_PRO_MAX_LIFECYCLE_ENV_{stamp}");
        mutate_credential_ref_at(&path, &name, Some("managed-secret")).expect("seed managed");
        std::env::set_var(&name, "launch-secret");

        let described = offline_describe_one(&name, &path).expect("describe env");
        assert!(described.configured);
        assert_eq!(described.source.as_deref(), Some("env"));
        assert!(!described.writable);
        let error = mutate_credential_ref_at(&path, &name, Some("replacement"))
            .expect_err("launch env must reject writes");
        assert!(error.contains("read-only"));
        assert_eq!(
            file_ref_value(&path, &name).expect("managed remains").as_deref(),
            Some("managed-secret")
        );

        std::env::remove_var(&name);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn flat_pre_release_document_is_upgraded_on_write() {
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
        assert_eq!(
            file_ref_value(&path, "OPENAI_API_KEY").expect("old"),
            Some("old".into())
        );
        assert_eq!(
            file_ref_value(&path, "ANTHROPIC_API_KEY").expect("new"),
            Some("new".into())
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_unknown_document_shape_instead_of_overwriting_it() {
        let error = document_from_text(
            "version: 1\nother: secret\n",
            Path::new("credentials.yaml"),
        )
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
