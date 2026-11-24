# Deepseek CE 架构与维护说明

面向接手者的工程地图。事实以当前代码（v1.1.7）为准；`IMPLEMENTATION.md` 是第一步改造时的历史说明，
其中「Electron / Capacitor 为后续阶段」等描述已过期，不要再作为依据。

## 1. 定位

基于 DeepSeek 官方 chat-demo 改造的社区版客户端，同一份前端产物跑三个运行形态：

| 形态 | 外壳 | 渲染 | 存储实现 |
| --- | --- | --- | --- |
| Web（开发 / 自托管） | Node 进程 `server/` | 浏览器 | HTTP `/api/*` → `server/store.ts` |
| Windows 桌面 | Tauri 2 | 系统 WebView2 | IPC `storage_request` → `src-tauri/src/main.rs` |
| Android | Capacitor | 系统 WebView | `@capacitor/filesystem` → `src/capacitor-bootstrap.ts` |

共同点：不打包浏览器内核、不引入框架级状态库以外的运行时、数据全部落在本机。

## 2. 目录职责

```text
src/
  main.tsx                 入口：注入平台存储 → 读设置 → 主题 → 渲染 → 显示窗口
  capacitor-bootstrap.ts   Android 存储适配（顶层 await，仅原生容器内加载 Filesystem）
  tauri-bootstrap.ts       桌面端存储适配 + 首帧后显示窗口
  app/                     App 外壳、主题（theme.ts）、视口与移动端判定（viewport.ts）
  components/              展示层；状态放同名 *State.ts / store，不放组件内全局
  services/
    chat/                  会话域：store（状态机）、branches（分支）、reply（流合并）、
                           view（界面派生）、drafts（草稿）、backup（导入导出入口）、
                           history/（ZIP 归档 v3）、db.ts（存储调用）、latestReminder
    api/                   DeepSeek 协议：client（请求）、sse、parseEvent（校验）、
                           types（Anthropic 兼容类型）、errors、speech（ASR/TTS）、
                           thirdParty（Chat Completions 兼容层）、webSearch
    storage/               存储抽象：bridge.ts（唯一 IO 入口）
    attachments.ts         上传队列、扩展名与体积校验、错误文案
    settings.ts            本机设置（zustand + 立即落盘）
    updater.ts             桌面 / Android 应用内更新
    codeRunner.ts          代码块运行（桌面 IPC / Web HTTP）
  i18n/                    zh.ts 是类型源，TranslationKey = keyof typeof zh
server/                    仅 Web 形态：静态托管 + /api + 代码运行 + 第三方代理
src-tauri/                 桌面端 Rust：存储、WebView2 检测、系统代理、更新安装
android/                   Capacitor 工程 + AppUpdater 原生插件（APK 下载安装）
scripts/publish-release.mjs 上传安装包与签名到 GitHub Release
```

## 3. 启动链路

1. `src/main.tsx` 先 import `capacitor-bootstrap`（Android 才注入 fetch 适配）与 `tauri-bootstrap`。
2. `initSettings()` 读 `/settings`，失败用默认值（不阻塞启动）。
3. `setupTheme()` 同步 body class 与 `theme-color`，随后 `createRoot` 渲染 `App`。
4. 桌面端等两帧后调 `window.__DSH_REVEAL__()` 显示窗口；未调用也会在 2 s 后兜底显示。
5. `App` 挂载后 `initChat()` 拉会话列表；选中会话才按需读正文。

## 4. 存储契约

前端所有持久化都走 `storage/bridge.ts::storageFetch(path, init)`：
原生层注入 `window.__DSH_STORAGE_FETCH__` 时用它，否则请求 `/api + path`。
新增端点必须同时改三个后端，语义以 `src/services/chat/db.ts` 的调用为准。

| 端点 | 用途 | Node | Rust | Capacitor |
| --- | --- | --- | --- | --- |
| GET/PUT `/settings` | 设置读写 | ✅ | ✅ | ✅ |
| GET `/sessions` | 会话摘要列表 | ✅ | ✅ | ✅ |
| GET/PUT/DELETE `/sessions/:id` | 会话正文 | ✅ | ✅ | ✅ |
| PATCH `/sessions/:id/title` | 重命名 | ✅ | ✅ | ✅ |
| POST `/session-with-files` | 会话 + 新增附件原件（base64） | ✅ | ✅ | ✅ |
| GET `/files/:id` | 读原件 | ✅ 二进制 | ✅ base64 JSON | ✅ base64 → 二进制 |
| PUT `/files/:id` | 写原件 | ✅ 二进制 | ✅ base64 → 二进制 | ✅ 存 base64 文本 |
| POST `/staging/clear` | 清空导入暂存 | ✅ 删除重建 | ✅ 删除重建 | ✅ 删除重建 |
| PUT `/staging/sessions/:id` | 暂存会话 | ✅ | ✅ | ✅ |
| PUT `/staging/files/:id` | 暂存附件 | ✅ 二进制 | ✅ base64 → 二进制 + meta | ✅ 存 base64 文本 |
| POST `/staging/file-types` | 回填导入图片 MIME | ✅ 改会话 JSON | ✅ 改会话 JSON | ✅ 改会话 JSON |
| POST `/staging/commit` | 原子替换正式数据 | ✅ 目录换位 | ✅ 目录换位 | ✅ 按归档删除多余会话/原件后搬运 |
| POST `/open-data-dir` | 打开数据目录 | ✅ | ✅ | 501 |
| POST `/history/clear` | 直接清空 | ✅ | ✅ | ✅（未被前端调用） |
| GET `/runtime`、POST `/run-code` | 代码运行 | ✅ | Rust 直连命令 | 不支持 |
| POST `/third-party-proxy` | 第三方模型同源代理 | ✅ | 用 plugin-http 直连 | 直连 fetch |

## 5. 磁盘布局

```text
data/                     Web 为项目根 data/；桌面为应用数据目录；Android 为私有目录 chat-data/
  settings.json           API Key、语言、主题、位置、音色、开关、系统提示词、模型来源（明文）
  summaries.json          列表索引：id/title/createdAt/updatedAt/pinned/fileIds
  sessions/<id>.json      会话全文（含全部分支）
  files/<id>              附件原件（Capacitor 下为 base64 文本）
  files/<id>.meta.json    contentType
  staging/{sessions,files}/  导入暂存；commit 时以归档为准整体替换正式数据
```

索引是缓存不是事实来源：三端都实现了「索引与会话文件 ID 集合不一致就重建」的自愈逻辑。
因此**只改索引、不删会话文件**的删除操作会在下一次列表请求时复活：这也是三端的
`/staging/commit` 与 `/history/clear` 必须以文件系统为准做删除的原因。

原子写三端各有实现：Node 用临时文件 + rename；Rust 用 `.{name}.tmp-{pid}-{seq}` + `sync_all` + rename；
Capacitor 用带随机后缀的临时文件 + rename，并在启动时把残留临时文件补回（Android rename 会先删目标）。

## 6. 会话与消息模型

`Session { id, title, createdAt, updatedAt, pinned?, messages, rootMessageId? }`
`Message = UserMessage | AssistantMessage`，公共分支字段 `parentId` / `selectedChildId`。

- `rootMessageId === undefined` 表示旧线性数据，`normalizeSession` 首次访问时补成单链分支。
- 当前上下文 = 从 `rootMessageId` 沿 `selectedChildId` 走出的路径（`getVisibleMessages`）。
- 新提问/重新生成/编辑都用 `appendBranch` 在指定父节点下挂新分支；`selectVersion` 切兄弟版本。
- `AssistantMessage.blocks` 是协议块的原样序列（thinking / text / server_tool_use / 搜索结果），
  回传上下文时由 `reply.ts::toAssistantParam` 过滤：历史思考不带回、read_link 必须带 signature。

## 7. 回复流水线

`sendMessage | editMessage | regenerateReply | continueReply | retryUpload`
→ `streamReply(sessionId, reply, { history, question, prefix? })`

1. **准备附件**：旧图长边检查（`imageSizeChecked`）→ 本轮提问并行补 serverId（任一失败即整轮 upload 错误）
→ 历史轮次串行尽力补传（失败静默跳过）。每步后用会话里的最新消息刷新请求快照。
2. **请求**：DeepSeek 走 `/anthropic/v1/messages`（SSE）；第三方模型走 `streamThirdPartyReply`，
   本地保存为同一套 `blocks` 结构。
3. **合并**：`applyEvent` 按本次请求的临时索引表累积；`requestAnimationFrame` 合帧刷新，
   页面隐藏时立即 flush；页面关闭或导入期间由 `settleReply` 收尾成 stopped。
4. **收尾**：`done | stopped | error`；`stop_reason: refusal` 时丢弃已下发的思考与正文，只保留工具块。
5. **重试**：服务端判 file_id 失效且尚未收到内容块时，清 serverId → 退避重传 → 重发，最多 2 次。
6. **标题**：会话无标题时带 `title: { enabled: true }`，`message_delta.title` 回写；手动改名后放弃该轮。
7. **本轮信息**：`latestReminder`（日期、星期、地区、平台、语言）作为独立 role 进请求，并快照进回复。

## 8. 前端状态与写入策略

- 唯一会话状态源是 `services/chat/store.ts`（zustand + 模块级闭包变量）。
- `persist()` 单飞：同一会话同时只有一个保存在飞，期间的新变化记 `saveAgain` 合并补写。
- 保存失败保留 `pendingFiles`，成功后释放；失败标记进 `sessionSaveErrors`，由顶部横幅提示重试。
- `historyEpoch` 让导入/清空期间的迟到写入与读取结果失效，避免旧数据写回。
- 详情缓存最多 5 个会话、正文总量 6 M 字符；淘汰与删除时调用 `releaseSessionContent` 主动清空消息数组，
  断开 DOM/fiber 对长文本的引用。
- 页面隐藏、`pagehide`、Android `appStateChange` 时先 flush 再落盘。

## 9. 外部 API

- 对话：`${API_ORIGIN}/anthropic/v1/messages`，扩展模式声明 `deepseek_read_url`（常开）与
  `deepseek_web_search`（智能搜索开关）；模型固定 `deepseek-flash`。
- 文件：`/anthropic/v1/files`，图片不传 purpose 且上传前缩放到长边上限；
  PDF/Word/PPT 用 `rich_layout_recognition`，其余用 `user_data`（两者体积上限不同）。
- 账号：`GET /models`（校验 Key）、`GET /user/balance`。
- 语音：`POST /v1/tools/asr`（WAV/Ogg，≤120 s、≤8 MiB）、`POST /v1/tools/tts`（裸 PCM 24 kHz）。
- 第三方：Chat Completions 兼容层，DeepSeek 的 Key 仍然负责联网搜索与 TTS。

## 10. 历史归档

ZIP 顺序：`manifest.json` → `user.json`（不导入）→ `chat_sessions/<id>.json` → `chat_session_index.json`
→ 图片（`chat_sessions/<id>_files/...`）。版本常量 `EXPORT_FORMAT_VERSION = 3`，读写都在
`services/chat/history/`，自带 zip 读（流式）与写（fflate）。
导出含会话与图片原件，不含 API Key 与设置；导入先写暂存，成功后 `commitStaging` 整目录换位。

## 11. 平台能力差异

| 能力 | Web | 桌面 | Android |
| --- | --- | --- | --- |
| 运行代码 | Node 子进程 | Rust 命令 | 不支持 |
| 第三方模型 | 本机代理，失败回退直连 | plugin-http + 系统代理 | 直连 |
| 应用内更新 | 无 | GitHub Release + 签名校验 | 下载 APK → 系统安装器 |
| 打开数据目录 | explorer/open/xdg-open | explorer | 501 |

## 12. 构建、校验与发布

```sh
pnpm type      # tsc 全量类型检查（含 server/）
pnpm lint      # oxlint，server/ 单独放宽 curly / no-explicit-any
pnpm build     # rspack → dist/
pnpm dev       # web :8090 + server :8091
pnpm start     # 生产：单源 :8091 托管 dist 与 /api
pnpm release:desktop v1.1.x "说明"   # 需先 tauri build 且带签名
```

版本号必须四处同步：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、
`android/app/build.gradle`（同时递增 `versionCode`）。网页与 APK 的版本标签由 rspack 注入
（`__APP_VERSION__`、`meta[name=application-version]`）。

仓库没有 JS 测试框架；仅 `src-tauri/src/main.rs` 有 `#[cfg(test)]` 单元测试（摘要自愈、并发写、更新清单），
Android 侧只有模板生成的示例测试。

## 13. 接手基线（2026-11-24 实测）

- `pnpm type` 通过；`pnpm lint` 0 warning / 0 error（147 文件）；`pnpm build` 成功，dist 162 文件约 4.5 MB。
- 工作区有 26 项未跟踪产物（各版本安装包、`latest.json`、`session.md`、`release-notes-*.md`），
  未纳入版本管理，提交前需确认是否要加入 `.gitignore`。

## 14. 已修复问题与剩余边界

### 已修复（待随下个版本发布，均未改数据格式）

- **F1 Android 清空/导入失效**：`/staging/clear` 改为删除并重建暂存目录；`/staging/commit` 改为
  「按归档删除多余会话与原件 → 写入归档会话 → 原件改名搬运」；`/history/clear` 同时删除会话文件。
  现在导入是替换而非合并，清空全部历史不会被索引自愈还原，导入的图片原件也会落到 `files/`。
- **F2 桌面端导入图片损坏**：Rust 的 `PUT /files/:id` 与 `PUT /staging/files/:id` 先 `base64_decode`
  再落盘（前端经 IPC 传的是 base64），暂存原件同时写 `.meta.json`，commit 换位时一并搬运。
- **F3 三端不一致**：Rust 与 Capacitor 补上 `POST /staging/file-types`，把原件推断出的图片 MIME 回填进暂存会话。
- **F5 死代码**：删除 `services/storage/backend.ts` 与 `db.saveFiles`（无实现、无调用方）。
- **F6 本机服务暴露面**：`server/` 默认只监听 `127.0.0.1`（`HOST=0.0.0.0` 可显式放开，启动时告警）；
  CORS 只对回环来源回写 `Access-Control-Allow-Origin`。
- **F7 文档漂移**：`IMPLEMENTATION.md` 已标注为历史记录；`README.md` 补齐第三方模型、代码运行等能力。

### 仍待处理

- **纯静态部署不再维护**：`.github/workflows/pages.yml` 已删除。前端没有浏览器侧存储实现，
  Pages 上 `/api/*` 全部失败，而产品只发布 Windows 安装包与 Android APK；`dist/` 仅作为构建
  产物与 Tauri / Capacitor 的输入。若将来要做在线版，需要单独设计一套 IndexedDB 后端。
- **无自动化回归**：仓库没有 JS 测试框架，`src-tauri` 只有少量单元测试。F1/F2 的正确性依赖真机验证：
  Android 上「导入含图片的历史 → 清空全部历史 → 重启」与 Windows 上「导入含图片的历史 → 打开图片」。
- **`settings.json` 明文保存 API Key**：本机单机设计下的取舍，未改动。
- **`tsconfig.json` 的 `include` 不含 `server/`**：`server/` 只被 oxlint 检查，类类型错误不会被 `pnpm type` 拦住
  （`IMPLEMENTATION.md` 里「含 server/」的说法不准确）。

## 15. 维护约定

- 中文注释解释「为什么」，不复述代码；UI 文案一律走 i18n（zh 为准，en 同步）。
- 组件样式用 CSS Modules（`*.module.css`），尺寸/动效用 `src/app/theme.css` 里的 `--ds-*` 变量。
- 新增持久化字段先改 `services/chat/types.ts`，再补归档 schema（`history/schema.ts`）与三端存储。
- 只改前端时不需要碰 Rust / Android；但新增存储端点必须三端同时实现并对照本文件第 4 节。