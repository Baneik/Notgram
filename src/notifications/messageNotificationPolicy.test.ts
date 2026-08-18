import { describe, expect, it } from "vitest";
import {
  notificationPresentation,
  shouldNotifyMessage,
} from "./messageNotificationPolicy";

const incomingMessage = {
  outgoing: false,
  notificationsEnabled: true,
  muted: false,
  messageId: "120",
  sentAt: "2026-08-19T02:30:00.000Z",
  lastReadInboxMessageId: "119",
  notBeforeMs: Date.parse("2026-08-19T02:29:50.000Z"),
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

  it("suppresses messages already covered by the Telegram read cursor", () => {
    expect(shouldNotifyMessage({
      ...incomingMessage,
      messageId: "119",
    })).toBe(false);
    expect(shouldNotifyMessage({
      ...incomingMessage,
      messageId: "118",
    })).toBe(false);
  });

  it("does not replay historical updates received during startup", () => {
    expect(shouldNotifyMessage({
      ...incomingMessage,
      messageId: "121",
      sentAt: "2026-08-19T02:00:00.000Z",
    })).toBe(false);
    expect(shouldNotifyMessage({
      ...incomingMessage,
      messageId: "121",
      sentAt: "2026-08-19T02:29:59.000Z",
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
