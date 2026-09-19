import { afterEach, describe, expect, it, vi } from "vitest";
import { TauriTelegramTransport } from "./tauriTransport";
import { TdRequestBroker } from "./tdRequestBroker";
import { RetryableSendError, TdRequestError } from "./sendErrors";
import type { TdObject } from "./tdlibMapper";

type Internal = {
  request: (request: TdObject) => Promise<TdObject>;
  mentionService: { prepare: () => Promise<void> };
};

describe("native send recovery boundaries", () => {
  afterEach(() => vi.useRealTimers());

  it.each([500, 502, 503, 429])("allows replay after explicit TDLib rejection %s", async code => {
    const transport = new TauriTelegramTransport();
    (transport as unknown as Internal).request = async () => { throw new TdRequestError("retry after 60", "rejected", code); };
    await expect(transport.sendMessage({ chatId: "7", text: "hello" })).rejects.toBeInstanceOf(RetryableSendError);
    if (code === 429) await expect(transport.sendMessage({ chatId: "7", text: "hello" })).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it.each([new TdRequestError("timeout", "unknown"), new TdRequestError("permission denied", "rejected", 403), new Error("IPC unavailable")])(
    "does not classify uncertain or permanent send failures as safe to replay: %s", async error => {
      const transport = new TauriTelegramTransport();
      (transport as unknown as Internal).request = async () => { throw error; };
      await expect(transport.sendMessage({ chatId: "7", text: "hello" })).rejects.toBe(error);
    },
  );

  it("can retry a timed-out mention lookup because submission has not started", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as Internal;
    const send = vi.fn();
    internal.request = send;
    internal.mentionService.prepare = async () => { throw new TdRequestError("getUser timeout", "unknown"); };
    await expect(transport.sendMessage({ chatId: "7", text: "hello" })).rejects.toBeInstanceOf(RetryableSendError);
    expect(send).not.toHaveBeenCalled();
  });

  it("nudges connection recovery on send acknowledgement timeout without resending", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => undefined);
    const recover = vi.fn();
    const broker = new TdRequestBroker(invoke, recover);
    const pending = broker.request({ "@type": "sendMessage" });
    const rejected = expect(pending).rejects.toMatchObject({ outcome: "unknown" });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(recover).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not treat local acceptance as final delivery or restart the request timer", async () => {
    vi.useFakeTimers();
    const recover = vi.fn();
    let broker!: TdRequestBroker;
    broker = new TdRequestBroker(async (_command, args) => {
      const request = args?.request as TdObject;
      broker.settle({ "@type": "message", "@extra": request["@extra"],
        sending_state: { "@type": "messageSendingStatePending" } });
    }, recover);
    await broker.request({ "@type": "sendMessage" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(recover).not.toHaveBeenCalled();
    // The Rust watchdog now owns progress after this acceptance boundary.
  });
});
