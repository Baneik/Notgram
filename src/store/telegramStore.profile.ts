import type { TelegramTransport } from "../telegram/transport";
import type { ChatProfile } from "../telegram/types";
import { emptyProfileState } from "./profileState";
import type { TelegramState } from "./telegramStore.types";

type ProfileStoreState = Pick<
  TelegramState,
  | "accountProfile"
  | "contacts"
  | "contactsError"
  | "contactsLoading"
  | "profile"
>;

type StoreSetter = (
  patch: Partial<TelegramState> | ((state: TelegramState) => Partial<TelegramState>),
) => void;

export interface ProfileController {
  getCachedProfiles: () => ChatProfile[];
  hydrateCachedProfiles: (profiles: ChatProfile[]) => void;
  reset: () => void;
  loadCurrentUserProfile: () => Promise<void>;
  updateCurrentUserProfile: (
    input: Parameters<TelegramTransport["updateCurrentUserProfile"]>[0],
  ) => Promise<boolean>;
  changeCurrentUserAvatar: (file?: File) => Promise<boolean>;
  loadChatProfile: (chatId: string) => Promise<void>;
  loadMoreChatProfileMembers: (chatId: string) => Promise<boolean>;
  loadUserProfile: (userId: string) => Promise<void>;
  clearProfile: () => void;
  loadContacts: () => Promise<void>;
}

export interface ProfileControllerOptions {
  transport: TelegramTransport;
  get: () => ProfileStoreState;
  set: StoreSetter;
  scheduleCacheWrite: () => void;
  registerCurrentAccount: () => Promise<unknown>;
  onError: (error: unknown, fallback: string) => string;
}

const profileCacheKey = (profile: ChatProfile) =>
  profile.chatId ? `chat:${profile.chatId}` : profile.userId ? `user:${profile.userId}` : undefined;

/**
 * Coordinates profile reads and their short-lived local cache. The root
 * Telegram store only wires this controller to Zustand and cache snapshots;
 * profile request races and member pagination stay inside this domain.
 */
export const createProfileController = ({
  transport,
  get,
  set,
  scheduleCacheWrite,
  registerCurrentAccount,
  onError,
}: ProfileControllerOptions): ProfileController => {
  let profileGeneration = 0;
  let accountProfileGeneration = 0;
  let contactsGeneration = 0;
  const profileCache = new Map<string, ChatProfile>();
  const profileRefreshes = new Map<string, Promise<ChatProfile>>();

  const refreshProfileCache = (
    cacheKey: string,
    loadProfile: () => Promise<ChatProfile>,
  ) => {
    const pending = profileRefreshes.get(cacheKey);
    if (pending) return pending;
    const request = loadProfile().then((value) => {
      profileCache.set(cacheKey, value);
      scheduleCacheWrite();
      return value;
    }).finally(() => {
      if (profileRefreshes.get(cacheKey) === request) profileRefreshes.delete(cacheKey);
    });
    profileRefreshes.set(cacheKey, request);
    return request;
  };

  const readCachedProfile = (cacheKey: string) => profileCache.get(cacheKey);

  const loadProfile = async (
    target: { kind: "chat"; chatId: string } | { kind: "user"; userId: string },
    cacheKey: string,
    request: () => Promise<ChatProfile>,
    fallback: string,
  ) => {
    const current = get().profile;
    const sameTarget = target.kind === "chat"
      ? current.target?.kind === "chat" && current.target.chatId === target.chatId
      : current.target?.kind === "user" && current.target.userId === target.userId;
    if (
      current.loading &&
      sameTarget
    ) return;
    const generation = ++profileGeneration;
    const cached = readCachedProfile(cacheKey);
    if (cached) set({ profile: { target, value: cached, loading: false } });
    else set({ profile: { target, loading: true } });
    try {
      const value = await refreshProfileCache(cacheKey, request);
      if (generation !== profileGeneration) return;
      set({ profile: { target, value, loading: false } });
    } catch (error) {
      if (generation !== profileGeneration) return;
      set({
        profile: {
          target,
          value: cached,
          loading: false,
          error: onError(error, fallback),
        },
      });
    }
  };

  return {
    getCachedProfiles: () => [...profileCache.values()],

    hydrateCachedProfiles: (profiles) => {
      profileCache.clear();
      for (const profile of profiles) {
        const key = profileCacheKey(profile);
        if (key) profileCache.set(key, profile);
      }
    },

    reset: () => {
      profileGeneration += 1;
      accountProfileGeneration += 1;
      contactsGeneration += 1;
      profileCache.clear();
      profileRefreshes.clear();
    },

    loadCurrentUserProfile: async () => {
      const generation = ++accountProfileGeneration;
      set({ accountProfile: { target: { kind: "current" }, loading: true } });
      try {
        const value = await transport.getCurrentUserProfile();
        if (generation !== accountProfileGeneration) return;
        set({ accountProfile: { target: { kind: "current" }, value, loading: false } });
      } catch (error) {
        if (generation !== accountProfileGeneration) return;
        set({
          accountProfile: {
            target: { kind: "current" },
            loading: false,
            error: onError(error, "无法读取账号资料"),
          },
        });
      }
    },

    updateCurrentUserProfile: async (input) => {
      const current = get().accountProfile;
      if (current.target?.kind !== "current" || current.updating) return false;
      set({ accountProfile: { ...current, updating: true, updateError: undefined } });
      try {
        const value = await transport.updateCurrentUserProfile(input);
        const latest = get().accountProfile;
        if (latest.target?.kind !== "current") return false;
        set({ accountProfile: { ...latest, value, loading: false, updating: false, updateError: undefined } });
        void registerCurrentAccount();
        return true;
      } catch (error) {
        const latest = get().accountProfile;
        if (latest.target?.kind === "current") {
          set({
            accountProfile: {
              ...latest,
              updating: false,
              updateError: onError(error, "无法更新账号资料"),
            },
          });
        }
        return false;
      }
    },

    changeCurrentUserAvatar: async (file) => {
      const current = get().accountProfile;
      if (current.target?.kind !== "current" || current.updating) return false;
      set({ accountProfile: { ...current, updating: true, updateError: undefined } });
      try {
        const value = await transport.setCurrentUserAvatar(file);
        const latest = get().accountProfile;
        if (latest.target?.kind !== "current") return false;
        set({
          accountProfile: {
            ...latest,
            value: value ?? latest.value,
            loading: false,
            updating: false,
            updateError: undefined,
          },
        });
        if (value) void registerCurrentAccount();
        return Boolean(value);
      } catch (error) {
        const latest = get().accountProfile;
        if (latest.target?.kind === "current") {
          set({
            accountProfile: {
              ...latest,
              updating: false,
              updateError: onError(error, "无法更新头像"),
            },
          });
        }
        return false;
      }
    },

    loadChatProfile: (chatId) => loadProfile(
      { kind: "chat", chatId },
      `chat:${chatId}`,
      () => transport.getChatProfile(chatId),
      "无法读取聊天资料",
    ),

    loadMoreChatProfileMembers: async (chatId) => {
      const current = get().profile;
      if (
        current.target?.kind !== "chat" ||
        current.target.chatId !== chatId ||
        !current.value ||
        !current.value.canViewMembers ||
        !current.value.memberHasMore ||
        current.membersLoading
      ) return false;
      const generation = profileGeneration;
      const offset = current.value.memberOffset ?? 0;
      set({ profile: { ...current, membersLoading: true, membersError: undefined } });
      try {
        const page = await transport.getChatProfileMembers(chatId, offset);
        if (generation !== profileGeneration) return false;
        const latest = get().profile;
        if (
          latest.target?.kind !== "chat" ||
          latest.target.chatId !== chatId ||
          !latest.value
        ) return false;
        const members = new Map(latest.value.members.map((member) => [member.user.id, member]));
        for (const member of page.members) {
          if (!members.has(member.user.id)) members.set(member.user.id, member);
        }
        const value: ChatProfile = {
          ...latest.value,
          members: [...members.values()],
          memberOffset: page.offset,
          memberHasMore: page.hasMore &&
            (latest.value.memberCount === undefined || page.offset < latest.value.memberCount),
        };
        profileCache.set(`chat:${chatId}`, value);
        scheduleCacheWrite();
        set({ profile: { ...latest, value, membersLoading: false, membersError: undefined } });
        return true;
      } catch (error) {
        if (generation === profileGeneration) {
          const latest = get().profile;
          if (latest.target?.kind === "chat" && latest.target.chatId === chatId) {
            set({
              profile: {
                ...latest,
                membersLoading: false,
                membersError: onError(error, "鏃犳硶鍔犺浇鏇村鎴愬憳"),
              },
            });
          }
        }
        return false;
      }
    },

    loadUserProfile: (userId) => loadProfile(
      { kind: "user", userId },
      `user:${userId}`,
      () => transport.getUserProfile(userId),
      "无法读取用户资料",
    ),

    clearProfile: () => {
      profileGeneration += 1;
      set({ profile: emptyProfileState() });
    },

    loadContacts: async () => {
      const generation = ++contactsGeneration;
      set({ contactsLoading: true, contactsError: undefined });
      try {
        const contacts = await transport.getContacts();
        if (generation !== contactsGeneration) return;
        set({ contacts, contactsLoading: false });
      } catch (error) {
        if (generation !== contactsGeneration) return;
        set({ contactsLoading: false, contactsError: onError(error, "无法读取联系人") });
      }
    },
  };
};
