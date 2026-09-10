import { describe, expect, it, vi } from "vitest";
import { chatReportRequest, mapChatReportResult } from "./chatReport";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";
import { mapTdMessageProperties } from "./tdlibMapper";

describe("TDLib chat reports", () => {
  it("preserves all server steps and opaque option IDs through the transport", async () => {
    const transport = new TauriTelegramTransport();
    const responses: TdObject[] = [
      { "@type": "reportChatResultOptionRequired", title: "Report", options: [{ id: "AAE+/w==", text: "Spam" }, { id: "Ag==", text: "Scam" }] },
      { "@type": "reportChatResultOptionRequired", title: "Scam", options: [{ id: "Aw==", text: "Phishing" }] },
      { "@type": "reportChatResultTextRequired", option_id: "AAQ=", is_optional: false },
      { "@type": "reportChatResultMessagesRequired" },
      { "@type": "reportChatResultOk" },
    ];
    const request = vi.fn(async () => responses.shift()!);
    (transport as unknown as { request: typeof request }).request = request;
    expect(await transport.getChatReportOptions("-1007", [])).toMatchObject({ kind: "options", options: [{ id: "AAE+/w==" }, { id: "Ag==" }] });
    expect(await transport.reportChat({ chatId: "-1007", messageIds: [], optionId: "Ag==" })).toMatchObject({ kind: "options", title: "Scam" });
    expect(await transport.reportChat({ chatId: "-1007", messageIds: [], optionId: "Aw==" })).toEqual({ kind: "text", optionId: "AAQ=", isOptional: false });
    expect(await transport.reportChat({ chatId: "-1007", messageIds: [], optionId: "AAQ=", text: "说明" })).toEqual({ kind: "messages" });
    expect(await transport.reportChat({ chatId: "-1007", messageIds: ["1048576"], optionId: "AAQ=", text: "说明" })).toEqual({ kind: "ok" });
    expect(request.mock.calls.at(-1)).toEqual([{ "@type": "reportChat", chat_id: -1007, option_id: "AAQ=", message_ids: [1048576], text: "说明" }]);
  });

  it("accepts optional comments and empty opaque IDs without inventing a reason", () => {
    expect(mapChatReportResult({ "@type": "reportChatResultTextRequired", option_id: "", is_optional: true })).toEqual({ kind: "text", optionId: "", isOptional: true });
    expect(mapChatReportResult({ "@type": "reportChatResultOptionRequired", title: "", options: [{ id: "", text: "Other" }] })).toMatchObject({ kind: "options", options: [{ id: "" }] });
  });

  it.each([
    { "@type": "ok" }, { "@type": "futureReportResult" },
    { "@type": "reportChatResultOptionRequired", title: "Report", options: [] },
    { "@type": "reportChatResultOptionRequired", title: "Report", options: [null] },
    { "@type": "reportChatResultOptionRequired", title: "Report", options: [{ id: "a", text: "Spam" }, { id: "a", text: "Scam" }] },
    { "@type": "reportChatResultTextRequired", is_optional: true },
  ])("does not turn unknown or malformed responses into success: %j", raw => {
    expect(() => mapChatReportResult(raw)).toThrow();
  });

  it.each(["中", "あ", "😀"])("preserves all 1024 %s characters and rejects overflow", character => {
    const input = { chatId: "7", messageIds: ["12"], optionId: "AAE+/w==", text: character.repeat(1024) };
    expect(chatReportRequest(input).text).toBe(input.text);
    expect(chatReportRequest(input).option_id).toBe(input.optionId);
    expect(() => chatReportRequest({ ...input, text: input.text + character })).toThrow();
  });

  it("enforces the report message bound and maps server reporting permission", () => {
    expect(() => chatReportRequest({ chatId: "7", optionId: "", messageIds: Array.from({ length: 101 }, (_, i) => String(i + 1)) })).toThrow();
    expect(mapTdMessageProperties({ can_report_chat: false }).canReport).toBe(false);
    expect(mapTdMessageProperties({ can_report_chat: true }).canReport).toBe(true);
  });
});
