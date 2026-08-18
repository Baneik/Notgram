import { isThemeId, type ThemeId } from "../theme/theme";
import {
  parseDesktopNotificationRoute,
  type DesktopNotificationRoute,
} from "./desktopNotifications";

export interface DesktopNotificationWindowItem {
  id: string;
  title: string;
  body: string;
  themeId: ThemeId;
  reduceMotion: boolean;
  createdAtMs: number;
  route: DesktopNotificationRoute;
}

export interface DesktopNotificationWindowSnapshot {
  revision: number;
  items: readonly DesktopNotificationWindowItem[];
}

type NotificationWindowListener = () => void;

const isBoundedText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;

export const parseDesktopNotificationWindowItem = (
  value: unknown,
): DesktopNotificationWindowItem | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<DesktopNotificationWindowItem>;
  const route = parseDesktopNotificationRoute(candidate.route);
  if (
    !isBoundedText(candidate.id, 64) ||
    !isBoundedText(candidate.title, 200) ||
    !isBoundedText(candidate.body, 1_000) ||
    !isThemeId(candidate.themeId) ||
    typeof candidate.reduceMotion !== "boolean" ||
    typeof candidate.createdAtMs !== "number" ||
    !Number.isFinite(candidate.createdAtMs) ||
    candidate.createdAtMs < 0 ||
    !route
  ) return undefined;
  return {
    id: candidate.id,
    title: candidate.title,
    body: candidate.body,
    themeId: candidate.themeId,
    reduceMotion: candidate.reduceMotion,
    createdAtMs: candidate.createdAtMs,
    route,
  };
};

export const parseDesktopNotificationWindowSnapshot = (
  value: unknown,
): DesktopNotificationWindowSnapshot | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<DesktopNotificationWindowSnapshot>;
  const revision = candidate.revision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Array.isArray(candidate.items)
  ) return undefined;
  const seen = new Set<string>();
  const parsed: DesktopNotificationWindowItem[] = [];
  for (const rawItem of candidate.items) {
    const item = parseDesktopNotificationWindowItem(rawItem);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    parsed.push(item);
  }
  return { revision, items: parsed };
};

let snapshot: readonly DesktopNotificationWindowItem[] = [];
let snapshotRevision = -1;
const listeners = new Set<NotificationWindowListener>();

const publish = () => {
  for (const listener of listeners) listener();
};

export const replaceDesktopNotificationWindowSnapshot = (value: unknown) => {
  const parsed = parseDesktopNotificationWindowSnapshot(value);
  if (!parsed || parsed.revision < snapshotRevision) return snapshot;
  snapshotRevision = parsed.revision;
  snapshot = parsed.items;
  publish();
  return snapshot;
};

export const removeDesktopNotificationWindowItem = (id: string) => {
  const next = snapshot.filter((item) => item.id !== id);
  if (next.length === snapshot.length) return snapshot;
  snapshot = next;
  publish();
  return snapshot;
};

export const desktopNotificationWindowStore = {
  getSnapshot: () => snapshot,
  subscribe: (listener: NotificationWindowListener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
