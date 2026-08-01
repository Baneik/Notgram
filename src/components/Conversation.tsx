import {
  AlertCircle,
  ArrowDown,
  Check,
  ChevronLeft,
  Forward,
  Edit3,
  MoreVertical,
  LoaderCircle,
  Paperclip,
  Phone,
  Search,
  Send,
  Smile,
  Reply,
  Trash2,
  X,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  Chat,
  ChatDraft,
  Message,
  MessageContent,
  MessagePermissions,
  ForwardMessagesResult,
  User,
} from "../telegram/types";
import { formatMessageDay, localDateKey } from "../utils/formatters";
import {
  groupConsecutiveMessages,
  messageGroupPosition,
} from "../utils/messageGrouping";
import { Avatar } from "./Avatar";
import { MessageBubble as RichMessageBubble } from "./MessageBubble";
import { usePreferencesStore } from "../store/preferencesStore";

interface ConversationProps {
  chat?: Chat;
  scrollScope: string;
  latestScrollRequest?: {
    chatId: string;
    requestId: number;
  };
  messages: Message[];
  chatDraft?: ChatDraft;
  forwardTargets: Chat[];
  users: Map<string, User>;
  historyLoading: boolean;
  hasOlderMessages: boolean;
  transportKind: "mock" | "tauri";
  onSendMessage: (text: string, replyToMessageId?: string) => Promise<boolean>;
  onEditMessage: (messageId: string, text: string) => Promise<boolean>;
  onDeleteMessage: (messageId: string, revoke: boolean) => Promise<boolean>;
  onDraftChange: (chatId: string, text: string, replyToMessageId?: string) => void;
  onForwardMessages: (
    fromChatId: string,
    messageIds: string[],
    toChatId: string,
  ) => Promise<ForwardMessagesResult | undefined>;
  onLoadMessageProperties: (
    chatId: string,
    messageId: string,
  ) => Promise<MessagePermissions | undefined>;
  onSetMessageReaction: (messageId: string, emoji: string, chosen: boolean) => Promise<void>;
  onSearchMessages: (query: string) => Promise<void>;
  onDownloadFile: (fileId: number, fileName: string) => Promise<void>;
  onRetryMessage: (messageId: string) => Promise<void>;
  onSendFile: (file?: File) => Promise<boolean>;
  onCancelFileUpload: (messageId: string) => Promise<void>;
  onLoadOlder: () => Promise<void>;
  onBack: () => void;
}

const COMPOSER_TEXTAREA_MIN_HEIGHT = 40;
const COMPOSER_TEXTAREA_MAX_HEIGHT = 290;
const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "👏", "😮"];
const BOTTOM_PROXIMITY_PX = 40;

interface ConversationScrollMemory {
  scrollTop: number;
  followLatest: boolean;
  lastKnownMessageId?: string;
  pendingNewCount: number;
  anchorMessageId?: string;
  anchorOffset?: number;
}

interface ConversationLayoutSnapshot {
  key?: string;
  firstId?: string;
  lastId?: string;
  search: string;
}

const conversationScrollMemory = new Map<string, ConversationScrollMemory>();

const scrollMemoryKey = (scope: string, chatId?: string) =>
  chatId ? `${scope}:${chatId}` : undefined;

const distanceFromBottom = (element: HTMLElement) =>
  Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);

const captureScrollMemory = (
  element: HTMLElement,
  lastKnownMessageId: string | undefined,
  pendingNewCount: number,
  followLatest = distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX,
): ConversationScrollMemory => {
  const listBounds = element.getBoundingClientRect();
  const anchor = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((row) => row.getBoundingClientRect().bottom > listBounds.top + 1);
  const atBottom = distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX;
  const shouldFollowLatest = atBottom || followLatest;
  return {
    scrollTop: element.scrollTop,
    followLatest: shouldFollowLatest,
    lastKnownMessageId,
    pendingNewCount: shouldFollowLatest ? 0 : pendingNewCount,
    anchorMessageId: anchor?.dataset.messageId,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - listBounds.top : undefined,
  };
};

const restoreScrollMemory = (element: HTMLElement, memory: ConversationScrollMemory) => {
  element.scrollTop = memory.scrollTop;
  if (!memory.anchorMessageId || memory.anchorOffset === undefined) return;
  const anchor = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((row) => row.dataset.messageId === memory.anchorMessageId);
  if (!anchor) return;
  const currentOffset = anchor.getBoundingClientRect().top - element.getBoundingClientRect().top;
  element.scrollTop += currentOffset - memory.anchorOffset;
};

const appendedMessageCount = (messages: Message[], previousLastId?: string) => {
  if (!previousLastId) return 0;
  const previousIndex = messages.findIndex((message) => message.id === previousLastId);
  return previousIndex < 0 ? 0 : Math.max(0, messages.length - previousIndex - 1);
};

const resizeComposerInput = (input: HTMLTextAreaElement) => {
  input.style.height = `${COMPOSER_TEXTAREA_MIN_HEIGHT}px`;
  const contentHeight = input.scrollHeight;
  input.style.height = `${Math.min(
    COMPOSER_TEXTAREA_MAX_HEIGHT,
    Math.max(COMPOSER_TEXTAREA_MIN_HEIGHT, contentHeight),
  )}px`;
  input.style.overflowY = contentHeight > COMPOSER_TEXTAREA_MAX_HEIGHT
    ? "auto"
    : "hidden";
};

export function Conversation({
  chat,
  scrollScope,
  latestScrollRequest,
  messages,
  chatDraft,
  forwardTargets,
  users,
  historyLoading,
  hasOlderMessages,
  transportKind,
  onSendMessage,
  onEditMessage,
  onDeleteMessage,
  onDraftChange,
  onForwardMessages,
  onLoadMessageProperties,
  onSetMessageReaction,
  onSearchMessages,
  onDownloadFile,
  onRetryMessage,
  onSendFile,
  onCancelFileUpload,
  onLoadOlder,
  onBack,
}: ConversationProps) {
  const [draft, setDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [messageSearch, setMessageSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [attachmentPending, setAttachmentPending] = useState(false);
  const [actionMenu, setActionMenu] = useState<{
    messageId: string;
    left: number;
    top: number;
  }>();
  const [actionLoadingId, setActionLoadingId] = useState<string>();
  const [replyingTo, setReplyingTo] = useState<Message>();
  const [editingMessage, setEditingMessage] = useState<Message>();
  const [deleteTarget, setDeleteTarget] = useState<Message>();
  const [deletePending, setDeletePending] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [selectionLoadingIds, setSelectionLoadingIds] = useState<Set<string>>(new Set());
  const [forwardDialogOpen, setForwardDialogOpen] = useState(false);
  const [forwardQuery, setForwardQuery] = useState("");
  const [forwardPending, setForwardPending] = useState(false);
  const [forwardPendingTargetId, setForwardPendingTargetId] = useState<string>();
  const [newMessageNotice, setNewMessageNotice] = useState<{
    key: string;
    count: number;
  }>();
  const sendOnEnter = usePreferencesStore((state) => state.sendOnEnter);
  const autoplayAnimations = usePreferencesStore((state) => state.autoplayAnimations);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const draftBeforeEditRef = useRef<string | undefined>(undefined);
  const autoFillAttemptRef = useRef<string | undefined>(undefined);
  const previousLayoutRef = useRef<ConversationLayoutSnapshot | undefined>(undefined);
  const handledLatestRequestRef = useRef(0);
  const scrollPointerActiveRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);

  const sendAttachment = async (file?: File) => {
    if (attachmentPending) return;
    setAttachmentPending(true);
    try {
      await onSendFile(file);
    } finally {
      setAttachmentPending(false);
    }
  };

  const displayMessages = useMemo(
    () => chat?.kind === "saved"
      ? messages.map((message) => message.outgoing ? message : { ...message, outgoing: true })
      : messages,
    [chat?.kind, messages],
  );

  const visibleMessages = useMemo(() => {
    const query = messageSearch.trim().toLocaleLowerCase();
    if (!query) return displayMessages;
    return displayMessages.filter((message) => {
      if (message.content.kind === "file" || message.content.kind === "media") {
        return message.content.fileName.toLocaleLowerCase().includes(query);
      }
      return message.content.text.toLocaleLowerCase().includes(query);
    });
  }, [displayMessages, messageSearch]);

  const visibleMessageGroups = useMemo(
    () => groupConsecutiveMessages(visibleMessages),
    [visibleMessages],
  );

  const messagesById = useMemo(
    () => new Map(displayMessages.map((message) => [message.id, message])),
    [displayMessages],
  );

  const filteredForwardTargets = useMemo(() => {
    const query = forwardQuery.trim().toLocaleLowerCase();
    return query
      ? forwardTargets.filter((target) => target.title.toLocaleLowerCase().includes(query))
      : forwardTargets;
  }, [forwardQuery, forwardTargets]);
  const forwardTargetsById = useMemo(
    () => new Map(forwardTargets.map((target) => [target.id, target])),
    [forwardTargets],
  );

  const selectionMode = selectedMessageIds.size > 0;

  useLayoutEffect(() => {
    const input = composerInputRef.current;
    if (!input || selectionMode) return;
    resizeComposerInput(input);
  }, [chat?.id, draft, selectionMode]);

  useEffect(() => {
    const input = composerInputRef.current;
    if (!input || selectionMode) return;
    const observer = new ResizeObserver(() => resizeComposerInput(input));
    observer.observe(input);
    return () => observer.disconnect();
  }, [chat?.id, selectionMode]);

  const actionMessage = actionMenu
    ? messagesById.get(actionMenu.messageId)
    : undefined;
  const actionPermissions = actionMessage?.permissions;
  const currentScrollKey = scrollMemoryKey(scrollScope, chat?.id);
  const lastVisibleMessageId = visibleMessages.at(-1)?.id;

  const jumpToLatest = () => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    scrollPointerActiveRef.current = false;
    userScrollIntentUntilRef.current = 0;
    element.scrollTop = element.scrollHeight;
    const memory = captureScrollMemory(element, lastVisibleMessageId, 0, true);
    conversationScrollMemory.set(currentScrollKey, {
      ...memory,
      followLatest: true,
      pendingNewCount: 0,
    });
    setNewMessageNotice({ key: currentScrollKey, count: 0 });
  };

  useEffect(() => {
    setActionMenu(undefined);
    setActionLoadingId(undefined);
    setReplyingTo(undefined);
    setEditingMessage(undefined);
    setDeleteTarget(undefined);
    setDeletePending(false);
    setSelectedMessageIds(new Set());
    setSelectionLoadingIds(new Set());
    setForwardDialogOpen(false);
    setForwardQuery("");
    setForwardPending(false);
    setForwardPendingTargetId(undefined);
    setSearchOpen(false);
    setMessageSearch("");
    setDraft(chatDraft?.text ?? "");
    draftBeforeEditRef.current = undefined;
  }, [chat?.id]);

  useEffect(() => {
    if (!editingMessage) setDraft(chatDraft?.text ?? "");
  }, [chat?.id, chatDraft?.text, editingMessage]);

  useEffect(() => {
    if (editingMessage) return;
    const replyToMessageId = chatDraft?.replyToMessageId;
    if (!replyToMessageId) {
      setReplyingTo(undefined);
      return;
    }
    const target = messagesById.get(replyToMessageId);
    if (target) {
      setReplyingTo((current) => current?.id === target.id ? current : target);
    }
  }, [chat?.id, chatDraft?.replyToMessageId, editingMessage, messagesById]);

  useEffect(() => {
    if (actionMenu && !messagesById.has(actionMenu.messageId)) setActionMenu(undefined);
    if (replyingTo && !messagesById.has(replyingTo.id)) {
      setReplyingTo(undefined);
    }
    if (editingMessage && !messagesById.has(editingMessage.id)) {
      setEditingMessage(undefined);
      setDraft(draftBeforeEditRef.current ?? "");
      draftBeforeEditRef.current = undefined;
    }
    if (deleteTarget && !messagesById.has(deleteTarget.id)) setDeleteTarget(undefined);
  }, [actionMenu, deleteTarget, editingMessage, messagesById, replyingTo]);

  useEffect(() => {
    setSelectedMessageIds((current) => {
      const available = new Set([...current].filter((messageId) => messagesById.has(messageId)));
      return available.size === current.size ? current : available;
    });
  }, [messagesById]);

  useEffect(() => {
    const query = messageSearch.trim();
    if (!chat?.id || !query) return;
    const timer = globalThis.setTimeout(() => void onSearchMessages(query), 250);
    return () => globalThis.clearTimeout(timer);
  }, [chat?.id, messageSearch, onSearchMessages]);

  useEffect(() => {
    if (!selectionMode) return;
    const closeWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (forwardDialogOpen && !forwardPending) {
        setForwardDialogOpen(false);
        setForwardQuery("");
      } else if (!forwardPending) {
        setSelectedMessageIds(new Set());
      }
    };
    document.addEventListener("keydown", closeWithKeyboard);
    return () => document.removeEventListener("keydown", closeWithKeyboard);
  }, [forwardDialogOpen, forwardPending, selectionMode]);

  useEffect(() => {
    if (!actionMenu) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".message-action-menu")) return;
      setActionMenu(undefined);
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionMenu(undefined);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [actionMenu]);

  useLayoutEffect(() => {
    const element = messageListRef.current;
    if (!element || !currentScrollKey) return;
    const previous = previousLayoutRef.current;
    const firstId = visibleMessages[0]?.id;
    const lastId = lastVisibleMessageId;
    const stored = conversationScrollMemory.get(currentScrollKey);

    if (messageSearch) {
      if (!previous || previous.key !== currentScrollKey || previous.search !== messageSearch) {
        element.scrollTop = 0;
      }
      setNewMessageNotice({
        key: currentScrollKey,
        count: stored?.pendingNewCount ?? 0,
      });
      previousLayoutRef.current = {
        key: currentScrollKey,
        firstId,
        lastId,
        search: messageSearch,
      };
      return;
    }

    let pendingNewCount = stored?.pendingNewCount ?? 0;
    let followLatest = stored?.followLatest ?? true;
    const enteringChat = !previous || previous.key !== currentScrollKey;
    const leavingSearch = previous?.key === currentScrollKey && Boolean(previous.search);
    if (enteringChat || leavingSearch) {
      if (!stored) {
        element.scrollTop = element.scrollHeight;
        pendingNewCount = 0;
        followLatest = true;
      } else if (stored.followLatest) {
        element.scrollTop = element.scrollHeight;
        pendingNewCount = 0;
        followLatest = true;
      } else {
        restoreScrollMemory(element, stored);
        pendingNewCount += appendedMessageCount(visibleMessages, stored.lastKnownMessageId);
        followLatest = false;
      }
    } else if (stored) {
      const firstMessageChanged = previous.firstId !== firstId;
      const previousFirstStillPresent = Boolean(
        previous.firstId && visibleMessages.some((message) => message.id === previous.firstId),
      );
      if (firstMessageChanged && previousFirstStillPresent) {
        if (stored.followLatest) element.scrollTop = element.scrollHeight;
        else restoreScrollMemory(element, stored);
      }

      if (previous.lastId !== lastId) {
        if (stored.followLatest) {
          element.scrollTop = element.scrollHeight;
          pendingNewCount = 0;
          followLatest = true;
        } else {
          pendingNewCount += appendedMessageCount(visibleMessages, stored.lastKnownMessageId);
          followLatest = false;
        }
      }
    }

    const memory = captureScrollMemory(element, lastId, pendingNewCount, followLatest);
    conversationScrollMemory.set(currentScrollKey, memory);
    setNewMessageNotice({ key: currentScrollKey, count: memory.pendingNewCount });
    previousLayoutRef.current = {
      key: currentScrollKey,
      firstId,
      lastId,
      search: messageSearch,
    };
  }, [currentScrollKey, lastVisibleMessageId, messageSearch, visibleMessages]);

  useLayoutEffect(() => {
    if (
      !latestScrollRequest ||
      latestScrollRequest.chatId !== chat?.id ||
      latestScrollRequest.requestId <= handledLatestRequestRef.current
    ) {
      return;
    }
    handledLatestRequestRef.current = latestScrollRequest.requestId;
    jumpToLatest();
  }, [chat?.id, latestScrollRequest]);

  useEffect(() => {
    const element = messageListRef.current;
    const content = element?.querySelector<HTMLElement>(".message-list-content");
    if (!element || !content || !currentScrollKey || messageSearch) return;
    let animationFrame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const stored = conversationScrollMemory.get(currentScrollKey);
        if (!stored) return;
        if (stored.followLatest) element.scrollTop = element.scrollHeight;
        else restoreScrollMemory(element, stored);
        const memory = captureScrollMemory(
          element,
          visibleMessages.at(-1)?.id,
          stored.pendingNewCount,
          stored.followLatest,
        );
        conversationScrollMemory.set(currentScrollKey, memory);
        setNewMessageNotice({ key: currentScrollKey, count: memory.pendingNewCount });
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    };
  }, [currentScrollKey, messageSearch, visibleMessages]);

  useEffect(() => {
    const element = messageListRef.current;
    if (
      !element ||
      messageSearch ||
      historyLoading ||
      !hasOlderMessages ||
      element.scrollHeight > element.clientHeight + 1
    ) {
      return;
    }
    const attemptKey = `${chat?.id ?? ""}:${messages.length}`;
    if (autoFillAttemptRef.current === attemptKey) return;
    autoFillAttemptRef.current = attemptKey;
    void onLoadOlder();
  }, [chat?.id, hasOlderMessages, historyLoading, messageSearch, messages.length, onLoadOlder]);

  if (!chat) {
    return (
      <section className="conversation empty-conversation">
        <div className="conversation-empty-mark">N</div>
        <h2>选择一个对话</h2>
      </section>
    );
  }

  const peer = chat.peerId ? users.get(chat.peerId) : undefined;
  const statusLabel =
    chat.kind === "channel"
      ? "频道"
      : chat.kind === "group"
        ? "群组"
        : chat.kind === "saved"
          ? "仅自己可见"
          : peer?.presence === "typing"
            ? "正在输入"
            : peer?.presence === "online"
              ? "在线"
              : peer?.lastSeenLabel
                ? `最后上线：${peer.lastSeenLabel}`
                : "离线";
  const composerContextMessage = editingMessage ?? replyingTo;
  const composerContextTitle = editingMessage
    ? "编辑消息"
    : replyingTo
      ? `回复 ${senderNameForMessage(replyingTo, users, chat)}`
      : undefined;

  const focusComposer = () => {
    globalThis.setTimeout(() => composerInputRef.current?.focus(), 0);
  };

  const openActionMenu = async (message: Message, left: number, top: number) => {
    const menuWidth = 184;
    const menuHeight = 170;
    setActionMenu({
      messageId: message.id,
      left: Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - menuHeight - 8)),
    });
    if (message.permissions || actionLoadingId === message.id) return;
    setActionLoadingId(message.id);
    await onLoadMessageProperties(message.chatId, message.id);
    setActionLoadingId((current) => current === message.id ? undefined : current);
  };

  const cancelEditing = () => {
    setEditingMessage(undefined);
    setDraft(chatDraft?.text ?? draftBeforeEditRef.current ?? "");
    draftBeforeEditRef.current = undefined;
    focusComposer();
  };

  const cancelReply = () => {
    setReplyingTo(undefined);
    onDraftChange(chat.id, draft, undefined);
    focusComposer();
  };

  const startReply = (message: Message) => {
    if (editingMessage) {
      setDraft(chatDraft?.text ?? draftBeforeEditRef.current ?? "");
      setEditingMessage(undefined);
      draftBeforeEditRef.current = undefined;
    }
    setReplyingTo(message);
    onDraftChange(chat.id, chatDraft?.text ?? draft, message.id);
    setActionMenu(undefined);
    focusComposer();
  };

  const startEditing = (message: Message) => {
    if (message.content.kind !== "text") return;
    if (!editingMessage) draftBeforeEditRef.current = draft;
    setReplyingTo(undefined);
    setEditingMessage(message);
    setDraft(message.content.text);
    setActionMenu(undefined);
    focusComposer();
  };

  const submitMessage = async () => {
    const submitted = draft.trim();
    if (!submitted || sending) return;
    if (editingMessage) {
      setSending(true);
      const edited = await onEditMessage(editingMessage.id, submitted);
      setSending(false);
      if (edited) cancelEditing();
      return;
    }
    setDraft("");
    setSending(true);
    const sent = await onSendMessage(submitted, replyingTo?.id ?? chatDraft?.replyToMessageId);
    setSending(false);
    if (sent) {
      setReplyingTo(undefined);
    } else {
      setDraft((current) => current ? `${submitted}\n${current}` : submitted);
    }
  };

  const confirmDelete = async (revoke: boolean) => {
    if (!deleteTarget || deletePending) return;
    setDeletePending(true);
    const deleted = await onDeleteMessage(deleteTarget.id, revoke);
    setDeletePending(false);
    if (deleted) setDeleteTarget(undefined);
  };

  const startForwardSelection = (message: Message) => {
    if (editingMessage) {
      setDraft(chatDraft?.text ?? draftBeforeEditRef.current ?? "");
      setEditingMessage(undefined);
      draftBeforeEditRef.current = undefined;
    }
    setActionMenu(undefined);
    setSearchOpen(false);
    setMessageSearch("");
    setSelectedMessageIds(new Set([message.id]));
  };

  const toggleMessageSelection = async (message: Message) => {
    if (selectedMessageIds.has(message.id)) {
      setSelectedMessageIds((current) => {
        const next = new Set(current);
        next.delete(message.id);
        return next;
      });
      return;
    }
    if (selectedMessageIds.size >= 100 || selectionLoadingIds.has(message.id)) return;

    let permissions = message.permissions;
    if (!permissions) {
      setSelectionLoadingIds((current) => new Set(current).add(message.id));
      permissions = await onLoadMessageProperties(message.chatId, message.id);
      setSelectionLoadingIds((current) => {
        const next = new Set(current);
        next.delete(message.id);
        return next;
      });
    }
    if (!permissions?.canForward) return;
    setSelectedMessageIds((current) => current.size >= 100
      ? current
      : new Set(current).add(message.id));
  };

  const confirmForward = async (target: Chat) => {
    if (forwardPending) return;
    const messageIds = messages
      .filter((message) => selectedMessageIds.has(message.id))
      .map((message) => message.id);
    if (messageIds.length === 0) return;
    setForwardPending(true);
    setForwardPendingTargetId(target.id);
    const result = await onForwardMessages(chat.id, messageIds, target.id);
    setForwardPending(false);
    setForwardPendingTargetId(undefined);
    if (!result) {
      setForwardDialogOpen(false);
      setForwardQuery("");
      return;
    }
    if (result.failedMessageIds.length > 0) {
      setSelectedMessageIds(new Set(result.failedMessageIds));
      setForwardDialogOpen(false);
      setForwardQuery("");
      return;
    }
    setForwardDialogOpen(false);
    setForwardQuery("");
    setSelectedMessageIds(new Set());
  };

  return (
    <section
      className={`conversation ${searchOpen ? "has-message-search" : ""} ${selectionMode ? "is-selecting-messages" : ""}`}
      aria-label={`${chat.title} 对话`}
    >
      <header className={`conversation-header ${selectionMode ? "is-selection-header" : ""}`}>
        {selectionMode ? (
          <>
            <button
              className="icon-button"
              type="button"
              aria-label="取消选择"
              title="取消选择"
              onClick={() => setSelectedMessageIds(new Set())}
            >
              <X size={20} strokeWidth={2} />
            </button>
            <div className="message-selection-title">
              <strong>已选择 {selectedMessageIds.size} 条</strong>
              <span>最多可同时转发 100 条消息</span>
            </div>
          </>
        ) : (
          <>
            <button className="mobile-back icon-button" type="button" aria-label="返回会话列表" title="返回会话列表" onClick={onBack}>
              <ChevronLeft size={21} strokeWidth={2} />
            </button>
            <Avatar avatar={chat.avatar} size="medium" />
            <div className="conversation-title">
              <h2>{chat.title}</h2>
              <span>{statusLabel}</span>
            </div>
            <div className="conversation-actions">
              <button className="icon-button" type="button" aria-label="语音通话" title="语音通话">
                <Phone size={19} strokeWidth={1.8} />
              </button>
              <button
                className={`icon-button ${searchOpen ? "is-active" : ""}`}
                type="button"
                aria-label="搜索消息"
                title="搜索消息"
                onClick={() => {
                  setSearchOpen((open) => !open);
                  if (searchOpen) setMessageSearch("");
                }}
              >
                <Search size={19} strokeWidth={1.8} />
              </button>
              <button className="icon-button" type="button" aria-label="更多操作" title="更多操作">
                <MoreVertical size={20} strokeWidth={1.8} />
              </button>
            </div>
          </>
        )}
      </header>

      {searchOpen && (
        <div className="message-search-row">
          <Search size={16} strokeWidth={1.8} />
          <input
            autoFocus
            value={messageSearch}
            onChange={(event) => setMessageSearch(event.target.value)}
            placeholder="搜索当前对话"
            type="search"
          />
          <button className="icon-button" type="button" aria-label="关闭消息搜索" title="关闭消息搜索" onClick={() => { setSearchOpen(false); setMessageSearch(""); }}>
            <X size={17} strokeWidth={1.8} />
          </button>
        </div>
      )}

      <div className="message-list-shell">
        <div
          className="message-list"
          ref={messageListRef}
          role="log"
          aria-label="消息列表"
          tabIndex={0}
          onWheel={() => {
            userScrollIntentUntilRef.current = performance.now() + 400;
          }}
          onPointerDown={() => {
            scrollPointerActiveRef.current = true;
          }}
          onPointerUp={() => {
            scrollPointerActiveRef.current = false;
            userScrollIntentUntilRef.current = performance.now() + 200;
          }}
          onPointerCancel={() => {
            scrollPointerActiveRef.current = false;
          }}
          onKeyDown={(event) => {
            if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
              userScrollIntentUntilRef.current = performance.now() + 400;
            }
          }}
          onScroll={(event) => {
            const element = event.currentTarget;
            if (!messageSearch && currentScrollKey) {
              const stored = conversationScrollMemory.get(currentScrollKey);
              const userInitiated = scrollPointerActiveRef.current ||
                performance.now() <= userScrollIntentUntilRef.current;
              const followLatest = distanceFromBottom(element) <= BOTTOM_PROXIMITY_PX ||
                (!userInitiated && stored?.followLatest === true);
              const memory = captureScrollMemory(
                element,
                lastVisibleMessageId,
                stored?.pendingNewCount ?? 0,
                followLatest,
              );
              conversationScrollMemory.set(currentScrollKey, memory);
              setNewMessageNotice({ key: currentScrollKey, count: memory.pendingNewCount });
            }
            if (element.scrollTop <= 64 && !messageSearch && hasOlderMessages && !historyLoading) {
              void onLoadOlder();
            }
          }}
        >
          <div className="message-list-content">
          {historyLoading && <div className="history-loading" aria-label="正在加载更早消息"><LoaderCircle className="spin" size={16} /></div>}
          {visibleMessages.length === 0 ? (
            <div className="messages-empty">没有匹配的消息</div>
          ) : (
            visibleMessageGroups.map((messageGroup, groupIndex) => {
            const firstMessage = messageGroup[0];
            const previousMessage = visibleMessageGroups[groupIndex - 1]?.[0];
            const startsNewDay = !previousMessage ||
              localDateKey(previousMessage.sentAt) !== localDateKey(firstMessage.sentAt);
            const showSenderAvatar = firstMessage.content.kind !== "service" &&
              !firstMessage.outgoing && chat.kind !== "direct";
            const sender = users.get(firstMessage.senderId);
            const senderName = sender?.displayName ??
              (chat.kind === "direct" ? chat.title : "Telegram 用户");
            const senderAvatar = sender?.avatar ??
              (chat.kind === "direct" ? chat.avatar : undefined);
            return (
              <Fragment key={firstMessage.id}>
              {startsNewDay && (
                <div className="message-day">{formatMessageDay(firstMessage.sentAt)}</div>
              )}
              <div
                className={`message-group ${firstMessage.outgoing ? "is-outgoing" : "is-incoming"}`}
              >
                {showSenderAvatar && (
                  <span className="message-group-avatar">
                    <Avatar
                      avatar={senderAvatar ?? {
                        label: Array.from(senderName.trim())[0] ?? "?",
                        color: "#73828c",
                      }}
                      size="small"
                    />
                  </span>
                )}
                <div className="message-group-stack">
                  {messageGroup.map((message, index) => (
                    <RichMessageBubble
                      key={message.id}
                      message={message}
                      sender={sender}
                      senderName={senderName}
                      groupPosition={messageGroupPosition(messageGroup, index)}
                      replyPreview={replyPreviewFor(message, messagesById, users, chat)}
                      forwardLabel={forwardLabelFor(message, users, forwardTargetsById)}
                      selectionMode={selectionMode}
                      selected={selectedMessageIds.has(message.id)}
                      selectionPending={selectionLoadingIds.has(message.id)}
                      selectionLimitReached={selectedMessageIds.size >= 100}
                      onToggleSelection={toggleMessageSelection}
                      onOpenActions={openActionMenu}
                      onDownload={onDownloadFile}
                      onRetry={onRetryMessage}
                      onCancelUpload={onCancelFileUpload}
                      onReaction={onSetMessageReaction}
                      autoplayAnimations={autoplayAnimations}
                    />
                  ))}
                </div>
              </div>
              </Fragment>
            );
            })
          )}
          </div>
        </div>
        {!messageSearch &&
          currentScrollKey &&
          newMessageNotice?.key === currentScrollKey &&
          newMessageNotice.count > 0 && (
            <button
              className="jump-to-latest"
              type="button"
              aria-label={`跳到最新消息，${newMessageNotice.count} 条新消息`}
              title="跳到最新消息"
              onClick={jumpToLatest}
            >
              <ArrowDown size={19} strokeWidth={2.1} />
              <span>{newMessageNotice.count > 99 ? "99+" : newMessageNotice.count}</span>
            </button>
          )}
      </div>

      {actionMenu && actionMessage && (
        <div
          className="message-action-menu"
          role="menu"
          aria-label="消息操作"
          style={{ left: actionMenu.left, top: actionMenu.top }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {!actionPermissions ? (
            <div className="message-action-status" role="status">
              {actionLoadingId === actionMessage.id ? (
                <><LoaderCircle className="spin" size={15} />正在读取操作权限</>
              ) : (
                <><AlertCircle size={15} />无法读取操作权限</>
              )}
            </div>
          ) : (
            <>
              <div className="message-action-reactions" role="group" aria-label="表情回应">
                {QUICK_REACTIONS.map((emoji) => {
                  const existing = actionMessage.interaction?.reactions.find(
                    (reaction) => reaction.type.kind === "emoji" && reaction.type.emoji === emoji,
                  );
                  return (
                    <button
                      type="button"
                      key={emoji}
                      aria-label={`回应 ${emoji}`}
                      className={existing?.chosen ? "is-chosen" : ""}
                      onClick={() => {
                        setActionMenu(undefined);
                        void onSetMessageReaction(actionMessage.id, emoji, !existing?.chosen);
                      }}
                    >
                      {emoji}
                    </button>
                  );
                })}
              </div>
              {actionPermissions.canReply && (
                <button type="button" role="menuitem" onClick={() => startReply(actionMessage)}>
                  <Reply size={16} strokeWidth={1.9} />
                  <span>回复</span>
                </button>
              )}
              {actionPermissions.canEdit && actionMessage.content.kind === "text" && (
                <button type="button" role="menuitem" onClick={() => startEditing(actionMessage)}>
                  <Edit3 size={16} strokeWidth={1.9} />
                  <span>编辑</span>
                </button>
              )}
              {actionPermissions.canForward && (
                <button type="button" role="menuitem" onClick={() => startForwardSelection(actionMessage)}>
                  <Forward size={16} strokeWidth={1.9} />
                  <span>转发</span>
                </button>
              )}
              {(actionPermissions.canDeleteOnlyForSelf ||
                actionPermissions.canDeleteForAllUsers) && (
                <button
                  className="is-danger"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setDeleteTarget(actionMessage);
                    setActionMenu(undefined);
                  }}
                >
                  <Trash2 size={16} strokeWidth={1.9} />
                  <span>删除</span>
                </button>
              )}
            </>
          )}
        </div>
      )}

      {selectionMode ? (
        <div className="message-selection-bar">
          <span>{selectedMessageIds.size} 条消息</span>
          <button
            className="selection-forward-button"
            type="button"
            onClick={() => setForwardDialogOpen(true)}
          >
            <Forward size={18} strokeWidth={1.9} />
            转发
          </button>
        </div>
      ) : (
      <div className="composer-wrap">
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) await sendAttachment(file);
            event.target.value = "";
          }}
        />
        {composerContextMessage && (
          <div className={`composer-context ${editingMessage ? "is-editing" : "is-replying"}`}>
            <span className="composer-context-icon">
              {editingMessage
                ? <Edit3 size={18} strokeWidth={1.9} />
                : <Reply size={18} strokeWidth={1.9} />}
            </span>
            <span className="composer-context-copy">
              <strong>{composerContextTitle}</strong>
              <small>{messageSummary(composerContextMessage.content)}</small>
            </span>
            <button
              className="icon-button"
              type="button"
              aria-label={editingMessage ? "取消编辑" : "取消回复"}
              title={editingMessage ? "取消编辑" : "取消回复"}
              onClick={editingMessage ? cancelEditing : cancelReply}
            >
              <X size={17} strokeWidth={1.9} />
            </button>
          </div>
        )}
        <div className={`composer ${editingMessage ? "is-editing" : ""}`}>
          <button className="icon-button" type="button" aria-label="表情" title="表情" disabled={Boolean(editingMessage)}>
            <Smile size={21} strokeWidth={1.8} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="添加附件"
            title={composerContextMessage ? "完成当前消息操作后添加附件" : attachmentPending ? "正在选择文件" : "添加附件"}
            disabled={Boolean(composerContextMessage) || attachmentPending}
            onClick={() => {
              if (transportKind === "tauri") void sendAttachment();
              else fileInputRef.current?.click();
            }}
          >
            {attachmentPending
              ? <LoaderCircle className="spin" size={19} strokeWidth={1.8} />
              : <Paperclip size={20} strokeWidth={1.8} />}
          </button>
          <textarea
            ref={composerInputRef}
            value={draft}
            onChange={(event) => {
              const value = event.target.value;
              setDraft(value);
              if (!editingMessage) {
                onDraftChange(
                  chat.id,
                  value,
                  replyingTo?.id ?? chatDraft?.replyToMessageId,
                );
              }
            }}
            onKeyDown={async (event) => {
              const submitWithKeyboard = event.key === "Enter" && (
                (sendOnEnter && !event.shiftKey) ||
                (!sendOnEnter && (event.ctrlKey || event.metaKey))
              );
              if (submitWithKeyboard) {
                if (event.nativeEvent.isComposing) return;
                event.preventDefault();
                await submitMessage();
              }
            }}
            rows={1}
            placeholder={editingMessage ? "编辑消息" : "写一条消息"}
            aria-label="消息内容"
            disabled={sending}
          />
          <button
            className="send-button icon-button"
            type="button"
            aria-label={editingMessage ? "保存编辑" : "发送消息"}
            title={editingMessage ? "保存编辑" : "发送消息"}
            disabled={!draft.trim() || sending}
            onClick={submitMessage}
          >
            {editingMessage
              ? <Check size={19} strokeWidth={2.2} />
              : <Send size={19} strokeWidth={2} />}
          </button>
        </div>
      </div>
      )}

      {deleteTarget && deleteTarget.permissions && (
        <div className="message-delete-backdrop" role="presentation">
          <section
            className="message-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="message-delete-title"
          >
            <div className="message-delete-heading">
              <span><Trash2 size={18} strokeWidth={1.9} /></span>
              <div>
                <h3 id="message-delete-title">删除消息</h3>
                <p>{messageSummary(deleteTarget.content)}</p>
              </div>
            </div>
            <div className="message-delete-actions">
              {deleteTarget.permissions.canDeleteOnlyForSelf && (
                <button
                  className="dialog-secondary"
                  type="button"
                  disabled={deletePending}
                  onClick={() => void confirmDelete(false)}
                >
                  仅对我删除
                </button>
              )}
              {deleteTarget.permissions.canDeleteForAllUsers && (
                <button
                  className="dialog-danger"
                  type="button"
                  disabled={deletePending}
                  onClick={() => void confirmDelete(true)}
                >
                  {deletePending ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                  为所有人删除
                </button>
              )}
              <button
                className="dialog-secondary"
                type="button"
                disabled={deletePending}
                onClick={() => setDeleteTarget(undefined)}
              >
                取消
              </button>
            </div>
          </section>
        </div>
      )}

      {forwardDialogOpen && selectionMode && (
        <div
          className="message-delete-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !forwardPending) {
              setForwardDialogOpen(false);
              setForwardQuery("");
            }
          }}
        >
          <section
            className="message-forward-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="message-forward-title"
          >
            <header className="message-forward-heading">
              <span className="message-forward-heading-icon"><Forward size={18} strokeWidth={1.9} /></span>
              <div>
                <h3 id="message-forward-title">转发 {selectedMessageIds.size} 条消息</h3>
                <p>选择目标会话</p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭转发"
                title="关闭"
                disabled={forwardPending}
                onClick={() => {
                  setForwardDialogOpen(false);
                  setForwardQuery("");
                }}
              >
                <X size={18} strokeWidth={1.9} />
              </button>
            </header>
            <label className="forward-target-search">
              <Search size={16} strokeWidth={1.8} />
              <span className="sr-only">搜索目标会话</span>
              <input
                autoFocus
                value={forwardQuery}
                onChange={(event) => setForwardQuery(event.target.value)}
                placeholder="搜索会话"
                type="search"
                disabled={forwardPending}
              />
            </label>
            <div className="forward-target-list">
              {filteredForwardTargets.length === 0 ? (
                <div className="forward-target-empty">没有匹配的会话</div>
              ) : filteredForwardTargets.map((target) => (
                <button
                  className="forward-target-row"
                  type="button"
                  key={target.id}
                  disabled={forwardPending}
                  onClick={() => void confirmForward(target)}
                >
                  <Avatar avatar={target.avatar} size="medium" />
                  <span>
                    <strong>{target.title}</strong>
                    <small>{target.id === chat.id ? "当前会话" : target.preview}</small>
                  </span>
                  {forwardPending && forwardPendingTargetId === target.id
                    ? <LoaderCircle className="spin" size={16} />
                    : <ChevronLeft className="forward-target-arrow" size={18} strokeWidth={1.8} />}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

interface ReplyPreview {
  author: string;
  text: string;
}

const senderNameForMessage = (message: Message, users: Map<string, User>, chat: Chat) => {
  if (message.outgoing) return "你";
  return users.get(message.senderId)?.displayName ??
    (chat.kind === "direct" ? chat.title : "Telegram 用户");
};

const forwardLabelFor = (
  message: Message,
  users: Map<string, User>,
  chats: Map<string, Chat>,
) => {
  const info = message.forwardInfo;
  if (!info) return undefined;
  const origin = info.origin;
  const name = origin?.kind === "user"
    ? users.get(origin.userId)?.displayName
    : origin?.kind === "hiddenUser"
      ? origin.senderName
      : origin?.kind === "chat" || origin?.kind === "channel"
        ? chats.get(origin.chatId)?.title ?? origin.authorSignature
        : undefined;
  const sourceName = info.source?.senderName ??
    (info.source?.chatId ? chats.get(info.source.chatId)?.title : undefined);
  return name ? `转发自 ${name}` : sourceName ? `转发自 ${sourceName}` : "已转发";
};

const replyPreviewFor = (
  message: Message,
  messagesById: Map<string, Message>,
  users: Map<string, User>,
  chat: Chat,
): ReplyPreview | undefined => {
  if (!message.replyTo) return undefined;
  if (message.replyTo.kind === "story") {
    return { author: "动态", text: "回复了一条动态" };
  }
  const target = message.replyTo.messageId
    ? messagesById.get(message.replyTo.messageId)
    : undefined;
  if (target) {
    return {
      author: senderNameForMessage(target, users, chat),
      text: messageSummary(target.content),
    };
  }
  const origin = message.replyTo.origin;
  const author = origin?.kind === "user"
    ? users.get(origin.userId)?.displayName
    : origin?.kind === "hiddenUser"
      ? origin.senderName
      : origin?.kind === "chat" || origin?.kind === "channel"
        ? origin.authorSignature
        : undefined;
  return {
    author: author || "回复消息",
    text: message.replyTo.quote ||
      (message.replyTo.content ? messageSummary(message.replyTo.content) : "原消息不可用"),
  };
};

const messageSummary = (content: MessageContent) => {
  const raw = content.kind === "text" || content.kind === "service"
    ? content.text
    : content.caption || content.fileName;
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 72)}…` : normalized;
};
