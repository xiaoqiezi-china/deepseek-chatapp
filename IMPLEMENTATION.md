# 第一步改造实施说明

> **历史记录**：本文是第一步（Web + 本地存储服务）改造时的说明，后续迭代（Tauri 桌面端、Capacitor Android、
> 第三方模型、代码运行、自动更新、历史归档等）未在此更新。当前架构、存储契约与已知边界见
> [docs/architecture.md](docs/architecture.md)。

## 运行

需要 Node 22.12+ 与 pnpm。

```sh
pnpm install
pnpm dev        # 同时启动前端 8090 与存储后端 8091（Ctrl+C 一起停）
```

浏览器打开 http://localhost:8090 。首次使用会看到鲸鱼首屏，点击「登录」输入 DeepSeek API Key。

生产模式（后端托管静态产物，单源 8091）：

```sh
pnpm build
pnpm start
```

打开 http://localhost:8091 。开发代理配置在 `rspack.config.ts`。

## 持久化

所有数据由后端写入项目根目录 `data/`：

- `settings.json`：API Key、语言、主题、位置、音色、开关、**系统提示词模式与内容**（明文，仅本机可访问）
- `summaries.json`：会话摘要索引（含附件 ID 列表，与会话文件不一致时自动重建）
- `sessions/<id>.json`：会话全文（含所有消息分支）
- `files/<id>` + `files/<id>.meta.json`：附件原件与 MIME
- `staging/`：历史导入暂存；commit 时目录级原子换位

浏览器不再使用 localStorage / IndexedDB。存储访问全部经 `/api/*`（见 `server/index.ts`），前端调用在 `src/services/chat/db.ts`，统一出口是 `src/services/storage/bridge.ts`：存在 `window.__DSH_STORAGE_FETCH__` 时走原生注入（桌面 IPC / Android Filesystem），否则请求 `/api`。

## 新增功能

- **账号管理**：设置弹窗第三分组；无 Key 时鲸鱼首屏整屏替换欢迎页；登录/改 Key 时校验并展示余额（GET /user/balance）与可用模型（GET /models）。官方无公开消费明细 API。
- **系统提示词**：通用设置里「默认 / 自定义」两态；自定义留空则请求中省略 system 字段；修改后下一条消息立即生效。
- **上下文编辑**：AI 消息操作行「修改回答」按钮；移动端长按消息正文 500ms 进入编辑。保存后创建同父分支新版本并成为当前上下文，旧版本可用版本切换找回。
- **官网标识**：侧边栏标题换成官方 wordmark（res/title.svg），favicon 用鲸鱼图标（res/whale.svg）。三个 SVG 已转成内联组件放在 `src/components/base/icons.tsx`，res/ 保留原始素材。
- **动画**：弹窗淡入淡出+上浮缩放（关闭延迟卸载）、菜单/Tooltip/来源卡淡入、侧栏/会话列表/消息/欢迎页入场、设置分组切换淡入；统一使用 `--ds-*` 动效变量并支持 `prefers-reduced-motion`。

## 校验

```sh
pnpm type    # TypeScript 类型检查（tsconfig 只包含 src/，server/ 由 lint 覆盖）
pnpm lint    # oxlint（server/ 单独放宽 curly 与 no-explicit-any）
pnpm build   # rspack 生产构建（跨平台，不用 rm -rf）
```

存储 API 已通过冒烟测试：设置读写、会话增删改/重命名、附件写读与引用计数清理、导入暂存五步骤、历史清空，全部返回预期状态。

## 已知边界

- `data/settings.json` 明文保存 API Key，存储服务无鉴权；现默认只监听 127.0.0.1:8091，需要对外监听时用 `HOST` 显式放开，且不要暴露到公网。
- 桌面端与 Android 端已在后续阶段完成（Tauri 2 / Capacitor），不使用 `server/`，直接读写应用数据目录中的同一份结构。
- 旧浏览器里的 localStorage/IndexedDB 历史数据不做自动迁移；可用原应用的 ZIP 导出/导入过渡。
