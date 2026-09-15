// shared/i18n 错误面：Rust 命令的 Err 过 IPC 时是「本地化前的稳定 key（可含
// 已插值的技术细节）」；前端 i18n.t 是唯一解析点。Rust 用户可见文案的 key
// 与其英文原文相同，因此 en 界面原样可读、zh-CN 查表翻译、缺失落回原文。
//
// 「key 即英文原文」是两侧的共同契约：en 词典恒等映射，zh-CN 词典按同 key
// 提供中文。词典 miss 时 i18next 回退 key 原文（英文）——漂移从「静默双语
// 混杂」变为「可查到的 key miss」。

import { i18n } from "./index";

/// 渲染 Rust 命令错误（Err(String) / 状态载荷中的错误字段）。
/// 语义 = i18n.t(key)：key 即英文原文，zh-CN 命中即中文，未命中如实显示原文。
/// 先 exists 再 t：未命中时直接 t() 会把文案里可能出现的 `{{...}}`（JSON 片段、
/// 模板串）当插值模板吃掉，把原始报错改成空串
export function tErr(rustError: string): string {
  return i18n.exists(rustError) ? i18n.t(rustError) : rustError;
}

/// 渲染 Rust 产出的诊断载荷（时间轴节点的 detail / problem / solution）。
/// detail 是多行拼接（基线行 + 追加的披露行），故逐行解析：命中词典即本地化，
/// 未命中原样保留。Rust 已把技术细节（路径/版本/原始 stderr）插值进文案，
/// 这类行构造不出词典 key，如实显示英文就是设计的兜底；而只有固定文案的
/// 诊断行（如 pnpm 缺失提示）能整行命中词典，中文界面因此不必再看英文
export function tDiagnostic(rustText: string): string {
  return rustText
    .split("\n")
    .map((line) => (i18n.exists(line) ? i18n.t(line) : line))
    .join("\n");
}
