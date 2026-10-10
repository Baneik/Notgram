# 论坛话题群组支持方案

文档基线：2026-10-11

## 1. 结论与范围

本次接入论坛型超级群组（`chatTypeSupergroup.supergroup_id -> supergroup.is_forum = true`），把会话身份从单一 `chatId` 扩展为 `chatId + topicId`。已实现的闭环包括：

- 话题列表、分页游标、未读数、置顶、关闭和最后一条消息预览。
- 打开话题、话题历史分页、文本/附件/贴纸/GIF/Inline 结果发送。
- 话题级回复、草稿、输入状态、会话内搜索、转发目标话题选择。
- 创建、重命名、关闭/重新开启、置顶/取消置顶和删除话题。
- 固定“所有”类别、整群历史、按账号/群组持久化的本地拖拽排序。
- TDLib 更新路由、Mock 数据和桌面/移动端自动化验证。

频道评论线程不在本次范围内。频道评论需要另外建模 `message.interaction`、评论入口和评论消息来源，不能把它误当成论坛话题复用。

## 2. TDLib 能力分析

依据 TDLib 官方 schema `td_api.tl`（[官方定义](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl)）确认以下能力：

| 能力 | TDLib 类型/函数 | Notgram 用法 |
| --- | --- | --- |
| 判断论坛群组 | `chatTypeSupergroup.supergroup_id`、`supergroup.is_forum`、`updateSupergroup` | 关联聊天和超级群组元数据，显示话题入口并切换主体视图 |
| 创建权限 | `chat.permissions.can_create_topics` | 控制“创建话题”按钮和服务端失败提示 |
| 消息归属 | `message.topic_id:MessageTopic`、`messageTopicForum.forum_topic_id` | 映射到 `Message.topicId`，所有发送请求携带 `topic_id` |
| 话题元数据 | `forumTopicInfo`、`forumTopic` | 名称、图标颜色、关闭/隐藏、置顶、未读、通知和草稿 |
| 话题列表 | `getForumTopics` -> `forumTopics` | 使用 `offset_date + offset_message_id + offset_forum_topic_id` 游标 |
| 话题历史 | `getForumTopicHistory` | 使用 `from_message_id` 按话题独立分页 |
| 话题管理 | `createForumTopic`、`editForumTopic`、`toggleForumTopicIsClosed`、`toggleForumTopicIsPinned`、`deleteForumTopic` | 对应管理弹窗的创建和行内管理菜单，删除需确认 |
| 话题详情 | `getForumTopic` | 创建后获取完整 `forumTopic`，补齐最后消息/草稿 |
| 发送上下文 | `sendMessage`、`sendMessageAlbum`、`setChatDraftMessage`、`sendChatAction`、`forwardMessages` 等的 `topic_id` | 通过 `forumTopicObject` 统一构造 `messageTopicForum` |
| 实时更新 | `updateForumTopicInfo`、`updateForumTopic`、带 `topic_id` 的消息更新 | 重新读取话题列表，消息仍进入按 chat 的消息 Map 并由 UI 过滤 |

论坛“常规”话题使用服务端返回的 `is_general` 和真实 topic id。“所有”使用未选定话题的整群历史作用域；记忆选择使用虚拟标识 `__all__`，该标识不能进入 TDLib 请求。“所有”视图提示选择话题后发送，避免未指定发送目标。

## 3. 实现方案

### 3.1 类型与映射

- `Chat.isForum`、`Chat.canCreateTopics` 描述群组能力。
- `TauriTelegramTransport` 缓存 `updateSupergroup.supergroup`，按 `chatTypeSupergroup.supergroup_id` 关联到聊天；TDLib 保证该更新先于超级群组标识返回。
- `Message.topicId`、`ChatDraft.topicId`、发件箱项 `topicId` 保持上下文。
- 新增 `ForumTopic`、`ForumTopicPage`、`GetForumTopicsInput`、`CreateForumTopicInput`。
- `mapTdMessage`、`mapTdChat`、`mapTdChatDraft`、`mapTdForumTopic` 只做 TDLib 到领域模型的转换，禁止 UI 读取原始 TDLib 对象。

### 3.2 传输与安全边界

- `TelegramTransport` 暴露话题查询、历史、创建、编辑、关闭、置顶、删除和话题已读操作。
- `TauriTelegramTransport` 负责 TDLib 请求构造、游标和实时事件；Rust security allowlist 只放行本次所需函数。
- 原生文件/粘贴上传通过受控的 topic-aware builder 传入 `topic_id`，本地文件路径仍不进入通用 JSON bridge。
- `MockTelegramTransport` 提供三个固定话题和话题级消息，确保浏览器回归不依赖真实账号。

### 3.3 Store 状态与一致性

```text
forumTopics: Map<chatId, ForumTopic[]>
topicHistories: Map<chatId:topic:topicId, HistoryState>
drafts: Map<chatId | chatId:topic:topicId, ChatDraft>
lastForumTopicIds: Map<chatId, topicId>
activeChatId + activeTopicId
messages: Map<chatId, Message[]>  // UI 按 topicId 过滤
```

关键不变量：

1. 切换话题前刷新旧话题草稿；发送、失败重试和附件队列永远使用队列项中的 `topicId`。
2. 话题打开后只读取对应历史游标，不能复用普通会话的 history state。
3. 论坛列表页不调用整群 `markChatRead`；进入话题后只用该话题最后一条入站消息执行 `viewMessages(force_read=true)`。
4. `forumTopic.draft_message` 和实时 `chat.draftChanged` 都按话题 key 写入，服务端空草稿会删除对应 key。
5. 旧消息缓存仍按 chat 存储，恢复后依靠 `Message.topicId` 过滤，避免破坏现有缓存迁移。
6. 每个论坛群组最后打开的话题和已加载的话题元数据写入加密快照；重新进入时先恢复缓存会话，再在后台刷新服务端列表和历史。
7. 搜索结果和通知先解析目标消息的 `topicId`，再一次性提交 `activeChatId + activeTopicId`，禁止先加载记忆话题再切换到目标话题。
8. 普通重新进入在 10 秒内复用新鲜话题列表；实时话题更新在 500 毫秒窗口内合并，避免连续更新触发重复请求。
9. 话题已读从有序消息尾部反向查找；服务端最后已读 ID 和三个未读计数均已收敛时，不重复发送已读请求。
10. 快照最多保留 20 个最近论坛、每论坛 100 个话题、100 条最后选择，并为话题元数据设置 256 KiB 总预算；`lastMessage` 和 `draft` 不重复写入话题元数据。
11. 所有话题列表草稿经过 `DraftSyncController`，读取开始时捕获本地修订号；发送/编辑后的迟到列表不能恢复旧文本。空草稿同步也从原草稿 key 取得 topicId；输入框卸载保存和停止输入状态携带原作用域，不读取切换后的 activeTopicId。
12. 删除禁止常规话题；管理员需要 `canDeleteMessages`，创建者的消息数量/来源限制由服务端最终判定。失败保留话题和消息，成功移除本地消息/草稿并为活动话题回退到“所有”。

### 3.4 请求示例

```json
{
  "@type": "sendMessage",
  "chat_id": 123,
  "topic_id": { "@type": "messageTopicForum", "forum_topic_id": 12 },
  "reply_to": null,
  "input_message_content": { "@type": "inputMessageText", "text": "..." }
}
```

`getForumTopics` 使用 TDLib 返回的三元游标；`getForumTopicHistory` 使用 `from_message_id`，不把 topic id 拼进 message id。服务端 `order` 保留原值，顶栏显示顺序单独保存到既有加密账号元数据；初次观察采用当前列表顺序，后续新话题追加，消息活跃度和置顶更新不移动已有位置。

## 4. UI 方案

### 4.1 话题列表页

- 首次进入且尚无缓存时自动打开服务端排序最前的话题；再次进入直接恢复该群组上次离开的话题，不要求重复经过列表页。
- 话题列表通过顶栏“管理话题”按钮以弹窗提供创建和管理能力；未知话题详情仍使用列表作为后备界面，未选定话题展示“所有”。
- 顶部沿用现有会话头部：群组头像、名称、移动端返回；有权限时右侧显示创建按钮。
- 每行展示颜色图标、名称、最后消息摘要、置顶/关闭图标和未读徽标；整行进入话题，更多菜单按权限提供重命名、置顶、关闭和删除。
- 创建使用行内表单，成功后自动进入新话题；名称限制 1-128 个字符，错误沿用全局操作提示。

### 4.2 话题会话页

- 复用现有 `Conversation`、虚拟消息列表、Composer、消息操作和媒体预览，减少两套会话行为分叉。
- 会话头部下方提供横向话题切换栏；“所有”固定在左侧、管理入口固定在右侧，中间话题可滚轮滚动和手动拖拽。切换不自动居中，也不因未读徽标出现/消失改变按钮宽度。Ctrl+Shift+左右方向键提供键盘排序。
- 同一群组切换保留 Conversation、头部和话题栏 DOM；消息虚拟列表和输入框继续按话题隔离。过渡快照只覆盖消息区，避免遮挡话题栏。
- 会话头部始终展示论坛群组名称，不提供返回话题列表按钮；当前话题由横向切换栏的选中态表达，关闭话题仍显示状态。
- 进入论坛和横向切换话题都记录独立的会话性能链路；快速历史初始化会以最新虚拟列表身份替换旧定位帧，避免界面残留在 `aria-busy` 状态。
- 草稿、回复目标、输入状态、搜索、发送和附件上传通过当前 `activeTopicId` 自动隔离。
- 转发到论坛群组时进入二级话题选择，关闭的话题不可选，避免把消息误发到普通群组上下文。

### 4.3 响应式与无障碍

- 桌面端和移动端都通过顶栏打开管理弹窗；初次加载的后备列表保留会话主体布局。
- 横向话题栏独立滚动且隐藏滚动条，窄屏不挤压消息区，也不造成页面级横向溢出。
- 行操作均使用 Lucide 图标、`aria-label` 和 `title`；编辑/创建表单支持键盘提交和取消。
- 话题列表、消息列表和 Composer 保持独立滚动容器；浏览器回归覆盖桌面和 390px 窄屏，检查横向溢出和按钮可达性。

## 5. 取舍与后续

- 话题通知设置编辑、自定义 emoji 图标选择和完整管理员权限矩阵仍待后续接入。
- 话题列表当前一次读取最多 100 条；需要超大论坛群组时再把三元游标接入 UI 的“加载更多”。
- 真实 TDLib 账号仍需验收权限拒绝、关闭话题发送失败、迟到更新和多设备未读同步；Mock/E2E 不能替代这些原生边界。

## 6. 验证

- `npm run check`：前端构建、类型检查、Vitest、原生单元测试及仓库约束检查。
- `npm run test:e2e -- tests/e2e/forum-topics.e2e.ts`：固定顺序、拖拽/键盘排序与重载、整群历史、管理/删除失败、快速切换草稿、发送后的迟到列表、慢历史下顶栏稳定性和 390px 窄屏。
- 相关 Vitest：TDLib 请求和删除验证、Store 话题上下文/权限/账号代际隔离、草稿修订与附件保留、持久化顺序。
- Playwright 默认无头并通过 `--mute-audio` 静音，使用项目已有依赖，无需安装全局工具。
