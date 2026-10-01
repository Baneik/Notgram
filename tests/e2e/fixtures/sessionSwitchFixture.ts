import type { TelegramSnapshot } from "../../../src/telegram/types";
import type { TelegramEventListener } from "../../../src/telegram/transport";

/** The development and production benchmarks use exactly the same history. */
export function installSessionSwitchFixture(Transport: { prototype: {
  connect: (listener: TelegramEventListener) => Promise<TelegramSnapshot>;
  loadCachedSnapshot: () => Promise<unknown>;
} }) {
  const connect = Transport.prototype.connect;
  Transport.prototype.loadCachedSnapshot = async () => undefined;
  Transport.prototype.connect = async function(this: { snapshot: TelegramSnapshot }, listener) {
    const ids = ["chat-product", "chat-mia"];
    const messages = ids.flatMap(chatId => Array.from({ length: 60 }, (_, i) => ({
      id: chatId + "-perf-" + i, chatId, senderId: i % 4 === 0 ? "self" : "u-mia", outgoing: i % 4 === 0,
      sentAt: new Date(1700000000000 + i * 1000).toISOString(), delivery: "read" as const,
      editedAt: i % 3 === 0 ? "2023-11-14T22:14:00Z" : undefined,
      content: { kind: "text" as const, text: i % 11 === 0 ?
        Array.from({ length: 10 }, (_, line) => "> A **formatted quote** with stable geometry, line " + line).join("\n") + "\n\nReply " + i : i % 5 === 0 ?
        "A long message to exercise metadata wrapping and rich text layout while switching between already loaded conversations. ".repeat(3) :
        "A reusable **formatted** message " + i },
    })));
    this.snapshot.messages = [...this.snapshot.messages.filter(m => !ids.includes(m.chatId)), ...messages];
    this.snapshot.chats = this.snapshot.chats.map(c => ids.includes(c.id)
      ? { ...c, unreadCount: 0, lastReadInboxMessageId: c.id + "-perf-59" } : c);
    return connect.call(this, listener);
  };
}
