import { describe, expect, it, vi } from "vitest";
import type { ForumTopic, ForumTopicPage } from "../telegram/types";
import { deriveChatManagementCapabilities } from "../telegram/chatManagement";
import {
  createForumController,
  type ForumControllerOptions,
} from "./telegramStore.forum";
import type { TelegramState } from "./telegramStore.types";

const topic = (id: string): ForumTopic => ({
  id,
  chatId: "forum-1",
  name: `Topic ${id}`,
  iconColor: 1,
  createdAt: "2026-08-08T10:00:00.000Z",
  isGeneral: false,
  isOutgoing: false,
  isClosed: false,
  isHidden: false,
  isPinned: false,
  unreadCount: 0,
  unreadMentionCount: 0,
  unreadReactionCount: 0,
  order: id,
  muted: false,
});

interface ForumHarnessState extends Record<string, unknown> {
  chats: Map<string, {
    id: string;
    isForum: boolean;
    canCreateTopics?: boolean;
    management?: ReturnType<typeof deriveChatManagementCapabilities>;
  }>;
  drafts: Map<string, { pending?: boolean; text?: string }>;
  forumTopics: Map<string, ForumTopic[]>;
  forumTopicsLoading: Set<string>;
}

const createHarness = () => {
  let state: ForumHarnessState = {
    chats: new Map([["forum-1", {
      id: "forum-1",
      isForum: true,
      canCreateTopics: true,
      management: deriveChatManagementCapabilities("supergroup", "owner"),
    }]]),
    drafts: new Map<string, { pending?: boolean; text?: string }>(),
    forumTopics: new Map<string, ForumTopic[]>(),
    forumTopicsLoading: new Set<string>(),
  };
  const set = ((patch: Partial<TelegramState> | ((value: TelegramState) => Partial<TelegramState>)) => {
    const next = typeof patch === "function" ? patch(state as unknown as TelegramState) : patch;
    state = { ...state, ...next } as ForumHarnessState;
  }) as ForumControllerOptions["set"];
  const transport = {
    getForumTopics: vi.fn(),
    getForumTopic: vi.fn(),
    createForumTopic: vi.fn(),
    editForumTopic: vi.fn(),
    setForumTopicClosed: vi.fn(),
    setForumTopicPinned: vi.fn(),
  } as unknown as ForumControllerOptions["transport"];
  const controller = createForumController({
    transport,
    get: () => state as unknown as ReturnType<ForumControllerOptions["get"]>,
    set,
    topicKey: (chatId, topicId) => topicId ? `${chatId}:topic:${topicId}` : chatId,
    onError: (error, fallback) => error instanceof Error ? error.message : fallback,
  });
  return { controller, transport, getState: () => state };
};

describe("telegram store forum controller", () => {
  it("loads topics and keeps pending local drafts over server drafts", async () => {
    const harness = createHarness();
    const localDraft = {
      chatId: "forum-1",
      topicId: "topic-1",
      text: "local",
      updatedAt: "2026-08-08T10:01:00.000Z",
      pending: true,
    };
    harness.getState().drafts.set("forum-1:topic:topic-1", localDraft);
    const page: ForumTopicPage = {
      topics: [{ ...topic("topic-1"), draft: { ...localDraft, text: "server" } }, topic("topic-2")],
      hasMore: false,
    };
    vi.mocked(harness.transport.getForumTopics).mockResolvedValue(page);

    await expect(harness.controller.loadForumTopics("forum-1")).resolves.toEqual(page);
    expect(harness.getState().forumTopics.get("forum-1")).toHaveLength(2);
    expect(harness.getState().drafts.get("forum-1:topic:topic-1")?.text).toBe("local");
  });

  it("refreshes topics after a successful topic mutation", async () => {
    const harness = createHarness();
    const created = topic("topic-new");
    vi.mocked(harness.transport.createForumTopic).mockResolvedValue(created);
    vi.mocked(harness.transport.getForumTopics).mockResolvedValue({ topics: [created], hasMore: false });

    await expect(harness.controller.createForumTopic("forum-1", "New topic")).resolves.toEqual(created);
    expect(harness.transport.getForumTopics).toHaveBeenCalledWith({ chatId: "forum-1", query: "", limit: 100 });
    expect(harness.getState().forumTopics.get("forum-1")).toEqual([created]);
  });

  it("shares an in-flight topic request with every caller", async () => {
    const harness = createHarness();
    let resolvePage!: (page: ForumTopicPage) => void;
    vi.mocked(harness.transport.getForumTopics).mockReturnValue(new Promise((resolve) => {
      resolvePage = resolve;
    }));

    const first = harness.controller.loadForumTopics("forum-1");
    const second = harness.controller.loadForumTopics("forum-1");
    expect(harness.transport.getForumTopics).toHaveBeenCalledTimes(1);
    expect(harness.getState().forumTopicsLoading.has("forum-1")).toBe(true);

    const page = { topics: [topic("topic-1")], hasMore: false };
    resolvePage(page);
    await expect(Promise.all([first, second])).resolves.toEqual([page, page]);
    expect(harness.getState().forumTopicsLoading.has("forum-1")).toBe(false);
  });

  it("coalesces exact topic resolution and replaces stale notification settings", async () => {
    const harness = createHarness();
    harness.getState().forumTopics.set("forum-1", [topic("topic-1")]);
    let resolveTopic!: (value: ForumTopic) => void;
    vi.mocked(harness.transport.getForumTopic).mockReturnValue(new Promise((resolve) => {
      resolveTopic = resolve;
    }));

    const first = harness.controller.resolveForumTopic("forum-1", "topic-1");
    const second = harness.controller.resolveForumTopic("forum-1", "topic-1");
    expect(harness.transport.getForumTopic).toHaveBeenCalledTimes(1);
    resolveTopic({ ...topic("topic-1"), muted: true, useDefaultMuteFor: false });

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { id: "topic-1", muted: true, useDefaultMuteFor: false },
      { id: "topic-1", muted: true, useDefaultMuteFor: false },
    ]);
    expect(harness.getState().forumTopics.get("forum-1")?.[0]).toMatchObject({
      muted: true,
      useDefaultMuteFor: false,
    });
  });

  it("blocks topic mutations outside the member's explicit topic scope", async () => {
    const harness = createHarness();
    harness.getState().chats.set("forum-1", {
      id: "forum-1",
      isForum: true,
      canCreateTopics: false,
      management: deriveChatManagementCapabilities("supergroup", "member"),
    });
    harness.getState().forumTopics.set("forum-1", [topic("topic-1")]);

    await expect(harness.controller.createForumTopic("forum-1", "New topic")).resolves.toBeUndefined();
    await expect(harness.controller.editForumTopic("forum-1", "topic-1", "Renamed")).resolves.toBe(false);
    await expect(harness.controller.setForumTopicClosed("forum-1", "topic-1", true)).resolves.toBe(false);
    await expect(harness.controller.setForumTopicPinned("forum-1", "topic-1", true)).resolves.toBe(false);
    expect(harness.transport.createForumTopic).not.toHaveBeenCalled();
    expect(harness.transport.editForumTopic).not.toHaveBeenCalled();
    expect(harness.transport.setForumTopicClosed).not.toHaveBeenCalled();
    expect(harness.transport.setForumTopicPinned).not.toHaveBeenCalled();
  });

  it("lets a member manage an outgoing topic without granting administrator controls", async () => {
    const harness = createHarness();
    harness.getState().chats.set("forum-1", {
      id: "forum-1",
      isForum: true,
      canCreateTopics: true,
      management: deriveChatManagementCapabilities("supergroup", "member"),
    });
    harness.getState().forumTopics.set("forum-1", [{ ...topic("topic-own"), isOutgoing: true }]);
    vi.mocked(harness.transport.createForumTopic).mockResolvedValue(topic("topic-new"));
    vi.mocked(harness.transport.getForumTopics).mockResolvedValue({ topics: [], hasMore: false });
    vi.mocked(harness.transport.editForumTopic).mockResolvedValue(undefined);
    vi.mocked(harness.transport.setForumTopicClosed).mockResolvedValue(undefined);

    await expect(harness.controller.createForumTopic("forum-1", "New topic")).resolves.toBeDefined();
    harness.getState().forumTopics.set("forum-1", [{ ...topic("topic-own"), isOutgoing: true }]);
    await expect(harness.controller.editForumTopic("forum-1", "topic-own", "Renamed")).resolves.toBe(true);
    harness.getState().forumTopics.set("forum-1", [{ ...topic("topic-own"), isOutgoing: true }]);
    await expect(harness.controller.setForumTopicClosed("forum-1", "topic-own", true)).resolves.toBe(true);
    await expect(harness.controller.setForumTopicPinned("forum-1", "topic-own", true)).resolves.toBe(false);
    expect(harness.transport.setForumTopicPinned).not.toHaveBeenCalled();
  });
});
