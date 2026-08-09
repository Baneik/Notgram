import { describe, expect, it } from "vitest";
import { MockTelegramTransport } from "./mockTransport";

describe("global search transport", () => {
  it("paginates mock message results in reverse chronological order without overlap", async () => {
    const transport = new MockTelegramTransport();
    const first = await transport.searchGlobal({
      query: "产品讨论历史消息",
      filter: "message",
      limit: 10,
    });
    const second = await transport.searchGlobal({
      query: "产品讨论历史消息",
      filter: "message",
      offset: first.nextOffset,
      limit: 10,
    });

    expect(first.totalCount).toBe(36);
    expect(first.nextOffset).toBe("10");
    expect(first.messages.map(({ id }) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `p-old-${36 - index}`),
    );
    expect(second.nextOffset).toBe("20");
    expect([...new Set([
      ...first.messages.map(({ id }) => id),
      ...second.messages.map(({ id }) => id),
    ])]).toHaveLength(20);
    expect(first.chats.map(({ id }) => id)).toContain("chat-product");
  });

  it("applies media and link filters independently", async () => {
    const transport = new MockTelegramTransport();

    await expect(transport.searchGlobal({
      query: "界面预览",
      filter: "media",
    })).resolves.toMatchObject({ messages: [{ id: "p-5" }] });
    await expect(transport.searchGlobal({
      query: "link",
      filter: "link",
    })).resolves.toMatchObject({ messages: [{ id: "p-rich-entities" }] });
  });

  it("treats search syntax as plain text", async () => {
    const transport = new MockTelegramTransport();

    const page = await transport.searchGlobal({
      query: "产品讨论历史消息 36",
      filter: "message",
    });

    expect(page.messages.map(({ id }) => id)).toEqual(["p-old-36"]);
    expect(page.totalCount).toBe(1);
    await expect(transport.searchGlobal({ query: "literal:[", filter: "all" }))
      .resolves.toMatchObject({ messages: [], totalCount: 0 });
  });
});
