//! 极简语义版本比较（semver 子集）：用于「是否有更新」判断与插件声明的
//! dsh 版本范围判定（satisfies_range）。
//! 支持可选的 v 前缀、`-prerelease` 后缀，忽略 `+build` 元数据。
//! 由 fastctx 与 dsh 两个 npm 包版本检测共用（唯一实现，避免逻辑分叉）。

/// prerelease 标识符：数字或字母数字（semver 优先级：数字 < 字母数字）
#[derive(Debug, Clone, PartialEq, Eq)]
enum PreId {
    Num(u64),
    Alpha(String),
}

/// 解析后的版本：核心三段 + 可选 prerelease 标识符列表
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Vec<PreId>,
}

/// 解析 "1.2.3" / "v1.2.3" / "0.1.0-rc.6" / "1.2.3+build.5" → Version。
/// 语义版本规范要求核心段恰好 3 段数字；解析失败返回 None
pub fn parse_version(v: &str) -> Option<Version> {
    let s = v.trim().trim_start_matches(['v', 'V']);
    // 忽略 +build 元数据（不影响优先级比较）
    let s = s.split('+').next().unwrap_or(s);
    // 核心段与 prerelease 以第一个 '-' 分隔
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (s, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None; // 核心段多于 3 段
    }
    let pre = match pre {
        None => Vec::new(),
        Some(p) => {
            let mut ids = Vec::new();
            for id in p.split('.') {
                if id.is_empty() {
                    return None;
                }
                ids.push(if id.chars().all(|c| c.is_ascii_digit()) {
                    PreId::Num(id.parse().ok()?)
                } else {
                    PreId::Alpha(id.to_string())
                });
            }
            ids
        }
    };
    Some(Version {
        major,
        minor,
        patch,
        pre,
    })
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Version {
    /// 同一演进线：major/minor/patch 三段全等（prerelease 任意）。dsh 上游
    /// 以 x.y.z 为独立演进线滚动 rc（0.1.0-rc.N → 0.1.1-rc.N），跨线会
    /// 重排插件接口与数据格式；按 semver 范围（^0.1.0-rc.8 覆盖 0.1.1）
    /// 放行是错的。
    pub fn same_line(&self, other: &Version) -> bool {
        self.major == other.major && self.minor == other.minor && self.patch == other.patch
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        for (a, b) in [
            (self.major, other.major),
            (self.minor, other.minor),
            (self.patch, other.patch),
        ] {
            match a.cmp(&b) {
                Ordering::Equal => {}
                o => return o,
            }
        }
        // 核心相同：无 prerelease 的发布版 > 有 prerelease 的候选版
        match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, true) => return Ordering::Equal,
            (true, false) => return Ordering::Greater,
            (false, true) => return Ordering::Less,
            (false, false) => {}
        }
        // 逐标识符比较：数字 < 字母数字；数字按数值、字母数字按 ASCII 字典序
        for (a, b) in self.pre.iter().zip(&other.pre) {
            let ord = match (a, b) {
                (PreId::Num(x), PreId::Num(y)) => x.cmp(y),
                (PreId::Num(_), PreId::Alpha(_)) => Ordering::Less,
                (PreId::Alpha(_), PreId::Num(_)) => Ordering::Greater,
                (PreId::Alpha(x), PreId::Alpha(y)) => x.cmp(y),
            };
            if ord != Ordering::Equal {
                return ord;
            }
        }
        // 前缀相同：标识符少的优先级低（rc.6 < rc.6.1）
        self.pre.len().cmp(&other.pre.len())
    }
}

/// cur < latest 才算有更新；任一侧解析失败按无更新处理
#[allow(dead_code)]
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// 范围比较子操作符
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RangeOp {
    Exact,
    Gte,
    Lte,
    Gt,
    Lt,
    Caret,
    Tilde,
}

/// 单个比较子 →（操作符, 目标版本原文）。操作符与其版本被空白拆开的形态
/// （`>= 0.1.1`）由 satisfies_range 先合并 token，这里目标恒非空
fn parse_comparator(part: &str) -> (RangeOp, &str) {
    for (prefix, op) in [
        (">=", RangeOp::Gte),
        ("<=", RangeOp::Lte),
        ("^", RangeOp::Caret),
        ("~", RangeOp::Tilde),
        (">", RangeOp::Gt),
        ("<", RangeOp::Lt),
    ] {
        if let Some(rest) = part.strip_prefix(prefix) {
            return (op, rest);
        }
    }
    (RangeOp::Exact, part)
}

/// ^ 的上界：进位到下一个非零段的进位点（^1.2.3 → <2.0.0、^0.1.2 → <0.2.0、
/// ^0.0.2 → <0.0.3）。u64 末端饱和，不因畸形超大版本 panic
fn caret_upper(t: &Version) -> Version {
    if t.major > 0 {
        Version {
            major: t.major.saturating_add(1),
            minor: 0,
            patch: 0,
            pre: Vec::new(),
        }
    } else if t.minor > 0 {
        Version {
            major: 0,
            minor: t.minor.saturating_add(1),
            patch: 0,
            pre: Vec::new(),
        }
    } else {
        Version {
            major: 0,
            minor: 0,
            patch: t.patch.saturating_add(1),
            pre: Vec::new(),
        }
    }
}

/// ~ 的上界：minor 进位（~1.2.3 → <1.3.0）
fn tilde_upper(t: &Version) -> Version {
    Version {
        major: t.major,
        minor: t.minor.saturating_add(1),
        patch: 0,
        pre: Vec::new(),
    }
}

/// 一个比较子的判定。读不懂（残缺段、x-range 部分形式）返回 None
fn comparator_matches(v: &Version, part: &str) -> Option<bool> {
    if matches!(part, "*" | "x" | "X") {
        return Some(true);
    }
    let (op, target) = parse_comparator(part);
    let t = parse_version(target)?;
    Some(match op {
        RangeOp::Exact => v == &t,
        RangeOp::Gte => v >= &t,
        RangeOp::Lte => v <= &t,
        RangeOp::Gt => v > &t,
        RangeOp::Lt => v < &t,
        RangeOp::Caret => v >= &t && v < &caret_upper(&t),
        RangeOp::Tilde => v >= &t && v < &tilde_upper(&t),
    })
}

/// 插件声明的 dsh 版本范围判定（npm range 子集，语义对齐官方市场 dsh-market
/// discovery 门禁的 satisfiesRange）：
/// - `||` 分支任一命中即满足；分支内空白分隔的比较子全部满足才满足；
///   操作符与其版本被空白拆开时（`>= 0.1.1`）并入前一个 token。
/// - 比较子：`^` `~` `>=` `<=` `>` `<`、裸版本（精确匹配）、`*`/`x`（恒真）。
/// - prerelease 按纯序参与比较，不设 npm 的「同元组 prerelease 比较子」
///   准入门：dsh 发布线全是 prerelease，严格门会把跨线升级大面积误杀
///   （与 `>=X` 时代「0.1.2-rc.2 满足 >=0.1.0-rc.8」的既定语义一致）。
///
/// 读不懂的形态（残缺段、悬空 `||` 产生的空分支、未知协议前缀）一律
/// false——读不懂的声明约束不能装作满足（fail closed）
pub fn satisfies_range(version: &str, range: &str) -> bool {
    let Some(v) = parse_version(version) else {
        return false;
    };
    range.split("||").any(|alt| {
        // 悬空 `||` 的空分支不按空合取恒真处理
        let mut parts = alt.split_whitespace().peekable();
        if parts.peek().is_none() {
            return false;
        }
        // 操作符与其版本被空白拆开时并入前一个 token；畸形串（连续操作符、
        // 孤立操作符结尾）自然变成读不懂的目标 → None → false
        let mut merged: Vec<String> = Vec::new();
        for part in parts {
            match merged.last_mut() {
                Some(last) if matches!(last.as_str(), ">=" | "<=" | ">" | "<" | "^" | "~") => {
                    last.push_str(part);
                }
                _ => merged.push(part.to_string()),
            }
        }
        merged
            .iter()
            .map(|part| comparator_matches(&v, part))
            .collect::<Option<Vec<_>>>()
            .is_some_and(|results| results.iter().all(|&r| r))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_basic() {
        assert_eq!(
            parse_version("1.2.3"),
            Some(Version {
                major: 1,
                minor: 2,
                patch: 3,
                pre: vec![]
            })
        );
        assert_eq!(
            parse_version("v1.2.3"),
            Some(Version {
                major: 1,
                minor: 2,
                patch: 3,
                pre: vec![]
            })
        );
        assert_eq!(
            parse_version(" 1.2.3 "),
            Some(Version {
                major: 1,
                minor: 2,
                patch: 3,
                pre: vec![]
            })
        );
    }

    #[test]
    fn parse_prerelease_and_build() {
        // dsh 实际版本形如 0.1.0-rc.6
        assert_eq!(
            parse_version("0.1.0-rc.6"),
            Some(Version {
                major: 0,
                minor: 1,
                patch: 0,
                pre: vec![PreId::Alpha("rc".into()), PreId::Num(6)],
            })
        );
        // +build 被忽略，不影响解析结果
        assert_eq!(parse_version("1.2.3+build.5"), parse_version("1.2.3"));
    }

    #[test]
    fn parse_invalid() {
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("a.b.c"), None);
        assert_eq!(parse_version("1.2.x"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("1.2.3-"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
    }

    #[test]
    fn same_line_judgement() {
        let rc6 = parse_version("0.1.0-rc.6").unwrap();
        let rc9 = parse_version("0.1.0-rc.9").unwrap();
        let stable = parse_version("0.1.0").unwrap();
        let next_minor = parse_version("0.1.1-rc.2").unwrap();
        let next_major = parse_version("1.0.0").unwrap();
        assert!(rc6.same_line(&rc9));
        assert!(rc6.same_line(&stable));
        assert!(!rc6.same_line(&next_minor));
        assert!(!rc6.same_line(&next_major));
    }

    #[test]
    fn is_newer_core() {
        assert!(is_newer("1.2.3", "1.2.2"));
        assert!(is_newer("1.3.0", "1.2.9"));
        assert!(is_newer("2.0.0", "1.9.9"));
        // 相同 / 已装更新 → 无更新
        assert!(!is_newer("1.2.3", "1.2.3"));
        assert!(!is_newer("1.2.2", "1.2.3"));
        // 任一侧解析失败 → 无更新
        assert!(!is_newer("v1.2.3", "abc"));
        assert!(!is_newer("", "1.2.3"));
    }

    #[test]
    fn is_newer_prerelease() {
        // 发布版 > 同版本 prerelease（rc.6 有新 0.1.0 稳定版即视为可更新）
        assert!(is_newer("0.1.0", "0.1.0-rc.6"));
        assert!(!is_newer("0.1.0-rc.6", "0.1.0"));
        // prerelease 之间比较
        assert!(is_newer("0.1.0-rc.7", "0.1.0-rc.6"));
        assert!(is_newer("0.1.0-rc.10", "0.1.0-rc.9"));
        assert!(is_newer("0.1.0-beta.2", "0.1.0-alpha.10"));
        // 相同
        assert!(!is_newer("0.1.0-rc.6", "0.1.0-rc.6"));
        // 标识符少者旧：rc.6 < rc.6.1
        assert!(is_newer("0.1.0-rc.6.1", "0.1.0-rc.6"));
    }

    #[test]
    fn satisfies_range_caret_and_tilde() {
        // npm caret 上界：进位到下一个非零段
        assert!(satisfies_range("0.1.9", "^0.1.2"));
        assert!(!satisfies_range("0.2.0", "^0.1.2"));
        assert!(satisfies_range("1.9.9", "^1.2.3"));
        assert!(!satisfies_range("2.0.0", "^1.2.3"));
        // 0.0.x 线：patch 位即进位点，^0.0.2 只容 0.0.2 自身
        assert!(satisfies_range("0.0.2", "^0.0.2"));
        assert!(!satisfies_range("0.0.3", "^0.0.2"));
        // tilde 上界：minor 进位
        assert!(satisfies_range("0.1.9", "~0.1.2"));
        assert!(!satisfies_range("0.2.0", "~0.1.2"));
    }

    #[test]
    fn satisfies_range_prerelease_plain_order() {
        // 同元组：prerelease 与声明同版本即满足
        assert!(satisfies_range("0.1.6-alpha.1", "^0.1.6-alpha.1"));
        // 跨线更高 prerelease 照纯序放行（npm 严格门会拒——刻意不设）
        assert!(satisfies_range("0.1.2-rc.2", ">=0.1.0-rc.8"));
        // prerelease < 同元组发布版：0.2.0-rc.1 < 0.2.0，落在 ^0.1.x 上界内
        // （includePrerelease 的既定代价，与 dsh-market discovery 对齐）
        assert!(satisfies_range("0.2.0-rc.1", "^0.1.5"));
    }

    #[test]
    fn satisfies_range_union_and_conjunction() {
        assert!(satisfies_range("0.1.2", "^0.1.0 || ^0.2.0"));
        assert!(satisfies_range("0.2.1", "^0.1.0 || ^0.2.0"));
        assert!(!satisfies_range("0.3.0", "^0.1.0 || ^0.2.0"));
        // 分支内空白合取
        assert!(satisfies_range("0.1.5", ">=0.1.2-rc.1 <0.2.0"));
        assert!(!satisfies_range("0.2.0", ">=0.1.2-rc.1 <0.2.0"));
        // `*` 恒真（宿主可解析为前提）
        assert!(satisfies_range("0.1.6-alpha.1", "*"));
        // 操作符与版本写开：token 合并后照常求值
        assert!(satisfies_range("0.1.5", ">= 0.1.1 < 0.2.0"));
    }

    #[test]
    fn satisfies_range_exact_and_fail_closed() {
        // 裸版本按精确匹配
        assert!(satisfies_range("0.1.2", "0.1.2"));
        assert!(!satisfies_range("0.1.3", "0.1.2"));
        assert!(!satisfies_range("0.1.2-rc.1", "0.1.2"));
        // 读不懂 → fail closed：宿主不可解析 / 残缺段 / 未知协议 / 悬空 ||
        assert!(!satisfies_range("not-a-version", "*"));
        assert!(!satisfies_range("0.1.2", "1.2"));
        assert!(!satisfies_range("0.1.2", "workspace:^0.1.2"));
        assert!(!satisfies_range("0.1.2", "catalog:default"));
        assert!(!satisfies_range("0.1.1", "^0.1.2 ||"));
        assert!(!satisfies_range("0.1.2", ""));
        // 孤立操作符结尾 / 连续操作符：目标读不懂
        assert!(!satisfies_range("0.1.2", "0.1.1 >="));
        assert!(!satisfies_range("0.1.2", ">= <0.2.0"));
    }
}
