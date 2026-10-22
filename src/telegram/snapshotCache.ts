import type { CachedTelegramSnapshot, User } from "./types";

export const SNAPSHOT_CACHE_CHUNK_SIZE = 64;
export const SNAPSHOT_CACHE_MAX_ITEMS = 50_000;
// The native writer adds the owning account and a resolved path to the header.
export const SNAPSHOT_CACHE_MAX_BYTES = 64 * 1024 * 1024 - 64 * 1024;

const userReferenceKeys = new Set([
  "currentUserId", "userId", "peerId", "senderId", "previewSenderId", "actorId", "recipientId",
  "memberUserIds", "memberIds", "recentSenderIds",
]);

/** Follow persisted identities, including embedded replies, service events and rich-text mentions. */
export const usersForSnapshot = (snapshot: CachedTelegramSnapshot, users: Iterable<User>): User[] => {
  const ids = new Set<string>();
  const visit = (value: unknown, key = "") => {
    const reference = userReferenceKeys.has(key) || key.endsWith("UserId") || key.endsWith("UserIds");
    if (typeof value === "string") {
      if (reference) ids.add(value);
    } else if (Array.isArray(value)) {
      for (const child of value) visit(child, key);
    } else if (value && typeof value === "object") {
      if (key === "user" && "id" in value && typeof value.id === "string") ids.add(value.id);
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  for (const [key, value] of Object.entries(snapshot)) if (key !== "users") visit(value, key);
  return [...users].filter(user => ids.has(user.id));
};

const yieldToMainThread = () => new Promise<void>(resolve => globalThis.setTimeout(resolve, 0));

interface SnapshotBudget { items: number; bytes: number }
const nativeBudget: SnapshotBudget = { items: SNAPSHOT_CACHE_MAX_ITEMS, bytes: SNAPSHOT_CACHE_MAX_BYTES };

/** Measure the same empty-array header and serialized chunks as native staging, without a giant JSON string. */
async function snapshotUsage(snapshot: CachedTelegramSnapshot, maxItems: number): Promise<SnapshotBudget> {
  const entries = Object.entries(snapshot);
  const items = entries.reduce((sum, [, value]) => sum + (Array.isArray(value) ? value.length : 0), 0);
  if (items > maxItems) return { items, bytes: 0 };
  const header = Object.fromEntries(entries.map(([key, value]) => [key, Array.isArray(value) ? [] : value]));
  const encoder = new TextEncoder();
  let bytes = encoder.encode(JSON.stringify(header)).byteLength;
  let yieldedAt = performance.now();
  for (const [, value] of entries) {
    if (!Array.isArray(value)) continue;
    for (let index = 0; index < value.length; index += SNAPSHOT_CACHE_CHUNK_SIZE) {
      bytes += encoder.encode(JSON.stringify(value.slice(index, index + SNAPSHOT_CACHE_CHUNK_SIZE))).byteLength;
      if (performance.now() - yieldedAt >= 4) {
        await yieldToMainThread();
        yieldedAt = performance.now();
      }
    }
  }
  return { items, bytes };
}

export async function prepareSnapshotCache(
  snapshot: CachedTelegramSnapshot,
  budget: SnapshotBudget = nativeBudget,
): Promise<CachedTelegramSnapshot> {
  const result = { ...snapshot, users: usersForSnapshot(snapshot, snapshot.users) };
  let usage = await snapshotUsage(result, budget.items);
  const fits = () => usage.items <= budget.items && usage.bytes <= budget.bytes;
  // These sections can be fetched again. Never evict archive copies, unsent state,
  // chat membership or the user identities they still reference to make a write fit.
  for (const section of ["emojiPickerPreviews", "emojiPickerSets", "emojiPickerCatalog", "profiles",
    "forumTopics", "historyContexts", "messages", "lastForumTopicIds"] as const) {
    if (fits()) return result;
    const value = result[section];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    if (section === "emojiPickerCatalog") result[section] = undefined;
    else result[section] = [];
    if (section === "messages") result.historyContexts = [];
    result.users = usersForSnapshot(result, result.users);
    usage = await snapshotUsage(result, budget.items);
  }
  if (!fits()) {
    if (usage.items > budget.items) throw new Error(`UI cache record limit exceeded (${usage.items} > ${budget.items}); local records were preserved`);
    throw new Error(`UI cache byte limit exceeded (${usage.bytes} > ${budget.bytes}); local records were preserved`);
  }
  return result;
}
