import { describe, expect, it, vi } from "vitest";

import { TdRequestBroker } from "./tdRequestBroker";

describe("TdRequestBroker prepared files", () => {
  it("waits for a selected profile photo to be accepted by TDLib", async () => {
    let broker!: TdRequestBroker;
    broker = new TdRequestBroker(async (command, args) => {
      expect(command).toBe("telegram_pick_profile_photo");
      const input = args as { extra: string };
      expect(broker.settle({ "@type": "ok", "@extra": input.extra })).toBe(true);
      return true;
    });

    await expect(broker.requestPreparedProfilePhoto()).resolves.toBe(true);
  });

  it("clears a cancelled profile photo request", async () => {
    let extra = "";
    const broker = new TdRequestBroker(async (_command, args) => {
      extra = (args as { extra: string }).extra;
      return false;
    });

    await expect(broker.requestPreparedProfilePhoto()).resolves.toBe(false);
    expect(broker.settle({ "@type": "ok", "@extra": extra })).toBe(false);
  });

  it("routes a selected chat photo through the native picker", async () => {
    let broker!: TdRequestBroker;
    broker = new TdRequestBroker(async (command, args) => {
      expect(command).toBe("telegram_pick_chat_photo");
      const input = args as { chatId: number; extra: string };
      expect(input.chatId).toBe(72);
      expect(broker.settle({ "@type": "ok", "@extra": input.extra })).toBe(true);
      return true;
    });

    await expect(broker.requestPreparedChatPhoto("72")).resolves.toBe(true);
  });

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

  it("sends pasted file payloads through the native-only upload command", async () => {
    let broker!: TdRequestBroker;
    const reportError = vi.fn();
    broker = new TdRequestBroker(async (command, args) => {
      expect(command).toBe("telegram_send_pasted_files");
      const input = args as { chatId: number; extra: string; files: unknown[]; caption?: string };
      expect(input.chatId).toBe(7);
      expect(input.files).toEqual([{
        name: "paste.png",
        mimeType: "image/png",
        dataBase64: "AQID",
        kind: "photo",
      }]);
      expect(input.caption).toBe("图片说明");
      broker.settle({ "@type": "messages", "@extra": input.extra });
      return true;
    });

    await expect(broker.requestPreparedPastedFiles("7", [{
      name: "paste.png",
      mimeType: "image/png",
      dataBase64: "AQID",
      kind: "photo",
    }], "图片说明", reportError)).resolves.toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });
});
