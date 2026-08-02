import { describe, expect, it } from "vitest";
import { shouldNotifyMessage } from "./messageNotificationPolicy";

const incomingBackgroundMessage = {
  outgoing: false,
  notificationsEnabled: true,
  muted: false,
  activeChat: false,
  appVisible: false,
};

describe("message notification policy", () => {
  it("notifies for an incoming background message", () => {
    expect(shouldNotifyMessage(incomingBackgroundMessage)).toBe(true);
  });

  it("suppresses outgoing, disabled, muted, and foreground-active messages", () => {
    expect(shouldNotifyMessage({ ...incomingBackgroundMessage, outgoing: true })).toBe(false);
    expect(shouldNotifyMessage({
      ...incomingBackgroundMessage,
      notificationsEnabled: false,
    })).toBe(false);
    expect(shouldNotifyMessage({ ...incomingBackgroundMessage, muted: true })).toBe(false);
    expect(shouldNotifyMessage({
      ...incomingBackgroundMessage,
      activeChat: true,
      appVisible: true,
    })).toBe(false);
  });

  it("still notifies for the selected chat while the app is hidden", () => {
    expect(shouldNotifyMessage({
      ...incomingBackgroundMessage,
      activeChat: true,
    })).toBe(true);
  });
});
