import { invoke, isTauri } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import type { Avatar } from "../telegram/types";
import type { ContextMenuPoint } from "../utils/contextMenuLayout";
import {
  calculateNativeContextMenuGeometry,
  calculateNativeContextMenuPosition,
  measureNativeContextMenuLabel,
  type NativeContextMenuGeometry,
} from "./nativeContextMenuLayout";

export type NativeContextMenuIcon =
  | "cut" | "paste" | "format" | "spoiler" | "strikethrough" | "underline" | "bold" | "blockquote" | "link" | "file"
  | "alert"
  | "loading"
  | "archive"
  | "ban"
  | "bell"
  | "bell-off"
  | "pin-off"
  | "at"
  | "check"
  | "copy"
  | "download"
  | "edit"
  | "folder"
  | "forward"
  | "flag"
  | "leave"
  | "message"
  | "pin"
  | "play-window"
  | "reply"
  | "retry"
  | "search"
  | "trash"
  | "user-plus";

export interface NativeContextMenuItem {
  id: string;
  label: string;
  title?: string;
  shortcut?: string;
  ariaKeyShortcuts?: string;
  icon: NativeContextMenuIcon;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  avatar?: Avatar;
  separatorBefore?: boolean;
  actionable?: boolean;
  /** Action to invoke when the item receives a middle-click. */
  middleClickActionId?: string;
  keepOpen?: boolean;
  status?: boolean;
  children?: NativeContextMenuItem[];
  maxVisibleChildren?: number;
}

export interface NativeContextMenuDescriptor {
  label: string;
  colorTheme: "light" | "dark";
  keyboardNavigation?: boolean;
  items: NativeContextMenuItem[];
}

export type NativeContextMenuMessage =
  | { type: "ready" }
  | { type: "prepared" }
  | { type: "probe" }
  | { type: "init"; id: string; descriptor: NativeContextMenuDescriptor }
  | { type: "shown"; id: string }
  | { type: "failed"; id: string }
  | { type: "dismiss"; id: string }
  | { type: "action"; id: string; actionId: string }
  | { type: "closed"; id: string };

export const NATIVE_CONTEXT_MENU_CHANNEL = "notgram-context-menu-v2";
const NATIVE_CONTEXT_MENU_OPEN_TIMEOUT_MS = 3_000;

let preparation: Promise<void> | undefined;

export const prepareNativeContextMenuWindow = () => {
  if (!isTauri()) return Promise.resolve();
  if (preparation) return preparation;
  const channel = new BroadcastChannel(NATIVE_CONTEXT_MENU_CHANNEL);
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const ready = new Promise<void>((resolve) => {
    channel.onmessage = (event: MessageEvent<NativeContextMenuMessage>) => {
      if (event.data?.type !== "ready") return;
      channel.postMessage({ type: "prepared" } satisfies NativeContextMenuMessage);
      resolve();
    };
  });
  const pending = Promise.race([
    Promise.all([
      invoke<void>("notgram_prepare_context_menu_window").then(() => {
        channel.postMessage({ type: "probe" } satisfies NativeContextMenuMessage);
      }),
      ready,
    ]),
    new Promise<never>((_, reject) => {
      timeout = globalThis.setTimeout(() => reject(new Error("context menu window did not become ready")), 5_000);
    }),
  ]).then(() => undefined).catch((error) => {
    if (preparation === pending) preparation = undefined;
    throw error;
  }).finally(() => {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    channel.close();
  });
  preparation = pending;
  return pending;
};

const menuId = () => {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "");
  return random ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
};

type NativeContextMenuPlacement = "cursor" | "anchor";

const menuPlacement = async (
  point: ContextMenuPoint,
  geometry: Pick<NativeContextMenuGeometry, "width" | "height">,
  placement: NativeContextMenuPlacement,
) => {
  const currentWindow = getCurrentWindow();
  const [origin, sourceScale, innerSize] = await Promise.all([
    currentWindow.innerPosition(),
    currentWindow.scaleFactor(),
    currentWindow.innerSize(),
  ]);
  const xScale = globalThis.innerWidth > 0 ? innerSize.width / globalThis.innerWidth : sourceScale;
  const yScale = globalThis.innerHeight > 0 ? innerSize.height / globalThis.innerHeight : sourceScale;
  const anchor = {
    x: origin.x + point.x * xScale,
    y: origin.y + point.y * yScale,
  };
  const monitor = await monitorFromPoint(anchor.x, anchor.y).catch(() => null)
    ?? await currentMonitor().catch(() => null);
  if (!monitor) throw new Error("context menu monitor unavailable");
  const targetScale = monitor.scaleFactor;
  return calculateNativeContextMenuPosition(
    anchor,
    geometry,
    monitor.workArea,
    targetScale,
    placement,
  );
};

type DescriptorUpdater = (descriptor: NativeContextMenuDescriptor) => void;

const showNativeContextMenu = async (
  initialDescriptor: NativeContextMenuDescriptor,
  point: ContextMenuPoint,
  signal: AbortSignal,
  registerUpdater: (updater?: DescriptorUpdater) => void,
  placement: NativeContextMenuPlacement,
  onKeepOpenAction: (actionId: string) => void,
) => {
  const id = menuId();
  const geometry = calculateNativeContextMenuGeometry(
    initialDescriptor.items,
    undefined,
    measureNativeContextMenuLabel,
  );
  const channel = new BroadcastChannel(NATIVE_CONTEXT_MENU_CHANNEL);
  let descriptor = initialDescriptor;
  let opened = false;
  let settled = false;
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  let finishResult: ((actionId?: string) => void) | undefined;
  let failResult: ((error: Error) => void) | undefined;
  const result = new Promise<string | undefined>((resolve, reject) => {
    finishResult = resolve;
    failResult = reject;
  });
  const publishDescriptor = () => {
    if (!opened || settled) return;
    channel.postMessage({ type: "init", id, descriptor } satisfies NativeContextMenuMessage);
  };
  registerUpdater((nextDescriptor) => {
    descriptor = nextDescriptor;
    publishDescriptor();
  });
  const finish = (actionId?: string, error?: Error) => {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    registerUpdater(undefined);
    channel.close();
    if (error) failResult?.(error);
    else finishResult?.(actionId);
  };
  const closeWindow = () => {
    channel.postMessage({ type: "dismiss", id } satisfies NativeContextMenuMessage);
    void invoke("notgram_close_context_menu_window", { id }).catch(() => undefined);
  };
  const abort = () => {
    closeWindow();
    finish();
  };
  const fail = () => {
    closeWindow();
    preparation = undefined;
    finish(undefined, new Error("context menu did not become visible"));
  };
  signal.addEventListener("abort", abort, { once: true });
  channel.onmessage = (event: MessageEvent<NativeContextMenuMessage>) => {
    const message = event.data;
    if (!message) return;
    if (message.type === "ready") {
      publishDescriptor();
    } else if (message.type === "shown" && message.id === id) {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      timeout = undefined;
    } else if (message.type === "failed" && message.id === id) {
      fail();
    } else if (message.type === "action" && message.id === id) {
      const item = descriptor.items.flatMap(item => [item, ...(item.children ?? [])])
        .find(item => item.id === message.actionId || item.middleClickActionId === message.actionId);
      if (!item || item.disabled || item.status) return;
      if (item.keepOpen) onKeepOpenAction(message.actionId);
      else finish(message.actionId);
    } else if (message.type === "closed" && message.id === id) {
      finish();
    }
  };
  timeout = globalThis.setTimeout(fail, NATIVE_CONTEXT_MENU_OPEN_TIMEOUT_MS);
  // The watchdog also covers placement/preparation IPC. Returning result now
  // lets a stalled native command fall back without waiting for that command.
  void (async () => {
    const [menuPosition] = await Promise.all([
      menuPlacement(point, geometry, placement),
      prepareNativeContextMenuWindow(),
    ]);
    if (settled || signal.aborted) return;
    const applied = await invoke<boolean>("notgram_open_context_menu_window", {
      id,
      width: geometry.width,
      height: geometry.height,
      x: menuPosition.x,
      y: menuPosition.y,
    });
    if (!applied) { if (!settled) fail(); return; }
    opened = true;
    if (settled || signal.aborted) {
      await invoke("notgram_close_context_menu_window", { id }).catch(() => undefined);
      return;
    }
    publishDescriptor();
  })().catch(() => { if (!settled) fail(); });
  if (signal.aborted) abort();
  return result;
};

export const useNativeContextMenu = (
  descriptor: NativeContextMenuDescriptor,
  point: ContextMenuPoint,
  onAction: (actionId: string) => void,
  onClose: () => void,
  options: { enabled?: boolean; placement?: NativeContextMenuPlacement } = {},
) => {
  const native = isTauri();
  const enabled = options.enabled ?? true;
  const [failed, setFailed] = useState(false);
  const onActionRef = useRef(onAction);
  const onCloseRef = useRef(onClose);
  const descriptorRef = useRef(descriptor);
  const updateDescriptorRef = useRef<DescriptorUpdater | undefined>(undefined);
  onActionRef.current = onAction;
  onCloseRef.current = onClose;
  descriptorRef.current = descriptor;
  const descriptorIdentity = JSON.stringify(descriptor);

  useEffect(() => {
    updateDescriptorRef.current?.(descriptorRef.current);
  }, [descriptorIdentity]);

  useEffect(() => {
    if (!native || !enabled) return;
    setFailed(false);
    const controller = new AbortController();
    let registeredUpdater: DescriptorUpdater | undefined;
    const registerUpdater = (updater?: DescriptorUpdater) => {
      if (updater) {
        registeredUpdater = updater;
        updateDescriptorRef.current = updater;
        updater(descriptorRef.current);
      } else if (updateDescriptorRef.current === registeredUpdater) {
        updateDescriptorRef.current = undefined;
      }
    };
    void showNativeContextMenu(
      descriptorRef.current,
      point,
      controller.signal,
      registerUpdater,
      options.placement ?? "cursor",
      (actionId) => { if (!controller.signal.aborted) onActionRef.current(actionId); },
    )
      .then((actionId) => {
        if (controller.signal.aborted) return;
        if (actionId) onActionRef.current(actionId);
        else onCloseRef.current();
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (updateDescriptorRef.current === registeredUpdater) {
        updateDescriptorRef.current = undefined;
      }
    };
  }, [enabled, native, options.placement, point.x, point.y]);

  return native && enabled && !failed;
};
