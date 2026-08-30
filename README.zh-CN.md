<div align="center">

# DSH Pro Max

**DeepSeek Harness 桌面启动器——一键本地 Web UI 与 Tailscale 安全远程访问。**

[![GitHub Release](https://img.shields.io/github/v/release/sperictao/dsh-pro-max)](https://github.com/sperictao/dsh-pro-max/releases)
[![Tauri 2](https://img.shields.io/badge/Tauri-2.x-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

## ✨ 亮点

- 🌐 **DeepSeek Harness 远程访问**——通过内置身份授权插件一键开通 dsh Web UI 的 Tailscale HTTPS 访问，8 步进度时间线展示全过程，支持兼容性修复与开机自启
- 🔌 **内置授权插件**——两个固定版本的插件（[dsh-client-connection-authz](https://github.com/sperictao/dsh-client-connection-authz) + [dsh-auth-tailscale](https://github.com/sperictao/dsh-auth-tailscale)）随安装包分发，自动装入 dsh web profile
- 🔐 **基于 Capability 的授权**——配置你自己的管理/使用 capability 域名与额外允许的 Tailscale 登录名；不配置 capability 时远程特权接口恒 403
- 🎨 **主题**——42 个 tweakcn 主题族，原生亮/暗/跟随系统模式；UI 字体全部应用内自托管，完全离线
- 🌍 **多语言**——英文与简体中文界面，默认跟随系统
- 🔄 **自更新**——内置 Tauri Updater：检查、下载、重启，完成
- ⌨️ **键盘**——`Cmd/Ctrl + ,` 打开设置

## 📦 安装

从 [Releases](https://github.com/sperictao/dsh-pro-max/releases) 下载对应平台的最新安装包（macOS `.dmg`、Windows `-setup.exe`、Linux `.AppImage` / `.deb`）。

dsh 功能的前置条件：**Node.js 18+**；远程访问另需 **Tailscale** 并启用 MagicDNS 与 HTTPS Certificates（应用内逐步引导；详见 [docs/dsh-remote-access-setup.md](docs/dsh-remote-access-setup.md)）。

## 🛠 开发

```bash
git clone --recurse-submodules https://github.com/sperictao/dsh-pro-max.git
cd dsh-pro-max
pnpm install
pnpm tauri dev
```

领域术语与语义边界见 [CONTEXT.md](CONTEXT.md)；设计决策见 [docs/adr/](docs/adr/)。

质量门禁：`pnpm test`（主题 + 组件测试）、`pnpm run check:i18n` 与 `pnpm test:e2e`（mock Tauri IPC 的浏览器冒烟，需 Chrome）。

## 📖 来源

DSH 模块于 v1.10.0 从 [Codex Pro Max](https://github.com/sperictao/codex-pro-max)（原名 dashi-taskboard-launcher）中拆分为独立应用。

## 许可证

MIT
