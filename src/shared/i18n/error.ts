// shared/i18n 错误面：Rust 的用户可见文案过 IPC 时一律是「模板 key + 参数」
// （bindings/Message）。前端是唯一解析点：
//   - 命中词典 → 用 args 插值成译文（zh-CN 词典是唯一事实来源）
//   - miss     → 用同一组 args 就地填出英文原文（en 兜底，不能露出 {{name}}）
// 技术性文案（路径、原始 stderr）整串就是 key、args 为空，原样显示。
//
// 为什么不再有「先把值插进句子」的形态：成品句子永远命不中词典里的模板 key，
// 那正是中文界面下带值诊断恒为英文的成因。参数必须作为数据随 key 一起过线。

import type { Message } from "../bindings/Message";
import type { MessageArg } from "../bindings/MessageArg";
import { i18n } from "./index";

export type { Message, MessageArg };

function isMessage(value: unknown): value is Message {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { key?: unknown }).key === "string"
  );
}

/// bindings 把 args 定为 `{ [key in string]?: MessageArg }`（Rust 总是序列化，
/// 但值可缺省），这里统一成可迭代形态
function argsOf(message: Message): Record<string, MessageArg | undefined> {
  return message.args ?? {};
}

/// 英文兜底：把 {{name}} 就地换成参数值（嵌套消息先各自渲染）。
/// 只有词典 miss 才走这里——命中词典时插值由 i18next 完成
function fillEnglish(key: string, args: Record<string, string>): string {
  return key.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in args ? args[name] : whole,
  );
}

/// 把参数渲染成 i18next 可插值的纯字符串：嵌套消息先递归解析，
/// 否则 i18next 会把对象插值成 "[object Object]"
function flattenArgs(message: Message): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(argsOf(message))) {
    if (value === undefined) continue;
    flat[name] = typeof value === "string" ? value : renderMessage(value);
  }
  return flat;
}

/// 把任意抛出值规整成 Message。用于类型就是 Message 的**状态字段**：存原文
/// （不预先渲染），渲染点仍走 renderMessage —— 语言切换时这些字段随重渲染
/// 一起换语言，而不是把当时的语言定格在字符串里
export function toMessage(value: unknown): Message {
  if (isMessage(value)) return value;
  if (typeof value === "string") return { key: value, args: {} };
  return { key: value === null || value === undefined ? "" : String(value), args: {} };
}

/// 渲染一条 Rust 消息（或历史遗留的纯字符串载荷）。
/// 先 exists 再 t：未命中时直接 t() 会把文案里可能出现的 `{{...}}` 当插值
/// 模板吃掉，把原始报错改成缺值的句子
export function renderMessage(value: unknown): string {
  if (typeof value === "string") {
    return i18n.exists(value) ? i18n.t(value) : value;
  }
  if (!isMessage(value)) {
    // 规整失败也不吞掉信息：如实显示，便于定位契约漂移
    return value === null || value === undefined ? "" : String(value);
  }
  const flat = flattenArgs(value);
  return i18n.exists(value.key) ? i18n.t(value.key, flat) : fillEnglish(value.key, flat);
}

/// 渲染 Rust 命令错误（Err）与状态载荷里的错误字段。
/// 参数是 unknown：IPC 拒绝值可能是 Message、也可能是本地抛出的 Error/字符串
export function tErr(rustError: unknown): string {
  return renderMessage(rustError);
}
