<div align="center">

<img src="src-tauri/icons/icon.png" alt="Taffy Studio" width="96" height="96" />

# Taffy Studio

**A cross-platform LLM chat client built on Tauri 2.**

Glassmorphism UI · OpenAI / Anthropic / Gemini native protocols · streaming · OS-keyring secret storage · Markdown + KaTeX + Mermaid · Windows / macOS / Linux / iOS / Android.

[![CI](https://github.com/your-org/taffy-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/taffy-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri)](https://v2.tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-stable-orange?logo=rust)](https://www.rust-lang.org/)

**English** · [简体中文](./README.md)

</div>

> [!NOTE]
> **Status: early — usable on desktop, mobile builds work but UI polish for touch is ongoing.**
> The skeleton (Tauri 2 + React + SQLite + streaming + multi-provider + OS keyring) is in place,
> and the Rust business logic now lives in a shared, platform-agnostic `taffy-core` crate so a
> second shell (a self-hosted web server) can reuse it.

## 🧭 Architecture & positioning

- **Frontend**: React (one UI, reused by every shell)
- **Core**: platform-agnostic Rust crate `taffy-core` (LLM dispatch / embeddings / DTOs; no `tauri::`, no `axum::`)
- **Shells**: Tauri desktop & mobile (ready); web / server (axum + embedded frontend, planned)
- **Access pattern**: desktop / mobile are native apps; (planned) browser opens a self-hosted service at `http://localhost:xxxx`
- **Targets**: Windows, macOS, Linux desktop; iOS / Android mobile; and headless Linux servers (Docker)

### 📚 Companion docs

- [`docs/MIGRATIONS.md`](./docs/MIGRATIONS.md) — DB migration rules for contributors
- [`docs/UPDATER.md`](./docs/UPDATER.md) — auto-update signing keys, manifest, hosting, rotation
- [`MIGRATION.md`](./MIGRATION.md) — Cherry Studio → this skeleton porting plan
- [`DOCKER.md`](./DOCKER.md) — Docker-based Linux + Android builds

---

## ✨ Features

- 🌐 **Five platforms, one codebase** — Windows, macOS, Linux, iOS, Android (Tauri 2).
- 🧩 **Shared Rust core** — business logic (LLM dispatch, embeddings, DTOs) lives in a platform-agnostic `taffy-core` crate; the Tauri shell is a thin wrapper, and a web/server shell can reuse the same core.
- 🚀 **Streaming first** — token-by-token via `tauri::ipc::Channel`; stop / regenerate built-in.
- 🤖 **Multi-provider, native protocols** — OpenAI-compatible (OpenAI / DeepSeek / SiliconFlow / Ollama / any base URL), **Anthropic** (`/v1/messages`), **Gemini** (`streamGenerateContent`). API keys live in the **OS keyring** (Win Credential / macOS Keychain / libsecret).
- 📝 **Rich rendering** — GitHub Flavored Markdown, syntax-highlighted code blocks with copy button, KaTeX math (`$inline$` / `$$block$$`), Mermaid diagrams (lazy-loaded).
- 💾 **Local-first** — conversations + messages persisted to SQLite via `tauri-plugin-sql`.
- 🎨 **Glassmorphism UI** — HSL token system, blue-gray glass surfaces, radial-gradient backdrop, auto dark mode.
- 📱 **Responsive** — desktop sidebar collapses to a drawer below 760px; safe-area insets on iOS/Android.
- 🔐 **Sideload-friendly** — no app store dependency; updater plugin pre-configured for self-hosted releases.

## 📸 Screenshots

> _Add screenshots here once UI stabilizes._
> `docs/screenshots/desktop-light.png`, `docs/screenshots/desktop-dark.png`, `docs/screenshots/mobile.png`

---

## 🚀 Quick Start

```bash
git clone https://github.com/your-org/taffy-studio.git
cd taffy-studio
pnpm install
pnpm tauri:dev      # first run compiles ~400 Rust crates (5–10 min)
```

Open Settings (⚙ in the top-right), pick a provider preset (OpenAI / Anthropic / Gemini / DeepSeek / SiliconFlow / Ollama), paste your API key, then chat.

## ⚙️ Prerequisites

| Tool | Why |
|------|-----|
| Node ≥ 18 + **pnpm** | Frontend tooling |
| **Rust** (stable via [rustup](https://rustup.rs)) | Tauri core |
| OS toolchain | See below |

Per-OS:
- **Windows** — MSVC Build Tools + WebView2 (Win11 ships with it)
- **macOS** — `xcode-select --install`
- **Linux** — `libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev librsvg2-dev libxdo-dev libayatana-appindicator3-dev patchelf`
- **Android** — Android Studio + NDK + `ANDROID_HOME` + `NDK_HOME`
- **iOS** — Xcode + Apple ID (free tier works for sideload)

Full setup: <https://v2.tauri.app/start/prerequisites/>

---

## 🛠 Scripts

### Windows host

```powershell
# Dev (hot-reload, local machine)
.\scripts\dev.ps1                  # desktop window         [default]
.\scripts\dev.ps1 android          # emulator / USB device

# Build release
.\scripts\build.ps1 windows        # native — fastest       [default]
.\scripts\build.ps1 linux          # Docker → dist-linux/{*.deb,*.AppImage}
.\scripts\build.ps1 android        # Docker → dist-android/*.apk
.\scripts\build.ps1 all            # windows + linux + android

# Local CI (run all checks before pushing)
.\scripts\ci-local.ps1
```

### macOS host

```bash
./scripts/dev-mac.sh               # desktop
./scripts/dev-mac.sh ios
./scripts/dev-mac.sh android

./scripts/build-mac.sh             # .app + .dmg            [default]
./scripts/build-mac.sh ios         # .ipa (sideload)
./scripts/build-mac.sh all         # mac + ios + android + linux

./scripts/ci-local.sh
```

All scripts run a preflight (Node ≥ 18, pnpm, Rust, plus toolchain checks per target) and fail loud with concrete install hints if something is missing.

---

## ✅ Pre-push verification: local CI

Run the **exact same checks** GitHub Actions runs, locally in Docker — catches regressions before you push:

```powershell
.\scripts\ci-local.ps1
```

Mirrors [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

1. `pnpm install --frozen-lockfile`
2. `pnpm exec tsc -b`       (frontend typecheck)
3. `pnpm build`              (vite production build)
4. `cargo fmt --all -- --check`
5. `cargo clippy --all-targets -- -D warnings`
6. `cargo check --all-targets`

First run ≈ 5–10 min (builds image + caches). Subsequent runs ≈ 2–3 min (cached node_modules + cargo registry).

```powershell
.\scripts\ci-local.ps1 -Reset       # wipe cached volumes if lockfile changes cause weirdness
.\scripts\ci-local.ps1 -NoCache     # rebuild the CI image from scratch
```

---

## 🧱 Tech Stack

| Layer | What |
|-------|------|
| Core | **`crates/taffy-core`** — platform-agnostic Rust (LLM dispatch, embeddings, DTOs), shared by every shell |
| Shell | [Tauri 2](https://v2.tauri.app/) (Rust core + system webview); a web/server shell is planned |
| Frontend | React 18 + TypeScript 5 + Vite 5 |
| Markdown | `react-markdown` + `remark-gfm` + `react-syntax-highlighter` + `rehype-katex` + `mermaid` |
| Database | SQLite via `tauri-plugin-sql` (sqlx under the hood) |
| Secrets | `keyring` crate (desktop) + Store fallback (mobile) |
| HTTP / SSE | `reqwest` (rustls — no system OpenSSL dep, mobile-friendly) + custom SSE parser |
| Build | pnpm + Cargo workspace + Docker (Linux / Android cross-build from Windows) |
| CI | GitHub Actions: typecheck + clippy + matrix desktop builds on tag |

## 📂 Project Layout

```
app/
├─ Cargo.toml                        # Cargo WORKSPACE root (src-tauri + crates/*)
├─ index.html                        # Vite entry
├─ src/                              # React frontend (one UI for every shell)
│  ├─ main.tsx                       # React boot
│  ├─ App.tsx                        # Layout (topbar + sidebar + main)
│  ├─ App.css                        # EK-OmniProbe-style design tokens + glass surfaces
│  ├─ components/
│  │  ├─ ChatPanel.tsx               # Messages + composer + Stop/Regenerate
│  │  ├─ MessageContent.tsx          # Markdown + KaTeX + Mermaid
│  │  └─ SettingsPanel.tsx           # Provider config + keyring-backed API key
│  └─ lib/
│     ├─ ipc.ts                      # All invoke() calls go through here
│     ├─ db.ts                       # SQLite via plugin-sql
│     ├─ store.ts                    # Persistent KV (plugin-store)
│     ├─ settings.ts                 # Typed config + keyring migration
│     └─ llm.ts                      # ChatRequest / chatStream contract
├─ crates/
│  └─ taffy-core/                    # ★ platform-agnostic core — no tauri:: / axum::
│     └─ src/
│        ├─ lib.rs                   # re-exports
│        └─ llm.rs                   # provider dispatch, SSE, list_models / chat_complete / embed_texts
├─ src-tauri/                        # Tauri desktop/mobile shell (thin; delegates to taffy-core)
│  ├─ src/
│  │  ├─ main.rs                     # Desktop entry
│  │  ├─ lib.rs                      # Tauri commands + streaming/agentic loop + storage
│  │  └─ mcp.rs                      # MCP stdio client
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  └─ capabilities/                  # Plugin permission grants
├─ docker/                           # Cross-platform BUILD images (not a runtime server)
│  ├─ ci.Dockerfile                  # Local CI verification
│  ├─ linux.Dockerfile               # Linux deb + AppImage
│  └─ android.Dockerfile             # Android APK
├─ scripts/                          # dev / build / ci-local for Win + Mac
├─ .github/workflows/                # ci.yml + release.yml
├─ DOCKER.md                         # Docker build details
├─ MIGRATION.md                      # Cherry Studio porting plan
├─ README.md                         # 简体中文 (default)
└─ README.en.md                      # You are here
```

---

## 🗺 Roadmap

Tracked in [`MIGRATION.md`](./MIGRATION.md). High level:

- [x] Tauri 2 skeleton (Windows/Mac/Linux/iOS/Android)
- [x] SQLite persistence + multi-conversation
- [x] OpenAI-compatible streaming + Anthropic + Gemini native protocols
- [x] Stop / Regenerate
- [x] Markdown + code highlight + KaTeX + Mermaid
- [x] OS keyring for API keys (desktop)
- [x] Responsive sidebar (drawer < 760px)
- [x] EK-OmniProbe-style glassmorphism UI
- [x] Local + GitHub Actions CI
- [x] Auto-fetch model lists per provider
- [x] Conversation title auto-summary
- [x] Bundle splitting (per-vendor chunks; pdf.js / tesseract lazy-loaded)
- [x] **i18n** — English + 简体中文, OS-detected + user-switchable
- [x] **Theme control** — System / Light / Dark (overrides the OS media query)
- [x] **File attachments** — images (vision) + PDF / text documents (client-side text extraction spliced into the prompt)
- [x] **OCR** — Tesseract.js fallback for images on non-vision models
- [x] **MCP client** — stdio servers, tool registry, agentic tool-use loop (OpenAI + Anthropic)
- [x] **Knowledge base / RAG** — local vector store (brute-force cosine), per-conversation retrieval injection
- [x] **Shared Rust core** — platform-agnostic `crates/taffy-core` (LLM / embeddings / DTOs) split out of the Tauri shell
- [ ] **Self-hosted web server** (Docker) — a second shell (axum + embedded frontend) over the shared core, browser-accessed
- [ ] Streaming markdown stability (no flicker on half-rendered tables/code)
- [ ] Token-by-token streaming during the agentic tool-use loop (currently per-round)
- [ ] Stronghold / Android Keystore / iOS Keychain for mobile secret storage

## 🤝 Contributing

PRs welcome. Before pushing:

```powershell
.\scripts\ci-local.ps1    # or .\scripts\ci-local.sh on Mac/Linux
```

Conventions:
- TypeScript strict on (`tsc -b` must pass).
- Rust: `cargo fmt`, `cargo clippy -- -D warnings`.
- Commit messages: short imperative subject; `feat:` / `fix:` / `docs:` / `chore:` / `refactor:` prefix encouraged but not required.
- All JS → Rust calls go through `src/lib/ipc.ts` (no inline `invoke()` in components).
- Keep business logic in `crates/taffy-core` (no `tauri::` types there) so future shells can reuse it.

Issues & discussion: open one on GitHub. For larger architectural changes, start a discussion first.

## 🙏 Acknowledgments

Taffy Studio draws design and architectural inspiration from:

- **[Cherry Studio](https://github.com/CherryHQ/cherry-studio)** — AI workstation feature inventory (AGPL-3.0).
- **[Kelivo](https://github.com/Chevey339/kelivo)** — Flutter LLM client, mobile UX reference.
- **[EK-OmniProbe](https://github.com/EmbeddedKitOrg/EK-OmniProbe)** — glassmorphism UI design language ported to chat.
- **[Tauri](https://v2.tauri.app/)** — the shell that makes 5-platform deployment realistic.

> Source code in this repo is original; the projects above are listed because their public ideas, file layouts, or visual languages informed decisions here.

## 📄 License

[MIT](./LICENSE) © 2026 zuolan

---

<div align="center">
<sub>Built with <a href="https://v2.tauri.app/">Tauri 2</a> · <a href="https://react.dev/">React</a> · <a href="https://www.rust-lang.org/">Rust</a></sub>
</div>
