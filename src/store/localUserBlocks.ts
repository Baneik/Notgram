import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Avatar, User } from "../telegram/types";

export interface LocalBlockedUser {
  accountId: string;
  userId: string;
  realName: string;
  realAvatar: Avatar;
  alias: string;
  aliasAvatar: Avatar;
  identityId: string;
  blockedAt: string;
}

interface AnimalIdentity {
  id: string;
  name: string;
  emoji: string;
  color: string;
}

interface LocalUserBlocksState {
  users: LocalBlockedUser[];
  blockUser: (accountId: string, user: Pick<User, "id" | "displayName" | "avatar">) => void;
  unblockUser: (accountId: string, userId: string) => void;
}

const STORAGE_KEY = "notgram:local-user-blocks:v1";

export const animalIdentities: readonly AnimalIdentity[] = [
  { id: "bear", name: "小熊", emoji: "🐻", color: "#8b6b55" },
  { id: "cat", name: "小猫", emoji: "🐱", color: "#ad7b54" },
  { id: "dog", name: "小狗", emoji: "🐶", color: "#92715b" },
  { id: "rabbit", name: "兔子", emoji: "🐰", color: "#b27b8d" },
  { id: "fox", name: "狐狸", emoji: "🦊", color: "#c86e46" },
  { id: "panda", name: "熊猫", emoji: "🐼", color: "#5d6469" },
  { id: "koala", name: "考拉", emoji: "🐨", color: "#77818b" },
  { id: "tiger", name: "老虎", emoji: "🐯", color: "#bf7a38" },
  { id: "lion", name: "狮子", emoji: "🦁", color: "#a77a3c" },
  { id: "frog", name: "青蛙", emoji: "🐸", color: "#5b8f63" },
  { id: "penguin", name: "企鹅", emoji: "🐧", color: "#4d6878" },
  { id: "owl", name: "猫头鹰", emoji: "🦉", color: "#7b684f" },
  { id: "dolphin", name: "海豚", emoji: "🐬", color: "#4d89a6" },
  { id: "whale", name: "鲸鱼", emoji: "🐳", color: "#557ca3" },
  { id: "otter", name: "水獭", emoji: "🦦", color: "#856853" },
  { id: "hedgehog", name: "刺猬", emoji: "🦔", color: "#8f704f" },
  { id: "squirrel", name: "松鼠", emoji: "🐿️", color: "#a76643" },
  { id: "duck", name: "小鸭", emoji: "🦆", color: "#6f9062" },
  { id: "seal", name: "海豹", emoji: "🦭", color: "#71838d" },
  { id: "parrot", name: "鹦鹉", emoji: "🦜", color: "#4f8a72" },
  { id: "butterfly", name: "蝴蝶", emoji: "🦋", color: "#7778ad" },
  { id: "bee", name: "蜜蜂", emoji: "🐝", color: "#a88435" },
  { id: "octopus", name: "章鱼", emoji: "🐙", color: "#a75f76" },
  { id: "turtle", name: "海龟", emoji: "🐢", color: "#59866d" },
] as const;

const isAvatar = (value: unknown): value is Avatar => {
  if (!value || typeof value !== "object") return false;
  const avatar = value as Partial<Avatar>;
  return typeof avatar.label === "string" && typeof avatar.color === "string";
};

const isLocalBlockedUser = (value: unknown): value is LocalBlockedUser => {
  if (!value || typeof value !== "object") return false;
  const user = value as Partial<LocalBlockedUser>;
  return typeof user.accountId === "string" &&
    typeof user.userId === "string" &&
    typeof user.realName === "string" &&
    isAvatar(user.realAvatar) &&
    typeof user.alias === "string" &&
    isAvatar(user.aliasAvatar) &&
    typeof user.identityId === "string" &&
    typeof user.blockedAt === "string";
};

const readUsers = () => {
  try {
    const serialized = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!serialized) return [];
    const parsed = JSON.parse(serialized) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isLocalBlockedUser) : [];
  } catch {
    return [];
  }
};

const writeUsers = (users: LocalBlockedUser[]) => {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(users));
  } catch {
    // Local display preferences remain usable for the current session.
  }
};

export const nextAnimalIdentity = (
  users: readonly Pick<LocalBlockedUser, "accountId" | "identityId">[],
  accountId: string,
) => {
  const used = new Set(users
    .filter((user) => user.accountId === accountId)
    .map((user) => user.identityId));
  const available = animalIdentities.find((identity) => !used.has(identity.id));
  if (available) return { ...available, suffix: "" };
  const index = users.filter((user) => user.accountId === accountId).length;
  const identity = animalIdentities[index % animalIdentities.length]!;
  return { ...identity, suffix: ` ${Math.floor(index / animalIdentities.length) + 2}` };
};

const initialUsers = readUsers();

export const localUserBlocksStore = createStore<LocalUserBlocksState>((set, get) => ({
  users: initialUsers,
  blockUser: (accountId, user) => {
    const current = get().users;
    const existing = current.find((item) =>
      item.accountId === accountId && item.userId === user.id
    );
    if (existing) return;
    const identity = nextAnimalIdentity(current, accountId);
    const next = [...current, {
      accountId,
      userId: user.id,
      realName: user.displayName,
      realAvatar: user.avatar,
      alias: `${identity.name}${identity.suffix}`,
      aliasAvatar: {
        label: identity.emoji,
        color: identity.color,
      },
      identityId: identity.id,
      blockedAt: new Date().toISOString(),
    } satisfies LocalBlockedUser];
    writeUsers(next);
    set({ users: next });
  },
  unblockUser: (accountId, userId) => {
    const current = get().users;
    const next = current.filter((user) =>
      user.accountId !== accountId || user.userId !== userId
    );
    if (next.length === current.length) return;
    writeUsers(next);
    set({ users: next });
  },
}));

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    localUserBlocksStore.setState({ users: readUsers() });
  });
}

export const useLocalUserBlocks = <T,>(selector: (state: LocalUserBlocksState) => T) =>
  useStore(localUserBlocksStore, selector);
