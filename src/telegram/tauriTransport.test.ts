import { describe, expect, it } from "vitest";
import type { TelegramEventListener } from "./transport";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";

type TestableTransport = {
  listener?: TelegramEventListener;
  request: (request: TdObject) => Promise<TdObject>;
  emitMessage: (message: TdObject) => void;
  upsertChat: (chat: TdObject) => void;
  upsertUser: (user: TdObject) => void;
  finishInitialChatSync: () => void;
};

const rawMessage = (id: number): TdObject => ({
  "@type": "message",
  id,
  chat_id: 7,
  sender_id: { "@type": "messageSenderUser", user_id: 11 },
  date: 1_700_000_000 + id,
  content: {
    "@type": "messageText",
    text: { "@type": "formattedText", text: `message ${id}`, entities: [] },
  },
});

const rawChat = (id: number, date: number): TdObject => ({
  "@type": "chat",
  id,
  title: `chat ${id}`,
  type: { "@type": "chatTypePrivate", user_id: id },
  positions: [{
    list: { "@type": "chatListMain" },
    order: String(date),
    is_pinned: false,
  }],
  last_message: { ...rawMessage(id), chat_id: id, date },
  unread_count: 0,
  notification_settings: { mute_for: 0 },
});

describe("TauriTelegramTransport startup", () => {
  it("publishes the initial chat refresh as one atomic event", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];

    internal.listener = (event) => events.push(event);
    internal.upsertChat(rawChat(7, 1_700_000_007));
    internal.upsertChat(rawChat(8, 1_700_000_008));

    expect(events).toEqual([]);
    internal.finishInitialChatSync();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "chats.upserted",
      chats: [{ id: "7" }, { id: "8" }],
    });

    internal.upsertChat(rawChat(7, 1_700_000_009));
    expect(events[1]).toMatchObject({ type: "chat.upsert", chat: { id: "7" } });
  });
});

describe("TauriTelegramTransport history", () => {
  it("keeps loading small TDLib pages until 30 unique messages are available", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const emittedIds: string[] = [];
    const cursors: number[] = [];

    internal.listener = (event) => {
      if (event.type === "message.upsert") emittedIds.push(event.message.id);
    };
    internal.request = async (request) => {
      const cursor = Number(request.from_message_id);
      cursors.push(cursor);
      const newest = cursor === 0 ? 100 : cursor;
      return {
        "@type": "messages",
        total_count: -1,
        messages: [rawMessage(newest), rawMessage(newest - 1)],
      };
    };

    const page = await transport.loadChatHistory("7", 30);

    expect(page).toEqual({
      loadedCount: 30,
      hasMore: true,
      messageIds: expect.any(Array),
    });
    expect(page.messageIds).toHaveLength(30);
    expect(new Set(emittedIds)).toHaveLength(30);
    expect(cursors).toHaveLength(29);
    expect(cursors.slice(0, 3)).toEqual([0, 99, 98]);
  });

  it("retries a stalled cursor before marking history complete", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    let requestCount = 0;

    internal.listener = () => undefined;
    internal.request = async (request) => {
      requestCount += 1;
      const cursor = Number(request.from_message_id);
      return {
        "@type": "messages",
        total_count: -1,
        messages: cursor === 0
          ? [rawMessage(10), rawMessage(9)]
          : [rawMessage(cursor)],
      };
    };

    const firstPage = await transport.loadChatHistory("7", 30);

    expect(firstPage).toEqual({
      loadedCount: 2,
      hasMore: true,
      messageIds: ["10", "9"],
    });
    const secondPage = await transport.loadChatHistory("7", 30);
    expect(secondPage).toEqual({
      loadedCount: 0,
      hasMore: false,
      messageIds: ["9"],
    });
    expect(requestCount).toBe(3);
  });

  it("starts from the latest history window even when live messages are already known", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const cursors: number[] = [];

    internal.listener = () => undefined;
    internal.emitMessage(rawMessage(100));
    internal.emitMessage(rawMessage(99));
    internal.request = async (request) => {
      const cursor = Number(request.from_message_id);
      cursors.push(cursor);
      return {
        "@type": "messages",
        total_count: -1,
        messages: cursor === 0
          ? [rawMessage(100), rawMessage(99)]
          : [rawMessage(99), rawMessage(98)],
      };
    };

    const page = await transport.loadChatHistory("7", 1);

    expect(cursors).toEqual([0, 99]);
    expect(page.loadedCount).toBe(1);
    expect(page.hasMore).toBe(true);
    expect(page.messageIds).toEqual(["100", "99", "98"]);
  });
});

describe("TauriTelegramTransport media", () => {
  it("automatically caches photo media without treating it as a downloaded document", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];

    internal.listener = () => undefined;
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "file",
        id: 91,
        size: 4096,
        local: {
          can_be_downloaded: true,
          is_downloading_active: true,
          is_downloading_completed: false,
        },
        remote: {},
      };
    };

    internal.emitMessage({
      "@type": "message",
      id: 12,
      chat_id: 7,
      sender_id: { "@type": "messageSenderUser", user_id: 11 },
      date: 1_700_000_000,
      content: {
        "@type": "messagePhoto",
        caption: { "@type": "formattedText", text: "preview", entities: [] },
        photo: {
          sizes: [{
            width: 1280,
            height: 720,
            photo: {
              "@type": "file",
              id: 91,
              size: 4096,
              local: {
                can_be_downloaded: true,
                is_downloading_active: false,
                is_downloading_completed: false,
              },
              remote: {},
            },
          }],
        },
      },
    });
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      "@type": "downloadFile",
      file_id: 91,
      priority: 18,
      synchronous: false,
    });
  });
});

describe("TauriTelegramTransport avatars", () => {
  it("downloads and publishes a user's small profile photo", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const imagePaths: Array<string | undefined> = [];

    internal.listener = (event) => {
      if (event.type === "user.upsert") imagePaths.push(event.user.avatar.imagePath);
    };
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "file",
        id: 44,
        local: {
          can_be_downloaded: true,
          is_downloading_active: false,
          is_downloading_completed: true,
          path: "C:\\avatars\\mia.jpg",
        },
        remote: {},
      };
    };

    internal.upsertUser({
      "@type": "user",
      id: 11,
      first_name: "Mia",
      last_name: "Chen",
      profile_photo: {
        small: {
          "@type": "file",
          id: 44,
          local: {
            can_be_downloaded: true,
            is_downloading_active: false,
            is_downloading_completed: false,
          },
          remote: {},
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      "@type": "downloadFile",
      file_id: 44,
      priority: 16,
    });
    expect(imagePaths).toEqual([undefined, "C:\\avatars\\mia.jpg"]);
  });
});
