import { describe, expect, it } from "vitest";
import {
  notificationPresentation,
  shouldNotifyMessage,
} from "./messageNotificationPolicy";

const incomingMessage = {
  outgoing: false,
  notificationsEnabled: true,
  muted: false,
};

describe("message notification policy", () => {
  it("notifies every incoming message from an unmuted conversation", () => {
    expect(shouldNotifyMessage(incomingMessage)).toBe(true);
  });

  it("suppresses only outgoing, globally disabled, and explicitly muted messages", () => {
    expect(shouldNotifyMessage({ ...incomingMessage, outgoing: true })).toBe(false);
    expect(shouldNotifyMessage({
      ...incomingMessage,
      notificationsEnabled: false,
    })).toBe(false);
    expect(shouldNotifyMessage({ ...incomingMessage, muted: true })).toBe(false);
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
