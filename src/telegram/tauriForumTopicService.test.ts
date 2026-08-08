import { describe, expect, it, vi } from "vitest";
import { TauriForumTopicService, type TauriForumTopicServiceContext } from "./tauriForumTopicService";

const createHarness = () => {
  const context: TauriForumTopicServiceContext = {
    request: vi.fn(),
    emitMessages: vi.fn(),
    emitForumTopicsChanged: vi.fn(),
  };
  return { context, service: new TauriForumTopicService(context) };
};

describe("tauri forum topic service", () => {
  it("bounds topic list requests and preserves pagination fields", async () => {
    const harness = createHarness();
    vi.mocked(harness.context.request).mockResolvedValue({
      "@type": "forumTopics",
      topics: [],
      total_count: 0,
      next_offset_date: 12,
      next_offset_message_id: "33",
      next_offset_forum_topic_id: "44",
    });

    await expect(harness.service.getForumTopics({ chatId: "1001", limit: 500 })).resolves.toMatchObject({
      topics: [],
      totalCount: 0,
      nextOffsetDate: 12,
      nextOffsetMessageId: "33",
      nextOffsetTopicId: "44",
      hasMore: false,
    });
    expect(harness.context.request).toHaveBeenCalledWith(expect.objectContaining({
      "@type": "getForumTopics",
      limit: 100,
    }));
  });

  it("coalesces topic history requests and advances the cursor", async () => {
    const harness = createHarness();
    vi.mocked(harness.context.request).mockResolvedValue({
      "@type": "messages",
      messages: [{ "@type": "message", id: "9" }, { "@type": "message", id: "8" }],
    });

    const first = harness.service.loadForumTopicHistory("1001", "2", 500);
    const second = harness.service.loadForumTopicHistory("1001", "2", 500);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { loadedCount: 2, hasMore: true, messageIds: ["9", "8"] },
      { loadedCount: 2, hasMore: true, messageIds: ["9", "8"] },
    ]);
    expect(harness.context.request).toHaveBeenCalledTimes(1);
    expect(harness.context.emitMessages).toHaveBeenCalledWith([
      { "@type": "message", id: "9" },
      { "@type": "message", id: "8" },
    ]);
  });
});
