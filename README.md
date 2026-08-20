<div align="center">

# DSH Pro Max

**A desktop launcher for DeepSeek Harness — one-click local web UI and Tailscale-secured remote access.**

[![GitHub Release](https://img.shields.io/github/v/release/sperictao/dsh-pro-max)](https://github.com/sperictao/dsh-pro-max/releases)
[![Tauri 2](https://img.shields.io/badge/Tauri-2.x-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

## ✨ Highlights

- 🌐 **DeepSeek Harness Remote Access** — one-click Tailscale HTTPS access to the dsh Web UI through bundled identity-authorization plugins, shown as an 8-step progress timeline with compatibility repair and boot auto-start
- 🔌 **Bundled Auth Plugins** — two pinned plugins ([dsh-client-connection-authz](https://github.com/sperictao/dsh-client-connection-authz) + [dsh-auth-tailscale](https://github.com/sperictao/dsh-auth-tailscale)) ship inside the installer and are installed into the dsh web profile automatically
- 🔐 **Capability-Based Authorization** — configure your own admin/use capability domains and extra allowed Tailscale logins; without capabilities, remote privileged APIs stay 403
- 🎨 **Themes** — 42 tweakcn theme families with native light / dark / system modes; UI fonts self-hosted in-app, fully offline
- 🌍 **i18n** — English and Simplified Chinese UI, following the system by default
- 🔄 **Self-Update** — built-in Tauri Updater: check, download, restart, done

## 📦 Install

Download the latest installer for your platform from [Releases](https://github.com/sperictao/dsh-pro-max/releases) (macOS `.dmg`, Windows `-setup.exe`, Linux `.AppImage` / `.deb`).

Prerequisites for the dsh features: **Node.js 18+**; for remote access additionally **Tailscale** with MagicDNS and HTTPS Certificates enabled (guided step by step in-app; see [docs/dsh-remote-access-setup.md](docs/dsh-remote-access-setup.md)).

## 🛠 Development

```bash
git clone --recurse-submodules https://github.com/sperictao/dsh-pro-max.git
cd dsh-pro-max
pnpm install
pnpm tauri dev
```

Domain terminology and semantic boundaries live in [CONTEXT.md](CONTEXT.md); design decisions in [docs/adr/](docs/adr/).

## 📖 Origin

The DSH module was extracted from [Codex Pro Max](https://github.com/sperictao/codex-pro-max) (formerly dashi-taskboard-launcher) at v1.10.0 into this standalone app.

## License

MIT
