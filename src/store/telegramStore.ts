import { messageCanBeSaved, messageExpired } from "../telegram/messageLifecycle";
import { canPostToChannel } from "../telegram/chatManagement";
import { initializeAccountMetadata, flushAccountMetadata } from "./accountMetadata";
import { removeAccountLocalBlocks } from "./localUserBlocks";
import { removeAccountActivity } from "./conversationActivity";
import { removeAccountDownloads } from "../utils/downloadManager";
import { translate } from "../i18n";
import { isCaptionContent } from "../telegram/messageContent";
import { bindRetainedMessageFile, retainedMessageQuote, retainHydratedContent, updateRetainedMessageFile } from "../telegram/retainedMessages";
import { senderNameForMessage } from "../components/conversationMessages";
import { RetainedMessageIndex } from "./retainedMessageIndex";
import { RetainedMediaRestorer } from "./retainedMediaRestorer";
import { SyncRetryQueue } from "../telegram/syncRetryQueue";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { createTelegramTransport } from "../telegram/createTransport";
import type { TelegramTransport } from "../telegram/transport";
import type {
  CachedTelegramSnapshot,
  ChatManagement,
  ChatManagementCapabilities,
  ChatDraft,
  ForwardMessagesResult,
  Message,
  MessagePermissions,
  QueuedOutgoingMessage,
  TelegramEvent,
  TelegramAccountState,
  User,
} from "../telegram/types";
import { connectionPresentation } from "../telegram/connectionState";
import {
  accountStatePatch,
  currentAccountRegistration,
  preserveUserAvatarMedia,
  shouldDiscardUnregisteredAccount,
} from "./telegramStore.accounts";
import { cachedSnapshotFrom, migrateCachedSnapshot, migrateLocalUnsentState } from "./telegramStore.cache";
import {
  DRAFT_SYNC_DELAY_MS,
  DraftSyncController,
  draftForSync,
  draftSignature,
} from "./telegramStore.drafts";
import {
  messageMapFrom,
  pendingCachedIdsAfterConfirmation,
  reachedCachedHistoryBoundary,
  replaceMessage,
  upsertMessage,
  upsertMessages,
  withEmojiReaction,
} from "./telegramStore.messages";
import { messagesWithOutbox, outboxItemId } from "./telegramStore.outbox";
import {
  compareChats,
  filterAndSortChats,
  isChatPinnedInFolder,
} from "./telegramStore.selectors";
import type {
  MessageChangeEvent,
  MessageChangeListener,
  TelegramState,
} from "./telegramStore.types";
import {
  getActiveConversationTraceId,
  logPerformance,
  markConversationSwitch,
} from "../utils/performanceMonitor";
import { markMessageEntrance, transferMessageEntrance } from "../utils/messageEntrance";
import { trimComposerFormattedText } from "../utils/composerMentions";
import { protectedCachePaths } from "./cacheProtection";
import { emptyGlobalSearch } from "./globalSearchState";
import { emptyChatMessageSearch } from "./chatMessageSearchState";
import { emptyProfileState } from "./profileState";
import { createSearchController } from "./telegramStore.search";
import { createProfileController } from "./telegramStore.profile";
import { createOutboxController } from "./telegramStore.outboxController";
import { createForumController } from "./telegramStore.forum";
import { createSessionController } from "./telegramStore.session";
import { createEmojiPickerController } from "./telegramStore.emoji";
import { SharedMediaIndex } from "./sharedMediaIndex";
import {
  attachmentOutbox,
  describeOutgoingAttachments,
} from "./attachmentOutbox";
import { inspectOutgoingAttachment } from "../media/outgoingAttachments";
import { recordConversationSentMessages } from "./conversationActivity";
import { localUserBlocksStore } from "./localUserBlocks";
import { messageHasUnreadLocalBlockedReaction } from "../utils/localBlockedReactions";
import { preferencesStore } from "./preferencesStore";

export type {
  ChatFilter,
  ChatListState,
  HistoryState,
  MessageChangeEvent,
  MessageChangeListener,
  RuntimePhase,
  TelegramState,
} from "./telegramStore.types";
export { filterAndSortChats, selectVisibleChats } from "./telegramStore.selectors";

const CACHE_WRITE_DELAY_MS = 10_000;
const CACHE_WRITE_MAX_DELAY_MS = 60_000;
const CACHE_WRITE_IDLE_TIMEOUT_MS = 1_500;

const normalizedUsername = (user?: Pick<User, "username">) =>
  user?.username?.trim().replace(/^@/, "").toLocaleLowerCase() || undefined;

const usernameIndexForUsers = (users: Iterable<User>) => {
  const index = new Map<string, string>();
  for (const user of users) {
    const username = normalizedUsername(user);
    if (username) index.set(username, user.id);
  }
  return index;
};

type ChatManagementCapabilityKey = keyof Pick<ChatManagementCapabilities,
  | "canOpenManagement"
  | "canAddMembers"
  | "canPromoteMembers"
  | "canRestrictMembers"
  | "canManagePermissions"
  | "canManageSlowMode"
  | "canTransferOwnership"
  | "canManageInvites"
  | "canManageAllInvites"
  | "canViewEventLog"
  | "canChangeInfo"
  | "canManageTags"
>;
const FORUM_TOPICS_REFRESH_TTL_MS = 10_000;
const FORUM_TOPICS_CHANGE_COALESCE_MS = 500;

const errorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
};

const topicKey = (chatId: string, topicId?: string) => topicId ? `${chatId}:topic:${topicId}` : chatId;

const diagnosticChatHash = (chatId: string) => {
  // FNV-1a keeps diagnostics correlatable without persisting a chat identifier.
  let hash = 2_166_136_261;
  for (let index = 0; index < chatId.length; index += 1) {
    hash ^= chatId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

const unreadCountBucket = (count: number) =>
  count <= 0 ? 0 : count < 10 ? 1 : count < 100 ? 2 : count < 1_000 ? 3 : 4;

const canArchiveDeletedMessage = (message: Message | undefined) => Boolean(
  message && !message.outgoing && !message.isLocallyDeleted && messageCanBeSaved(message),
);

const archiveMediaFileId = (message: Message) =>
  !message.outgoing &&
  message.content.kind === "media" &&
  (message.content.mediaType === "photo" || message.content.mediaType === "sticker") &&
  message.content.fileId !== undefined &&
  message.content.canDownload !== false
    ? message.content.fileId
    : undefined;

const migrateMessageChatId = (message: Message, fromChatId: string, toChatId: string): Message => {
  const replyTo = message.replyTo?.kind === "message"
    ? {
        ...message.replyTo,
        ...(message.replyTo.chatId === fromChatId ? { chatId: toChatId } : {}),
        origin: message.replyTo.origin && (message.replyTo.origin.kind === "chat" || message.replyTo.origin.kind === "channel")
          ? {
              ...message.replyTo.origin,
              ...(message.replyTo.origin.chatId === fromChatId ? { chatId: toChatId } : {}),
            }
          : message.replyTo.origin,
      }
    : message.replyTo?.kind === "story" && message.replyTo.chatId === fromChatId
      ? { ...message.replyTo, chatId: toChatId }
      : message.replyTo;
  const forwardInfo = message.forwardInfo
    ? {
        ...message.forwardInfo,
        origin: message.forwardInfo.origin && (message.forwardInfo.origin.kind === "chat" || message.forwardInfo.origin.kind === "channel")
          ? {
              ...message.forwardInfo.origin,
              ...(message.forwardInfo.origin.chatId === fromChatId ? { chatId: toChatId } : {}),
            }
          : message.forwardInfo.origin,
        source: message.forwardInfo.source
          ? {
              ...message.forwardInfo.source,
              ...(message.forwardInfo.source.chatId === fromChatId ? { chatId: toChatId } : {}),
            }
          : message.forwardInfo.source,
      }
    : message.forwardInfo;
  return {
    ...message,
    chatId: toChatId,
    replyTo,
    forwardInfo,
  };
};

const migrateChatKey = (key: string, fromChatId: string, toChatId: string) =>
  key === fromChatId
    ? toChatId
    : key.startsWith(`${fromChatId}:topic:`)
      ? `${toChatId}${key.slice(fromChatId.length)}`
      : key;

const reloadCurrentApplication = () => {
  if (typeof window === "undefined") return;
  if (isTauri()) {
    void emit("notgram://reload-application").catch(() => window.location.reload());
    return;
  }
  window.location.reload();
};

export const createTelegramStore = (
  transport: TelegramTransport,
  reloadApplication: () => void = reloadCurrentApplication,
) =>
  createStore<TelegramState>((set, get) => {
    const sharedMediaIndex = new SharedMediaIndex();
    let cacheTimer: ReturnType<typeof setTimeout> | undefined;
    let cacheIdleCallback: number | undefined;
    let cacheDirtySince: number | undefined;
    let cacheWrite = Promise.resolve();
    const cachedMessageIds = new Map<string, Set<string>>();
    const rememberCachedMessage = (message: Message, isForum = get().chats.get(message.chatId)?.isForum) => {
      if (message.isLocallyDeleted || message.isPending || message.delivery === "sending" || message.delivery === "failed") return;
      const key = topicKey(message.chatId, isForum ? message.topicId : undefined);
      const ids = cachedMessageIds.get(key) ?? new Set<string>();
      ids.add(message.id);
      cachedMessageIds.set(key, ids);
    };
    let accountTransition = false;
    let accountGeneration = 0;
    let syncGeneration = 0;
    let hasConnected = false;
    const syncRetries = new SyncRetryQueue(() =>
      get().authorization.kind === "ready" && get().connectionStatus === "online");
    // Conversation work has a shorter lifetime than the authenticated account.
    // Keep it separate so a fast chat switch can retire pending navigation work
    // without tearing down the whole TDLib session.
    let conversationGeneration = 0;
    const historyLoadPromises = new Map<string, Promise<void>>();
    const cacheBoundaryPromises = new Map<string, Promise<void>>();
    const advanceConversationGeneration = () => {
      conversationGeneration += 1;
      return conversationGeneration;
    };
    let registeredAccountKey: string | undefined;
    let accountRegistration = Promise.resolve();
    const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const readRequestChains = new Map<string, Promise<void>>();
    const forumTopicsRefreshedAt = new Map<string, number>();
    const groupManagementLoads = new Map<string, Promise<ChatManagement | undefined>>();
    const chatAdministratorLabelLoads = new Map<string, Promise<Record<string, string>>>();
    let chatAdministratorLabelsGeneration = 0;
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const localAttachmentDraftGenerations = new Map<string, number>();
    const liveAttentionCandidates = new Set<string>();
    // Visibility observers can fire repeatedly before TDLib publishes the mention-read update.
    const attentionReadRequests = new Set<string>();
    const acknowledgedAttentionMessages = new Set<string>();
    const seenReactionMessageIds = new Map<string, Set<string>>();
    const reactionAttentionLoads = new Map<string, Promise<void>>();
    const reactionReadRequests = new Set<string>();
    const blockedReactionReadRequests = new Set<string>();
    let attentionReadGeneration = 0;
    const messageChangeListeners = new Set<MessageChangeListener>();
    const retainedMessages = new RetainedMessageIndex();
    const publishMessageChange = (event: MessageChangeEvent) => {
      if (event.type === "reset") retainedMessages.reset(event.messages);
      else if (event.type === "remove") retainedMessages.remove(event.chatId, event.messageIds);
      else if (event.type === "replace") {
        retainedMessages.remove(event.message.chatId, [event.oldMessageId]);
        retainedMessages.upsert([event.message]);
      } else {
        // Match upsertMessages: late live snapshots cannot overwrite retained copies,
        // including in downstream incremental indexes.
        event = {
          ...event,
          messages: event.messages.map(message => message.isLocallyDeleted ? message
            : retainedMessages.get(message.chatId, message.id) ?? message),
          liveMessages: event.liveMessages.filter(message => !message.isLocallyDeleted &&
            !retainedMessages.get(message.chatId, message.id)),
        };
        retainedMessages.upsert(event.messages);
      }
      for (const listener of messageChangeListeners) listener(event);
    };
    const messageLocation = (messageId: string, preferredChatId?: string) => {
      if (preferredChatId) {
        const preferredMessages = get().messages.get(preferredChatId) ?? [];
        const preferredMessage = preferredMessages.find((message) => message.id === messageId);
        if (preferredMessage) {
          return {
            chatId: preferredChatId,
            messages: preferredMessages,
            message: preferredMessage,
          };
        }
      }
      for (const [chatId, messages] of get().messages) {
        const message = messages.find((candidate) => candidate.id === messageId);
        if (message) return { chatId, messages, message };
      }
      return undefined;
    };
    const managementCapabilitiesFor = (chatId: string) => {
      const loaded = get().groupManagement;
      return loaded?.chatId === chatId
        ? loaded.capabilities
        : get().chats.get(chatId)?.management;
    };
    const requireManagementCapability = (
      chatId: string,
      capability: ChatManagementCapabilityKey,
      message: string,
    ) => {
      if (managementCapabilitiesFor(chatId)?.[capability] === true) return true;
      set({ operationError: message });
      return false;
    };
    const deleteScopeAllowed = (permissions: MessagePermissions, revoke: boolean) => revoke
      ? permissions.canDeleteForAllUsers
      : permissions.canDeleteOnlyForSelf;
    const verifyDeleteScope = async (chatId: string, messageIds: string[], revoke: boolean) => {
      const permissions = await Promise.all(
        messageIds.map((messageId) => transport.getMessageProperties(chatId, messageId)),
      );
      if (permissions.every((value) => deleteScopeAllowed(value, revoke))) return true;
      set({
        operationError: revoke
          ? translate("部分消息当前不能为所有人删除")
          : translate("部分消息当前不能仅对你删除"),
      });
      return false;
    };
    const verifyPinPermission = async (chatId: string, messageId: string) => {
      try {
        const permissions = await transport.getMessageProperties(chatId, messageId);
        if (permissions.canPin === true) return true;
      } catch (error) {
        set({ operationError: errorMessage(error, translate("无法读取置顶权限")) });
        return false;
      }
      set({ operationError: translate("当前账号没有置顶消息的权限") });
      return false;
    };
    const pinOperationError = (error: unknown, fallback: string) => {
      const detail = error instanceof Error ? error.message : String(error ?? "");
      return /CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN|not enough rights/i.test(detail)
        ? translate("当前账号没有置顶消息的权限")
        : errorMessage(error, fallback);
    };
    const messageEventKey = (message: Message) => `${message.chatId}:${message.id}`;
    const messageHasPrimaryAttention = (message: Message) => {
      if (message.containsUnreadMention === true) return true;
      const reply = message.replyTo?.kind === "message" ? message.replyTo : undefined;
      if (!reply) return false;
      const replyChatId = reply.chatId ?? message.chatId;
      const repliedMessage = reply.messageId
        ? get().messages.get(replyChatId)?.find((candidate) => candidate.id === reply.messageId)
        : undefined;
      return reply.outgoing === true || repliedMessage?.outgoing === true;
    };
    const removeUnreadAttention = (chatId: string, messageIds: Iterable<string>) => {
      const removedIds = new Set(messageIds);
      if (removedIds.size === 0) return;
      const unreadAttentionMessageIds = new Map(get().unreadAttentionMessageIds);
      const remaining = (unreadAttentionMessageIds.get(chatId) ?? [])
        .filter((messageId) => !removedIds.has(messageId));
      if (remaining.length > 0) unreadAttentionMessageIds.set(chatId, remaining);
      else unreadAttentionMessageIds.delete(chatId);
      set({ unreadAttentionMessageIds });
    };
    const addUnreadReactionAttention = (messages: Message[]) => {
      const unreadAttentionMessageIds = new Map(get().unreadAttentionMessageIds);
      let changed = false;
      for (const message of messages) {
        if (message.containsUnreadReaction !== true) continue;
        const current = unreadAttentionMessageIds.get(message.chatId) ?? [];
        if (current.includes(message.id)) continue;
        unreadAttentionMessageIds.set(message.chatId, [...current, message.id]);
        changed = true;
      }
      if (changed) set({ unreadAttentionMessageIds });
    };
    const clearUnreadReactionAttention = (chatId: string) => {
      const currentMessages = get().messages.get(chatId) ?? [];
      const reactionIds = currentMessages
        .filter((message) => message.containsUnreadReaction === true)
        .map((message) => message.id);
      if (reactionIds.length === 0) return;
      const messages = new Map(get().messages);
      messages.set(chatId, currentMessages.map((message) => message.containsUnreadReaction === true
        ? { ...message, containsUnreadReaction: false }
        : message));
      set({ messages });
      const removableIds = reactionIds.filter((messageId) => {
        const message = messages.get(chatId)?.find((candidate) => candidate.id === messageId);
        return !message ||
          acknowledgedAttentionMessages.has(`${chatId}:${messageId}`) ||
          !messageHasPrimaryAttention(message);
      });
      removeUnreadAttention(chatId, removableIds);
      seenReactionMessageIds.delete(chatId);
    };
    const localBlockedReactionUserIds = () => new Set(
      localUserBlocksStore.getState().users
        .filter((user) => user.accountId === get().activeAccountId)
        .map((user) => user.userId),
    );
    const clearChatReactionUnreadState = (chatId: string) => {
      clearUnreadReactionAttention(chatId);
      const chats = new Map(get().chats);
      const chat = chats.get(chatId);
      if (chat && (chat.unreadReactionCount ?? 0) > 0) {
        chats.set(chatId, { ...chat, unreadReactionCount: 0 });
      }
      const forumTopics = new Map(get().forumTopics);
      if (forumTopics.has(chatId)) {
        forumTopics.set(chatId, (forumTopics.get(chatId) ?? []).map((topic) => ({
          ...topic,
          unreadReactionCount: 0,
        })));
      }
      set({ chats, forumTopics });
    };
    const markBlockedChatReactionsRead = (chatId: string): Promise<void> => {
      if (
        get().authorization.kind !== "ready" ||
        blockedReactionReadRequests.has(chatId) ||
        reactionReadRequests.has(chatId)
      ) return Promise.resolve();
      const requestGeneration = attentionReadGeneration;
      blockedReactionReadRequests.add(chatId);
      reactionReadRequests.add(chatId);
      return transport.markAllChatReactionsRead(chatId)
        .then(() => {
          if (requestGeneration !== attentionReadGeneration) return;
          clearChatReactionUnreadState(chatId);
          set({ operationError: undefined });
          scheduleCacheWrite();
        })
        .catch((error) => {
          if (requestGeneration !== attentionReadGeneration) return;
          set({ operationError: errorMessage(error, translate("无法更新屏蔽回应的已读状态")) });
        })
        .finally(() => {
          if (requestGeneration !== attentionReadGeneration) return;
          blockedReactionReadRequests.delete(chatId);
          reactionReadRequests.delete(chatId);
        });
    };
    const queueBlockedReactionReads = (messages: readonly Message[]) => {
      const blockedSenderIds = localBlockedReactionUserIds();
      if (blockedSenderIds.size === 0) return;
      for (const message of messages) {
        if (messageHasUnreadLocalBlockedReaction(message, blockedSenderIds)) {
          void markBlockedChatReactionsRead(message.chatId);
        }
      }
    };
    const reconcileMessageAttention = (
      message: Message,
      previous: Message | undefined,
      live: boolean,
    ) => {
      const key = messageEventKey(message);
      const hasUnreadReaction = message.containsUnreadReaction === true;
      const needsAttention = hasUnreadReaction || messageHasPrimaryAttention(message);
      if (
        previous && (
          previous.containsUnreadMention !== message.containsUnreadMention ||
          previous.containsUnreadReaction !== message.containsUnreadReaction
        )
      ) {
        acknowledgedAttentionMessages.delete(key);
      }
      const previouslyNeededAttention = previous && (
        previous.containsUnreadReaction === true || messageHasPrimaryAttention(previous)
      );
      if (previouslyNeededAttention && !needsAttention) {
        removeUnreadAttention(message.chatId, [message.id]);
      }
      if (previous?.containsUnreadReaction === true && !hasUnreadReaction) {
        seenReactionMessageIds.get(message.chatId)?.delete(message.id);
      }
      if (message.outgoing && !hasUnreadReaction) {
        liveAttentionCandidates.delete(key);
        return;
      }
      if (live || hasUnreadReaction) {
        liveAttentionCandidates.add(key);
        if (liveAttentionCandidates.size > 512) {
          liveAttentionCandidates.delete(liveAttentionCandidates.values().next().value!);
        }
      }
      if (!liveAttentionCandidates.has(key)) return;

      const reply = message.replyTo?.kind === "message" ? message.replyTo : undefined;
      const repliedMessage = reply?.messageId
        ? get().messages.get(reply.chatId ?? message.chatId)?.find((candidate) => candidate.id === reply.messageId)
        : undefined;
      const replyResolved = !reply || reply.outgoing !== undefined || repliedMessage !== undefined;
      if (!needsAttention && !replyResolved) return;

      liveAttentionCandidates.delete(key);
      if (!needsAttention) return;
      const unreadAttentionMessageIds = new Map(get().unreadAttentionMessageIds);
      const current = unreadAttentionMessageIds.get(message.chatId) ?? [];
      if (current.includes(message.id)) return;
      unreadAttentionMessageIds.set(message.chatId, [...current, message.id]);
      set({ unreadAttentionMessageIds });
    };
    const expectedUnreadReactionCount = (chatId: string) => Math.max(
      get().chats.get(chatId)?.unreadReactionCount ?? 0,
      (get().forumTopics.get(chatId) ?? []).reduce(
        (total, topic) => total + topic.unreadReactionCount,
        0,
      ),
    );
    const refreshUnreadReactionAttention = (chatId: string) => {
      if (
        get().authorization.kind !== "ready" ||
        get().connectionStatus !== "online" ||
        expectedUnreadReactionCount(chatId) <= 0
      ) return Promise.resolve();
      const existing = reactionAttentionLoads.get(chatId);
      if (existing) return existing;
      const generation = accountGeneration;
      const expectedCount = expectedUnreadReactionCount(chatId);
      const request = (async () => {
        const found: Message[] = [];
        let fromMessageId: string | undefined;
        const maximumPages = Math.min(100, Math.max(1, Math.ceil(expectedCount / 100) + 1));
        for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
          const page = await transport.searchChatMessages({
            chatId,
            filter: "unreadReaction",
            fromMessageId,
            limit: 100,
          });
          found.push(...page.messages);
          if (
            found.length >= expectedCount ||
            !page.hasMore ||
            !page.nextFromMessageId ||
            page.nextFromMessageId === fromMessageId
          ) break;
          fromMessageId = page.nextFromMessageId;
        }
        if (
          generation !== accountGeneration ||
          !get().chats.has(chatId) ||
          expectedUnreadReactionCount(chatId) <= 0 ||
          found.length === 0
        ) return;
        const messages = new Map(get().messages);
        messages.set(chatId, upsertMessages(messages.get(chatId) ?? [], found));
        set({ messages });
        queueBlockedReactionReads(found);
        addUnreadReactionAttention(found);
        publishMessageChange({ type: "upsert", messages: found, liveMessages: [] });
      })()
        .catch((error) => {
          if (generation === accountGeneration) {
            set({ operationError: errorMessage(error, translate("无法恢复未读回应")) });
          }
        })
        .finally(() => {
          if (reactionAttentionLoads.get(chatId) === request) {
            reactionAttentionLoads.delete(chatId);
          }
        });
      reactionAttentionLoads.set(chatId, request);
      return request;
    };
    const markSeenChatReactionsRead = (chatId: string, visibleMessageIds: string[]) => {
      const chatMessages = get().messages.get(chatId) ?? [];
      const knownReactionMessageIds = chatMessages
        .filter((message) => message.containsUnreadReaction === true)
        .map((message) => message.id);
      const visibleReactionIds = new Set(visibleMessageIds.filter((messageId) =>
        knownReactionMessageIds.includes(messageId),
      ));
      if (visibleReactionIds.size === 0) return;
      const seen = new Set(seenReactionMessageIds.get(chatId) ?? []);
      for (const messageId of visibleReactionIds) seen.add(messageId);
      seenReactionMessageIds.set(chatId, seen);
      const expectedCount = expectedUnreadReactionCount(chatId);
      if (
        reactionReadRequests.has(chatId) ||
        expectedCount <= 0 ||
        knownReactionMessageIds.length === 0 ||
        knownReactionMessageIds.length < expectedCount ||
        knownReactionMessageIds.some((messageId) => !seen.has(messageId))
      ) {
        if (knownReactionMessageIds.length < expectedCount) {
          void refreshUnreadReactionAttention(chatId);
        }
        return;
      }
      const requestGeneration = attentionReadGeneration;
      reactionReadRequests.add(chatId);
      void transport.markAllChatReactionsRead(chatId)
        .then(() => {
          if (requestGeneration !== attentionReadGeneration) return;
          clearUnreadReactionAttention(chatId);
          const chats = new Map(get().chats);
          const chat = chats.get(chatId);
          if (chat) chats.set(chatId, { ...chat, unreadReactionCount: 0 });
          const forumTopics = new Map(get().forumTopics);
          if (forumTopics.has(chatId)) {
            forumTopics.set(chatId, (forumTopics.get(chatId) ?? []).map((topic) => ({
              ...topic,
              unreadReactionCount: 0,
            })));
          }
          set({ chats, forumTopics, operationError: undefined });
          scheduleCacheWrite();
        })
        .catch((error) => {
          if (requestGeneration !== attentionReadGeneration) return;
          set({ operationError: errorMessage(error, translate("无法更新回应已读状态")) });
        })
        .finally(() => {
          if (requestGeneration !== attentionReadGeneration) return;
          reactionReadRequests.delete(chatId);
        });
    };
    let expiryMessages: TelegramState["messages"] | undefined;
    let expiryChats: TelegramState["chats"] | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleMessageExpiry = () => {
      if (expiryMessages === get().messages && expiryChats === get().chats) return;
      expiryMessages = get().messages; expiryChats = get().chats;
      if (expiryTimer) globalThis.clearTimeout(expiryTimer);
      let earliest = Infinity;
      for (const messages of get().messages.values()) {
        for (const message of messages) if (message.expiresAt) earliest = Math.min(earliest, Date.parse(message.expiresAt));
      }
      for (const chat of get().chats.values()) if (chat.previewExpiresAt) earliest = Math.min(earliest, Date.parse(chat.previewExpiresAt));
      if (!Number.isFinite(earliest)) return;
      expiryTimer = globalThis.setTimeout(() => {
        expiryTimer = undefined;
        expiryMessages = undefined; expiryChats = undefined;
        for (const [chatId, messages] of get().messages) {
          for (const message of messages) if (messageExpired(message)) removeMessageImmediately(chatId, message.id);
        }
        const chats = new Map(get().chats);
        for (const [id, chat] of chats) if (chat.previewExpiresAt && Date.parse(chat.previewExpiresAt) <= Date.now()) {
          chats.set(id, { ...chat, preview: "", previewSenderId: undefined, previewExpiresAt: undefined });
        }
        set({ chats });
        scheduleMessageExpiry();
      }, Math.min(60_000, Math.max(0, earliest - Date.now())));
    };

    const markMessageRemoving = (chatId: string, messageId: string) => {
      const key = `${chatId}:${messageId}`;
      const previous = removalTimers.get(key);
      const messages = new Map(get().messages);
      const current = messages.get(chatId) ?? [];
      const removed = current.find((message) => message.id === messageId);
      if (!removed) return;
      if (previous) globalThis.clearTimeout(previous);
      removalTimers.delete(key);
      messages.set(chatId, current.filter((message) => message.id !== messageId));
      const removingMessages = new Map(get().removingMessages);
      const ghosts = removingMessages.get(chatId) ?? [];
      removingMessages.set(chatId, [...ghosts.filter((message) => message.id !== messageId), { ...removed, isRemoving: true }]);
      set({ messages, removingMessages });
      publishMessageChange({ type: "remove", chatId, messageIds: [messageId] });
      removalTimers.set(key, globalThis.setTimeout(() => {
        removalTimers.delete(key);
        const nextRemoving = new Map(get().removingMessages);
        nextRemoving.set(chatId, (nextRemoving.get(chatId) ?? []).filter((message) => message.id !== messageId));
        sharedMediaIndex.remove(chatId, [messageId]);
        set({ removingMessages: nextRemoving });
        scheduleCacheWrite();
      }, 180));
    };
    const removeMessageImmediately = (chatId: string, messageId: string) => {
      const key = `${chatId}:${messageId}`;
      const previous = removalTimers.get(key);
      if (previous) globalThis.clearTimeout(previous);
      removalTimers.delete(key);

      const messages = new Map(get().messages);
      messages.set(chatId, (messages.get(chatId) ?? []).filter((message) => message.id !== messageId));
      const removingMessages = new Map(get().removingMessages);
      const ghosts = (removingMessages.get(chatId) ?? []).filter((message) => message.id !== messageId);
      if (ghosts.length > 0) removingMessages.set(chatId, ghosts);
      else removingMessages.delete(chatId);
      sharedMediaIndex.remove(chatId, [messageId]);
      set({ messages, removingMessages });
      publishMessageChange({ type: "remove", chatId, messageIds: [messageId] });
    };

    const setTypingUser = (chatId: string, senderId: string, typing: boolean) => {
      const key = `${chatId}:${senderId}`;
      const previousTimer = typingTimers.get(key);
      if (previousTimer) globalThis.clearTimeout(previousTimer);
      typingTimers.delete(key);

      const currentIds = get().typingUserIds.get(chatId) ?? [];
      const hasSender = currentIds.includes(senderId);
      if (typing && !hasSender) {
        const typingUserIds = new Map(get().typingUserIds);
        typingUserIds.set(chatId, [...currentIds, senderId]);
        set({ typingUserIds });
      } else if (!typing && hasSender) {
        const typingUserIds = new Map(get().typingUserIds);
        const nextIds = currentIds.filter((id) => id !== senderId);
        if (nextIds.length > 0) typingUserIds.set(chatId, nextIds);
        else typingUserIds.delete(chatId);
        set({ typingUserIds });
      }

      if (typing) {
        typingTimers.set(key, globalThis.setTimeout(() => {
          typingTimers.delete(key);
          setTypingUser(chatId, senderId, false);
        }, 6_000));
      }
    };

    const clearTypingUsers = () => {
      for (const timer of typingTimers.values()) globalThis.clearTimeout(timer);
      typingTimers.clear();
    };

    const cancelPendingCacheCallback = () => {
      if (cacheTimer) globalThis.clearTimeout(cacheTimer);
      cacheTimer = undefined;
      if (cacheIdleCallback !== undefined && typeof globalThis.cancelIdleCallback === "function") {
        globalThis.cancelIdleCallback(cacheIdleCallback);
      }
      cacheIdleCallback = undefined;
    };

    const cancelScheduledCacheWrite = () => {
      cancelPendingCacheCallback();
      cacheDirtySince = undefined;
    };

    let localSaveTimer: ReturnType<typeof setTimeout> | undefined;
    let savedLocalReferences: unknown[] = [];
    const flushUnsentState = async () => {
      if (localSaveTimer) globalThis.clearTimeout(localSaveTimer);
      localSaveTimer = undefined;
      if (!transport.saveLocalState) return flushCachedSnapshot();
      const state = get();
      if (!state.currentUserId) return;
      const accountId = state.activeAccountId;
      const value = {
        currentUserId: state.currentUserId,
        savedAt: new Date().toISOString(),
        drafts: [...state.drafts.values()],
        localAttachmentDrafts: [...state.localAttachmentDrafts.values()],
        outbox: state.outbox,
      };
      const operation = cacheWrite.catch(() => undefined).then(() => transport.saveLocalState!(accountId, value));
      cacheWrite = operation;
      await operation;
    };

    const boundInactiveHistory = () => {
      const current = get();
      let total = [...current.messages.values()].reduce(
        (sum, items) => sum + items.filter((message) => !message.isLocallyDeleted).length,
        0,
      );
      if (total <= 10_000 && current.messages.size <= 100) return;
      const messages = new Map(current.messages);
      const histories = new Map(current.histories);
      const protectedChats = new Set(current.outbox.map((item) => item.chatId));
      for (const [chatId, items] of messages) {
        if (total <= 10_000 && messages.size <= 100) break;
        if (
          current.chats.get(chatId)?.isForum ||
          chatId === current.activeChatId ||
          protectedChats.has(chatId) ||
          histories.get(chatId)?.loading ||
          items.some((message) => message.isLocallyDeleted)
        ) continue;
        if (items.some((message) => message.delivery === "sending")) continue;
        total -= items.filter((message) => !message.isLocallyDeleted).length;
        messages.delete(chatId); histories.delete(chatId); cachedMessageIds.delete(chatId);
        transport.discardChatHistoryCache?.(chatId);
      }
      if (messages.size !== current.messages.size) set({ messages, histories });
    };
    const scheduleCacheWrite = () => {
      boundInactiveHistory();
      const state = get();
      if (state.authorization.kind !== "ready" || !state.currentUserId) return;
      scheduleMessageExpiry();
      const references = [state.drafts, state.localAttachmentDrafts, state.outbox];
      if (transport.saveLocalState && references.some((value, index) => value !== savedLocalReferences[index])) {
        savedLocalReferences = references;
        if (localSaveTimer) globalThis.clearTimeout(localSaveTimer);
        localSaveTimer = globalThis.setTimeout(() => {
          void flushUnsentState().catch(() => set({
            cacheHealth: "invalid",
            operationError: translate("无法保存附件草稿"),
          }));
        }, 500);
      }
      const now = Date.now();
      cacheDirtySince ??= now;
      const deadline = cacheDirtySince + CACHE_WRITE_MAX_DELAY_MS;
      if ((cacheTimer || cacheIdleCallback !== undefined) && now >= deadline) return;
      cancelPendingCacheCallback();
      const delay = Math.max(0, Math.min(CACHE_WRITE_DELAY_MS, deadline - now));
      cacheTimer = globalThis.setTimeout(() => {
        cacheTimer = undefined;
        const writeSnapshot = () => {
          cacheIdleCallback = undefined;
          cacheDirtySince = undefined;
          const current = get();
          if (current.authorization.kind !== "ready" || !current.currentUserId) return;
          const snapshot = cachedSnapshotFrom(
            current,
            profileController.getCachedProfiles(),
          );
          cacheWrite = cacheWrite
            .catch(() => undefined)
            .then(() => transport.saveCachedSnapshot(snapshot))
            .then(() => set({ cacheHealth: "healthy" }))
            .catch(() => set({ cacheHealth: "invalid" }));
        };
        if (typeof globalThis.requestIdleCallback === "function") {
          cacheIdleCallback = globalThis.requestIdleCallback(writeSnapshot, {
            timeout: CACHE_WRITE_IDLE_TIMEOUT_MS,
          });
        } else {
          writeSnapshot();
        }
      }, delay);
    };

    const discardLocalAttachmentDraft = (draftKey: string) => {
      localAttachmentDraftGenerations.set(
        draftKey,
        (localAttachmentDraftGenerations.get(draftKey) ?? 0) + 1,
      );
      const current = get().localAttachmentDrafts.get(draftKey);
      if (!current) return;
      const localAttachmentDrafts = new Map(get().localAttachmentDrafts);
      localAttachmentDrafts.delete(draftKey);
      set({ localAttachmentDrafts });
      void flushUnsentState().then(() => attachmentOutbox.remove(current.batchId)).catch(() => {
        set({ cacheHealth: "invalid" });
      });
      scheduleCacheWrite();
    };

    const draftSync = new DraftSyncController({
      isReady: () => get().authorization.kind === "ready",
      getDrafts: () => get().drafts,
      setDrafts: (drafts) => set({ drafts }),
      sendDraft: (draftKey, draft) => transport.setChatDraft({
        chatId: draft?.chatId ?? draftKey.split(":topic:")[0],
        topicId: draft?.topicId,
        text: draft?.text ?? "",
        entities: draft?.entities,
        replyToMessageId: draft?.replyToMessageId,
        replyQuote: draft?.replyQuote,
      }),
      reportError: (operationError) => set({ operationError }),
      scheduleCacheWrite,
      discardLocalAttachments: discardLocalAttachmentDraft,
    });

    const clearCachedData = (clearSnapshot = true) => {
      retainedMediaRestorer.reset();
      syncGeneration += 1;
      hasConnected = false;
      syncRetries.clear();
      forumController.reset();
      cancelScheduledCacheWrite();
      if (localSaveTimer) globalThis.clearTimeout(localSaveTimer);
      localSaveTimer = undefined;
      savedLocalReferences = [];
      if (expiryTimer) globalThis.clearTimeout(expiryTimer);
      expiryTimer = undefined;
      sharedMediaIndex.clear();
      cachedMessageIds.clear();
      historyLoadPromises.clear();
      cacheBoundaryPromises.clear();
      advanceConversationGeneration();
      transport.setConversationFocus?.();
      draftSync.clear();
      localAttachmentDraftGenerations.clear();
      clearTypingUsers();
      liveAttentionCandidates.clear();
      attentionReadRequests.clear();
      acknowledgedAttentionMessages.clear();
      seenReactionMessageIds.clear();
      reactionAttentionLoads.clear();
      reactionReadRequests.clear();
      blockedReactionReadRequests.clear();
      attentionReadGeneration += 1;
      for (const timer of readTimers.values()) globalThis.clearTimeout(timer);
      readTimers.clear();
      readRequestChains.clear();
      chatAdministratorLabelLoads.clear();
      chatAdministratorLabelsGeneration += 1;
      forumTopicsRefreshedAt.clear();
      searchController.reset();
      profileController.reset();
      emojiPickerController.reset();
      set({
        currentUserId: undefined,
        users: new Map(),
        userIdsByUsername: new Map(),
        folders: [],
        chats: new Map(),
        chatAdministratorLabels: new Map(),
        chatListReady: false,
        chatLists: new Map(),
        messages: new Map(),
        sponsoredMessages: new Map(),
        removingMessages: new Map(),
        unreadAttentionMessageIds: new Map(),
        drafts: new Map(),
        localAttachmentDrafts: new Map(),
        typingUserIds: new Map(),
        outbox: [],
        histories: new Map(),
        forumTopics: new Map(),
        forumTopicsLoading: new Set(),
        topicHistories: new Map(),
        lastForumTopicIds: new Map(),
        activeChatId: undefined,
        activeTopicId: undefined,
        globalSearch: emptyGlobalSearch(),
        chatMessageSearch: emptyChatMessageSearch(),
        accountProfile: emptyProfileState(),
        profile: emptyProfileState(),
        contacts: [],
        contactsLoading: false,
        contactsError: undefined,
        contactPendingUserId: undefined,
        chatManagementPending: new Set(),
        groupManagement: undefined,
        groupManagementLoading: false,
        groupManagementError: undefined,
        blockedSenders: [],
        blockedSendersLoading: false,
        folderManagementPending: false,
        chatCreationPending: false,
        chatFilter: "main",
        cacheHealth: clearSnapshot ? "empty" : get().cacheHealth,
      });
      publishMessageChange({ type: "reset", messages: get().messages });
      if (clearSnapshot) void transport.clearCachedSnapshot().catch(() => undefined);
    };

    const applyAccountState = (accountState: TelegramAccountState) => {
      set(accountStatePatch(accountState));
    };

    const registerCurrentAccount = () => {
      const state = get();
      if (accountTransition) return Promise.resolve();
      const registration = currentAccountRegistration(state);
      if (!registration) return Promise.resolve();
      const { accountId, account, key } = registration;
      if (registeredAccountKey === key) return accountRegistration;
      registeredAccountKey = key;
      const request = transport.registerCurrentAccount(account).then((accountState) => {
        if (
          !accountTransition &&
          get().activeAccountId === accountId &&
          accountState.activeAccountId === accountId
        ) {
          applyAccountState(accountState);
        }
      }).catch((error) => {
        if (registeredAccountKey === key) registeredAccountKey = undefined;
        if (!accountTransition) {
          set({
            accountError: error instanceof Error ? error.message : translate("无法保存账号信息"),
          });
        }
      });
      accountRegistration = request;
      return request;
    };

    const flushCachedSnapshot = async () => {
      cancelScheduledCacheWrite();
      if (localSaveTimer) globalThis.clearTimeout(localSaveTimer);
      localSaveTimer = undefined;
      const state = get();
      if (state.authorization.kind === "ready" && state.currentUserId) {
        const snapshot = cachedSnapshotFrom(state, profileController.getCachedProfiles());
        const operation = cacheWrite.catch(() => undefined).then(() => transport.saveCachedSnapshot(snapshot));
        cacheWrite = operation;
        await operation;
        set({ cacheHealth: "healthy" });
      }
    };

    const hydrateCachedSnapshot = (persistedSnapshot?: CachedTelegramSnapshot, localState?: ReturnType<typeof migrateLocalUnsentState>) => {
      const migration = migrateCachedSnapshot(persistedSnapshot);
      const snapshot = localState ? {
        ...(migration.snapshot ?? { version: 4 as const, users: [], folders: [], chats: [], messages: [] }),
        ...localState,
      } : migration.snapshot;
      set({ cacheHealth: migration.health });
      if (!snapshot) {
        return;
      }
      const current = get();
      profileController.hydrateCachedProfiles(snapshot.profiles ?? []);
      const chats = new Map(snapshot.chats.map((chat) => [chat.id, chat]));
      const users = new Map(snapshot.users.map((user) => [user.id, user]));
      const forumTopics = new Map(
        (snapshot.forumTopics ?? []).map((entry) => [entry.chatId, entry.topics]),
      );
      const lastForumTopicIds = new Map(
        (snapshot.lastForumTopicIds ?? []).map((entry) => [entry.chatId, entry.topicId]),
      );
      let messages = messageMapFrom([
        ...snapshot.messages,
        ...(snapshot.locallyDeletedMessages ?? []),
      ]);
      const drafts = new Map((snapshot.drafts ?? []).map((draft) => [draft.localKey ?? topicKey(draft.chatId, draft.topicId), draft]));
      const localAttachmentDrafts = new Map(
        (snapshot.localAttachmentDrafts ?? []).map((draft) => [draft.draftKey, draft]),
      );
      const outbox = snapshot.outbox ?? [];
      cachedMessageIds.clear();
      for (const message of snapshot.messages) {
        rememberCachedMessage(message, chats.get(message.chatId)?.isForum);
      }
      for (const [id, chat] of current.chats) chats.set(id, chat);
      for (const [id, user] of current.users) users.set(id, user);
      for (const [chatId, topics] of current.forumTopics) forumTopics.set(chatId, topics);
      for (const [chatId, topicId] of current.lastForumTopicIds) {
        lastForumTopicIds.set(chatId, topicId);
      }
      for (const [chatId, draft] of current.drafts) {
        if (draft.pending || !drafts.has(chatId)) drafts.set(chatId, draft);
      }
      for (const [draftKey, draft] of current.localAttachmentDrafts) {
        localAttachmentDrafts.set(draftKey, draft);
      }
      for (const [chatId, chatMessages] of current.messages) {
        for (const message of chatMessages) {
          messages.set(chatId, upsertMessage(messages.get(chatId) ?? [], message));
        }
      }
      messages = messagesWithOutbox(
        messages,
        outbox,
        current.currentUserId ?? snapshot.currentUserId,
      );
      const unreadAttentionMessageIds = new Map(current.unreadAttentionMessageIds);
      for (const [chatId, chatMessages] of messages) {
        const reactionIds = chatMessages
          .filter((message) => message.containsUnreadReaction === true)
          .map((message) => message.id);
        if (reactionIds.length === 0) continue;
        unreadAttentionMessageIds.set(chatId, [
          ...new Set([...(unreadAttentionMessageIds.get(chatId) ?? []), ...reactionIds]),
        ]);
      }
      const folders = current.folders.length > 0
        ? current.folders
        : snapshot.folders;
      const requestedFilter = snapshot.chatFilter ?? "main";
      const chatFilter = folders.some((folder) => folder.id === requestedFilter)
        ? requestedFilter
        : (folders[0]?.id ?? "main");
      const cachedActiveChatId = snapshot.activeChatId && chats.has(snapshot.activeChatId)
        ? snapshot.activeChatId
        : undefined;
      const nextActiveChatId = current.activeChatId ?? cachedActiveChatId;
      const cachedActiveTopicId = nextActiveChatId && chats.get(nextActiveChatId)?.isForum
        ? lastForumTopicIds.get(nextActiveChatId)
        : undefined;
      set({
        currentUserId: current.currentUserId ?? snapshot.currentUserId,
        users,
        userIdsByUsername: usernameIndexForUsers(users.values()),
        folders,
        chats,
        chatListReady: true,
        messages,
        unreadAttentionMessageIds,
        drafts,
        localAttachmentDrafts,
        outbox,
        forumTopics,
        lastForumTopicIds,
        activeChatId: nextActiveChatId,
        activeTopicId: current.activeTopicId ?? cachedActiveTopicId,
        chatFilter: current.chatFilter !== "main" ? current.chatFilter : chatFilter,
        cacheHealth: migration.health,
      });
      publishMessageChange({ type: "reset", messages });
    };

    const mergeHistoryPage = (incomingMessages: readonly Message[]) => {
      if (incomingMessages.length === 0) return { messages: get().messages, removingMessages: get().removingMessages };
      const messages = new Map(get().messages);
      const removingMessages = new Map(get().removingMessages);
      const incomingByChat = new Map<string, Message[]>();
      for (const message of incomingMessages) {
        const incoming = incomingByChat.get(message.chatId) ?? [];
        incoming.push(message);
        incomingByChat.set(message.chatId, incoming);
      }
      for (const [chatId, incoming] of incomingByChat) {
        const existing = messages.get(chatId) ?? [];
        for (const message of incoming) {
          queueBlockedReactionReads([message]);
          reconcileMessageAttention(message, existing.find((candidate) => candidate.id === message.id), false);
        }
        messages.set(chatId, upsertMessages(existing, incoming).map((message) => ({ ...message, isRemoving: false })));
        const incomingIds = new Set(incoming.map((message) => message.id));
        const ghosts = (removingMessages.get(chatId) ?? []).filter((message) => !incomingIds.has(message.id));
        if (ghosts.length > 0) removingMessages.set(chatId, ghosts);
        else removingMessages.delete(chatId);
      }
      return { messages, removingMessages };
    };

    const loadHistory = (
      chatId: string,
      mode: "ensure" | "older",
      options: { background?: boolean } = {},
    ) => {
      if (
        get().authorization.kind !== "ready" ||
        get().connectionStatus !== "online"
      ) return Promise.resolve();
      const current = get().histories.get(chatId);
      const generation = accountGeneration;
      const sync = syncGeneration;
      const navigationGeneration = conversationGeneration;
      if (
        current?.loading ||
        current?.hasMore === false ||
        (mode === "ensure" && current?.initialized)
      ) return Promise.resolve();
      const existing = historyLoadPromises.get(chatId);
      if (existing) return existing;

      const cachedCount = get().messages.get(chatId)?.length ?? 0;
      if (mode === "ensure" && cachedCount > 0) {
        const histories = new Map(get().histories);
        histories.set(chatId, {
          loading: false,
          hasMore: current?.hasMore ?? true,
          initialized: true,
        });
        set({ histories });
        // The snapshot is immediately usable. Refresh the server window in
        // the background without keeping the conversation switch trace open.
        queueMicrotask(() => {
          if (generation === accountGeneration && sync === syncGeneration) void loadHistory(chatId, "older", { background: true });
        });
        return Promise.resolve();
      }

      const histories = new Map(get().histories);
      histories.set(chatId, {
        loading: true,
        background: options.background === true,
        hasMore: current?.hasMore ?? true,
        initialized: current?.initialized ?? false,
      });
      set({ histories });
      const startedAt = performance.now();
      const beforeCount = get().messages.get(chatId)?.length ?? 0;
      const chat = get().chats.get(chatId);
      const unreadCount = chat?.unreadCount ?? 0;
      const anchorMessageId = chat?.lastReadInboxMessageId;
      const anchorMessagePresent = Boolean(
        anchorMessageId && (get().messages.get(chatId) ?? []).some((message) => message.id === anchorMessageId),
      );
      const performanceTraceId = options.background ? undefined : getActiveConversationTraceId();
      markConversationSwitch(performanceTraceId, "asyncWaitStarted");
      const load = (async () => {
        try {
          const page = await transport.loadChatHistory(chatId, 30);
          if (generation !== accountGeneration || sync !== syncGeneration) return;

          syncRetries.complete(`history:${chatId}`);

          // The first page is enough to render the conversation. Cache-boundary
          // verification is deliberately detached from the visible loading state
          // so a sparse snapshot cannot hold the first frame hostage.
          const pendingCachedIds = cachedMessageIds.get(chatId);
          const confirmedIds = pendingCachedIds
            ? new Set(page.messageIds)
            : undefined;
          const hasUnconfirmedCache = Boolean(
            pendingCachedIds && [...pendingCachedIds].some((messageId) => !confirmedIds!.has(messageId)),
          );
          const merged = mergeHistoryPage(page.messages ?? []);
          const nextHistories = new Map(get().histories);
          nextHistories.set(chatId, {
            loading: false,
            hasMore: page.hasMore,
            initialized: true,
          });
          set({ histories: nextHistories, messages: merged.messages, removingMessages: merged.removingMessages, operationError: undefined });
          if (page.messages?.length) {
            publishMessageChange({ type: "upsert", messages: page.messages, liveMessages: [] });
          }
          if (hasUnconfirmedCache && pendingCachedIds && confirmedIds) {
            void confirmCachedHistory(
              chatId,
              pendingCachedIds,
              confirmedIds,
              page.hasMore,
              generation,
              navigationGeneration,
              sync,
            );
          }
          markConversationSwitch(performanceTraceId, "asyncWaitFinished", { failed: false });
          logPerformance("ui_history_data", {
            durationMs: performance.now() - startedAt,
            beforeCount,
            afterCount: get().messages.get(chatId)?.length ?? 0,
            loadedCount: page.loadedCount,
            hasMore: page.hasMore,
            failed: false,
            traceId: performanceTraceId,
            duringConversationSwitch: performanceTraceId !== undefined,
            chatHash: diagnosticChatHash(chatId),
            unreadCountBucket: unreadCountBucket(unreadCount),
            anchorMessagePresent,
            localCacheHit: beforeCount > 0,
            pageCount: 1,
          });
          scheduleCacheWrite();
        } catch (error) {
          if (generation !== accountGeneration || sync !== syncGeneration) return;
          const nextHistories = new Map(get().histories);
          nextHistories.set(chatId, {
            loading: false,
            hasMore: true,
            initialized: current?.initialized ?? false,
          });
          set({
            histories: nextHistories,
            operationError: error instanceof Error ? error.message : translate("无法加载历史消息"),
          });
          syncRetries.schedule(`history:${chatId}`, () => loadHistory(chatId, "older", options), error);
          markConversationSwitch(performanceTraceId, "asyncWaitFinished", { failed: true });
          logPerformance("ui_history_data", {
            durationMs: performance.now() - startedAt,
            beforeCount,
            afterCount: get().messages.get(chatId)?.length ?? 0,
            failed: true,
            traceId: performanceTraceId,
            duringConversationSwitch: performanceTraceId !== undefined,
            chatHash: diagnosticChatHash(chatId),
            unreadCountBucket: unreadCountBucket(unreadCount),
            anchorMessagePresent,
            localCacheHit: beforeCount > 0,
            pageCount: 0,
          });
        }
      })();
      historyLoadPromises.set(chatId, load);
      void load.finally(() => {
        if (historyLoadPromises.get(chatId) === load) historyLoadPromises.delete(chatId);
      });
      return load;
    };

    const confirmCachedHistory = async (
      chatId: string,
      pendingCachedIds: Set<string>,
      initialConfirmedIds: Set<string>,
      initialHasMore: boolean,
      generation: number,
      navigationGeneration: number,
      sync: number,
      topicId?: string,
    ) => {
      const key = topicKey(chatId, topicId);
      const retry = () => topicId
        ? loadForumTopicHistory(chatId, topicId, "older", { background: true })
        : loadHistory(chatId, "older", { background: true });
      const retryKey = topicId ? `topic:${key}` : `history:${chatId}`;
      const existing = cacheBoundaryPromises.get(key);
      if (existing) return existing;
      const confirmation = (async () => {
        const confirmationStartedAt = performance.now();
        const confirmedIds = new Set(initialConfirmedIds);
        let hasMore = initialHasMore;
        let continuationPages = 0;
        // A bounded cache can span more than two server pages. Keep this repair
        // bounded and out of the visible history loading state.
        while (
          [...pendingCachedIds].some((messageId) => !confirmedIds.has(messageId)) &&
          !reachedCachedHistoryBoundary(pendingCachedIds, confirmedIds) &&
          hasMore &&
          continuationPages < 8
        ) {
          if (navigationGeneration !== conversationGeneration || generation !== accountGeneration || sync !== syncGeneration) return;
          continuationPages += 1;
          const confirmedBefore = confirmedIds.size;
          const continuation = await (topicId
            ? transport.loadForumTopicHistory(chatId, topicId, 30)
            : transport.loadChatHistory(chatId, 30));
          if (generation !== accountGeneration || sync !== syncGeneration) return;
          // The transport has committed this cursor. Commit its data even when
          // the user switched conversations while the request was in flight.
          const merged = mergeHistoryPage(continuation.messages ?? []);
          const histories = new Map(topicId ? get().topicHistories : get().histories);
          histories.set(key, {
            loading: histories.get(key)?.loading ?? false,
            background: histories.get(key)?.background,
            initialized: true,
            hasMore: continuation.hasMore,
          });
          set({ ...(topicId ? { topicHistories: histories } : { histories }), messages: merged.messages, removingMessages: merged.removingMessages });
          if (continuation.messages?.length) {
            publishMessageChange({ type: "upsert", messages: continuation.messages, liveMessages: [] });
          }
          scheduleCacheWrite();
          for (const messageId of continuation.messageIds) confirmedIds.add(messageId);
          hasMore = continuation.hasMore;
          if (confirmedIds.size === confirmedBefore) break;
        }
        const remainingCachedIds = pendingCachedIdsAfterConfirmation(pendingCachedIds, confirmedIds);
        if (remainingCachedIds.size === 0) cachedMessageIds.delete(key);
        else cachedMessageIds.set(key, remainingCachedIds);
        if (remainingCachedIds.size > 0 && hasMore && !reachedCachedHistoryBoundary(pendingCachedIds, confirmedIds) && navigationGeneration === conversationGeneration) {
          syncRetries.schedule(retryKey, retry);
        }
        logPerformance("ui_history_cache_confirmation", {
          durationMs: performance.now() - confirmationStartedAt,
          chatHash: diagnosticChatHash(chatId),
          continuationPages,
          pageCount: continuationPages + 1,
          loadedCount: confirmedIds.size - initialConfirmedIds.size,
          remainingCachedCount: remainingCachedIds.size,
          cancelled: (generation !== accountGeneration || sync !== syncGeneration) || navigationGeneration !== conversationGeneration,
        });
        scheduleCacheWrite();
      })().catch((error) => {
        if (generation !== accountGeneration || sync !== syncGeneration) return;
        set({ operationError: errorMessage(error, translate("无法加载历史消息")) });
        if (navigationGeneration === conversationGeneration) {
          syncRetries.schedule(retryKey, retry, error);
        }
      });
      cacheBoundaryPromises.set(key, confirmation);
      void confirmation.finally(() => {
        if (cacheBoundaryPromises.get(key) === confirmation) cacheBoundaryPromises.delete(key);
      });
      return confirmation;
    };

    const loadForumTopicHistory = async (
      chatId: string,
      topicId: string,
      mode: "ensure" | "older",
      options: { background?: boolean } = {},
    ) => {
      if (
        get().authorization.kind !== "ready" ||
        get().connectionStatus !== "online"
      ) return;
      const key = topicKey(chatId, topicId);
      const generation = accountGeneration;
      const sync = syncGeneration;
      const navigationGeneration = conversationGeneration;
      const current = get().topicHistories.get(key);
      if (current?.loading || current?.hasMore === false || (mode === "ensure" && current?.initialized)) return;
      const topicHistories = new Map(get().topicHistories);
      const background = options.background === true || (mode === "ensure" &&
        (get().messages.get(chatId) ?? []).some((message) => message.topicId === topicId));
      topicHistories.set(key, { loading: true, background, hasMore: current?.hasMore ?? true, initialized: current?.initialized ?? false });
      set({ topicHistories });
      try {
        const page = await transport.loadForumTopicHistory(chatId, topicId, 30);
        if (generation !== accountGeneration || sync !== syncGeneration) return;
        syncRetries.complete(`topic:${key}`);
        const merged = mergeHistoryPage(page.messages ?? []);
        const next = new Map(get().topicHistories);
        next.set(key, { loading: false, hasMore: page.hasMore, initialized: true });
        set({ topicHistories: next, messages: merged.messages, removingMessages: merged.removingMessages, operationError: undefined });
        if (page.messages?.length) {
          publishMessageChange({ type: "upsert", messages: page.messages, liveMessages: [] });
        }
        const pendingCachedIds = cachedMessageIds.get(key);
        if (pendingCachedIds) {
          void confirmCachedHistory(chatId, pendingCachedIds, new Set(page.messageIds), page.hasMore, generation, navigationGeneration, sync, topicId);
        }
        scheduleCacheWrite();
      } catch (error) {
        if (generation !== accountGeneration || sync !== syncGeneration) return;
        const next = new Map(get().topicHistories);
        next.set(key, { loading: false, hasMore: true, initialized: current?.initialized ?? false });
        syncRetries.schedule(`topic:${key}`, () => loadForumTopicHistory(chatId, topicId, "older", { background }), error);
        set({ topicHistories: next, operationError: errorMessage(error, translate("无法加载话题消息")) });
      }
    };

    const invalidateSyncState = () => {
      syncGeneration += 1;
      syncRetries.clear();
      transport.resetSyncState();
      forumController.reset();
      historyLoadPromises.clear();
      cacheBoundaryPromises.clear();
      cachedMessageIds.clear();
      for (const messages of get().messages.values()) {
        for (const message of messages) rememberCachedMessage(message);
      }
      forumTopicsRefreshedAt.clear();
      set({ histories: new Map(), topicHistories: new Map(), chatLists: new Map() });
    };

    const refreshVisibleData = () => {
      if (get().authorization.kind !== "ready" || get().connectionStatus !== "online") return;
      void loadChats();
      const { activeChatId, activeTopicId, chats } = get();
      if (!activeChatId) return;
      if (chats.get(activeChatId)?.isForum) {
        if (activeTopicId) loadActiveForumTopic(activeChatId, activeTopicId);
        void refreshForumConversation(activeChatId, true);
      } else {
        void loadHistory(activeChatId, "ensure");
      }
    };

    const loadChats = async (chatListId = get().chatFilter) => {
      if (get().authorization.kind !== "ready" || get().connectionStatus !== "online") return;
      const current = get().chatLists.get(chatListId);
      const generation = accountGeneration;
      const sync = syncGeneration;
      if (current?.loading || current?.hasMore === false) return;

      const chatLists = new Map(get().chatLists);
      chatLists.set(chatListId, { loading: true, hasMore: current?.hasMore ?? true });
      set({ chatLists });
      try {
        const page = await transport.loadMoreChats(chatListId, 50);
        if (generation !== accountGeneration || sync !== syncGeneration) return;
        syncRetries.complete(`list:${chatListId}`);
        const nextChatLists = new Map(get().chatLists);
        nextChatLists.set(chatListId, { loading: false, hasMore: page.hasMore });
        set({ chatLists: nextChatLists, operationError: undefined });
        scheduleCacheWrite();
      } catch (error) {
        if (generation !== accountGeneration || sync !== syncGeneration) return;
        const nextChatLists = new Map(get().chatLists);
        nextChatLists.set(chatListId, { loading: false, hasMore: true });
        syncRetries.schedule(`list:${chatListId}`, () => loadChats(chatListId), error);
        set({
          chatLists: nextChatLists,
          operationError: error instanceof Error ? error.message : translate("无法加载更多会话"),
        });
      }
    };

    const searchController = createSearchController({
      transport,
      get,
      set,
      onError: errorMessage,
    });

    const documentIsVisible = () =>
      typeof document === "undefined" || document.visibilityState === "visible";

    const markChatRead = (chatId: string, activeOnly = true) => {
      const previous = readRequestChains.get(chatId) ?? Promise.resolve();
      let succeeded = false;
      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          if (
            get().authorization.kind !== "ready" ||
            (activeOnly && get().activeChatId !== chatId) ||
            !documentIsVisible()
          ) {
            return;
          }
          await transport.markChatRead(chatId);
          succeeded = true;
        })
        .catch((error) => {
          set({ operationError: error instanceof Error ? error.message : translate("无法更新已读状态") });
        });
      const tracked = operation.finally(() => {
        if (readRequestChains.get(chatId) === tracked) readRequestChains.delete(chatId);
      });
      readRequestChains.set(chatId, tracked);
      return tracked.then(() => succeeded);
    };

    const markForumTopicRead = async (chatId: string, topicId: string) => {
      if (
        get().authorization.kind !== "ready" ||
        get().activeChatId !== chatId ||
        get().activeTopicId !== topicId ||
        !documentIsVisible()
      ) return false;
      const messages = get().messages.get(chatId) ?? [];
      let latestIncoming: Message | undefined;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.topicId === topicId && !message.outgoing) {
          latestIncoming = message;
          break;
        }
      }
      if (!latestIncoming) return false;
      const topic = get().forumTopics.get(chatId)?.find((candidate) => candidate.id === topicId);
      if (
        topic?.lastReadInboxMessageId === latestIncoming.id &&
        topic.unreadCount === 0
      ) return false;
      try {
        await transport.markForumTopicRead(chatId, topicId, latestIncoming.id);
        const forumTopics = new Map(get().forumTopics);
        forumTopics.set(chatId, (forumTopics.get(chatId) ?? []).map((topic) => topic.id === topicId
          ? {
              ...topic,
              unreadCount: 0,
              lastReadInboxMessageId: latestIncoming.id,
            }
          : topic));
        set({ forumTopics });
        return true;
      } catch (error) {
        set({ operationError: errorMessage(error, translate("无法更新话题已读状态")) });
        return false;
      }
    };

    const markActiveConversationRead = (chatId: string) => {
      const current = get();
      if (current.activeChatId !== chatId) return Promise.resolve(false);
      if (current.chats.get(chatId)?.isForum) {
        return current.activeTopicId
          ? markForumTopicRead(chatId, current.activeTopicId)
          : Promise.resolve(false);
      }
      return markChatRead(chatId);
    };

    const migrateChatState = (fromChatId: string, toChatId: string) => {
      if (!fromChatId || !toChatId || fromChatId === toChatId) return;
      const current = get();
      const chats = new Map(current.chats);
      const oldChat = chats.get(fromChatId);
      const newChat = chats.get(toChatId);
      if (oldChat) {
        chats.set(toChatId, newChat ? { ...oldChat, ...newChat, id: toChatId } : { ...oldChat, id: toChatId });
      }
      chats.delete(fromChatId);

      const messages = new Map(current.messages);
      const migratedMessages = (messages.get(fromChatId) ?? [])
        .map((message) => migrateMessageChatId(message, fromChatId, toChatId));
      messages.delete(fromChatId);
      if (migratedMessages.length > 0 || messages.has(toChatId)) {
        messages.set(toChatId, upsertMessages(messages.get(toChatId) ?? [], migratedMessages));
      }
      const cachedIds = cachedMessageIds.get(fromChatId);
      if (cachedIds) {
        const mergedCachedIds = new Set([...(cachedMessageIds.get(toChatId) ?? []), ...cachedIds]);
        cachedMessageIds.delete(fromChatId);
        cachedMessageIds.set(toChatId, mergedCachedIds);
      }

      const removingMessages = new Map(current.removingMessages);
      const migratedRemoving = (removingMessages.get(fromChatId) ?? [])
        .map((message) => migrateMessageChatId(message, fromChatId, toChatId));
      removingMessages.delete(fromChatId);
      if (migratedRemoving.length > 0) {
        removingMessages.set(toChatId, upsertMessages(removingMessages.get(toChatId) ?? [], migratedRemoving));
      }

      const unreadAttentionMessageIds = new Map(current.unreadAttentionMessageIds);
      const migratedAttention = [
        ...(unreadAttentionMessageIds.get(toChatId) ?? []),
        ...(unreadAttentionMessageIds.get(fromChatId) ?? []),
      ];
      unreadAttentionMessageIds.delete(fromChatId);
      if (migratedAttention.length > 0) {
        unreadAttentionMessageIds.set(toChatId, [...new Set(migratedAttention)]);
      }

      const drafts = new Map(current.drafts);
      for (const [key, draft] of current.drafts) {
        const migratedKey = migrateChatKey(key, fromChatId, toChatId);
        const migratedDraft = draft.chatId === fromChatId ? { ...draft, chatId: toChatId } : draft;
        if (migratedKey !== key) drafts.delete(key);
        const previous = drafts.get(migratedKey);
        if (!previous || Date.parse(migratedDraft.updatedAt) >= Date.parse(previous.updatedAt)) {
          drafts.set(migratedKey, migratedDraft);
        }
      }

      const localAttachmentDrafts = new Map(current.localAttachmentDrafts);
      for (const [key, draft] of [...localAttachmentDrafts]) {
        if (draft.chatId !== fromChatId) continue;
        const migratedKey = migrateChatKey(key, fromChatId, toChatId);
        localAttachmentDrafts.delete(key);
        localAttachmentDrafts.set(migratedKey, {
          ...draft,
          draftKey: migratedKey,
          chatId: toChatId,
        });
      }

      const outbox = current.outbox.map((item) => item.chatId === fromChatId
        ? { ...item, chatId: toChatId }
        : item);
      const histories = new Map(current.histories);
      const oldHistory = histories.get(fromChatId);
      const newHistory = histories.get(toChatId);
      histories.delete(fromChatId);
      if (oldHistory || newHistory) {
        histories.set(toChatId, {
          loading: Boolean(oldHistory?.loading || newHistory?.loading),
          hasMore: Boolean(oldHistory?.hasMore || newHistory?.hasMore),
          initialized: Boolean(oldHistory?.initialized || newHistory?.initialized),
        });
      }

      const forumTopics = new Map(current.forumTopics);
      const oldTopics = forumTopics.get(fromChatId);
      if (oldTopics && !forumTopics.has(toChatId)) forumTopics.set(toChatId, oldTopics);
      forumTopics.delete(fromChatId);
      const forumTopicsLoading = new Set(current.forumTopicsLoading);
      if (forumTopicsLoading.delete(fromChatId)) forumTopicsLoading.add(toChatId);
      const topicHistories = new Map(current.topicHistories);
      topicHistories.clear();
      for (const [key, history] of current.topicHistories) topicHistories.set(migrateChatKey(key, fromChatId, toChatId), history);
      const lastForumTopicIds = new Map(current.lastForumTopicIds);
      const oldTopicId = lastForumTopicIds.get(fromChatId);
      lastForumTopicIds.delete(fromChatId);
      if (oldTopicId && !lastForumTopicIds.has(toChatId)) lastForumTopicIds.set(toChatId, oldTopicId);

      const typingUserIds = new Map(current.typingUserIds);
      const oldTyping = typingUserIds.get(fromChatId);
      typingUserIds.delete(fromChatId);
      if (oldTyping?.length) typingUserIds.set(toChatId, [...new Set([...(typingUserIds.get(toChatId) ?? []), ...oldTyping])]);

      const chatAdministratorLabels = new Map(current.chatAdministratorLabels);
      const labels = chatAdministratorLabels.get(fromChatId);
      chatAdministratorLabels.delete(fromChatId);
      if (labels && !chatAdministratorLabels.has(toChatId)) chatAdministratorLabels.set(toChatId, labels);

      for (const [key, timer] of [...readTimers]) {
        if (key === fromChatId) {
          globalThis.clearTimeout(timer);
          readTimers.delete(key);
        }
      }
      for (const [key, timer] of [...typingTimers]) {
        if (key.startsWith(`${fromChatId}:`)) {
          globalThis.clearTimeout(timer);
          typingTimers.delete(key);
        }
      }
      readRequestChains.delete(fromChatId);
      groupManagementLoads.delete(fromChatId);
      chatAdministratorLabelLoads.delete(fromChatId);
      forumTopicsRefreshedAt.delete(fromChatId);
      sharedMediaIndex.clearChat(fromChatId);
      sharedMediaIndex.clearChat(toChatId);

      const activeChatId = current.activeChatId === fromChatId ? toChatId : current.activeChatId;
      const oldAttachmentGenerationKeys = [...localAttachmentDraftGenerations.keys()]
        .filter((key) => migrateChatKey(key, fromChatId, toChatId) !== key);
      for (const key of oldAttachmentGenerationKeys) {
        const migratedKey = migrateChatKey(key, fromChatId, toChatId);
        const generation = localAttachmentDraftGenerations.get(key);
        localAttachmentDraftGenerations.delete(key);
        if (generation !== undefined) localAttachmentDraftGenerations.set(migratedKey, generation);
      }
      for (const collection of [attentionReadRequests, acknowledgedAttentionMessages, liveAttentionCandidates]) {
        for (const key of [...collection]) {
          if (!key.startsWith(`${fromChatId}:`)) continue;
          collection.delete(key);
          collection.add(`${toChatId}:${key.slice(fromChatId.length + 1)}`);
        }
      }
      const previousSeenReactions = seenReactionMessageIds.get(fromChatId);
      seenReactionMessageIds.delete(fromChatId);
      if (previousSeenReactions) {
        seenReactionMessageIds.set(toChatId, new Set([
          ...(seenReactionMessageIds.get(toChatId) ?? []),
          ...previousSeenReactions,
        ]));
      }
      reactionAttentionLoads.delete(fromChatId);
      reactionReadRequests.delete(fromChatId);
      const profile = current.profile.target?.kind === "chat" && current.profile.target.chatId === fromChatId
        ? emptyProfileState()
        : current.profile;
      const groupManagement = current.groupManagement?.chatId === fromChatId
        ? undefined
        : current.groupManagement;
      set({
        chats,
        messages,
        removingMessages,
        unreadAttentionMessageIds,
        drafts,
        localAttachmentDrafts,
        outbox,
        histories,
        forumTopics,
        forumTopicsLoading,
        topicHistories,
        lastForumTopicIds,
        typingUserIds,
        chatAdministratorLabels,
        activeChatId,
        profile,
        groupManagement,
        groupManagementLoading: groupManagement ? current.groupManagementLoading : false,
        groupManagementError: groupManagement ? current.groupManagementError : undefined,
      });
      draftSync.migrateChat(fromChatId, toChatId);
      publishMessageChange({ type: "reset", messages });
      if ((chats.get(toChatId)?.unreadReactionCount ?? 0) > 0) {
        void refreshUnreadReactionAttention(toChatId);
      }
      scheduleCacheWrite();
    };

    const scheduleChatRead = (chatId: string, delayMs = 120) => {
      const currentTimer = readTimers.get(chatId);
      if (currentTimer) globalThis.clearTimeout(currentTimer);
      readTimers.set(chatId, globalThis.setTimeout(() => {
        readTimers.delete(chatId);
        void markActiveConversationRead(chatId);
      }, delayMs));
    };

    const maybeAutoCacheArchiveMedia = (message: Message) => {
      if (!preferencesStore.getState().deletedMessageArchiveEnabled) return;
      const fileId = archiveMediaFileId(message);
      const content = message.content.kind === "media" &&
        (message.content.mediaType === "photo" || message.content.mediaType === "sticker")
        ? message.content
        : undefined;
      if (fileId !== undefined && content && !content.isDownloaded) {
        void get().cacheFile(fileId, 48).catch(() => undefined);
      }
    };

    const retainedMediaRestorer = new RetainedMediaRestorer({
      canRestore: () => !accountTransition && get().authorization.kind === "ready",
      messages: () => retainedMessages.all(),
      resolveFile: remoteId => transport.resolveRemoteFile(remoteId),
      applyFile: (remoteId, file) => {
        const updated = retainedMessages.forRemoteFile(remoteId).flatMap(message => {
          const next = bindRetainedMessageFile(message, remoteId, file);
          return next === message ? [] : [next];
        });
        if (updated.length === 0) return;
        const messages = new Map(get().messages);
        for (const message of updated) {
          messages.set(message.chatId, upsertMessage(messages.get(message.chatId) ?? [], message));
        }
        set({ messages });
        publishMessageChange({ type: "upsert", messages: updated, liveMessages: [] });
        for (const message of updated) maybeAutoCacheArchiveMedia(message);
        scheduleCacheWrite();
      },
    });

    const applyEvent = (event: TelegramEvent) => {
      if (event.type === "emoji.catalogChanged" || event.type === "stickerSet.updated") {
        emojiPickerController.handleUpdate(event);
        return;
      }
      if (event.type === "file.updated") {
        emojiPickerController.updateFile(event.file);
        const updated = retainedMessages.forFile(event.file.fileId).flatMap(message => {
          const current = get().messages.get(message.chatId)?.find(candidate => candidate.id === message.id);
          if (!current?.isLocallyDeleted) return [];
          const next = updateRetainedMessageFile(current, event.file);
          return next === current ? [] : [next];
        });
        if (updated.length === 0) return;
        const messages = new Map(get().messages);
        for (const message of updated) {
          messages.set(message.chatId, upsertMessage(messages.get(message.chatId) ?? [], message));
        }
        set({ messages });
        publishMessageChange({ type: "upsert", messages: updated, liveMessages: [] });
        if (event.file.isDownloaded || !event.file.isDownloading) scheduleCacheWrite();
        return;
      }
      if (event.type === "authorization.changed") {
        set({
          authorization: event.state,
          authorizationPending: false,
          authorizationError: undefined,
        });
        if (event.state.kind === "ready") {
          void retainedMediaRestorer.restore();
          scheduleCacheWrite();
          draftSync.resumePending();
          void flushOutbox();
          const activeChatId = get().activeChatId;
          if (activeChatId && get().connectionStatus === "online") {
            const activeTopicId = get().activeTopicId;
            if (get().chats.get(activeChatId)?.isForum) {
              if (activeTopicId) loadActiveForumTopic(activeChatId, activeTopicId);
              void refreshForumConversation(activeChatId);
            } else {
              void loadHistory(activeChatId, "ensure").then(() => markChatRead(activeChatId));
              if (get().chats.get(activeChatId)?.kind === "channel") {
                void get().loadChatSponsoredMessages(activeChatId);
              }
            }
          }
          if (get().connectionStatus === "online") {
            for (const chat of get().chats.values()) {
              if ((chat.unreadReactionCount ?? 0) > 0) void refreshUnreadReactionAttention(chat.id);
            }
          }
        } else if (event.state.kind !== "preparing") {
          if (event.state.kind === "closing" || event.state.kind === "closed") {
            set({ connectionStatus: "offline" });
          }
          clearCachedData(!accountTransition);
        }
        return;
      }

      if (event.type === "sync.required") {
        emojiPickerController.invalidate();
        if (get().authorization.kind === "ready") {
          invalidateSyncState();
          refreshVisibleData();
        }
        return;
      }

      if (event.type === "proxy.settingsChanged") {
        void get().loadProxySettings();
        return;
      }
      if (event.type === "connection.changed") {
        const recovered = event.status === "online" && get().connectionStatus !== "online" && hasConnected;
        set({ connectionStatus: event.status });
        if (event.status === "online") {
          void retainedMediaRestorer.restore();
          hasConnected = true;
          if (recovered) {
            emojiPickerController.invalidate();
            invalidateSyncState();
            refreshVisibleData();
          }
          draftSync.resumePending();
          void flushOutbox();
          const activeChatId = get().activeChatId;
          if (get().authorization.kind === "ready" && activeChatId) {
            const activeTopicId = get().activeTopicId;
            if (get().chats.get(activeChatId)?.isForum) {
              if (activeTopicId) loadActiveForumTopic(activeChatId, activeTopicId);
              void refreshForumConversation(activeChatId);
            } else {
              void loadHistory(activeChatId, "ensure").then(() => markChatRead(activeChatId));
              if (get().chats.get(activeChatId)?.kind === "channel") {
                void get().loadChatSponsoredMessages(activeChatId);
              }
            }
          }
          if (get().authorization.kind === "ready") {
            for (const chat of get().chats.values()) {
              if ((chat.unreadReactionCount ?? 0) > 0) void refreshUnreadReactionAttention(chat.id);
            }
          }
        }
        return;
      }

      if (event.type === "currentUser.changed") {
        set({ currentUserId: event.userId });
        scheduleCacheWrite();
        void registerCurrentAccount();
        return;
      }

      if (event.type === "sync.error") {
        set({
          phase: event.fatal ? "error" : get().phase,
          connectionStatus: event.fatal ? "offline" : get().connectionStatus,
          error: event.fatal ? event.message : get().error,
          operationError: event.fatal ? undefined : event.message,
        });
        return;
      }

      if (event.type === "folders.replaced") {
        const folders = event.folders;
        const activeFolderExists = folders.some(
          (folder) => folder.id === get().chatFilter,
        );
        set({
          folders,
          chatFilter: activeFolderExists
            ? get().chatFilter
            : (folders[0]?.id ?? "main"),
        });
        scheduleCacheWrite();
        return;
      }

      if (event.type === "chat.migrated") {
        migrateChatState(event.fromChatId, event.toChatId);
        return;
      }

      if (event.type === "chats.upserted" || event.type === "chat.upsert") {
        const incomingChats = event.type === "chats.upserted" ? event.chats : [event.chat];
        const previousChats = get().chats;
        const loadedManagement = get().groupManagement;
        const managementChanged = Boolean(loadedManagement && incomingChats.some((chat) =>
          chat.id === loadedManagement.chatId &&
          JSON.stringify(previousChats.get(chat.id)?.management ?? null) !== JSON.stringify(chat.management ?? null),
        ));
        const activeChatId = get().activeChatId;
        const previousActiveChat = activeChatId ? previousChats.get(activeChatId) : undefined;
        const chats = new Map(previousChats);
        for (const chat of incomingChats) {
          chats.set(chat.id, chat);
        }
        const firstChat = get().activeChatId
          ? undefined
          : [...chats.values()].sort(compareChats)[0]?.id;
        const activeChat = activeChatId ? chats.get(activeChatId) : undefined;
        const activeChatModeChanged = Boolean(
          activeChatId &&
          activeChat &&
          (!previousActiveChat || previousActiveChat.isForum !== activeChat.isForum),
        );
        set({
          chats,
          groupManagement: managementChanged ? undefined : loadedManagement,
          groupManagementError: managementChanged ? undefined : get().groupManagementError,
          chatListReady: true,
          activeChatId: get().activeChatId ?? firstChat,
          activeTopicId: activeChatModeChanged && !activeChat?.isForum
            ? undefined
            : get().activeTopicId,
        });
        for (const chat of incomingChats) {
          if ((chat.unreadReactionCount ?? 0) > 0) {
            void refreshUnreadReactionAttention(chat.id);
          } else if ((previousChats.get(chat.id)?.unreadReactionCount ?? 0) > 0) {
            clearUnreadReactionAttention(chat.id);
          }
        }
        if (event.type !== "chat.upsert" || event.cacheRelevant !== false) {
          scheduleCacheWrite();
        }
        if (activeChatModeChanged && activeChatId && activeChat) {
          if (activeChat.isForum) void refreshForumConversation(activeChatId);
          else void loadHistory(activeChatId, "ensure").then(() => markChatRead(activeChatId));
        }
        if (firstChat) {
          if (chats.get(firstChat)?.isForum) void refreshForumConversation(firstChat);
          else void loadHistory(firstChat, "ensure").then(() => markChatRead(firstChat));
        }
        return;
      }

      if (event.type === "users.upserted") {
        const current = get();
        const users = new Map(current.users);
        const userIdsByUsername = new Map(current.userIdsByUsername);
        for (const incoming of event.users) {
          const previous = users.get(incoming.id);
          const user = preserveUserAvatarMedia(incoming, previous);
          users.set(user.id, user);
          const previousUsername = normalizedUsername(previous);
          const nextUsername = normalizedUsername(user);
          if (previousUsername && userIdsByUsername.get(previousUsername) === user.id) {
            userIdsByUsername.delete(previousUsername);
          }
          if (nextUsername) userIdsByUsername.set(nextUsername, user.id);
        }
        set({ users, userIdsByUsername });
        if (event.users.length > 0) scheduleCacheWrite();
        return;
      }

      if (event.type === "user.upsert") {
        const current = get();
        const users = new Map(current.users);
        const previous = users.get(event.user.id);
        const user = preserveUserAvatarMedia(event.user, previous);
        users.set(event.user.id, user);
        // Mention selectors return primitive display keys, so this derived index can
        // update in place without forcing an O(n) clone on frequent presence updates.
        const userIdsByUsername = current.userIdsByUsername;
        const previousUsername = normalizedUsername(previous);
        const nextUsername = normalizedUsername(user);
        if (previousUsername && userIdsByUsername.get(previousUsername) === event.user.id) {
          userIdsByUsername.delete(previousUsername);
        }
        if (nextUsername) userIdsByUsername.set(nextUsername, event.user.id);
        set({ users, userIdsByUsername });
        if (event.cacheRelevant !== false) scheduleCacheWrite();
        if (event.user.id === get().currentUserId) void registerCurrentAccount();
        return;
      }

      if (event.type === "chat.typingChanged") {
        if (event.senderId !== get().currentUserId) {
          setTypingUser(event.chatId, event.senderId, event.typing);
        }
        return;
      }

      if (event.type === "forumTopics.changed") {
        if (event.topic) {
          const existing = get().forumTopics.get(event.chatId);
          if (existing?.some((topic) => topic.id === event.topic?.id)) {
            const forumTopics = new Map(get().forumTopics);
            forumTopics.set(event.chatId, existing.map((topic) => topic.id === event.topic?.id
              ? { ...topic, ...event.topic }
              : topic));
            set({ forumTopics });
            if ((event.topic.unreadReactionCount ?? 0) > 0) {
              void refreshUnreadReactionAttention(event.chatId);
            }
            scheduleCacheWrite();
          }
        }
        if (get().chats.get(event.chatId)?.isForum) {
          void refreshForumConversation(event.chatId, true);
        }
        return;
      }

      if (event.type === "message.remove") {
        const unreadAttentionMessageIds = new Map(get().unreadAttentionMessageIds);
        const unreadAttention = (unreadAttentionMessageIds.get(event.chatId) ?? [])
          .filter((messageId) => messageId !== event.messageId);
        if (unreadAttention.length > 0) unreadAttentionMessageIds.set(event.chatId, unreadAttention);
        else unreadAttentionMessageIds.delete(event.chatId);
        liveAttentionCandidates.delete(`${event.chatId}:${event.messageId}`);
        const existing = get().messages.get(event.chatId)?.find(message => message.id === event.messageId);
        if (existing?.isLocallyDeleted && event.source === "remote") {
          set({ unreadAttentionMessageIds });
          return;
        }
        if (
          preferencesStore.getState().deletedMessageArchiveEnabled &&
          event.source === "remote" &&
          event.permanent === true &&
          canArchiveDeletedMessage(event.preservedMessage) &&
          get().users.get(event.preservedMessage!.senderId)?.isBot !== true
        ) {
          const archived = {
            ...event.preservedMessage!,
            content: retainHydratedContent(event.preservedMessage!.content, existing?.content),
            isLocallyDeleted: true,
            locallyDeletedAt: new Date().toISOString(),
            permissions: undefined,
            interaction: undefined,
            isPinned: false,
          };
          const messages = new Map(get().messages);
          messages.set(event.chatId, upsertMessage(messages.get(event.chatId) ?? [], archived));
          set({ messages, unreadAttentionMessageIds });
          publishMessageChange({ type: "upsert", messages: [archived], liveMessages: [] });
          maybeAutoCacheArchiveMedia(archived);
          void flushCachedSnapshot().catch(() => set({ cacheHealth: "invalid" }));
          return;
        }
        if (event.immediate) {
          set({ unreadAttentionMessageIds });
          removeMessageImmediately(event.chatId, event.messageId);
          return;
        }
        set({ unreadAttentionMessageIds });
        markMessageRemoving(event.chatId, event.messageId);
        scheduleCacheWrite();
        return;
      }

      if (event.type === "message.replace") {
        const chatId = event.message.chatId;
        queueBlockedReactionReads([event.message]);
        const previousMessage = get().messages.get(chatId)
          ?.find((message) => message.id === event.oldMessageId || message.id === event.message.id);
        reconcileMessageAttention(event.message, previousMessage, false);
        transferMessageEntrance(chatId, event.oldMessageId, event.message);
        const oldKey = `${chatId}:${event.oldMessageId}`;
        const removalTimer = removalTimers.get(oldKey);
        if (removalTimer) globalThis.clearTimeout(removalTimer);
        removalTimers.delete(oldKey);

        const messages = new Map(get().messages);
        messages.set(
          chatId,
          replaceMessage(messages.get(chatId) ?? [], event.oldMessageId, event.message),
        );
        const removingMessages = new Map(get().removingMessages);
        const ghosts = (removingMessages.get(chatId) ?? []).filter(
          (message) => message.id !== event.oldMessageId && message.id !== event.message.id,
        );
        if (ghosts.length > 0) removingMessages.set(chatId, ghosts);
        else removingMessages.delete(chatId);
        set({ messages, removingMessages });
        publishMessageChange({
          type: "replace",
          oldMessageId: event.oldMessageId,
          message: event.message,
        });
        scheduleCacheWrite();
        return;
      }

      if (event.type === "messages.upserted") {
        if (event.messages.length === 0) return;
        const mergeStartedAt = performance.now();
        const messages = new Map(get().messages);
        const incomingByChat = new Map<string, typeof event.messages>();
        let beforeCount = 0;
        for (const message of event.messages) {
          maybeAutoCacheArchiveMedia(message);
          const chatMessages = incomingByChat.get(message.chatId) ?? [];
          chatMessages.push(message);
          incomingByChat.set(message.chatId, chatMessages);
        }
        for (const [chatId, incoming] of incomingByChat) {
          const existing = messages.get(chatId) ?? [];
          for (const message of incoming) {
            queueBlockedReactionReads([message]);
            reconcileMessageAttention(
              message,
              existing.find((candidate) => candidate.id === message.id),
              false,
            );
          }
          beforeCount += existing.length;
          messages.set(chatId, upsertMessages(existing, incoming).map((message) => ({ ...message, isRemoving: false })));
          const removingMessages = new Map(get().removingMessages);
          const incomingIds = new Set(incoming.map((message) => message.id));
          const ghosts = (removingMessages.get(chatId) ?? []).filter((message) => !incomingIds.has(message.id));
          if (ghosts.length > 0) removingMessages.set(chatId, ghosts); else removingMessages.delete(chatId);
          set({ removingMessages });
        }
        set({ messages });
        publishMessageChange({ type: "upsert", messages: event.messages, liveMessages: [] });
        logPerformance("ui_history_merge", {
          durationMs: performance.now() - mergeStartedAt,
          batchCount: event.messages.length,
          beforeCount,
          afterCount: [...incomingByChat.keys()].reduce(
            (total, chatId) => total + (messages.get(chatId)?.length ?? 0),
            0,
          ),
          traceId: getActiveConversationTraceId(),
          duringConversationSwitch: getActiveConversationTraceId() !== undefined,
        });
        const activeChatId = get().activeChatId;
        if (activeChatId && event.messages.some(
          (message) => message.chatId === activeChatId &&
            !message.outgoing &&
            (!get().chats.get(activeChatId)?.isForum || (
              Boolean(get().activeTopicId) && message.topicId === get().activeTopicId
            )),
        )) {
          scheduleChatRead(activeChatId);
        }
        if (event.cacheRelevant !== false) scheduleCacheWrite();
        return;
      }

      if (event.type === "chat.draftChanged") {
        if (event.draft?.topicId) {
          const key = topicKey(event.chatId, event.draft.topicId);
          draftSync.acceptServerDraft(key, event.draft);
          return;
        }
        draftSync.acceptServerDraft(event.chatId, event.draft);
        return;
      }

      if (event.type === "drafts.replaced") {
        draftSync.replaceServerDrafts(event.drafts, event.chatIds);
        return;
      }

      const messages = new Map(get().messages);
      const existingMessages = messages.get(event.message.chatId) ?? [];
      maybeAutoCacheArchiveMedia(event.message);
      queueBlockedReactionReads([event.message]);
      const isNewLiveMessage = event.animateEntrance === true &&
        !existingMessages.some((message) => message.id === event.message.id);
      reconcileMessageAttention(
        event.message,
        existingMessages.find((message) => message.id === event.message.id),
        event.animateEntrance === true,
      );
      if (isNewLiveMessage) {
        markMessageEntrance(event.message);
      }
      if (!event.message.outgoing) {
        setTypingUser(event.message.chatId, event.message.senderId, false);
      }
      messages.set(
        event.message.chatId,
        upsertMessage(existingMessages, event.message),
      );
      set({ messages });
      publishMessageChange({
        type: "upsert",
        messages: [event.message],
        liveMessages: isNewLiveMessage ? [event.message] : [],
      });
      if (
        !event.message.outgoing &&
        event.message.chatId === get().activeChatId &&
        (!get().chats.get(event.message.chatId)?.isForum || (
          Boolean(get().activeTopicId) && event.message.topicId === get().activeTopicId
        ))
      ) {
        scheduleChatRead(event.message.chatId);
      }
      if (event.cacheRelevant !== false) scheduleCacheWrite();
    };

    if (import.meta.env.VITE_WEBVIEW_STRESS === "1") {
      (
        globalThis as typeof globalThis & {
          __notgramWebviewStressDispatch?: (event: TelegramEvent) => void;
        }
      ).__notgramWebviewStressDispatch = (event) => {
        globalThis.queueMicrotask(() => applyEvent(event));
      };
    }

    const selectAccountAndReconnect = async (accountId: string) => {
      const current = get();
      if (current.accountPending) return false;
      if (accountId === current.activeAccountId && current.authorization.kind === "ready") {
        return true;
      }
      const accountSwitching = current.authorization.kind === "ready" &&
        current.accounts.some((account) => account.id === accountId);
      const previousAccountId = current.activeAccountId;
      const discardPreviousAccount = shouldDiscardUnregisteredAccount(
        current.accounts,
        previousAccountId,
        accountId,
      );
      let disconnected = false;
      accountTransition = true;
      accountGeneration += 1;
      retainedMediaRestorer.reset();
      registeredAccountKey = undefined;
      set({
        accountPending: true,
        accountSwitching,
        accountError: undefined,
        error: undefined,
        operationError: undefined,
      });
      try {
        await Promise.all([
          accountRegistration,
          draftSync.flushPending(),
          flushCachedSnapshot(),
        ]);
        await transport.disconnect();
        disconnected = true;
        if (discardPreviousAccount) {
          await transport.removeAccount(previousAccountId);
        }
        applyAccountState(await transport.selectAccount(accountId));
        // Reconnect the selected TDLib database in the existing Store. Keeping the
        // WebView mounted avoids a full-page reload and its repeated blank flashes.
        clearCachedData(false);
        set({
          phase: "idle",
          connectionStatus: "offline",
          authorization: { kind: "preparing" },
          authorizationPending: false,
          authorizationError: undefined,
          accountPending: true,
          accountSwitching,
          accountError: undefined,
          error: undefined,
          operationError: undefined,
        });
        await get().initialize({ preserveAccountPending: true, skipAccountState: true });
        if (get().phase === "error") {
          throw new Error(get().error ?? translate("无法切换账号"));
        }
        accountTransition = false;
        void retainedMediaRestorer.restore();
        void registerCurrentAccount();
        return true;
      } catch (error) {
        accountTransition = false;
        set({
          accountPending: false,
          accountSwitching: false,
          accountError: error instanceof Error ? error.message : translate("无法切换账号"),
        });
        if (disconnected) reloadApplication();
        return false;
      }
    };

    const manageChat = async (
      chatId: string,
      fallbackError: string,
      confirmationError: string,
      operation: () => Promise<void>,
      confirmed: () => boolean,
    ) => {
      const state = get();
      if (
        state.authorization.kind !== "ready" ||
        !state.chats.has(chatId) ||
        state.chatManagementPending.has(chatId)
      ) return false;

      const pending = new Set(state.chatManagementPending);
      pending.add(chatId);
      set({ chatManagementPending: pending, operationError: undefined });
      try {
        await operation();
        if (!confirmed()) throw new Error(confirmationError);
        await flushCachedSnapshot();
        return true;
      } catch (error) {
        set({ operationError: errorMessage(error, fallbackError) });
        return false;
      } finally {
        const latestPending = new Set(get().chatManagementPending);
        latestPending.delete(chatId);
        set({ chatManagementPending: latestPending });
      }
    };

    const manageFolder = async <T,>(
      fallbackError: string,
      confirmationError: string,
      operation: () => Promise<T>,
      confirmed: (result: T) => boolean,
    ): Promise<T | undefined> => {
      if (get().authorization.kind !== "ready" || get().folderManagementPending) {
        return undefined;
      }
      set({ folderManagementPending: true, operationError: undefined });
      try {
        const result = await operation();
        if (!confirmed(result)) throw new Error(confirmationError);
        await flushCachedSnapshot();
        return result;
      } catch (error) {
        set({ operationError: errorMessage(error, fallbackError) });
        return undefined;
      } finally {
        set({ folderManagementPending: false });
      }
    };

    const profileController = createProfileController({
      transport,
      get,
      set,
      scheduleCacheWrite,
      registerCurrentAccount,
      onError: errorMessage,
    });
    const { setOutbox, persistOutboxState, flushOutbox } = createOutboxController({
      transport,
      get,
      set,
      flushCachedSnapshot,
      topicKey,
      onError: errorMessage,
    });
    const forumController = createForumController({
      transport,
      get,
      set,
      topicKey,
      onError: errorMessage,
      onTopicsLoaded: (chatId, query) => {
        if (!query.trim()) {
          forumTopicsRefreshedAt.set(chatId, Date.now());
          if (expectedUnreadReactionCount(chatId) > 0) {
            void refreshUnreadReactionAttention(chatId);
          }
        }
      },
    });
    const touchForumTopic = (chatId: string, topicId: string) => {
      const next = new Map(get().lastForumTopicIds);
      next.delete(chatId);
      next.set(chatId, topicId);
      return next;
    };
    const restorableForumTopicId = (chatId: string, topics = get().forumTopics.get(chatId) ?? []) => {
      const remembered = get().lastForumTopicIds.get(chatId);
      if (remembered && (topics.length === 0 || topics.some((topic) => topic.id === remembered))) {
        return remembered;
      }
      return topics.find((topic) => !topic.isHidden)?.id ?? topics[0]?.id;
    };
    const loadActiveForumTopic = (chatId: string, topicId: string) => {
      if (get().authorization.kind !== "ready") return;
      void loadForumTopicHistory(chatId, topicId, "ensure")
        .then(() => markForumTopicRead(chatId, topicId));
    };
    const refreshForumConversation = async (chatId: string, changed = false) => {
      const topics = get().forumTopics.get(chatId) ?? [];
      const refreshedAt = forumTopicsRefreshedAt.get(chatId) ?? 0;
      const minimumAge = changed
        ? FORUM_TOPICS_CHANGE_COALESCE_MS
        : FORUM_TOPICS_REFRESH_TTL_MS;
      if (topics.length > 0 && Date.now() - refreshedAt < minimumAge) return;
      const page = await forumController.loadForumTopics(chatId);
      if (!page || get().activeChatId !== chatId || !get().chats.get(chatId)?.isForum) return;
      const currentTopicId = get().activeTopicId;
      if (currentTopicId && page.topics.some((topic) => topic.id === currentTopicId)) return;
      const nextTopicId = restorableForumTopicId(chatId, page.topics);
      if (nextTopicId) get().selectForumTopic(nextTopicId);
      else set({ activeTopicId: undefined });
    };
    const sessionController = createSessionController({
      transport,
      set,
      onError: errorMessage,
    });
    const emojiPickerController = createEmojiPickerController({
      transport,
      get,
      set,
      onError: errorMessage,
    });

    return {
      phase: "idle",
      transportKind: transport.kind,
      transportLabel: transport.label,
      connectionStatus: "offline",
      authorization: { kind: "preparing" },
      authorizationPending: false,
      accounts: [],
      activeAccountId: "default",
      accountPending: false,
      accountSwitching: false,
      proxyPending: false,
      storagePending: false,
      cacheUsage: undefined,
      cacheCleanupResult: undefined,
      cacheHealth: "empty",
      users: new Map(),
      userIdsByUsername: new Map(),
      folders: [],
      chats: new Map(),
      chatAdministratorLabels: new Map(),
      chatListReady: false,
      chatLists: new Map(),
      messages: new Map(),
      sponsoredMessages: new Map(),
      subscribeMessageChanges: (listener) => {
        messageChangeListeners.add(listener);
        return () => messageChangeListeners.delete(listener);
      },
      removingMessages: new Map(),
      unreadAttentionMessageIds: new Map(),
      drafts: new Map(),
      localAttachmentDrafts: new Map(),
      typingUserIds: new Map(),
      outbox: [],
      histories: new Map(),
      forumTopics: new Map(),
      forumTopicsLoading: new Set(),
      topicHistories: new Map(),
      lastForumTopicIds: new Map(),
      activeTopicId: undefined,
      searchQuery: "",
      chatFilter: "main",
      globalSearch: emptyGlobalSearch(),
      chatMessageSearch: emptyChatMessageSearch(),
      accountProfile: emptyProfileState(),
      profile: emptyProfileState(),
      contacts: [],
      contactsLoading: false,
      chatManagementPending: new Set(),
      groupManagement: undefined,
      groupManagementLoading: false,
      groupManagementError: undefined,
      blockedSenders: [],
      blockedSendersLoading: false,
      folderManagementPending: false,
      chatCreationPending: false,

      initialize: async (options = {}) => {
        if (get().phase !== "idle") return;
        const settingsOnly = options.settingsOnly === true;
        const preserveAccountPending = options.preserveAccountPending === true;
        const skipAccountState = options.skipAccountState === true;
        set({
          phase: "loading",
          connectionStatus: "connecting",
          error: undefined,
          operationError: undefined,
        });
        try {
          await initializeAccountMetadata().catch((error) => {
            set({ operationError: errorMessage(error, translate("无法加载本地账号数据")) });
          });
          const pendingCleanup = globalThis.localStorage?.getItem("notgram:pending-account-cleanup");
          if (pendingCleanup) {
            await attachmentOutbox.removeAccount(pendingCleanup);
            removeAccountLocalBlocks(pendingCleanup);
            removeAccountActivity(pendingCleanup);
            removeAccountDownloads(pendingCleanup);
            await flushAccountMetadata();
            await transport.removeAccount(pendingCleanup);
            globalThis.localStorage?.removeItem("notgram:pending-account-cleanup");
          }
          if (!skipAccountState) {
            applyAccountState(await transport.getAccountState());
            if (preserveAccountPending) set({ accountPending: true });
          } else if (preserveAccountPending) {
            set({ accountPending: true });
          }
          if (!settingsOnly) {
            let persistedSnapshot: CachedTelegramSnapshot | undefined;
            try {
              persistedSnapshot = await transport.loadCachedSnapshot();
            } catch {
              set({ cacheHealth: "invalid" });
            }
            // Durable drafts remain authoritative even when the replaceable cache is invalid.
            const localState = transport.loadLocalState
              ? migrateLocalUnsentState(await transport.loadLocalState(get().activeAccountId))
              : undefined;
            hydrateCachedSnapshot(persistedSnapshot, localState);
            try {
              await attachmentOutbox.claimLegacy(get().activeAccountId, [
                ...[...get().localAttachmentDrafts.values()].map((draft) => draft.batchId),
                ...get().outbox.filter((item) => item.attachments?.length).map((item) => item.id),
              ]);
            } catch {
              // A corrupt or unavailable cache must not block the live connection.
              set({ cacheHealth: "invalid" });
            }
          }
          const snapshot = await transport.connect(applyEvent, { settingsOnly });
          const chats = new Map(snapshot.chats.map((chat) => [chat.id, chat]));
          const users = new Map(snapshot.users.map((user) => [user.id, user]));
          const folders = snapshot.folders;
          const messages = messageMapFrom(snapshot.messages);
          const drafts = new Map((snapshot.drafts ?? []).map((draft) => [draft.localKey ?? topicKey(draft.chatId, draft.topicId), draft]));
          const current = get();
          for (const [id, chat] of current.chats) chats.set(id, chat);
          for (const [id, user] of current.users) users.set(id, user);
          for (const [chatId, chatMessages] of current.messages) {
            for (const message of chatMessages) {
              messages.set(
                chatId,
                upsertMessage(messages.get(chatId) ?? [], message),
              );
            }
          }
          for (const [chatId, draft] of current.drafts) {
            if (draft.pending || !drafts.has(chatId)) drafts.set(chatId, draft);
          }
          const firstChat = [...chats.values()].sort(
            (left, right) =>
              Number(right.pinned) - Number(left.pinned) ||
              new Date(right.updatedAt).getTime() -
                new Date(left.updatedAt).getTime(),
          )[0];
          const authorization =
            current.authorization.kind === "preparing"
              ? snapshot.authorization
              : current.authorization;
          if (authorization.kind !== "ready" && authorization.kind !== "preparing") {
            clearCachedData();
            set({
              phase: current.phase === "error" ? "error" : "ready",
              authorization,
              accountPending: false,
              accountSwitching: false,
            });
            return;
          }
          set({
            phase: current.phase === "error" ? "error" : "ready",
            currentUserId:
              current.currentUserId && current.currentUserId !== "self"
                ? current.currentUserId
                : snapshot.currentUserId,
            authorization,
            chats,
            chatListReady: current.chatListReady || snapshot.chats.length > 0,
            users,
            userIdsByUsername: usernameIndexForUsers(users.values()),
            folders: current.folders.length > 0 ? current.folders : folders,
            messages,
            drafts,
            activeChatId: current.activeChatId ?? firstChat?.id,
            chatFilter:
              (current.folders.length > 0 ? current.folders : folders).some(
                (folder) => folder.id === current.chatFilter,
              )
                ? current.chatFilter
                : (folders[0]?.id ?? "main"),
            accountPending: false,
            accountSwitching: false,
          });
          const initialChatId = get().activeChatId;
          if (initialChatId && get().chats.get(initialChatId)?.kind === "channel") {
            void get().loadChatSponsoredMessages(initialChatId);
          }
          for (const chatMessages of messages.values()) {
            addUnreadReactionAttention(chatMessages);
            queueBlockedReactionReads(chatMessages);
          }
          if (authorization.kind === "ready" && get().connectionStatus === "online") {
            for (const chat of chats.values()) {
              if ((chat.unreadReactionCount ?? 0) > 0) void refreshUnreadReactionAttention(chat.id);
            }
          }
          publishMessageChange({ type: "reset", messages });
          void retainedMediaRestorer.restore();
          void registerCurrentAccount();
          if (settingsOnly) return;
          const refreshChatId = get().activeChatId ?? firstChat?.id;
          if (
            authorization.kind === "ready" &&
            get().connectionStatus === "online" &&
            refreshChatId
          ) {
            if (get().chats.get(refreshChatId)?.isForum) {
              const activeTopicId = get().activeTopicId;
              if (activeTopicId) loadActiveForumTopic(refreshChatId, activeTopicId);
              await refreshForumConversation(refreshChatId);
            } else {
              await loadHistory(refreshChatId, "ensure");
              await markChatRead(refreshChatId);
            }
          }
          if (authorization.kind === "ready") {
            draftSync.resumePending();
            void flushOutbox();
          }
          scheduleCacheWrite();
        } catch (error) {
          const browserTauriMismatch = !isTauri() && transport.kind === "tauri";
          set({
            phase: "error",
            connectionStatus: "offline",
            accountPending: false,
            accountSwitching: false,
            error: browserTauriMismatch
              ? translate("当前配置需要 Notgram 桌面版；浏览器预览请将 VITE_TELEGRAM_TRANSPORT 设置为 mock")
              : errorMessage(error, translate("无法启动 Telegram runtime")),
          });
        }
      },

      authenticate: async (action) => {
        set({ authorizationPending: true, authorizationError: undefined });
        try {
          await transport.authenticate(action);
        } catch (error) {
          set({
            authorizationPending: false,
            authorizationError:
              error instanceof Error ? error.message : translate("登录请求失败"),
          });
        }
      },

      loadProxySettings: async () => {
        set({ proxyPending: true, proxyError: undefined, proxyLatencyMs: undefined });
        try {
          const proxySettings = await transport.getProxySettings();
          set({ proxySettings, proxyPending: false });
        } catch (error) {
          set({
            proxyPending: false,
            proxyError: error instanceof Error ? error.message : translate("无法读取代理设置"),
          });
        }
      },

      saveProxySettings: async (proxySettings) => {
        set({ proxyPending: true, proxyError: undefined, proxyLatencyMs: undefined });
        try {
          await transport.saveProxySettings(proxySettings);
          set({ proxySettings: await transport.getProxySettings(), proxyPending: false });
          return true;
        } catch (error) {
          set({
            proxyPending: false,
            proxyError: error instanceof Error ? error.message : translate("无法保存代理设置"),
          });
          return false;
        }
      },

      testProxy: async (proxySettings) => {
        set({ proxyPending: true, proxyError: undefined, proxyLatencyMs: undefined });
        try {
          const proxyLatencyMs = await transport.testProxy(proxySettings);
          set({ proxyLatencyMs, proxyPending: false });
        } catch (error) {
          set({
            proxyPending: false,
            proxyError: error instanceof Error ? error.message : translate("代理连接失败"),
          });
        }
      },

      loadStorageSettings: async () => {
        set({ storagePending: true, storageError: undefined });
        try {
          const storageSettings = await transport.getStorageSettings();
          set({ storageSettings, storagePending: false });
        } catch (error) {
          set({
            storagePending: false,
            storageError: error instanceof Error ? error.message : translate("无法读取存储路径设置"),
          });
        }
      },

      saveStorageSettings: async (storageSettings) => {
        set({ storagePending: true, storageError: undefined });
        try {
          const saved = await transport.saveStorageSettings(storageSettings);
          set({ storageSettings: saved, storagePending: false });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({
            storagePending: false,
            storageError: error instanceof Error ? error.message : translate("无法保存存储路径设置"),
          });
          return false;
        }
      },

      getStorageInventory: () => transport.getStorageInventory(),

      removeMigrationBackup: (id) => transport.removeMigrationBackup(id),

      loadCacheUsage: async () => {
        set({ storagePending: true, storageError: undefined });
        try {
          const cacheUsage = await transport.getCacheUsage();
          set({ cacheUsage, storagePending: false });
        } catch (error) {
          set({
            storagePending: false,
            storageError: error instanceof Error ? error.message : translate("无法统计媒体缓存"),
          });
        }
      },

      clearMediaCache: async (categories, olderThanDays) => {
        if (categories.length === 0) {
          set({ storageError: translate("至少选择一种缓存类型") });
          return false;
        }
        const current = get();
        set({ storagePending: true, storageError: undefined, cacheCleanupResult: undefined });
        try {
          const result = await transport.clearMediaCache({
            categories,
            olderThanDays,
            protectedPaths: protectedCachePaths({
              accounts: current.accounts,
              users: current.users.values(),
              chats: current.chats.values(),
              messages: current.messages.values(),
            }),
          });
          emojiPickerController.reset();
          set({
            cacheUsage: result.usage,
            cacheCleanupResult: result,
            storagePending: false,
          });
          return true;
        } catch (error) {
          set({
            storagePending: false,
            storageError: error instanceof Error ? error.message : translate("无法清理媒体缓存"),
          });
          return false;
        }
      },

      rebuildCachedSnapshot: async () => {
        const current = get();
        if (current.authorization.kind !== "ready" || !current.currentUserId) {
          set({ storageError: translate("Telegram 就绪后才能重建界面缓存") });
          return false;
        }
        cancelScheduledCacheWrite();
        set({ storagePending: true, storageError: undefined });
        try {
          await cacheWrite.catch(() => undefined);
          await transport.clearCachedSnapshot();
          await transport.saveCachedSnapshot(cachedSnapshotFrom(
            get(),
            profileController.getCachedProfiles(),
          ));
          set({ cacheHealth: "rebuilt", storagePending: false });
          return true;
        } catch (error) {
          set({
            cacheHealth: "invalid",
            storagePending: false,
            storageError: error instanceof Error ? error.message : translate("无法重建界面缓存"),
          });
          return false;
        }
      },

      addAccount: async () => {
        const accountId = `account-${globalThis.crypto.randomUUID()}`;
        return selectAccountAndReconnect(accountId);
      },

      switchAccount: selectAccountAndReconnect,

      logOutCurrentAccount: async () => {
        const accountId = get().activeAccountId;
        let disconnected = false;
        accountTransition = true;
        registeredAccountKey = undefined;
        set({
          accountPending: true,
          accountSwitching: false,
          accountError: undefined,
          error: undefined,
          operationError: undefined,
        });
        try {
          await accountRegistration;
          await draftSync.flushPending();
          await flushCachedSnapshot();
          await transport.logOut();
          globalThis.localStorage?.setItem("notgram:pending-account-cleanup", accountId);
          await transport.disconnect();
          disconnected = true;
          await attachmentOutbox.removeAccount(accountId);
          removeAccountLocalBlocks(accountId);
          removeAccountActivity(accountId);
          removeAccountDownloads(accountId);
          await flushAccountMetadata();
          globalThis.localStorage?.removeItem(`notgram:cache-cleanup:${accountId}`);
          applyAccountState(await transport.removeAccount(accountId));
          globalThis.localStorage?.removeItem("notgram:pending-account-cleanup");
          reloadApplication();
          return true;
        } catch (error) {
          accountTransition = false;
          set({
            accountPending: false,
            accountSwitching: false,
            accountError: error instanceof Error ? error.message : translate("退出登录失败"),
          });
          if (disconnected) set({ phase: "error", error: translate("账号已退出，本地数据清理未完成。重启后将继续清理。") });
          return false;
        }
      },

      selectChat: (chatId, options) => {
        if (!get().chats.has(chatId)) {
          set({ operationError: translate("会话不存在或当前账号无权访问") });
          return;
        }
        const previousChatId = get().activeChatId;
        const previousTopicId = get().activeTopicId;
        if (previousChatId && previousChatId !== chatId) {
          void draftSync.flush(topicKey(previousChatId, previousTopicId));
        }
        const targetChat = get().chats.get(chatId);
        const restoredTopicId = targetChat?.isForum
          ? options?.forumTopicId ?? restorableForumTopicId(chatId)
          : undefined;
        if (previousChatId !== chatId || previousTopicId !== restoredTopicId) {
          advanceConversationGeneration();
        }
        transport.setConversationFocus?.(chatId);
        const lastForumTopicIds = restoredTopicId
          ? touchForumTopic(chatId, restoredTopicId)
          : new Map(get().lastForumTopicIds);
        set({
          activeChatId: chatId,
          activeTopicId: restoredTopicId,
          lastForumTopicIds,
        });
        scheduleCacheWrite();
        if (get().authorization.kind !== "ready") return;
        if (targetChat?.isForum) {
          if (restoredTopicId) loadActiveForumTopic(chatId, restoredTopicId);
          void refreshForumConversation(chatId);
        } else {
          if (!options?.deferHistory) void loadHistory(chatId, "ensure");
          void markChatRead(chatId);
          if (targetChat?.kind === "channel") void get().loadChatSponsoredMessages(chatId);
        }
        if ((targetChat?.unreadReactionCount ?? 0) > 0) {
          void refreshUnreadReactionAttention(chatId);
        }
      },

      selectForumTopic: (topicId) => {
        const chatId = get().activeChatId;
        if (!chatId || !get().chats.get(chatId)?.isForum) return;
        const previousTopicId = get().activeTopicId;
        if (previousTopicId && previousTopicId !== topicId) void draftSync.flush(topicKey(chatId, previousTopicId));
        if (previousTopicId !== topicId) advanceConversationGeneration();
        const lastForumTopicIds = topicId
          ? touchForumTopic(chatId, topicId)
          : new Map(get().lastForumTopicIds);
        set({ activeTopicId: topicId, lastForumTopicIds });
        scheduleCacheWrite();
        if (topicId) loadActiveForumTopic(chatId, topicId);
      },

      loadForumTopics: forumController.loadForumTopics,
      resolveForumTopic: forumController.resolveForumTopic,
      createForumTopic: forumController.createForumTopic,
      editForumTopic: forumController.editForumTopic,
      setForumTopicClosed: forumController.setForumTopicClosed,
      setForumTopicPinned: forumController.setForumTopicPinned,

      resolveTelegramLink: async (url) => {
        const accountId = get().activeAccountId;
        try {
          const target = await transport.resolveTelegramLink(url);
          if (get().activeAccountId !== accountId) return undefined;
          if (target && "kind" in target && target.kind === "stickerSet") emojiPickerController.rememberStickerSet(target.stickerSet);
          if (target && "kind" in target && target.kind === "unsupported") {
            set({ operationError: target.reason });
          } else if (!target) {
            set({ operationError: translate("无法识别或打开此 Telegram 链接") });
          } else {
            set({ operationError: undefined });
          }
          return target;
        } catch (error) {
          if (get().activeAccountId !== accountId) return undefined;
          set({ operationError: error instanceof Error ? error.message : translate("Telegram 链接无法打开") });
          return undefined;
        }
      },

      loadMoreChats: loadChats,
      setChatPinned: (chatListId, chatId, pinned) => manageChat(
        chatId,
        translate("无法更新置顶状态"),
        translate("Telegram 未确认置顶状态"),
        () => transport.setChatPinned(chatListId, chatId, pinned),
        () => {
          const chat = get().chats.get(chatId);
          return Boolean(chat) && isChatPinnedInFolder(chat!, chatListId) === pinned;
        },
      ),
      reorderPinnedChats: async (chatListId, orderedChatIds) => {
        const pinnedChats = filterAndSortChats(get().chats.values(), chatListId, "")
          .filter((chat) => isChatPinnedInFolder(chat, chatListId));
        const currentIds = pinnedChats.map((chat) => chat.id);
        const uniqueIds = [...new Set(orderedChatIds)];
        if (
          uniqueIds.length !== currentIds.length ||
          uniqueIds.some((chatId) => !currentIds.includes(chatId))
        ) return false;
        if (uniqueIds.every((chatId, index) => chatId === currentIds[index])) return true;

        const originalChats = new Map(pinnedChats.map((chat) => [chat.id, chat]));
        const optimisticOrders = new Map<string, string>();
        const chats = new Map(get().chats);
        const rankBase = BigInt(uniqueIds.length);
        for (const [index, chatId] of uniqueIds.entries()) {
          const chat = chats.get(chatId);
          if (!chat) return false;
          const order = String(rankBase - BigInt(index));
          optimisticOrders.set(chatId, order);
          chats.set(chatId, {
            ...chat,
            listOrderByFolder: { ...chat.listOrderByFolder, [chatListId]: order },
          });
        }
        set({ chats, operationError: undefined });

        try {
          await transport.setPinnedChats(chatListId, uniqueIds);
          await flushCachedSnapshot();
          return true;
        } catch (error) {
          const latestChats = get().chats;
          const stillOptimistic = uniqueIds.every((chatId) =>
            latestChats.get(chatId)?.listOrderByFolder?.[chatListId] ===
              optimisticOrders.get(chatId),
          );
          if (stillOptimistic) {
            const rollback = new Map(latestChats);
            for (const [chatId, chat] of originalChats) rollback.set(chatId, chat);
            set({ chats: rollback });
          }
          set({
            operationError: error instanceof Error ? error.message : translate("无法调整置顶顺序"),
          });
          return false;
        }
      },
      setChatMuted: (chatId, muted) => {
        if (get().chats.get(chatId)?.kind === "saved") {
          set({ operationError: translate("收藏夹不支持静音") });
          return Promise.resolve(false);
        }
        return manageChat(
          chatId,
          translate("无法更新通知设置"),
          translate("Telegram 未确认静音状态"),
          () => transport.setChatMuted(chatId, muted),
          () => get().chats.get(chatId)?.muted === muted,
        );
      },
      setChatArchived: (chatId, archived) => manageChat(
        chatId,
        archived ? translate("无法归档会话") : translate("无法移出归档"),
        translate("Telegram 未确认{{value0}}状态", {
          value0: archived ? translate("归档") : translate("取消归档"),
        }),
        () => transport.setChatArchived(chatId, archived),
        () => get().chats.get(chatId)?.folderIds.includes(
          archived ? "archive" : "main",
        ) === true,
      ),
      leaveGroup: async (chatId) => {
        const chat = get().chats.get(chatId);
        if (chat?.kind !== "group") {
          set({ operationError: translate("只能退出群组会话") });
          return false;
        }
        const succeeded = await manageChat(
          chatId,
          translate("无法退出群组"),
          translate("Telegram 未确认退出群组"),
          () => transport.leaveChat(chatId),
          () => get().chats.get(chatId)?.folderIds.length === 0,
        );
        if (!succeeded || get().activeChatId !== chatId) return succeeded;

        const nextChat = filterAndSortChats(
          get().chats.values(),
          get().chatFilter,
          "",
        )[0];
        const lastForumTopicIds = new Map(get().lastForumTopicIds);
        lastForumTopicIds.delete(chatId);
        set({ lastForumTopicIds });
        if (nextChat) get().selectChat(nextChat.id);
        else {
          set({ activeChatId: undefined, activeTopicId: undefined });
          scheduleCacheWrite();
        }
        return true;
      },
      createChatFolder: async (title, chatIds) => {
        const uniqueChatIds = [...new Set(chatIds)].filter((chatId) => get().chats.has(chatId));
        if (uniqueChatIds.length === 0) {
          set({ operationError: translate("请至少选择一个会话") });
          return undefined;
        }
        const folder = await manageFolder(
          translate("无法创建文件夹"),
          translate("Telegram 未确认新文件夹"),
          () => transport.createChatFolder(title, uniqueChatIds),
          (created) => get().folders.some((item) =>
            item.id === created.id && item.title === created.title
          ) && uniqueChatIds.every((chatId) =>
            get().chats.get(chatId)?.folderIds.includes(created.id)
          ),
        );
        return folder?.id;
      },
      renameChatFolder: async (folderId, title) => Boolean(await manageFolder(
        translate("无法重命名文件夹"),
        translate("Telegram 未确认文件夹名称"),
        () => transport.renameChatFolder(folderId, title),
        (renamed) => get().folders.some((folder) =>
          folder.id === folderId && folder.title === renamed.title
        ),
      )),
      deleteChatFolder: async (folderId) => Boolean(await manageFolder(
        translate("无法删除文件夹"),
        translate("Telegram 未确认文件夹删除"),
        async () => {
          await transport.deleteChatFolder(folderId);
          return true;
        },
        () => !get().folders.some((folder) => folder.id === folderId) &&
          [...get().chats.values()].every((chat) => !chat.folderIds.includes(folderId)),
      )),
      reorderChatFolders: async (orderedFolderIds) => {
        const state = get();
        const reorderableFolders = state.folders.filter((folder) => folder.id !== "archive");
        const currentIds = reorderableFolders.map((folder) => folder.id);
        const uniqueIds = [...new Set(orderedFolderIds)];
        if (
          state.authorization.kind !== "ready" ||
          state.folderManagementPending ||
          uniqueIds.length !== currentIds.length ||
          uniqueIds.some((folderId) => !currentIds.includes(folderId))
        ) return false;
        if (uniqueIds.every((folderId, index) => folderId === currentIds[index])) return true;

        const originalFolders = state.folders;
        const byId = new Map(reorderableFolders.map((folder) => [folder.id, folder]));
        const optimisticFolders = [
          ...uniqueIds.map((folderId) => byId.get(folderId)!),
          ...state.folders.filter((folder) => folder.id === "archive"),
        ];
        set({
          folders: optimisticFolders,
          folderManagementPending: true,
          operationError: undefined,
        });
        try {
          await transport.reorderChatFolders(uniqueIds);
          const confirmedIds = get().folders
            .filter((folder) => folder.id !== "archive")
            .map((folder) => folder.id);
          if (!uniqueIds.every((folderId, index) => folderId === confirmedIds[index])) {
            throw new Error(translate("Telegram 未确认文件夹顺序"));
          }
          await flushCachedSnapshot();
          return true;
        } catch (error) {
          const latestIds = get().folders
            .filter((folder) => folder.id !== "archive")
            .map((folder) => folder.id);
          if (uniqueIds.every((folderId, index) => folderId === latestIds[index])) {
            set({ folders: originalFolders });
          }
          set({ operationError: errorMessage(error, translate("无法调整文件夹顺序")) });
          return false;
        } finally {
          set({ folderManagementPending: false });
        }
      },
      setChatFolderMembership: async (folderId, chatId, included) => Boolean(
        await manageFolder(
          translate("无法更新文件夹成员"),
          translate("Telegram 未确认文件夹成员状态"),
          async () => {
            await transport.setChatFolderMembership(folderId, chatId, included);
            return true;
          },
          () => get().chats.get(chatId)?.folderIds.includes(folderId) === included,
        )
      ),
      markChatFolderRead: async (folderId) => {
        const state = get();
        if (
          state.authorization.kind !== "ready" ||
          state.folderManagementPending ||
          !state.folders.some((folder) => folder.id === folderId)
        ) return false;
        const unreadChatIds = [...state.chats.values()]
          .filter((chat) => chat.folderIds.includes(folderId) && chat.unreadCount > 0)
          .map((chat) => chat.id);
        if (unreadChatIds.length === 0) return true;

        set({ folderManagementPending: true, operationError: undefined });
        try {
          const results = await Promise.all(
            unreadChatIds.map((chatId) => markChatRead(chatId, false)),
          );
          if (results.some((result) => !result)) return false;
          scheduleCacheWrite();
          return true;
        } finally {
          set({ folderManagementPending: false });
        }
      },
      loadMoreHistory: (chatId) => {
        const topicId = get().activeChatId === chatId ? get().activeTopicId : undefined;
        return topicId ? loadForumTopicHistory(chatId, topicId, "older") : loadHistory(chatId, "older");
      },
      loadChatSponsoredMessages: async (chatId) => {
        if (get().authorization.kind !== "ready" || get().chats.get(chatId)?.kind !== "channel") return;
        try {
          const sponsored = await transport.getChatSponsoredMessages(chatId);
          if (get().chats.get(chatId)?.kind !== "channel") return;
          const next = new Map(get().sponsoredMessages);
          next.set(chatId, sponsored);
          set({ sponsoredMessages: next });
        } catch {
          // Sponsored messages are optional and unavailable on older TDLib builds.
        }
      },
      clickChatSponsoredMessage: (chatId, messageId, isMediaClick = false) =>
        transport.clickChatSponsoredMessage(chatId, messageId, isMediaClick),
      loadMessage: async (chatId, messageId, options) => {
        const generation = accountGeneration;
        const navigationGeneration = conversationGeneration;
        const isCurrent = () => generation === accountGeneration &&
          options?.isCurrent?.() !== false && (!options?.onlyIfActive || (
            get().activeChatId === chatId && navigationGeneration === conversationGeneration
          ));
        if (!isCurrent()) return false;
        if (!options?.forceContext && (get().messages.get(chatId) ?? []).some((message) => message.id === messageId)) {
          return true;
        }
        if (get().authorization.kind !== "ready") return false;
        try {
          // The entry context and the first history page are independent TDLib
          // reads.  Do not serialize them behind the initial page: a cold chat
          // otherwise pays both network round trips before its target can settle.
          // Generation checks below make either result safe to merge when it
          // arrives first, and active-only callers still discard stale results.
          if (!isCurrent()) return false;
          if (!options?.forceContext && (get().messages.get(chatId) ?? []).some((message) => message.id === messageId)) {
            return true;
          }
          const context = await transport.getMessageContext(chatId, messageId, 31);
          if (!isCurrent()) return false;
          let message = context.find((item) =>
            item.chatId === chatId && item.id === messageId
          );
          if (!message) message = await transport.getMessage(chatId, messageId);
          if (!isCurrent()) return false;
          if (!message || message.chatId !== chatId || message.id !== messageId) return false;
          const messages = new Map(get().messages);
          messages.set(
            chatId,
            upsertMessages(
              messages.get(chatId) ?? [],
              [...context.filter((item) => item.chatId === chatId), message],
            ),
          );
          set({ messages, operationError: undefined });
          publishMessageChange({
            type: "upsert",
            messages: [...context.filter((item) => item.chatId === chatId), message],
            liveMessages: [],
          });
          scheduleCacheWrite();
          return true;
        } catch {
          return false;
        }
      },
      loadMessageThreadHistory: async (chatId, messageId, limit = 100, fromMessageId) => {
        if (get().authorization.kind !== "ready") return undefined;
        const generation = accountGeneration;
        try {
          // A channel post's comments live in its linked discussion chat. Resolve
          // that chat and root message before asking TDLib for the history; using
          // the channel id for both requests can produce an unexpected-chat error.
          const reference = fromMessageId
            ? get().messages.get(chatId)?.find(message => message.id === messageId)?.discussionThread
            : undefined;
          const thread = reference ? { ...reference, messages: [] } : await transport.getMessageThread(chatId, messageId);
          if (generation !== accountGeneration) return undefined;
          if (!thread) return { chatId, messageId, messages: [], hasMore: false };
          let page: import("../telegram/types").MessageThreadHistoryPage;
          let historyError = false;
          try {
            page = await transport.getMessageThreadHistory(thread.chatId, thread.messageId, limit, fromMessageId);
          } catch {
            historyError = true;
            page = { messages: [], nextFromMessageId: fromMessageId, hasMore: true };
          }
          if (generation !== accountGeneration) return undefined;
          const threadMessages = [...thread.messages, ...page.messages];
          const uniqueThreadMessages = [...new Map(
            threadMessages.map((message) => [`${message.chatId}:${message.id}`, message]),
          ).values()];
          const messages = new Map(get().messages);
          const channelPost = messages.get(chatId)?.find((message) => message.id === messageId)
            ?? uniqueThreadMessages.find((message) => message.chatId === chatId && message.id === messageId);
          const resolvedChannelPost = channelPost
            ? {
                ...channelPost,
                discussionThread: { chatId: thread.chatId, messageId: thread.messageId },
              }
            : undefined;
          const cacheMessages = resolvedChannelPost
            ? [...uniqueThreadMessages, resolvedChannelPost]
            : uniqueThreadMessages;
          const messagesByChat = new Map<string, Message[]>();
          for (const message of cacheMessages) {
            const current = messagesByChat.get(message.chatId) ?? messages.get(message.chatId) ?? [];
            messagesByChat.set(message.chatId, upsertMessage(current, message));
          }
          for (const [messageChatId, nextMessages] of messagesByChat) {
            messages.set(messageChatId, nextMessages);
          }
          set({ messages, operationError: undefined });
          publishMessageChange({ type: "upsert", messages: cacheMessages, liveMessages: [] });
          scheduleCacheWrite();
          return { ...page, chatId: thread.chatId, messageId: thread.messageId, messages: uniqueThreadMessages, error: historyError };
        } catch (error) {
          if (generation !== accountGeneration) return undefined;
          const message = error instanceof Error ? error.message : String(error);
          if (/message has no (thread|comments)|can't get message thread/i.test(message)) {
            set({ operationError: undefined });
            return { chatId, messageId, messages: [], hasMore: false };
          }
          set({ operationError: errorMessage(error, translate("无法加载帖子留言")) });
          return undefined;
        }
      },
      sendMessageToThread: (chatId, replyToMessageId, text, entities, replyQuote, options) =>
        get().sendMessage(text, replyToMessageId, replyQuote, entities, options?.disableNotification, {
          chatId,
          discussionThreadId: options?.threadId ?? get().messages.get(chatId)?.find(message => message.id === replyToMessageId)?.topicId ?? replyToMessageId,
          clearDraft: false,
        }),
      sendFilesToThread: (chatId, replyToMessageId, attachments, caption, captionEntities, replyQuote, options) =>
        get().sendFiles(attachments, caption, captionEntities, replyToMessageId, replyQuote, options?.disableNotification, {
          chatId,
          discussionThreadId: options?.threadId ?? get().messages.get(chatId)?.find(message => message.id === replyToMessageId)?.topicId ?? replyToMessageId,
          clearDraft: false,
        }),
      markActiveChatRead: async () => {
        const chatId = get().activeChatId;
        if (chatId) await markActiveConversationRead(chatId);
      },
      markMessageThreadRead: async (chatId, messageIds) => {
        if (get().authorization.kind !== "ready" || get().connectionStatus !== "online" || !documentIsVisible()) return false;
        const requested = new Set(messageIds);
        const visibleIds = (get().messages.get(chatId) ?? [])
          .filter(message => requested.has(message.id) && !message.outgoing && !outboxItemId(message.id))
          .map(message => message.id);
        if (!visibleIds.length) return true;
        try {
          await transport.markMessageThreadRead(chatId, visibleIds);
          return true;
        } catch {
          return false;
        }
      },
      markLocalBlockedUserReactionsRead: async (userId) => {
        const blockedSenderIds = localBlockedReactionUserIds();
        if (userId) blockedSenderIds.add(userId);
        const chatIds = new Set<string>();
        for (const [chatId, messages] of get().messages) {
          if (messages.some((message) => messageHasUnreadLocalBlockedReaction(message, blockedSenderIds))) {
            chatIds.add(chatId);
          }
        }
        await Promise.all([...chatIds].map((chatId) => markBlockedChatReactionsRead(chatId)));
      },

      dismissMessageAttention: (chatId, messageIds) => {
        const uniqueMessageIds = [...new Set(messageIds.filter(Boolean))];
        markSeenChatReactionsRead(chatId, uniqueMessageIds);
        const chatMessages = get().messages.get(chatId) ?? [];
        const pendingMessageIds = uniqueMessageIds.filter((messageId) => {
          const key = `${chatId}:${messageId}`;
          const message = chatMessages.find((candidate) => candidate.id === messageId);
          return Boolean(
            message && messageHasPrimaryAttention(message) &&
            !attentionReadRequests.has(key) && !acknowledgedAttentionMessages.has(key),
          );
        });
        if (pendingMessageIds.length === 0) return;
        const requestGeneration = attentionReadGeneration;
        for (const messageId of pendingMessageIds) {
          attentionReadRequests.add(`${chatId}:${messageId}`);
        }
        void transport.markMessageAttentionRead(chatId, pendingMessageIds)
          .then(() => {
            if (requestGeneration !== attentionReadGeneration) return;
            const unreadAttentionMessageIds = new Map(get().unreadAttentionMessageIds);
            const readIds = new Set(pendingMessageIds.filter((messageId) =>
              get().messages.get(chatId)?.find((message) => message.id === messageId)
                ?.containsUnreadReaction !== true,
            ));
            const remaining = (unreadAttentionMessageIds.get(chatId) ?? [])
              .filter((candidate) => !readIds.has(candidate));
            if (remaining.length > 0) unreadAttentionMessageIds.set(chatId, remaining);
            else unreadAttentionMessageIds.delete(chatId);
            for (const messageId of pendingMessageIds) {
              acknowledgedAttentionMessages.add(`${chatId}:${messageId}`);
            }
            while (acknowledgedAttentionMessages.size > 2_048) {
              acknowledgedAttentionMessages.delete(
                acknowledgedAttentionMessages.values().next().value!,
              );
            }
            set({ unreadAttentionMessageIds });
          })
          .catch((error) => {
            if (requestGeneration !== attentionReadGeneration) return;
            set({ operationError: errorMessage(error, translate("无法更新提醒已读状态")) });
          })
          .finally(() => {
            if (requestGeneration !== attentionReadGeneration) return;
            for (const messageId of pendingMessageIds) {
              attentionReadRequests.delete(`${chatId}:${messageId}`);
            }
          });
      },

      loadMessageProperties: async (chatId, messageId, force = false) => {
        const requestedMessage = (get().messages.get(chatId) ?? [])
          .find((message) => message.id === messageId);
        if (!requestedMessage) return undefined;
        if (!connectionPresentation(get().connectionStatus).operational) return requestedMessage.permissions;
        if (requestedMessage.permissions && !force) return requestedMessage.permissions;
        try {
          const permissions = await transport.getMessageProperties(chatId, messageId);
          const currentMessages = get().messages.get(chatId) ?? [];
          const message = currentMessages.find((item) => item.id === messageId);
          if (!message || message !== requestedMessage) return undefined;
          const messages = new Map(get().messages);
          messages.set(chatId, upsertMessage(currentMessages, { ...message, permissions }));
          set({ messages, operationError: undefined });
          return permissions;
        } catch (error) {
          set({
            operationError: error instanceof Error ? error.message : translate("无法读取消息操作权限"),
          });
          return undefined;
        }
      },

      loadRawMessage: async (chatId, messageId) => {
        try {
          const raw = await transport.getRawMessage(chatId, messageId);
          if (!raw) {
            set({ operationError: translate("找不到原始消息") });
            return undefined;
          }
          set({ operationError: undefined });
          return raw;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("无法读取原始消息")) });
          return undefined;
        }
      },

      searchChatMessages: searchController.searchChatMessages,
      loadMoreChatMessages: searchController.loadMoreChatMessages,
      cancelChatMessageSearch: searchController.cancelChatMessageSearch,
      clearChatMessageSearch: searchController.clearChatMessageSearch,
      searchGlobal: searchController.searchGlobal,
      loadMoreGlobalSearch: searchController.loadMoreGlobalSearch,
      cancelGlobalSearch: searchController.cancelGlobalSearch,
      clearGlobalSearch: searchController.clearGlobalSearch,

      loadCurrentUserProfile: profileController.loadCurrentUserProfile,
      updateCurrentUserProfile: profileController.updateCurrentUserProfile,
      changeCurrentUserAvatar: profileController.changeCurrentUserAvatar,

      loadChatProfile: profileController.loadChatProfile,

      loadMoreChatProfileMembers: profileController.loadMoreChatProfileMembers,

      loadUserProfile: profileController.loadUserProfile,

      clearProfile: profileController.clearProfile,

      loadContacts: profileController.loadContacts,

      startPrivateChat: async (userId) => {
        set({ contactPendingUserId: userId, contactsError: undefined });
        try {
          const chat = await transport.createPrivateChat(userId);
          const chats = new Map(get().chats);
          chats.set(chat.id, chat);
          set({ chats, contactPendingUserId: undefined });
          scheduleCacheWrite();
          return chat.id;
        } catch (error) {
          set({
            contactPendingUserId: undefined,
            contactsError: errorMessage(error, translate("无法发起私聊")),
          });
          return undefined;
        }
      },

      createChat: async (input) => {
        if (get().chatCreationPending) return undefined;
        set({ chatCreationPending: true, operationError: undefined });
        try {
          const chat = await transport.createChat(input);
          const chats = new Map(get().chats);
          chats.set(chat.id, chat);
          const messages = new Map(get().messages);
          if (!messages.has(chat.id)) messages.set(chat.id, []);
          set({
            chats,
            messages,
            activeChatId: chat.id,
            chatCreationPending: false,
            chatFilter: "main",
          });
          scheduleCacheWrite();
          return chat.id;
        } catch (error) {
          set({
            chatCreationPending: false,
            operationError: errorMessage(error, translate("无法创建群组或频道")),
          });
          return undefined;
        }
      },

      loadChatManagement: (chatId, memberOffset = 0) => {
        if (!requireManagementCapability(chatId, "canOpenManagement", translate("当前账号没有群组管理权限"))) {
          set({ groupManagement: undefined, groupManagementLoading: false, groupManagementError: translate("当前账号没有群组管理权限") });
          return Promise.resolve(undefined);
        }
        const key = `${chatId}:${memberOffset}`;
        const existing = groupManagementLoads.get(key);
        if (existing) return existing;
        const request = (async () => {
          set({ groupManagementLoading: true, groupManagementError: undefined });
          try {
            const value = await transport.getChatManagement(chatId, memberOffset);
            const current = get().groupManagement;
            const merged = memberOffset > 0 && current?.chatId === chatId
              ? {
                  ...value,
                  members: [
                    ...current.members,
                    ...value.members.filter((member) => !current.members.some((item) => item.user.id === member.user.id)),
                  ],
                  memberOffset: 0,
                }
              : value;
            const chats = new Map(get().chats);
            const chat = chats.get(chatId);
            if (chat) chats.set(chatId, { ...chat, management: value.capabilities });
            const chatAdministratorLabels = new Map(get().chatAdministratorLabels);
            chatAdministratorLabels.set(chatId, value.administratorLabels ?? {});
            set({
              chats,
              chatAdministratorLabels,
              groupManagement: merged,
              groupManagementLoading: false,
            });
            return merged;
          } catch (error) {
            set({ groupManagementLoading: false, groupManagementError: errorMessage(error, translate("无法读取群组管理资料")) });
            return undefined;
          } finally {
            groupManagementLoads.delete(key);
          }
        })();
        groupManagementLoads.set(key, request);
        return request;
      },

      loadChatAdministratorLabels: (chatId, force = false) => {
        const chat = get().chats.get(chatId);
        if (!chat || (chat.kind !== "group" && chat.kind !== "channel")) {
          return Promise.resolve({});
        }
        const cached = get().chatAdministratorLabels.get(chatId);
        if (cached && !force) return Promise.resolve(cached);
        const existing = chatAdministratorLabelLoads.get(chatId);
        if (existing) return existing;
        const generation = chatAdministratorLabelsGeneration;
        const request = transport.getChatAdministratorLabels(chatId).catch(() => ({})).then((labels) => {
          if (generation !== chatAdministratorLabelsGeneration) return labels;
          const chatAdministratorLabels = new Map(get().chatAdministratorLabels);
          chatAdministratorLabels.set(chatId, labels);
          set({ chatAdministratorLabels });
          return labels;
        }).finally(() => {
          if (chatAdministratorLabelLoads.get(chatId) === request) {
            chatAdministratorLabelLoads.delete(chatId);
          }
        });
        chatAdministratorLabelLoads.set(chatId, request);
        return request;
      },

      addChatMembers: async (chatId, userIds) => {
        if (!requireManagementCapability(chatId, "canAddMembers", translate("当前账号没有邀请成员权限"))) return false;
        try {
          await transport.addChatMembers(chatId, userIds);
          await get().loadChatManagement(chatId, 0);
          set({ operationError: undefined });
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("无法添加成员")) });
          return false;
        }
      },

      setChatMemberStatus: async (chatId, userId, status) => {
        const management = get().groupManagement?.chatId === chatId ? get().groupManagement : undefined;
        const member = management?.members.find((item) => item.user.id === userId);
        const capability = status.kind === "administrator" || member?.status === "administrator"
          ? "canPromoteMembers"
          : status.kind === "restricted" || status.kind === "banned" || member?.status === "restricted" || member?.status === "banned"
            ? "canRestrictMembers"
            : member?.status === "left" ? "canAddMembers" : undefined;
        if (capability && !requireManagementCapability(
          chatId,
          capability,
          capability === "canPromoteMembers"
            ? translate("当前账号没有管理员任免权限")
            : capability === "canRestrictMembers" ? translate("当前账号没有限制成员权限") : translate("当前账号没有邀请成员权限"),
        )) return false;
        if (!capability && !managementCapabilitiesFor(chatId)?.canOpenManagement) {
          set({ operationError: translate("当前账号没有成员管理权限") });
          return false;
        }
        try {
          await transport.setChatMemberStatus({ chatId, userId, status });
          await get().loadChatManagement(chatId, 0);
          set({ operationError: undefined });
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("无法更新成员权限")) });
          return false;
        }
      },

      setChatMemberTag: async (chatId, userId, tag) => {
        if (!requireManagementCapability(chatId, "canManageTags", translate("当前账号没有修改成员标签的权限"))) return false;
        try {
          await transport.setChatMemberTag(chatId, userId, tag);
          await get().loadChatManagement(chatId, 0);
          set({ operationError: undefined });
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("无法更新成员标签")) });
          return false;
        }
      },

      setChatPermissions: async (chatId, permissions) => {
        if (!requireManagementCapability(chatId, "canManagePermissions", translate("当前账号没有修改默认权限的权限"))) return false;
        try {
          await transport.setChatPermissions(chatId, permissions);
          await get().loadChatManagement(chatId, 0);
          set({ operationError: undefined });
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("无法更新群组默认权限")) });
          return false;
        }
      },

      setChatSlowModeDelay: async (chatId, delaySeconds) => {
        if (!requireManagementCapability(chatId, "canManageSlowMode", translate("当前账号没有修改慢速模式的权限"))) return false;
        try {
          await transport.setChatSlowModeDelay(chatId, delaySeconds);
          await get().loadChatManagement(chatId, 0);
          set({ operationError: undefined });
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("无法更新慢速模式")) });
          return false;
        }
      },

      transferChatOwnership: async (chatId, userId, password) => {
        if (!requireManagementCapability(chatId, "canTransferOwnership", translate("当前账号不能转移所有权"))) return false;
        try {
          await transport.transferChatOwnership(chatId, userId, password);
          await get().loadChatManagement(chatId, 0);
          set({ operationError: undefined });
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("无法转移所有者")) });
          return false;
        }
      },

      loadChatEventLog: async (input) => {
        if (!requireManagementCapability(input.chatId, "canViewEventLog", translate("当前账号没有查看管理日志的权限"))) return undefined;
        try {
          const page = await transport.getChatEventLog(input);
          set({ operationError: undefined });
          return page;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("无法读取管理日志")) });
          return undefined;
        }
      },

      getChatInviteLinks: async (input) => {
        if (!requireManagementCapability(input.chatId, "canManageInvites", translate("当前账号没有管理邀请链接的权限"))) return undefined;
        const capabilities = managementCapabilitiesFor(input.chatId);
        if (
          capabilities?.canManageAllInvites !== true &&
          input.creatorUserId &&
          input.creatorUserId !== get().currentUserId
        ) {
          set({ operationError: translate("管理员只能读取自己创建的邀请链接") });
          return undefined;
        }
        try { return await transport.getChatInviteLinks(input); }
        catch (error) { set({ operationError: errorMessage(error, translate("无法读取邀请链接")) }); return undefined; }
      },

      createChatInviteLink: async (input) => {
        if (!requireManagementCapability(input.chatId, "canManageInvites", translate("当前账号没有管理邀请链接的权限"))) return undefined;
        try { const link = await transport.createChatInviteLink(input); set({ operationError: undefined }); return link; }
        catch (error) { set({ operationError: errorMessage(error, translate("无法创建邀请链接")) }); return undefined; }
      },

      editChatInviteLink: async (input) => {
        if (!requireManagementCapability(input.chatId, "canManageInvites", translate("当前账号没有管理邀请链接的权限"))) return undefined;
        try { const link = await transport.editChatInviteLink(input); set({ operationError: undefined }); return link; }
        catch (error) { set({ operationError: errorMessage(error, translate("无法编辑邀请链接")) }); return undefined; }
      },

      revokeChatInviteLink: async (chatId, inviteLink) => {
        if (!requireManagementCapability(chatId, "canManageInvites", translate("当前账号没有管理邀请链接的权限"))) return false;
        try { await transport.revokeChatInviteLink(chatId, inviteLink); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, translate("无法撤销邀请链接")) }); return false; }
      },

      getChatJoinRequests: async (input) => {
        if (!requireManagementCapability(input.chatId, "canManageInvites", translate("当前账号没有处理入群申请的权限"))) return undefined;
        if (managementCapabilitiesFor(input.chatId)?.canManageAllInvites !== true && !input.inviteLink) {
          set({ operationError: translate("管理员只能读取自己邀请链接的入群申请") });
          return undefined;
        }
        try { return await transport.getChatJoinRequests(input); }
        catch (error) { set({ operationError: errorMessage(error, translate("无法读取入群申请")) }); return undefined; }
      },

      processChatJoinRequest: async (chatId, userId, approve) => {
        if (!requireManagementCapability(chatId, "canManageInvites", translate("当前账号没有处理入群申请的权限"))) return false;
        try { await transport.processChatJoinRequest(chatId, userId, approve); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, translate("无法处理入群申请")) }); return false; }
      },

      processChatJoinRequests: async (chatId, inviteLink, approve) => {
        if (!requireManagementCapability(chatId, "canManageInvites", translate("当前账号没有处理入群申请的权限"))) return false;
        if (managementCapabilitiesFor(chatId)?.canManageAllInvites !== true && !inviteLink) {
          set({ operationError: translate("管理员只能处理自己邀请链接的入群申请") });
          return false;
        }
        try { await transport.processChatJoinRequests(chatId, inviteLink, approve); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, translate("无法批量处理入群申请")) }); return false; }
      },

      getBotCommandSuggestions: async (chatId, query = "", botUsername) => {
        try { return await transport.getBotCommandSuggestions(chatId, query, botUsername); }
        catch { return []; }
      },

      getCallbackQueryAnswer: async (messageId, data, preferredChatId) => {
        const location = messageLocation(messageId, preferredChatId ?? get().activeChatId);
        if (!location) return undefined;
        try {
          const answer = await transport.getCallbackQueryAnswer(location.chatId, messageId, data);
          set({ operationError: undefined });
          return answer;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("无法处理机器人操作")) });
          return undefined;
        }
      },

      getInlineQueryResults: async (chatId, botUsername, query, offset = "") => {
        try { return await transport.getInlineQueryResults(chatId, botUsername, query, offset); }
        catch { return undefined; }
      },

      sendInlineQueryResultMessage: async (chatId, botUserId, queryId, resultId, replyToMessageId, topicId) => {
        try { await transport.sendInlineQueryResultMessage(chatId, botUserId, queryId, resultId, replyToMessageId, topicId); recordConversationSentMessages(get().activeAccountId, chatId); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, translate("无法发送 Inline 结果")) }); return false; }
      },

      sendBotStartMessage: async (chatId, botUserId, parameter = "") => {
        try { await transport.sendBotStartMessage(chatId, botUserId, parameter); recordConversationSentMessages(get().activeAccountId, chatId); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, translate("无法启动机器人")) }); return false; }
      },

      loadBlockedSenders: async () => {
        set({ blockedSendersLoading: true });
        try { set({ blockedSenders: await transport.getBlockedSenders(), blockedSendersLoading: false }); }
        catch (error) { set({ blockedSendersLoading: false, operationError: errorMessage(error, translate("无法读取黑名单")) }); }
      },

      setMessageSenderBlocked: async (senderId, kind, blocked) => {
        try {
          await transport.setMessageSenderBlocked(senderId, kind, blocked);
          const blockedSenders = blocked ? await transport.getBlockedSenders() : get().blockedSenders.filter((sender) => !(sender.id === senderId && sender.kind === kind));
          set({ blockedSenders, operationError: undefined });
          return true;
        } catch (error) { set({ operationError: errorMessage(error, blocked ? translate("无法屏蔽对象") : translate("无法解除屏蔽")) }); return false; }
      },

      getChatReportOptions: async (chatId, messageIds) => {
        try { return await transport.getChatReportOptions(chatId, messageIds); }
        catch (error) { set({ operationError: errorMessage(error, translate("无法读取举报选项")) }); return undefined; }
      },

      reportChat: async (input) => {
        try { await transport.reportChat(input); set({ operationError: undefined }); return true; }
        catch (error) { set({ operationError: errorMessage(error, translate("无法提交举报")) }); return false; }
      },

      getActiveSessions: sessionController.getActiveSessions,
      terminateSession: sessionController.terminateSession,
      terminateAllOtherSessions: sessionController.terminateAllOtherSessions,
      getPrivacySettingRules: sessionController.getPrivacySettingRules,
      setPrivacySettingRules: sessionController.setPrivacySettingRules,

      setMessageReaction: async (messageId, emoji, chosen, preferredChatId) => {
        const location = messageLocation(messageId, preferredChatId ?? get().activeChatId);
        if (!location) return;
        const { chatId, messages: currentMessages, message: original } = location;
        const optimistic = withEmojiReaction(original, emoji, chosen, get().currentUserId);
        if (optimistic === original) return;
        const messages = new Map(get().messages);
        messages.set(chatId, upsertMessage(currentMessages, optimistic));
        set({ messages, operationError: undefined });
        try {
          await transport.setMessageReaction({ chatId, messageId, emoji, chosen });
          scheduleCacheWrite();
        } catch (error) {
          const latestMessages = get().messages.get(chatId) ?? [];
          const latest = latestMessages.find((message) => message.id === messageId);
          const latestReaction = latest?.interaction?.reactions.find(
            (reaction) => reaction.type.kind === "emoji" && reaction.type.emoji === emoji,
          );
          if (latest && Boolean(latestReaction?.chosen) === chosen) {
            const rollback = new Map(get().messages);
            rollback.set(chatId, upsertMessage(latestMessages, original));
            set({ messages: rollback });
          }
          set({
            operationError: error instanceof Error ? error.message : translate("无法更新表情回应"),
          });
        }
      },

      getMessageReactionSenders: async (messageId, type, offset, preferredChatId) => {
        const location = messageLocation(messageId, preferredChatId ?? get().activeChatId);
        if (!location) throw new Error(translate("消息不存在"));
        return transport.getMessageReactionSenders({
          chatId: location.chatId,
          messageId,
          type,
          offset,
          limit: 100,
        });
      },

      setPollAnswer: async (messageId, optionPositions, preferredChatId) => {
        const location = messageLocation(messageId, preferredChatId ?? get().activeChatId);
        if (!location) return false;
        try {
          await transport.setPollAnswer({ chatId: location.chatId, messageId, optionPositions });
          set({ operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({
            operationError: error instanceof Error ? error.message : translate("无法提交投票"),
          });
          return false;
        }
      },

      loadPinnedMessages: async (chatId) => {
        if (!get().chats.has(chatId)) return [];
        try {
          const pinned = await transport.getPinnedMessages(chatId);
          if (get().operationError) set({ operationError: undefined });
          return pinned;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("无法读取置顶消息")) });
          return [];
        }
      },

      pinMessage: async (messageId, disableNotification, onlyForSelf, preferredChatId) => {
        const location = messageLocation(messageId, preferredChatId ?? get().activeChatId);
        const chatId = location?.chatId;
        if (!chatId) return false;
        if (!await verifyPinPermission(chatId, messageId)) return false;
        try {
          await transport.pinMessage({
            chatId,
            messageId,
            disableNotification,
            onlyForSelf,
          });
          const messages = new Map(get().messages);
          messages.set(chatId, (messages.get(chatId) ?? []).map((message) =>
            message.id === messageId ? { ...message, isPinned: true, permissions: undefined } : message
          ));
          set({ messages, operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({ operationError: pinOperationError(error, translate("无法置顶消息")) });
          return false;
        }
      },

      unpinMessage: async (messageId, preferredChatId) => {
        const location = messageLocation(messageId, preferredChatId ?? get().activeChatId);
        const chatId = location?.chatId;
        if (!chatId) return false;
        if (!await verifyPinPermission(chatId, messageId)) return false;
        try {
          await transport.unpinMessage(chatId, messageId);
          const messages = new Map(get().messages);
          messages.set(chatId, (messages.get(chatId) ?? []).map((message) =>
            message.id === messageId ? { ...message, isPinned: false, permissions: undefined } : message
          ));
          set({ messages, operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({ operationError: pinOperationError(error, translate("无法取消置顶消息")) });
          return false;
        }
      },

      setChatMessageAutoDeleteTime: async (chatId, messageAutoDeleteTime) => {
        const targetChat = get().chats.get(chatId);
        if (!targetChat) return false;
        if (
          (targetChat.kind === "group" || targetChat.kind === "channel") &&
          !requireManagementCapability(chatId, "canChangeInfo", translate("当前账号没有修改群资料的权限"))
        ) return false;
        if (targetChat.kind !== "direct" && targetChat.kind !== "group" && targetChat.kind !== "channel") {
          set({ operationError: translate("当前会话不支持自动删除设置") });
          return false;
        }
        try {
          await transport.setChatMessageAutoDeleteTime({
            chatId,
            messageAutoDeleteTime,
          });
          const chats = new Map(get().chats);
          const chat = chats.get(chatId);
          if (chat) chats.set(chatId, { ...chat, messageAutoDeleteTime });
          set({ chats, operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("无法设置自动删除")) });
          return false;
        }
      },

      loadSharedMedia: async (input, force = false) => {
        if (accountTransition || !get().chats.has(input.chatId)) return undefined;
        const generation = accountGeneration;
        const reset = !input.fromMessageId;
        if (reset && !force) {
          const cached = sharedMediaIndex.read(input);
          if (cached) return cached;
        }
        try {
          const page = await transport.searchSharedMedia(input);
          if (generation !== accountGeneration || accountTransition) return undefined;
          const merged = sharedMediaIndex.merge(input, page, reset);
          set({ operationError: undefined });
          return merged;
        } catch (error) {
          if (generation !== accountGeneration || accountTransition) return undefined;
          set({ operationError: errorMessage(error, translate("无法读取共享媒体")) });
          return undefined;
        }
      },

      deleteMessagesFromChat: async (chatId, messageIds, revoke) => {
        const uniqueIds = [...new Set(messageIds)];
        if (!get().chats.has(chatId) || uniqueIds.length === 0 || uniqueIds.length > 100) {
          return false;
        }
        try {
          if (!await verifyDeleteScope(chatId, uniqueIds, revoke)) return false;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("无法确认消息删除权限")) });
          return false;
        }
        const deletedIds: string[] = [];
        let failure: unknown;
        for (const messageId of uniqueIds) {
          try {
            await transport.deleteMessage({ chatId, messageId, revoke });
            deletedIds.push(messageId);
          } catch (error) {
            failure ??= error;
          }
        }
        if (deletedIds.length > 0) {
          for (const messageId of deletedIds) markMessageRemoving(chatId, messageId);
          sharedMediaIndex.remove(chatId, deletedIds);
          scheduleCacheWrite();
        }
        set({
          operationError: failure
            ? errorMessage(failure, translate("已删除 {{value0}} 条，部分消息删除失败", { value0: deletedIds.length }))
            : undefined,
        });
        return !failure;
      },

      getCachedEmojiPicker: emojiPickerController.getCachedEmojiPicker,
      emojiRevision: 0,
      loadEmojiPicker: emojiPickerController.loadEmojiPicker,
      getCachedStickerSet: emojiPickerController.getCachedStickerSet,
      loadStickerSet: emojiPickerController.loadStickerSet,
      addStickerSet: emojiPickerController.addStickerSet,
      removeStickerSet: emojiPickerController.removeStickerSet,
      getCachedStickerOutline: emojiPickerController.getCachedStickerOutline,
      loadStickerOutline: emojiPickerController.loadStickerOutline,

      searchStickers: async (query, chatId) => {
        const normalized = query.trim();
        if (!normalized) return [];
        const accountId = get().activeAccountId;
        try {
          const results = await transport.searchStickers(normalized, chatId);
          return get().activeAccountId === accountId ? results : undefined;
        } catch {
          return undefined;
        }
      },

      getCachedEmojiAsset: emojiPickerController.getCachedEmojiAsset,
      loadEmojiAsset: emojiPickerController.loadEmojiAsset,

      sendSticker: async (asset, replyToMessageId, replyQuote, preferredChatId, disableNotification) => {
        const accountId = get().activeAccountId;
        const chatId = preferredChatId ?? get().activeChatId;
        const topicId = get().activeChatId === chatId ? get().activeTopicId : undefined;
        if (!chatId) return false;
        if (!connectionPresentation(get().connectionStatus).operational) {
          set({ operationError: translate("联网后才能发送贴纸") });
          return false;
        }
        const localOnlyReply = replyToMessageId
          ? get().messages.get(chatId)?.some((message) => message.id === replyToMessageId && message.isLocallyDeleted) === true
          : false;
        try {
          await transport.sendSticker({
            chatId,
            topicId,
            asset,
            replyToMessageId: localOnlyReply ? undefined : replyToMessageId,
            replyQuote: localOnlyReply ? undefined : replyToMessageId ? replyQuote : undefined,
            disableNotification,
          });
          if (get().activeAccountId !== accountId) return false;
          emojiPickerController.rememberSentSticker(asset);
          recordConversationSentMessages(get().activeAccountId, chatId);
          set({ operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("贴纸发送失败")) });
          return false;
        }
      },

      sendAnimation: async (asset, replyToMessageId, replyQuote, preferredChatId, disableNotification) => {
        const chatId = preferredChatId ?? get().activeChatId;
        const topicId = get().activeChatId === chatId ? get().activeTopicId : undefined;
        if (!chatId) return false;
        if (!connectionPresentation(get().connectionStatus).operational) {
          set({ operationError: translate("联网后才能发送 GIF") });
          return false;
        }
        const localOnlyReply = replyToMessageId
          ? get().messages.get(chatId)?.some((message) => message.id === replyToMessageId && message.isLocallyDeleted) === true
          : false;
        try {
          await transport.sendAnimation({
            chatId,
            topicId,
            asset,
            replyToMessageId: localOnlyReply ? undefined : replyToMessageId,
            replyQuote: localOnlyReply ? undefined : replyToMessageId ? replyQuote : undefined,
            disableNotification,
          });
          recordConversationSentMessages(get().activeAccountId, chatId);
          set({ operationError: undefined });
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({ operationError: errorMessage(error, translate("GIF 发送失败")) });
          return false;
        }
      },

      setSearchQuery: searchController.setSearchQuery,
      setChatFilter: (chatFilter) => {
        set({ chatFilter });
        scheduleCacheWrite();
        void loadChats(chatFilter);
      },

      updateChatDraft: (chatId, text, replyToMessageId, replyQuote, entities) => {
        if (!get().chats.has(chatId)) return;
        const topicId = get().activeChatId === chatId ? get().activeTopicId : undefined;
        const key = topicKey(chatId, topicId);
        const current = get().drafts.get(key);
        const next: ChatDraft = {
          chatId,
          topicId,
          text,
          ...(entities?.length ? { entities } : {}),
          replyToMessageId,
          replyQuote: replyToMessageId ? replyQuote : undefined,
          updatedAt: new Date().toISOString(),
          pending: true,
        };
        if (draftSignature(current) === draftSignature(next)) return;
        const drafts = new Map(get().drafts);
        drafts.set(key, next);
        set({ drafts });
        draftSync.expect(key, draftForSync(next), DRAFT_SYNC_DELAY_MS);
        scheduleCacheWrite();
      },

      updateThreadDraft: (draftKey, chatId, text, replyToMessageId, replyQuote, entities) => {
        if (!get().chats.has(chatId) && !get().messages.has(chatId)) return;
        const current = get().drafts.get(draftKey);
        const next: ChatDraft = {
          chatId,
          localKey: draftKey,
          text,
          ...(entities?.length ? { entities } : {}),
          replyToMessageId,
          replyQuote: replyToMessageId ? replyQuote : undefined,
          updatedAt: new Date().toISOString(),
          pending: false,
        };
        if (draftSignature(current) === draftSignature(next)) return;
        const drafts = new Map(get().drafts);
        drafts.set(draftKey, next);
        set({ drafts });
        scheduleCacheWrite();
      },

      loadLocalAttachmentDraft: async (draftKey) => {
        const localDraft = get().localAttachmentDrafts.get(draftKey);
        if (!localDraft) return [];
        try {
          const stored = await attachmentOutbox.get(localDraft.batchId, get().activeAccountId);
          if (stored && stored.attachments.length === localDraft.attachments.length) {
            return stored.attachments;
          }
        } catch {
          // Invalid local attachment drafts are discarded below.
        }
        discardLocalAttachmentDraft(draftKey);
        set({ operationError: translate("附件草稿已失效，请重新选择文件") });
        return [];
      },

      saveLocalAttachmentDraft: async (draftKey, chatId, attachments, options) => {
        if (!get().chats.has(chatId) || attachments.length === 0) return false;
        const accountId = get().activeAccountId;
        const generation = (localAttachmentDraftGenerations.get(draftKey) ?? 0) + 1;
        localAttachmentDraftGenerations.set(draftKey, generation);
        const batchId = `draft:${globalThis.crypto.randomUUID()}`;
        const updatedAt = new Date().toISOString();
        try {
          const metadata = await describeOutgoingAttachments(batchId, attachments);
          if (get().activeAccountId !== accountId) return false;
          await attachmentOutbox.put({
            id: batchId,
            accountId,
            createdAt: updatedAt,
            persistent: true,
            recovery: { draftKey, chatId, ...options },
            attachments,
            metadata,
          });
          if (get().activeAccountId !== accountId || localAttachmentDraftGenerations.get(draftKey) !== generation) {
            await attachmentOutbox.remove(batchId).catch(() => undefined);
            return false;
          }
          const previous = get().localAttachmentDrafts.get(draftKey);
          const localAttachmentDrafts = new Map(get().localAttachmentDrafts);
          localAttachmentDrafts.set(draftKey, {
            draftKey,
            chatId,
            batchId,
            attachments: metadata,
            ...options,
            updatedAt,
          });
          set({ localAttachmentDrafts, operationError: undefined });
          await flushUnsentState();
          if (previous?.batchId && previous.batchId !== batchId) {
            await attachmentOutbox.remove(previous.batchId).catch(() => undefined);
          }
          return true;
        } catch (error) {
          // A failed acknowledgement may still follow a successful disk commit.
          // Keep both blob versions until committed references can be reconciled.
          if (localAttachmentDraftGenerations.get(draftKey) === generation) {
            set({ operationError: errorMessage(error, translate("无法保存附件草稿")) });
          }
          return false;
        }
      },

      updateLocalAttachmentDraftOptions: (draftKey, options) => {
        const current = get().localAttachmentDrafts.get(draftKey);
        if (!current) return;
        const localAttachmentDrafts = new Map(get().localAttachmentDrafts);
        localAttachmentDrafts.set(draftKey, {
          ...current,
          ...options,
          updatedAt: new Date().toISOString(),
        });
        set({ localAttachmentDrafts });
        scheduleCacheWrite();
      },

      clearLocalAttachmentDraft: async (draftKey) => {
        const current = get().localAttachmentDrafts.get(draftKey);
        localAttachmentDraftGenerations.set(
          draftKey,
          (localAttachmentDraftGenerations.get(draftKey) ?? 0) + 1,
        );
        if (!current) return;
        const localAttachmentDrafts = new Map(get().localAttachmentDrafts);
        localAttachmentDrafts.delete(draftKey);
        set({ localAttachmentDrafts });
        await flushUnsentState();
        await attachmentOutbox.remove(current.batchId).catch(() => undefined);
      },

      setChatTyping: async (chatId, typing) => {
        if (get().authorization.kind !== "ready") return;
        try {
          await transport.setChatTyping(chatId, typing, get().activeChatId === chatId ? get().activeTopicId : undefined);
        } catch {
          // Typing state is ephemeral and must not replace actionable operation errors.
        }
      },

      sendMessage: async (text, replyToMessageId, replyQuote, entities, disableNotification, context) => {
        const chatId = context?.chatId ?? get().activeChatId;
        const topicId = context ? context.topicId : get().activeTopicId;
        const clearDraft = context?.clearDraft !== false;
        const formatted = trimComposerFormattedText(text, entities ?? []);
        const normalizedText = formatted.text;
        if (!chatId || !normalizedText) return false;
        if (!context?.discussionThreadId && get().chats.get(chatId)?.kind === "channel" && !canPostToChannel(get().chats.get(chatId))) {
          set({ operationError: translate("当前账号没有在此频道发布消息的权限") });
          return false;
        }
        const draftKey = topicKey(chatId, topicId);
        const previousDraft = clearDraft ? get().drafts.get(draftKey) : undefined;
        if (!connectionPresentation(get().connectionStatus).operational) {
          const previousOutbox = get().outbox;
          const previousMessages = get().messages;
          const previousDrafts = get().drafts;
          const item: QueuedOutgoingMessage = {
            id: globalThis.crypto.randomUUID(),
            chatId,
            topicId,
            discussionThreadId: context?.discussionThreadId,
            ...(clearDraft ? {} : { clearDraft: false }),
            text: normalizedText,
            ...(formatted.entities.length ? { entities: formatted.entities } : {}),
            replyToMessageId,
            replyQuote: replyToMessageId ? replyQuote : undefined,
            disableNotification,
            createdAt: new Date().toISOString(),
            status: "queued",
          };
          const outbox = [...previousOutbox, item];
          const drafts = new Map(previousDrafts);
          if (clearDraft) drafts.delete(draftKey);
          const clearGeneration = clearDraft ? draftSync.expect(draftKey, undefined) : undefined;
          set({
            drafts,
            outbox,
            messages: messagesWithOutbox(
              previousMessages,
              outbox,
              get().currentUserId ?? "self",
            ),
            operationError: undefined,
          });
          try {
            await flushCachedSnapshot();
            recordConversationSentMessages(get().activeAccountId, chatId);
            return true;
          } catch (error) {
            if (clearGeneration !== undefined) draftSync.cancelExpectation(draftKey, clearGeneration);
            if (previousDraft?.pending) {
              draftSync.expect(draftKey, draftForSync(previousDraft));
            }
            set({
              drafts: previousDrafts,
              outbox: previousOutbox,
              messages: previousMessages,
              cacheHealth: "invalid",
              operationError: errorMessage(error, translate("无法保存离线发送队列")),
            });
            return false;
          }
        }
        if (clearDraft) await draftSync.flush(draftKey);
        const clearGeneration = clearDraft ? draftSync.expect(draftKey, undefined) : undefined;
        try {
          await transport.sendMessage({
            chatId,
            topicId,
            text: normalizedText,
            entities: formatted.entities,
            replyToMessageId,
            replyQuote: replyToMessageId ? replyQuote : undefined,
            disableNotification,
            clearDraft,
          });
          if (clearGeneration !== undefined) draftSync.markAwaitingAck(draftKey, clearGeneration);
          const currentDraft = get().drafts.get(draftKey);
          if (clearDraft && draftSignature(currentDraft) === draftSignature(previousDraft)) {
            const drafts = new Map(get().drafts);
            drafts.delete(draftKey);
            set({ drafts, operationError: undefined });
          } else {
            set({ operationError: undefined });
          }
          scheduleCacheWrite();
          recordConversationSentMessages(get().activeAccountId, chatId);
          return true;
        } catch (error) {
          if (clearGeneration !== undefined) draftSync.cancelExpectation(draftKey, clearGeneration);
          const currentDraft = get().drafts.get(draftKey);
          if (previousDraft && draftSignature(currentDraft) === draftSignature(previousDraft)) {
            const restored = { ...previousDraft, pending: true };
            const drafts = new Map(get().drafts);
            drafts.set(draftKey, restored);
            set({ drafts });
            draftSync.expect(draftKey, draftForSync(restored), 0);
          }
          set({ operationError: error instanceof Error ? error.message : translate("消息发送失败") });
          return false;
        }
      },

      editMessage: async (messageId, text, entities, preferredChatId) => {
        const location = messageLocation(messageId, preferredChatId ?? get().activeChatId);
        const chatId = location?.chatId;
        const formatted = trimComposerFormattedText(text, entities ?? []);
        const normalizedText = formatted.text;
        const content = location?.message.content;
        const caption = content && isCaptionContent(content) ? content : undefined;
        if (!chatId || (!normalizedText && !caption)) return false;
        try {
          await transport.editMessage({
            chatId,
            messageId,
            text: normalizedText,
            entities: formatted.entities,
            ...(caption ? { contentType: "caption" as const, showCaptionAboveMedia: caption.showCaptionAboveMedia } : {}),
          });
          set({ operationError: undefined });
          return true;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : translate("消息编辑失败") });
          return false;
        }
      },

      deleteMessage: async (messageId, revoke, preferredChatId) => {
        const queuedItemId = outboxItemId(messageId);
        if (queuedItemId) {
          const item = get().outbox.find((candidate) => candidate.id === queuedItemId);
          if (!item) return false;
          setOutbox(get().outbox.filter((candidate) => candidate.id !== queuedItemId));
          if (!await persistOutboxState()) return false;
          if (item.attachments?.length) {
            await attachmentOutbox.remove(queuedItemId).catch(() => undefined);
          }
          set({ operationError: undefined });
          return true;
        }
        const location = messageLocation(messageId, preferredChatId ?? get().activeChatId);
        const chatId = location?.chatId;
        if (!chatId) return false;
        if (location.message.isLocallyDeleted) {
          removeMessageImmediately(chatId, messageId);
          set({ operationError: undefined });
          scheduleCacheWrite();
          return true;
        }
        try {
          if (!await verifyDeleteScope(chatId, [messageId], revoke)) return false;
          await transport.deleteMessage({ chatId, messageId, revoke });
          markMessageRemoving(chatId, messageId);
          set({ operationError: undefined });
          sharedMediaIndex.remove(chatId, [messageId]);
          scheduleCacheWrite();
          return true;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : translate("消息删除失败") });
          return false;
        }
      },

      forwardMessages: async (fromChatId, messageIds, toChatId, toTopicId, description) => {
        if (accountTransition || !get().chats.has(fromChatId) || !get().chats.has(toChatId)) return undefined;
        const generation = accountGeneration;
        const accountId = get().activeAccountId;
        const isCurrent = () => generation === accountGeneration && !accountTransition;
        const uniqueMessageIds = [...new Set(messageIds)];
        if (uniqueMessageIds.length === 0) return undefined;
        if (uniqueMessageIds.length > 100) {
          set({ operationError: translate("单次最多转发 100 条消息") });
          return undefined;
        }
        const sourceMessages = new Map((get().messages.get(fromChatId) ?? []).map(message => [message.id, message]));
        try {
          const result: ForwardMessagesResult = { forwardedCount: 0, failedMessageIds: [] };
          for (let index = 0; index < uniqueMessageIds.length;) {
            if (!isCurrent()) return undefined;
            const message = sourceMessages.get(uniqueMessageIds[index]);
            const batchIds = [uniqueMessageIds[index++]];
            // Only combine adjacent live messages, keeping archived copies in place.
            if (!message?.isLocallyDeleted) {
              while (index < uniqueMessageIds.length && !sourceMessages.get(uniqueMessageIds[index])?.isLocallyDeleted) {
                batchIds.push(uniqueMessageIds[index++]);
              }
            }
            try {
              if (!message?.isLocallyDeleted) {
                const forwarded = await transport.forwardMessages({ fromChatId, toChatId, toTopicId, messageIds: batchIds });
                result.forwardedCount += forwarded.forwardedCount;
                result.failedMessageIds.push(...forwarded.failedMessageIds);
              } else if (message.content.kind === "media" || message.content.kind === "file") {
                await transport.sendMediaCopy({ chatId: toChatId, topicId: toTopicId, content: message.content });
                result.forwardedCount += 1;
              } else {
                const author = senderNameForMessage(message, get().users, get().chats.get(fromChatId)!, get().chats);
                const quote = retainedMessageQuote(message.content, author, undefined, message.senderId);
                if (!quote.text) throw new Error(translate("消息转发失败"));
                await transport.sendMessage({ chatId: toChatId, topicId: toTopicId, ...quote, clearDraft: false });
                result.forwardedCount += 1;
              }
            } catch {
              result.failedMessageIds.push(...batchIds);
            }
            if (!isCurrent()) return undefined;
          }
          const normalizedDescription = description?.trim();
          let descriptionError: string | undefined;
          if (result.forwardedCount > 0 && normalizedDescription) {
            try {
              await transport.sendMessage({
                chatId: toChatId,
                topicId: toTopicId,
                text: normalizedDescription,
                entities: [],
                clearDraft: false,
              });
            } catch (error) {
              descriptionError = errorMessage(error, translate("转发成功，但描述发送失败"));
            }
          }
          if (!isCurrent()) return undefined;
          set({
            operationError: descriptionError ?? (result.failedMessageIds.length > 0
              ? translate("{{value0}} 条消息已转发，{{value1}} 条失败", { value0: result.forwardedCount, value1: result.failedMessageIds.length })
              : undefined),
          });
          if (result.forwardedCount > 0) {
            recordConversationSentMessages(
              accountId,
              toChatId,
              result.forwardedCount + (normalizedDescription && !descriptionError ? 1 : 0),
            );
          }
          scheduleCacheWrite();
          return result;
        } catch (error) {
          if (!isCurrent()) return undefined;
          set({ operationError: error instanceof Error ? error.message : translate("消息转发失败") });
          return undefined;
        }
      },

      cacheFile: async (fileId, priority) => {
        if (retainedMessages.forFile(fileId).some(({ content }) =>
          (content.kind === "media" || content.kind === "file") && content.fileId === fileId &&
          content.isDownloaded && content.localPath)) return;
        // Callers retry opportunistic preview downloads without surfacing a
        // global runtime error, so preserve the rejection signal here.
        await transport.cacheFile(fileId, priority);
      },

      recoverFile: async (fileId, priority) => {
        try {
          await transport.recoverFile(fileId, priority);
          return true;
        } catch {
          return false;
        }
      },

      streamFile: async (fileId, size, mimeType) => {
        try {
          const source = await transport.streamFile({ fileId, size, mimeType });
          set({ operationError: undefined });
          return source;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : translate("视频流加载失败") });
          return undefined;
        }
      },

      suspendFileStream: async (fileId) => {
        try {
          await transport.suspendFileStream(fileId);
        } catch {
          // Pausing playback is best-effort and should not surface a global
          // operation error when the stream already finished or disappeared.
        }
      },

      downloadFile: async (fileId, fileName) => {
        try {
          const retained = retainedMessages.forFile(fileId).find(({ content }) =>
            (content.kind === "media" || content.kind === "file") && content.fileId === fileId &&
            content.isDownloaded && content.localPath);
          const content = retained?.content;
          const sourcePath = content?.kind === "media" || content?.kind === "file" ? content.localPath : undefined;
          const path = await transport.downloadFile(fileId, fileName, sourcePath);
          set({ operationError: undefined });
          return path;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : translate("文件下载失败") });
          throw error;
        }
      },

      cancelFileDownload: async (fileId) => {
        try {
          await transport.cancelFileDownload(fileId);
          set({ operationError: undefined });
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : translate("取消文件下载失败") });
        }
      },

      openFile: async (sourcePath, fileId) => {
        try {
          await transport.openFile(sourcePath);
          set({ operationError: undefined });
          return true;
        } catch (error) {
          if (fileId !== undefined) {
            try {
              await transport.recoverFile(fileId, 32);
              set({ operationError: translate("文件缓存已失效并已重新下载，请再次打开") });
              return false;
            } catch {
              // Preserve the original open error when recovery also fails.
            }
          }
          set({ operationError: error instanceof Error ? error.message : translate("无法打开文件") });
          return false;
        }
      },

      saveFileToDownloads: async (sourcePath, fileName) => {
        try {
          await transport.saveFileToDownloads(sourcePath, fileName);
          set({ operationError: undefined });
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : translate("无法保存文件") });
        }
      },

      saveFileAs: async (sourcePath, fileName) => {
        try {
          await transport.saveFileAs(sourcePath, fileName);
          set({ operationError: undefined });
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : translate("无法另存文件") });
        }
      },

      openDownloadDirectory: async () => {
        try {
          await transport.openDownloadDirectory();
          set({ operationError: undefined });
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : translate("无法打开下载目录") });
        }
      },

      retryMessage: async (messageId, preferredChatId) => {
        const itemId = outboxItemId(messageId);
        const location = itemId
          ? undefined
          : messageLocation(messageId, preferredChatId ?? get().activeChatId);
        const chatId = location?.chatId ?? preferredChatId ?? get().activeChatId;
        if (!chatId) return;
        if (itemId) {
          const previous = get().outbox;
          const item = previous.find((candidate) => candidate.id === itemId);
          if (!item) return;
          setOutbox(previous.map((candidate) =>
            candidate.id === itemId
              ? { ...candidate, status: "queued", error: undefined }
              : candidate,
          ));
          try {
            await flushCachedSnapshot();
          } catch (error) {
            setOutbox(previous);
            set({
              cacheHealth: "invalid",
              operationError: errorMessage(error, translate("无法保存重试队列")),
            });
            return;
          }
          await flushOutbox();
          return;
        }
        try {
          await transport.retryMessage(chatId, messageId);
          set({ operationError: undefined });
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : translate("消息重试失败") });
        }
      },

      sendFile: async (file) => {
        const chatId = get().activeChatId;
        const topicId = get().activeTopicId;
        if (!chatId) return false;
        if (file && !connectionPresentation(get().connectionStatus).operational) {
          return get().sendFiles([await inspectOutgoingAttachment(file)]);
        }
        try {
          const sent = await transport.sendFile({ chatId, topicId, file });
          if (sent) {
            recordConversationSentMessages(get().activeAccountId, chatId);
            set({ operationError: undefined });
          }
          return sent;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : translate("文件发送失败") });
          return false;
        }
      },

      sendFiles: async (
        attachments,
        caption,
        captionEntities,
        replyToMessageId,
        replyQuote,
        disableNotification,
        context,
      ) => {
        const chatId = context?.chatId ?? get().activeChatId;
        const topicId = context ? context.topicId : get().activeTopicId;
        if (!chatId || attachments.length === 0) return false;
        if (!context?.discussionThreadId && get().chats.get(chatId)?.kind === "channel" && !canPostToChannel(get().chats.get(chatId))) {
          set({ operationError: translate("当前账号没有在此频道发布消息的权限") });
          return false;
        }
        const formattedCaption = trimComposerFormattedText(caption ?? "", captionEntities ?? []);
        if (!connectionPresentation(get().connectionStatus).operational) {
          const id = globalThis.crypto.randomUUID();
          const createdAt = new Date().toISOString();
          try {
            const metadata = await describeOutgoingAttachments(id, attachments);
            await attachmentOutbox.put({ id, accountId: get().activeAccountId, createdAt, attachments, metadata, recovery: { chatId, topicId, discussionThreadId: context?.discussionThreadId, replyToMessageId, replyQuote, caption: formattedCaption.text } });
            const previousOutbox = get().outbox;
            const previousMessages = get().messages;
            const item: QueuedOutgoingMessage = {
              id,
              chatId,
              topicId,
              discussionThreadId: context?.discussionThreadId,
              text: formattedCaption.text || metadata.map(({ name }) => name).join("、"),
              caption: formattedCaption.text || undefined,
              ...(formattedCaption.entities.length ? { entities: formattedCaption.entities } : {}),
              replyToMessageId,
              replyQuote: replyToMessageId ? replyQuote : undefined,
              disableNotification,
              kind: "attachments",
              attachments: metadata,
              createdAt,
              status: "queued",
            };
            setOutbox([...get().outbox, item]);
            set({ operationError: undefined });
            if (!await persistOutboxState()) {
              set({ outbox: previousOutbox, messages: previousMessages });
              return false;
            }
            recordConversationSentMessages(get().activeAccountId, chatId, attachments.length);
            return true;
          } catch (error) {
            await attachmentOutbox.remove(id).catch(() => undefined);
            set({ operationError: errorMessage(error, translate("无法保存离线附件")) });
            return false;
          }
        }
        try {
          const sent = await transport.sendFiles({
            chatId,
            topicId,
            attachments,
            caption: formattedCaption.text || undefined,
            captionEntities: formattedCaption.entities,
            replyToMessageId,
            replyQuote: replyToMessageId ? replyQuote : undefined,
            disableNotification,
          });
          if (sent) {
            recordConversationSentMessages(get().activeAccountId, chatId, attachments.length);
            set({ operationError: undefined });
          }
          return sent;
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : translate("附件发送失败") });
          return false;
        }
      },

      cancelFileUpload: async (messageId, preferredChatId) => {
        const itemId = outboxItemId(messageId);
        if (itemId) {
          const item = get().outbox.find((candidate) => candidate.id === itemId);
          if (!item) return;
          setOutbox(get().outbox.filter((candidate) => candidate.id !== itemId));
          if (!await persistOutboxState()) return;
          await attachmentOutbox.remove(itemId).catch(() => undefined);
          set({ operationError: undefined });
          return;
        }
        const location = messageLocation(messageId, preferredChatId ?? get().activeChatId);
        const chatId = location?.chatId;
        if (!chatId) return;
        try {
          await transport.cancelFileUpload(chatId, messageId);
          // A cancelled upload is not a user-visible deletion. Remove it from
          // the projection immediately so the virtual list can reclaim its row.
          removeMessageImmediately(chatId, messageId);
          set({ operationError: undefined });
          scheduleCacheWrite();
        } catch (error) {
          set({ operationError: error instanceof Error ? error.message : translate("取消上传失败") });
        }
      },

      clearError: () => set({ error: undefined }),
      clearOperationError: () => set({ operationError: undefined }),
    };
  });

export const telegramStore = createTelegramStore(createTelegramTransport());

export const useTelegramStore = <T,>(selector: (state: TelegramState) => T) =>
  useStore(telegramStore, selector);
