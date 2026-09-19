import { translate } from "../i18n";
import { asTdObject, asTdObjects, mapTdUser, tdId, type TdObject } from "./tdlibMapper";
import { formattedTextObject, numericId } from "./tdlibRequests";
import type { CachedTelegramSnapshot, MessageTextEntity } from "./types";

interface MentionSource { chatId: string; messageId: string }
interface MentionContext {
  sessionGeneration: () => number;
  currentUserId: () => string | undefined;
  request: (request: TdObject) => Promise<TdObject>;
  rawUsers: ReadonlyMap<string, TdObject>;
  rawMessages: ReadonlyMap<string, ReadonlyMap<string, TdObject>>;
  loadCachedSnapshot: () => Promise<CachedTelegramSnapshot | undefined>;
}

const unavailableUser = (error: unknown) => error instanceof Error &&
  /^(User not found|Have no access to the user)(?: \(400\))?$/.test(error.message);
const unavailableSource = (error: unknown) => error instanceof Error &&
  ([400, 404].includes((error as Error & { code?: number }).code ?? 0) || /\((400|404)\)$/.test(error.message));
const validSource = (source: MentionSource) => Number.isSafeInteger(Number(source.chatId)) &&
  Number(source.chatId) !== 0 && Number.isSafeInteger(Number(source.messageId)) && Number(source.messageId) > 0;

/** Restores TDLib references without publishing messages or changing the history window. */
export class TauriMentionService {
  private pending = new Map<string, Promise<void>>();
  private snapshotLoad?: { generation: number; promise: Promise<CachedTelegramSnapshot | undefined> };

  constructor(private readonly context: MentionContext) {}

  async prepare(chatId: string, text: string, entities?: MessageTextEntity[]) {
    const generation = this.context.sessionGeneration();
    const userIds = asTdObjects(formattedTextObject(text, entities).entities).flatMap((entity) => {
      const type = asTdObject(entity.type);
      return type?.["@type"] === "textEntityTypeMentionName" ? [tdId(type.user_id)] : [];
    });
    await Promise.all([...new Set(userIds)].map((userId) => {
      const key = `${generation}:${userId}`;
      let pending = this.pending.get(key);
      if (!pending) {
        pending = this.resolve(chatId, userId, generation).finally(() => {
          if (this.pending.get(key) === pending) this.pending.delete(key);
        });
        this.pending.set(key, pending);
      }
      return pending;
    }));
    this.assertCurrent(generation);
  }

  private assertCurrent(generation: number) {
    if (generation !== this.context.sessionGeneration()) throw new Error(translate("账号已切换，发送已取消"));
  }

  private async snapshot(generation: number) {
    this.assertCurrent(generation);
    let load = this.snapshotLoad;
    if (!load || load.generation !== generation) {
      load = { generation, promise: this.context.loadCachedSnapshot().catch(() => undefined) };
      this.snapshotLoad = load;
    }
    try {
      const snapshot = await load.promise;
      this.assertCurrent(generation);
      const currentUserId = this.context.currentUserId();
      return currentUserId && snapshot?.currentUserId !== currentUserId ? undefined : snapshot;
    } finally {
      if (this.snapshotLoad === load) this.snapshotLoad = undefined;
    }
  }

  private async resolve(chatId: string, userId: string, generation: number) {
    const request = async (value: TdObject) => {
      this.assertCurrent(generation);
      try {
        return await this.context.request(value);
      } finally {
        this.assertCurrent(generation);
      }
    };
    let failure: unknown;
    const accessible = async () => {
      try {
        // Always consult TDLib: the frontend user cache can outlive native residency.
        const user = await request({ "@type": "getUser", user_id: numericId(userId) });
        if (user["@type"] !== "user" || tdId(user.id) !== userId) throw new Error("TDLib returned an unexpected mention user");
        if (user.have_access === true) return true;
        failure = new Error("Have no access to the user (400)");
      } catch (error) {
        if (!unavailableUser(error)) throw error;
        failure = error;
      }
      return false;
    };
    if (await accessible()) return;

    const attempted = new Set<string>();
    const restoreSources = async (sources: MentionSource[]) => {
      sources.sort((left, right) => Number(right.chatId === chatId) - Number(left.chatId === chatId) ||
        Number(right.messageId) - Number(left.messageId));
      for (const source of sources) {
        const key = `${source.chatId}:${source.messageId}`;
        if (!validSource(source) || attempted.has(key)) continue;
        if (attempted.size >= 3) break;
        attempted.add(key);
        try {
          // Loading a real authored message lets TDLib construct inputUserFromMessage.
          const message = await request({ "@type": "getMessage", chat_id: numericId(source.chatId), message_id: numericId(source.messageId) });
          const sender = asTdObject(message.sender_id);
          if (message["@type"] !== "message" || tdId(message.chat_id) !== source.chatId || tdId(message.id) !== source.messageId ||
            sender?.["@type"] !== "messageSenderUser" || tdId(sender.user_id) !== userId) continue;
          if (await accessible()) return true;
        } catch (error) {
          if (!unavailableSource(error)) throw error;
        }
      }
      return false;
    };
    const liveSources: MentionSource[] = [];
    for (const messages of this.context.rawMessages.values()) {
      for (const message of messages.values()) {
        const sender = asTdObject(message.sender_id);
        if (sender?.["@type"] === "messageSenderUser" && tdId(sender.user_id) === userId && !message.sending_state) {
          liveSources.push({ chatId: tdId(message.chat_id), messageId: tdId(message.id) });
        }
      }
    }
    if (await restoreSources(liveSources)) return;
    const snapshot = await this.snapshot(generation);
    if (await restoreSources((snapshot?.messages ?? []).filter((message) =>
      message.senderId === userId && !message.isLocallyDeleted && !message.isRemoving &&
      message.delivery !== "sending" && message.delivery !== "failed",
    ).map((message) => ({ chatId: message.chatId, messageId: message.id })))) return;

    const rawUser = this.context.rawUsers.get(userId);
    const username = (rawUser ? mapTdUser(rawUser)?.username : undefined) ?? snapshot?.users?.find((user) => user.id === userId)?.username;
    if (username && /^[a-zA-Z0-9_]{5,32}$/.test(username)) {
      try {
        const chat = await request({ "@type": "searchPublicChat", username });
        const type = asTdObject(chat.type);
        // A cached username may now belong to somebody else. Never retarget the entity.
        if (type?.["@type"] === "chatTypePrivate" && tdId(type.user_id) === userId && await accessible()) return;
      } catch (error) {
        if (!unavailableSource(error)) throw error;
      }
    }
    this.assertCurrent(generation);
    throw failure;
  }
}
