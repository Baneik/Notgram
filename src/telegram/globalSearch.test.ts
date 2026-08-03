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

  it("filters global messages with reg: expressions and rejects invalid patterns", async () => {
    const transport = new MockTelegramTransport();

    const page = await transport.searchGlobal({
      query: "reg:^产品讨论历史消息 3[0-6]$",
      filter: "message",
    });

    expect(page.messages.map(({ id }) => id)).toEqual([
      "p-old-36",
      "p-old-35",
      "p-old-34",
      "p-old-33",
      "p-old-32",
      "p-old-31",
      "p-old-30",
    ]);
    expect(page.totalCount).toBe(7);
    await expect(transport.searchGlobal({ query: "reg:[", filter: "all" }))
      .rejects.toThrow("无效的正则表达式");
  });
});
