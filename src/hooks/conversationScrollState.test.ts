import { describe, expect, it, vi } from "vitest";
import {
  captureActiveConversationScrollState,
  registerConversationScrollStateCapture,
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
