//! 启动前插件导出漂移预检：插件对宿主 @deepseek-ai/* 包的具名导入与宿主
//! 实际导出比对，缺失即点名。这是 semver 判定做不到的——prerelease 宿主
//! 生态里 peer 范围普遍"失配"但绝大多数能跑（本机实测 5 包 semver 全红、
//! 唯一真雷混在其中）；API 漂移（宿主升线删除/改名导出）才是启动必炸的
//! 精确信号。失配只披露不拦截：预检是静态近似（动态 import、default 导入
//! 等形态抓不到），漏报由启动失败诊断兜底，两道闸共用「禁用并重试」。

use super::components::{dsh_dir, npm_bin, resolve_dsh_bin};
use super::process::run_capture;
use super::{AUTH_PLUGIN_PACKAGE, CONNECTION_PLUGIN_PACKAGE};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::i18n::keyf;

/// 一条漂移：插件从宿主包具名导入的若干导出在宿主实际产物中不存在
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ExportDrift {
    pub(crate) plugin: String,
    pub(crate) dependency: String,
    pub(crate) missing: Vec<String>,
}

/// 宿主 dsh 包根（…/node_modules/@deepseek-ai/dsh）：宿主导出清单的定位基点。
/// 优先从 CLI 符号链接 canonicalize 推导（零子进程）；npm 的 cmd shim
/// （Windows）穿透不了，回退 npm root -g。两路都断时返回 None（预检放弃）
fn host_package_root() -> Option<PathBuf> {
    if let Ok(bin) = resolve_dsh_bin() {
        if let Ok(real) = bin.canonicalize() {
            let hit = real.ancestors().find(|p| {
                p.file_name().is_some_and(|n| n == "dsh")
                    && p.parent().and_then(|p| p.file_name())
                        == Some(std::ffi::OsStr::new("@deepseek-ai"))
                    && p.join("package.json").is_file()
            });
            if let Some(root) = hit {
                return Some(root.to_path_buf());
            }
        }
    }
    if let Ok((out, _, true)) = run_capture(&npm_bin(), &["root", "-g"]) {
        let candidate = PathBuf::from(out.trim()).join("@deepseek-ai").join("dsh");
        if candidate.join("package.json").is_file() {
            return Some(candidate);
        }
    }
    None
}

/// 递归收集目录下的 .js 文件（跳过嵌套 node_modules 与点前缀项）
fn js_files(dir: &Path, acc: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let lossy = name.to_string_lossy();
        if lossy.starts_with('.') || lossy == "node_modules" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            js_files(&path, acc);
        } else if lossy.ends_with(".js") {
            acc.push(path);
        }
    }
}

/// 从 `import { a, b as c } from "pkg"` / `export { ... } from "pkg"` 的
/// 花括号清单里取被导入的名字。`as` 重命名的绑定名在最后（`x as default`
/// 即 default），故取每段最后一个 token 即答案
fn brace_names(inner: &str) -> Vec<String> {
    inner
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| {
            part.split_whitespace()
                .next_back()
                .unwrap_or(part)
                .to_string()
        })
        .collect()
}

/// 一个插件包对宿主 @deepseek-ai/* 包的全部具名导入：
/// (宿主包名, 导入名集合)。字符串扫描回溯法：先定位宿主包名字符串字面量，
/// 向前校验 `from`、`} ` 花括号清单与 import/export 关键字——普通字符串值、
/// 注释里的包名、default/namespace 导入没有这个语句形状，天然被滤掉
pub(crate) fn plugin_host_imports(plugin_dir: &Path) -> HashMap<String, HashSet<String>> {
    let mut files = Vec::new();
    js_files(plugin_dir, &mut files);
    let mut imports: HashMap<String, HashSet<String>> = HashMap::new();
    for file in files {
        let Ok(src) = fs::read_to_string(&file) else {
            continue;
        };
        for quote in ['"', '\''] {
            let mut rest = src.as_str();
            while let Some(pos) = rest.find(quote) {
                let after = &rest[pos + quote.len_utf8()..];
                let Some(end) = after.find(quote) else {
                    break;
                };
                let literal = &after[..end];
                rest = &after[end + quote.len_utf8()..];
                // 字面量须是裸宿主包名（允许 "pkg" 不允许 "pkg/sub"）
                let Some(pkg) = literal.strip_prefix("@deepseek-ai/") else {
                    continue;
                };
                if pkg.is_empty() || pkg.contains('/') {
                    continue;
                }
                // 回溯：字面量前应是 `from`，再往前应是 `}` 花括号清单，
                // 花括号前应有 import/export 关键字（default/namespace 导入
                // 无花括号，到此自然落空）
                let before = &src[..src.len() - rest.len() - literal.len() - 2 * quote.len_utf8()];
                let Some(from_stripped) = before.trim_end().strip_suffix("from") else {
                    continue;
                };
                let Some(brace_end) = from_stripped.trim_end().strip_suffix('}') else {
                    continue;
                };
                let Some(brace_open_rel) = brace_end.rfind('{') else {
                    continue;
                };
                let keyword = brace_end[..brace_open_rel].trim_end();
                if !keyword.ends_with("import") && !keyword.ends_with("export") {
                    continue;
                }
                for name in brace_names(&brace_end[brace_open_rel + 1..]) {
                    imports.entry(pkg.to_string()).or_default().insert(name);
                }
            }
        }
    }
    imports
}

/// 宿主包实际导出名集：main 产物里的 `export { … }` 聚合（`x as y` 取 y）。
/// 只认 `export` 后紧邻 `{` 的聚合形态（`export const` / `export default`
/// 等一律跳过）。解析不了（入口缺失/形态变化）返回 None——该包整体跳过，
/// 宁漏报不误报
pub(crate) fn host_export_names(host_node_modules: &Path, pkg: &str) -> Option<HashSet<String>> {
    // pkg 是剥过 scope 的短名（dsh-session）；宿主提供的包一律在 @deepseek-ai 下
    let pkg_dir = host_node_modules.join("@deepseek-ai").join(pkg);
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(pkg_dir.join("package.json")).ok()?).ok()?;
    let main = manifest
        .get("main")
        .and_then(|v| v.as_str())
        .unwrap_or("index.js");
    let entry = pkg_dir.join(main);
    let src = fs::read_to_string(entry).ok()?;
    let mut names = HashSet::new();
    let mut rest = src.as_str();
    while let Some(pos) = rest.find("export") {
        let after = rest[pos + "export".len()..].trim_start();
        if let Some(body) = after.strip_prefix('{') {
            if let Some(close_rel) = body.find('}') {
                for name in brace_names(&body[..close_rel]) {
                    names.insert(name);
                }
                rest = &body[close_rel + 1..];
                continue;
            }
        }
        rest = after;
    }
    (!names.is_empty()).then_some(names)
}

/// 单插件比对：其宿主导入清单 vs 宿主实际导出。宿主包解析不了（缓存 None）
/// 则整包跳过；缺失导出按包聚合为一条漂移
pub(crate) fn drift_for_plugin(
    plugin: &str,
    imports: &HashMap<String, HashSet<String>>,
    host_node_modules: &Path,
    cache: &mut HashMap<String, Option<HashSet<String>>>,
) -> Vec<ExportDrift> {
    let mut drifts = Vec::new();
    for (pkg, names) in imports {
        let exports = cache
            .entry(pkg.clone())
            .or_insert_with(|| host_export_names(host_node_modules, pkg))
            .clone();
        let Some(exports) = exports else {
            continue;
        };
        let missing: Vec<String> = names.difference(&exports).cloned().collect();
        if missing.is_empty() {
            continue;
        }
        drifts.push(ExportDrift {
            plugin: plugin.to_string(),
            dependency: format!("@deepseek-ai/{pkg}"),
            missing,
        });
    }
    drifts
}

/// 预检总入口：宿主包根 / profile 目录不可得时返回空——预检是披露面，
/// 任何环节不成立都静默放弃，绝不阻塞启动
pub(crate) fn preflight_export_drift() -> Vec<ExportDrift> {
    let Some(root) = host_package_root() else {
        return Vec::new();
    };
    let host_node_modules = root.join("node_modules");
    let Some(profile) = dsh_dir().ok().map(|d| d.join("profiles").join("web")) else {
        return Vec::new();
    };
    let mut plugins = Vec::new();
    let Ok(entries) = fs::read_dir(profile.join("node_modules")) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let lossy = entry.file_name().to_string_lossy().to_string();
        if lossy.starts_with('@') {
            if let Ok(scope) = fs::read_dir(&path) {
                plugins.extend(scope.flatten().map(|e| e.path()));
            }
        } else {
            plugins.push(path);
        }
    }
    let mut cache: HashMap<String, Option<HashSet<String>>> = HashMap::new();
    let mut drifts = Vec::new();
    for plugin_dir in plugins {
        let manifest = plugin_dir.join("package.json");
        let Ok(raw) = fs::read_to_string(&manifest) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(plugin) = json.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        drifts.extend(drift_for_plugin(
            plugin,
            &plugin_host_imports(&plugin_dir),
            &host_node_modules,
            &mut cache,
        ));
    }
    drifts
}

/// 漂移披露行（追加在 start 步骤 done 文案后，风格同诊断 problem 的多行）；
/// 超过 3 条折叠为计数，防长列表淹没节点
pub(crate) fn preflight_warning_lines(drifts: &[ExportDrift]) -> String {
    let mut lines: Vec<String> = drifts
        .iter()
        .take(3)
        .map(|d| {
            let mut missing = d.missing.clone();
            missing.sort();
            keyf(
                "Incompatible plugin {plugin}: {dependency} does not export {names}; it will abort dsh startup",
                &[
                    ("plugin", d.plugin.clone()),
                    ("dependency", d.dependency.clone()),
                    ("names", missing.join(", ")),
                ],
            )
        })
        .collect();
    if drifts.len() > 3 {
        lines.push(keyf(
            "… and {count} more",
            &[("count", (drifts.len() - 3).to_string())],
        ));
    }
    lines.join("\n")
}

/// start 步骤的 done 文案组装：基线文案追加漂移披露行，并给出可一键禁用
/// 的第三方插件（受管授权插件不给按钮——它的既定恢复路径是 Repair dsh
/// stack，与启动失败诊断同一规则）。无漂移时原样返回、不带动作
pub(crate) fn done_detail_with_preflight(base: &str) -> (String, Option<String>) {
    let drifts = preflight_export_drift();
    if drifts.is_empty() {
        return (base.to_string(), None);
    }
    let action = drifts
        .iter()
        .map(|d| d.plugin.as_str())
        .find(|p| *p != AUTH_PLUGIN_PACKAGE && *p != CONNECTION_PLUGIN_PACKAGE)
        .map(str::to_string);
    (
        format!("{base}\n{}", preflight_warning_lines(&drifts)),
        action,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brace_names_extracts_as_renames() {
        assert_eq!(brace_names(" a, b as c,  d "), vec!["a", "c", "d"]);
        assert_eq!(brace_names("x as default"), vec!["default"]);
        assert_eq!(brace_names(""), Vec::<String>::new());
    }
}
