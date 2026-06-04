<div align="center">

<img src="src-tauri/icons/icon.png" alt="Taffy Studio" width="96" height="96" />

# Taffy Studio

**基于 Tauri 2 的跨平台大模型聊天客户端。**

玻璃拟态 UI · OpenAI / Anthropic / Gemini 原生协议 · 流式输出 · 系统密钥环存密钥 · Markdown + KaTeX + Mermaid · Windows / macOS / Linux / iOS / Android。

[![CI](https://github.com/your-org/taffy-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/taffy-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri)](https://v2.tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-stable-orange?logo=rust)](https://www.rust-lang.org/)

[English](./README.en.md) · **简体中文**

</div>

> [!NOTE]
> **状态：早期 —— 桌面端可用，移动端能构建，触屏 UI 仍在打磨。**
> 骨架（Tauri 2 + React + SQLite + 流式 + 多服务商 + 系统密钥环）已就位；
> Rust 业务逻辑现已抽到一个**平台无关的 `taffy-core` crate**，以便后续第二个外壳
> （自托管 Web 服务）复用同一套核心。

## 🧭 架构

```
              React 前端（一套 UI，全外壳复用）
   ┌──────────────────────────────────────────┐
   │  Components + 状态                         │
   │  ┌────────────┐      ┌─────────────────┐  │
   │  │ tauriApi.ts │      │    webApi.ts    │  │
   │  │  (invoke)   │      │  (fetch / SSE)  │  │
   │  └──────┬──────┘      └────────┬────────┘  │
   └─────────┼──────────────────────┼───────────┘
             │                      │
        Tauri IPC            REST + SSE/WebSocket
             │                      │
   ┌─────────┴─────────┐  ┌─────────┴──────────┐
   │     src-tauri/    │  │     taffy-web/     │
   │  (Tauri 桌面/移动)│  │ (Axum HTTP · 规划) │
   └─────────┬─────────┘  └─────────┬──────────┘
             │                      │
             └──────────┬───────────┘
                        │
              ┌─────────┴──────────┐
              │     taffy-core     │  ← 共享 Rust 核心
              │  llm（分发 / SSE） │
              │  embeddings / DTO  │
              └─────────┬──────────┘
                        │
         ┌──────────────┼───────────────┐
         │              │               │
    LLM 服务商        SQLite       MCP / 系统密钥环
 (OpenAI/Claude/    (会话·消息)   (stdio 工具 / keyring)
   Gemini …)
```

> 前端通过编译期变量 `__IS_TAURI__` 自动切换 API 层（Tauri `invoke` ↔ HTTP `fetch`/SSE），组件代码 100% 复用。
> 现状：`taffy-core`（含 SQLite 数据层）、前端 `api` 抽象层、`taffy-web`(axum) 均已落地 —— 会话/消息/KV 已是两端共用的**语义端点**，桌面已移除 plugin-sql/store。搜索 / RAG / 导入导出的语义化、移动端密钥仍在进行中（见[路线图](#-路线图)）。

### 📚 配套文档

- [`docs/MIGRATIONS.md`](./docs/MIGRATIONS.md) —— 数据库迁移规则（贡献者须读）
- [`docs/UPDATER.md`](./docs/UPDATER.md) —— 自动更新的签名密钥、清单、托管与轮换
- [`MIGRATION.md`](./MIGRATION.md) —— Cherry Studio → 本骨架的移植计划
- [`DOCKER.md`](./DOCKER.md) —— 基于 Docker 的 Linux + Android 构建

---

## ✨ 特性

- 🌐 **一套代码，五端** —— Windows、macOS、Linux、iOS、Android（Tauri 2）。
- 🧩 **共享 Rust 核心** —— 业务逻辑（LLM 分发、嵌入、DTO）集中在平台无关的 `taffy-core` crate；Tauri 外壳只是薄封装，Web/服务端外壳也能复用同一核心。
- 🚀 **流式优先** —— 通过 `tauri::ipc::Channel` 逐 token 推送；内置停止 / 重新生成。
- 🤖 **多服务商 · 原生协议** —— OpenAI 兼容（OpenAI / DeepSeek / SiliconFlow / Ollama / 任意 base URL）、**Anthropic**（`/v1/messages`）、**Gemini**（`streamGenerateContent`）。API 密钥存于**系统密钥环**（Win 凭据管理器 / macOS 钥匙串 / libsecret）。
- 📝 **富文本渲染** —— GitHub 风味 Markdown、带复制按钮的代码高亮、KaTeX 公式（`$行内$` / `$$块级$$`）、Mermaid 图表（懒加载）。
- 💾 **本地优先** —— 会话与消息通过 `tauri-plugin-sql` 持久化到 SQLite。
- 🎨 **玻璃拟态 UI** —— HSL 颜色令牌体系、蓝灰玻璃质感、径向渐变背景、自动深色模式。
- 📱 **响应式** —— 桌面侧栏在 760px 以下折叠为抽屉；iOS/Android 适配安全区。
- 🔐 **便于侧载** —— 不依赖应用商店；更新插件已为自托管发布预配置。

## 📸 截图

> _UI 稳定后在此补充截图。_
> `docs/screenshots/desktop-light.png`、`docs/screenshots/desktop-dark.png`、`docs/screenshots/mobile.png`

---

## 🚀 快速开始

```bash
git clone https://github.com/your-org/taffy-studio.git
cd taffy-studio
pnpm install
pnpm tauri:dev      # 首次运行会编译约 400 个 Rust crate（5–10 分钟）
```

打开「设置」（右上角 ⚙），选一个服务商预设（OpenAI / Anthropic / Gemini / DeepSeek / SiliconFlow / Ollama），粘贴你的 API 密钥，即可开聊。

## ⚙️ 前置条件

| 工具 | 用途 |
|------|------|
| Node ≥ 18 + **pnpm** | 前端工具链 |
| **Rust**（用 [rustup](https://rustup.rs) 装 stable） | Tauri 核心 |
| 各系统工具链 | 见下 |

按系统：
- **Windows** —— MSVC Build Tools + WebView2（Win11 自带）
- **macOS** —— `xcode-select --install`
- **Linux** —— `libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev librsvg2-dev libxdo-dev libayatana-appindicator3-dev patchelf`
- **Android** —— Android Studio + NDK + `ANDROID_HOME` + `NDK_HOME`
- **iOS** —— Xcode + Apple ID（免费档即可侧载）

完整配置：<https://v2.tauri.app/start/prerequisites/>

---

## 🛠 脚本

### Windows 主机

```powershell
# 开发（热重载，本机）
.\scripts\dev.ps1                  # 桌面窗口               [默认]
.\scripts\dev.ps1 android          # 模拟器 / USB 真机

# 构建发行包
.\scripts\build.ps1 windows        # 本机原生 —— 最快      [默认]
.\scripts\build.ps1 linux          # Docker → dist-linux/{*.deb,*.AppImage}
.\scripts\build.ps1 android        # Docker → dist-android/*.apk
.\scripts\build.ps1 all            # windows + linux + android

# 本地 CI（推送前跑全部检查）
.\scripts\ci-local.ps1
```

### macOS 主机

```bash
./scripts/dev-mac.sh               # 桌面
./scripts/dev-mac.sh ios
./scripts/dev-mac.sh android

./scripts/build-mac.sh             # .app + .dmg           [默认]
./scripts/build-mac.sh ios         # .ipa（侧载）
./scripts/build-mac.sh all         # mac + ios + android + linux

./scripts/ci-local.sh
```

所有脚本都会做预检（Node ≥ 18、pnpm、Rust，以及各目标的工具链检查），缺什么会直接报错并给出具体安装提示。

---

## ✅ 推送前自检：本地 CI

在本地 Docker 里跑与 GitHub Actions **完全相同**的检查 —— 推送前先抓回归：

```powershell
.\scripts\ci-local.ps1
```

对应 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：

1. `pnpm install --frozen-lockfile`
2. `pnpm exec tsc -b`       （前端类型检查）
3. `pnpm build`              （vite 生产构建）
4. `cargo fmt --all -- --check`
5. `cargo clippy --all-targets -- -D warnings`
6. `cargo check --all-targets`

首次约 5–10 分钟（构建镜像 + 缓存）。后续约 2–3 分钟（复用 node_modules + cargo registry 缓存）。

```powershell
.\scripts\ci-local.ps1 -Reset       # 若 lockfile 变动导致诡异问题，清掉缓存卷
.\scripts\ci-local.ps1 -NoCache     # 从头重建 CI 镜像
```

---

## 🧱 技术栈

| 层 | 内容 |
|-----|------|
| 核心 | **`crates/taffy-core`** —— 平台无关的 Rust（LLM 分发、嵌入、DTO），所有外壳共享 |
| 外壳 | [Tauri 2](https://v2.tauri.app/)（Rust 核心 + 系统 webview）；Web/服务端外壳规划中 |
| 前端 | React 18 + TypeScript 5 + Vite 5 |
| Markdown | `react-markdown` + `remark-gfm` + `react-syntax-highlighter` + `rehype-katex` + `mermaid` |
| 数据库 | SQLite，经 `tauri-plugin-sql`（底层 sqlx） |
| 密钥 | `keyring` crate（桌面）+ Store 降级（移动端） |
| HTTP / SSE | `reqwest`（rustls —— 不依赖系统 OpenSSL，对移动端友好）+ 自研 SSE 解析 |
| 构建 | pnpm + Cargo workspace + Docker（在 Windows 上交叉构建 Linux / Android） |
| CI | GitHub Actions：类型检查 + clippy + 打 tag 时矩阵构建桌面端 |

## 📂 项目结构

```
app/
├─ Cargo.toml                        # Cargo WORKSPACE 根（src-tauri + crates/*）
├─ index.html                        # Vite 入口
├─ src/                              # React 前端（所有外壳共用一套 UI）
│  ├─ main.tsx                       # React 启动
│  ├─ App.tsx                        # 布局（顶栏 + 侧栏 + 主区）
│  ├─ App.css                        # EK-OmniProbe 风格设计令牌 + 玻璃质感
│  ├─ components/
│  │  ├─ ChatPanel.tsx               # 消息 + 输入框 + 停止/重新生成
│  │  ├─ MessageContent.tsx          # Markdown + KaTeX + Mermaid
│  │  └─ SettingsPanel.tsx           # 服务商配置 + 密钥环存储的 API 密钥
│  └─ lib/
│     ├─ ipc.ts                      # 所有 invoke() 调用都走这里
│     ├─ db.ts                       # SQLite（plugin-sql）
│     ├─ store.ts                    # 持久化 KV（plugin-store）
│     ├─ settings.ts                 # 类型化配置 + 密钥环迁移
│     └─ llm.ts                      # ChatRequest / chatStream 契约
├─ crates/
│  ├─ taffy-core/                    # ★ 平台无关核心 —— 不含 tauri:: / axum::
│  │  └─ src/
│  │     ├─ lib.rs                   # 重新导出
│  │     └─ llm.rs                   # 服务商分发、SSE 解析、流式、list_models / chat_complete / embed_texts
│  └─ taffy-web/                     # ★ Web/服务端外壳（axum + rust-embed）
│     └─ src/
│        ├─ main.rs                  # 路由 + 单用户 env token + SSE + SPA 托管
│        └─ static_files.rs          # 内嵌 dist/
├─ src-tauri/                        # Tauri 桌面/移动外壳（薄；委托给 taffy-core）
│  ├─ src/
│  │  ├─ main.rs                     # 桌面入口
│  │  ├─ lib.rs                      # Tauri 命令 + 流式/agentic 循环 + 存储
│  │  └─ mcp.rs                      # MCP stdio 客户端
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  └─ capabilities/                  # 插件权限授予
├─ docker/                           # 跨平台「构建」镜像（不是运行时服务器）
│  ├─ ci.Dockerfile                  # 本地 CI 校验
│  ├─ linux.Dockerfile               # Linux deb + AppImage
│  └─ android.Dockerfile             # Android APK
├─ scripts/                          # Win + Mac 的 dev / build / ci-local
├─ .github/workflows/                # ci.yml + release.yml
├─ DOCKER.md                         # Docker 构建说明
├─ MIGRATION.md                      # Cherry Studio 移植计划
├─ README.md                         # 你在这里（简体中文，默认）
└─ README.en.md                      # English
```

---

## 🗺 路线图

详见 [`MIGRATION.md`](./MIGRATION.md)。概览：

- [x] Tauri 2 骨架（Windows/Mac/Linux/iOS/Android）
- [x] SQLite 持久化 + 多会话
- [x] OpenAI 兼容流式 + Anthropic + Gemini 原生协议
- [x] 停止 / 重新生成
- [x] Markdown + 代码高亮 + KaTeX + Mermaid
- [x] 桌面端 API 密钥存系统密钥环
- [x] 响应式侧栏（< 760px 变抽屉）
- [x] EK-OmniProbe 风格玻璃拟态 UI
- [x] 本地 + GitHub Actions CI
- [x] 按服务商自动拉取模型列表
- [x] 会话标题自动摘要
- [x] 分包（按 vendor 切块；pdf.js / tesseract 懒加载）
- [x] **国际化** —— 英文 + 简体中文，自动识别系统语言 + 可手动切换
- [x] **主题控制** —— 跟随系统 / 浅色 / 深色（覆盖系统媒体查询）
- [x] **文件附件** —— 图片（视觉）+ PDF / 文本文档（客户端抽取文本拼进 prompt）
- [x] **OCR** —— 非视觉模型下用 Tesseract.js 兜底识图
- [x] **MCP 客户端** —— stdio 服务器、工具注册表、agentic 工具调用循环（OpenAI + Anthropic）
- [x] **知识库 / RAG** —— 本地向量库（暴力余弦）、按会话注入检索
- [x] **共享 Rust 核心** —— 把平台无关逻辑（LLM / 嵌入 / DTO）拆出到 `crates/taffy-core`
- [x] **前端后端抽象层** —— `services/api.ts` + `tauriApi.ts` + `webApi.ts`，UI 与传输彻底解耦
- [x] **Web 外壳骨架** —— `taffy-web`(axum + rust-embed) + 单用户 env token + LLM/embed 端点(SSE)
- [x] **数据层下沉到核心** —— SQLite 迁移 / 会话 / 消息 / KV 移入 `taffy-core::db`(rusqlite)，桌面与 Web 共用语义端点；桌面已移除 plugin-sql/store
- [x] **Web Docker 镜像** —— `docker/web.Dockerfile` + `scripts/dev-docker.{ps1,sh}`（本地一键起 web 服务测试）
- [ ] **Web 端到端完整化** —— 搜索 / RAG / 导入导出的语义端点（当前桌面走低层 SQL 通路、Web 暂不可用）
- [ ] 流式 Markdown 稳定性（表格/代码半渲染时不闪烁）
- [ ] agentic 工具调用循环内的逐 token 流式（目前是按轮）
- [ ] 移动端密钥存储用 Stronghold / Android Keystore / iOS Keychain

## 🤝 贡献

欢迎 PR。推送前：

```powershell
.\scripts\ci-local.ps1    # Mac/Linux 用 .\scripts\ci-local.sh
```

约定：
- TypeScript 严格模式（`tsc -b` 必须通过）。
- Rust：`cargo fmt`、`cargo clippy -- -D warnings`。
- 提交信息：简短祈使句主题；鼓励但不强制 `feat:` / `fix:` / `docs:` / `chore:` / `refactor:` 前缀。
- 所有 JS → Rust 调用都走 `src/lib/ipc.ts`（组件里不要内联 `invoke()`）。
- 业务逻辑放进 `crates/taffy-core`（那里不出现 `tauri::` 类型），以便将来外壳复用。

Issue 与讨论：在 GitHub 开。较大的架构改动请先开个 discussion。

## 🙏 致谢

Taffy Studio 的设计与架构受以下项目启发：

- **[Cherry Studio](https://github.com/CherryHQ/cherry-studio)** —— AI 工作站功能清单（AGPL-3.0）。
- **[Kelivo](https://github.com/Chevey339/kelivo)** —— Flutter 大模型客户端，移动端 UX 参考。
- **[EK-OmniProbe](https://github.com/EmbeddedKitOrg/EK-OmniProbe)** —— 移植到聊天界面的玻璃拟态设计语言。
- **[Tauri](https://v2.tauri.app/)** —— 让五端部署变得现实的外壳。

> 本仓库源码均为原创；上述项目仅作致谢 —— 它们公开的思路、文件结构或视觉语言为这里的取舍提供了参考。

## 📄 许可

[MIT](./LICENSE) © 2026 zuolan

---

<div align="center">
<sub>由 <a href="https://v2.tauri.app/">Tauri 2</a> · <a href="https://react.dev/">React</a> · <a href="https://www.rust-lang.org/">Rust</a> 构建</sub>
</div>
