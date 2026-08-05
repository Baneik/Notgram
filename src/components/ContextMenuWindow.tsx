import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Archive,
  Check,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  FolderInput,
  Forward,
  LogOut,
  Pin,
  PictureInPicture2,
  Reply,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  NATIVE_CONTEXT_MENU_CHANNEL,
  type NativeContextMenuDescriptor,
  type NativeContextMenuIcon,
  type NativeContextMenuMessage,
} from "../contextMenu/nativeContextMenuBridge";
import { focusFirstMenuButton, handleMenuKeyboard } from "../utils/menuKeyboard";

const icons: Record<NativeContextMenuIcon, typeof Pin> = {
  archive: Archive,
  check: Check,
  copy: Copy,
  download: Download,
  edit: Edit3,
  folder: FolderInput,
  forward: Forward,
  leave: LogOut,
  pin: Pin,
  "play-window": PictureInPicture2,
  reply: Reply,
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
    await getCurrentWindow().close().catch(() => undefined);
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
      document.documentElement.classList.toggle(
        "theme-dark",
        message.descriptor.colorTheme === "dark",
      );
      document.documentElement.style.colorScheme = message.descriptor.colorTheme;
      void getCurrentWindow().setTheme(message.descriptor.colorTheme).catch(() => undefined);
      globalThis.setTimeout(() => { blurArmedRef.current = true; }, 100);
    };
    ready();
    readyTimer = globalThis.setInterval(ready, 200);
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onFocusChanged(({ payload }) => {
      if (!payload && blurArmedRef.current) void close();
    }).then((listener) => { unlisten = listener; });
    return () => {
      if (readyTimer !== undefined) globalThis.clearInterval(readyTimer);
      unlisten?.();
      channel.close();
      channelRef.current = undefined;
      document.documentElement.classList.remove("context-menu-window-page");
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

  if (!descriptor) return null;
  const select = (actionId: string) => {
    channelRef.current?.postMessage({ type: "action", id, actionId } satisfies NativeContextMenuMessage);
    void close();
  };

  return (
    <div
      ref={menuRef}
      className="native-context-menu context-menu-panel"
      role="menu"
      aria-label={descriptor.label}
      tabIndex={-1}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => handleMenuKeyboard(event, () => { void close(); })}
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
              onMouseEnter={() => { if (item.children) setExpandedId(item.id); }}
              onClick={() => item.children ? setExpandedId(expanded ? undefined : item.id) : select(item.id)}
            >
              {item.checked ? <Check size={17} strokeWidth={2.1} /> : <Icon size={17} strokeWidth={1.9} />}
              <span>{item.label}</span>
              {item.children && <ChevronRight className="context-menu-chevron" size={16} />}
            </button>
            {expanded && item.children && (
              <div className="native-context-menu-children" role="menu" aria-label={item.label}>
                {item.children.map((child) => {
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
      })}
    </div>
  );
}
