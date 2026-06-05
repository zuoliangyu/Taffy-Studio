# 更新日志

本文件记录 Taffy Studio 的所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.0.1] - 2026-06-05

首个公开版本。

### 新增

- **基于 Tauri 2 的跨平台外壳** —— Windows、macOS、Linux、iOS、Android，外加
  浏览器单文件自托管服务与 Docker 镜像。前端一套 UI，全端复用。
- **多服务商 · 原生协议** —— OpenAI 兼容（OpenAI / DeepSeek / SiliconFlow /
  Ollama / 任意 base URL）、Anthropic `/v1/messages`、Gemini
  `streamGenerateContent`，并按服务商自动拉取模型列表。
- **流式输出** —— 逐 token 推送，内置停止 / 重新生成，会话标题自动摘要。
- **MCP 客户端** —— 本地 stdio + 远程 Streamable HTTP 服务器、agentic 工具调用
  循环（OpenAI & Anthropic），并带一个可一键导入的 **MCP 市场**。
- **技能（Skills）** —— `SKILL.md` 形式的可复用能力包，支持导入与按会话启用，
  通过 `use_skill` 工具暴露给模型。
- **知识库 / RAG** —— 本地向量库，按会话注入检索上下文。
- **附件与 OCR** —— 图片（视觉模型）、PDF / 文本文档；非视觉模型用
  Tesseract.js 兜底识图。
- **富文本渲染** —— GitHub 风味 Markdown、代码高亮、KaTeX 公式、懒加载的
  Mermaid 图表。
- **密钥安全** —— 桌面端 API 密钥存系统密钥环；服务器版从环境变量注入，
  浏览器永不接触密钥。
- **玻璃拟态 UI** —— 跟随系统 / 浅色 / 深色主题、响应式布局，
  英文 + 简体中文国际化。
- **共享 Rust 核心** —— LLM 分发、SQLite 持久化（rusqlite）、MCP、技能、嵌入
  集中在 `taffy-core`，桌面与 Web 外壳共用。
- **构建与发版工具链** —— 交互式 `build` / `dev` / `clean` 脚本、基于 Docker 的
  Linux/Android 构建、CI（类型检查 + clippy），以及打 tag 触发的发版流程
  （产出安装包、Web 二进制、APK 和 GHCR 镜像）。

[未发布]: https://github.com/zuoliangyu/Taffy-Studio/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/zuoliangyu/Taffy-Studio/releases/tag/v0.0.1
