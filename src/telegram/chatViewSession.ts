import type { TdObject } from "./tdlibMapper";

/** Keep TDLib's update subscription aligned with synchronous UI navigation. */
export class ChatViewSession {
  private desiredChatId?: string;
  private openedChatId?: string;
  private generation = 0;
  private transition = Promise.resolve();

  constructor(private readonly request: (request: TdObject) => Promise<TdObject>) {}

  focus(chatId?: string) {
    this.desiredChatId = chatId;
    void this.synchronize().catch(() => undefined);
  }

  private synchronize() {
    const generation = this.generation;
    const next = this.transition.catch(() => undefined).then(async () => {
      if (generation !== this.generation) return;
      const target = this.desiredChatId;
      if (this.openedChatId === target) return;
      if (this.openedChatId) {
        await this.request({ "@type": "closeChat", chat_id: Number(this.openedChatId) });
        if (generation !== this.generation) return;
        this.openedChatId = undefined;
      }
      if (target && target === this.desiredChatId) {
        await this.request({ "@type": "openChat", chat_id: Number(target) });
        if (generation !== this.generation) return;
        this.openedChatId = target;
      }
    });
    this.transition = next;
    return next;
  }

  async view(chatId: string, messageIds: number[]) {
    const generation = this.generation;
    await this.synchronize();
    if (generation !== this.generation || this.desiredChatId !== chatId || !messageIds.length) return;
    await this.request({
      "@type": "viewMessages", chat_id: Number(chatId), message_ids: [...new Set(messageIds)],
      source: { "@type": "messageSourceChatHistory" }, force_read: false,
    });
  }

  reset() {
    this.generation++;
    this.desiredChatId = undefined;
    this.openedChatId = undefined;
    this.transition = Promise.resolve();
  }
}
