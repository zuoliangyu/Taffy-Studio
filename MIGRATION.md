# Cherry Studio → Taffy Studio 迁移清单

把 Cherry Studio (Electron + React + Node) 的功能"端口"到这个 Tauri 2 骨架上。
不是一次性大重写——按本清单 **分四期渐进**。

> **核心思路**
>
> - **renderer 80% 直接搬**：React/TS UI、store、aiCore 逻辑层、components、pages、hooks、i18n、types、utils。
> - **preload bridge 全部换掉**：`window.electron.*` / `window.api.*` → `invoke()` 或 Tauri 插件 API。Cherry Studio renderer 里共 **~196 个文件** 用到了这两个全局对象。
> - **main 进程 100% 重写**：所有 `src/main/` 下的 Node 服务用 Rust 重写，或先用 **Node sidecar** 过渡。

---

## 0. 目录映射

参考 Cherry Studio 的 `src/renderer/src/`（CS）→ 本项目 `app/src/`（FC）：

| CS 目录 | FC 对应 | 处理 |
|---|---|---|
| `App.tsx`, `Router.tsx`, `entryPoint.tsx`, `init.ts` | `src/main.tsx`, `src/App.tsx` | 改写引导，去 multi-window |
| `components/` | `src/components/` | **直接搬**，按需替换 `window.electron` 调用 |
| `pages/` | `src/pages/` | **直接搬** |
| `hooks/` | `src/hooks/` | **直接搬**，桥接 hook 改 IPC |
| `context/`, `providers/` | `src/context/` | **直接搬** |
| `store/` (Redux toolkit / zustand) | `src/store/` | **直接搬**；持久化改走 SQL plugin / Store plugin |
| `services/` | `src/services/` | **逐文件改造**：纯前端逻辑直接搬；调 main 的改 `invoke()` |
| `aiCore/` | `src/aiCore/` | **大部分搬**，HTTP 部分可选择 Rust 侧重做以隐藏 key |
| `i18n/` | `src/i18n/` | **直接搬** |
| `types/`, `utils/`, `config/` | 同名 | **直接搬** |
| `databases/` (Dexie / IndexedDB) | `src/lib/db.ts` (sqlite) | **重写**：把 schema 翻译到 SQL plugin migration |
| `workers/` | `src/workers/` | **直接搬**（Web Worker，浏览器 API） |
| `windows/` (multi-window) | — | **舍弃**，Tauri 用 `WebviewWindow` 重新建模 |
| `handler/`, `queue/`, `trace/` | 视实现而定 | 大部分搬；触底硬依赖（OpenTelemetry node SDK 等）换 Web SDK |

main 进程没有"直接搬"——全部进入下方 §6 的 Rust/sidecar 计划。

---

## 1. 第 1 期：基础聊天可跑（1–2 周）

目标：单 provider（如 OpenAI 兼容）、单对话、消息持久化、模型切换。

- [ ] 把 CS 的 `types/` 全量搬过来 — 后面所有代码都依赖它。
- [ ] `aiCore/` 中**只搬非 Node** 的部分：provider 适配的 fetch 调用、参数构造、stream 解析。
- [ ] 在 Rust 侧实现 `chat_complete`：用 `reqwest` + SSE。
- [ ] 流式输出用 `tauri::ipc::Channel<String>`：renderer 通过 `listen('chat:stream', cb)` 接 token。
- [ ] 用本骨架的 `db.ts` 持久化 conversations / messages。
- [ ] 用 `store.ts` 存 API key（短期）；后面再加 OS keyring（见 §5）。
- [ ] 搬 CS 的核心 `components/Message*`, `components/CodeBlockView`, `pages/Home`。

**搬的过程中遇到的 `window.electron.*` / `window.api.*` 调用**：先注释掉、放进 TODO 列表，第 1 期不必全部实现。

---

## 2. 第 2 期：多 provider + 设置面板（1–2 周）

- [ ] 端口 CS `aiCore/provider/`：OpenAI / Anthropic / Gemini / Bedrock 等。
- [ ] Settings UI：搬 CS 的 settings 页面，存储改走 `setting:get` / `setting:set` 命令（在 Rust 侧用 store plugin）。
- [ ] 模型列表 (`listModels`)：每个 provider 一个 Rust 命令，避免 key 暴露到 webview。
- [ ] i18n：搬 `src/renderer/src/i18n`，几乎零改动。
- [ ] 主题 / 暗色：搬 `src/renderer/src/context/ThemeProvider` 之类的逻辑。

---

## 3. 第 3 期：文件附件 + MCP（2–4 周）

- [ ] 文件附件：用 `@tauri-apps/plugin-dialog` + `@tauri-apps/plugin-fs` 替换 `window.api.file.*`。
- [ ] 图片预览 / 复制：原来 CS 走 IPC 的部分改为 invoke 命令（在 Rust 侧用 `image` crate 处理）。
- [ ] MCP 客户端：**两条路二选一**：
  - **A. Rust-native**：用 [`rust-mcp-sdk`](https://crates.io/crates/rust-mcp-sdk) 重写，长期最干净。
  - **B. Node sidecar**：把 CS `src/main/mcpServers` 打包成 sidecar 二进制（`pnpm pkg`/`node --experimental-sea-config`），Tauri 通过 `tauri-plugin-shell` 启动，stdio JSON-RPC 通信。第 1 版强烈推荐 B。
- [ ] 把 `aiCore/utils/mcp.ts` 中的桥接调用从 `window.api.mcp.*` 换成新的 invoke 命令。

---

## 4. 第 4 期：知识库 / RAG / OCR / 高级特性（开放式）

- [ ] 向量库：CS 用 `libsql` 存 vector。Tauri 侧改用 sqlx + 自带 SQLite，或继续用 `libsql` crate（在 Rust 侧直接绑定）。
- [ ] Embeddings：HTTP 调外部 (OpenAI / Cohere / SiliconFlow / 本地 Ollama) — 纯 HTTP 没有原生依赖。
- [ ] OCR：CS 用 `tesseract.js` (wasm)，本骨架可以**保留 wasm 在 renderer 跑**（最省事），或换 Rust 端 `tesseract-rs`（依赖系统 libtesseract）。
- [ ] 图像处理：`sharp` → Rust `image` crate。
- [ ] Skills / Agents / Workflows：CS 的 `src/renderer/src/aiCore` 里很多是纯逻辑，可以直接搬。
- [ ] 备份 / 同步 (S3 / WebDAV / Nutstore)：S3 用 `aws-sdk-s3` Rust crate；WebDAV 用 `reqwest_dav`。

---

## 5. 横切关注点

### 5.1 替换 `window.electron` / `window.api`

在 renderer 里 grep:

```bash
rg "window\.(electron|api)\." src/
```

按命名空间归组，**每组写一个 Rust command**：

| CS 调用模式 | 替换为 |
|---|---|
| `window.api.file.read(p)` | `invoke('file_read', { path })` ← 用 `tauri-plugin-fs` |
| `window.api.shell.openPath(p)` | `import { open } from '@tauri-apps/plugin-shell'` |
| `window.api.config.get(k)` | `getSetting<T>(k)` (store plugin) |
| `window.electron.ipcRenderer.send/invoke(channel, ...)` | 一对一映射到 `invoke('<cmd>', payload)` |
| `window.api.knowledge.search(q)` | `invoke('knowledge_search', { q })` |

收口到 `src/lib/ipc.ts`，**禁止业务代码直接 `invoke()`**——所有调用都过这一层，方便以后 mock / 监控 / 测试。

### 5.2 API Key 与凭据

桌面：用系统 keyring（`keyring` crate / `tauri-plugin-stronghold`）。
移动：iOS Keychain / Android Keystore，同样过 `tauri-plugin-stronghold` 或自定义插件。
**绝不**把 key 存进 `Store`(JSON 明文)，除非你只是 dev。

### 5.3 流式输出

```rust
// Rust
#[tauri::command]
async fn chat_stream(req: ChatRequest, on_token: tauri::ipc::Channel<String>) -> Result<(), String> {
    // ... SSE loop ...
    on_token.send(token).map_err(|e| e.to_string())?;
    Ok(())
}
```

```ts
// JS
import { Channel } from '@tauri-apps/api/core'
const ch = new Channel<string>()
ch.onmessage = (token) => append(token)
await invoke('chat_stream', { req, onToken: ch })
```

比 event bus 更稳，因为是 typed + 单消费者。

### 5.4 多窗口

CS 用了 main / mini / selection toolbar / trace 等多个 BrowserWindow。Tauri 等价物是
`WebviewWindowBuilder`。第 1 版只做主窗口，第 N 期再加。

### 5.5 Logger

CS 用 electron-log + 自家 `LoggerService`。换 `tauri-plugin-log`，前端用同名 `info/warn/error` 接口，几乎零改动。

---

## 6. main 进程的处置

CS `src/main/` 包含：`aiCore/`, `apiServer/`, `knowledge/`, `mcpServers/`, `services/`, `utils/`, `integration/`, `bootstrap.ts`, `config.ts`。

| 子目录 | Rust 等价 | 推荐 |
|---|---|---|
| `services/file*` | `tauri-plugin-fs` + 自写命令 | **Rust** |
| `services/window*` | Tauri WebviewWindow | **Rust** |
| `services/api*`（内置 OpenAPI server） | `axum` / `actix-web` | Rust，**或第 1 版用 Node sidecar** |
| `mcpServers/` | `rust-mcp-sdk` | **第 1 版 sidecar，第 2 版 Rust** |
| `knowledge/` | `sqlx` + 外部 embeddings HTTP | Rust |
| `aiCore/`（main 侧的） | reqwest + tokio | Rust |
| `integration/`（第三方集成） | reqwest | Rust |
| `bootstrap.ts`, `config.ts` | `lib.rs::setup` | Rust |

### Node sidecar 的具体做法（过渡期神器）

1. 在 `src-tauri/sidecars/` 放一个 Node 可执行（用 `pnpm pkg` 把 CS 的 `apiServer` 或 `mcpServers` 打成 exe）。
2. `tauri.conf.json` → `bundle.externalBin: ["sidecars/node-core"]`，会自动按平台带后缀。
3. Rust 侧用 `tauri::process::Command::new_sidecar("node-core")` 启动，stdio JSON-RPC。
4. 移动端：iOS 因签名/沙箱限制**不能**带 Node 二进制；Android 大多可行但不优雅。**所以 sidecar 只是桌面过渡方案——移动端必须走 Rust 或纯 webview。**

---

## 7. 验收 checklist

每完成一期跑一遍：

- [ ] `pnpm tauri:dev` 三个桌面平台都能起。
- [ ] `pnpm android:dev` + `pnpm ios:dev` 能进首屏。
- [ ] `pnpm tauri:build` 出包，安装能跑且数据持久化。
- [ ] 进程内存 < 200MB（移动端 < 150MB）。
- [ ] 关闭再开，对话记录还在。
- [ ] 切换 system theme，UI 跟随。

---

## 8. 常见坑

- **`SQL plugin` migration 只跑一次**：版本号要严格自增；schema 写错只能加新版本号迁移修，不能"修历史"。
- **`@tauri-apps/api` v2 path 与 v1 不同**：CS 的 `electron-log` 之类的 path API 调用要全部换成 `@tauri-apps/api/path`。
- **WebView 差异**：Linux 上是 WebKitGTK，与 macOS Safari 行为接近；Windows 用 WebView2（Edge Chromium）。CSS 兼容性按 `safari13` 兜底。
- **移动端键盘 / SafeArea**：iOS 自带 `viewport-fit=cover` 后要用 `env(safe-area-inset-*)`；Android 用 `WindowInsets`。CS 桌面布局直接搬到移动会出布局问题，需要响应式改造（**这是 Kelivo 那侧最值得抄的部分** —— Kelivo 的 mobile UX 库选型与布局策略可直接借鉴）。
- **iOS 侧载下的 ATS**：默认禁止 HTTP，所有 LLM endpoint 都要 HTTPS；自签证书要在 Info.plist 加例外。

---

## 9. 时间评估（参考）

| 期 | 范围 | 全职估时 |
|---|---|---|
| 1 | 单 provider + 持久化 + 核心 UI | 1–2 周 |
| 2 | 多 provider + 设置 + i18n + 主题 | 1–2 周 |
| 3 | 文件附件 + MCP（sidecar 版） | 2–4 周 |
| 4 | RAG + OCR + 高级特性 | 开放式（4 周+） |
| MCP / apiServer Rust 化 | §6 表里所有"Rust" 项 | 持续 |

业余开发把上面所有数字 ×3～×5。
