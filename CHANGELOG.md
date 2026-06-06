# 更新日志

本文件记录 Taffy Studio 的所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.0.2] - 2026-06-06

聚焦移动端体验、多模型对比与界面统一。

### 新增

- **多模型并行对比（Cherry 风）** —— 在聊天头部「对比」多选,或用 `@模型` 把模型
  加入本轮;一条消息同时发给多个模型,回答**并排分栏**展示(固定半宽、两列可见、
  更多模型横向滚动),每列可单独**复制 / 重试 / 删除**,组底有「全部重试」。
- **每条回复的 token 用量与耗时** —— 显示「模型 · 1.2s · 26+28 tok」;可在
  设置→外观开关,关闭后单条回复保持简洁标签、详情移到悬停。
- **逐条消息操作栏** —— 复制、重新生成、就地编辑(删除该轮及其后内容并载回输入框)、
  删除单条。
- **关于页（设置→关于）** —— 作者、哔哩哔哩 / GitHub 链接、本仓库链接,以及检查更新按钮。

### 优化

- **统一的线条图标系统** —— 用一套内联 SVG(Lucide 风)替换全部 emoji 图标。
- **移动端 Material You 化** —— 设置改为全屏 sheet + 顶部胶囊 tab、单行横向滚动的
  头部 chip、42–46px 触摸目标、圆形发送钮、窄屏(320px)适配、空状态品牌化。
- **更小的安卓包** —— 启用按体积优化的 release 配置,APK 体积约缩小一个数量级。
- **全量界面中文本地化** —— 右键菜单、搜索面板、会话覆盖弹层、模板编辑器、温度/
  模型选择器等此前硬编码英文的文案全部接入 i18n。

### 修复

- **安卓 launcher 图标** —— 构建时覆盖默认 Tauri 图标,显示正确的 Taffy 形象;
  CI/Docker 安卓产物改为 release 构建并签名。

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

[未发布]: https://github.com/zuoliangyu/Taffy-Studio/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/zuoliangyu/Taffy-Studio/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/zuoliangyu/Taffy-Studio/releases/tag/v0.0.1
