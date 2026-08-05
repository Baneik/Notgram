import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import type { ContextMenuPoint } from "../utils/contextMenuLayout";
import { calculateNativeContextMenuGeometry } from "./nativeContextMenuLayout";

export type NativeContextMenuIcon =
  | "archive"
  | "check"
  | "copy"
  | "download"
  | "edit"
  | "folder"
  | "forward"
  | "leave"
  | "pin"
  | "play-window"
  | "reply"
  | "trash";

export interface NativeContextMenuItem {
  id: string;
  label: string;
  icon: NativeContextMenuIcon;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  children?: NativeContextMenuItem[];
}

export interface NativeContextMenuDescriptor {
  label: string;
  colorTheme: "light" | "dark";
  items: NativeContextMenuItem[];
}

export type NativeContextMenuMessage =
  | { type: "ready"; id: string }
  | { type: "init"; id: string; descriptor: NativeContextMenuDescriptor }
  | { type: "action"; id: string; actionId: string }
  | { type: "closed"; id: string };

export const NATIVE_CONTEXT_MENU_CHANNEL = "notgram-context-menu-v1";
const MENU_SCREEN_GAP = 4;

const menuId = () => {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "");
  return random ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
};

const menuPlacement = async (point: ContextMenuPoint, width: number, height: number) => {
  const currentWindow = getCurrentWindow();
  const [origin, sourceScale, innerSize] = await Promise.all([
    currentWindow.outerPosition(),
    currentWindow.scaleFactor(),
    currentWindow.innerSize(),
  ]);
  const xScale = globalThis.innerWidth > 0 ? innerSize.width / globalThis.innerWidth : sourceScale;
  const yScale = globalThis.innerHeight > 0 ? innerSize.height / globalThis.innerHeight : sourceScale;
  const anchor = {
    x: origin.x + point.x * xScale,
    y: origin.y + point.y * yScale,
  };
  const monitor = await monitorFromPoint(anchor.x, anchor.y);
  const targetScale = monitor?.scaleFactor ?? sourceScale;
  const workPosition = monitor?.workArea.position ?? { x: 0, y: 0 };
  const workSize = monitor?.workArea.size ?? {
    width: globalThis.screen.availWidth * targetScale,
    height: globalThis.screen.availHeight * targetScale,
  };
  const widthPx = width * targetScale;
  const heightPx = height * targetScale;
  const gapPx = MENU_SCREEN_GAP * targetScale;
  const marginPx = 6 * targetScale;
  const right = workPosition.x + workSize.width;
  const bottom = workPosition.y + workSize.height;
  let x = anchor.x + gapPx;
  let y = anchor.y + gapPx;
  if (x + widthPx + marginPx > right) x = anchor.x - widthPx - gapPx;
  if (y + heightPx + marginPx > bottom) y = anchor.y - heightPx - gapPx;
  x = Math.max(workPosition.x + marginPx, Math.min(x, right - widthPx - marginPx));
  y = Math.max(workPosition.y + marginPx, Math.min(y, bottom - heightPx - marginPx));
  return { x: Math.round(x), y: Math.round(y), scaleFactor: targetScale };
};

const showNativeContextMenu = async (
  descriptor: NativeContextMenuDescriptor,
  point: ContextMenuPoint,
  signal: AbortSignal,
) => {
  const id = menuId();
  const geometry = calculateNativeContextMenuGeometry(descriptor.items);
  const placement = await menuPlacement(
    point,
    geometry.expandedWidth,
    geometry.maximumExpandedHeight,
  );
  const channel = new BroadcastChannel(NATIVE_CONTEXT_MENU_CHANNEL);
  let settled = false;
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  let finishResult: ((actionId?: string) => void) | undefined;
  const result = new Promise<string | undefined>((resolve) => {
    finishResult = resolve;
  });
  const finish = (actionId?: string) => {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    channel.close();
    finishResult?.(actionId);
  };
  const abort = () => {
    void invoke("notgram_close_context_menu_window", { id }).catch(() => undefined);
    finish();
  };
  signal.addEventListener("abort", abort, { once: true });
  channel.onmessage = (event: MessageEvent<NativeContextMenuMessage>) => {
    const message = event.data;
    if (!message || message.id !== id) return;
    if (message.type === "ready") {
      channel.postMessage({ type: "init", id, descriptor } satisfies NativeContextMenuMessage);
    } else if (message.type === "action") finish(message.actionId);
    else if (message.type === "closed") finish();
  };
  timeout = globalThis.setTimeout(abort, 10_000);
  try {
    await invoke("notgram_open_context_menu_window", {
      id,
      width: geometry.width,
      height: geometry.height,
      x: placement.x,
      y: placement.y,
      scaleFactor: placement.scaleFactor,
    });
  } catch (error) {
    finish();
    throw error;
  }
  return result;
};

export const useNativeContextMenu = (
  descriptor: NativeContextMenuDescriptor,
  point: ContextMenuPoint,
  onAction: (actionId: string) => void,
  onClose: () => void,
  options: { enabled?: boolean } = {},
) => {
  const native = isTauri();
  const enabled = options.enabled ?? true;
  const [failed, setFailed] = useState(false);
  const onActionRef = useRef(onAction);
  const onCloseRef = useRef(onClose);
  onActionRef.current = onAction;
  onCloseRef.current = onClose;
  const identity = JSON.stringify({ descriptor, point });

  useEffect(() => {
    if (!native || !enabled) return;
    const controller = new AbortController();
    void showNativeContextMenu(descriptor, point, controller.signal)
      .then((actionId) => {
        if (controller.signal.aborted) return;
        if (actionId) onActionRef.current(actionId);
        else onCloseRef.current();
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [enabled, identity, native]);

  return native && enabled && !failed;
};
