// shared/types：IPC 载荷与领域视图类型（镜像 Rust 侧结构）

export interface LauncherConfig {
  minimize_to_tray_on_close: boolean;
  language: string;
  dsh_admin_cap_domain: string;
  dsh_use_cap_domain: string;
  dsh_extra_allowed_logins: string;
}

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

// dsh 最新版本检测（npm registry dist-tag latest）
export interface DshLatestInfo {
  latestVersion: string | null;
  installedVersion: string | null;
  supportedVersion: string;
  hasUpdate: boolean;
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
