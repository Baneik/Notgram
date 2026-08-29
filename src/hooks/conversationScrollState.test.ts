import { describe, expect, it, vi } from "vitest";
import {
  captureActiveConversationScrollState,
  isMessageFullyVisible,
  registerConversationScrollStateCapture,
  resolveConversationVirtualIndex,
} from "./conversationScrollState";

describe("conversation scroll state capture", () => {
  it("captures the active viewport and ignores stale cleanup", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerConversationScrollStateCapture(first);
    const unregisterSecond = registerConversationScrollStateCapture(second);

    unregisterFirst();
    captureActiveConversationScrollState();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    unregisterSecond();
    captureActiveConversationScrollState();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe("conversation virtual indexes", () => {
  it("keeps shared messages on the same logical index when history is prepended", () => {
    const key = "account:chat:prepend";
    const initial = resolveConversationVirtualIndex(key, new Map([
      ["current-1", 0],
      ["current-2", 1],
    ]));
    const prepended = resolveConversationVirtualIndex(key, new Map([
      ["older-1", 0],
      ["older-2", 1],
      ["current-1", 2],
      ["current-2", 3],
    ]), "current-1");

    expect(prepended).toBe(initial - 2);
    expect(prepended + 2).toBe(initial);
  });

  it("does not shift the logical origin when messages are appended", () => {
    const key = "account:chat:append";
    const initial = resolveConversationVirtualIndex(key, new Map([
      ["current-1", 0],
      ["current-2", 1],
    ]));
    const appended = resolveConversationVirtualIndex(key, new Map([
      ["current-1", 0],
      ["current-2", 1],
      ["new-1", 2],
    ]));

    expect(appended).toBe(initial);
  });
});

describe("conversation message visibility", () => {
  it("requires the whole target row to fit inside the viewport", () => {
    const list = {
      getBoundingClientRect: () => ({ top: 100, bottom: 500 } as DOMRect),
    } as HTMLElement;
    const target = {
      getBoundingClientRect: () => ({ top: 140, bottom: 460 } as DOMRect),
    } as HTMLElement;
    expect(isMessageFullyVisible(list, target)).toBe(true);

    target.getBoundingClientRect = () => ({ top: 90, bottom: 460 } as DOMRect);
    expect(isMessageFullyVisible(list, target)).toBe(false);
    target.getBoundingClientRect = () => ({ top: 140, bottom: 510 } as DOMRect);
    expect(isMessageFullyVisible(list, target)).toBe(false);
  });
});
