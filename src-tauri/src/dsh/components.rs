//! 组件定位与安装：node/npm/dsh/tailscale 二进制定位、版本闸门、内置授权插件 tarball 装入 web profile。

use super::{AUTH_PLUGIN_PACKAGE, AUTH_PLUGIN_TARBALL, CONNECTION_PLUGIN_PACKAGE, CONNECTION_PLUGIN_TARBALL, DSH_PACKAGE, SUPPORTED_DSH_VERSION};
use super::process::{run_capture, which};
use super::update::{ensure_web_profile_compat_patch, rewrite_web_profile_patch};
use crate::version::parse_version;
use std::fs;
use std::path::{Path, PathBuf};


use tauri::{Manager};

use crate::config;
use crate::i18n::{tr, trf};

// ============ 组件定位 ============

pub(crate) fn dsh_dir() -> Result<PathBuf, String> {
    Ok(config::home_dir()?.join(".dsh"))
}

#[derive(Debug, Clone)]
pub(crate) struct DshPluginSpecs {
    connection: String,
    auth: String,
}

pub(crate) fn plugin_file_spec(path: &Path) -> String {
    let normalized = config::strip_unc(&path.to_string_lossy()).replace('\\', "/");
    format!("file:{}", normalized)
}

pub(crate) fn bundled_plugin_tarball(app: &tauri::AppHandle, filename: &str) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("dsh-plugins").join(filename));
        candidates.push(resources.join(filename));
    }
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".artifacts")
            .join("dsh-plugins")
            .join(filename),
    );
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            log::error!("[dsh 插件] 内置插件 tarball 缺失: {}", filename);
            trf(
                "Bundled dsh plugin is missing: {plugin}",
                &[("plugin", filename.to_string())],
            )
        })
}

pub(crate) fn bundled_plugin_specs(app: &tauri::AppHandle) -> Result<DshPluginSpecs, String> {
    Ok(DshPluginSpecs {
        connection: plugin_file_spec(&bundled_plugin_tarball(app, CONNECTION_PLUGIN_TARBALL)?),
        auth: plugin_file_spec(&bundled_plugin_tarball(app, AUTH_PLUGIN_TARBALL)?),
    })
}

pub(crate) fn web_profile_package_path() -> Result<PathBuf, String> {
    Ok(dsh_dir()?.join("profiles").join("web").join("package.json"))
}

pub(crate) fn plugin_profile_is_current(contents: &str, connection_spec: &str, auth_spec: &str) -> bool {
    let Ok(package) = serde_json::from_str::<serde_json::Value>(contents) else {
        return false;
    };
    let dependencies = package
        .get("dependencies")
        .and_then(serde_json::Value::as_object);
    let bundles = package
        .pointer("/dsh/profile/bundles")
        .and_then(serde_json::Value::as_array);
    let has_dependency = |name: &str, spec: &str| {
        dependencies
            .and_then(|deps| deps.get(name))
            .and_then(serde_json::Value::as_str)
            == Some(spec)
    };
    let has_bundle = |name: &str| {
        bundles.is_some_and(|items| items.iter().any(|item| item.as_str() == Some(name)))
    };
    has_dependency(CONNECTION_PLUGIN_PACKAGE, connection_spec)
        && has_dependency(AUTH_PLUGIN_PACKAGE, auth_spec)
        && has_bundle(CONNECTION_PLUGIN_PACKAGE)
        && has_bundle(AUTH_PLUGIN_PACKAGE)
}

pub(crate) fn auth_plugins_installed(specs: &DshPluginSpecs) -> bool {
    let Ok(path) = web_profile_package_path() else {
        return false;
    };
    fs::read_to_string(path)
        .map(|contents| plugin_profile_is_current(&contents, &specs.connection, &specs.auth))
        .unwrap_or(false)
}

/// web profile 是否仍带授权插件条目（dependencies 或 bundles 任一命中即算）。
/// 与 auth_plugins_installed 的区别：不关心 spec 是否指向当前内置 tarball，
/// 用于卸载前的存在性判断与卸载后的残留校验
pub(crate) fn web_profile_has_auth_plugins() -> bool {
    let Ok(path) = web_profile_package_path() else {
        return false;
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(package) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return false;
    };
    let has_dep = |name: &str| {
        package
            .get("dependencies")
            .and_then(serde_json::Value::as_object)
            .is_some_and(|deps| deps.contains_key(name))
    };
    let has_bundle = |name: &str| {
        package
            .pointer("/dsh/profile/bundles")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(name)))
    };
    [CONNECTION_PLUGIN_PACKAGE, AUTH_PLUGIN_PACKAGE]
        .iter()
        .any(|name| has_dep(name) || has_bundle(name))
}

pub(crate) fn install_auth_plugins(app: &tauri::AppHandle) -> Result<DshPluginSpecs, String> {
    let specs = bundled_plugin_specs(app)?;
    if auth_plugins_installed(&specs) {
        return Ok(specs);
    }
    let dsh = resolve_dsh_bin()?.display().to_string();
    // 首次安装失败时，先清掉 profile 里的残留条目再重试一次：
    // pnpm 在 profile 目录的 node_modules/lockfile 状态损坏（跨版本/跨安装源
    // 复用时硬链接失效，Windows 上尤为常见）会导致 add 失败但 stderr 没有
    // 有效信息（实机回归：「pnpm failed in profile directory」无详情）。
    // remove 是幂等的（无残留时 pnpm 直接成功），清理后 add 走干净路径
    match run_plugin_add(&dsh, &specs) {
        Ok(()) => {
            ensure_web_profile_compat_patch()?;
            Ok(specs)
        }
        Err(first_err) => {
            log::warn!("[dsh 插件] 首次安装失败，清理 profile 后重试: {}", first_err);
            let _ = run_capture(
                &dsh,
                &[
                    "plugin",
                    "--profile",
                    "web",
                    "remove",
                    CONNECTION_PLUGIN_PACKAGE,
                    AUTH_PLUGIN_PACKAGE,
                ],
            );
            run_plugin_add(&dsh, &specs)?;
            ensure_web_profile_compat_patch()?;
            Ok(specs)
        }
    }
}

/// 执行一次 dsh plugin --profile web add 并校验结果；失败带完整 stderr
pub(crate) fn run_plugin_add(dsh: &str, specs: &DshPluginSpecs) -> Result<(), String> {
    match run_capture(
        dsh,
        &[
            "plugin",
            "--profile",
            "web",
            "add",
            &specs.connection,
            &specs.auth,
        ],
    ) {
        Ok((_, _, true)) if auth_plugins_installed(specs) => Ok(()),
        Ok((_, err, true)) => {
            let e = trf(
                "dsh plugin install completed but the web profile is incomplete: {error}",
                &[("error", err)],
            );
            log::error!("[dsh 插件] profile 不完整: {}", e);
            Err(e)
        }
        Ok((_, err, false)) => {
            let e = trf(
                "Failed to install dsh auth plugins: {error}",
                &[(
                    "error",
                    if err.is_empty() {
                        "dsh plugin add failed".to_string()
                    } else {
                        err
                    },
                )],
            );
            log::error!("[dsh 插件] 安装失败: {}", e);
            Err(e)
        }
        Err(error) => {
            log::error!("[dsh 插件] 执行 dsh plugin add 失败: {}", error);
            Err(error)
        }
    }
}

/// 定位 node 可执行（绝对路径，供自启脚本嵌入）
pub(crate) fn resolve_node_bin() -> Result<String, String> {
    which("node").ok_or_else(|| {
        let err = tr("Node.js is not available; please install Node.js 18+ and restart this app");
        log::error!("[dsh] 定位 node 失败: {}", err);
        err
    })
}

/// 定位 npm（probe PATH 内；失败返回裸 "npm" 让错误自然暴露）
pub(crate) fn npm_bin() -> String {
    which("npm").unwrap_or_else(|| "npm".to_string())
}

/// 从 dsh --version 原始输出中提取可解析的版本号：容忍 "dsh 0.1.0"、"v0.1.0-rc.6"、
/// 尾部构建信息等前缀/杂质，保证版本胶囊显示与 semver 比较（version::is_newer）
/// 使用同一份干净版本号。提取失败回退原串（比较侧解析失败会安全降级为无更新）
pub(crate) fn normalize_version(raw: &str) -> String {
    let t = raw.trim();
    for tok in t.split_whitespace() {
        let tok = tok.trim_start_matches(['v', 'V']);
        if parse_version(tok).is_some() {
            return tok.to_string();
        }
    }
    t.to_string()
}

/// dsh --version 输出（经 normalize_version 规范化）；未安装返回 None
pub(crate) fn dsh_version() -> Option<String> {
    let bin = which("dsh")?;
    let (out, _, ok) = run_capture(&bin, &["--version"]).ok()?;
    if !ok {
        return None;
    }
    let v = normalize_version(&out);
    if v.is_empty() { None } else { Some(v) }
}

/// 版本闸门：actual 不低于锁定版本，且与锁定版本同一条 x.y.z 演进线。
/// 只看 ">=" 会放过上游新线：0.1.1-rc.2 满足 >=0.1.0-rc.8，但跨线会重排
/// credentials 文件格式并改插件运行时（v0.3.8 的实机教训）。下限唯一来源
/// 是 SUPPORTED_DSH_VERSION——跟线升级本就要求常量与插件 pin 三处同步，
/// 再读 profile 里已装插件的 peer 只会在「CLI 已升、插件未升」的窗口里
/// 制造自相矛盾的判定。
pub(crate) fn version_within_supported_line(
    actual: &crate::version::Version,
    min: &crate::version::Version,
) -> bool {
    actual >= min && actual.same_line(min)
}

/// 兼容判定（供 detect/setup/install 共用）：解析失败按不兼容处理。
/// 锁定线是 SUPPORTED_DSH_VERSION；同线更高 rc 由插件依赖范围承诺，
/// 跨线一律视为不兼容。
pub(crate) fn dsh_version_is_compatible(version: Option<&str>) -> bool {
    let Some(v) = version else { return false };
    match (parse_version(v), parse_version(SUPPORTED_DSH_VERSION)) {
        (Some(actual), Some(min)) => version_within_supported_line(&actual, &min),
        _ => false,
    }
}

/// 安装 Launcher 锁定的 dsh 版本（固定 SUPPORTED_DSH_VERSION），并在 npm
/// 成功后再次校验实际 CLI。固定版本而非跟随 @next：上游把 @next 滚到新
/// minor（0.1.1-rc.2）时并不照顾 vendored 授权栈的兼容性，被动跟随会把
/// 用户机器拖进起不来服务的状态；升线由本仓库显式 bump 常量并验证。
pub(crate) fn install_supported_dsh() -> Result<String, String> {
    resolve_node_bin()?;
    let package = format!("{DSH_PACKAGE}@{SUPPORTED_DSH_VERSION}");
    match run_capture(&npm_bin(), &["install", "-g", &package]) {
        Ok((_, _, true)) => {}
        Ok((_, err, false)) => {
            let error = if err.is_empty() {
                format!("npm install -g {package} failed")
            } else {
                err
            };
            log::error!("[dsh 安装] npm install -g 失败: {}", error);
            return Err(trf("Install failed: {error}", &[("error", error)]));
        }
        Err(error) => {
            log::error!("[dsh 安装] 执行 npm install 失败: {}", error);
            return Err(error);
        }
    }
    let version = dsh_version().ok_or_else(|| {
        let err = tr("dsh installed but cannot be located in PATH");
        log::error!("[dsh 安装] 安装后无法在 PATH 定位 dsh");
        err
    })?;
    // 装的是精确固定版本，校验直接对常量；不用 dsh_version_is_compatible——
    // 它的下限读 profile 里已装插件的 peer，跟线升级时插件尚未重装，
    // 旧下限会拒绝刚装上的新线版本（setup 的 install 步骤先于 plugin add）
    if version != SUPPORTED_DSH_VERSION {
        let err = trf(
            "Installed dsh version {actual}, but this Launcher requires {expected}",
            &[
                ("actual", version.clone()),
                ("expected", SUPPORTED_DSH_VERSION.to_string()),
            ],
        );
        log::error!("[dsh 安装] 版本不匹配: {}", err);
        return Err(err);
    }
    // 仅在版本校验成功后写 profile patch，避免失败安装留下持久残留。
    // authz 插件的依赖范围（^rc.8）不覆盖 dsh 下一个 rc 的 peer（^rc.9），
    // 装新版本后需要让 profile 的插件依赖也跟着滚。
    if let Err(error) = rewrite_web_profile_patch(&version) {
        log::warn!("[dsh 安装] 重写 web profile patch 失败: {}", error);
    }
    Ok(version)
}

/// 定位 dsh 可执行：先 probe PATH，再经 `npm prefix -g` 推 npm 全局 bin
pub(crate) fn resolve_dsh_bin() -> Result<PathBuf, String> {
    if let Some(p) = which("dsh") {
        return Ok(PathBuf::from(p));
    }
    if let Ok((out, _, ok)) = run_capture(&npm_bin(), &["prefix", "-g"]) {
        if ok {
            let prefix = PathBuf::from(out.trim());
            #[cfg(windows)]
            let candidates = [
                prefix.join("dsh.cmd"),
                prefix.join("dsh.ps1"),
                prefix.join("dsh"),
            ];
            #[cfg(not(windows))]
            let candidates = [prefix.join("bin").join("dsh")];
            for c in candidates {
                if c.exists() {
                    return Ok(c);
                }
            }
        }
    }
    Err({
        let err = tr("Cannot locate the dsh CLI; install it with npm install -g @deepseek-ai/dsh");
        log::error!("[dsh] 定位 dsh CLI 失败: {}", err);
        err
    })
}

/// 定位 tailscale CLI（Windows 默认装在 Program Files，不在 PATH）
pub(crate) fn tailscale_path() -> Option<String> {
    if let Some(p) = which("tailscale") {
        return Some(p);
    }
    #[cfg(windows)]
    for c in [
        "C:\\Program Files\\Tailscale\\tailscale.exe",
        "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
    ] {
        if Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    None
}

/// 解析 MagicDNS 状态与后缀（tailscale dns status）
pub(crate) fn magic_dns_info(ts: &str) -> (bool, Option<String>) {
    let Ok((out, _, _)) = run_capture(ts, &["dns", "status"]) else {
        return (false, None);
    };
    let enabled = out
        .lines()
        .any(|l| l.to_lowercase().contains("magicdns: enabled"));
    let suffix = out.lines().find_map(|l| {
        l.find("suffix = ")
            .map(|i| l[i + "suffix = ".len()..].trim_end_matches(')').trim().to_string())
    });
    (enabled, suffix)
}

/// 解析 tailnet 主机名与 HTTPS URL：
/// 1) tailscale serve status 里的 https://<host>.ts.net
/// 2) tailscale status 首行设备名 + MagicDNS 后缀
pub(crate) fn resolve_host_and_url() -> (Option<String>, Option<String>) {
    let Some(ts) = tailscale_path() else {
        return (None, None);
    };
    if let Ok((out, _, ok)) = run_capture(&ts, &["serve", "status"]) {
        if ok {
            for line in out.lines() {
                let l = line.trim();
                if let Some(rest) = l.strip_prefix("https://") {
                    let host = rest.split([' ', '/']).next().unwrap_or("");
                    if !host.is_empty() {
                        return (
                            Some(host.split('.').next().unwrap_or(host).to_string()),
                            Some(format!("https://{}", host)),
                        );
                    }
                }
            }
        }
    }
    if let Ok((out, _, ok)) = run_capture(&ts, &["status"]) {
        if ok {
            if let Some(first) = out.lines().next() {
                let host = first.split_whitespace().nth(1).unwrap_or("").to_string();
                if !host.is_empty() {
                    let (_, suffix) = magic_dns_info(&ts);
                    if let Some(sfx) = suffix {
                        return (Some(host.clone()), Some(format!("https://{}.{}", host, sfx)));
                    }
                    return (Some(host), None);
                }
            }
        }
    }
    (None, None)
}
