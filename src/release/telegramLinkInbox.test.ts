import { describe, expect, it, vi } from "vitest";
import { TelegramLinkInbox } from "./telegramLinkInbox";

describe("native Telegram link inbox", () => {
  it("defers cold-start links until login and connectivity are ready", async () => {
    let ready = false;
    const take = vi.fn().mockResolvedValueOnce(["tg://join?invite=private"]).mockResolvedValue([]);
    const open = vi.fn(async () => undefined);
    const inbox = new TelegramLinkInbox(take);
    inbox.attach({ ready: () => ready, open, error: vi.fn() });
    expect(take).not.toHaveBeenCalled();
    ready = true;
    await inbox.wake();
    expect(open).toHaveBeenCalledExactlyOnceWith("tg://join?invite=private");
    await inbox.wake();
    expect(open).toHaveBeenCalledOnce();
  });

  it("keeps drained links across StrictMode detach and reattach", async () => {
    let finish!: (urls: string[]) => void;
    const take = vi.fn().mockImplementationOnce(() => new Promise<string[]>(resolve => { finish = resolve; })).mockResolvedValue([]);
    const inbox = new TelegramLinkInbox(take);
    const stale = vi.fn(async () => undefined);
    const detach = inbox.attach({ ready: () => true, open: stale, error: vi.fn() });
    detach();
    finish(["tg://resolve?domain=public"]);
    await vi.waitFor(() => expect(take).toHaveBeenCalledOnce());
    const open = vi.fn(async () => undefined);
    inbox.attach({ ready: () => true, open, error: vi.fn() });
    await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith("tg://resolve?domain=public"));
    expect(stale).not.toHaveBeenCalled();
  });

  it("serializes warm events and pauses a batch when authorization disappears", async () => {
    let ready = true;
    const take = vi.fn().mockResolvedValueOnce(["tg://resolve?domain=first", "tg://resolve?domain=second"]).mockResolvedValue([]);
    const open = vi.fn(async () => { ready = false; });
    const inbox = new TelegramLinkInbox(take);
    inbox.attach({ ready: () => ready, open, error: vi.fn() });
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(open.mock.calls[0]).toEqual(["tg://resolve?domain=first"]);
    ready = true;
    await inbox.wake();
    expect(open.mock.calls[1]).toEqual(["tg://resolve?domain=second"]);
  });
});
