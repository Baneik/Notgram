import { describe, expect, it, vi } from "vitest";
import {
  captureActiveConversationScrollState,
  isMessageFullyVisible,
  matchesVirtualMessageLayout,
  registerConversationScrollStateCapture,
  resolveConversationVirtualIndex,
  commitConversationVirtualIndex,
} from "./conversationScrollState";

describe("virtual measurement cache validity", () => {
  it("rejects equal-size timelines with different partitions or ordering", () => {
    const before = new Map([["a", 0], ["b", 0], ["c", 1], ["d", 1]]);
    expect(matchesVirtualMessageLayout(before, new Map(before))).toBe(true);
    expect(matchesVirtualMessageLayout(before, new Map([["a", 0], ["b", 1], ["c", 1], ["d", 1]]))).toBe(false);
    expect(matchesVirtualMessageLayout(before, new Map([["b", 0], ["a", 0], ["c", 1], ["d", 1]]))).toBe(false);
    expect(matchesVirtualMessageLayout(undefined, before)).toBe(false);
  });
});

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
  it("protects the bottom range when history fills a hole after an older cached island", () => {
    const key = "account:chat:hole";
    const first = resolveConversationVirtualIndex(key, new Map([["island", 0], ["recent", 1], ["last", 2]]));
    const next = resolveConversationVirtualIndex(key, new Map([["island", 0], ["fill", 1], ["recent", 2], ["last", 3]]), undefined, { edge: "end" });
    expect(next + 3).toBe(first + 2);
  });

  it("does not let an abandoned render change the committed origin", () => {
    const key = "account:chat:abandoned";
    const initial = new Map([["a", 0], ["b", 1]]);
    const first = resolveConversationVirtualIndex(key, initial);
    const speculative = resolveConversationVirtualIndex(key, new Map([["x", 0], ["a", 1], ["b", 2]]), undefined, { commit: false });
    expect(speculative).toBe(first - 1);
    expect(resolveConversationVirtualIndex(key, initial)).toBe(first);
    commitConversationVirtualIndex(key, speculative, new Map([["x", 0], ["a", 1], ["b", 2]]));
    expect(resolveConversationVirtualIndex(key, initial)).toBe(first);
  });
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
