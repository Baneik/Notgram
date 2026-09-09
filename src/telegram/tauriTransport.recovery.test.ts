import { afterEach, describe, expect, it, vi } from "vitest";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";
import type { TelegramEventListener } from "./transport";

type Internal = {
  listener?: TelegramEventListener;
  request: (request: TdObject) => Promise<TdObject>;
  bootstrap: () => Promise<void>;
  handleUpdate: (update: TdObject) => void;
  resetSessionState: () => void;
  finishInitialChatSync: () => void;
  requestImmediateConnectionRecovery: (force: boolean) => void;
};
const message = (id: number) => ({
  "@type": "message", id, chat_id: 7, date: 1_700_000_000 + id,
  sender_id: { "@type": "messageSenderUser", user_id: 11 },
  content: { "@type": "messageText", text: { text: String(id), entities: [] } },
});
const connection = (state: string) => ({ "@type": "updateConnectionState", state: { "@type": state } });

describe("TDLib synchronization recovery", () => {
  afterEach(() => vi.useRealTimers());

  it("retries bootstrap after timeouts without needing another authorization event", async () => {
    vi.useFakeTimers();
    const internal = new TauriTelegramTransport() as unknown as Internal;
    internal.listener = vi.fn();
    internal.bootstrap = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(undefined);
    internal.handleUpdate(connection("connectionStateReady"));
    internal.handleUpdate({ "@type": "updateAuthorizationState", authorization_state: { "@type": "authorizationStateReady" } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(internal.bootstrap).toHaveBeenCalledTimes(2);
    expect(internal.listener).toHaveBeenLastCalledWith({ type: "connection.changed", status: "online" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(internal.bootstrap).toHaveBeenCalledTimes(2);
    internal.resetSessionState();
  });

  it("does not publish online when bootstrap finishes during TDLib update synchronization", async () => {
    const internal = new TauriTelegramTransport() as unknown as Internal;
    internal.listener = vi.fn();
    internal.bootstrap = async () => undefined;
    internal.handleUpdate(connection("connectionStateUpdating"));
    internal.handleUpdate({ "@type": "updateAuthorizationState", authorization_state: { "@type": "authorizationStateReady" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(internal.listener).not.toHaveBeenCalledWith({ type: "connection.changed", status: "online" });
    internal.handleUpdate(connection("connectionStateReady"));
    expect(internal.listener).toHaveBeenCalledWith({ type: "connection.changed", status: "online" });
  });

  it("retires an old in-flight page and restarts exhausted histories from latest", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as Internal;
    let resolveOld!: (value: TdObject) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise<TdObject>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ messages: [message(20)] })
      .mockResolvedValue({ messages: [] });
    internal.request = request;
    const old = transport.loadChatHistory("7", 1);
    const retired = expect(old).rejects.toThrow("superseded");
    transport.resetSyncState();
    const current = await transport.loadChatHistory("7", 1);
    resolveOld({ messages: [message(10)] });
    await retired;
    expect(current.messageIds).toEqual(["20"]);
    await transport.loadChatHistory("7", 1);
    expect(request.mock.calls.at(-1)?.[0].from_message_id).toBe(20);
    transport.resetSyncState();
    request.mockResolvedValueOnce({ messages: [message(30)] });
    expect((await transport.loadChatHistory("7", 1)).messageIds).toEqual(["30"]);
    expect(request.mock.calls.at(-1)?.[0].from_message_id).toBe(0);
  });

  it("keeps boundary-only forum pages retryable and retires their cursors on recovery", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as Internal;
    internal.request = vi.fn(async () => ({ messages: [message(10)] }));
    expect((await transport.loadForumTopicHistory("7", "1", 3)).hasMore).toBe(true);
    const request = vi.fn(async (_request: TdObject) => ({ messages: [message(20)] }));
    internal.request = request;
    transport.resetSyncState();
    expect((await transport.loadForumTopicHistory("7", "1", 1)).messageIds).toEqual(["20"]);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ from_message_id: 0, forum_topic_id: 1 });
  });
});
