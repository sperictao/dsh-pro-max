// shared/types：IPC 载荷与领域视图类型。
// 契约类型由 ts-rs 从 Rust serde 结构生成（./bindings 下的 18 个文件，
// 唯一事实来源是 src-tauri 侧结构体；手改即破，重跑 cargo test export_bindings
// 再生成）。名称差异经 re-export 别名一次适配，消费方 import 路径不变。

export type { LauncherConfig } from "./bindings/LauncherConfig";
export type { DshStatus } from "./bindings/DshStatus";
export type { RemoteUrlAccess } from "./bindings/RemoteUrlAccess";
export type { DshDistTag } from "./bindings/DshDistTag";
export type { DshLatestInfo } from "./bindings/DshLatestInfo";
export type { UpdaterConfigHealth } from "./bindings/UpdaterConfigHealth";
export type { UpdaterHelpPaths } from "./bindings/UpdaterHelpPaths";
export type { UpdateInfo } from "./bindings/UpdateInfo";
export type { ProviderConfig } from "./bindings/ProviderConfig";
export type { ModelConfig } from "./bindings/ModelConfig";
export type { MarketPlugin } from "./bindings/MarketPlugin";
export type { MarketCatalog } from "./bindings/MarketCatalog";
export type { InstalledPlugin } from "./bindings/InstalledPlugin";
export type { InstallReceipt } from "./bindings/InstallReceipt";
export type { InstallOutcome } from "./bindings/InstallOutcome";
export type { MarketInstallLogEvent } from "./bindings/MarketInstallLogEvent";
export type { PluginUpdateInfo } from "./bindings/PluginUpdateInfo";

// 别名：bindings 按 Rust 结构名导出，消费方沿用的前端名在此一次映射
export type { StepEvent as DshStepEvent } from "./bindings/StepEvent";

// 前端独有（Rust 无对应载荷）：dsh 访问模式（localStorage 持久化）
export type DshAccessMode = "local" | "remote";

// 更新下载进度事件：由 updater 插件事件推送（Rust 侧不经 serde 结构，
// 是插件内部事件载荷），保持手写契约
export interface DownloadProgress {
  stage: string;
  version: string;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  attempt: number;
  maxAttempts: number;
}
