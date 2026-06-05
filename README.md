<div align="center">

<img src="src-tauri/icons/icon.png" alt="Taffy Studio" width="96" height="96" />

# Taffy Studio

**一套代码，七端交付的大模型工作站 —— 基于 Tauri 2 + React + 共享 Rust 核心。**

OpenAI / Anthropic / Gemini 原生协议 · 流式输出 · MCP 工具 + 技能 · 知识库(RAG) · 系统密钥环 · 玻璃拟态 UI
Windows · macOS · Linux · iOS · Android · 浏览器单文件 · Docker

[![CI](https://github.com/zuoliangyu/Taffy-Studio/actions/workflows/ci.yml/badge.svg)](https://github.com/zuoliangyu/Taffy-Studio/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zuoliangyu/Taffy-Studio?include_prereleases&sort=semver)](https://github.com/zuoliangyu/Taffy-Studio/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri)](https://v2.tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-stable-orange?logo=rust)](https://www.rust-lang.org/)

[English](./README.en.md) · **简体中文**

</div>

> [!NOTE]
> **状态：活跃开发中 —— 桌面端可日常使用，移动端可构建，Web/服务器外壳已能聊天。**
> 业务逻辑（LLM 分发、SQLite 数据层、MCP、技能、嵌入）集中在一个**平台无关的 `taffy-core` crate**，
> 桌面（Tauri）与服务器（axum）两个外壳共享同一套核心，前端一套 UI 全端复用。

---

## 📦 下载

> 最新版本 **[v0.0.1](https://github.com/zuoliangyu/Taffy-Studio/releases/latest)** · 完整变更见 [CHANGELOG.md](./CHANGELOG.md)

到 [Releases 页](https://github.com/zuoliangyu/Taffy-Studio/releases) 按平台下载：

| 平台 | 文件 |
|---|---|
| Windows | `.msi` / `.exe`（NSIS 安装器）/ `*-portable.exe`（免安装便携版） |
| macOS | `.dmg`（Intel + Apple Silicon 各一份） |
| Linux | `.deb` / `.AppImage` |
| Android | `.apk`（调试签名，可侧载） |
| Web 服务 | `taffy-web-*` 单文件（各系统），或 Docker 镜像 `ghcr.io/zuoliangyu/taffy-web` |

> 桌面端依赖系统 WebView2（Win11 自带；旧 Win10 可能需装一次）。

---

## ✨ 它能做什么

- 🌐 **一套代码，七种交付** —— Windows / macOS / Linux / iOS / Android 五个原生端（Tauri 2），外加**浏览器单文件**自托管服务与 **Docker** 镜像。
- 🤖 **多服务商，原生协议** —— OpenAI 兼容（OpenAI / DeepSeek / SiliconFlow / Ollama / 任意 base URL）、**Anthropic** `/v1/messages`、**Gemini** `streamGenerateContent`。按服务商自动拉取模型列表。
- 🚀 **流式优先** —— 逐 token 推送（桌面走 `tauri::ipc::Channel`，Web 走 SSE），内置停止 / 重新生成。
- 🧩 **MCP 工具 + 市场** —— 接入 MCP 服务器（stdio 本地 + Streamable HTTP 远程），内置 agentic 工具调用循环（OpenAI & Anthropic），并带一个可一键导入的 **MCP 市场**。
- 🛠 **技能（Skills）** —— `SKILL.md` 形式的可复用提示/能力包，支持导入与按会话启用。
- 📚 **知识库 / RAG** —— 本地向量库（余弦检索），按会话注入检索上下文。
- 📎 **附件与 OCR** —— 图片（视觉模型）、PDF / 文本文档（客户端抽取文本拼进 prompt）；非视觉模型用 Tesseract.js 兜底识图。
- 📝 **富文本渲染** —— GitHub 风味 Markdown、代码高亮（带复制）、KaTeX 公式、Mermaid 图表（懒加载）。
- 🔐 **密钥安全** —— API 密钥存**系统密钥环**（Windows 凭据管理器 / macOS 钥匙串 / Linux libsecret）；服务器版从环境变量注入，浏览器永不接触密钥。
- 🎨 **玻璃拟态 UI** —— HSL 令牌体系、蓝灰玻璃质感、跟随系统/浅色/深色主题、< 760px 侧栏折叠为抽屉，移动端适配安全区。
- 🌍 **国际化** —— 英文 + 简体中文，自动识别系统语言并可手动切换。

## 📸 截图

> _UI 稳定后补充：`docs/screenshots/desktop-light.png`、`desktop-dark.png`、`mobile.png`。_

---

## 🧭 架构

```
              React 前端（一套 UI，全外壳复用）
   ┌──────────────────────────────────────────┐
   │  Components + 状态                         │
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
   │  (桌面 / 移动外壳)│  │   (axum HTTP 服务) │
   └─────────┬─────────┘  └─────────┬──────────┘
             │                      │
             └──────────┬───────────┘
                        │
              ┌─────────┴──────────┐
              │     taffy-core     │  ← 共享 Rust 核心
              │ llm · db · mcp     │
              │ skills · embeddings│
              └─────────┬──────────┘
                        │
       ┌────────────┬───┴────┬──────────────┐
   LLM 服务商     SQLite   MCP 工具     系统密钥环
 (OpenAI/Claude/ (会话·消息  (stdio +     (keyring)
   Gemini …)      ·KV·向量)  HTTP 远程)
```

> 前端通过编译期变量 `__IS_TAURI__` 自动切换传输层（Tauri `invoke` ↔ HTTP `fetch`/SSE），组件代码 100% 复用。
> 会话 / 消息 / KV 已是两端共用的**语义端点**（桌面已移除 plugin-sql/store）。搜索、RAG、导入导出的 Web 端语义化仍在进行（见[路线图](#-路线图)）。

### 📚 配套文档

- [`DOCKER.md`](./DOCKER.md) —— 基于 Docker 的 Linux + Android 构建
- [`MIGRATION.md`](./MIGRATION.md) —— Cherry Studio → 本骨架的移植计划
- [`docs/`](./docs/) —— 数据库迁移规则、自动更新签名与清单等贡献者文档

---

## 🚀 快速开始

```bash
git clone git@github.com:zuoliangyu/Taffy-Studio.git
cd Taffy-Studio
pnpm install
pnpm tauri:dev      # 首次会编译约 400 个 Rust crate（5–10 分钟）
```

打开右上角「设置 ⚙」，选一个服务商预设（OpenAI / Anthropic / Gemini / DeepSeek / SiliconFlow / Ollama），粘贴 API 密钥即可开聊。

## 🌐 自托管 Web 服务（服务器版）

同一套代码可编译成**单个可执行文件**：运行后浏览器访问，无需桌面环境 —— 适合本机，也适合无桌面的 Linux 服务器 / Docker。

```powershell
# Windows：产出 dist-out\web\taffy-web.exe，构建完直接运行（自动开浏览器）
.\scripts\tasks\build-web.ps1 -Run
```
```bash
# macOS / Linux：产出 dist-out/web/taffy-web
RUN=1 ./scripts/tasks/build-web.sh
```

- 默认监听 `127.0.0.1:8787`、数据存 `./taffy.db`。`--host 0.0.0.0` 对外暴露，`--db-path` 改数据位置，`--token <密钥>` 开单用户鉴权，`--no-open` 关闭自动开浏览器。
- 服务商密钥从环境变量注入（`TAFFY_OPENAI_API_KEY` / `TAFFY_ANTHROPIC_API_KEY` / `TAFFY_GEMINI_API_KEY` / 兜底 `TAFFY_API_KEY`）—— 浏览器永不接触密钥。
- Docker 测试：`.\scripts\tasks\dev-docker.ps1`（或 `./scripts/tasks/dev-docker.sh`），见 `docker/web.Dockerfile`。

> 当前 Web 端：聊天 + 会话历史可用；全文搜索 / RAG / 导入导出仍在语义化中。

## 🗄 数据 / 配置存储位置

**桌面端与"服务器版原生二进制"默认共用同一个库**（会话、消息、设置互通），便于在两种形态间无缝切换：

| 内容 | 桌面端（Tauri） | 服务器版（原生二进制） | 服务器版（Docker） |
|---|---|---|---|
| 会话 + 消息 + 设置（kv 表） | `taffy-studio.db`（应用配置目录） | **同一个** `taffy-studio.db`（默认共用桌面库） | `/data/taffy.db`（挂卷，独立隔离） |
| API 密钥 | 系统密钥环（服务名 `com.taffy.studio`） | 环境变量 `TAFFY_*_API_KEY`（推荐）；界面填写则入库 `kv` 表 | 同左 |
| 自动备份 | 应用配置目录下的 `backups/` | 同左 | 直接备份 / 挂载那个 DB 文件 |

「应用配置目录」随系统：
- Windows：`%APPDATA%\com.taffy.studio\`
- macOS：`~/Library/Application Support/com.taffy.studio/`
- Linux：`~/.config/com.taffy.studio/`

- 数据库开了 **WAL 模式**，桌面端和 web 服务同时读写同一文件也安全。
- 想让 web 用独立库？加 `--db-path D:\some\taffy.db`（或环境变量 `TAFFY_DB_PATH`）。Docker 默认就是隔离的 `/data/taffy.db`。
- 注意：**API 密钥不共享**（桌面在密钥环、web 在环境变量）；会话/设置/模板/MCP 配置是共享的。

---

## ⚙️ 前置条件

| 工具 | 用途 |
|------|------|
| Node ≥ 18 + **pnpm** | 前端工具链 |
| **Rust** stable（[rustup](https://rustup.rs)） | Tauri 核心 |
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

`scripts/` 下每个入口都**同时提供 `.ps1`（Windows）与 `.sh`（macOS / Linux / WSL）两个版本**，
都会先做预检（Node ≥ 18、pnpm、Rust、目标工具链 / Docker），缺什么直接报错并给出安装提示。
所有平台的成品统一输出到 **`dist-out/<平台>/`**（桌面安装包除外，留在 `target/release/bundle/`）。

| 任务 | Windows (PowerShell) | macOS / Linux (bash) |
|---|---|---|
| 桌面开发（热重载） | `.\scripts\dev.ps1` | `./scripts/dev.sh` |
| Android 开发 | `.\scripts\dev.ps1 android` | `./scripts/dev.sh android` |
| iOS 开发 | —（Apple 限定） | `./scripts/tasks/dev-mac.sh ios` |
| 构建 Windows 安装包 | `.\scripts\tasks\build-windows.ps1` | `./scripts/tasks/build-windows.sh`¹ |
| 构建 Linux（Docker） | `.\scripts\tasks\build-linux.ps1` | `./scripts/tasks/build-linux.sh` |
| 构建 Android（Docker） | `.\scripts\tasks\build-android.ps1` | `./scripts/tasks/build-android.sh` |
| 构建 macOS / iOS | —（Apple 限定） | `./scripts/tasks/build-mac.sh` / `build-mac.sh ios` |
| 构建 Web 单文件 | `.\scripts\tasks\build-web.ps1` | `./scripts/tasks/build-web.sh` |
| 构建 / 推送 Docker 镜像 | `.\scripts\tasks\build-docker.ps1` | `./scripts/tasks/build-docker.sh` |
| 统一调度器 | `.\scripts\build.ps1 <target>` | `./scripts/build.sh <target>` |
| 生成图标 | `.\scripts\tasks\gen-icons.ps1` | `./scripts/tasks/gen-icons.sh` |
| 本地 CI（推送前自检） | `.\scripts\tasks\ci-local.ps1` | `./scripts/tasks/ci-local.sh` |

> ¹ Windows 安装包只能在 Windows 主机上产出；`build-windows.sh` 供 Git Bash / MSYS2 用户使用。
> macOS / iOS 只能在真机 Mac 上构建（Apple EULA 限制），故没有对应的 `.ps1`。

也可走 pnpm 脚本（见 `package.json`）：`pnpm dev:desktop`、`pnpm build:windows`、`pnpm build:linux`、`pnpm mac:build` 等。

---

## ✅ 推送前自检：本地 CI

在本地 Docker 里跑与 GitHub Actions **完全相同**的检查：

```powershell
.\scripts\tasks\ci-local.ps1        # macOS/Linux：./scripts/tasks/ci-local.sh
```

对应 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：

1. `pnpm install --frozen-lockfile`
2. `pnpm exec tsc -b`（前端类型检查）
3. `pnpm build`（vite 生产构建）
4. `cargo fmt --all -- --check`
5. `cargo clippy --all-targets -- -D warnings`
6. `cargo check --all-targets`

首次约 5–10 分钟（构建镜像 + 缓存），后续约 2–3 分钟。`-Reset` 清缓存卷，`-NoCache` 从头重建镜像。

---

## 🧱 技术栈

| 层 | 内容 |
|-----|------|
| 共享核心 | **`crates/taffy-core`** —— 平台无关 Rust：LLM 分发、SQLite 数据层、MCP、技能、嵌入、DTO |
| 桌面/移动外壳 | [Tauri 2](https://v2.tauri.app/)（Rust 核心 + 系统 webview），薄封装委托给 taffy-core |
| 服务器外壳 | **`crates/taffy-web`** —— axum HTTP + rust-embed 内嵌前端 + SSE + 单用户 env token |
| 前端 | React 18 + TypeScript 5 + Vite 5（一套 UI 全端复用） |
| Markdown | `react-markdown` + `remark-gfm` + `react-syntax-highlighter` + `rehype-katex` + `mermaid` |
| 数据库 | SQLite，经 `taffy-core::db`（**rusqlite**，桌面与服务器共用语义端点） |
| 密钥 | `keyring` crate（桌面）+ Store 降级（移动端） |
| HTTP / SSE | `reqwest`（rustls，不依赖系统 OpenSSL，对移动端友好）+ 自研 SSE 解析 |
| 构建 | pnpm + Cargo workspace + Docker（在 Windows 上交叉构建 Linux / Android；Linux 镜像用 mold 加速链接） |
| CI | GitHub Actions：类型检查 + clippy + 打 `v*` tag 时矩阵构建全平台 |

## 📂 项目结构

```
.
├─ Cargo.toml                 # Cargo WORKSPACE 根（src-tauri + crates/*）+ 构建 profile
├─ .cargo/config.toml         # 链接器等构建配置（更快链接器按平台文档化）
├─ index.html                 # Vite 入口
├─ src/                       # React 前端（所有外壳共用一套 UI）
│  ├─ App.tsx / App.css       # 布局 + 玻璃拟态设计令牌
│  ├─ components/             # ChatPanel · MessageContent · SettingsPanel ·
│  │                          #   McpPanel · McpMarket · SkillsPanel · KnowledgePanel ·
│  │                          #   SearchPalette · ModelPicker · TemplatePicker · …
│  ├─ services/               # api.ts + tauriApi.ts + webApi.ts（传输抽象层）
│  ├─ lib/                    # ipc · llm · mcp · mcpMarket · skills · rag · ocr ·
│  │                          #   attachments · doctext · settings · theme · i18n 桥接 …
│  └─ i18n/                   # 英文 + 简体中文
├─ crates/
│  ├─ taffy-core/             # ★ 平台无关核心（无 tauri:: / axum::）
│  │  └─ src/                 #   lib · llm · db · mcp · mcp_import · skills
│  └─ taffy-web/              # ★ axum 服务器外壳
│     └─ src/                 #   main（路由 + env token + SSE + SPA）· static_files（内嵌 dist/）
├─ src-tauri/                 # Tauri 桌面/移动外壳（薄；委托给 taffy-core）
│  ├─ src/                    #   main（桌面入口）· lib（Tauri 命令 + 流式/agentic 循环 + 存储）
│  ├─ tauri.conf.json
│  ├─ icons/ · capabilities/  # 图标 · 插件权限授予
├─ docker/                    # 跨平台「构建」镜像（非运行时服务）
│  ├─ ci · linux · android · web .Dockerfile
├─ scripts/                   # 每个入口都有 .ps1 + .sh；共享 lib/common.{ps1,sh}
├─ dist-out/                  # 所有平台成品（已 gitignore）
├─ .github/workflows/         # ci.yml + release.yml
└─ README.md · README.en.md · DOCKER.md · MIGRATION.md
```

---

## 🗺 路线图

- [x] Tauri 2 骨架（Windows/Mac/Linux/iOS/Android）
- [x] SQLite 持久化 + 多会话；数据层下沉到 `taffy-core::db`(rusqlite)
- [x] OpenAI 兼容流式 + Anthropic + Gemini 原生协议；按服务商拉取模型列表
- [x] 停止 / 重新生成；会话标题自动摘要
- [x] Markdown + 代码高亮 + KaTeX + Mermaid
- [x] 桌面 API 密钥存系统密钥环
- [x] 响应式侧栏 + 玻璃拟态 UI + 主题（系统/浅/深）+ 国际化（英/中）
- [x] 文件附件（图片 + PDF/文本）+ Tesseract.js OCR 兜底
- [x] **MCP 客户端** —— stdio + Streamable HTTP 远程、工具注册表、agentic 工具调用循环
- [x] **MCP 市场** —— 可一键导入的服务器目录
- [x] **技能（Skills）** —— `SKILL.md` 存储/导入 + 按会话启用 + `use_skill` 内置工具
- [x] **知识库 / RAG** —— 本地向量库（余弦）、按会话注入
- [x] **共享 Rust 核心** —— LLM / 数据层 / MCP / 技能 / 嵌入拆入 `crates/taffy-core`
- [x] **前后端抽象层** —— `services/api.ts` + `tauriApi.ts` + `webApi.ts`，UI 与传输解耦
- [x] **Web 外壳** —— `taffy-web`(axum + rust-embed) + 单用户 env token + LLM/embed 端点(SSE)
- [x] **Web Docker 镜像** + 本地一键起服务测试
- [ ] **Web 端到端完整化** —— 搜索 / RAG / 导入导出的语义端点
- [ ] 流式 Markdown 稳定性（表格/代码半渲染不闪烁）
- [ ] agentic 工具调用循环内的逐 token 流式（目前按轮）
- [ ] 移动端密钥存储用 Stronghold / Android Keystore / iOS Keychain

## 🤝 贡献

欢迎 PR。推送前跑 `ci-local`（见上）。约定：

- TypeScript 严格模式（`tsc -b` 必须通过）；Rust 走 `cargo fmt` + `cargo clippy -- -D warnings`。
- 所有 JS → Rust 调用走 `src/lib/ipc.ts`（组件里不要内联 `invoke()`）。
- 业务逻辑放进 `crates/taffy-core`（那里不出现 `tauri::` / `axum::` 类型），以便外壳复用。
- 提交信息：简短祈使句；鼓励 `feat:` / `fix:` / `docs:` / `chore:` / `refactor:` 前缀。

较大的架构改动请先在 GitHub 开个 discussion。

## 🙏 致谢

设计与架构受以下项目启发：

- **[Cherry Studio](https://github.com/CherryHQ/cherry-studio)** —— AI 工作站功能清单（AGPL-3.0）。
- **[Kelivo](https://github.com/Chevey339/kelivo)** —— Flutter 大模型客户端，移动端 UX 参考。
- **[EK-OmniProbe](https://github.com/EmbeddedKitOrg/EK-OmniProbe)** —— 玻璃拟态设计语言。
- **[Tauri](https://v2.tauri.app/)** —— 让多端部署成为现实的外壳。

> 本仓库源码均为原创；上述项目仅作致谢。

## 📄 许可

[MIT](./LICENSE) © 2026 zuolan

---

<div align="center">
<sub>由 <a href="https://v2.tauri.app/">Tauri 2</a> · <a href="https://react.dev/">React</a> · <a href="https://www.rust-lang.org/">Rust</a> 构建</sub>
</div>
