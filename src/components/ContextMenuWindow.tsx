import { invoke, isTauri } from "@tauri-apps/api/core";
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
  Search,
  Trash2,
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
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
  search: Search,
  trash: Trash2,
};

export function ContextMenuWindow({ id }: { id: string }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<BroadcastChannel | undefined>(undefined);
  const closingRef = useRef(false);
  const blurArmedRef = useRef(false);
  const [descriptor, setDescriptor] = useState<NativeContextMenuDescriptor>();
  const [expandedId, setExpandedId] = useState<string>();

  const close = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    channelRef.current?.postMessage({ type: "closed", id } satisfies NativeContextMenuMessage);
    if (isTauri()) await getCurrentWindow().close().catch(() => undefined);
    else globalThis.close();
  };

  useEffect(() => {
    document.documentElement.classList.add("context-menu-window-page");
    document.body.classList.add("context-menu-window-page");
    const channel = new BroadcastChannel(NATIVE_CONTEXT_MENU_CHANNEL);
    channelRef.current = channel;
    let readyTimer: ReturnType<typeof globalThis.setInterval> | undefined;
    const ready = () => channel.postMessage({ type: "ready", id } satisfies NativeContextMenuMessage);
    channel.onmessage = (event: MessageEvent<NativeContextMenuMessage>) => {
      const message = event.data;
      if (!message || message.id !== id || message.type !== "init") return;
      if (readyTimer !== undefined) globalThis.clearInterval(readyTimer);
      readyTimer = undefined;
      setDescriptor(message.descriptor);
      applyThemeToDocument(themeIdForColorTheme(message.descriptor.colorTheme));
      if (isTauri()) {
        void getCurrentWindow().setTheme(message.descriptor.colorTheme).catch(() => undefined);
      }
      globalThis.setTimeout(() => { blurArmedRef.current = true; }, 100);
    };
    ready();
    readyTimer = globalThis.setInterval(ready, 200);
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void getCurrentWindow().onFocusChanged(({ payload }) => {
        if (!payload && blurArmedRef.current) void close();
      }).then((listener) => { unlisten = listener; });
    }
    return () => {
      if (readyTimer !== undefined) globalThis.clearInterval(readyTimer);
      unlisten?.();
      channel.close();
      channelRef.current = undefined;
      document.documentElement.classList.remove("context-menu-window-page");
      document.documentElement.removeAttribute("data-theme");
      document.body.classList.remove("context-menu-window-page");
    };
  }, [id]);

  useEffect(() => {
    if (!descriptor) return;
    const timer = globalThis.setTimeout(() => {
      focusFirstMenuButton(menuRef.current);
    }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [descriptor, expandedId]);

  useEffect(() => {
    if (!descriptor) return;
    const geometry = calculateNativeContextMenuGeometry(
      descriptor.items,
      expandedId,
      measureNativeContextMenuLabel,
    );
    if (isTauri()) {
      void invoke("notgram_resize_context_menu_window", {
        id,
        width: expandedId ? geometry.expandedWidth : geometry.width,
        height: geometry.height,
      }).catch(() => { void close(); });
    }
  }, [descriptor, expandedId, id]);

  if (!descriptor) return null;
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
          return (
            <div className="native-context-menu-group" key={item.id}>
              <button
                className={item.danger ? "is-danger" : undefined}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                aria-haspopup={item.children ? "menu" : undefined}
                aria-expanded={item.children ? expanded : undefined}
                onMouseEnter={() => setExpandedId(item.children ? item.id : undefined)}
                onClick={() => item.children ? setExpandedId(expanded ? undefined : item.id) : select(item.id)}
              >
                {item.checked ? <Check size={17} strokeWidth={2.1} /> : <Icon size={17} strokeWidth={1.9} />}
                <span>{item.label}</span>
                {item.children && <ChevronRight className="context-menu-chevron" size={16} />}
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
