import { flushAccountMetadata } from "../store/accountMetadata";
import { preferencesStore } from "../store/preferencesStore";
import { ReadReceiptPolicyChanged } from "./readReceiptPolicy";
import { atReadCursor, compareReadCursors, LocalReadState, readCursor, type ReadCursor, type ReadCountSource } from "./localReadState";
import type { TelegramEventListener, TelegramTransport } from "./transport";
import type { Chat, ForumTopic, Message, TelegramEvent, TelegramSnapshot } from "./types";

const topicKey = (chatId: string, topicId: string) => JSON.stringify([chatId, topicId]);
const countSignature = (value: ReadCountSource & { updatedAt?: string }) => JSON.stringify([
  value.unreadCount, value.lastReadInboxMessageId, value.unreadMentionCount, value.unreadReactionCount,
  "updatedAt" in value ? value.updatedAt : value.lastMessage?.id,
]);
const resultMethods = new Set<keyof TelegramTransport>([
  "loadMoreChats", "refreshChatMembership", "createPrivateChat", "createChat", "joinChat",
  "loadChatHistory", "loadForumTopicHistory", "getForumTopics", "getForumTopic", "createForumTopic",
  "getMessageContext", "getMessage", "getMessageThread", "getMessageThreadHistory", "getPinnedMessages",
  "searchChatMessages", "searchGlobal", "searchSharedMedia",
]);

/** Projects local reads at the transport boundary; TDLib retains its original state. */
export const withLocalReadState = (base: TelegramTransport, onPolicyChanged: () => void): TelegramTransport => {
  const state = new LocalReadState();
  const chats = new Map<string, Chat>();
  const topics = new Map<string, ReadCountSource & { chatId: string }>();
  const revisions = new Map<string, number>();
  const pending = new Set<string>();
  const active = new Set<string>();
  let generation = 0;
  let accountId: string | undefined;
  let connected = false;
  let online = false;
  let settingsOnly = false;
  let listener: TelegramEventListener | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const blocked = () => preferencesStore.getState().blockReadReceipts;
  const sendRemote = async (send: () => Promise<void>) => {
    if (blocked()) return false;
    try { await send(); return true; }
    catch (error) {
      if (error instanceof ReadReceiptPolicyChanged && blocked()) return false;
      throw error;
    }
  };
  const bump = (chatId: string) => revisions.set(chatId, (revisions.get(chatId) ?? 0) + 1);
  const projectTopic = <T extends ReadCountSource>(topic: T) => state.project(topic, topic.id);

  const publish = (chatId: string) => {
    const chat = chats.get(chatId);
    if (chat) listener?.({ type: "chat.upsert", chat: state.project(chat) });
    for (const topic of topics.values()) {
      if (topic.chatId !== chatId) continue;
      const effective = projectTopic(topic);
      listener?.({ type: "forumTopics.changed", chatId, topic: { id: effective.id,
        lastReadInboxMessageId: effective.lastReadInboxMessageId,
        unreadCount: effective.unreadCount,
        unreadMentionCount: effective.unreadMentionCount, unreadReactionCount: effective.unreadReactionCount ?? 0 } });
    }
  };
  const persist = async () => { state.save(); await flushAccountMetadata(); };
  const schedule = (chatId: string) => {
    if (!state.has(chatId) || settingsOnly) return;
    pending.add(chatId);
    if (!timer && online && connected) timer = setTimeout(() => { timer = undefined; drain(); }, 40);
  };
  const recount = async (chatId: string) => {
    const owner = generation;
    const revision = revisions.get(chatId);
    const valid = () => owner === generation && revision === revisions.get(chatId) && online && connected;
    const chat = chats.get(chatId);
    if (!chat) return;
    const scopes = state.scopes(chatId);
    // A complete pass is committed atomically. Partial/failed pages never claim a count.
    const counts = new Map(scopes.map(record => [record.topicId, { unread: 0, mention: 0, reaction: 0 }]));
    const scan = async (filter?: "mention" | "reaction") => {
      let from: string | undefined;
      const seen = new Set<string>();
      let stop = false;
      while (valid() && !stop) {
        const page = await base.loadReadStatePage(chatId, undefined, from, filter);
        if (!valid()) return false;
        let progress = false;
        for (const message of page.messages) {
          if (seen.has(message.id)) continue;
          progress = true;
          seen.add(message.id);
          if (filter) {
            const unread = filter === "mention" ? message.containsUnreadMention && !state.mentionRead(message)
              : message.containsUnreadReaction && !state.reactionRead(message);
            if (unread) {
              const root = counts.get(undefined)!;
              root[filter]++;
              const topic = message.topicId ? counts.get(message.topicId) : undefined;
              if (topic) topic[filter]++;
            }
            continue;
          }
          const serverRead = chat.lastReadInboxMessageId && atReadCursor(message, { id: chat.lastReadInboxMessageId, sentAt: "" });
          const globalRead = atReadCursor(message, state.get(chatId)?.through);
          if (serverRead || globalRead) { stop = true; continue; }
          const topic = message.topicId ? topics.get(topicKey(chatId, message.topicId)) : undefined;
          const topicServerRead = topic?.lastReadInboxMessageId && atReadCursor(message, { id: topic.lastReadInboxMessageId, sentAt: "" });
          if (!message.outgoing && !message.isLocallyDeleted && !state.isRead(message) && !topicServerRead) {
            counts.get(undefined)!.unread++;
            const topicCount = message.topicId ? counts.get(message.topicId) : undefined;
            if (topicCount) topicCount.unread++;
          }
        }
        if (stop || !page.hasMore) return true;
        if (!progress || !page.nextFromMessageId || page.nextFromMessageId === from) throw new Error("Reading state pagination stalled");
        from = page.nextFromMessageId;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return valid();
    };
    const root = state.get(chatId)!;
    const history = state.hasReads(chatId);
    if (history && chat.unreadCount > 0 && !await scan()) return;
    const mentions = Boolean(root.mentions?.length);
    const reactions = Boolean(root.reactions?.length);
    if (mentions && chat.unreadMentionCount > 0 && !await scan("mention")) return;
    if (reactions && (chat.unreadReactionCount ?? 0) > 0 && !await scan("reaction")) return;
    if (!valid()) return;
    for (const record of scopes) {
      const count = counts.get(record.topicId)!;
      if (history) record.unreadCount = count.unread;
      if (mentions) record.mentionCount = count.mention;
      else delete record.mentionCount;
      if (reactions) record.reactionCount = count.reaction;
      else delete record.reactionCount;
    }
    await persist();
    if (valid()) publish(chatId);
  };
  const drain = () => {
    if (!online || !connected) return;
    for (const chatId of pending) {
      if (active.size >= 2) break;
      if (active.has(chatId)) continue;
      pending.delete(chatId);
      active.add(chatId);
      const owner = generation;
      void recount(chatId).catch(() => {
        // Retry on the next server update/reconnection, keeping the last complete count.
      }).finally(() => {
        if (owner !== generation) return;
        active.delete(chatId);
        drain();
      });
    }
  };
  const observeChat = (chat: Chat) => {
    const old = chats.get(chat.id);
    chats.set(chat.id, chat);
    const root = state.get(chat.id);
    if (root && chat.unreadMentionCount === 0) { root.mentions = []; delete root.mentionCount; }
    if (root && (chat.unreadReactionCount ?? 0) === 0) { root.reactions = []; delete root.reactionCount; }
    if (!old || countSignature(old) !== countSignature(chat)) { bump(chat.id); schedule(chat.id); }
    return state.project(chat);
  };
  const observeTopic = (topic: ForumTopic) => {
    const key = topicKey(topic.chatId, topic.id);
    const old = topics.get(key);
    topics.set(key, { id: topic.id, chatId: topic.chatId, unreadCount: topic.unreadCount,
      unreadMentionCount: topic.unreadMentionCount, unreadReactionCount: topic.unreadReactionCount,
      lastReadInboxMessageId: topic.lastReadInboxMessageId,
      lastMessage: topic.lastMessage ? readCursor(topic.lastMessage) : undefined });
    if (state.has(topic.chatId)) state.ensure(topic.chatId, topic.id);
    if (!old || countSignature(old) !== countSignature(topic)) { bump(topic.chatId); schedule(topic.chatId); }
    return projectTopic(topic);
  };
  const projectMessage = (message: Message) => state.projectMessage(message);
  const mapResult = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(mapResult);
    if (!value || typeof value !== "object") return value;
    if ("chatId" in value && "content" in value && "id" in value) return projectMessage(value as Message);
    if ("isGeneral" in value && "unreadCount" in value) return observeTopic(value as ForumTopic);
    if ("avatar" in value && "unreadCount" in value) return observeChat(value as Chat);
    const result = { ...value } as Record<string, unknown>;
    for (const key of ["chat", "chats", "messages", "topics", "lastMessage"]) if (key in result) result[key] = mapResult(result[key]);
    return result;
  };
  const receive = (event: TelegramEvent) => {
    if (event.type === "connection.changed") {
      online = event.status === "online";
      if (online) { for (const chatId of chats.keys()) schedule(chatId); drain(); }
    }
    if (event.type === "chat.upsert") { listener?.({ ...event, chat: observeChat(event.chat) }); return; }
    if (event.type === "chats.upserted") { listener?.({ ...event, chats: event.chats.map(observeChat) }); return; }
    if (event.type === "message.upsert" || event.type === "message.replace") {
      bump(event.message.chatId); schedule(event.message.chatId);
      const alreadyRead = state.isRead(event.message);
      listener?.({ ...event, message: projectMessage(event.message),
        ...(event.type === "message.upsert" && alreadyRead ? { animateEntrance: false } : {}) });
      return;
    }
    if (event.type === "messages.upserted") {
      listener?.({ ...event, messages: event.messages.map(projectMessage) }); return;
    }
    if (event.type === "message.remove") { bump(event.chatId); schedule(event.chatId); }
    if (event.type === "chat.migrated") {
      bump(event.fromChatId); bump(event.toChatId);
      state.migrateChat(event.fromChatId, event.toChatId);
    }
    if (event.type === "forumTopics.changed" && event.topic) {
      const key = topicKey(event.chatId, event.topic.id);
      const old = topics.get(key);
      if (old) { topics.set(key, { ...old, ...event.topic }); bump(event.chatId); }
      // A cached topic can receive an update before its raw metadata has loaded.
      const effective = projectTopic({ unreadCount: 0, unreadMentionCount: 0,
        ...old, ...event.topic, chatId: event.chatId });
      const topic = { ...event.topic };
      if ("lastReadInboxMessageId" in topic) topic.lastReadInboxMessageId = effective.lastReadInboxMessageId;
      if ("unreadCount" in topic) topic.unreadCount = effective.unreadCount;
      if ("unreadMentionCount" in topic) topic.unreadMentionCount = effective.unreadMentionCount;
      if ("unreadReactionCount" in topic) topic.unreadReactionCount = effective.unreadReactionCount;
      listener?.({ ...event, topic });
      schedule(event.chatId);
      return;
    }
    listener?.(event);
  };
  const loadAccount = (accountId: string) => {
    generation++;
    chats.clear(); topics.clear(); revisions.clear(); pending.clear(); active.clear();
    state.load(accountId);
  };
  const localRead = async (chatId: string, cursor: ReadCursor, topicId?: string) => {
    const chat = chats.get(chatId);
    const topic = topicId ? topics.get(topicKey(chatId, topicId)) : undefined;
    const previous = topic ? projectTopic(topic).unreadCount : chat ? state.project(chat).unreadCount : 0;
    state.read(chatId, cursor, topicId);
    if (!topicId) for (const record of state.scopes(chatId)) record.unreadCount = 0;
    const root = state.ensure(chatId);
    root.unreadCount = topicId ? Math.max(0, (chat ? state.project(chat).unreadCount : 0) - previous) : 0;
    bump(chatId);
    await persist();
    publish(chatId);
    schedule(chatId);
  };
  const acknowledge = async (chatId: string, ids: string[], reactionsOnly = false) => {
    const owner = generation;
    const messages = await Promise.all([...new Set(ids)].map(id => base.getMessage(chatId, id)));
    if (owner !== generation) return;
    for (const message of messages) {
      if (!message || message.chatId !== chatId) continue;
      state.acknowledge(message, reactionsOnly);
      listener?.({ type: "message.upsert", message: projectMessage(message) });
    }
    const root = state.ensure(chatId);
    const chat = chats.get(chatId);
    root.mentionCount = Math.max(0, (chat?.unreadMentionCount ?? 0) - (root.mentions?.length ?? 0));
    root.reactionCount = Math.max(0, (chat?.unreadReactionCount ?? 0) - (root.reactions?.length ?? 0));
    bump(chatId);
    await persist(); publish(chatId); schedule(chatId);
  };
  const overrides: Partial<TelegramTransport> = {
    usesLocalReadState: chatId => blocked() || state.has(chatId),
    getAccountState: async () => {
      const account = await base.getAccountState();
      if (accountId !== account.activeAccountId) { loadAccount(account.activeAccountId); accountId = account.activeAccountId; }
      return account;
    },
    selectAccount: async nextAccountId => {
      await flushAccountMetadata(); const account = await base.selectAccount(nextAccountId);
      loadAccount(account.activeAccountId); accountId = account.activeAccountId; return account;
    },
    removeAccount: async accountId => { state.removeAccount(accountId); await flushAccountMetadata(); return base.removeAccount(accountId); },
    loadCachedSnapshot: async () => {
      const snapshot = await base.loadCachedSnapshot();
      if (!snapshot) return undefined;
      // Cache counts are already projected; never feed them back as raw server counts.
      return { ...snapshot, chats: snapshot.chats.map(chat => state.project(chat)),
        messages: snapshot.messages.map(projectMessage),
        forumTopics: snapshot.forumTopics?.map(entry => ({ ...entry, topics: entry.topics.map(projectTopic) })) };
    },
    connect: async (nextListener, options) => {
      listener = nextListener;
      settingsOnly = options?.settingsOnly === true;
      connected = true;
      unsubscribe?.();
      unsubscribe = preferencesStore.subscribe((next, previous) => {
        if (next.blockReadReceipts && !previous.blockReadReceipts && !settingsOnly) onPolicyChanged();
      });
      const snapshot = await base.connect(receive, options);
      return mapResult(snapshot) as TelegramSnapshot;
    },
    disconnect: async () => {
      connected = false; online = false; generation++;
      unsubscribe?.(); unsubscribe = undefined;
      clearTimeout(timer); timer = undefined;
      await flushAccountMetadata();
      await base.disconnect();
      listener = undefined;
    },
    markChatRead: async chatId => {
      if (await sendRemote(() => base.markChatRead(chatId))) return;
      const owner = generation;
      const page = await base.loadReadStatePage(chatId);
      if (owner !== generation) return;
      const latest = page.messages.reduce<Message | undefined>((last, message) => !last || compareReadCursors(readCursor(message), readCursor(last)) > 0 ? message : last, undefined);
      if (latest) await localRead(chatId, readCursor(latest));
    },
    markForumTopicRead: async (chatId, topicId, messageId) => {
      if (await sendRemote(() => base.markForumTopicRead(chatId, topicId, messageId))) return;
      const owner = generation;
      // The switch can be enabled after topics were loaded without local projection.
      if (!topics.has(topicKey(chatId, topicId))) {
        const topic = await base.getForumTopic(chatId, topicId);
        if (owner !== generation) return;
        if (topic) observeTopic(topic);
      }
      const message = await base.getMessage(chatId, messageId);
      if (owner === generation && message?.chatId === chatId && message.topicId === topicId) await localRead(chatId, readCursor(message), topicId);
    },
    markMessageThreadRead: async (chatId, ids) => {
      if (await sendRemote(() => base.markMessageThreadRead(chatId, ids))) return;
      await acknowledge(chatId, ids);
    },
    viewChannelMessages: async (chatId, ids) => {
      // force_read=false still reads ChatHistory in TDLib. Keep openChat subscription separately.
      await sendRemote(() => base.viewChannelMessages(chatId, ids));
    },
    markMessageAttentionRead: async (chatId, ids) => {
      if (await sendRemote(() => base.markMessageAttentionRead(chatId, ids))) return;
      await acknowledge(chatId, ids);
    },
    markAllChatReactionsRead: async chatId => {
      if (await sendRemote(() => base.markAllChatReactionsRead(chatId))) return;
      const owner = generation;
      let from: string | undefined;
      do {
        const page = await base.loadReadStatePage(chatId, undefined, from, "reaction");
        if (owner !== generation) return;
        for (const message of page.messages) {
          state.acknowledge(message, true);
          listener?.({ type: "message.upsert", message: projectMessage(message) });
        }
        if (!page.hasMore) break;
        if (!page.nextFromMessageId || page.nextFromMessageId === from) throw new Error("Reaction pagination stalled");
        from = page.nextFromMessageId;
      } while (owner === generation);
      state.ensure(chatId).reactionCount = 0;
      for (const record of state.scopes(chatId)) record.reactionCount = 0;
      bump(chatId); await persist(); publish(chatId); schedule(chatId);
    },
  };
  return new Proxy(base, {
    get(target, key) {
      const override = Reflect.get(overrides, key);
      if (override) return override;
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (resultMethods.has(key as keyof TelegramTransport)) return (...args: unknown[]) => {
        const result = value.apply(target, args);
        // Preserve the ordinary transport's completion timing while the feature is unused.
        if (!blocked() && !state.hasAny()) return result;
        return Promise.resolve(result).then(mapResult);
      };
      return value.bind(target);
    },
  });
};
