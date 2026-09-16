# Contributing to DSH Pro Max

Thanks for your interest in contributing! This document covers the setup, the
quality gates every change must pass, and the conventions the repository follows.

## Setup

```bash
git clone --recurse-submodules https://github.com/sperictao/dsh-pro-max.git
cd dsh-pro-max
pnpm install
pnpm tauri dev
```

Requirements: Node.js 22+ with pnpm, and a Rust stable toolchain. The two
`vendor/` git submodules hold the pinned dsh authorization plugins and are
built automatically by `pnpm tauri dev` / `pnpm tauri build`.

## Quality gates

CI (`.github/workflows/quality.yml`) runs all of these on every PR — please run
them locally before pushing:

| Command | What it checks |
| --- | --- |
| `pnpm exec tsc --noEmit` | TypeScript types (also keeps the zh-CN dictionary in sync with en at compile time) |
| `pnpm exec vitest run` | Frontend unit tests |
| `node scripts/check-i18n.mjs` | i18n coverage: frontend `t("...")` and Rust `Message` / `tr` / `trf` literals must exist in the dictionary, and no dictionary entry may be unreachable |
| `pnpm run test:e2e` | Browser smoke test over a mocked Tauri IPC (needs Chrome) |
| `cargo clippy --all-targets -- -D warnings` | Rust lints, warnings are errors |
| `cargo test` | Rust unit tests (in `src-tauri`) |

A practical shortcut: `pnpm test` runs the theme tests plus vitest.

## Conventions

- **Commits**: Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`,
  `test:`, `chore:`, `ci:`), English, imperative subject ≤ 72 chars.
- **One source of truth**: no compatibility layers, no deprecated retention
  paths, no duplicated facts. When a rule changes, replace the old one.
- **Terminology**: domain terms and semantic boundaries live in
  [CONTEXT.md](CONTEXT.md); design decisions in [docs/adr/](docs/adr/). Read
  both before changing behavior — the UI copy and error messages follow them.
- **Code layout**: the Rust side is split by domain under `src-tauri/src/dsh/`
  (see `dsh/mod.rs` for the map); frontend features live under `src/features/`
  with shared infrastructure in `src/shared/`. All IPC command names appear
  only in `src/shared/commands.ts` and `src-tauri/src` `#[tauri::command]`s.
- **i18n**: the frontend dictionary `src/shared/i18n/en.ts` (+ `zh-CN.ts`) is the
  single source of truth for translations. User-visible text produced by Rust
  crosses IPC as a `Message { key, args }` (`src-tauri/src/i18n.rs`): `key` is the
  English original, possibly with `{{name}}` placeholders, and `args` carries the
  values **as data** — never interpolate in Rust. Render it with `tErr` /
  `renderMessage` (`src/shared/i18n/error.ts`); a dictionary hit interpolates the
  translation, a miss fills the English original in place. When you add such a
  string, add the entry to both dictionaries.
  The one exception is text Rust hands straight to an OS API (tray menu titles,
  system notifications): there is no frontend render point, so those use
  `i18n::trf(key, args)` and the small `zh_cn` table in `src-tauri/src/i18n.rs`.
  `check-i18n.mjs` enforces all four directions: frontend `t("...")` ⊆ dictionary,
  Rust `Message::key/localized` literals ⊆ dictionary, `tr/trf` ⊆ tray table, and
  no unreachable dictionary entry.

## Updating the pinned dsh plugins

The vendored plugin pin is mirrored in three places that must move together:
the submodule pointer, `scripts/build-dsh-plugins.mjs` (pin assertion), and the
tgz filenames in `src-tauri/tauri.conf.json` `bundle.resources`. Missing any
one breaks packaging or runtime.

## Releasing

Releases are tag-driven (`build-release.yml`). Before tagging a `vX.Y.Z`:

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml` — three places, always in sync.
2. Write `release-notes/vX.Y.Z.md` (the release job fails without it).
3. Run `pnpm run check:release -- --tag vX.Y.Z` locally, then commit and tag.

## Reporting issues

Use the issue templates. For security vulnerabilities, follow
[SECURITY.md](SECURITY.md) — please do not open public issues for them.
