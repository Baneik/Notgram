import type {
  Chat,
  GlobalSearchFilter,
  GlobalSearchInput,
  GlobalSearchPage,
  Message,
  SharedMediaPage,
  SharedMediaSearchInput,
} from "./types";
import {
  asTdObjects,
  tdId,
  tdNumber,
} from "./tdlibMapper";
import { messageContentText } from "./messageContent";
import { messageSearchMatches, parseMessageSearchQuery } from "./messageSearch";
import { forumTopicObject, numericId } from "./tdlibRequests";
import type { TdObject } from "./tdlibMapper";

export interface TauriSearchServiceContext {
  request: (request: TdObject) => Promise<TdObject>;
  rawChats: Map<string, TdObject>;
  upsertChat: (raw?: TdObject) => void;
  mapChat: (raw: TdObject) => Chat | undefined;
  mapMessage: (raw: TdObject) => Message | undefined;
  emitMessage: (raw: TdObject) => void;
  emitMessages: (rawMessages: TdObject[]) => void;
}

const globalSearchFilterObject = (filter: GlobalSearchFilter): TdObject | null => {
  switch (filter) {
    case "media": return { "@type": "searchMessagesFilterPhotoAndVideo" };
    case "file": return { "@type": "searchMessagesFilterDocument" };
    case "link": return { "@type": "searchMessagesFilterUrl" };
    default: return null;
  }
};

const globalSearchContentMatches = (message: Message, filter: GlobalSearchFilter) => {
  if (filter === "all") return true;
  if (filter === "message") return ["text", "rich", "service"].includes(message.content.kind);
  if (filter === "media") return message.content.kind === "media";
  if (filter === "file") return message.content.kind === "file";
  return message.content.kind === "text" && (
    message.content.entities?.some((entity) => entity.kind === "textUrl" || entity.kind === "url") ||
    /https?:\/\//i.test(message.content.text)
  );
};

export class TauriSearchService {
  constructor(private readonly context: TauriSearchServiceContext) {}

  async searchChats(query: string, limit = 50) {
    const normalized = query.trim();
    if (!normalized) return;
    const result = await this.context.request({
      "@type": "searchChatsOnServer",
      query: normalized,
      limit: Math.max(1, Math.min(limit, 100)),
    });
    const ids = Array.isArray(result.chat_ids)
      ? result.chat_ids.map(tdId).filter(Boolean)
      : [];
    await Promise.all(ids.map(async (id) => {
      const raw = this.context.rawChats.get(id) ?? await this.context.request({
        "@type": "getChat",
        chat_id: numericId(id),
      });
      this.context.upsertChat(raw);
    }));
  }

  async searchGlobal({
    query,
    filter,
    offset = "",
    limit = 30,
  }: GlobalSearchInput): Promise<GlobalSearchPage> {
    const pattern = parseMessageSearchQuery(query);
    if (!pattern.query) return { chats: [], messages: [], totalCount: 0 };
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const filterObject = globalSearchFilterObject(filter);
    const [found, serverChats, publicChats] = await Promise.all([
      this.context.request({
        "@type": "searchMessages",
        chat_list: null,
        query: pattern.serverQuery,
        offset,
        limit: boundedLimit,
        filter: filterObject,
        chat_type_filter: null,
        min_date: 0,
        max_date: 0,
      }),
      offset || pattern.kind === "regex" ? Promise.resolve(undefined) : this.context.request({
        "@type": "searchChatsOnServer",
        query: pattern.serverQuery,
        limit: 50,
      }).catch(() => undefined),
      offset || pattern.kind === "regex" ? Promise.resolve(undefined) : this.context.request({
        "@type": "searchPublicChats",
        query: pattern.serverQuery,
      }).catch(() => undefined),
    ]);
    const rawMessages = asTdObjects(found.messages);
    const resultChatIds = new Set(
      rawMessages.map((message) => tdId(message.chat_id)).filter(Boolean),
    );
    await Promise.all([...resultChatIds].map(async (chatId) => {
      if (this.context.rawChats.has(chatId)) return;
      this.context.upsertChat(await this.context.request({
        "@type": "getChat",
        chat_id: numericId(chatId),
      }));
    }));
    const messages = rawMessages
      .map((raw) => this.context.mapMessage(raw))
      .filter((message): message is Message => Boolean(message))
      .filter((message) => globalSearchContentMatches(message, filter))
      .filter((message) => pattern.kind === "text" || messageSearchMatches(
        messageContentText(message.content),
        pattern,
      ));
    const uniqueMessages = [...new Map(messages.map((message) => [
      `${message.chatId}:${message.id}`,
      message,
    ])).values()];
    const chatIds = new Set<string>(uniqueMessages.map((message) => message.chatId));
    for (const result of [serverChats, publicChats]) {
      for (const id of Array.isArray(result?.chat_ids) ? result.chat_ids.map(tdId) : []) {
        if (id) chatIds.add(id);
      }
    }
    const chats = (await Promise.all([...chatIds].map(async (chatId) => {
      const raw = this.context.rawChats.get(chatId) ?? await this.context.request({
        "@type": "getChat",
        chat_id: numericId(chatId),
      });
      this.context.upsertChat(raw);
      return this.context.mapChat(raw);
    }))).filter((chat): chat is Chat => Boolean(chat));
    const totalCount = tdNumber(found.total_count);
    return {
      chats,
      messages: uniqueMessages,
      totalCount: pattern.kind === "text" && filter !== "message" && totalCount !== undefined && totalCount >= 0
        ? totalCount
        : undefined,
      nextOffset: typeof found.next_offset === "string" && found.next_offset
        ? found.next_offset
        : undefined,
    };
  }

  async searchChatMessages(chatId: string, query: string, limit = 100, topicId?: string) {
    const pattern = parseMessageSearchQuery(query);
    if (!pattern.query) return 0;
    const result = await this.context.request({
      "@type": "searchChatMessages",
      chat_id: numericId(chatId),
      topic_id: forumTopicObject(topicId),
      query: pattern.serverQuery,
      sender_id: null,
      from_message_id: 0,
      offset: 0,
      limit: Math.max(1, Math.min(limit, 100)),
      filter: null,
    });
    const messages = asTdObjects(result.messages);
    const matches = pattern.kind === "text"
      ? messages
      : messages.filter((raw) => {
          const message = this.context.mapMessage(raw);
          return Boolean(message && messageSearchMatches(
            messageContentText(message.content),
            pattern,
          ));
        });
    for (const message of matches) this.context.emitMessage(message);
    return matches.length;
  }

  async searchSharedMedia(input: SharedMediaSearchInput): Promise<SharedMediaPage> {
    const filter = {
      media: "searchMessagesFilterPhotoAndVideo",
      file: "searchMessagesFilterDocument",
      link: "searchMessagesFilterUrl",
      audio: "searchMessagesFilterAudio",
    }[input.category];
    const limit = Math.max(1, Math.min(input.limit ?? 40, 100));
    const result = await this.context.request({
      "@type": "searchChatMessages",
      chat_id: numericId(input.chatId),
      topic_id: null,
      query: input.query?.trim() ?? "",
      sender_id: null,
      from_message_id: input.fromMessageId ? numericId(input.fromMessageId) : 0,
      offset: 0,
      limit,
      filter: { "@type": filter },
    });
    const rawMessages = asTdObjects(result.messages);
    const messages = rawMessages.map((raw) => this.context.mapMessage(raw))
      .filter((message): message is Message => Boolean(message && message.chatId === input.chatId));
    this.context.emitMessages(rawMessages);
    const nextFromMessageId = rawMessages.length > 0 ? tdId(rawMessages.at(-1)?.id) : undefined;
    return {
      messages,
      totalCount: Math.max(0, tdNumber(result.total_count) ?? messages.length),
      nextFromMessageId: nextFromMessageId || undefined,
      hasMore: rawMessages.length === limit && Boolean(nextFromMessageId),
    };
  }
}
