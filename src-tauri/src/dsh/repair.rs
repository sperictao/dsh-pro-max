//! web profile 修复核：启动前把「宿主升线后 profile 里的陈旧状态」收敛掉，
//! 让 dsh 自己的机制接管恢复。两把修复都是幂等数据修复，不猜不试跑：
//!
//! 1. 影子副本治理：profile node_modules 下的 `@deepseek-ai/*` 真实目录是
//!    旧时代 pnpm 物化的 registry 副本。宿主包的 npm dist-tag（latest 是
//!    占位版、next 滞后）决定 registry 副本版本必然错位，且 semver 预发布
//!    规则让重装也追不上宿主；dsh 的 module-fallback heal 只补缺失、把
//!    pnpm 管理的现存条目当权威（不纠版本）。真实目录删掉后 heal 自动以
//!    符号链接补回宿主正源副本——heal 的 fallback 链接是 symlink，可精确
//!    区分，误删也无损。
//! 2. 保留权限预设剥离：宿主把 `auto`/`custom` 保留为 permission presets
//!    内置名（服务构造期校验，配置表出现即拒启）。最后声明 `permission`
//!    条目配置的 bundle 层（wholesale 覆盖语义，后者胜）若表里带保留名，
//!    在用户层写一条「生效表减保留名」的覆盖行。该行是派生物：冲突消失
//!    即自洁删除，bundle 更新后下次启动重算——插件补丁层始终是唯一事实
//!    来源。是否需要剥离由宿主库内容的保留名指纹门控（版本无关），观测到
//!    保留名启动失败时可越过门控强制执行（force）。

use super::compat::host_package_root;
use super::components::dsh_dir;
use std::fs;
use std::path::{Path, PathBuf};

/// permission presets 条目 id（dsh-base 层创建，插件层 wholesale 覆盖）
const RESERVED_PRESET_ENTRY: &str = "permission";
/// dsh-permission-presets 构造期保留的名字：`custom` 是派生的非预设态，
/// `auto` 是实验性逐调用审查预设
const RESERVED_PRESET_NAMES: [&str; 2] = ["auto", "custom"];
/// strip 覆盖行的宿主库指纹：指纹读不到（路径变更/上游改写）时门控关闭，
/// 只披露不修复，观测到真实失败再由 force 兜底。诊断层也用它识别保留名
/// 类失败（pub(crate)：setup.rs 的诊断分支按此归 repairable）
pub(crate) const RESERVED_NAME_FINGERPRINT: &str =
    "is reserved and cannot name a configured preset";
/// strip 覆盖行的块首标记：删除与识别只认这一行，用户手写的同名覆盖行不受影响
const STRIP_BLOCK_MARKER: &str =
    "# dsh-pro-max repair: permission presets minus reserved names (derived; do not edit)";

/// 保留名冲突的处置结果（时间轴披露与重试决策的共同事实）
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) enum ReservedPresetOutcome {
    /// 无冲突，或冲突方在当前宿主上合法（保留名门控未命中）
    #[default]
    Clear,
    /// 已写入 strip 覆盖：点名被剥离的插件与保留名
    Stripped { plugin: String, reserved: String },
    /// 有冲突但修不了（生效表含标签值无法重序列化 / 写盘失败）：披露 +
    /// 一键禁用兜底，不阻塞披露链路
    Blocked { plugin: String, reserved: String },
}

/// 一次修复 pass 的台账：done 明细据此披露，重试编排据此判定是否重试
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct ProfileRepair {
    /// 删除的影子副本（`@deepseek-ai/dsh-llm 0.1.5-rc.2` 形态，已排序）
    pub(crate) removed_copies: Vec<String>,
    pub(crate) reserved_presets: ReservedPresetOutcome,
}

impl ProfileRepair {
    /// force 重试的判据：这一轮确实改动了什么才值得再付一次启动等待
    pub(crate) fn did_something(&self) -> bool {
        !self.removed_copies.is_empty()
            || !matches!(self.reserved_presets, ReservedPresetOutcome::Clear)
    }
}

/// 修复 pass 总入口：spawn 前以门控模式调用（幂等，每启动顺路），启动失败
/// 诊断为保留名类时以 force 再调一次（观测到的失败即事实，越过内容门控）。
/// 任何环节不成立都静默放弃——修复是披露面，绝不阻塞启动
pub(crate) fn repair_web_profile(force: bool) -> ProfileRepair {
    let mut report = ProfileRepair::default();
    let Some(profile) = web_profile_dir() else {
        return report;
    };
    report.removed_copies = remove_stale_host_copies(&profile);
    report.reserved_presets = reconcile_reserved_presets(&profile, force);
    report
}

/// web profile 目录（package.json 所在处）；不可得即整体放弃修复
pub(crate) fn web_profile_dir() -> Option<PathBuf> {
    dsh_dir().ok().map(|d| d.join("profiles").join("web"))
}

/// 删除 profile node_modules 下 `@deepseek-ai/*` 的真实目录副本。symlink
/// （heal 的 fallback 链接，含断链）与散文件不动；删除范围只限 web profile
/// 的 node_modules——共享层 `~/.dsh/profiles/node_modules` 由 dsh 自己的
/// heal 维护，不越界
pub(crate) fn remove_stale_host_copies(profile: &Path) -> Vec<String> {
    let scope = profile.join("node_modules").join("@deepseek-ai");
    let Ok(entries) = fs::read_dir(&scope) else {
        return Vec::new();
    };
    let mut removed = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // 先判 symlink 再判 dir：断链 is_dir 为 false，两种判定都安全
        if path.is_symlink() || !path.is_dir() {
            continue;
        }
        let version = fs::read_to_string(path.join("package.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|m| m.get("version")?.as_str().map(str::to_string));
        let name = entry.file_name().to_string_lossy().to_string();
        match fs::remove_dir_all(&path) {
            Ok(()) => removed.push(match version {
                Some(v) => format!("@deepseek-ai/{name} {v}"),
                None => format!("@deepseek-ai/{name}"),
            }),
            Err(e) => {
                crate::logging::warn("[repair] 删除影子副本失败", &format!("{name}: {e}"));
            }
        }
    }
    removed.sort();
    removed
}

/// 保留名冲突的核对与落盘。有冲突且门控命中（或 force）→ 写 strip 覆盖；
/// 无冲突 → 已有的 strip 覆盖自洁删除；门控未命中 → 一律不动（旧宿主上
/// 插件声明 `auto` 预设是合法功能，剥了反而是回归）
fn reconcile_reserved_presets(profile: &Path, force: bool) -> ReservedPresetOutcome {
    let Some(conflict) = scan_reserved_presets(profile) else {
        if remove_strip_override(profile) {
            log::info!("[repair] 保留名冲突已消失，strip 覆盖行自洁删除");
        }
        return ReservedPresetOutcome::Clear;
    };
    if !force && !host_reserves_presets() {
        return ReservedPresetOutcome::Clear;
    }
    let reserved = conflict.reserved.join(", ");
    match conflict.stripped_config {
        Some(config) => match write_strip_override(profile, &config) {
            Ok(()) => ReservedPresetOutcome::Stripped {
                plugin: conflict.plugin,
                reserved,
            },
            Err(e) => {
                crate::logging::warn("[repair] strip 覆盖行写入失败", &e);
                ReservedPresetOutcome::Blocked {
                    plugin: conflict.plugin,
                    reserved,
                }
            }
        },
        None => ReservedPresetOutcome::Blocked {
            plugin: conflict.plugin,
            reserved,
        },
    }
}

/// 宿主库是否把保留名当构造期校验：读实际安装的 dsh-permission-presets
/// 产物找指纹（与 compat 预检同思路——读宿主实物比猜版本线精确）
fn host_reserves_presets() -> bool {
    let Some(root) = host_package_root() else {
        return false;
    };
    let lib = root
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh-permission-presets")
        .join("lib")
        .join("index.js");
    fs::read_to_string(lib)
        .map(|src| src.contains(RESERVED_NAME_FINGERPRINT))
        .unwrap_or(false)
}

/// 一条保留名冲突：plugin 是最后声明 `permission` 条目配置的 bundle（
/// wholesale 覆盖语义下的生效方），stripped_config 为 None 表示生效表里
/// 有 `!!js` 标签值、无法安全重序列化
pub(crate) struct ReservedConflict {
    pub(crate) plugin: String,
    pub(crate) reserved: Vec<String>,
    pub(crate) stripped_config: Option<serde_yaml::Value>,
}

/// 扫描 bundle 补丁层，找最后声明 `permission` 条目配置的 bundle 并判定
/// 保留名。解析不了的补丁层跳过——预检是披露面，宁漏报不误报；dsh-base
/// 的层若因标签解析失败被跳过也无碍（它的表没有保留名，且第三方声明者
/// 在后、wholesale 覆盖语义下才是生效方）
pub(crate) fn scan_reserved_presets(profile: &Path) -> Option<ReservedConflict> {
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(profile.join("package.json")).ok()?).ok()?;
    let bundles: Vec<String> = manifest
        .get("dsh")?
        .get("profile")?
        .get("bundles")?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    let mut winner: Option<(String, serde_yaml::Value, String)> = None;
    for bundle in bundles {
        let Some(patch_path) = bundle_patch_path(profile, &bundle) else {
            continue;
        };
        let Ok(raw) = fs::read_to_string(&patch_path) else {
            continue;
        };
        let Ok(parsed) = serde_yaml::from_str::<serde_yaml::Value>(&raw) else {
            continue;
        };
        let Some(items) = parsed.as_sequence() else {
            continue;
        };
        for item in items {
            let declares = item.get("id").and_then(|v| v.as_str()) == Some(RESERVED_PRESET_ENTRY)
                && item.get("config").is_some_and(|v| v.is_mapping());
            if declares {
                winner = Some((
                    bundle.clone(),
                    item.get("config").expect("checked above").clone(),
                    raw.clone(),
                ));
            }
        }
    }
    let (plugin, config, raw) = winner?;
    let (reserved, stripped) = strip_reserved_presets(&config)?;
    if reserved.is_empty() {
        // 生效表没有保留名：无冲突（dsh-base 等合法声明者也走这里）
        return None;
    }
    // serde_yaml 会静默剥掉 `!!js` 双 bang 标签（解析成普通字符串，Tagged
    // 不出现）：带标签的生效表一旦重序列化，表达式就被烤成字面量、插件语义
    // 被歪曲。补丁层原文含 `!!` 即拒绝剥离（单 bang 自定义标签落为 Tagged，
    // 由 strip_reserved_presets 的 Tagged 守卫拦截）
    let stripped_config = if raw.contains("!!") { None } else { stripped };
    Some(ReservedConflict {
        plugin,
        reserved,
        stripped_config,
    })
}

/// bundle 自带补丁层路径：读其 package.json 的 dsh.bundle.patch（dsh 的
/// bundle 清单字段），缺省回退 cordis.patch.yml（现行生态的事实形态）
fn bundle_patch_path(profile: &Path, bundle: &str) -> Option<PathBuf> {
    let dir = profile.join("node_modules").join(bundle);
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.join("package.json")).ok()?).ok()?;
    let declared = manifest
        .get("dsh")?
        .get("bundle")?
        .get("patch")?
        .as_str()
        .unwrap_or("./cordis.patch.yml");
    Some(dir.join(declared.trim_start_matches("./")))
}

/// 生效配置的保留名判定与剥离：(保留名清单, 剥离后配置)。无保留名返回空
/// 清单；配置树含 Tagged 值（单 bang 自定义标签的落点，重序列化不保真）时
/// 剥离结果置 None——修不了就披露，不产出会歪曲插件语义的覆盖行。`!!js`
/// 双 bang 标签解析时被静默剥掉、Value 层不可见，由 scan 的原文 `!!` 守卫
/// 拦截，不在此列
pub(crate) fn strip_reserved_presets(
    config: &serde_yaml::Value,
) -> Option<(Vec<String>, Option<serde_yaml::Value>)> {
    let presets = config.get("presets")?;
    let mut reserved: Vec<String> = Vec::new();
    if let Some(table) = presets.as_mapping() {
        for name in table.keys() {
            if let Some(name) = name.as_str() {
                if RESERVED_PRESET_NAMES.contains(&name) {
                    reserved.push(name.to_string());
                }
            }
        }
    }
    if reserved.is_empty() {
        return Some((Vec::new(), None));
    }
    reserved.sort();
    if config_has_tagged(config) {
        return Some((reserved, None));
    }
    let mut stripped = config.clone();
    if let Some(table) = stripped.get_mut("presets").and_then(|p| p.as_mapping_mut()) {
        for name in &reserved {
            table.remove(name.as_str());
        }
    }
    Some((reserved, Some(stripped)))
}

/// 配置树里是否含标签值（Tagged）：有则该配置不可重序列化
fn config_has_tagged(value: &serde_yaml::Value) -> bool {
    match value {
        serde_yaml::Value::Tagged(_) => true,
        serde_yaml::Value::Mapping(m) => m
            .iter()
            .any(|(k, v)| config_has_tagged(k) || config_has_tagged(v)),
        serde_yaml::Value::Sequence(s) => s.iter().any(config_has_tagged),
        _ => false,
    }
}

/// strip 覆盖行落盘（行级编辑，同启停写入的约束：YAML 文档往返会剥掉
/// dsh loader 依赖的 `!!js` 标签，这里只增删自有标记块、其余字节原样）。
/// 空层的 `[]` 占位行先剥掉再追加（flow 空数组 + 块条目会被 loader 当两个
/// 文档拒收）。已有标记块先删后写，内容不变时免写盘
pub(crate) fn write_strip_override(
    profile: &Path,
    config: &serde_yaml::Value,
) -> Result<(), String> {
    let body = serde_yaml::to_string(config).map_err(|e| e.to_string())?;
    let mut block = vec![
        STRIP_BLOCK_MARKER.to_string(),
        format!("- id: {RESERVED_PRESET_ENTRY}"),
        "  config:".to_string(),
    ];
    // body 顶层键缩进 4 格，落在 `  config:` 之下
    for line in body.lines() {
        block.push(format!("    {line}"));
    }
    let patch_path = profile.join("cordis.patch.yml");
    let raw = fs::read_to_string(&patch_path).unwrap_or_default();
    let mut lines: Vec<String> = raw.lines().map(str::to_string).collect();
    if super::market::is_empty_patch(&raw) {
        lines.retain(|l| l.trim() != "[]");
    }
    lines = with_marker_block_removed_lines(lines);
    if let Some(last) = lines.last() {
        if !last.is_empty() {
            lines.push(String::new());
        }
    }
    lines.extend(block);
    let out = lines.join("\n") + "\n";
    if out == raw {
        return Ok(());
    }
    fs::write(&patch_path, out).map_err(|e| e.to_string())
}

/// 删除既有 strip 覆盖块（只认标记行起、到下一个顶层 item 或 EOF）。
/// 块删空层时归一回官方脚手架形态。返回是否改动了内容
pub(crate) fn remove_strip_override(profile: &Path) -> bool {
    let patch_path = profile.join("cordis.patch.yml");
    let Ok(raw) = fs::read_to_string(&patch_path) else {
        return false;
    };
    let lines = with_marker_block_removed_lines(raw.lines().map(str::to_string).collect());
    if lines.len() == raw.lines().count() {
        return false;
    }
    let mut out = lines.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    if super::market::is_empty_patch(&out) {
        // 空层归一回官方脚手架形态（注释头 + `[]`）：纯注释文件 YAML 解析
        // 为 null，dsh loader 必拒——落盘永远可解析
        while out.ends_with('\n') {
            out.pop();
        }
        out.push_str("\n[]\n");
    }
    fs::write(patch_path, out).is_ok()
}

/// 行序列 → 删掉标记块后的行序列。标记块 = 标记行 + 其后的自有条目（到
/// 再下一个顶层 item 行或 EOF）；无标记行原样返回。块尾扫描必须跳过标记
/// 块自己的条目起始行——它本身就是"下一个顶层 item"，从它起扫会把条目体
/// 留在文件里（只删标记行的半删态）
fn with_marker_block_removed_lines(lines: Vec<String>) -> Vec<String> {
    let Some(marker) = lines.iter().position(|l| l.trim() == STRIP_BLOCK_MARKER) else {
        return lines;
    };
    let is_top_level_item = |l: &str| l.starts_with("- ") || l == "-";
    // 标记块自身的条目起始行
    let block_item = lines[marker + 1..]
        .iter()
        .position(|l| is_top_level_item(l))
        .map(|p| marker + 1 + p);
    let end = match block_item {
        Some(start) => lines[start + 1..]
            .iter()
            .position(|l| is_top_level_item(l))
            .map(|p| start + 1 + p)
            .unwrap_or(lines.len()),
        // 残缺块（标记行后没有条目）：吞到 EOF
        None => lines.len(),
    };
    let mut kept: Vec<String> = lines[..marker].to_vec();
    kept.extend(lines[end..].to_vec());
    // 标记块带走后残留的尾部空行收敛掉（追加写会再补分隔空行）
    while kept.last().is_some_and(|l| l.trim().is_empty()) {
        kept.pop();
    }
    kept
}

/// R3 归因：哪个 bundle 层声明/插入过 entry_id（bare 覆盖行与 insert 子项
/// 都算，bundle 顺序取最后）。诊断层据此把「宿主包条目炸了」映射回肇事
/// 第三方插件；找不到（宿主包自身问题/层不可解析）返回 None
pub(crate) fn bundle_declarer_of_entry(profile: &Path, entry_id: &str) -> Option<String> {
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(profile.join("package.json")).ok()?).ok()?;
    let bundles: Vec<String> = manifest
        .get("dsh")?
        .get("profile")?
        .get("bundles")?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    let mut declarer: Option<String> = None;
    for bundle in bundles {
        let Some(patch_path) = bundle_patch_path(profile, &bundle) else {
            continue;
        };
        let Ok(raw) = fs::read_to_string(&patch_path) else {
            continue;
        };
        let Ok(parsed) = serde_yaml::from_str::<serde_yaml::Value>(&raw) else {
            continue;
        };
        let Some(items) = parsed.as_sequence() else {
            continue;
        };
        let declares = items.iter().any(|item| {
            item.get("id").and_then(|v| v.as_str()) == Some(entry_id)
                || item
                    .get("insert")
                    .and_then(|v| v.as_sequence())
                    .is_some_and(|children| {
                        children
                            .iter()
                            .any(|c| c.get("id").and_then(|v| v.as_str()) == Some(entry_id))
                    })
        });
        if declares {
            declarer = Some(bundle.clone());
        }
    }
    declarer
}
