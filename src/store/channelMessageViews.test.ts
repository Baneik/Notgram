import { describe, expect, it, vi } from "vitest";
import { createTelegramStore } from "./telegramStore";
import { MockTelegramTransport } from "../telegram/mockTransport";

describe("channel post views", () => {
  it("accepts only active, live channel posts and preserves normal read markers", async () => {
    const transport = new MockTelegramTransport();
    const views = vi.spyOn(transport, "viewChannelMessages").mockResolvedValue();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    store.getState().selectChat("chat-release");
    await vi.waitFor(() => expect(store.getState().messages.get("chat-release")?.length).toBeGreaterThan(0));
    const state = store.getState();
    const base = state.messages.get("chat-release")!.find(message => message.id === "release-post-1")!;
    store.setState({ messages: new Map(state.messages).set("chat-release", [
      { ...base, id: "live" }, { ...base, id: "deleted", isLocallyDeleted: true },
      { ...base, id: "pending", delivery: "sending" },
      { ...base, id: "service", isChannelPost: false, content: { kind: "service", text: "Notice" } },
    ]) });
    expect(await store.getState().viewChannelMessages("chat-release", ["live", "deleted", "pending", "service", "live"])).toBe(true);
    expect(views).toHaveBeenCalledWith("chat-release", ["live"]);
    store.setState({ connectionStatus: "offline" });
    expect(await store.getState().viewChannelMessages("chat-release", ["live"])).toBe(false);
    store.setState({ connectionStatus: "online", activeChatId: "chat-product" });
    expect(await store.getState().viewChannelMessages("chat-release", ["live"])).toBe(false);
    expect(views).toHaveBeenCalledTimes(1);
    await transport.disconnect();
  });
});
