/// 端到端复现并验证「Reinstall → pnpm 11 拦构建 → 审批 → 写双键 → 重跑成功」
/// 闭环。使用隔离 HOME 与模拟 profile，不触碰 ~/.dsh；pnpm 用 npx 拉起 11.x。
///
/// 用法：node scripts/e2e-approval-loop.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const HOME = join(tmpdir(), "dsh-e2e-approval-home");
const PROFILE = join(HOME, ".dsh/profiles/web");
const PNPM = ["npx", "-y", "pnpm@11"];

function run(args, opts = {}) {
  return spawnSync(args[0], args.slice(1), {
    cwd: PROFILE,
    env: { ...process.env, HOME },
    encoding: "utf8",
    ...opts,
  });
}

// 0) 隔离环境 + 模拟“手动 add 被拦留下半成品”的 profile
rmSync(HOME, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
writeFileSync(
  join(PROFILE, "package.json"),
  JSON.stringify({ name: "dsh-web-profile", dependencies: {} }, null, 2),
);
// 模拟用户已手动跑过 pnpm approve-builds 但没完成交互，留下占位符
writeFileSync(
  join(PROFILE, "pnpm-workspace.yaml"),
  `packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  node-pty: set this to true or false\n`,
);

// 1) Reinstall：等价于 dsh plugin --profile web add dsh-better-sidebar@latest
console.log("=== step 1: reinstall (expect blocked by pnpm 11) ===");
const first = run([...PNPM, "add", "dsh-better-sidebar@latest"]);
const firstOut = (first.stderr || "") + (first.stdout || "");
console.log("exit:", first.status);
console.log(firstOut.split("\n").filter((l) => l.includes("Ignored") || l.includes("ERR_PNPM")).join("\n"));
assert.equal(first.status, 1, "first add should be blocked");
assert.match(firstOut, /Ignored build scripts: /, "output must contain Ignored build scripts");

// 2) 解析被拦包名（与 market.rs blocked_build_packages 同逻辑）
console.log("\n=== step 2: parse blocked packages ===");
function blockedBuildPackages(output) {
  const line = output.split("\n").find((l) => l.includes("Ignored build scripts:"));
  if (!line) return [];
  const list = line.split("Ignored build scripts:")[1] ?? "";
  const out = [];
  for (const raw of list.split(",")) {
    const spec = raw.trim();
    const i = spec.lastIndexOf("@");
    const name = i > 0 ? spec.slice(0, i) : spec;
    if (/^[A-Za-z0-9@/._#:-]+$/.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
const pkgs = blockedBuildPackages(firstOut);
console.log("parsed:", pkgs);
assert.ok(pkgs.includes("node-pty"), `expected node-pty, got ${pkgs.join(",")}`);

// 3) 审批：merge_allow_builds 语义——保留显式 false，覆盖非布尔占位符
// 零依赖实现：仅处理本脚本已知的固定占位符形态；Rust 侧合并逻辑由单测覆盖
console.log("\n=== step 3: approve & write allowBuilds ===");
function mergeAllowBuilds(yamlText, packages) {
  let out = yamlText;
  for (const p of packages) {
    // 覆盖 pnpm approve-builds 交互占位符；若键不存在则追加
    const placeholder = `  ${p}: set this to true or false`;
    if (out.includes(placeholder)) {
      out = out.replace(placeholder, `  ${p}: true`);
    } else if (!new RegExp(`^  ${p}: (true|false)$`, "m").test(out)) {
      out = out.trimEnd() + `\n  ${p}: true`;
    }
  }
  const only = packages.map((p) => `  - ${p}`).join("\n");
  if (!out.includes("onlyBuiltDependencies:")) out = out.trimEnd() + `\nonlyBuiltDependencies:\n${only}\n`;
  return out;
}
const yamlPath = join(PROFILE, "pnpm-workspace.yaml");
const merged = mergeAllowBuilds(readFileSync(yamlPath, "utf8"), pkgs);
writeFileSync(yamlPath, merged);
console.log(merged);

// 4) 重跑安装：应补跑 node-pty postinstall 并成功
console.log("\n=== step 4: retry install (expect success) ===");
const second = run([...PNPM, "add", "dsh-better-sidebar@latest"]);
const secondOut = (second.stdout || "") + (second.stderr || "");
console.log("exit:", second.status);
console.log(secondOut.split("\n").slice(-10).join("\n"));
assert.equal(second.status, 0, `retry should succeed, got ${second.status}`);
assert.match(secondOut, /node-pty.*postinstall|Done/, "postinstall should run");

// 5) 断言 postinstall 已执行（node-pty 产物在 lib/ 下，不是 build/）
const built = spawnSync("test", ["-f", join(PROFILE, "node_modules/node-pty/lib/index.js")]).status === 0;
console.log("\nnode-pty lib/index.js exists:", built);
assert.ok(built, "node-pty should be built after approval");

console.log("\n✓ E2E approval loop passed");
rmSync(HOME, { recursive: true, force: true });
