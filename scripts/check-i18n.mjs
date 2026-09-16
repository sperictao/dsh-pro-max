#!/usr/bin/env node
// i18n 覆盖校验（本地与 CI 共用）：
//
//   1. 前端：src 下所有 t("...") 静态 key 必须存在于 en.ts 词典
//      （zh-CN.ts 由 Record<I18nKey, string> 编译期保证与 en 同步）
//   2. Rust：src-tauri/src 下所有 tr(...)/trf("...") 静态 key 必须存在于
//      i18n.rs 的 zh_cn 小表；表中无任何源码引用的条目视为死 key（防漂移）
//   3. Rust：所有 Message::key("...") / Message::localized("...") 的字面量 key
//      必须存在于 en.ts 词典——它们是前端唯一能本地化的形态，漏词典就等于
//      中文界面显示英文（与规则 1 是同一约束的两侧）
//   4. 词典无死条目：一个 key 可达 ⟺ 前端面量 ∪ Rust 面量（技术文案整串即 key，
//      也是 Message 的 key）∪ 运行期拼出的 step.<id> 家族
//
// Rust 的 #[cfg(test)] 模块整体排除：那里的 key 是夹具，不该给词典条目续命，
// 也不该要求词典收留它们。i18n.rs 的托盘小表夹具见 RUST_TEST_FIXTURES。
// 用法：node scripts/check-i18n.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// i18n.rs 测试夹具：验证「未翻译 key 原样返回」的回退行为，不属于产品文案
const RUST_TEST_FIXTURES = new Set(["Untranslated Key", "Path does not exist: {path}"]);

// 运行期拼出的 key 家族：Rust format!("step.{id}") / 前端 `step.${id}`
const DYNAMIC_KEY_PREFIXES = ["step."];

const failures = [];

function unescape(lit) {
  let out = "";
  for (let i = 0; i < lit.length; i++) {
    if (lit[i] === "\\") {
      const next = lit[++i];
      out += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
    } else out += lit[i];
  }
  return out;
}

function literalsIn(src) {
  const set = new Set();
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) set.add(unescape(m[1]));
  return set;
}

/// 去掉每个 #[cfg(test)] mod ... { ... } 块（花括号配对；Rust 里测试模块通常
/// 在文件末尾，但不假设它一定在末尾）
function stripTestModules(src) {
  let out = "";
  let cursor = 0;
  while (true) {
    const cfg = src.indexOf("#[cfg(test)]", cursor);
    if (cfg === -1) break;
    const modMatch = /\bmod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.exec(src.slice(cfg));
    if (!modMatch) break;
    let depth = 0;
    let i = cfg + modMatch.index + modMatch[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out += src.slice(cursor, cfg);
    cursor = i + 1;
  }
  out += src.slice(cursor);
  return out;
}

// —— 词典 ——
const enSrc = readFileSync("src/shared/i18n/en.ts", "utf8");
const dictKeys = new Set(
  [...enSrc.matchAll(/^\s*"((?:[^"\\]|\\.)*)":/gm)].map((m) => unescape(m[1])),
);

// —— 前端源码（排除 i18n 目录与测试）——
function* walk(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) {
      if (f.name !== "i18n") yield* walk(p);
    } else if (/\.tsx?$/.test(f.name) && !/\.test\.tsx?$/.test(f.name)) {
      yield p;
    }
  }
}

const frontendSources = [...walk("src")].map((file) => ({
  file,
  src: readFileSync(file, "utf8"),
}));

// 规则 1：t("...") ⊆ 词典
for (const { file, src } of frontendSources) {
  for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const key = unescape(m[1]);
    if (!dictKeys.has(key)) failures.push(`前端缺词典 key: ${JSON.stringify(key)}（${file}）`);
  }
}

// —— Rust 源码 ——
const i18nPath = "src-tauri/src/i18n.rs";

function* walkRust(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) yield* walkRust(p);
    else if (f.name.endsWith(".rs")) yield p;
  }
}

// tests.rs 整个文件都是测试代码（由 mod.rs 的 #[cfg(test)] mod tests 引入），
// 按测试块处理：不参与词典要求，也不给词典条目续命
const rustSources = [...walkRust("src-tauri/src")].map((file) => {
  const raw = readFileSync(file, "utf8");
  const isTestFile = file.endsWith("tests.rs");
  return { file, raw, src: isTestFile ? "" : stripTestModules(raw) };
});

// 规则 2：tr/trf ⊆ 托盘小表；小表无死 key
const i18nRaw = rustSources.find((s) => s.file === i18nPath)?.raw ?? "";
const tableEntries = [];
i18nRaw.split("\n").forEach((line, i) => {
  const m = line.match(/^\s*"((?:[^"\\]|\\.)*)"\s*=>/);
  if (m) tableEntries.push({ key: unescape(m[1]), line: i + 1 });
});
const tableKeys = new Set(tableEntries.map((e) => e.key));

for (const { file, src } of rustSources) {
  for (const m of src.matchAll(/\btrf?\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const key = unescape(m[1]);
    if (!tableKeys.has(key) && !RUST_TEST_FIXTURES.has(key)) {
      failures.push(`Rust 缺托盘翻译: ${JSON.stringify(key)}（${file}）`);
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
      if (file === i18nPath && lineNo === e.line) continue; // 表定义自身不算引用
      return true;
    }
    return false;
  });
  if (!referenced) {
    failures.push(`托盘 i18n 表死 key（无任何源码引用）: ${JSON.stringify(e.key)}（i18n.rs:${e.line}）`);
  }
}

// 规则 3：Rust Message 字面量 key ⊆ 词典
for (const { file, src } of rustSources) {
  if (file === i18nPath) continue; // 托盘小表与夹具不在词典域
  for (const m of src.matchAll(/Message::(?:key|localized)\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const key = unescape(m[1]);
    if (!dictKeys.has(key)) {
      failures.push(`Rust 消息缺词典 key: ${JSON.stringify(key)}（${file}）`);
    }
  }
}

// 规则 4：词典无死条目
const reachable = new Set();
for (const { src } of frontendSources) for (const s of literalsIn(src)) reachable.add(s);
for (const { src } of rustSources) for (const s of literalsIn(src)) reachable.add(s);

for (const key of dictKeys) {
  if (DYNAMIC_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
  if (reachable.has(key)) continue;
  failures.push(`词典死 key（前端与 Rust 均无产出）: ${JSON.stringify(key)}`);
}

if (failures.length > 0) {
  console.error(`✗ i18n 校验失败（${failures.length} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `✓ i18n 校验通过：前端 ${dictKeys.size} key，托盘表 ${tableEntries.length} 条，无缺失无死 key`,
);
