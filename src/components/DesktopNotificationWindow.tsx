import { MessageCircle, X } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { applyThemeToDocument } from "../theme/theme";
import { motionDuration } from "../utils/motionTokens";
import {
  dismissDesktopNotificationWindowItem,
  listenForDesktopNotificationWindowChanges,
  openDesktopNotificationWindowItem,
  readDesktopNotificationWindowSnapshot,
  showDesktopNotificationWindow,
} from "../notifications/notificationWindowBridge";
import {
  desktopNotificationWindowStore,
  removeDesktopNotificationWindowItem,
  replaceDesktopNotificationWindowSnapshot,
  type DesktopNotificationWindowItem,
} from "../notifications/notificationWindowStore";

const NOTIFICATION_LIFETIME_MS = 6_000;

interface DesktopNotificationCardProps {
  exiting: boolean;
  item: DesktopNotificationWindowItem;
  onDismiss: (id: string, reduceMotion: boolean) => void;
  onOpen: (item: DesktopNotificationWindowItem) => void;
}

const DesktopNotificationCard = memo(function DesktopNotificationCard({
  exiting,
  item,
  onDismiss,
  onOpen,
}: DesktopNotificationCardProps) {
  const handleOpen = useCallback(() => onOpen(item), [item, onOpen]);
  const handleDismiss = useCallback(() => {
    onDismiss(item.id, item.reduceMotion);
  }, [item.id, item.reduceMotion, onDismiss]);

  useEffect(() => {
    if (exiting) return;
    const elapsed = Math.max(0, Date.now() - item.createdAtMs);
    const timer = globalThis.setTimeout(
      () => onDismiss(item.id, item.reduceMotion),
      Math.max(0, NOTIFICATION_LIFETIME_MS - elapsed),
    );
    return () => globalThis.clearTimeout(timer);
  }, [exiting, item.createdAtMs, item.id, item.reduceMotion, onDismiss]);

  return (
    <article
      className={`desktop-notification-card${exiting ? " is-exiting" : ""}`}
      data-notification-id={item.id}
      aria-hidden={exiting || undefined}
      inert={exiting || undefined}
    >
      <button
        className="desktop-notification-open"
        type="button"
        aria-label={`打开 ${item.title} 的消息`}
        onClick={handleOpen}
      >
        <span className="desktop-notification-icon" aria-hidden="true">
          <MessageCircle size={19} strokeWidth={2} />
        </span>
        <span className="desktop-notification-copy">
          <strong>{item.title}</strong>
          <span>{item.body}</span>
        </span>
      </button>
      <button
        className="desktop-notification-close"
        type="button"
        aria-label="关闭通知"
        title="关闭通知"
        onClick={handleDismiss}
      >
        <X size={16} strokeWidth={2} />
      </button>
    </article>
  );
});

export function DesktopNotificationWindow() {
  const stageRef = useRef<HTMLDivElement>(null);
  const exitTimersRef = useRef(new Map<string, ReturnType<typeof globalThis.setTimeout>>());
  const lastHeightRef = useRef(0);
  const notifications = useSyncExternalStore(
    desktopNotificationWindowStore.subscribe,
    desktopNotificationWindowStore.getSnapshot,
    desktopNotificationWindowStore.getSnapshot,
  );
  const [exitingIds, setExitingIds] = useState<ReadonlySet<string>>(() => new Set());

  const finishDismiss = useCallback((id: string) => {
    exitTimersRef.current.delete(id);
    void dismissDesktopNotificationWindowItem(id)
      .then((snapshot) => {
        if (snapshot === undefined) removeDesktopNotificationWindowItem(id);
        else replaceDesktopNotificationWindowSnapshot(snapshot);
      })
      .catch(() => removeDesktopNotificationWindowItem(id))
      .finally(() => {
        setExitingIds((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      });
  }, []);

  const dismiss = useCallback((id: string, reduceMotion: boolean) => {
    if (exitTimersRef.current.has(id)) return;
    setExitingIds((current) => new Set(current).add(id));
    const timer = globalThis.setTimeout(
      () => finishDismiss(id),
      reduceMotion ? 0 : motionDuration.fast,
    );
    exitTimersRef.current.set(id, timer);
  }, [finishDismiss]);

  const open = useCallback((item: DesktopNotificationWindowItem) => {
    dismiss(item.id, item.reduceMotion);
    void openDesktopNotificationWindowItem(item.route);
  }, [dismiss]);

  useEffect(() => {
    let disposed = false;
    let unlisten: () => void = () => undefined;
    const update = (snapshot: unknown) => {
      if (!disposed) replaceDesktopNotificationWindowSnapshot(snapshot);
    };
    void listenForDesktopNotificationWindowChanges(update)
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => undefined);
    void readDesktopNotificationWindowSnapshot().then(update).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten();
    };
  }, []);

  useEffect(() => () => {
    for (const timer of exitTimersRef.current.values()) globalThis.clearTimeout(timer);
    exitTimersRef.current.clear();
  }, []);

  const latestAppearance = notifications.at(-1);
  useLayoutEffect(() => {
    if (!latestAppearance) return;
    applyThemeToDocument(latestAppearance.themeId);
    document.documentElement.classList.toggle("reduce-motion", latestAppearance.reduceMotion);
    document.documentElement.dataset.motion = latestAppearance.reduceMotion ? "reduced" : "full";
  }, [latestAppearance]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || notifications.length === 0) {
      lastHeightRef.current = 0;
      return;
    }
    let frame: number | undefined;
    const updateLayout = (forcePosition: boolean) => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const height = Math.ceil(stage.scrollHeight);
        if (height <= 0 || (!forcePosition && height === lastHeightRef.current)) return;
        lastHeightRef.current = height;
        void showDesktopNotificationWindow(height);
      });
    };
    const observer = new ResizeObserver(() => updateLayout(false));
    observer.observe(stage);
    updateLayout(true);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [notifications]);

  return (
    <div
      ref={stageRef}
      className="desktop-notification-stage"
      role="region"
      aria-label="桌面通知"
      aria-live="polite"
    >
      {notifications.map((item) => (
        <DesktopNotificationCard
          key={item.id}
          item={item}
          exiting={exitingIds.has(item.id)}
          onDismiss={dismiss}
          onOpen={open}
        />
      ))}
    </div>
  );
}
