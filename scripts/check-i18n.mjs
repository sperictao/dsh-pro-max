#!/usr/bin/env node
// i18n 覆盖校验（本地与 CI 共用）：
//   前端：src 下所有 t("...") 静态 key 必须存在于 en.ts 词典
//         （zh-CN.ts 由 Record<I18nKey, string> 编译期保证与 en 同步）
//   Rust：src-tauri/src 下所有 tr(...)/trf("...") 静态 key 必须存在于
//         i18n.rs 的 zh_cn 表；表中无任何源码引用的条目视为死 key（防漂移）
//   白名单：i18n.rs 测试里的夹具 key（刻意不翻译，验证回退行为）
// 用法：node scripts/check-i18n.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// i18n.rs 测试夹具：验证「未翻译 key 原样返回」的回退行为，不属于产品文案
const RUST_TEST_FIXTURES = new Set(["Untranslated Key", "Path does not exist: {path}"]);

const failures = [];
const stringLit = /^\s*"((?:[^"\\]|\\.)*)"/;

// —— 前端：t("...") ⊆ en.ts ——
const enSrc = readFileSync("src/shared/i18n/en.ts", "utf8");
const dictKeys = new Set(
  [...enSrc.matchAll(/^\s*"((?:[^"\\]|\\.)*)":/gm)].map((m) => m[1]),
);

function* walk(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) {
      if (f.name !== "i18n") yield* walk(p);
    } else if (/\.tsx?$/.test(f.name) && !f.name.endsWith(".test.ts")) {
      yield p;
    }
  }
}

for (const p of walk("src")) {
  const src = readFileSync(p, "utf8");
  for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    if (!dictKeys.has(m[1])) {
      failures.push(`前端缺词典 key: ${JSON.stringify(m[1])}（${p}）`);
    }
  }
}

// —— Rust：tr/trf ⊆ zh_cn 表；表中无死 key ——
const i18nPath = "src-tauri/src/i18n.rs";
const i18nSrc = readFileSync(i18nPath, "utf8");
const tableEntries = [];
i18nSrc.split("\n").forEach((line, i) => {
  const m = line.match(/^\s*"((?:[^"\\]|\\.)*)"\s*=>/);
  if (m) tableEntries.push({ key: m[1], line: i + 1 });
});
const tableKeys = new Set(tableEntries.map((e) => e.key));

const rustSources = readdirSync("src-tauri/src")
  .filter((f) => f.endsWith(".rs"))
  .map((f) => ({ file: `src-tauri/src/${f}`, src: readFileSync(`src-tauri/src/${f}`, "utf8") }));

for (const { file, src } of rustSources) {
  for (const m of src.matchAll(/\btrf?\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    if (!tableKeys.has(m[1]) && !RUST_TEST_FIXTURES.has(m[1])) {
      failures.push(`Rust 缺翻译: ${JSON.stringify(m[1])}（${file}）`);
    }
  }
}

for (const e of tableEntries) {
  if (RUST_TEST_FIXTURES.has(e.key)) continue;
  const quoted = `"${e.key}"`;
  const referenced = rustSources.some(({ file, src }) => {
    let idx = 0;
    while ((idx = src.indexOf(quoted, idx)) !== -1) {
      const lineNo = src.slice(0, idx).split("\n").length;
      idx += quoted.length;
      // 表定义自身不算引用
      if (file === i18nPath && lineNo === e.line) continue;
      return true;
    }
    return false;
  });
  if (!referenced) {
    failures.push(`Rust i18n 表死 key（无任何源码引用）: ${JSON.stringify(e.key)}（i18n.rs:${e.line}）`);
  }
}

if (failures.length > 0) {
  console.error(`✗ i18n 校验失败（${failures.length} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ i18n 校验通过：前端 ${dictKeys.size} key，Rust 表 ${tableEntries.length} 条，无缺失无死 key`);
