import type { Message, MessageFileState } from "../telegram/types";
import { updateMessageFile } from "../telegram/messageFileState";
import { upsertMessages } from "./telegramStore.messages";

const ALBUM_QUIET_MS = 500;
const ALBUM_MAX_WAIT_MS = 2_000;

interface PendingAlbum {
  messages: Map<string, Message>;
  liveIds: Set<string>;
  cacheRelevant: boolean;
  quietTimer?: ReturnType<typeof globalThis.setTimeout>;
  deadlineTimer: ReturnType<typeof globalThis.setTimeout>;
}

export interface IncomingAlbumBatch {
  messages: Message[];
  liveMessages: Message[];
  cacheRelevant: boolean;
}

/** TDLib delivers album members separately and supplies no completion marker.
 * Coalesce new members after a quiet interval, with a deadline for slow streams.
 * File/content updates replace buffered values without extending that interval. */
export class IncomingMediaAlbums {
  private albums = new Map<string, PendingAlbum>();
  private owners = new Map<string, string>();

  constructor(private publish: (batch: IncomingAlbumBatch) => void) {}

  capture(message: Message, live = false, cacheRelevant = true) {
    const reference = JSON.stringify([message.chatId, message.id]);
    if (message.outgoing && !this.owners.has(reference)) return false;
    const visual = message.mediaAlbumId && message.content.kind === "media" &&
      (message.content.mediaType === "photo" || message.content.mediaType === "video");
    const key = this.owners.get(reference) ?? (visual
      ? JSON.stringify([message.chatId, message.mediaAlbumId]) : undefined);
    if (!key) return false;
    let album = this.albums.get(key);
    if (!album) {
      if (!live || message.outgoing || !visual) return false;
      album = { messages: new Map(), liveIds: new Set(), cacheRelevant: false,
        deadlineTimer: globalThis.setTimeout(() => this.flush(key), ALBUM_MAX_WAIT_MS) };
      this.albums.set(key, album);
    }
    const added = !album.messages.has(reference);
    const previous = album.messages.get(reference);
    album.messages.set(reference, previous ? upsertMessages([previous], [message])[0] : message);
    this.owners.set(reference, key);
    if (live) album.liveIds.add(reference);
    album.cacheRelevant ||= cacheRelevant;
    if (added) {
      globalThis.clearTimeout(album.quietTimer);
      album.quietTimer = globalThis.setTimeout(() => this.flush(key), ALBUM_QUIET_MS);
    }
    return true;
  }

  updateFile(file: MessageFileState) {
    for (const album of this.albums.values()) {
      for (const [reference, message] of album.messages) {
        const updated = updateMessageFile(message, file);
        if (updated === message) continue;
        album.messages.set(reference, updated);
        album.cacheRelevant ||= file.isDownloaded || !file.isDownloading;
      }
    }
  }

  discard(predicate: (message: Message) => boolean) {
    for (const [key, album] of this.albums) {
      for (const [reference, message] of album.messages) {
        if (!predicate(message)) continue;
        album.messages.delete(reference);
        album.liveIds.delete(reference);
        this.owners.delete(reference);
      }
      if (album.messages.size === 0) this.remove(key, album);
    }
  }

  reset() {
    for (const [key, album] of this.albums) this.remove(key, album);
  }

  private remove(key: string, album: PendingAlbum) {
    globalThis.clearTimeout(album.quietTimer);
    globalThis.clearTimeout(album.deadlineTimer);
    this.albums.delete(key);
    for (const reference of album.messages.keys()) this.owners.delete(reference);
  }

  private flush(key: string) {
    const album = this.albums.get(key);
    if (!album) return;
    this.remove(key, album);
    this.publish({ messages: [...album.messages.values()],
      liveMessages: [...album.messages].filter(([reference]) => album.liveIds.has(reference)).map(([, message]) => message),
      cacheRelevant: album.cacheRelevant });
  }
}
