import {
  parseDesktopNotificationRoute,
  type DesktopNotificationRoute,
} from "./desktopNotifications";

const PENDING_NOTIFICATION_ROUTE_KEY = "notgram.pending-notification-route";

interface RouteStorage {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
}

const sessionRouteStorage = (): RouteStorage | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

export const savePendingNotificationRoute = (
  route: DesktopNotificationRoute,
  storage = sessionRouteStorage(),
) => {
  if (!storage) return false;
  try {
    storage.setItem(PENDING_NOTIFICATION_ROUTE_KEY, JSON.stringify(route));
    return true;
  } catch {
    return false;
  }
};

export const readPendingNotificationRoute = (
  storage = sessionRouteStorage(),
): DesktopNotificationRoute | undefined => {
  if (!storage) return undefined;
  try {
    const serialized = storage.getItem(PENDING_NOTIFICATION_ROUTE_KEY);
    return serialized ? parseDesktopNotificationRoute(JSON.parse(serialized)) : undefined;
  } catch {
    return undefined;
  }
};

export const clearPendingNotificationRoute = (
  storage = sessionRouteStorage(),
) => {
  if (!storage) return;
  try {
    storage.removeItem(PENDING_NOTIFICATION_ROUTE_KEY);
  } catch {
    // A blocked session store only prevents cross-account route restoration.
  }
};
