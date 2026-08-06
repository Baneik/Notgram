import { describe, expect, it } from "vitest";
import { MockTelegramTransport } from "./mockTransport";

describe("bot commands and inline queries", () => {
  it("provides command hints, paginates inline results, and sends the chosen result", async () => {
    const transport = new MockTelegramTransport();
    const internal = transport as unknown as { snapshot: { messages: Array<{ content: { kind: string; text?: string } }> } };
    const commands = await transport.getBotCommandSuggestions("chat-product", "st");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: "start", botUserId: "bot:notgram_bot" });
    const chat = await transport.loadChatHistory("chat-product", 1);
    void chat;
    const first = await transport.getInlineQueryResults("chat-product", "notgram_bot", "release");
    expect(first.results).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    await transport.sendInlineQueryResultMessage("chat-product", "bot:notgram_bot", first.queryId, first.results[0].id);
    await transport.sendBotStartMessage("chat-product", "bot:notgram_bot", "campaign");
    expect(internal.snapshot.messages.some((message) => message.content.kind === "text" && message.content.text?.includes("@notgram_bot"))).toBe(true);
    expect(internal.snapshot.messages.some((message) => message.content.kind === "text" && message.content.text === "/start campaign")).toBe(true);
  });
});
