# Notgram 项目完整分析报告

## 1. 报告范围与结论

报告基线为当前工作树 `main@16fd66a`，应用版本 `0.5.0-rc.2`，分析日期为 2026-08-11。分析依据包括源码、`project.md`、README、架构/发布文档、近期 Git 提交、测试配置和本地实际执行结果。

Notgram 是一个面向 Windows 桌面的第三方 Telegram 客户端。它不是单纯的 Web 聊天页面，而是一个包含 TDLib 原生运行时、账号级本地存储、媒体文件系统、Windows 窗口/通知/托盘、更新器和发布签名链路的桌面产品。前端使用 React 19 + TypeScript + Zustand，桌面壳使用 Tauri 2，原生侧使用 Rust，Telegram 协议事实来源为 TDLib。

当前的产品能力已经覆盖 `0.5` 候选范围，工程问题主要从“功能是否存在”转移为“候选证据是否闭合”和“高复杂度边界是否可持续维护”。

关键判断：

- 核心业务闭环较完整：授权、多账号、代理、会话/历史、消息操作、论坛话题、媒体、搜索、资料、群组治理、Bot、通知、设置、诊断和发布脚本均已接入。
- 状态所有权正在收紧。最新提交将会话选择和消息视口定位统一为一次事务，并将底部滚动写入集中到单一协调器，这是当前最重要的稳定性改造。
- 前端和原生单元门禁当前全绿，但完整 Playwright Mock 套件在本次复核中 240 秒内未结束，因此当前不能宣称全量 E2E 通过。
- 当前本地便携制品可追溯但未签名；当前提交没有 clean/existing 原生 TDLib 冒烟、WebView 压力/隐私 smoke、安装/升级/卸载和 Narrator/高 DPI 等 Windows 证据。
- 主要技术债是大型协调文件和异步状态耦合：`telegramStore.ts`、`tauriTransport.ts`、`Conversation.tsx`、`App.tsx`、滚动 Hook、视频模块仍承载过多职责。

## 2. 项目规模与目录地图

| 区域 | 文件数 | 代码行数 | 作用 |
| --- | ---: | ---: | --- |
| `src/` | 223 | 56,471 | React UI、Zustand 状态、Telegram 传输、媒体和工具 |
| `src-tauri/src/` | 27 | 9,263 | Rust/Tauri 命令、TDLib runtime、存储和 Windows 集成 |
| `scripts/` | 23 | 2,964 | 检查、TDLib 构建、原生冒烟、发布、签名和压力驱动 |
| `tests/` | 2 | 5,893 | Playwright Mock E2E 与无障碍用例 |
| `docs/` | 8 | 1,585 | 话题、视口、主题、发布、原生验收和本报告 |

主要目录：

```text
src/
  app/             顶层应用编排、导航历史、通知路由、页面选择
  components/      授权、导航、会话、消息、媒体、搜索、资料、治理、设置
  store/           Telegram 根 Store、缓存、草稿、搜索、资料、发件箱、会话、话题
  telegram/        Transport 契约、Mock/Tauri 适配器、TDLib 映射和 service
  media/           音频、视频、媒体查看器、自动下载和播放协调
  notifications/   Windows 通知策略和路由
  release/         更新、诊断和开发者自动化前端桥接
  hooks/ utils/    滚动、虚拟化、菜单、选区、布局、性能和动效纯逻辑
  theme/ styles/   主题注册表、语义颜色 token 和全局样式
src-tauri/src/
  telegram.rs      TDLib runtime、请求/更新入口和文件发送命令
  telegram/        runtime wrapper、安全校验、媒体流、资源授权、日志
  storage.rs       快照、路径和缓存主编排
  storage/         账号、DPAPI 数据库密钥、缓存、受控文件动作
  desktop_*.rs     生命周期、托盘和 Windows 通知
  *window.rs       设置、视频、媒体查看器和上下文菜单窗口
  diagnostics.rs   脱敏日志、崩溃记录和 ZIP 导出
  proxy.rs         系统/自定义代理和凭据保护
scripts/ .github/workflows/
  自动检查、发布候选、代码签名、更新通道和生命周期测试
```

## 3. 技术架构与数据流

```text
React components
       |
Zustand stores ---- localStorage 非敏感偏好
       |            DPAPI 快照/离线队列（由 Tauri 代存）
       |
TelegramTransport
       |---------------- MockTelegramTransport（浏览器开发/E2E）
       |
       +---------- TauriTelegramTransport
                              |
                     Tauri commands/events
                              |
                     Rust 安全边界
                       |      |       |
                    TDLib   storage  Windows
                   tdjson   DPAPI    通知/窗口/更新
                       |
                 Telegram server
```

### 3.1 启动路径

1. `src/main.tsx` 安装 WebView 快捷键保护和性能监控，根据 URL 参数决定渲染主窗口、设置窗口、视频窗口、媒体查看器或原生上下文菜单窗口。
2. `src/telegram/createTransport.ts` 根据 `VITE_TELEGRAM_TRANSPORT` 选择 Mock 或 Tauri 适配器。
3. `telegramStore.initialize()` 先读取缓存快照，再连接 Transport；缓存用于首屏和离线恢复，TDLib/服务端实时状态覆盖缓存事实。
4. Tauri 模式由 `src-tauri/src/lib.rs` 注册插件、窗口生命周期、媒体协议和命令；`telegram_start` 启动 TDLib，专用线程负责 `td_receive`。
5. 授权就绪后，Tauri Transport 启动聊天列表、用户、文件、草稿、历史和更新同步；Store 通过事件归并更新 UI。

### 3.2 事件与状态所有权

- TDLib/Telegram：授权、连接、会话、文件夹、话题、资料、消息、文件、草稿、已读、通知设置和服务端搜索事实。
- `TauriTelegramTransport`：TDLib 请求构造、响应关联、原始对象缓存、分页游标、文件引用、代理恢复和服务拆分编排。
- Zustand Store：UI 可观察状态、快照水合、事件幂等归并、异步 generation 失效和用户操作状态。
- Rust：文件路径、数据库目录、凭据、DPAPI、媒体 Range、通知和窗口等特权边界。
- `App`：只维护一个 `ConversationScrollRequest`，负责入口路径与视口意图协调；Store 是 `activeChatId`/`activeTopicId` 唯一事实来源。
- `useConversationScroll`：底部跟随的唯一 `scrollTop` 写入者；ResizeObserver、挂载回调和高度变化只能提交合并请求。

异步结果必须带目标 generation 或 request id。切换账号、会话、话题或搜索上下文后，迟到结果不能恢复旧选择、旧视口或旧数据。

## 4. 功能模块分析

### 4.1 授权、账号和网络

实现：二维码、手机号、验证码、两步验证、邮箱验证和注册分支；多账号添加/切换/退出；每账号独立 TDLib 数据库、文件缓存、快照和数据库密钥；系统代理、直连、HTTP、SOCKS5、MTProto 和测速；连接中、同步中、在线、等待网络、代理错误和离线状态。

代码边界：`src/components/AuthorizationScreen.tsx`、`src/store/telegramStore.accounts.ts`、`src/telegram/tauriAccountStorage.ts`、`src/telegram/connectionState.ts`、`src/telegram/tdlibRequests.ts`、`src-tauri/src/proxy.rs`、`src-tauri/src/storage/account.rs`。

评价：业务路径完整，且状态被细分为可行动状态；真实账号恢复、代理反复切换、休眠/唤醒仍需要当前候选的原生长稳证据。

### 4.2 会话列表、文件夹和会话切换

实现：主列表、归档、自定义文件夹、置顶排序、静音、归档、离开群组、会话搜索和缓存首屏；置顶顺序采用完整列表同步并支持失败回滚。

代码边界：`src/components/ChatSidebar.tsx`、`src/components/NavigationRail.tsx`、`src/components/FolderManagerDialog.tsx`、`src/store/telegramStore.session.ts`、`src/store/telegramStore.selectors.ts`、`src/telegram/tauriTransport.ts` 的 chat-list 方法。

评价：列表事实和 UI 过滤已分离，但 `App.tsx` 仍同时协调导航历史、搜索作用域、通知路由和页面显示，仍是高风险入口。

### 4.3 历史同步、虚拟列表和阅读位置

实现：按聊天独立历史游标分页，首屏缓存水合，向上加载历史并保持锚点；重复页、空页、停滞页和服务端确认窗口有明确语义；长会话按稳定虚拟块渲染，媒体组保持原子性；已读和“跳到最新”按可见性处理。

代码边界：`src/telegram/historyPager.ts`、`src/hooks/useConversationScroll.ts`、`src/hooks/conversationScrollState.ts`、`src/hooks/conversationBottomState.ts`、`src/utils/messageVirtualization.ts`、`src/components/Conversation.tsx`。

最新改造：`16fd66a` 将选择目标与 `entry/latest/message` 视口命令合并为一个带单调 `requestId` 的事务；底部几何修正由单一协调器管理，避免 Virtuoso、观察者和应用循环互相覆盖。

评价：这是项目最有工程含量、也是最需要继续压测的模块。专项选择/底部稳定测试通过，但完整 E2E 当前超时，说明候选证据仍未闭合。

### 4.4 消息收发和消息操作

实现：文本、回复、局部引用、编辑、仅自己删除/为所有人删除、转发、多选、部分失败重试、emoji 回应、置顶/取消置顶、自动删除、轮询和已读；草稿服务端防抖同步，切换前刷新，迟到更新不覆盖本地最新状态。

代码边界：`src/components/ConversationComposer.tsx`、`src/components/MessageBubble.tsx`、`src/components/ConversationOverlays.tsx`、`src/store/telegramStore.messages.ts`、`src/store/telegramStore.drafts.ts`、`src/store/telegramStore.outboxController.ts`、`src/telegram/tauriMessageMediaService.ts`、`src/telegram/tdUpdateRouter.ts`。

评价：错误恢复和幂等归并是设计重点；复杂度集中在消息更新、发送确认、回复 hydration、未读提及和选择态之间的交叉。

### 4.5 论坛话题群组

实现：论坛超级群组识别、话题列表和游标、话题历史、未读数、最后话题恢复、创建、重命名、关闭/重开、置顶/取消置顶、话题级草稿/输入/搜索/转发/发送。

代码边界：`src/components/ForumTopicsView.tsx`、`src/components/ForumTopicStrip.tsx`、`src/store/telegramStore.forum.ts`、`src/telegram/tauriForumTopicService.ts`、`docs/forum-topics.md`。

关键模型：普通话题使用真实 `topicId`，非论坛聊天才使用无话题上下文；所有消息、草稿、历史、已读和发件箱键均按 `chatId + topicId` 隔离。

未覆盖：频道评论线程、话题删除/通知设置、自定义 emoji 图标和完整管理员角色模型。

### 4.6 文件、媒体和离线发件箱

实现：照片/视频/音频/语音/动画/贴纸/文档发送，粘贴附件和相册，自动下载，下载队列、取消、重试、保存到本地、缓存清理，流式视频，连续音频播放，独立媒体查看器和透明置顶视频窗口；离线文本与附件进入有序发件箱并在线后串行发送。

代码边界：`src/media/autoDownload.ts`、`src/media/fileTransfer.ts`、`src/media/mediaStream.ts`、`src/media/audioPlayback.ts`、`src/media/videoWindowBridge.ts`、`src/media/mediaViewerWindowBridge.ts`、`src/telegram/fileDownloadQueue.ts`、`src/telegram/tauriMessageMediaService.ts`、`src-tauri/src/telegram/media_stream.rs`、`src-tauri/src/storage/file_actions.rs`。

评价：浏览器 Mock 已覆盖主要协议；真实大文件、断点上传、长时间播放、缓存清理后恢复和主/子窗口焦点仍必须在 WebView2/TDLib 上验收。录音、位置、联系人、直播和跨设备断点上传暂未承诺。

### 4.7 搜索、资料、联系人和共享媒体

实现：统一侧栏搜索、会话内 `Ctrl+F`、全局服务端搜索、会话消息搜索、成员过滤、分页预加载、总数、关键词高亮、精确上下文/来源跳转、账号/用户/群组/频道资料、成员分页、联系人和共享媒体分页/TTL 索引。

代码边界：`src/components/GlobalSearchView.tsx`、`src/components/ProfileDrawer.tsx`、`src/components/ContactsView.tsx`、`src/components/SharedMediaBrowser.tsx`、`src/store/globalSearchState.ts`、`src/store/chatMessageSearchState.ts`、`src/store/telegramStore.search.ts`、`src/store/telegramStore.profile.ts`、`src/store/sharedMediaIndex.ts`、`src/telegram/tauriSearchService.ts`、`src/telegram/tauriProfileService.ts`。

评价：服务端分页和状态边界已具备；联系人入口目前从主导航隐藏，真实长历史、论坛群组、删除消息和服务端结果变化还需要验证游标稳定性。

### 4.8 群组治理、安全和 Bot

实现：群组/频道创建，成员添加、角色/状态、标签、权限、慢速模式、所有权转移、事件日志、邀请链接、入群请求、封禁/举报、屏蔽发送者、设备会话、隐私规则；Bot 命令建议、Inline Query、内联键盘和回调答案。

代码边界：`src/components/ChatManagementDialog.tsx`、`src/components/SafetySettings.tsx`、`src/components/NewChatDialog.tsx`、`src/components/InlineKeyboard.tsx`、`src/telegram/chatManagement.ts`、`src/telegram/inviteManagement.test.ts`、`src-tauri/src/telegram/security.rs`。

评价：Mock 写操作基本闭环；原生权限错误、多管理员并发、通知审计和复杂 Bot 工作流仍是服务端验证项。Web App、支付、游戏和 Stars 不在当前承诺内。

### 4.9 Windows 桌面、主题和无障碍

实现：无边框主窗体、设置/视频/媒体/上下文菜单子窗口、托盘、单实例、关闭隐藏、原生通知与点击路由、80%-150% 应用缩放、浅/深主题、字体、减少动态效果、键盘焦点和语义化无障碍；主题由语义 token 契约约束。

代码边界：`src/components/WindowChrome.tsx`、`src/components/SettingsWindow.tsx`、`src/components/VideoWindow.tsx`、`src/components/MediaViewerWindow.tsx`、`src/components/ContextMenuWindow.tsx`、`src/theme/theme.ts`、`src/styles/themes.css`、`src-tauri/src/desktop_lifecycle.rs`、`src-tauri/src/desktop_notification.rs`、`docs/accessibility-matrix.md`。

评价：Chromium 自动化门禁覆盖最小窗口、DPI 模拟、强制色、键盘和语义树；真实 Windows 高 DPI、Contrast Theme、Narrator、通知点击、托盘和多窗口仍未在当前候选完成。

### 4.10 诊断、性能和发布

实现：结构化日志、递归脱敏、性能时间线、长任务/布局/交互采样、诊断 ZIP、可选本地崩溃记录、WebView 压力和隐私 smoke、统一版本源、便携 ZIP、NSIS、签名、更新通道和生命周期脚本。

代码边界：`src/utils/performanceMonitor.ts`、`src/release/diagnostics.ts`、`src/release/appUpdater.ts`、`src/release/automation.ts`、`src-tauri/src/diagnostics.rs`、`scripts/check.ps1`、`scripts/native-smoke.ps1`、`scripts/webview-stress.mjs`、`scripts/test-release-lifecycle.ps1`、`.github/workflows/release.yml`。

评价：发布能力已经工程化，但当前本地制品仍是未签名便携版；稳定/候选通道的真实部署、签名更新清单和生命周期证据尚未闭合。

## 5. 代码模块分析

### 5.1 应用入口与顶层协调

| 文件 | 行数 | 职责 | 评价 |
| --- | ---: | --- | --- |
| `src/main.tsx` | 43 | React 启动、窗口模式分流、全局 guard/性能监控 | 入口清晰 |
| `src/app/App.tsx` | 1,490 | 顶层导航、页面、搜索作用域、通知路由、窗口和焦点 | 仍然过重，异步路由边界多 |
| `src/components/WindowChrome.tsx` | 约 100 | 无边框窗口拖拽/最小化/最大化/关闭 | 依赖 Tauri capability |

`App.tsx` 是前端的流程协调器，不应继续吸收业务 reducer。后续拆分应优先围绕导航路由、通知路由和视口事务建立契约，而不是继续增加条件分支。

### 5.2 UI 组件层

核心组件复杂度如下：

| 文件 | 行数 | 主要内容 |
| --- | ---: | --- |
| `Conversation.tsx` | 2,060 | Virtuoso、消息窗口、置顶、搜索、话题、菜单和焦点组合 |
| `SettingsDialog.tsx` | 1,424 | 账号、代理、存储、主题、通知、隐私、诊断、更新和开发者设置 |
| `MessageBubble.tsx` | 1,180 | 消息分组、富文本、媒体、操作菜单、回应、投票、回复 |
| `ConversationComposer.tsx` | 904 | 草稿、回复/编辑、附件、相册、Bot、发送和输入状态 |
| `VideoPlayer.tsx` + `VideoWindow.tsx` | 1,377 | 播放状态、流缓冲、全屏、窗口同步和控件 |
| `ChatSidebar.tsx` | 653 | 会话列表、文件夹、搜索、置顶和窄屏导航 |

优点是用户流程能在单个纵向组件内闭环；缺点是组件同时拥有视图、异步副作用和协议调用，导致回归定位成本高。`Conversation`、`MessageBubble`、`SettingsDialog` 和视频模块应继续以纯模型/控制器/视图三层收紧。

### 5.3 Zustand Store 层

`src/store/telegramStore.ts` 是根 Store 和 reducer 编排中心，当前 2,840 行。状态包括授权、连接、账号、用户、文件夹、聊天、消息、删除过渡、未读关注、草稿、输入状态、发件箱、历史、论坛、搜索、资料、治理和缓存。

已经拆出的边界：

- `telegramStore.accounts.ts`：账号注册、切换、退出。
- `telegramStore.cache.ts`：缓存迁移、快照、保护路径和健康状态。
- `telegramStore.drafts.ts`：服务端草稿防抖、请求串行化和迟到事件处理。
- `telegramStore.messages.ts`：按消息 id 幂等 upsert、排序、删除和历史合并。
- `telegramStore.outbox.ts`/`outboxController.ts`：文本/附件离线队列和失败重试。
- `telegramStore.search.ts`、`profile.ts`、`session.ts`、`forum.ts`：搜索、资料、会话和话题 controller。
- `preferencesStore.ts`：只保存非敏感偏好，并同步到 `localStorage`/窗口主题。

当前设计的主要风险不是状态缺少类型，而是根 Store 仍拥有太多跨模块副作用。建议继续保持 Transport/Store 接口稳定，按 controller 逐步转移消息治理和生命周期编排。

### 5.4 Telegram 领域和传输层

| 文件/模块 | 行数 | 职责 |
| --- | ---: | --- |
| `src/telegram/types.ts` | 1,223 | 领域模型、输入 DTO、事件和快照类型 |
| `src/telegram/transport.ts` | 197 | Mock/Tauri 的统一能力契约 |
| `src/telegram/mockTransport.ts` | 2,196 | 确定性浏览器运行时、状态持久化和 E2E 场景 |
| `src/telegram/tauriTransport.ts` | 2,804 | TDLib 主编排、请求/更新、分页、文件、治理和恢复 |
| `src/telegram/tdlibMapper.ts` | 1,899 | TDLib 原始对象到领域模型的防御式映射 |
| `src/telegram/tdUpdateRouter.ts` | 165 | TDLib 更新到领域事件的路由 |
| `src/telegram/tdRequestBroker.ts` | 197 | 请求 id 与响应关联、超时/失败边界 |
| `src/telegram/tauri*Service.ts` | 1,608 合计 | 搜索、资料、消息媒体和论坛话题专用 service |

这是合理的 ports-and-adapters 结构：UI 不读取 TDLib 原始 JSON，Mock 和 Tauri 共享同一 Transport 契约。主要维护问题是 `tauriTransport.ts` 仍同时承担授权后同步、Bot、治理和媒体调用，应继续拆分但必须保持请求和事件兼容。

### 5.5 媒体、通知、发布和工具层

- `src/media/`：文件检查、下载队列、自动下载、WebAudio、视频流和子窗口桥接；核心状态需要避免多个播放器同时抢占全局媒体资源。
- `src/notifications/`：消息通知策略、预览/声音偏好、点击后的账号/聊天/话题路由。
- `src/release/`：更新检查、诊断导出和 opt-in 自动化端口配置。
- `src/hooks/`：滚动、定位、菜单关闭、模态焦点、可见性和置顶消息等交互控制器。
- `src/utils/`：消息分组/虚拟化、选区引用、媒体布局、外链安全、下载管理、性能监控、动效策略和格式化；这些模块大多有独立 Vitest，适合继续承载纯逻辑。

### 5.6 Rust/Tauri 原生层

| 文件/模块 | 行数 | 职责 |
| --- | ---: | --- |
| `src-tauri/src/lib.rs` | 约 130 | 插件、协议、command allowlist 和运行入口 |
| `src-tauri/src/telegram.rs` | 1,344 | TDLib runtime、接收循环、请求和文件命令 |
| `telegram/security.rs` | 2,171 | 通用 bridge 白名单、字段/权限/路径校验、上传构造 |
| `telegram/tdlib_runtime.rs` | 约 100 | 动态库加载和 runtime wrapper |
| `telegram/media_stream.rs` | 693 | 注册文件、Range 校验和流式响应 |
| `telegram/assets.rs` | 约 150 | TDLib 文件完成状态与 asset scope 授权 |
| `storage.rs` | 789 | 快照、缓存路径、清理和存储设置主编排 |
| `storage/account.rs` | 约 300 | 账号目录隔离和账号表 |
| `storage/database_key.rs` | 约 200 | 每账号数据库密钥和 Windows DPAPI |
| `storage/cache.rs`/`file_actions.rs` | 约 550 | 缓存清理、可信根和受控文件操作 |
| `diagnostics.rs` | 626 | 脱敏日志、同意状态、崩溃记录和 ZIP 导出 |
| `desktop_lifecycle.rs`/`desktop_notification.rs` | 约 350 | 单实例、托盘、关闭隐藏和 Windows Toast |
| `video_window.rs`/`media_viewer_window.rs`/`settings_window.rs` | 约 250 | 子窗口创建、标识校验、定位和焦点 |

原生层最重要的架构决策是最小权限：WebView 不拿本地上传路径，不通过通用 TDLib bridge 发送 `inputFileLocal`，资产协议静态 scope 为空，媒体协议只读取已注册且已观察的范围。

### 5.7 脚本、文档和测试模块

- `scripts/check.ps1` 统一执行版本、发布策略、主题、Vitest、构建、E2E 类型、Rust fmt/Clippy/test；`-Release` 追加 Tauri release build。
- `scripts/native-smoke.ps1` 生成 clean/existing profile 的脱敏清单；`scripts/webview-stress.mjs` 和 `webview-privacy-smoke.mjs` 面向真实 WebView2。
- `scripts/publish-*.ps1`、`sign-windows-files.ps1`、`publish-update-channel.ps1` 和 `.github/workflows/release.yml` 组成签名发布链路。
- `tests/e2e/notgram.e2e.ts` 是主要 Mock E2E；`accessibility.e2e.ts` 覆盖窄屏、DPI、强制色、键盘和语义树。
- `docs/conversation-state-model.md` 和 `docs/forum-topics.md` 是行为契约，不只是说明文档；后续改动应先更新不变量再改代码。

## 6. 安全与可靠性分析

### 6.1 已有防护

- API ID/Hash 在 Rust 读取，不发送给 WebView；代理凭据、账号表、快照和数据库密钥由当前 Windows 用户 DPAPI 保护。
- `security.rs` 对请求类型、文本长度、ID、权限键、邀请链接、用户列表、消息目标和媒体元数据做白名单/上限校验。
- 通用 bridge 拒绝本地文件和特权请求，上传/打开/保存/媒体流走专用命令。
- Tauri CSP 限制 `connect-src`、媒体协议和资源来源；`freezePrototype`、关闭 DevTools/默认右键菜单和快捷键 guard 收紧 WebView。
- 资产协议只逐文件授权可信账号根目录内、TDLib 已完成且已观察的文件；缓存快照路径会 canonicalize 并校验根目录。
- 日志和诊断做递归脱敏，不包含消息正文、凭据、手机号、账号/聊天/消息 id 和本地身份路径；崩溃记录默认关闭。

### 6.2 仍需关注

- 任何新增 TDLib request、Tauri capability、asset scope、媒体 Range 或诊断字段都可能扩大攻击面，必须配套安全测试。
- 自动化调试端口虽然默认关闭且只绑定 loopback，但连接者可以操作已认证 UI，生产环境必须保持显式 opt-in 并及时关闭。
- 当前未签名制品不能作为正式分发；签名主体、更新清单和发布通道必须在候选冻结后记录。

## 7. 测试与当前证据

### 7.1 已实际执行

本次复核执行了：

```text
npm test -- --run       69 个测试文件，453/453 通过
npm run build           TypeScript 和 Vite 生产构建通过
npm run check           全部通过
```

`npm run check` 还确认：版本同步有效、发布策略有效、主题契约有效（当前脚本报告 38 个语义颜色 token）、Playwright 类型检查通过、Rust fmt/Clippy 通过、Rust 63/63 通过。

构建警告：`index-BG59O1ik.js` 约 1,235.77 kB，gzip 365.72 kB；Tauri core 动态 import 因同时被静态依赖而无法独立分块；Vite 仍提示 chunk 超过 500 kB。该警告不阻断构建，但应纳入体积预算。

### 7.2 当前未能闭合

本次执行 `npm run test:e2e`，240 秒内未得到最终汇总，命令以超时结束；测试目录只产生了前若干场景的 trace/screenshot 产物，不能推断通过率。项目文档中记录的专项会话选择/底部稳定 3/3 仍可作为专项证据，但不是当前全量 E2E 结果。

以下证据在当前 `16fd66a` 上没有新记录：

- clean profile 和 existing account 的真实 TDLib 冒烟；
- WebView2 压力、隐私 smoke 和长会话内存基线；
- 已签名便携/NSIS、更新清单和真实发布通道；
- 安装、升级、卸载、通知点击、托盘、休眠/唤醒和高 DPI/Narrator 人工门禁。

## 8. 风险、技术债和优先级

### P0：候选冻结阻塞

1. **完整 Mock E2E 超时/无法出汇总。** 先定位当前套件的挂起或极慢场景，保证单条测试能在 30 秒内结束并生成明确失败；不能用历史 `93/113` 或专项 `3/3` 代替当前全量基线。
2. **原生证据不在当前提交上。** 必须在冻结提交执行 clean/existing、网络/代理恢复、论坛、搜索、媒体、视口和通知冒烟，并归档脱敏 run metadata。
3. **制品未签名。** 当前便携 ZIP 只证明构建可追溯；正式发布还需要 Authenticode、Tauri updater 签名、NSIS、更新通道和生命周期检查。

### P1：维护性和性能

1. **大型根协调文件。** `telegramStore.ts`、`tauriTransport.ts`、`Conversation.tsx`、`App.tsx` 和 `SettingsDialog.tsx` 的职责重叠会放大迟到事件和交互竞态的回归成本。
2. **滚动边界仍高风险。** Virtuoso、ResizeObserver、媒体尺寸和消息挂载都影响几何；需要以不变量测试和真实 WebView 长会话数据固定 settlement、底部跟随和 detached 行为。
3. **缺少可比较性能阈值。** 已有性能采样和压力驱动，但尚未定义启动、首次会话、历史分页、交互延迟、DOM/内存增长的候选门槛。
4. **前端主包偏大。** KaTeX、Lottie、Markdown、Tauri API 和根入口一起进入较大的主 chunk，应评估按设置/富文本/媒体/窗口场景拆分。

### P2：产品边界和运营

- 联系人入口当前隐藏，稳定版需要决定新入口或明确不承诺。
- 共享媒体筛选/批量操作、频道评论线程、复杂管理员权限、播放队列、断点上传和更多 Bot 能力需要在功能取舍清单中明确版本归属。
- 便携版禁用自动更新，发布说明和支持流程必须明确用户如何替换 ZIP、如何保留/清理账号数据。
- 需要建立候选到 stable 的前向修复演练和至少两个已签名版本的保留策略。

## 9. 建议路线图

### 阶段 A：恢复当前提交的可比较自动化基线

1. 从 `tests/e2e/notgram.e2e.ts` 的最后运行场景开始二分，单独运行每个 describe/test，确认挂起、资源等待或服务器关闭问题。
2. 将慢测试拆成独立项目或设置明确超时，保留失败 trace；修复后取得当前提交的完整通过数。
3. 继续保持 453 Vitest、63 Rust 和 `npm run check` 全绿，避免在候选阶段做大范围重构。

### 阶段 B：原生和安全证据

1. 在同一冻结 commit 跑 Clean/Existing 原生冒烟，特别覆盖一次点击切换、话题路由、搜索/置顶/回复定位、缓存水合、离线队列和代理恢复。
2. 运行 WebView stress/privacy smoke，建立启动、交互、历史加载和内存阈值；审查 automation 端口、日志和诊断导出。
3. 运行已签名候选的 DPI、强制色、Narrator、键盘、通知、托盘、子窗口和休眠/唤醒清单。

### 阶段 C：发布冻结

1. 同步版本源到 `rc.3`，冻结功能，只接受消息一致性、崩溃、安全、原生验收和发布阻塞修复。
2. 通过 release workflow 生成已签名便携 ZIP、NSIS、依赖/许可证/哈希、更新清单和生命周期证据。
3. 记录版本、提交、签名主体、制品哈希、自动检查、原生冒烟和人工门禁的摘要，禁止记录账号和消息数据。

### 阶段 D：候选之后的降复杂度

按一个边界一次的原则继续拆分：先消息/治理编排，再 `App` 导航与通知路由，最后视频窗口协议和主入口 chunk。保持 Transport 契约、Tauri command 和缓存 schema 兼容，用契约测试固定外部行为。

## 10. 最终评价

Notgram 的工程方向是正确的：以 TDLib/服务端为事实源，以 Mock 保证确定性，以 Rust/Tauri 承担 Windows 和安全边界，以 Zustand 管理 UI 归并，并对缓存、离线队列、日志和发布制品设置边界。功能模块之间已经形成纵向闭环，项目不是“功能演示”，而是接近 Windows 发布候选的桌面客户端。

当前不应继续以扩大 TDLib API 覆盖率作为主要目标。最高价值工作是完成当前提交的 E2E 可比较基线、真实原生证据、签名发布和性能阈值，然后再针对联系人入口、播放队列、断点上传或更深群组/Bot 能力做产品取舍。只要坚持“事实来源单一、异步结果带 generation、特权留在 Rust、Mock 与原生证据分层”的约束，后续迭代可以在不破坏核心消息一致性的前提下推进。
