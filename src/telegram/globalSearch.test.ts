import { describe, expect, it } from "vitest";
import { MockTelegramTransport } from "./mockTransport";

describe("global search transport", () => {
  it("paginates filtered results with stable opaque offsets", async () => {
    const transport = new MockTelegramTransport();
    const first = await transport.searchGlobal({
      query: "预览",
      filter: "media",
      limit: 1,
    });

    expect(first.messages).toHaveLength(1);
    expect(first.nextOffset).toBe("1");
    const second = await transport.searchGlobal({
      query: "预览",
      filter: "media",
      offset: first.nextOffset,
      limit: 1,
    });
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].id).not.toBe(first.messages[0].id);
  });

  it("keeps link results separate from regular text results", async () => {
    const result = await new MockTelegramTransport().searchGlobal({
      query: "link",
      filter: "link",
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("p-rich-entities");
  });
});
