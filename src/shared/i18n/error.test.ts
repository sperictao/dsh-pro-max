// Rust 诊断载荷的本地化解析点回归。
//
// 这些用例锁定的是「词典里有译文、渲染点却从不查表」这一类缺陷：时间轴的
// detail / problem / solution 由 Rust 产出，固定文案的行必须能整行命中词典
// 翻成中文，而带技术细节（已插值）的行必须原样显示——直接 t() 会把其中的
// `{{...}}` 当插值模板吃掉，把原始报错变成缺值的句子。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { i18n } from "./index";
import { tDiagnostic, tErr } from "./error";

// 词典里确有其译文的两条固定文案（Rust 侧同文产出）
const PNPM_MISSING =
  'pnpm was not found. Install it once ("corepack enable pnpm" or "npm install -g pnpm") and restart dsh, then retry.';
const STARTED = "dsh web is running on 127.0.0.1:3899";
// 含已插值细节的行：构造不出词典 key，必须原样保留
const DRIFT_LINE =
  "Incompatible plugin dsh-rewind-plugin: @deepseek-ai/dsh-session does not export decodeStorageRecord; the plugin will not load, and dsh aborts startup if its entry is required";
// 含 `{{` 的原始报错：不得被当成插值模板
const BRACE_BEARING = 'Failed to parse {"refs":{{}}}';

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("tDiagnostic", () => {
  it("fixed-text diagnostics resolve to the dictionary translation", () => {
    expect(tDiagnostic(PNPM_MISSING)).toBe(
      '找不到 pnpm。请安装一次（"corepack enable pnpm" 或 "npm install -g pnpm"）并重启 dsh，然后重试。',
    );
    expect(tDiagnostic(STARTED)).toBe("dsh Web 已运行在 127.0.0.1:3899");
  });

  it("localizes per line so appended disclosure lines keep their raw text", () => {
    expect(tDiagnostic(`${STARTED}\n${DRIFT_LINE}`)).toBe(
      `dsh Web 已运行在 127.0.0.1:3899\n${DRIFT_LINE}`,
    );
  });

  it("leaves unknown text byte-identical instead of interpolating it away", () => {
    expect(tDiagnostic(DRIFT_LINE)).toBe(DRIFT_LINE);
    expect(tDiagnostic(BRACE_BEARING)).toBe(BRACE_BEARING);
  });
});

describe("tErr", () => {
  it("translates dictionary keys and passes unknown text through untouched", () => {
    expect(tErr(PNPM_MISSING)).toContain("找不到 pnpm");
    expect(tErr(BRACE_BEARING)).toBe(BRACE_BEARING);
  });
});
