import type { Message, MessageFileState } from "../telegram/types";
import { matchesFileIdentity, messageFiles } from "../telegram/messageFileState";

interface Context {
  canRestore: () => boolean;
  messages: () => Message[];
  resolveFile: (remoteId: string) => Promise<MessageFileState | undefined>;
  applyFile: (remoteId: string, file: MessageFileState) => void;
  refreshMessage?: (message: Message) => Promise<void>;
}

/** Bounded, deduplicated lookups. Failed identities can be retried on the next connection. */
export class MediaFileRestorer {
  private generation = 0;
  private running?: Promise<void>;
  private rescanRequested = false;

  constructor(private readonly context: Context) {}

  reset() {
    this.generation += 1;
    this.running = undefined;
    this.rescanRequested = false;
  }

  restore() {
    if (this.running) {
      this.rescanRequested = true;
      return this.running;
    }
    if (!this.context.canRestore()) return Promise.resolve();
    const generation = this.generation;
    const isCurrent = () => generation === this.generation && this.context.canRestore();
    const run = async () => {
      const attempted = new Set<string>();
      const refreshed = new Set<string>();
      const refresh = async (message: Message) => {
        const key = `${message.chatId}:${message.id}`;
        if (!isCurrent() || message.isLocallyDeleted || message.isPending || refreshed.has(key) || !this.context.refreshMessage) return;
        refreshed.add(key);
        await this.context.refreshMessage(message).catch(() => undefined);
      };
      do {
        this.rescanRequested = false;
        const remoteIds = new Set<string>();
        const sources = new Map<string, Message[]>();
        const missingIdentity: Message[] = [];
        for (const message of this.context.messages()) {
          for (const content of messageFiles(message)) {
            if (content.fileId === undefined && !content.remoteId && !content.localPath) missingIdentity.push(message);
            for (const [id, remoteId] of [
              [content.fileId, content.remoteId],
              [content.thumbnailFileId, content.thumbnailRemoteId],
            ] as const) {
              if (id !== undefined) continue;
              if (remoteId) {
                remoteIds.add(remoteId);
                sources.set(remoteId, [...(sources.get(remoteId) ?? []), message]);
              }
            }
          }
        }
        const queue: Array<string | Message> = [...remoteIds].filter(id => !attempted.has(id));
        queue.push(...missingIdentity);
        let next = 0;
        const worker = async () => {
          while (next < queue.length && isCurrent()) {
            const item = queue[next++];
            if (typeof item !== "string") {
              await refresh(item);
              continue;
            }
            const remoteId = item;
            attempted.add(remoteId);
            let file: MessageFileState | undefined;
            try {
              file = await this.context.resolveFile(remoteId);
              if (file && isCurrent()) this.context.applyFile(remoteId, file);
            } catch {
              // Keep the saved preview on failure; never fall back to an old numeric handle.
            }
            for (const message of sources.get(remoteId) ?? []) {
              const matches = file && messageFiles(message).some(content =>
                content.remoteId === remoteId && matchesFileIdentity(content.remoteId, content.remoteUniqueId, file!) ||
                content.thumbnailRemoteId === remoteId && matchesFileIdentity(content.thumbnailRemoteId, content.thumbnailRemoteUniqueId, file!));
              if (!matches) await refresh(message);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
        // A conversation selected while requests were in flight must not miss its restoration pass.
      } while (this.rescanRequested && isCurrent());
    };
    const operation = run().finally(() => {
      if (this.running === operation) this.running = undefined;
    });
    this.running = operation;
    return operation;
  }
}
