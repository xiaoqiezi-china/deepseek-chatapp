# DeepSeek Chat App

基于 DeepSeek 官方 chat-demo 二次开发的聊天客户端。提供网页、Windows 桌面和 Android 三种形态，界面参考 DeepSeek 官网。

本项目不是 DeepSeek 官方产品。聊天、附件上传和语音功能使用你自己的 API Key 直接请求 DeepSeek 官方 API。

## 功能

- 多会话管理：新建、自动标题、重命名、删除、按时间分组。
- 对话编辑：修改提问或回答，修改后作为后续对话的上下文；支持消息分支切换、重新生成和继续生成。
- 回答能力：流式输出、深度思考、智能搜索、链接阅读与来源引用、回复朗读。
- 附件：上传、粘贴、拖拽图片和文件；语音输入带实时频谱。
- 渲染：Markdown、代码高亮、KaTeX 公式、Mermaid 图表。
- 账号管理：输入 API Key 登录，展示账户余额与可用模型；支持更换密钥。
- 系统提示词：可选默认身份提示词或自定义内容；自定义留空时不发送 system 字段。
- 设置：简体中文 / English、浅色 / 深色 / 跟随系统、朗读音色、位置、模型（默认 `deepseek-flash`）。
- 历史记录：ZIP 导入导出、删除全部对话。

## 运行

需要 Node.js 22.12+ 和 pnpm。

```sh
pnpm install
pnpm dev
```

`pnpm dev` 同时启动 Web（8090）和本地存储服务（8091），打开 http://localhost:8090 。

停止服务：运行 `stop.bat`（Windows），或在终端按 Ctrl+C。

## 构建

```sh
pnpm build          # 静态站点输出到 dist/
pnpm start          # 单源模式：8091 同时提供页面与存储 API
pnpm type           # TypeScript 类型检查
pnpm lint           # 代码检查
```

桌面端与 APK 的构建说明见 [docs/build.md](docs/build.md)。

## 数据存储

网页版由本地存储服务把数据写入项目根目录的 `data/`：

- `settings.json`：API Key、界面设置、系统提示词、模型
- `summaries.json`：会话摘要索引
- `sessions/<id>.json`：会话全文
- `files/<id>`：附件原件

桌面端和 Android 版不使用存储服务，直接把相同结构的数据写入各自的应用数据目录。

历史导入导出使用 ZIP 格式。导出包含会话和本地图片原件，不含 API Key、设置或非图片附件原件。导入会替换全部会话和附件。

API Key 以明文保存在本地文件中。请不要在共享设备上使用，也不要把 `data/` 提交到仓库。

## 项目结构

```text
src/                 前端界面与业务逻辑
  services/
    api/             DeepSeek API 请求、SSE 与协议类型
    chat/            会话、消息分支、存储适配与历史导入导出
    storage/         存储后端接口
server/              本地存储服务（网页版）
src-tauri/           Tauri 2 桌面端
android/             Capacitor Android 工程
res/                 图标素材
```

## 协议

[MIT](LICENSE)。原项目版权归 DeepSeek；本项目在 MIT 协议下继续分发。第三方依赖遵循各自许可证。
