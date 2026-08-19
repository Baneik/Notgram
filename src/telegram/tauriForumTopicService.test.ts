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

  it("resolves one topic once and applies live notification settings to the cache", async () => {
    const harness = createHarness();
    vi.mocked(harness.context.request).mockResolvedValue({
      "@type": "forumTopic",
      info: {
        "@type": "forumTopicInfo",
        chat_id: 1001,
        forum_topic_id: 12,
        name: "Releases",
        icon: { "@type": "forumTopicIcon", color: 7_321_072, custom_emoji_id: 0 },
        creation_date: 1_700_000_000,
      },
      notification_settings: { use_default_mute_for: true, mute_for: 0 },
      last_read_inbox_message_id: 100,
      last_read_outbox_message_id: 90,
      unread_mention_count: 0,
      unread_reaction_count: 0,
      order: "1000",
    });

    const first = harness.service.getForumTopic("1001", "12");
    const second = harness.service.getForumTopic("1001", "12");
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { id: "12", muted: false, useDefaultMuteFor: true },
      { id: "12", muted: false, useDefaultMuteFor: true },
    ]);
    expect(harness.context.request).toHaveBeenCalledTimes(1);

    const pendingNotificationTopic = harness.service.getForumTopic("1001", "12");
    expect(harness.service.applyForumTopicUpdate({
      "@type": "updateForumTopic",
      chat_id: 1001,
      forum_topic_id: 12,
      notification_settings: { use_default_mute_for: false, mute_for: 2_147_483_647 },
      last_read_inbox_message_id: 101,
      last_read_outbox_message_id: 90,
      unread_mention_count: 1,
      unread_reaction_count: 2,
    })).toMatchObject({
      chatId: "1001",
      topic: { id: "12", muted: true, useDefaultMuteFor: false, lastReadInboxMessageId: "101" },
    });
    await expect(pendingNotificationTopic).resolves.toMatchObject({
      id: "12",
      muted: true,
      useDefaultMuteFor: false,
    });
    await expect(harness.service.getForumTopic("1001", "12")).resolves.toMatchObject({
      id: "12",
      muted: true,
      useDefaultMuteFor: false,
      lastReadInboxMessageId: "101",
    });
    expect(harness.context.request).toHaveBeenCalledTimes(1);
  });
});
