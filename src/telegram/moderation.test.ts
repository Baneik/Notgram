import { describe, expect, it } from "vitest";
import { MockTelegramTransport } from "./mockTransport";

describe("moderation", () => {
  it("blocks/unblocks senders and validates report reasons", async () => {
    const transport = new MockTelegramTransport();
    await transport.setMessageSenderBlocked("u-mia", "user", true);
    expect((await transport.getBlockedSenders()).map((sender) => sender.id)).toContain("u-mia");
    const options = await transport.getChatReportOptions("chat-product", ["p-1"]);
    expect(options.options.some((option) => option.id === "spam")).toBe(true);
    await transport.reportChat({ chatId: "chat-product", messageIds: ["p-1"], optionId: "spam" });
    await expect(transport.reportChat({ chatId: "chat-product", messageIds: ["p-1"], optionId: "other" })).rejects.toThrow("举报说明");
    await transport.setMessageSenderBlocked("u-mia", "user", false);
    expect(await transport.getBlockedSenders()).toHaveLength(0);
  });
});
