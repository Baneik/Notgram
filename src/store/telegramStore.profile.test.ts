import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatProfile } from "../telegram/types";
import { emptyProfileState } from "./profileState";
import {
  createProfileController,
  type ProfileControllerOptions,
} from "./telegramStore.profile";
import type { TelegramState } from "./telegramStore.types";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

const profile = (id: string): ChatProfile => ({
  id,
  kind: "group",
  chatId: id,
  title: `Group ${id}`,
  avatar: { label: "G", color: "#999999" },
  statusLabel: "group",
  members: [],
  canViewMembers: false,
});

const createHarness = () => {
  let state: ReturnType<ProfileControllerOptions["get"]> = {
    accountProfile: emptyProfileState(),
    contacts: [],
    contactsError: undefined,
    contactsLoading: false,
    profile: emptyProfileState(),
  };
  const set = ((patch: Partial<TelegramState> | ((value: TelegramState) => Partial<TelegramState>)) => {
    const next = typeof patch === "function" ? patch(state as TelegramState) : patch;
    state = { ...state, ...next };
  }) as ProfileControllerOptions["set"];
  const transport = {
    getChatProfile: vi.fn(),
    getChatProfileMembers: vi.fn(),
    getUserProfile: vi.fn(),
    getCurrentUserProfile: vi.fn(),
    updateCurrentUserProfile: vi.fn(),
    setCurrentUserAvatar: vi.fn(),
    getContacts: vi.fn(),
  } as unknown as ProfileControllerOptions["transport"];
  const controller = createProfileController({
    transport,
    get: () => state,
    set,
    scheduleCacheWrite: vi.fn(),
    registerCurrentAccount: vi.fn().mockResolvedValue(undefined),
    onError: (error, fallback) => error instanceof Error ? error.message : fallback,
  });
  return { controller, transport, getState: () => state };
};

afterEach(() => vi.useRealTimers());

describe("telegram store profile controller", () => {
  it("deduplicates an in-flight profile load and exposes hydrated cache entries", async () => {
    const pending = deferred<ChatProfile>();
    const harness = createHarness();
    vi.mocked(harness.transport.getChatProfile).mockReturnValue(pending.promise);

    const first = harness.controller.loadChatProfile("chat-1");
    const second = harness.controller.loadChatProfile("chat-1");
    expect(harness.transport.getChatProfile).toHaveBeenCalledTimes(1);
    pending.resolve(profile("chat-1"));
    await Promise.all([first, second]);

    expect(harness.getState().profile.value?.title).toBe("Group chat-1");
    harness.controller.hydrateCachedProfiles([profile("cached")]);
    expect(harness.controller.getCachedProfiles().map(({ id }) => id)).toEqual(["cached"]);
  });

  it("ignores a stale profile response after the view is cleared", async () => {
    const pending = deferred<ChatProfile>();
    const harness = createHarness();
    vi.mocked(harness.transport.getChatProfile).mockReturnValue(pending.promise);

    const request = harness.controller.loadChatProfile("chat-1");
    harness.controller.clearProfile();
    pending.resolve(profile("chat-1"));
    await request;

    expect(harness.getState().profile).toEqual(emptyProfileState());
  });
});
