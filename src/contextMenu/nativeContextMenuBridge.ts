import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import type { ContextMenuPoint } from "../utils/contextMenuLayout";
import {
  calculateNativeContextMenuGeometry,
  measureNativeContextMenuLabel,
} from "./nativeContextMenuLayout";

export type NativeContextMenuIcon =
  | "archive"
  | "at"
  | "check"
  | "copy"
  | "download"
  | "edit"
  | "folder"
  | "forward"
  | "leave"
  | "message"
  | "pin"
  | "play-window"
  | "reply"
  | "search"
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
  | { type: "ready" }
  | { type: "prepared" }
  | { type: "init"; id: string; descriptor: NativeContextMenuDescriptor }
  | { type: "action"; id: string; actionId: string }
  | { type: "closed"; id: string };

export const NATIVE_CONTEXT_MENU_CHANNEL = "notgram-context-menu-v2";
const MENU_SCREEN_GAP = 4;
const MENU_FIRST_ITEM_CENTER_OFFSET = 33;

let preparation: Promise<void> | undefined;

export const prepareNativeContextMenuWindow = () => {
  if (!isTauri()) return Promise.resolve();
  if (preparation) return preparation;
  const channel = new BroadcastChannel(NATIVE_CONTEXT_MENU_CHANNEL);
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    timeout = globalThis.setTimeout(() => reject(new Error("context menu window did not become ready")), 5_000);
    channel.onmessage = (event: MessageEvent<NativeContextMenuMessage>) => {
      if (event.data?.type !== "ready") return;
      channel.postMessage({ type: "prepared" } satisfies NativeContextMenuMessage);
      resolve();
    };
  });
  const pending = Promise.all([
    invoke<void>("notgram_prepare_context_menu_window"),
    ready,
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
  let y = anchor.y - MENU_FIRST_ITEM_CENTER_OFFSET * targetScale;
  if (x + widthPx + marginPx > right) x = anchor.x - widthPx - gapPx;
  if (y + heightPx + marginPx > bottom) y = anchor.y - heightPx - gapPx;
  x = Math.max(workPosition.x + marginPx, Math.min(x, right - widthPx - marginPx));
  y = Math.max(workPosition.y + marginPx, Math.min(y, bottom - heightPx - marginPx));
  return { x: Math.round(x), y: Math.round(y) };
};

type DescriptorUpdater = (descriptor: NativeContextMenuDescriptor) => void;

const showNativeContextMenu = async (
  initialDescriptor: NativeContextMenuDescriptor,
  point: ContextMenuPoint,
  signal: AbortSignal,
  registerUpdater: (updater?: DescriptorUpdater) => void,
) => {
  const id = menuId();
  const geometry = calculateNativeContextMenuGeometry(
    initialDescriptor.items,
    undefined,
    measureNativeContextMenuLabel,
  );
  const placement = await menuPlacement(
    point,
    geometry.expandedWidth,
    geometry.maximumExpandedHeight,
  );
  if (signal.aborted) return undefined;
  const channel = new BroadcastChannel(NATIVE_CONTEXT_MENU_CHANNEL);
  let descriptor = initialDescriptor;
  let opened = false;
  let settled = false;
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  let finishResult: ((actionId?: string) => void) | undefined;
  const result = new Promise<string | undefined>((resolve) => {
    finishResult = resolve;
  });
  const publishDescriptor = () => {
    if (!opened || settled) return;
    channel.postMessage({ type: "init", id, descriptor } satisfies NativeContextMenuMessage);
  };
  registerUpdater((nextDescriptor) => {
    descriptor = nextDescriptor;
    publishDescriptor();
  });
  const finish = (actionId?: string) => {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    registerUpdater(undefined);
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
    if (!message) return;
    if (message.type === "ready") {
      publishDescriptor();
    } else if (message.type === "action" && message.id === id) {
      finish(message.actionId);
    } else if (message.type === "closed" && message.id === id) {
      finish();
    }
  };
  timeout = globalThis.setTimeout(abort, 10_000);
  try {
    await prepareNativeContextMenuWindow().catch(() => undefined);
    if (signal.aborted) return result;
    await invoke("notgram_open_context_menu_window", {
      id,
      width: geometry.width,
      height: geometry.height,
      x: placement.x,
      y: placement.y,
    });
    opened = true;
    if (signal.aborted) {
      await invoke("notgram_close_context_menu_window", { id }).catch(() => undefined);
      return result;
    }
    publishDescriptor();
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
  }, [enabled, native, point.x, point.y]);

  return native && enabled && !failed;
};
