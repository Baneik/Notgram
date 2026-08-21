import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Archive,
  AtSign,
  Check,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  FolderInput,
  Forward,
  LogOut,
  MessageCircle,
  Pin,
  PictureInPicture2,
  Reply,
  Repeat2,
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
  type NativeContextMenuMessage,
} from "../contextMenu/nativeContextMenuBridge";
import {
  calculateNativeContextMenuGeometry,
  measureNativeContextMenuLabel,
} from "../contextMenu/nativeContextMenuLayout";
import { focusFirstMenuButton, handleMenuKeyboard } from "../utils/menuKeyboard";
import { applyThemeToDocument, themeIdForColorTheme } from "../theme/theme";
import { StableImage } from "./StableImage";

const icons: Record<NativeContextMenuIcon, typeof Pin> = {
  archive: Archive,
  at: AtSign,
  check: Check,
  copy: Copy,
  download: Download,
  edit: Edit3,
  folder: FolderInput,
  forward: Forward,
  leave: LogOut,
  message: MessageCircle,
  pin: Pin,
  "play-window": PictureInPicture2,
  reply: Reply,
  repeat: Repeat2,
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
  const [session, setSession] = useState<ContextMenuSession>();
  const [expandedId, setExpandedId] = useState<string>();

  const close = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id || closingRef.current) return;
    closingRef.current = true;
    blurArmedRef.current = false;
    if (blurTimerRef.current !== undefined) globalThis.clearTimeout(blurTimerRef.current);
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
        shownIdRef.current = undefined;
        setExpandedId(undefined);
      }
      activeIdRef.current = message.id;
      closingRef.current = false;
      blurArmedRef.current = false;
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
      focusFirstMenuButton(menuRef.current);
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
  const select = (actionId: string) => {
    channelRef.current?.postMessage({ type: "action", id, actionId } satisfies NativeContextMenuMessage);
    void close();
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
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => handleMenuKeyboard(event, () => { void close(); })}
    >
      <div
        className="native-context-menu context-menu-panel"
        role="menu"
        aria-label={descriptor.label}
        tabIndex={-1}
      >
        {descriptor.items.map((item) => {
          const Icon = icons[item.icon];
          const expanded = item.id === expandedId;
          const avatarSource = item.avatar?.imagePath
            ? isTauri() ? convertFileSrc(item.avatar.imagePath) : item.avatar.imagePath
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
                onMouseEnter={() => setExpandedId(item.children ? item.id : undefined)}
                onClick={() => {
                  if (item.actionable || !item.children) select(item.id);
                  else setExpandedId(expanded ? undefined : item.id);
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
        >
          {expandedItem.children.map((child) => {
            const ChildIcon = icons[child.icon];
            return (
              <button
                className={child.danger ? "is-danger" : undefined}
                type="button"
                role="menuitemcheckbox"
                aria-checked={child.checked}
                disabled={child.disabled}
                key={child.id}
                onClick={() => select(child.id)}
              >
                {child.checked ? <Check size={17} strokeWidth={2.1} /> : <ChildIcon size={17} strokeWidth={1.9} />}
                <span>{child.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
