# 可复用符号清单

格式：`语义名/别名 | 文件::符号 | 状态 | 一句话限制`

状态：`可用` = 已核对语义与依赖，可直接复用；`慎用` = 可复用但副作用明显。

## 存储与持久化

- 存储请求适配 / storageFetch | src/services/storage/bridge.ts::storageFetch | 可用 | 原生注入优先，否则自动拼 `/api` 前缀，调用方传入的 path 不带前缀
- 索引串行读改写 / summaries lock | server/store.ts::withSummariesLock | 可用 | 仅同进程内串行，多进程并发无效
- 摘要自愈重建 | server/store.ts::rebuildSummaries | 可用 | 会重写 summaries.json，损坏的会话文件被跳过
- 原子写文件 / atomicWrite | server/store.ts::atomicWrite | 可用 | 仅 Node 端；临时文件名带随机后缀，失败会尝试清理

## 会话与分支

- 可见消息路径 / visible path | src/services/chat/branches.ts::getVisibleMessages | 可用 | 依赖 selectedChildId 链；rootMessageId 为 undefined 时原样返回全部消息
- 追加分支 / appendBranch | src/services/chat/branches.ts::appendBranch | 可用 | 内部先 normalizeSession，会改写父节点的 selectedChildId
- 切换兄弟版本 / selectVersion | src/services/chat/branches.ts::selectVersion | 可用 | 只接受当前路径上某节点的兄弟，否则原样返回
- 版本分组缓存 | src/services/chat/branches.ts::buildMessageVersions | 可用 | 仅在版本列表未变化时复用旧对象，用于避免历史消息重绘

## 回复流水线

- 流事件合并 / applyEvent | src/services/chat/reply.ts::applyEvent | 可用 | blockIndexes 必须每次请求新建；客户端工具块不落库
- 回复收尾 / settleReply | src/services/chat/reply.ts::settleReply | 可用 | stop_reason 为 refusal 时会丢弃正文与思考块
- 上下文轮次筛选 | src/services/chat/reply.ts::getContextRounds | 可用 | 只保留「提问 + 可用回答」成对轮次，孤立消息不进上下文
- 请求消息构造 / toRequestMessages | src/services/chat/reply.ts::toRequestMessages | 可用 | latestReminder 按内容去重插入；续写需非空白正文
- 可续写判定 | src/services/chat/reply.ts::canContinueReply | 可用 | 报错、拒绝、含服务端工具或模板块的回复一律 false
- 回复纯文本 | src/services/chat/reply.ts::getReplyText | 可用 | 只拼 text 块，忽略思考与工具块

## 界面派生

- 回复界面结构 / buildReplyView | src/services/chat/view.ts::buildReplyView | 可用 | 纯计算且不修改 blocks；来源编号按搜索结果与打开的网页出现顺序
- 会话时间分组 | src/services/chat/sessionGroups.ts::groupSessions | 可用 | 依赖 translate 与浏览器本地时区，置顶单独成组

## 附件

- 上传队列 / uploadAttachment | src/services/attachments.ts::uploadAttachment | 可用 | 同一附件 id 复用同一 Promise；任务只在内存，刷新后丢失
- 旧图长边检查 | src/services/attachments.ts::checkImageFileIds | 可用 | 需要本地原件；读取失败时保留原 serverId 不重传

## 历史归档

- ZIP 流式读 / readArchive | src/services/chat/history/zipReader.ts::readArchive | 可用 | 先 isZipFile；只支持归档用到的压缩方法
- ZIP 写 / writeArchive | src/services/chat/history/zipWriter.ts::writeArchive | 可用 | 一次性在内存组装，超限抛 ArchiveLimitError
- 归档转本地会话 | src/services/chat/history/toLocal.ts::toLocalSession | 可用 | 仅接受 v3 格式，图片以路径映射返回

## 更新与工具

- 版本比较 / compareVersion | src/services/updater.ts::compareVersion | 可用 | 非数字段被忽略，只比较数字位
- 镜像竞速 / firstSuccessful | src/services/updater.ts::firstSuccessful | 可用 | 首个成功者生效，其余请求不会被取消
- 唯一 ID | src/utils/id.ts::createId | 可用 | 优先 crypto.randomUUID，降级为时间戳 + 随机串
- 文件体积格式化 | src/services/attachments.ts::formatSize | 可用 | 以 1024 进位，10 以上取整
