// shared/types：IPC 载荷与领域视图类型（镜像 Rust 侧结构）

export interface LauncherConfig {
  minimize_to_tray_on_close: boolean;
  language: string;
  dsh_admin_cap_domain: string;
  dsh_use_cap_domain: string;
  dsh_extra_allowed_logins: string;
  /** 插件市场目录源镜像；空 = 内置官方源 */
  market_catalog_url: string;
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

// ============ 插件市场（awesome-dsh-plugin curated 目录）============

export interface MarketPlugin {
  /** owner/name（展示与排序键） */
  fullName: string;
  name: string;
  /** 多语言描述原样透传（如 {"en": "...", "zh": "..."}），按界面语言取 */
  description: Record<string, string> | null;
  url: string;
  /** null = 目录暂无数据（新收录或仓库 404），不静默当 0 */
  stars: number | null;
  /** 分类 id（显示名经 catalog.categories 本地化） */
  category: string | null;
  /** 目录 install 命令串解析出的安装标识；null = 无一键安装候选 */
  installSpecifier: string | null;
  /** 目录侧弃用标记原样透传 */
  deprecated: boolean;
  /** 弃用时目录建议的替代插件名 */
  replacement: string | null;
}

export interface MarketCatalog {
  /** 目录生成日期（目录原生 updated，如 "2026-08-31"） */
  updated: string | null;
  /** 分类 id → {语言 → 显示名}，目录原生表原样透传 */
  categories: Record<string, Record<string, string>>;
  total: number;
  plugins: MarketPlugin[];
  /** 本次数据来自本地快照（网络拉取失败时的降级），UI 需如实标注 */
  fromSnapshot: boolean;
}

export interface InstalledPlugin {
  /** npm 包名（profile package.json dependencies 键） */
  name: string;
  /** 安装 spec（file: tarball / npm:x / github:owner/repo 等） */
  spec: string;
  /** Launcher 自管授权插件：不出移除按钮 */
  managed: boolean;
}

/** 安装回执：本次安装落进 profile 的 dependencies 键与 spec；无法唯一定位落点时为 null */
export interface InstallReceipt {
  name: string;
  spec: string;
}

/** 安装结果：成功带回执；被 pnpm 拦截构建脚本时转审批请求（包名 + 待写 yaml 路径） */
export type InstallOutcome =
  | { status: "installed"; receipt: InstallReceipt | null }
  | { status: "needsApproval"; packages: string[]; workspaceYaml: string };

/** 安装输出行事件（market-install-log）：specifier 锚定发起安装的卡片 */
export interface MarketInstallLogEvent {
  specifier: string;
  line: string;
}

/** 插件更新检测单包结果：npm 形态安装的非受管插件才可检（registry latest 比对），
 * 协议形态（github:/file: 等）与范围 spec 如实返回 None */
export interface PluginUpdateInfo {
  name: string;
  /** 落盘 spec 原文 */
  spec: string;
  managed: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
}
