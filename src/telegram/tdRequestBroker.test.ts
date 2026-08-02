import { describe, expect, it, vi } from "vitest";

import { TdRequestBroker } from "./tdRequestBroker";

describe("TdRequestBroker prepared files", () => {
  it("settles a response that arrives before the native picker command returns", async () => {
    let broker!: TdRequestBroker;
    const reportError = vi.fn();
    broker = new TdRequestBroker(async (_command, args) => {
      const input = args as { extra: string };
      expect(broker.settle({
        "@type": "message",
        "@extra": input.extra,
      })).toBe(true);
      return true;
    });

    await expect(broker.requestPreparedFile("7", reportError)).resolves.toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports an early TDLib error without turning selection into a timeout", async () => {
    let broker!: TdRequestBroker;
    const reportError = vi.fn();
    broker = new TdRequestBroker(async (_command, args) => {
      const input = args as { extra: string };
      broker.settle({
        "@type": "error",
        "@extra": input.extra,
        code: 400,
        message: "UPLOAD_FAILED",
      });
      return true;
    });

    await expect(broker.requestPreparedFile("7", reportError)).resolves.toBe(true);
    expect(reportError).toHaveBeenCalledWith(new Error("UPLOAD_FAILED (400)"));
  });

  it("clears the prepared correlation when selection is cancelled", async () => {
    const reportError = vi.fn();
    let extra = "";
    const broker = new TdRequestBroker(async (_command, args) => {
      const input = args as { extra: string };
      extra = input.extra;
      return false;
    });

    await expect(broker.requestPreparedFile("7", reportError)).resolves.toBe(false);
    expect(broker.settle({ "@type": "message", "@extra": extra })).toBe(false);
    expect(reportError).not.toHaveBeenCalled();
  });
});
