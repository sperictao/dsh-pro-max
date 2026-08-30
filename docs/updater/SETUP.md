# Updater 配置指南

本指南面向维护者，配置 DSH Pro Max 内置自动更新（Tauri Updater）的签名与更新源。
设置页 **About → Updates** 卡片显示的更新源健康状态即由本配置决定；未配置时应用内
的「Setup Guide」链接指向本文件，「Config Template」链接指向
`src-tauri/tauri.conf.updater.example.json`。

## 1. 配置模型：仓库内为空，构建时生成

`src-tauri/tauri.conf.json` 中 `plugins.updater` 的 `pubkey` 与 `endpoints` 刻意留空
（占位），生产配置只在构建时生成：

1. `scripts/generate-updater-config.mjs` 从环境变量生成
   `src-tauri/tauri.conf.updater.prod.json`（gitignore，不进仓库）；
2. `scripts/validate-updater-config.mjs` 校验生成结果（pubkey 非空且非占位值、
   endpoints 非空且全部 https、`createUpdaterArtifacts: true`）；
3. `pnpm run build:updater` 串联以上两步并执行
   `tauri build --config src-tauri/tauri.conf.updater.prod.json`。

生成配置使用 Tauri 的 `--config` overlay 机制，只覆盖 updater 相关字段，其余配置仍
以 `tauri.conf.json` 为准。两份事实不并存：仓库内的空配置即「未配置」状态本身，
本地 `pnpm tauri dev` / `pnpm tauri build`（不走 build:updater）构建出的应用更新源
未配置、不检查更新，这是预期行为。

## 2. 前置：生成签名密钥对

Updater 使用 minisign 签名。每个发布密钥对生成一次，私钥保密、公钥随构建注入：

```bash
pnpm tauri signer generate -w ~/.tauri/dsh-pro-max.key
# 按提示设置私钥密码，输出中的公钥即 TAURI_UPDATER_PUBKEY 的值
```

- 私钥丢失或更换后，旧客户端只信任旧公钥签名的包——换钥等于断更，需发布过渡版本。
- 私钥与密码以 CI secrets（`TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）注入，不落仓库。

## 3. 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TAURI_UPDATER_PUBKEY` | 是 | minisign 公钥；含 `REPLACE_WITH` 占位值时生成脚本直接失败 |
| `TAURI_UPDATER_REPO` | 否 | 仓库 slug（默认 `sperictao/dsh-pro-max`），用于推导默认 endpoint |
| `TAURI_UPDATER_ENDPOINT` | 否 | 显式指定 `latest.json` 地址；必须 https，默认 `https://github.com/<repo>/releases/latest/download/latest.json` |
| `TAURI_SIGNING_PRIVATE_KEY` | 是（签名） | minisign 私钥（内容或文件路径），Tauri bundler 用它给更新包生成 `.sig` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 否 | 私钥密码 |

本地完整构建示例：

```bash
export TAURI_UPDATER_PUBKEY="<第 2 步生成的公钥>"
export TAURI_SIGNING_PRIVATE_KEY=~/.tauri/dsh-pro-max.key
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<私钥密码>"
pnpm run build:updater
```

## 4. CI 配置

`.github/workflows/build-release.yml` 在每个平台构建步骤注入同一组 secrets：

| GitHub secret | 对应环境变量 |
| --- | --- |
| `TAURI_UPDATER_PUBKEY` | 同名 |
| `TAURI_SIGNING_PRIVATE_KEY` | 同名 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 同名 |

`TAURI_UPDATER_REPO` / `TAURI_UPDATER_ENDPOINT` 未配置 secrets 时使用默认值
（GitHub Releases），无需额外配置。

## 5. 发布产物链

发布 job（tag 触发）把构建产物整理为 updater 资产并生成 manifest：

1. 各平台产物重命名：macOS `*.app.tar.gz`(+`.sig`)、Windows `*-setup.exe`(+`.sig`)、
   Linux `*.AppImage`(+`.sig`)；
2. `scripts/generate-latest-json.mjs` 汇总签名与下载地址生成 `latest.json`
   （资产名按 GitHub 规则净化，空格替换为 `.`，否则下载 404）；
3. `latest.json` 与更新包随 GitHub Release 一起上传，endpoint 固定指向
   `releases/latest/download/latest.json`。

客户端更新流程：应用内检查 → 下载（网络类错误自动重试 3 次）→ minisign 验签 →
安装 → 自动重启，全程进度显示在 About 卡片。

## 6. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 更新源健康显示「Error」：`Updater does not have any endpoints set` | 构建时未注入 `TAURI_UPDATER_PUBKEY` 或未走 `build:updater`，见第 3 节 |
| 检查更新报 `Update URL must use https` | endpoint 使用了 http，改为 https |
| 下载后验签失败 | 公钥与签名私钥不是同一对，或 `latest.json` 里的 `.sig` 与包不配套；核对第 2、5 节 |
| `latest.json` 下载 404 | Release 资产名被 GitHub 净化后与 manifest 中 URL 不一致；确认由 `generate-latest-json.mjs` 生成 manifest |
| 构建失败：`TAURI_UPDATER_PUBKEY 环境变量未设置或无效` | 变量未设置或仍是 `REPLACE_WITH` 占位值 |
