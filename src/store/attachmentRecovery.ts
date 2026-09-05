import { emitTo, listen } from "@tauri-apps/api/event";
import { translate } from "../i18n";
import { attachmentOutbox } from "./attachmentOutbox";
import { telegramStore } from "./telegramStore";

export async function restoreAttachmentBatch(accountId: string, id: string) {
  const state = telegramStore.getState();
  if (state.activeAccountId !== accountId) throw new Error("Attachment account changed");
  const batch = (await attachmentOutbox.list(accountId)).find((item) => item.id === id);
  if (!batch || batch.referenced) throw new Error(translate("无法恢复附件"));
  const route = batch.recovery;
  const chatId = typeof route?.chatId === "string" ? route.chatId : state.activeChatId;
  if (!chatId) throw new Error(translate("请先选择附件要恢复到的会话"));
  const draftKey = typeof route?.draftKey === "string" ? route.draftKey
    : typeof route?.topicId === "string" ? `${chatId}:topic:${route.topicId}` : chatId;
  if (state.localAttachmentDrafts.has(draftKey)) throw new Error(translate("目标会话已有附件草稿，请先处理已有草稿"));
  const stored = await attachmentOutbox.get(id, accountId, true);
  const current = telegramStore.getState();
  if (!stored || current.activeAccountId !== accountId) throw new Error(translate("无法恢复附件"));
  if (current.localAttachmentDrafts.has(draftKey)) throw new Error(translate("目标会话已有附件草稿，请先处理已有草稿"));
  if (!await current.saveLocalAttachmentDraft(draftKey, chatId, stored.attachments, {
    mode: route?.mode === "file" ? "file" : "media", hasSpoiler: route?.hasSpoiler === true, muteVideos: route?.muteVideos === true,
  })) throw new Error(translate("无法恢复附件"));
}

// The main window owns unsent state. Settings windows must never write a stale
// copy of that state or restore attachments into their settings-only store.
export const listenForAttachmentRecovery = () => listen<{ accountId: string; id: string; requestId: string }>(
  "notgram-restore-attachment", (event) => {
    const { accountId, id, requestId } = event.payload;
    void restoreAttachmentBatch(accountId, id)
      .then(() => emitTo("settings", "notgram-attachment-restored", { requestId }))
      .catch((error) => emitTo("settings", "notgram-attachment-restored", { requestId, error: String(error) }));
  },
);

export async function requestAttachmentRecovery(accountId: string, id: string) {
  if (!location.pathname.endsWith("settings-window.html")) return restoreAttachmentBatch(accountId, id);
  const requestId = crypto.randomUUID();
  let finish!: (error?: string) => void;
  const response = new Promise<void>((resolve, reject) => { finish = (error) => error ? reject(new Error(error)) : resolve(); });
  const unlisten = await listen<{ requestId: string; error?: string }>("notgram-attachment-restored", ({ payload }) => {
    if (payload.requestId === requestId) finish(payload.error);
  });
  const timer = setTimeout(() => finish(translate("无法恢复附件")), 120_000);
  try {
    await emitTo("main", "notgram-restore-attachment", { accountId, id, requestId });
    await response;
  } finally { clearTimeout(timer); unlisten(); }
}
