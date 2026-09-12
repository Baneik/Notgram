import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Archive,
  AlertCircle,
  LoaderCircle,
  AtSign,
  Check,
  ChevronRight,
  ClipboardCopy,
  Download,
  Flag,
  FolderInput,
  Forward,
  LogOut,
  MessageCircle,
  MessageCircleReply,
  Pencil,
  Pin,
  PictureInPicture2,
  RefreshCw,
  Search,
  Trash2,
  UserPlus,
} from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  NATIVE_CONTEXT_MENU_CHANNEL,
  type NativeContextMenuDescriptor,
  type NativeContextMenuIcon,
  type NativeContextMenuItem,
  type NativeContextMenuMessage,
} from "../contextMenu/nativeContextMenuBridge";
import {
  calculateNativeContextMenuGeometry,
  measureNativeContextMenuLabel,
} from "../contextMenu/nativeContextMenuLayout";
import {
  focusFirstMenuButton,
  handleMenuKeyboard,
  handleMenuPointerMove,
} from "../utils/menuKeyboard";
import { applyThemeToDocument, themeIdForColorTheme } from "../theme/theme";
import { StableImage } from "./StableImage";

const icons: Record<NativeContextMenuIcon, typeof Pin> = {
  alert: AlertCircle,
  loading: LoaderCircle,
  archive: Archive,
  at: AtSign,
  check: Check,
  copy: ClipboardCopy,
  download: Download,
  edit: Pencil,
  folder: FolderInput,
  forward: Forward,
  leave: LogOut,
  message: MessageCircle,
  pin: Pin,
  "play-window": PictureInPicture2,
  reply: MessageCircleReply,
  retry: RefreshCw,
  flag: Flag,
  search: Search,
  trash: Trash2,
  "user-plus": UserPlus,
};

interface ContextMenuSession {
  id: string;
  descriptor: NativeContextMenuDescriptor;
}

export function ContextMenuWindow() {
  const menuRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<BroadcastChannel | undefined>(undefined);
  const activeIdRef = useRef<string | undefined>(undefined);
  const shownIdRef = useRef<string | undefined>(undefined);
  const initSignatureRef = useRef<string | undefined>(undefined);
  const closingRef = useRef(false);
  const blurArmedRef = useRef(false);
  const blurTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const expandedCloseTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const [session, setSession] = useState<ContextMenuSession>();
  const [expandedId, setExpandedId] = useState<string>();

  const close = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id || closingRef.current) return;
    closingRef.current = true;
    blurArmedRef.current = false;
    if (blurTimerRef.current !== undefined) globalThis.clearTimeout(blurTimerRef.current);
    if (expandedCloseTimerRef.current !== undefined) globalThis.clearTimeout(expandedCloseTimerRef.current);
    channelRef.current?.postMessage({ type: "closed", id } satisfies NativeContextMenuMessage);
    if (isTauri()) {
      await invoke("notgram_close_context_menu_window", { id }).catch(() => undefined);
    } else {
      globalThis.close();
    }
    if (activeIdRef.current !== id) return;
    activeIdRef.current = undefined;
    shownIdRef.current = undefined;
    setExpandedId(undefined);
    setSession(undefined);
    closingRef.current = false;
  }, []);

  const cancelExpandedClose = () => {
    if (expandedCloseTimerRef.current === undefined) return;
    globalThis.clearTimeout(expandedCloseTimerRef.current);
    expandedCloseTimerRef.current = undefined;
  };
  const scheduleExpandedClose = () => {
    cancelExpandedClose();
    expandedCloseTimerRef.current = globalThis.setTimeout(() => {
      expandedCloseTimerRef.current = undefined;
      setExpandedId(undefined);
    }, 90);
  };

  useEffect(() => {
    document.documentElement.classList.add("context-menu-window-page");
    document.body.classList.add("context-menu-window-page");
    const channel = new BroadcastChannel(NATIVE_CONTEXT_MENU_CHANNEL);
    channelRef.current = channel;
    let readyTimer: ReturnType<typeof globalThis.setInterval> | undefined;
    const ready = () => channel.postMessage({ type: "ready" } satisfies NativeContextMenuMessage);
    const stopReady = () => {
      if (readyTimer !== undefined) globalThis.clearInterval(readyTimer);
      readyTimer = undefined;
    };
    channel.onmessage = (event: MessageEvent<NativeContextMenuMessage>) => {
      const message = event.data;
      if (!message) return;
      if (message.type === "prepared") {
        stopReady();
        return;
      }
      if (message.type !== "init") return;
      stopReady();
      const signature = `${message.id}:${JSON.stringify(message.descriptor)}`;
      if (initSignatureRef.current === signature) return;
      initSignatureRef.current = signature;
      if (activeIdRef.current !== message.id) {
        cancelExpandedClose();
        if (blurTimerRef.current !== undefined) globalThis.clearTimeout(blurTimerRef.current);
        blurArmedRef.current = false;
        shownIdRef.current = undefined;
        setExpandedId(undefined);
      }
      activeIdRef.current = message.id;
      closingRef.current = false;
      setSession({ id: message.id, descriptor: message.descriptor });
      applyThemeToDocument(themeIdForColorTheme(message.descriptor.colorTheme));
      if (isTauri()) {
        void getCurrentWindow().setTheme(message.descriptor.colorTheme).catch(() => undefined);
      }
    };
    ready();
    readyTimer = globalThis.setInterval(ready, 50);
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void getCurrentWindow().onFocusChanged(({ payload }) => {
        if (!payload && blurArmedRef.current) void close();
      }).then((listener) => { unlisten = listener; });
    }
    return () => {
      stopReady();
      if (blurTimerRef.current !== undefined) globalThis.clearTimeout(blurTimerRef.current);
      if (expandedCloseTimerRef.current !== undefined) globalThis.clearTimeout(expandedCloseTimerRef.current);
      unlisten?.();
      channel.close();
      channelRef.current = undefined;
      document.documentElement.classList.remove("context-menu-window-page");
      document.documentElement.removeAttribute("data-theme");
      document.body.classList.remove("context-menu-window-page");
    };
  }, [close]);

  useLayoutEffect(() => {
    if (!session) return;
    const geometry = calculateNativeContextMenuGeometry(
      session.descriptor.items,
      expandedId,
      measureNativeContextMenuLabel,
    );
    if (!isTauri()) return;
    const firstShow = shownIdRef.current !== session.id;
    const command = firstShow
      ? "notgram_show_context_menu_window"
      : "notgram_resize_context_menu_window";
    void invoke<boolean>(command, {
      id: session.id,
      width: expandedId ? geometry.expandedWidth : geometry.width,
      height: geometry.height,
    }).then((applied) => {
      if (!applied || activeIdRef.current !== session.id) return;
      if (firstShow) {
        shownIdRef.current = session.id;
        blurTimerRef.current = globalThis.setTimeout(() => {
          if (activeIdRef.current === session.id) blurArmedRef.current = true;
        }, 50);
      }
      // Updating permissions must not steal keyboard focus from a usable action.
      const focused = document.activeElement;
      if (firstShow || !(focused instanceof HTMLButtonElement) || focused.disabled || !menuRef.current?.contains(focused)) {
        focusFirstMenuButton(menuRef.current);
      }
    }).catch(() => {
      if (activeIdRef.current === session.id) void close();
    });
  }, [close, expandedId, session]);

  if (!session) return null;
  const { id, descriptor } = session;
  const geometry = calculateNativeContextMenuGeometry(
    descriptor.items,
    expandedId,
    measureNativeContextMenuLabel,
  );
  const expandedItem = descriptor.items.find((item) => item.id === expandedId);
  const select = (item: NativeContextMenuItem) => {
    if (item.disabled || item.status || closingRef.current) return;
    channelRef.current?.postMessage({ type: "action", id, actionId: item.id } satisfies NativeContextMenuMessage);
    if (!item.keepOpen) void close();
  };

  return (
    <div
      ref={menuRef}
      className="native-context-menu-stage"
      style={{
        "--native-context-primary-width": `${geometry.primaryPanelWidth}px`,
        "--native-context-submenu-width": `${geometry.submenuPanelWidth}px`,
        "--native-context-submenu-x": `${geometry.submenuOffsetX}px`,
        "--native-context-submenu-y": `${geometry.submenuOffsetY}px`,
      } as CSSProperties}
      data-keyboard-navigation={descriptor.keyboardNavigation ? "true" : undefined}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => handleMenuKeyboard(event, () => { void close(); })}
      onPointerMove={handleMenuPointerMove}
    >
      <div
        className="native-context-menu context-menu-panel"
        role="menu"
        aria-label={descriptor.label}
        tabIndex={-1}
      >
        {descriptor.items.map((item) => {
          const Icon = icons[item.icon];
          if (item.status) return (
            <div key={item.id} className="native-context-menu-status" role="status">
              <Icon size={15} className={item.icon === "loading" ? "spin" : undefined} />
              <span>{item.label}</span>
            </div>
          );
          const expanded = item.id === expandedId;
          const avatarSource = item.avatar?.imagePath
            ? isTauri() ? convertFileSrc(item.avatar.imagePath, "notgram-asset") : item.avatar.imagePath
            : undefined;
          const itemClassName = [
            item.danger ? "is-danger" : "",
            item.avatar ? "native-account-menu-item" : "",
            item.separatorBefore ? "has-separator" : "",
          ].filter(Boolean).join(" ") || undefined;
          return (
            <div className="native-context-menu-group" key={item.id}>
              <button
                className={itemClassName}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                aria-haspopup={item.children ? "menu" : undefined}
                aria-expanded={item.children ? expanded : undefined}
                onMouseEnter={() => {
                  cancelExpandedClose();
                  setExpandedId(item.children ? item.id : undefined);
                }}
                onClick={() => {
                  if (item.actionable || !item.children) select(item);
                  else setExpandedId(expanded ? undefined : item.id);
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1 || !item.middleClickActionId) return;
                  event.preventDefault();
                  channelRef.current?.postMessage({
                    type: "action",
                    id,
                    actionId: item.middleClickActionId,
                  } satisfies NativeContextMenuMessage);
                  if (!item.keepOpen) void close();
                }}
              >
                {item.avatar ? (
                  <span
                    className="native-account-menu-avatar avatar"
                    style={{ backgroundColor: item.avatar.color }}
                    aria-hidden="true"
                  >
                    <span>{item.avatar.label}</span>
                    {avatarSource && <StableImage src={avatarSource} alt="" />}
                  </span>
                ) : item.checked ? (
                  <Check size={17} strokeWidth={2.1} />
                ) : (
                  <Icon size={17} strokeWidth={1.9} />
                )}
                <span>{item.label}</span>
                {item.children ? (
                  <ChevronRight className="context-menu-chevron" size={16} />
                ) : item.avatar && item.checked ? (
                  <Check className="account-switcher-check" size={16} strokeWidth={2.2} />
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
      {expandedItem?.children && (
        <div
          className="native-context-menu-children context-menu-panel"
          role="menu"
          aria-label={expandedItem.label}
          onMouseEnter={cancelExpandedClose}
          onMouseLeave={scheduleExpandedClose}
        >
          {expandedItem.children.map((child) => {
            const ChildIcon = icons[child.icon];
            const childAvatarSource = child.avatar?.imagePath
              ? isTauri() ? convertFileSrc(child.avatar.imagePath, "notgram-asset") : child.avatar.imagePath
              : undefined;
            return (
              <button
                className={[
                  child.danger ? "is-danger" : "",
                  child.avatar ? "native-context-menu-child-item" : "",
                ].filter(Boolean).join(" ") || undefined}
                type="button"
                role="menuitemcheckbox"
                aria-checked={child.checked}
                disabled={child.disabled}
                key={child.id}
                onClick={() => select(child)}
              >
                {child.avatar ? (
                  <span
                    className="native-context-menu-child-avatar avatar"
                    style={{ backgroundColor: child.avatar.color }}
                    aria-hidden="true"
                  >
                    <span>{child.avatar.label}</span>
                    {childAvatarSource && <StableImage src={childAvatarSource} alt="" />}
                  </span>
                ) : child.checked ? <Check size={17} strokeWidth={2.1} /> : <ChildIcon size={17} strokeWidth={1.9} />}
                <span>{child.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
