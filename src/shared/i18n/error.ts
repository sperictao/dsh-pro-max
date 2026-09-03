// shared/i18n 错误面：Rust 命令的 Err 过 IPC 时是「本地化前的稳定 key（可含
// 已插值的技术细节）」；前端 i18n.t 是唯一解析点。Rust 用户可见文案的 key
// 与其英文原文相同，因此 en 界面原样可读、zh-CN 查表翻译、缺失落回原文。
//
// 「key 即英文原文」是两侧的共同契约：en 词典恒等映射，zh-CN 词典按同 key
// 提供中文。词典 miss 时 i18next 回退 key 原文（英文）——漂移从「静默双语
// 混杂」变为「可查到的 key miss」。

import { i18n } from "./index";

/// 渲染 Rust 命令错误（Err(String) / 状态载荷中的错误字段）。
/// 语义 = i18n.t(key)：key 即英文原文，zh-CN 命中即中文，未命中如实显示原文
export function tErr(rustError: string): string {
  return i18n.t(rustError);
}
