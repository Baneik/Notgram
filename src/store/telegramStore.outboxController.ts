import type { TelegramTransport } from "../telegram/transport";
import type { QueuedOutgoingMessage } from "../telegram/types";
import { attachmentOutbox } from "./attachmentOutbox";
import { messagesWithOutbox } from "./telegramStore.outbox";
import type { TelegramState } from "./telegramStore.types";

type StoreSetter = (
  patch: Partial<TelegramState> | ((state: TelegramState) => Partial<TelegramState>),
) => void;

export interface OutboxController {
  setOutbox: (outbox: QueuedOutgoingMessage[]) => void;
  persistOutboxState: () => Promise<boolean>;
  flushOutbox: () => Promise<void>;
}

export interface OutboxControllerOptions {
  transport: TelegramTransport;
  get: () => TelegramState;
  set: StoreSetter;
  flushCachedSnapshot: () => Promise<void>;
  topicKey: (chatId: string, topicId?: string) => string;
  onError: (error: unknown, fallback: string) => string;
}

/**
 * Owns the durable offline queue lifecycle. Queue entries remain represented
 * in TelegramState and the existing cache schema; this controller only keeps
 * their message projection, persistence and online drain mechanics together.
 */
export const createOutboxController = ({
  transport,
  get,
  set,
  flushCachedSnapshot,
  topicKey,
  onError,
}: OutboxControllerOptions): OutboxController => {
  let outboxFlush: Promise<void> | undefined;

  const setOutbox = (outbox: QueuedOutgoingMessage[]) => {
    const state = get();
    set({
      outbox,
      messages: messagesWithOutbox(
        state.messages,
        outbox,
        state.currentUserId ?? "self",
      ),
    });
  };

  const persistOutboxState = async () => {
    try {
      await flushCachedSnapshot();
      return true;
    } catch {
      await transport.clearCachedSnapshot().catch(() => undefined);
      set({ cacheHealth: "invalid" });
      return false;
    }
  };

  const flushOutbox = () => {
    if (outboxFlush) return outboxFlush;
    const operation = (async () => {
      while (
        get().authorization.kind === "ready" &&
        get().connectionStatus === "online"
      ) {
        const item = get().outbox.find((candidate) => candidate.status === "queued");
        if (!item) return;
        try {
          if (item.attachments?.length) {
            const stored = await attachmentOutbox.get(item.id);
            if (!stored) throw new Error("离线附件已过期或文件内容已变更，请重新选择");
            const sent = await transport.sendFiles({
              chatId: item.chatId,
              topicId: item.topicId,
              attachments: stored.attachments,
              caption: item.caption,
            });
            if (!sent) throw new Error("附件上传未完成");
          } else {
            await transport.sendMessage({
              chatId: item.chatId,
              topicId: item.topicId,
              text: item.text,
              replyToMessageId: item.replyToMessageId,
              clearDraft: !get().drafts.has(topicKey(item.chatId, item.topicId)),
            });
          }
        } catch (error) {
          setOutbox(get().outbox.map((candidate) =>
            candidate.id === item.id
              ? { ...candidate, status: "failed", error: onError(error, "离线发送失败") }
              : candidate,
          ));
          set({
            operationError: onError(
              error,
              item.attachments?.length ? "离线附件恢复发送失败" : "离线消息恢复发送失败",
            ),
          });
          await persistOutboxState();
          return;
        }

        setOutbox(get().outbox.filter((candidate) => candidate.id !== item.id));
        if (item.attachments?.length) await attachmentOutbox.remove(item.id);
        if (!await persistOutboxState()) return;
      }
    })();
    const tracked = operation.finally(() => {
      if (outboxFlush === tracked) outboxFlush = undefined;
    });
    outboxFlush = tracked;
    return tracked;
  };

  return { setOutbox, persistOutboxState, flushOutbox };
};
