import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockSnapshot } from "./mockData";
import type { CachedTelegramSnapshot } from "./types";
import { TauriAccountStorage } from "./tauriAccountStorage";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

const snapshotWithMessages = (count: number): CachedTelegramSnapshot => ({
  version: 3,
  savedAt: "2026-08-15T12:00:00.000Z",
  currentUserId: mockSnapshot.currentUserId,
  users: structuredClone(mockSnapshot.users),
  folders: structuredClone(mockSnapshot.folders),
  chats: structuredClone(mockSnapshot.chats),
  messages: Array.from({ length: count }, (_, index) => ({
    ...structuredClone(mockSnapshot.messages[0]),
    id: `cached-${index}`,
  })),
  drafts: [],
  outbox: [],
  activeChatId: mockSnapshot.chats[0]?.id,
  chatFilter: "main",
  profiles: [],
  forumTopics: [],
  lastForumTopicIds: [],
});

describe("TauriAccountStorage snapshot cache", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("sends large snapshots as bounded chunks before committing", async () => {
    await new TauriAccountStorage().saveCachedSnapshot(snapshotWithMessages(130));

    const begin = invokeMock.mock.calls.find(
      ([command]) => command === "telegram_begin_snapshot_cache_write",
    );
    expect(begin?.[1]).toMatchObject({
      header: {
        version: 3,
        currentUserId: mockSnapshot.currentUserId,
        messages: [],
      },
    });
    const messageChunks = invokeMock.mock.calls
      .filter(([, args]) => args?.section === "messages")
      .map(([, args]) => args.values.length);
    expect(messageChunks).toEqual([64, 64, 2]);
    expect(invokeMock.mock.calls.at(-1)?.[0]).toBe("telegram_commit_snapshot_cache_write");
  });

  it("aborts a staged snapshot when a chunk fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "telegram_append_snapshot_cache_chunk") {
        return Promise.reject(new Error("chunk rejected"));
      }
      return Promise.resolve(undefined);
    });

    await expect(new TauriAccountStorage().saveCachedSnapshot(snapshotWithMessages(1)))
      .rejects.toThrow("chunk rejected");
    expect(invokeMock).toHaveBeenLastCalledWith(
      "telegram_abort_snapshot_cache_write",
      expect.objectContaining({ transactionId: expect.any(String) }),
    );
  });
});
