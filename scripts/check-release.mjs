#!/usr/bin/env node
// 发布前置校验（本地打 tag 前与 CI validate job 共用）：
//   必查：package.json / tauri.conf.json / Cargo.toml 三处版本号一致
//   必查：tauri.conf.json bundle.resources 中被 git 跟踪的源路径真实存在
//         （v1.3.2 曾漏打包 skills/ 导致安装技能失败，见 AGENTS.md。
//         dist/web 等构建产物被 gitignore，CI validate 阶段尚未构建，
//         只对 git 已跟踪的路径做存在性校验）
//   必查：bridge.rs 钉住的桥接版本已在 npm registry 上（钉一个没发布的版本，用户粘进
//         桌面应用就是 404；同类事故见 AGENTS.md 的 v0.5.3。需要联网，查不到即失败）
//   --tag <vX.Y.Z>：追加校验 tag 与版本一致 + release-notes/<tag>.md 存在
// 用法：node scripts/check-release.mjs [--tag v0.12.2]
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const read = (p) => readFileSync(p, "utf8");

const pkgVersion = JSON.parse(read("package.json")).version;
const tauriConfPath = "src-tauri/tauri.conf.json";
const tauriConf = JSON.parse(read(tauriConfPath));
const tauriVersion = tauriConf.version;
const cargoVersion = read("src-tauri/Cargo.toml").match(/^version = "([^"]+)"$/m)?.[1];
// Cargo.lock 也记录 workspace 包自身的版本，且 cargo 会在任意命令里就地改写它。
// bump 上面三处却漏了它，之后每次 cargo test 都会留下假脏 diff，CI 的
// generated-artifacts 守卫也会红。
const lockVersion = read("src-tauri/Cargo.lock").match(
  /\[\[package\]\]\nname = "dsh-pro-max"\nversion = "([^"]+)"/,
)?.[1];

const failures = [];
if (!cargoVersion) {
  failures.push("src-tauri/Cargo.toml 找不到 version 字段");
}
if (pkgVersion !== tauriVersion || tauriVersion !== cargoVersion) {
  failures.push(
    `版本号三处不一致：package.json=${pkgVersion} tauri.conf.json=${tauriVersion} Cargo.toml=${cargoVersion}`,
  );
}
if (!lockVersion) {
  failures.push("src-tauri/Cargo.lock 找不到 dsh-pro-max 的 package 版本");
} else if (lockVersion !== pkgVersion) {
  failures.push(
    `src-tauri/Cargo.lock 版本号未同步：Cargo.lock=${lockVersion}，期望 ${pkgVersion}（跑一次 cargo check 就地同步后一并提交）`,
  );
}

// bundle.resources 的源路径（map 的 key）必须存在。../vendor/... 相对 tauri.conf.json 所在目录解析。
// dist/web 等构建产物被 gitignore，CI validate job 在构建前运行、产物尚不存在，
// 因此只对 git 已跟踪的路径做存在性校验（能拦下 skills/ 这种仓库内资源漏打包）。
const isGitTracked = (abs) => {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", abs], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};
const tauriDir = dirname(tauriConfPath);
const resources = tauriConf.bundle?.resources ?? {};
const resourceEntries =
  typeof resources === "object" && !Array.isArray(resources) ? Object.keys(resources) : resources;
for (const src of resourceEntries) {
  const abs = resolve(tauriDir, src);
  if (isGitTracked(abs) && !existsSync(abs)) {
    failures.push(`bundle.resources 源路径不存在（git 已跟踪）：${src}（解析为 ${abs}）`);
  }
}

// 桥接 pin：包名与版本的唯一事实来源是 bridge.rs 的两个常量，这里只读不抄。
// 锚点抽不到必须报错——静默跳过就等于这道校验不存在
const bridgeSource = read("src-tauri/src/dsh/bridge.rs");
// 可见性不进匹配条件：常量被别的模块引用而改成 pub(crate) 时，校验不该跟着失明
const bridgePackage = bridgeSource.match(/^(?:pub\(crate\) )?const BRIDGE_PACKAGE: &str = "([^"]+)";$/m)?.[1];
const bridgeVersion = bridgeSource.match(/^(?:pub\(crate\) )?const BRIDGE_VERSION: &str = "([^"]+)";$/m)?.[1];
if (!bridgePackage || !bridgeVersion) {
  failures.push("src-tauri/src/dsh/bridge.rs 找不到 BRIDGE_PACKAGE / BRIDGE_VERSION 常量");
} else {
  const spec = `${bridgePackage}@${bridgeVersion}`;
  // 查版本端点而不是 `npm view`：后者取整份 packument，那个端点会被 CDN 负缓存——
  // 发布前查过一次 404，发布后几分钟内仍返回 404（2026-10-01 实测），版本端点不受影响
  const url = `https://registry.npmjs.org/${bridgePackage.replace("/", "%2f")}/${bridgeVersion}`;
  try {
    const response = await fetch(url);
    const published = response.ok ? (await response.json()).version : null;
    if (published !== bridgeVersion) {
      failures.push(`桥接 pin ${spec} 不在 npm registry 上（HTTP ${response.status}）：先发布桥接再发应用`);
    }
  } catch (error) {
    failures.push(`桥接 pin ${spec} 查询失败（无法联网？）：${error.message}`);
  }
}

const tagIdx = process.argv.indexOf("--tag");
const tag = tagIdx !== -1 ? process.argv[tagIdx + 1] : null;
if (tag) {
  if (tag !== `v${pkgVersion}`) {
    failures.push(`tag ${tag} 与版本号 v${pkgVersion} 不一致`);
  }
  const notesPath = `release-notes/${tag}.md`;
  if (!existsSync(notesPath)) {
    failures.push(`缺少 release notes：${notesPath}（build-release.yml 强制要求，见 AGENTS.md）`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((f) => `✗ ${f}`).join("\n"));
  process.exit(1);
}
console.log(`✓ 发布校验通过：v${pkgVersion}${tag ? `（tag ${tag}）` : ""}`);
