import type { ChatDraft } from "../telegram/types";

export const DRAFT_SYNC_DELAY_MS = 450;
const DRAFT_ACK_TIMEOUT_MS = 5_000;
const DRAFT_RETRY_DELAYS_MS = [1_000, 2_500, 5_000] as const;

interface DraftSyncEntry {
  generation: number;
  draft?: ChatDraft;
  attempts: number;
  sent: boolean;
  timer?: ReturnType<typeof setTimeout>;
  ackTimer?: ReturnType<typeof setTimeout>;
}

export const draftForSync = (draft?: ChatDraft) =>
  draft && (draft.text.length > 0 || draft.replyToMessageId) ? draft : undefined;

export const draftSignature = (draft?: ChatDraft) => JSON.stringify([
  draft?.text ?? "",
  draft?.replyToMessageId ?? "",
]);

const clearDraftSyncTimers = (entry: DraftSyncEntry) => {
  if (entry.timer) globalThis.clearTimeout(entry.timer);
  if (entry.ackTimer) globalThis.clearTimeout(entry.ackTimer);
  entry.timer = undefined;
  entry.ackTimer = undefined;
};

interface DraftSyncDependencies {
  isReady: () => boolean;
  getDrafts: () => Map<string, ChatDraft>;
  setDrafts: (drafts: Map<string, ChatDraft>) => void;
  sendDraft: (chatId: string, draft?: ChatDraft) => Promise<void>;
  reportError: (message: string) => void;
  scheduleCacheWrite: () => void;
}

export class DraftSyncController {
  private generation = 0;
  private syncs = new Map<string, DraftSyncEntry>();
  private requestChains = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: DraftSyncDependencies) {}

  expect(chatId: string, draft: ChatDraft | undefined, delayMs?: number) {
    const previous = this.syncs.get(chatId);
    if (previous) clearDraftSyncTimers(previous);
    const entry: DraftSyncEntry = {
      generation: ++this.generation,
      draft: draftForSync(draft),
      attempts: 0,
      sent: false,
    };
    this.syncs.set(chatId, entry);
    if (delayMs !== undefined) {
      entry.timer = globalThis.setTimeout(
        () => void this.perform(chatId, entry.generation),
        delayMs,
      );
    }
    return entry.generation;
  }

  resumePending() {
    if (!this.dependencies.isReady()) return;
    for (const draft of this.dependencies.getDrafts().values()) {
      if (!draft.pending) continue;
      const generation = this.expect(draft.chatId, draftForSync(draft), 0);
      void this.perform(draft.chatId, generation);
    }
  }

  async flush(chatId: string) {
    let entry = this.syncs.get(chatId);
    const cached = this.dependencies.getDrafts().get(chatId);
    if (!entry && cached?.pending) {
      const generation = this.expect(chatId, draftForSync(cached));
      entry = this.syncs.get(chatId);
      if (entry?.generation !== generation) return;
    }
    if (!entry || entry.sent) return;
    await this.perform(chatId, entry.generation);
  }

  async flushPending() {
    await Promise.all([...this.dependencies.getDrafts().values()]
      .filter((draft) => draft.pending)
      .map((draft) => this.flush(draft.chatId)));
  }

  acceptServerDraft(chatId: string, draft?: ChatDraft) {
    const incoming = draftForSync(draft);
    const expected = this.syncs.get(chatId);
    if (expected && draftSignature(incoming) !== draftSignature(expected.draft)) return false;
    if (expected) {
      clearDraftSyncTimers(expected);
      this.syncs.delete(chatId);
    }
    const drafts = new Map(this.dependencies.getDrafts());
    if (incoming) drafts.set(chatId, { ...incoming, pending: false });
    else drafts.delete(chatId);
    this.dependencies.setDrafts(drafts);
    this.dependencies.scheduleCacheWrite();
    return true;
  }

  replaceServerDrafts(incomingDrafts: ChatDraft[], chatIds: string[]) {
    const incoming = new Map(incomingDrafts.map((draft) => [draft.chatId, draft]));
    const drafts = new Map(this.dependencies.getDrafts());
    for (const chatId of chatIds) {
      if (drafts.get(chatId)?.pending) continue;
      const draft = incoming.get(chatId);
      if (draft) drafts.set(chatId, { ...draft, pending: false });
      else drafts.delete(chatId);
    }
    this.dependencies.setDrafts(drafts);
    this.dependencies.scheduleCacheWrite();
  }

  markAwaitingAck(chatId: string, generation: number) {
    const entry = this.syncs.get(chatId);
    if (!entry || entry.generation !== generation) return;
    entry.sent = true;
    entry.ackTimer = globalThis.setTimeout(
      () => this.settleWithoutServerUpdate(chatId, generation),
      DRAFT_ACK_TIMEOUT_MS,
    );
  }

  cancelExpectation(chatId: string, generation: number) {
    const entry = this.syncs.get(chatId);
    if (!entry || entry.generation !== generation) return;
    clearDraftSyncTimers(entry);
    this.syncs.delete(chatId);
  }

  clear() {
    for (const entry of this.syncs.values()) clearDraftSyncTimers(entry);
    this.syncs.clear();
    this.requestChains.clear();
  }

  private settleWithoutServerUpdate(chatId: string, generation: number) {
    const entry = this.syncs.get(chatId);
    if (!entry || entry.generation !== generation) return;
    this.syncs.delete(chatId);
    const drafts = new Map(this.dependencies.getDrafts());
    const current = drafts.get(chatId);
    if (!entry.draft) {
      drafts.delete(chatId);
    } else if (draftSignature(current) === draftSignature(entry.draft)) {
      drafts.set(chatId, { ...entry.draft, pending: false });
    }
    this.dependencies.setDrafts(drafts);
    this.dependencies.scheduleCacheWrite();
  }

  private perform(chatId: string, generation: number): Promise<void> {
    const entry = this.syncs.get(chatId);
    if (!entry || entry.generation !== generation || entry.sent) return Promise.resolve();
    if (entry.timer) globalThis.clearTimeout(entry.timer);
    entry.timer = undefined;
    if (!this.dependencies.isReady()) return Promise.resolve();

    const previous = this.requestChains.get(chatId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const current = this.syncs.get(chatId);
        if (!current || current.generation !== generation || current.sent) return;
        try {
          await this.dependencies.sendDraft(chatId, current.draft);
        } catch (error) {
          const latest = this.syncs.get(chatId);
          if (!latest || latest.generation !== generation) return;
          const retryDelay = DRAFT_RETRY_DELAYS_MS[latest.attempts];
          latest.attempts += 1;
          if (retryDelay !== undefined) {
            latest.timer = globalThis.setTimeout(
              () => void this.perform(chatId, generation),
              retryDelay,
            );
          }
          this.dependencies.reportError(
            error instanceof Error ? error.message : "草稿同步失败",
          );
          return;
        }

        const latest = this.syncs.get(chatId);
        if (!latest || latest.generation !== generation) return;
        latest.sent = true;
        latest.attempts = 0;
        latest.ackTimer = globalThis.setTimeout(
          () => this.settleWithoutServerUpdate(chatId, generation),
          DRAFT_ACK_TIMEOUT_MS,
        );
      });
    const tracked = operation.finally(() => {
      if (this.requestChains.get(chatId) === tracked) this.requestChains.delete(chatId);
    });
    this.requestChains.set(chatId, tracked);
    return tracked;
  }
}
