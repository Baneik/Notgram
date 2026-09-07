import type { Message, MessageFileState } from "../telegram/types";

interface Context {
  canRestore: () => boolean;
  messages: () => Message[];
  resolveFile: (remoteId: string) => Promise<MessageFileState | undefined>;
  applyFile: (remoteId: string, file: MessageFileState) => void;
}

/** Bounded, deduplicated lookups. Failed identities can be retried on the next connection. */
export class RetainedMediaRestorer {
  private generation = 0;
  private running?: Promise<void>;

  constructor(private readonly context: Context) {}

  reset() {
    this.generation += 1;
    this.running = undefined;
  }

  restore() {
    if (this.running) return this.running;
    if (!this.context.canRestore()) return Promise.resolve();
    const remoteIds = new Set<string>();
    for (const { content } of this.context.messages()) {
      if (content.kind !== "media" && content.kind !== "file") continue;
      if (content.fileId === undefined && content.remoteId) remoteIds.add(content.remoteId);
      if (content.thumbnailFileId === undefined && content.thumbnailRemoteId) remoteIds.add(content.thumbnailRemoteId);
    }
    const queue = [...remoteIds];
    let next = 0;
    const generation = this.generation;
    const isCurrent = () => generation === this.generation && this.context.canRestore();
    const worker = async () => {
      while (next < queue.length && isCurrent()) {
        const remoteId = queue[next++];
        try {
          const file = await this.context.resolveFile(remoteId);
          if (file && isCurrent()) this.context.applyFile(remoteId, file);
        } catch {
          // Deleted or inaccessible files keep their saved local preview; never fall back to an old ID.
        }
      }
    };
    const operation = Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
      .then(() => undefined).finally(() => {
        if (this.running === operation) this.running = undefined;
      });
    this.running = operation;
    return operation;
  }
}
