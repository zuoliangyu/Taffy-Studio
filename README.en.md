<div align="center">

<img src="src-tauri/icons/icon.png" alt="Taffy Studio" width="96" height="96" />

# Taffy Studio

**One codebase, seven targets — an LLM workstation built on Tauri 2 + React + a shared Rust core.**

OpenAI / Anthropic / Gemini native protocols · streaming · MCP tools + skills · knowledge base (RAG) · OS keyring · glassmorphism UI
Windows · macOS · Linux · iOS · Android · single-file web binary · Docker

[![CI](https://github.com/zuoliangyu/Taffy-Studio/actions/workflows/ci.yml/badge.svg)](https://github.com/zuoliangyu/Taffy-Studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri)](https://v2.tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-stable-orange?logo=rust)](https://www.rust-lang.org/)

**English** · [简体中文](./README.md)

</div>

> [!NOTE]
> **Status: actively developed — usable on desktop, mobile builds work, the web/server shell can chat.**
> Business logic (LLM dispatch, the SQLite data layer, MCP, skills, embeddings) lives in one
> platform-agnostic `taffy-core` crate, shared by the desktop (Tauri) and server (axum) shells,
> with a single React UI reused across every target.

---

## ✨ What it does

- 🌐 **One codebase, seven deliverables** — Windows / macOS / Linux / iOS / Android native targets (Tauri 2), plus a **single-file web binary** for self-hosting and a **Docker** image.
- 🤖 **Multi-provider, native protocols** — OpenAI-compatible (OpenAI / DeepSeek / SiliconFlow / Ollama / any base URL), **Anthropic** `/v1/messages`, **Gemini** `streamGenerateContent`. Model lists fetched per provider.
- 🚀 **Streaming-first** — token-by-token (desktop via `tauri::ipc::Channel`, web via SSE), with stop / regenerate built in.
- 🧩 **MCP tools + market** — connect MCP servers (local stdio + remote Streamable HTTP), with a built-in agentic tool-call loop (OpenAI & Anthropic) and a one-click **MCP market**.
- 🛠 **Skills** — reusable prompt/capability packs in `SKILL.md` form, with import and per-conversation enablement.
- 📚 **Knowledge base / RAG** — a local vector store (cosine retrieval) injected per conversation.
- 📎 **Attachments & OCR** — images (vision models), PDFs / text documents (text extracted client-side into the prompt); Tesseract.js OCR fallback for non-vision models.
- 📝 **Rich rendering** — GitHub-flavored Markdown, code highlighting (with copy), KaTeX math, Mermaid diagrams (lazy-loaded).
- 🔐 **Secret safety** — API keys in the **OS keyring** (Windows Credential Manager / macOS Keychain / Linux libsecret); the server build injects keys from env vars and the browser never touches them.
- 🎨 **Glassmorphism UI** — HSL token system, blue-grey glass, system/light/dark themes, sidebar collapses to a drawer below 760px, mobile safe-area aware.
- 🌍 **i18n** — English + Simplified Chinese, auto-detected from the system locale and switchable.

## 📸 Screenshots

> _Coming once the UI settles: `docs/screenshots/desktop-light.png`, `desktop-dark.png`, `mobile.png`._

---

## 🧭 Architecture

```
              React frontend (one UI, reused by every shell)
   ┌──────────────────────────────────────────┐
   │  Components + state                        │
   │  ┌─────────────┐      ┌─────────────────┐ │
   │  │ tauriApi.ts │      │    webApi.ts    │ │
   │  │  (invoke)   │      │  (fetch / SSE)  │ │
   │  └──────┬──────┘      └────────┬────────┘ │
   └─────────┼──────────────────────┼──────────┘
             │                      │
        Tauri IPC            REST + SSE
             │                      │
   ┌─────────┴─────────┐  ┌─────────┴──────────┐
   │     src-tauri/    │  │     taffy-web/     │
   │ (desktop / mobile)│  │   (axum HTTP svc)  │
   └─────────┬─────────┘  └─────────┬──────────┘
             │                      │
             └──────────┬───────────┘
                        │
              ┌─────────┴──────────┐
              │     taffy-core     │  ← shared Rust core
              │ llm · db · mcp     │
              │ skills · embeddings│
              └─────────┬──────────┘
                        │
       ┌────────────┬───┴────┬──────────────┐
   LLM providers  SQLite   MCP tools     OS keyring
 (OpenAI/Claude/ (convos·msgs (stdio +     (keyring)
   Gemini …)      ·KV·vectors) HTTP remote)
```

> The frontend switches transport at compile time via `__IS_TAURI__` (Tauri `invoke` ↔ HTTP `fetch`/SSE); component code is 100% reused.
> Conversations / messages / KV are already shared **semantic endpoints** across both shells (the desktop dropped plugin-sql/store). Web-side semantics for search, RAG and import/export are still in progress (see the [roadmap](#-roadmap)).

### 📚 Companion docs

- [`DOCKER.md`](./DOCKER.md) — Docker-driven Linux + Android builds
- [`MIGRATION.md`](./MIGRATION.md) — the Cherry Studio → this-skeleton porting plan
- [`docs/`](./docs/) — DB migration rules, updater signing/manifest, and other contributor docs

---

## 🚀 Quick start

```bash
git clone git@github.com:zuoliangyu/Taffy-Studio.git
cd Taffy-Studio
pnpm install
pnpm tauri:dev      # first run compiles ~400 Rust crates (5–10 min)
```

Open Settings (⚙ top-right), pick a provider preset (OpenAI / Anthropic / Gemini / DeepSeek / SiliconFlow / Ollama), paste your API key, and chat.

## 🌐 Self-hosted web server

The same code compiles to a **single executable**: run it, open a browser, no desktop needed — great for your machine and for headless Linux servers / Docker.

```powershell
# Windows: produces dist-out\web\taffy-web.exe and runs it (auto-opens the browser)
.\scripts\tasks\build-web.ps1 -Run
```
```bash
# macOS / Linux: produces dist-out/web/taffy-web
RUN=1 ./scripts/tasks/build-web.sh
```

- Defaults to `127.0.0.1:8787` with data in `./taffy.db`. `--host 0.0.0.0` to expose, `--db-path` to relocate data, `--token <secret>` for single-user auth, `--no-open` to skip the browser.
- Provider keys are injected from env vars (`TAFFY_OPENAI_API_KEY` / `TAFFY_ANTHROPIC_API_KEY` / `TAFFY_GEMINI_API_KEY` / fallback `TAFFY_API_KEY`) — the browser never sees them.
- Docker test drive: `.\scripts\tasks\dev-docker.ps1` (or `./scripts/tasks/dev-docker.sh`), see `docker/web.Dockerfile`.

> Web today: chat + conversation history work; full-text search / RAG / import-export are still being made semantic.

## 🗄 Where data / config lives

**The desktop app and the "native server binary" share one database by default** (conversations, messages, settings all in sync), so you can move between the two forms seamlessly:

| Item | Desktop (Tauri) | Server (native binary) | Server (Docker) |
|---|---|---|---|
| Conversations + messages + settings (kv table) | `taffy-studio.db` (app config dir) | the **same** `taffy-studio.db` (shares the desktop DB by default) | `/data/taffy.db` (mounted volume, isolated) |
| API keys | OS keyring (service `com.taffy.studio`) | env vars `TAFFY_*_API_KEY` (recommended); UI entry persists to the `kv` table | same |
| Auto-backups | `backups/` under the app config dir | same | back up / mount that DB file |

The "app config dir" follows the OS:
- Windows: `%APPDATA%\com.taffy.studio\`
- macOS: `~/Library/Application Support/com.taffy.studio/`
- Linux: `~/.config/com.taffy.studio/`

- The DB runs in **WAL mode**, so the desktop app and web server can read/write the same file concurrently.
- Want the web server on its own DB? Pass `--db-path D:\some\taffy.db` (or env `TAFFY_DB_PATH`). Docker is already isolated at `/data/taffy.db`.
- Note: **API keys are not shared** (desktop in the keyring, web in env vars); conversations/settings/templates/MCP config are.

---

## ⚙️ Prerequisites

| Tool | For |
|------|-----|
| Node ≥ 18 + **pnpm** | frontend toolchain |
| **Rust** stable ([rustup](https://rustup.rs)) | the Tauri core |
| Per-OS toolchain | see below |

By OS:
- **Windows** — MSVC Build Tools + WebView2 (ships with Win11)
- **macOS** — `xcode-select --install`
- **Linux** — `libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev librsvg2-dev libxdo-dev libayatana-appindicator3-dev patchelf`
- **Android** — Android Studio + NDK + `ANDROID_HOME` + `NDK_HOME`
- **iOS** — Xcode + an Apple ID (free tier is enough to sideload)

Full setup: <https://v2.tauri.app/start/prerequisites/>

---

## 🛠 Scripts

Every entry point under `scripts/` ships **both a `.ps1` (Windows) and a `.sh` (macOS / Linux / WSL)**.
Each preflights (Node ≥ 18, pnpm, Rust, target toolchain / Docker) and fails with a clear install hint if something is missing.
All packaged artifacts land under **`dist-out/<platform>/`** (desktop installers stay in `target/release/bundle/`).

| Task | Windows (PowerShell) | macOS / Linux (bash) |
|---|---|---|
| Desktop dev (hot-reload) | `.\scripts\dev.ps1` | `./scripts/dev.sh` |
| Android dev | `.\scripts\dev.ps1 android` | `./scripts/dev.sh android` |
| iOS dev | — (Apple-only) | `./scripts/tasks/dev-mac.sh ios` |
| Build Windows installers | `.\scripts\tasks\build-windows.ps1` | `./scripts/tasks/build-windows.sh`¹ |
| Build Linux (Docker) | `.\scripts\tasks\build-linux.ps1` | `./scripts/tasks/build-linux.sh` |
| Build Android (Docker) | `.\scripts\tasks\build-android.ps1` | `./scripts/tasks/build-android.sh` |
| Build macOS / iOS | — (Apple-only) | `./scripts/tasks/build-mac.sh` / `build-mac.sh ios` |
| Build web single-file | `.\scripts\tasks\build-web.ps1` | `./scripts/tasks/build-web.sh` |
| Build / push Docker image | `.\scripts\tasks\build-docker.ps1` | `./scripts/tasks/build-docker.sh` |
| Unified dispatcher | `.\scripts\build.ps1 <target>` | `./scripts/build.sh <target>` |
| Generate icons | `.\scripts\tasks\gen-icons.ps1` | `./scripts/tasks/gen-icons.sh` |
| Local CI (pre-push check) | `.\scripts\tasks\ci-local.ps1` | `./scripts/tasks/ci-local.sh` |

> ¹ Windows installers can only be produced on a Windows host; `build-windows.sh` is for Git Bash / MSYS2 users.
> macOS / iOS can only be built on a real Mac (Apple EULA), so there's no `.ps1` counterpart.

You can also use the pnpm scripts (see `package.json`): `pnpm dev:desktop`, `pnpm build:windows`, `pnpm build:linux`, `pnpm mac:build`, etc.

---

## ✅ Pre-push check: local CI

Run the **exact same** checks as GitHub Actions, inside Docker:

```powershell
.\scripts\tasks\ci-local.ps1        # macOS/Linux: ./scripts/tasks/ci-local.sh
```

Mirrors [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

1. `pnpm install --frozen-lockfile`
2. `pnpm exec tsc -b` (frontend typecheck)
3. `pnpm build` (vite production build)
4. `cargo fmt --all -- --check`
5. `cargo clippy --all-targets -- -D warnings`
6. `cargo check --all-targets`

First run ~5–10 min (image build + cache), then ~2–3 min. `-Reset` wipes cached volumes, `-NoCache` rebuilds the image from scratch.

---

## 🧱 Tech stack

| Layer | What |
|-----|------|
| Shared core | **`crates/taffy-core`** — platform-agnostic Rust: LLM dispatch, SQLite data layer, MCP, skills, embeddings, DTOs |
| Desktop/mobile shell | [Tauri 2](https://v2.tauri.app/) (Rust core + system webview), a thin wrapper delegating to taffy-core |
| Server shell | **`crates/taffy-web`** — axum HTTP + rust-embed frontend + SSE + single-user env token |
| Frontend | React 18 + TypeScript 5 + Vite 5 (one UI across every target) |
| Markdown | `react-markdown` + `remark-gfm` + `react-syntax-highlighter` + `rehype-katex` + `mermaid` |
| Database | SQLite via `taffy-core::db` (**rusqlite**, shared semantic endpoints across desktop & server) |
| Secrets | `keyring` crate (desktop) + Store fallback (mobile) |
| HTTP / SSE | `reqwest` (rustls — no system OpenSSL, mobile-friendly) + a hand-rolled SSE parser |
| Build | pnpm + Cargo workspace + Docker (cross-build Linux / Android from Windows; the Linux image links with mold) |
| CI | GitHub Actions: typecheck + clippy + full-platform matrix build on `v*` tags |

## 📂 Project layout

```
.
├─ Cargo.toml                 # Cargo WORKSPACE root (src-tauri + crates/*) + build profiles
├─ .cargo/config.toml         # build config (faster linkers documented per platform)
├─ index.html                 # Vite entry
├─ src/                       # React frontend (one UI for every shell)
│  ├─ App.tsx / App.css       # layout + glassmorphism design tokens
│  ├─ components/             # ChatPanel · MessageContent · SettingsPanel ·
│  │                          #   McpPanel · McpMarket · SkillsPanel · KnowledgePanel ·
│  │                          #   SearchPalette · ModelPicker · TemplatePicker · …
│  ├─ services/               # api.ts + tauriApi.ts + webApi.ts (transport abstraction)
│  ├─ lib/                    # ipc · llm · mcp · mcpMarket · skills · rag · ocr ·
│  │                          #   attachments · doctext · settings · theme · i18n bridge …
│  └─ i18n/                   # English + Simplified Chinese
├─ crates/
│  ├─ taffy-core/             # ★ platform-agnostic core (no tauri:: / axum::)
│  │  └─ src/                 #   lib · llm · db · mcp · mcp_import · skills
│  └─ taffy-web/              # ★ axum server shell
│     └─ src/                 #   main (routes + env token + SSE + SPA) · static_files (embeds dist/)
├─ src-tauri/                 # Tauri desktop/mobile shell (thin; delegates to taffy-core)
│  ├─ src/                    #   main (desktop entry) · lib (Tauri commands + streaming/agentic loop + storage)
│  ├─ tauri.conf.json
│  ├─ icons/ · capabilities/  # icons · plugin permission grants
├─ docker/                    # cross-platform "build" images (not a runtime service)
│  ├─ ci · linux · android · web .Dockerfile
├─ scripts/                   # every entry has .ps1 + .sh; shared lib/common.{ps1,sh}
├─ dist-out/                  # all packaged artifacts (gitignored)
├─ .github/workflows/         # ci.yml + release.yml
└─ README.md · README.en.md · DOCKER.md · MIGRATION.md
```

---

## 🗺 Roadmap

- [x] Tauri 2 skeleton (Windows/Mac/Linux/iOS/Android)
- [x] SQLite persistence + multi-conversation; data layer sunk into `taffy-core::db` (rusqlite)
- [x] OpenAI-compatible streaming + Anthropic + Gemini native protocols; per-provider model lists
- [x] Stop / regenerate; auto-summarized conversation titles
- [x] Markdown + code highlighting + KaTeX + Mermaid
- [x] Desktop API keys in the OS keyring
- [x] Responsive sidebar + glassmorphism UI + themes (system/light/dark) + i18n (en/zh)
- [x] File attachments (images + PDF/text) + Tesseract.js OCR fallback
- [x] **MCP client** — stdio + remote Streamable HTTP, tool registry, agentic tool-call loop
- [x] **MCP market** — a one-click-importable server directory
- [x] **Skills** — `SKILL.md` storage/import + per-conversation enablement + `use_skill` built-in tool
- [x] **Knowledge base / RAG** — local vector store (cosine), per-conversation injection
- [x] **Shared Rust core** — LLM / data layer / MCP / skills / embeddings split into `crates/taffy-core`
- [x] **Frontend↔backend abstraction** — `services/api.ts` + `tauriApi.ts` + `webApi.ts`, UI decoupled from transport
- [x] **Web shell** — `taffy-web` (axum + rust-embed) + single-user env token + LLM/embed endpoints (SSE)
- [x] **Web Docker image** + one-command local server test
- [ ] **Web end-to-end parity** — semantic endpoints for search / RAG / import-export
- [ ] Streaming-Markdown stability (no flicker on half-rendered tables/code)
- [ ] Token-by-token streaming inside the agentic tool-call loop (currently per-round)
- [ ] Mobile secret storage via Stronghold / Android Keystore / iOS Keychain

## 🤝 Contributing

PRs welcome. Run `ci-local` before pushing (above). Conventions:

- TypeScript strict mode (`tsc -b` must pass); Rust via `cargo fmt` + `cargo clippy -- -D warnings`.
- All JS → Rust calls go through `src/lib/ipc.ts` (no inline `invoke()` in components).
- Put business logic in `crates/taffy-core` (no `tauri::` / `axum::` types there) so shells can reuse it.
- Commit messages: short imperative subject; `feat:` / `fix:` / `docs:` / `chore:` / `refactor:` prefixes encouraged.

Open a GitHub discussion first for larger architectural changes.

## 🙏 Acknowledgements

Design and architecture inspired by:

- **[Cherry Studio](https://github.com/CherryHQ/cherry-studio)** — the AI-workstation feature checklist (AGPL-3.0).
- **[Kelivo](https://github.com/Chevey339/kelivo)** — a Flutter LLM client, mobile UX reference.
- **[EK-OmniProbe](https://github.com/EmbeddedKitOrg/EK-OmniProbe)** — the glassmorphism design language.
- **[Tauri](https://v2.tauri.app/)** — the shell that makes multi-target deployment real.

> All source here is original; the projects above are credited as inspiration only.

## 📄 License

[MIT](./LICENSE) © 2026 zuolan

---

<div align="center">
<sub>Built with <a href="https://v2.tauri.app/">Tauri 2</a> · <a href="https://react.dev/">React</a> · <a href="https://www.rust-lang.org/">Rust</a></sub>
</div>
