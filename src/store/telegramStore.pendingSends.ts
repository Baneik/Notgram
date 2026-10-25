import type { Message, OutgoingAttachment, SendEmojiAssetInput } from "../telegram/types";
import { messageFromOutbox } from "./telegramStore.outbox";
import { replaceMessage, upsertMessages } from "./telegramStore.messages";
import { groupOutgoingAttachments, outgoingAlbumCaptionIndex } from "../media/outgoingAttachments";
import { markMessageEntrance, transferMessageEntrance } from "../utils/messageEntrance";

interface PendingSendState {
  activeAccountId: string;
  currentUserId?: string;
  messages: Map<string, Message[]>;
}

let nextSendingId = crypto.getRandomValues(new Uint32Array(1))[0] % 0x7ffffffe;

/** Own only the presentation before TDLib creates its pending message. */
export const createPendingSends = (
  get: () => PendingSendState,
  set: (patch: { messages: Map<string, Message[]> }) => void,
) => {
  const pending = new Map<string, Message>();
  const previews = new Map<string, string[]>();

  const remove = (ids: readonly string[]) => {
    const messages = new Map(get().messages);
    let changed = false;
    for (const id of ids) {
      const message = pending.get(id);
      if (message) {
        changed = true;
        messages.set(message.chatId, (messages.get(message.chatId) ?? []).filter(item => item.id !== id));
        pending.delete(id);
      }
      for (const url of previews.get(id) ?? []) URL.revokeObjectURL(url);
      previews.delete(id);
    }
    if (changed) set({ messages });
  };

  const begin = (chatId: string, topicId: string | undefined, contents: Pick<Message, "content" | "mediaAlbumId">[], replyToMessageId?: string,
    replyQuote?: { text: string }, urls: string[] = []) => {
    const accountId = get().activeAccountId;
    const sendingId = nextSendingId = nextSendingId % 0x7ffffffe + 1;
    const messages = new Map(get().messages);
    const previous = messages.get(chatId) ?? [];
    // Preserve album order when several placeholders are created in one tick.
    const timestamp = Math.max(Date.now(), (Date.parse(previous.at(-1)?.sentAt ?? "") || 0) + 1);
    const rows = contents.map((row, index) => {
      const id = `local-send:${crypto.randomUUID()}`;
      const message: Message = {
        id, renderKey: id, sendingId, chatId, topicId, senderId: get().currentUserId ?? "self", outgoing: true,
        sentAt: new Date(timestamp + index).toISOString(), delivery: "sending", isPending: true, ...row,
        replyTo: replyToMessageId ? { kind: "message", chatId, messageId: replyToMessageId, quote: replyQuote?.text } : undefined,
        permissions: { canReply: false, canEdit: false, canForward: false, canDeleteOnlyForSelf: false, canDeleteForAllUsers: false },
      };
      pending.set(id, message);
      markMessageEntrance(message);
      return message;
    });
    if (rows[0] && urls.length) previews.set(rows[0].id, urls);
    messages.set(chatId, upsertMessages(previous, rows));
    set({ messages });
    const finish = () => {
      if (get().activeAccountId === accountId) remove(rows.map(row => row.id));
    };
    return { sendingId, finish };
  };

  const beginFiles = (chatId: string, topicId: string | undefined, attachments: OutgoingAttachment[], caption?: string,
    entities?: import("../telegram/types").MessageTextEntity[], replyToMessageId?: string, replyQuote?: { text: string }) => {
    const urls: string[] = [];
    const rows = groupOutgoingAttachments(attachments).flatMap((group, groupIndex) => {
      const mediaAlbumId = group.length > 1 ? `local-album:${crypto.randomUUID()}` : undefined;
      return group.map((attachment, index): Pick<Message, "content" | "mediaAlbumId"> => {
        const captioned = groupIndex === 0 && index === outgoingAlbumCaptionIndex(group);
        const file = attachment.file;
        const visual = attachment.kind === "photo" || attachment.kind === "video" || attachment.kind === "animation";
        const previewDataUrl = visual ? URL.createObjectURL(file) : undefined;
        if (previewDataUrl) urls.push(previewDataUrl);
        const shared = { fileName: file.name, size: file.size, sizeLabel: `${Math.max(1, Math.ceil(file.size / 1024))} KB`,
          caption: captioned ? caption : undefined, captionEntities: captioned ? entities : undefined,
          mimeType: file.type, canDownload: false };
        return { mediaAlbumId, content: attachment.kind === "document" ? { kind: "file", ...shared }
          : { kind: "media", ...shared, mediaType: attachment.kind, previewDataUrl,
            width: attachment.width, height: attachment.height, duration: attachment.duration,
            hasSpoiler: attachment.hasSpoiler, showCaptionAboveMedia: attachment.showCaptionAboveMedia } };
      });
    });
    return begin(chatId, topicId, rows, replyToMessageId, replyQuote, urls);
  };

  const accept = (message: Message) => {
    if (!message.outgoing || message.isPending || !message.sendingId) return false;
    if (get().messages.get(message.chatId)?.some(item => item.id === message.id)) return false;
    // TDLib may publish updateNewMessage before the request promise resolves.
    // TDLib's application-owned sending_id also identifies album members;
    // never infer identity from text, file names, timestamps or media types.
    const match = [...pending.values()].find(item => item.chatId === message.chatId && item.sendingId === message.sendingId);
    if (!match) return false;
    transferMessageEntrance(match.chatId, match.id, message);
    message.renderKey = match.renderKey;
    // Keep preview URLs until completion; a decoded server thumbnail can arrive later.
    pending.delete(match.id);
    const messages = new Map(get().messages);
    messages.set(match.chatId, replaceMessage(messages.get(match.chatId) ?? [], match.id, message));
    set({ messages });
    return true;
  };

  const beginEmoji = (input: SendEmojiAssetInput) => {
    const { content } = messageFromOutbox({ ...input, emojiAsset: input.asset, id: "", text: "",
      status: "queued", createdAt: new Date().toISOString() }, get().currentUserId ?? "self");
    return begin(input.chatId, input.topicId, [{ content }], input.replyToMessageId, input.replyQuote);
  };

  const reset = () => {
    remove([...pending.keys()]);
    for (const urls of previews.values()) for (const url of urls) URL.revokeObjectURL(url);
    previews.clear();
  };

  return { begin, beginFiles, beginEmoji, accept, reset };
};
