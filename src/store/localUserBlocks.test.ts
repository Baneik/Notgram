import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../telegram/types";

const user = (id: string): User => ({
  id,
  displayName: `User ${id}`,
  avatar: { label: id, color: "#445566" },
  presence: "offline",
});

describe("local user blocks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    });
  });

  it("assigns distinct animal identities within one account", async () => {
    const { localUserBlocksStore } = await import("./localUserBlocks");
    localUserBlocksStore.getState().blockUser("one", user("alice"));
    localUserBlocksStore.getState().blockUser("one", user("bob"));

    const blocked = localUserBlocksStore.getState().users;
    expect(blocked.map(({ alias }) => alias)).toEqual(["小熊", "小猫"]);
    expect(new Set(blocked.map(({ identityId }) => identityId)).size).toBe(2);
  });

  it("isolates records and identity allocation by account", async () => {
    const { localUserBlocksStore } = await import("./localUserBlocks");
    localUserBlocksStore.getState().blockUser("one", user("alice"));
    localUserBlocksStore.getState().blockUser("two", user("alice"));

    expect(localUserBlocksStore.getState().users.map(({ accountId, alias }) =>
      `${accountId}:${alias}`
    )).toEqual(["one:小熊", "two:小熊"]);
  });

  it("removes only the selected account record", async () => {
    const { localUserBlocksStore } = await import("./localUserBlocks");
    localUserBlocksStore.getState().blockUser("one", user("alice"));
    localUserBlocksStore.getState().blockUser("two", user("alice"));
    localUserBlocksStore.getState().unblockUser("one", "alice");

    expect(localUserBlocksStore.getState().users).toMatchObject([
      { accountId: "two", userId: "alice" },
    ]);
  });

  it("defaults new and legacy blocks to masking", async () => {
    const { localUserBlocksStore } = await import("./localUserBlocks");
    localUserBlocksStore.getState().blockUser("one", user("alice"));
    const record = localUserBlocksStore.getState().users[0]!;
    expect(record.mode).toBe("mask");
    const { mode: _mode, ...legacy } = record;
    vi.resetModules();
    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify([legacy]));
    const reloaded = await import("./localUserBlocks");
    expect(reloaded.localUserBlocksStore.getState().users[0]?.mode).toBe("mask");
  });

  it("persists mode changes without reallocating identities or changing another account", async () => {
    const { localUserBlocksStore } = await import("./localUserBlocks");
    localUserBlocksStore.getState().blockUser("one", user("alice"));
    localUserBlocksStore.getState().blockUser("two", user("alice"));
    const original = localUserBlocksStore.getState().users[0]!;
    localUserBlocksStore.getState().setUserMode("one", "alice", "hide");
    expect(localUserBlocksStore.getState().users).toEqual([
      { ...original, mode: "hide" }, expect.objectContaining({ accountId: "two", mode: "mask" }),
    ]);
    const saved = vi.mocked(localStorage.setItem).mock.lastCall?.[1]!;
    vi.resetModules();
    vi.mocked(localStorage.getItem).mockReturnValue(saved);
    const reloaded = await import("./localUserBlocks");
    expect(reloaded.localUserBlocksStore.getState().users[0]).toEqual({ ...original, mode: "hide" });
    reloaded.localUserBlocksStore.getState().setUserMode("one", "alice", "mask");
    expect(reloaded.localUserBlocksStore.getState().users[0]).toEqual(original);
  });
});
