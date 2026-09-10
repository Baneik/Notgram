import { describe, expect, it } from "vitest";
import { MockTelegramTransport } from "./mockTransport";

describe("moderation", () => {
  it("blocks/unblocks senders and validates report reasons", async () => {
    const transport = new MockTelegramTransport();
    await transport.setMessageSenderBlocked("u-mia", "user", true);
    expect((await transport.getBlockedSenders()).map((sender) => sender.id)).toContain("u-mia");
    const options = await transport.getChatReportOptions("chat-product", ["p-1"]);
    expect(options.kind).toBe("options");
    if (options.kind !== "options") throw new Error("Expected choices");
    expect(options.options.some((option) => option.title === "Spam or scam")).toBe(true);
    expect(await transport.reportChat({ chatId: "chat-product", messageIds: ["p-1"], optionId: btoa("spam") })).toMatchObject({ kind: "options" });
    expect(await transport.reportChat({ chatId: "chat-product", messageIds: ["p-1"], optionId: btoa("other") })).toEqual({ kind: "text", optionId: btoa("comment:other"), isOptional: false });
    await transport.setMessageSenderBlocked("u-mia", "user", false);
    expect(await transport.getBlockedSenders()).toHaveLength(0);
  });
});
