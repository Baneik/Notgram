import type { Message } from "../telegram/types";

const keyFor = (chatId: string, messageId: string) => `${chatId}\u0000${messageId}`;
const fileIdsFor = ({ content }: Message) => content.kind === "media" || content.kind === "file"
  ? [content.fileId, content.thumbnailFileId].filter((id): id is number => id !== undefined) : [];
const remoteIdsFor = ({ content }: Message) => content.kind === "media" || content.kind === "file"
  ? [content.remoteId, content.thumbnailRemoteId].filter((id): id is string => Boolean(id)) : [];

/** File updates outlive the server message and its transport history index. */
export class RetainedMessageIndex {
  private messages = new Map<string, Message>();
  private fileReferences = new Map<number, Set<string>>();
  private remoteReferences = new Map<string, Set<string>>();

  get(chatId: string, messageId: string) {
    return this.messages.get(keyFor(chatId, messageId));
  }

  all() {
    return [...this.messages.values()];
  }

  forFile(fileId: number) {
    return [...(this.fileReferences.get(fileId) ?? [])].map(key => this.messages.get(key)!);
  }

  forRemoteFile(remoteId: string) {
    return [...(this.remoteReferences.get(remoteId) ?? [])].map(key => this.messages.get(key)!);
  }

  reset(messages: ReadonlyMap<string, Message[]>) {
    this.messages.clear();
    this.fileReferences.clear();
    this.remoteReferences.clear();
    for (const items of messages.values()) this.upsert(items);
  }

  upsert(messages: readonly Message[]) {
    for (const message of messages) {
      this.remove(message.chatId, [message.id]);
      if (!message.isLocallyDeleted) continue;
      const key = keyFor(message.chatId, message.id);
      this.messages.set(key, message);
      for (const fileId of fileIdsFor(message)) {
        const references = this.fileReferences.get(fileId) ?? new Set<string>();
        references.add(key);
        this.fileReferences.set(fileId, references);
      }
      for (const remoteId of remoteIdsFor(message)) {
        const references = this.remoteReferences.get(remoteId) ?? new Set<string>();
        references.add(key);
        this.remoteReferences.set(remoteId, references);
      }
    }
  }

  remove(chatId: string, messageIds: readonly string[]) {
    for (const messageId of messageIds) {
      const key = keyFor(chatId, messageId);
      const existing = this.messages.get(key);
      if (!existing) continue;
      this.messages.delete(key);
      for (const fileId of fileIdsFor(existing)) {
        const references = this.fileReferences.get(fileId);
        references?.delete(key);
        if (references?.size === 0) this.fileReferences.delete(fileId);
      }
      for (const remoteId of remoteIdsFor(existing)) {
        const references = this.remoteReferences.get(remoteId);
        references?.delete(key);
        if (references?.size === 0) this.remoteReferences.delete(remoteId);
      }
    }
  }
}
