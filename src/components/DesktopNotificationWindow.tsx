import { Bell, X } from "lucide-react";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
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
import { StableImage } from "./StableImage";
import { motionDuration, motionLifecycleTiming } from "../utils/motionTokens";
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

interface DesktopNotificationCardProps {
  exiting: boolean;
  item: DesktopNotificationWindowItem;
  onDismiss: (item: DesktopNotificationWindowItem) => void;
  onOpen: (item: DesktopNotificationWindowItem) => void;
}

const DesktopNotificationCard = memo(function DesktopNotificationCard({
  exiting,
  item,
  onDismiss,
  onOpen,
}: DesktopNotificationCardProps) {
  const itemRef = useRef(item);
  itemRef.current = item;
  const [failedAvatarSource, setFailedAvatarSource] = useState<string>();
  const avatarSource = item.avatar.imagePath
    ? isTauri() ? convertFileSrc(item.avatar.imagePath) : item.avatar.imagePath
    : undefined;
  const handleOpen = useCallback(() => onOpen(item), [item, onOpen]);
  const handleDismiss = useCallback(() => onDismiss(item), [item, onDismiss]);
  const handleAvatarError = useCallback(() => {
    if (avatarSource) setFailedAvatarSource(avatarSource);
  }, [avatarSource]);

  useEffect(() => {
    if (exiting) return;
    const elapsed = Math.max(0, Date.now() - item.updatedAtMs);
    const timer = globalThis.setTimeout(
      () => onDismiss(itemRef.current),
      Math.max(0, motionLifecycleTiming.desktopNotificationIdle - elapsed),
    );
    return () => globalThis.clearTimeout(timer);
  }, [exiting, item.updatedAtMs, onDismiss]);

  return (
    <article
      className={`desktop-notification-card${exiting ? " is-exiting" : ""}`}
      data-notification-id={item.id}
      data-notification-updated-at={item.updatedAtMs}
      aria-hidden={exiting || undefined}
      inert={exiting || undefined}
    >
      <header className="desktop-notification-header">
        <span className="desktop-notification-source">
          <Bell size={13} strokeWidth={2.2} aria-hidden="true" />
          <span>Notgram</span>
        </span>
        <button
          className="desktop-notification-close"
          type="button"
          aria-label="关闭通知"
          title="关闭通知"
          onClick={handleDismiss}
        >
          <X size={15} strokeWidth={2} />
        </button>
      </header>
      <button
        className="desktop-notification-open"
        type="button"
        aria-label={`打开 ${item.title} 的消息`}
        onClick={handleOpen}
      >
        <span
          className="desktop-notification-avatar avatar"
          style={{ backgroundColor: item.avatar.color }}
          aria-hidden="true"
        >
          <span>{item.avatar.label}</span>
          {avatarSource && avatarSource !== failedAvatarSource ? (
            <StableImage
              key={avatarSource}
              src={avatarSource}
              alt=""
              loading="eager"
              decoding="async"
              onError={handleAvatarError}
            />
          ) : null}
        </span>
        <span className="desktop-notification-copy">
          <strong>{item.title}</strong>
          <span className="desktop-notification-message" key={item.updatedAtMs}>{item.body}</span>
        </span>
      </button>
    </article>
  );
});

export function DesktopNotificationWindow() {
  const stageRef = useRef<HTMLDivElement>(null);
  const exitTimersRef = useRef(new Map<string, {
    timer: ReturnType<typeof globalThis.setTimeout>;
    updatedAtMs: number;
  }>());
  const lastHeightRef = useRef(0);
  const notifications = useSyncExternalStore(
    desktopNotificationWindowStore.subscribe,
    desktopNotificationWindowStore.getSnapshot,
    desktopNotificationWindowStore.getSnapshot,
  );
  const [exitingVersions, setExitingVersions] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  const finishDismiss = useCallback((id: string, expectedUpdatedAtMs: number) => {
    const pending = exitTimersRef.current.get(id);
    if (pending?.updatedAtMs === expectedUpdatedAtMs) exitTimersRef.current.delete(id);
    void dismissDesktopNotificationWindowItem(id, expectedUpdatedAtMs)
      .then((snapshot) => {
        if (snapshot === undefined) {
          removeDesktopNotificationWindowItem(id, expectedUpdatedAtMs);
        }
        else replaceDesktopNotificationWindowSnapshot(snapshot);
      })
      .catch(() => removeDesktopNotificationWindowItem(id, expectedUpdatedAtMs))
      .finally(() => {
        setExitingVersions((current) => {
          if (current.get(id) !== expectedUpdatedAtMs) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      });
  }, []);

  const dismiss = useCallback((item: DesktopNotificationWindowItem) => {
    const pending = exitTimersRef.current.get(item.id);
    if (pending?.updatedAtMs === item.updatedAtMs) return;
    if (pending) globalThis.clearTimeout(pending.timer);
    setExitingVersions((current) => new Map(current).set(item.id, item.updatedAtMs));
    const timer = globalThis.setTimeout(
      () => finishDismiss(item.id, item.updatedAtMs),
      item.reduceMotion ? 0 : motionDuration.fast,
    );
    exitTimersRef.current.set(item.id, { timer, updatedAtMs: item.updatedAtMs });
  }, [finishDismiss]);

  const open = useCallback((item: DesktopNotificationWindowItem) => {
    dismiss(item);
    void openDesktopNotificationWindowItem(item.route);
  }, [dismiss]);

  useEffect(() => {
    const latestVersions = new Map(notifications.map((item) => [item.id, item.updatedAtMs]));
    const revivedIds: string[] = [];
    for (const [id, pending] of exitTimersRef.current) {
      const latestVersion = latestVersions.get(id);
      if (latestVersion === undefined || latestVersion === pending.updatedAtMs) continue;
      globalThis.clearTimeout(pending.timer);
      exitTimersRef.current.delete(id);
      revivedIds.push(id);
    }
    if (revivedIds.length === 0) return;
    setExitingVersions((current) => {
      const next = new Map(current);
      for (const id of revivedIds) next.delete(id);
      return next;
    });
  }, [notifications]);

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
    for (const { timer } of exitTimersRef.current.values()) globalThis.clearTimeout(timer);
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
          exiting={exitingVersions.get(item.id) === item.updatedAtMs}
          onDismiss={dismiss}
          onOpen={open}
        />
      ))}
    </div>
  );
}
