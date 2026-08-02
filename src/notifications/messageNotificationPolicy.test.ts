import { describe, expect, it } from "vitest";
import {
  notificationPresentation,
  shouldNotifyMessage,
} from "./messageNotificationPolicy";

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

  it("redacts both the chat title and message when previews are disabled", () => {
    expect(notificationPresentation({
      showPreview: false,
      chatTitle: "Private chat",
      messageText: "secret body",
    })).toEqual({ title: "Notgram", body: "收到一条新消息" });
  });

  it("uses safe fallbacks for empty preview content", () => {
    expect(notificationPresentation({
      showPreview: true,
      chatTitle: " ",
      messageText: " ",
    })).toEqual({ title: "Notgram", body: "收到一条新消息" });
  });
});
