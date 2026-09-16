// Rust 消息（模板 key + 参数）的解析点回归。
//
// 锁定的语义：命中词典用译文并按参数插值；miss 时用同一组参数就地填出英文
// 原文（绝不能把 {{name}} 露给用户）；嵌套参数继续走词典；纯字符串载荷（技术
// 文案 / 尚未迁移的旧契约）原样显示，且其中的 `{{...}}` 不被当成插值模板吃掉。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { i18n } from "./index";
import { renderMessage, tErr } from "./error";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("renderMessage", () => {
  it("resolves a dictionary template and interpolates its args", () => {
    expect(
      renderMessage({ key: "Failed to read config file: {{error}}", args: { error: "ENOENT" } }),
    ).toBe("读取配置文件失败: ENOENT");
    expect(
      renderMessage({
        key: "Installed dsh version {{actual}}, but this Launcher requires {{expected}}",
        args: { actual: "0.1.6", expected: "0.1.6-alpha.1" },
      }),
    ).toBe("已安装 dsh 0.1.6，但当前 Launcher 需要 0.1.6-alpha.1");
  });

  it("falls back to filled-in English when the dictionary has no entry", () => {
    // 词典 miss 也必须填参：露 {{name}} 比不翻译更糟
    expect(
      renderMessage({ key: "Vendor probe failed: {{detail}}", args: { detail: "EIO" } }),
    ).toBe("Vendor probe failed: EIO");
  });

  it("renders nested messages through the dictionary too", () => {
    // 外层无译文，内层是词典里有的固定文案 → 内层仍要翻成中文
    expect(
      renderMessage({
        key: "Rollback: {{reason}}",
        args: { reason: { key: "dsh web is running on 127.0.0.1:3899", args: {} } },
      }),
    ).toBe("Rollback: dsh Web 已运行在 127.0.0.1:3899");
  });

  it("leaves plain strings untouched and never interpolates them", () => {
    // 技术性文案整串即 key：词典 miss → 原样（含 {{...}} 的技术片段）
    expect(renderMessage('Failed to parse {"refs":{{}}}')).toBe('Failed to parse {"refs":{{}}}');
    expect(renderMessage("dsh web is running on 127.0.0.1:3899")).toBe(
      "dsh Web 已运行在 127.0.0.1:3899",
    );
  });

  it("accepts the legacy string shape and tolerates junk", () => {
    expect(renderMessage(null)).toBe("");
    expect(renderMessage(undefined)).toBe("");
  });
});

describe("tErr", () => {
  it("renders both the Message shape and bare strings", () => {
    expect(tErr({ key: "Repair failed: {{error}}", args: { error: "denied" } })).toContain("denied");
    expect(tErr("Untranslated technical text")).toBe("Untranslated technical text");
  });
});
