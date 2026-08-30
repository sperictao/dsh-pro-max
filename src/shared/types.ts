// shared/types：IPC 载荷与领域视图类型（镜像 Rust 侧结构）

export interface LauncherConfig {
  minimize_to_tray_on_close: boolean;
  language: string;
  dsh_admin_cap_domain: string;
  dsh_use_cap_domain: string;
  dsh_extra_allowed_logins: string;
}

export type DshAccessMode = "local" | "remote";

export interface DshStatus {
  nodeAvailable: boolean;
  dshInstalled: boolean;
  dshVersion: string | null;
  supportedVersion: string;
  dshCompatible: boolean;
  // 实际版本高于 Launcher 验证过的锁定版本：授权插件栈在更新版下未验证，UI 提示风险不阻断
  dshVersionAboveSupported: boolean;
  pluginsInstalled: boolean;
  dshRunning: boolean;
  tailscaleInstalled: boolean;
  tailscaleOnline: boolean;
  hostname: string | null;
  localUrl: string | null;
  url: string | null;
  remoteUrlAccess: "ready" | "capability_denied" | "proxy_interference" | "endpoint_failure" | null;
  magicDnsEnabled: boolean;
  serveConfigured: boolean;
  autostartEnabled: boolean;
  error: string | null;
}

export interface DshStepEvent {
  index: number;
  id: string;
  state: "running" | "done" | "failed" | "skipped" | "pending";
  detail: string | null;
  problem: string | null;
  solution: string | null;
}

// dsh dist-tag 行（latest/next 等）
export interface DshDistTag {
  tag: string;
  version: string;
  isInstalled: boolean;
  aboveSupported: boolean;
  incompatible: boolean;
}

// dsh 版本检测（npm registry 全部 dist-tag）
export interface DshLatestInfo {
  tags: DshDistTag[];
  installedVersion: string | null;
  supportedVersion: string;
  error: string | null;
}

export interface UpdaterConfigHealth {
  configured: boolean;
  message: string;
}

export interface UpdaterHelpPaths {
  docsPath: string;
  templatePath: string;
}

export interface UpdateInfo {
  currentVersion: string;
  availableVersion: string | null;
  hasUpdate: boolean;
  releaseNotes: string | null;
  message: string | null;
}

export interface DownloadProgress {
  stage: string;
  version: string;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  attempt: number;
  maxAttempts: number;
}

// ============ 模型配置（~/.dsh/settings.yaml 的模型域）============

export interface ProviderConfig {
  /** 提供商路由键（providers dict 的键，如 spero-ai） */
  route: string;
  displayName: string | null;
  baseURL: string | null;
  /** wire 协议：openai-completions | openai-responses | anthropic-messages */
  api: string | null;
  /** 凭据引用（环境变量名），密钥永不落盘 */
  apiKeyEnv: string | null;
  /** 模型 id 列表 */
  models: string[];
  /** 非管理键（高级字段），原样透传保存 */
  extra: unknown;
}

export interface ModelConfig {
  defaultProvider: string | null;
  defaultModel: string | null;
  /** 思考等级：off | minimal | low | medium | high | xhigh | max */
  defaultReasoningEffort: string | null;
  providers: ProviderConfig[];
}

// ============ 插件市场（dsh-plugins-store 公开目录）============

export interface MarketPlugin {
  repositoryId: number;
  fullName: string;
  name: string;
  description: string | null;
  url: string;
  stars: number;
  category: string | null;
  language: string | null;
  /** 仅 validation.overall === "verified"（目录约定的唯一判定依据） */
  verified: boolean;
  /** candidate.action === "add" 的机器安装标识；null = 无一键安装候选 */
  installSpecifier: string | null;
  installExecutable: boolean;
}

export interface MarketCatalog {
  generatedAt: string | null;
  total: number;
  plugins: MarketPlugin[];
}

export interface InstalledPlugin {
  /** npm 包名（profile package.json dependencies 键） */
  name: string;
  /** 安装 spec（file: tarball / npm:x / github:owner/repo 等） */
  spec: string;
  /** Launcher 自管授权插件：不出移除按钮 */
  managed: boolean;
}
