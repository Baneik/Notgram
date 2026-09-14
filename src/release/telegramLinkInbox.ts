/** One inbox survives login, account transitions and StrictMode effect replay. */
export class TelegramLinkInbox {
  private pending: string[] = [];
  private running = false;
  private wakeRequested = false;
  private consumer?: { ready: () => boolean; open: (url: string) => Promise<unknown>; error: (error: unknown) => void };

  constructor(private readonly take: () => Promise<string[]>) {}

  attach(consumer: NonNullable<TelegramLinkInbox["consumer"]>) {
    this.consumer = consumer;
    void this.wake();
    return () => { if (this.consumer === consumer) this.consumer = undefined; };
  }

  async wake() {
    this.wakeRequested = true;
    if (this.running || !this.consumer?.ready()) return;
    this.running = true;
    try {
      while (this.wakeRequested && this.consumer?.ready()) {
        this.wakeRequested = false;
        const links = await this.take();
        this.pending = [...new Set([...this.pending, ...links])].slice(-16);
        while (this.pending.length && this.consumer?.ready()) {
          const consumer: NonNullable<TelegramLinkInbox["consumer"]> = this.consumer;
          const url = this.pending.shift()!;
          try { await consumer.open(url); }
          catch (error) { if (this.consumer === consumer) consumer.error(error); }
        }
      }
    } catch (error) { this.consumer?.error(error); }
    finally { this.running = false; }
  }
}
