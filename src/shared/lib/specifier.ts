// specifier 语义解析的共享原语：视图（已装匹配）与 store（更新重装标识）
// 都要用，放 shared 避免反向依赖视图文件。Rust 侧 market.rs 的同名解析器
// 由 specifier_cases.json 向量表双端共同驱动，改一侧必须同步另一侧

/// GitHub 仓库标识归一：github:owner/repo 与 pnpm 落盘的
/// git+https://github.com/owner/repo.git 等形态 → "owner/repo"（小写，
/// GitHub 仓库地址大小写不敏感）；#fragment（#ref/#path:）与 .git 后缀剥离。
/// 非 GitHub 仓库形态返回 null。只用于匹配与重装标识派生，不碰落盘事实
/// （spec 原样展示）。Rust 侧 github_repo_id 同一套语义
export function githubRepoId(spec: string): string | null {
  const prefixes = [
    "github:",
    "git+https://github.com/",
    "https://github.com/",
    "git+ssh://git@github.com/",
    "ssh://git@github.com/",
    "git@github.com:",
  ];
  const rest = prefixes.find((p) => spec.startsWith(p));
  if (rest === undefined) return null;
  const body = spec
    .slice(rest.length)
    .split("#")[0]
    .replace(/\.git$/, "");
  const slash = body.indexOf("/");
  if (slash <= 0) return null;
  const owner = body.slice(0, slash);
  const repo = body.slice(slash + 1);
  if (!owner || !repo || repo.includes("/")) return null;
  return `${owner}/${repo}`.toLowerCase();
}
