import { translate } from "../i18n";
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
        const accountId = get().activeAccountId;
        const currentAccount = () => get().activeAccountId === accountId;
        setOutbox(get().outbox.map((candidate) => candidate.id === item.id ? { ...candidate, status: "sending" } : candidate));
        if (!await persistOutboxState()) {
          setOutbox(get().outbox.map((candidate) => candidate.id === item.id ? { ...candidate, status: "failed" } : candidate));
          return;
        }
        if (!currentAccount()) return;
        try {
          if (item.attachments?.length) {
            const stored = await attachmentOutbox.get(item.id, get().activeAccountId);
            if (!stored) throw new Error(translate("离线附件已过期或文件内容已变更，请重新选择"));
            const acceptedIds = new Set(item.acceptedAttachmentIds ?? []);
            const remaining = stored.attachments.filter((_, index) => !acceptedIds.has(stored.metadata[index].storageId));
            const sent = remaining.length === 0 || await transport.sendFiles({
              chatId: item.chatId,
              topicId: item.topicId,
              attachments: remaining,
              onGroupAccepted: async (attachments) => {
                if (!currentAccount()) throw new Error("Account changed during send");
                for (const attachment of attachments) {
                  const index = stored.attachments.indexOf(attachment);
                  if (index >= 0) acceptedIds.add(stored.metadata[index].storageId);
                }
                setOutbox(get().outbox.map((candidate) => candidate.id === item.id
                  ? { ...candidate, acceptedAttachmentIds: [...acceptedIds], caption: undefined, entities: undefined }
                  : candidate));
                if (!await persistOutboxState()) throw new Error(translate("无法保存重试队列"));
              },
              caption: item.caption,
              captionEntities: item.entities,
              replyToMessageId: item.replyToMessageId,
              replyQuote: item.replyQuote,
              disableNotification: item.disableNotification,
            });
            if (!sent) throw new Error(translate("附件上传未完成"));
          } else {
            await transport.sendMessage({
              chatId: item.chatId,
              topicId: item.topicId,
              text: item.text,
              entities: item.entities,
              replyToMessageId: item.replyToMessageId,
              replyQuote: item.replyQuote,
              disableNotification: item.disableNotification,
              clearDraft: item.clearDraft !== false && !get().drafts.has(topicKey(item.chatId, item.topicId)),
            });
          }
        } catch (error) {
          if (!currentAccount()) return;
          setOutbox(get().outbox.map((candidate) =>
            candidate.id === item.id
              ? { ...candidate, status: "failed", error: onError(error, translate("离线发送失败")) }
              : candidate,
          ));
          set({
            operationError: onError(
              error,
              item.attachments?.length ? translate("离线附件恢复发送失败") : translate("离线消息恢复发送失败"),
            ),
          });
          await persistOutboxState();
          return;
        }

        if (!currentAccount()) return;
        setOutbox(get().outbox.filter((candidate) => candidate.id !== item.id));
        if (!await persistOutboxState()) return;
        if (item.attachments?.length) await attachmentOutbox.remove(item.id, accountId);
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
