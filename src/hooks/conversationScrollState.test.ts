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
  it.each([
    ["internal deletion", ["a", "b", "c"], ["a", "c"], 0],
    ["internal history fill", ["island", "recent", "last"], ["island", "fill", "recent", "last"], 0],
    ["tail append", ["a", "b"], ["a", "b", "c"], 0],
    ["tail removal", ["a", "b", "c"], ["a", "b"], 0],
    ["complete prepend", ["a", "b"], ["x", "y", "a", "b"], -2],
    ["complete prefix removal", ["x", "y", "a", "b"], ["a", "b"], 2],
    ["first block member removal or ID confirmation", ["partition-a", "b"], ["partition-a", "b"], 0],
    ["group split", ["a", "b", "c"], ["a", "split-a", "b", "c"], 0],
    ["group merge", ["a", "split-a", "b", "c"], ["a", "b", "c"], 0],
    ["mixed head and tail insertion", ["a", "b"], ["x", "a", "b", "c"], 0],
    ["mixed prefix removal and interior insertion", ["x", "a", "b"], ["a", "fill", "b"], 0],
    ["reordering", ["a", "b", "c"], ["b", "a", "c"], 0],
    ["independent window replacement", ["a", "b"], ["x", "y", "z"], 0],
    ["empty window", ["a", "b"], [], 0],
    ["initial population", [], ["a", "b"], 0],
    ["sponsored prefix", ["a", "b"], ["sponsored:x", "a", "b"], -1],
  ])("uses block-prefix semantics for %s", (name, before, after, delta) => {
    const key = `account:chat:${name}`;
    const first = resolveConversationVirtualIndex(key, before);
    expect(resolveConversationVirtualIndex(key, after)).toBe(first + delta);
  });

  it("does not let an abandoned render change the committed origin", () => {
    const key = "account:chat:abandoned";
    const initial = ["a", "b"];
    const first = resolveConversationVirtualIndex(key, initial);
    const speculative = resolveConversationVirtualIndex(key, ["x", "a", "b"], { commit: false });
    expect(speculative).toBe(first - 1);
    expect(resolveConversationVirtualIndex(key, initial)).toBe(first);
    commitConversationVirtualIndex(key, speculative, ["x", "a", "b"]);
    expect(resolveConversationVirtualIndex(key, initial)).toBe(first);
  });
  it("isolates account/view origins across subsequent interior changes", () => {
    const key = "account:chat:sequence";
    const first = resolveConversationVirtualIndex(key, ["a", "c"]);
    expect(resolveConversationVirtualIndex(key, ["x", "a", "c"])).toBe(first - 1);
    expect(resolveConversationVirtualIndex(key, ["x", "a", "b", "c"])).toBe(first - 1);
    expect(resolveConversationVirtualIndex(`${key}:pinned`, ["a", "c"])).toBe(first);
    expect(resolveConversationVirtualIndex(key, ["a", "b", "c"])).toBe(first);
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
