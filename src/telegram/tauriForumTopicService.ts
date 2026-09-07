import { translate } from "../i18n";
import { mapTdForumTopic, asTdObject, asTdObjects, tdId, tdNumber } from "./tdlibMapper";
import { numericId } from "./tdlibRequests";
import { identityTextField } from "./identityText";
import { loadHistoryWindow } from "./historyPager";
import type {
  ChatHistoryPage,
  CreateForumTopicInput,
  ForumTopic,
  ForumTopicPage,
  GetForumTopicsInput,
  Message,
} from "./types";
import type { TdObject } from "./tdlibMapper";

export interface TauriForumTopicServiceContext {
  request: (request: TdObject) => Promise<TdObject>;
  emitMessages: (rawMessages: TdObject[], notify?: boolean) => Message[];
  emitForumTopicsChanged: (chatId: string) => void;
}

export class TauriForumTopicService {
  private generation = 0;
  private exhaustedHistories = new Set<string>();
  private historyCursors = new Map<string, number>();
  private historyLoads = new Map<string, Promise<ChatHistoryPage>>();
  private topics = new Map<string, ForumTopic>();
  private topicLoads = new Map<string, Promise<ForumTopic | undefined>>();

  constructor(private readonly context: TauriForumTopicServiceContext) {}

  reset() {
    this.generation += 1;
    this.exhaustedHistories.clear();
    this.historyCursors.clear();
    this.historyLoads.clear();
    this.topics.clear();
    this.topicLoads.clear();
  }

  private assertGeneration(generation: number) {
    if (generation !== this.generation) throw new Error("TDLib synchronization superseded");
  }

  private topicKey(chatId: string, topicId: string) {
    return `${chatId}:${topicId}`;
  }

  private rememberTopic(topic: ForumTopic) {
    this.topics.set(this.topicKey(topic.chatId, topic.id), topic);
    return topic;
  }

  async getForumTopics(input: GetForumTopicsInput): Promise<ForumTopicPage> {
    const generation = this.generation;
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const result = await this.context.request({
      "@type": "getForumTopics",
      chat_id: numericId(input.chatId),
      query: (input.query ?? "").trim(),
      offset_date: Math.max(0, input.offsetDate ?? 0),
      offset_message_id: input.offsetMessageId ? numericId(input.offsetMessageId) : 0,
      offset_forum_topic_id: input.offsetTopicId ? numericId(input.offsetTopicId) : 0,
      limit,
    });
    this.assertGeneration(generation);
    const rawTopics = asTdObjects(result.topics);
    const topics = rawTopics
      .map(mapTdForumTopic)
      .filter((topic): topic is ForumTopic => Boolean(topic && topic.chatId === input.chatId))
      .map((topic) => this.rememberTopic(topic));
    const lastMessages = rawTopics.flatMap((topic) => {
      const last = asTdObject(topic.last_message);
      return last ? [last] : [];
    });
    this.context.emitMessages(lastMessages);
    const nextOffsetDate = tdNumber(result.next_offset_date);
    const nextOffsetMessageId = tdId(result.next_offset_message_id) || undefined;
    const nextOffsetTopicId = tdId(result.next_offset_forum_topic_id) || undefined;
    return {
      topics,
      totalCount: tdNumber(result.total_count),
      nextOffsetDate,
      nextOffsetMessageId,
      nextOffsetTopicId,
      hasMore: topics.length > 0 && Boolean(nextOffsetDate || nextOffsetMessageId || nextOffsetTopicId),
    };
  }

  async getForumTopic(chatId: string, topicId: string): Promise<ForumTopic | undefined> {
    const generation = this.generation;
    const key = this.topicKey(chatId, topicId);
    const cached = this.topics.get(key);
    if (cached) return cached;
    const pending = this.topicLoads.get(key);
    if (pending) return pending;
    const load = (async () => {
      const raw = await this.context.request({
        "@type": "getForumTopic",
        chat_id: numericId(chatId),
        forum_topic_id: numericId(topicId),
      });
      this.assertGeneration(generation);
      const topic = mapTdForumTopic(raw);
      if (!topic || topic.chatId !== chatId || topic.id !== topicId) return undefined;
      const lastMessage = asTdObject(raw.last_message);
      if (lastMessage) this.context.emitMessages([lastMessage]);
      return this.rememberTopic(topic);
    })().finally(() => {
      if (this.topicLoads.get(key) === load) this.topicLoads.delete(key);
    });
    this.topicLoads.set(key, load);
    return load;
  }

  applyForumTopicUpdate(update: TdObject) {
    const chatId = tdId(update.chat_id);
    const topicId = tdId(update.forum_topic_id);
    if (!chatId || !topicId) return undefined;
    const notificationSettings = asTdObject(update.notification_settings);
    const useDefaultMuteFor = notificationSettings?.use_default_mute_for !== false;
    const topicUpdate = {
      id: topicId,
      muted: !useDefaultMuteFor && (tdNumber(notificationSettings?.mute_for) ?? 0) > 0,
      useDefaultMuteFor,
      lastReadInboxMessageId: tdId(update.last_read_inbox_message_id) || undefined,
      lastReadOutboxMessageId: tdId(update.last_read_outbox_message_id) || undefined,
      unreadMentionCount: Math.max(0, tdNumber(update.unread_mention_count) ?? 0),
      unreadReactionCount: Math.max(0, tdNumber(update.unread_reaction_count) ?? 0),
    };
    const key = this.topicKey(chatId, topicId);
    const cached = this.topics.get(key);
    if (cached) Object.assign(cached, topicUpdate);
    return { chatId, topic: topicUpdate };
  }

  async loadForumTopicHistory(chatId: string, topicId: string, limit = 30): Promise<ChatHistoryPage> {
    const generation = this.generation;
    const key = `${chatId}:${topicId}`;
    if (this.exhaustedHistories.has(key)) {
      return { loadedCount: 0, hasMore: false, messageIds: [] };
    }
    const existing = this.historyLoads.get(key);
    if (existing) return existing;
    const load = (async () => {
      const cursor = this.historyCursors.get(key) ?? 0;
      const rawMessages = new Map<string, TdObject>();
      const result = await loadHistoryWindow({
        chatId,
        topicId,
        cursor,
        targetCount: Math.max(1, Math.min(limit, 100)),
        knownMessages: new Map(cursor ? [[String(cursor), {}]] : []),
        request: async (request) => {
          const response = await this.context.request(request);
          this.assertGeneration(generation);
          return response;
        },
        emitMessage: (message) => rawMessages.set(tdId(message.id), message),
      });
      this.assertGeneration(generation);
      const messages = this.context.emitMessages([...rawMessages.values()], false);
      this.historyCursors.set(key, result.cursor);
      if (result.exhausted) this.exhaustedHistories.add(key);
      return {
        loadedCount: result.loadedCount,
        hasMore: !this.exhaustedHistories.has(key),
        messageIds: result.messageIds,
        messages,
      };
    })().finally(() => {
      if (this.historyLoads.get(key) === load) this.historyLoads.delete(key);
    });
    this.historyLoads.set(key, load);
    return load;
  }

  async createForumTopic(input: CreateForumTopicInput): Promise<ForumTopic> {
    const name = identityTextField(input.name, 128, translate("话题名称"), true);
    const iconColor = input.iconColor ?? 0x6fb9f0;
    const info = await this.context.request({
      "@type": "createForumTopic",
      chat_id: numericId(input.chatId),
      name,
      is_name_implicit: false,
      icon: { "@type": "forumTopicIcon", color: iconColor, custom_emoji_id: 0 },
    });
    try {
      const topic = await this.getForumTopic(input.chatId, tdId(info.forum_topic_id));
      if (topic) {
        this.context.emitForumTopicsChanged(input.chatId);
        return topic;
      }
    } catch {
      // Fall back to the information returned by createForumTopic below.
    }
    const topic = mapTdForumTopic({
      info,
      is_pinned: false,
      unread_count: 0,
      order: "0",
      notification_settings: null,
      draft_message: null,
    });
    if (!topic) throw new Error(translate("TDLib 未返回新话题"));
    this.context.emitForumTopicsChanged(input.chatId);
    return topic;
  }

  async editForumTopic(chatId: string, topicId: string, name: string) {
    const normalized = identityTextField(name, 128, translate("话题名称"), true);
    await this.context.request({
      "@type": "editForumTopic",
      chat_id: numericId(chatId),
      forum_topic_id: numericId(topicId),
      name: normalized,
      edit_icon_custom_emoji: false,
      icon_custom_emoji_id: 0,
    });
    this.context.emitForumTopicsChanged(chatId);
  }

  async setForumTopicClosed(chatId: string, topicId: string, closed: boolean) {
    await this.context.request({
      "@type": "toggleForumTopicIsClosed",
      chat_id: numericId(chatId),
      forum_topic_id: numericId(topicId),
      is_closed: closed,
    });
    this.context.emitForumTopicsChanged(chatId);
  }

  async setForumTopicPinned(chatId: string, topicId: string, pinned: boolean) {
    await this.context.request({
      "@type": "toggleForumTopicIsPinned",
      chat_id: numericId(chatId),
      forum_topic_id: numericId(topicId),
      is_pinned: pinned,
    });
    this.context.emitForumTopicsChanged(chatId);
  }
}
