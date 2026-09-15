#!/usr/bin/env node
// i18n 覆盖校验（本地与 CI 共用）：
//   前端：src 下所有 t("...") 静态 key 必须存在于 en.ts 词典
//         （zh-CN.ts 由 Record<I18nKey, string> 编译期保证与 en 同步）
//   前端：en.ts 词典不得有死 key——「前端面量 ∪ Rust 面量 ∪ step.<id>
//         动态家族」之外的条目无人能产出。Rust 面量必须计入：诊断载荷
//         （时间轴 detail / problem / solution、Err 文案）由 Rust 产出，
//         前端源码里没有这些字面量，经 tErr/tDiagnostic 才查表
//   Rust：src-tauri/src 下所有 tr(...)/trf("...") 静态 key 必须存在于
//         i18n.rs 的 zh_cn 表；表中无任何源码引用的条目视为死 key（防漂移）
//   白名单：i18n.rs 测试里的夹具 key（刻意不翻译，验证回退行为）
//
// 待决项：词典里仍有一批 `{{name}}` 模板形态的 Rust 诊断文案。它们当前不可达
// ——Rust 侧 keyf 用单花括号且先把值插值好再发串，前端拿到的是成品句子，整行
// 命不中模板 key。要让它们生效需要把诊断载荷改成「模板 key + 参数」过 IPC
// （见仓库 issue/设计讨论），在此之前只报告、不判失败：这些条目的存在本身是
// 设计意图的证据，不该由校验脚本替所有者决定删还是实现。
// 用法：node scripts/check-i18n.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// i18n.rs 测试夹具：验证「未翻译 key 原样返回」的回退行为，不属于产品文案
const RUST_TEST_FIXTURES = new Set(["Untranslated Key", "Path does not exist: {path}"]);

const failures = [];

// —— 通用：源码里的字符串面量（含转义还原）——
// 词典 key 是「还原后的英文原文」，源文件里写的是带转义的形态，比较前两侧
// 都要还原，否则带引号的文案会假死
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

// —— 前端：t("...") ⊆ en.ts ——
const enSrc = readFileSync("src/shared/i18n/en.ts", "utf8");
const dictKeys = new Set(
  [...enSrc.matchAll(/^\s*"((?:[^"\\]|\\.)*)":/gm)].map((m) => unescape(m[1])),
);

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

for (const { file, src } of frontendSources) {
  for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const key = unescape(m[1]);
    if (!dictKeys.has(key)) {
      failures.push(`前端缺词典 key: ${JSON.stringify(key)}（${file}）`);
    }
  }
}

// —— Rust：tr/trf ⊆ zh_cn 表；表中无死 key ——
const i18nPath = "src-tauri/src/i18n.rs";
const i18nSrc = readFileSync(i18nPath, "utf8");
const tableEntries = [];
i18nSrc.split("\n").forEach((line, i) => {
  const m = line.match(/^\s*"((?:[^"\\]|\\.)*)"\s*=>/);
  if (m) tableEntries.push({ key: unescape(m[1]), line: i + 1 });
});
const tableKeys = new Set(tableEntries.map((e) => e.key));

function* walkRust(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) yield* walkRust(p);
    else if (f.name.endsWith(".rs")) yield p;
  }
}

const rustSources = [...walkRust("src-tauri/src")].map((file) => ({
  file,
  src: readFileSync(file, "utf8"),
}));

for (const { file, src } of rustSources) {
  for (const m of src.matchAll(/\btrf?\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const key = unescape(m[1]);
    if (!tableKeys.has(key) && !RUST_TEST_FIXTURES.has(key)) {
      failures.push(`Rust 缺翻译: ${JSON.stringify(key)}（${file}）`);
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

// —— 前端词典无死 key ——
// 可达面 = 前端面量 ∪ Rust 面量（测试文件不算：夹具不该给词典条目续命）
const reachable = new Set();
for (const { src } of frontendSources) for (const s of literalsIn(src)) reachable.add(s);
for (const { file, src } of rustSources) {
  if (file.endsWith("tests.rs")) continue;
  for (const s of literalsIn(src)) reachable.add(s);
}

const pendingTemplates = [];
for (const key of dictKeys) {
  // step.<id> 由两侧运行期拼出（Rust format!("step.{id}") / 前端 `step.${id}`）
  if (key.startsWith("step.")) continue;
  if (reachable.has(key)) continue;
  if (key.includes("{{")) {
    pendingTemplates.push(key);
    continue;
  }
  failures.push(`前端词典死 key（前端与 Rust 均无产出）: ${JSON.stringify(key)}`);
}

if (failures.length > 0) {
  console.error(`✗ i18n 校验失败（${failures.length} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ i18n 校验通过：前端 ${dictKeys.size} key，Rust 表 ${tableEntries.length} 条，无缺失无死 key`);
if (pendingTemplates.length > 0) {
  console.warn(
    `⚠ ${pendingTemplates.length} 条 {{name}} 模板形态的诊断文案当前不可达（Rust keyf 是单花括号且先插值）：` +
      `需把诊断载荷改为「模板 key + 参数」过 IPC 才会生效；在那之前它们既不判失败也不翻中文`,
  );
}
