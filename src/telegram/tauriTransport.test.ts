import { describe, expect, it } from "vitest";
import type { TelegramEventListener } from "./transport";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";

type TestableTransport = {
  listener?: TelegramEventListener;
  request: (request: TdObject) => Promise<TdObject>;
  emitMessage: (message: TdObject) => void;
  handleUpdate: (update: TdObject) => void;
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

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "chats.upserted",
      chats: [{ id: "7" }, { id: "8" }],
    });
    expect(events[1]).toEqual({
      type: "drafts.replaced",
      drafts: [],
      chatIds: ["7", "8"],
    });

    internal.upsertChat(rawChat(7, 1_700_000_009));
    expect(events[2]).toMatchObject({ type: "chat.upsert", chat: { id: "7" } });
  });
});

describe("TauriTelegramTransport message operations", () => {
  it("queries current message permissions through TDLib", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "messageProperties",
        can_be_replied: true,
        can_be_edited: true,
        can_be_deleted_only_for_self: false,
        can_be_deleted_for_all_users: true,
        can_be_forwarded: true,
      };
    };

    await expect(transport.getMessageProperties("7", "12")).resolves.toEqual({
      canReply: true,
      canEdit: true,
      canDeleteOnlyForSelf: false,
      canDeleteForAllUsers: true,
      canForward: true,
    });
    expect(requests).toEqual([{
      "@type": "getMessageProperties",
      chat_id: 7,
      message_id: 12,
    }]);
  });

  it("sends a text reply with the current TDLib reply object", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };

    await transport.sendMessage({ chatId: "7", text: "reply", replyToMessageId: "12" });

    expect(requests).toEqual([{
      "@type": "sendMessage",
      chat_id: 7,
      topic_id: null,
      reply_to: {
        "@type": "inputMessageReplyToMessage",
        message_id: 12,
        quote: null,
        checklist_task_id: 0,
      },
      options: null,
      reply_markup: null,
      input_message_content: {
        "@type": "inputMessageText",
        text: { "@type": "formattedText", text: "reply", entities: [] },
        link_preview_options: null,
        clear_draft: true,
      },
    }]);
  });

  it("writes, clears, and publishes chat drafts through the current TDLib schema", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };
    internal.listener = (event) => events.push(event);

    await transport.setChatDraft({ chatId: "7", text: "unfinished", replyToMessageId: "12" });
    await transport.setChatDraft({ chatId: "7", text: "" });

    expect(requests).toEqual([
      {
        "@type": "setChatDraftMessage",
        chat_id: 7,
        topic_id: null,
        draft_message: {
          "@type": "draftMessage",
          reply_to: {
            "@type": "inputMessageReplyToMessage",
            message_id: 12,
            quote: null,
            checklist_task_id: 0,
          },
          date: expect.any(Number),
          content: {
            "@type": "draftMessageContentText",
            text: { "@type": "formattedText", text: "unfinished", entities: [] },
            link_preview_options: null,
          },
          effect_id: 0,
          suggested_post_info: null,
        },
      },
      {
        "@type": "setChatDraftMessage",
        chat_id: 7,
        topic_id: null,
        draft_message: null,
      },
    ]);

    internal.handleUpdate({
      "@type": "updateChatDraftMessage",
      chat_id: 7,
      draft_message: {
        "@type": "draftMessage",
        reply_to: null,
        date: 1_700_000_000,
        content: {
          "@type": "draftMessageContentText",
          text: { "@type": "formattedText", text: "remote draft", entities: [] },
        },
      },
      positions: [],
    });
    internal.handleUpdate({
      "@type": "updateChatDraftMessage",
      chat_id: 7,
      draft_message: null,
      positions: [],
    });

    expect(events).toContainEqual({
      type: "chat.draftChanged",
      chatId: "7",
      draft: expect.objectContaining({ text: "remote draft" }),
    });
    expect(events.at(-1)).toEqual({
      type: "chat.draftChanged",
      chatId: "7",
      draft: undefined,
    });
  });

  it("edits and deletes messages through TDLib", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return request["@type"] === "editMessageText" ? rawMessage(12) : { "@type": "ok" };
    };

    await transport.editMessage({ chatId: "7", messageId: "12", text: "edited" });
    await transport.deleteMessage({ chatId: "7", messageId: "12", revoke: true });

    expect(requests).toEqual([
      {
        "@type": "editMessageText",
        chat_id: 7,
        message_id: 12,
        reply_markup: null,
        input_message_content: {
          "@type": "inputMessageText",
          text: { "@type": "formattedText", text: "edited", entities: [] },
          link_preview_options: null,
          clear_draft: false,
        },
      },
      {
        "@type": "deleteMessages",
        chat_id: 7,
        message_ids: [12],
        revoke: true,
      },
    ]);
  });

  it("forwards a sorted message batch and reports partial TDLib failures", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "messages",
        messages: [
          { ...rawMessage(20), chat_id: 9, is_outgoing: true },
          null,
          { ...rawMessage(22), chat_id: 9, is_outgoing: true },
        ],
      };
    };

    await expect(transport.forwardMessages({
      fromChatId: "7",
      toChatId: "9",
      messageIds: ["14", "12", "13", "12"],
    })).resolves.toEqual({ forwardedCount: 2, failedMessageIds: ["13"] });

    expect(requests).toEqual([{
      "@type": "forwardMessages",
      chat_id: 9,
      topic_id: null,
      from_chat_id: 7,
      message_ids: [12, 13, 14],
      options: null,
      send_copy: false,
      remove_caption: false,
    }]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "message.upsert", message: { id: "20", chatId: "9" } });
    expect(events[1]).toMatchObject({ type: "message.upsert", message: { id: "22", chatId: "9" } });
  });

  it("rejects forward batches over TDLib's 100-message limit", async () => {
    const transport = new TauriTelegramTransport();
    await expect(transport.forwardMessages({
      fromChatId: "7",
      toChatId: "9",
      messageIds: Array.from({ length: 101 }, (_, index) => String(index + 1)),
    })).rejects.toThrow("单次最多转发 100 条消息");
  });

  it("sends selected photos and documents with native local-file inputs", async () => {
    const photoTransport = new TauriTelegramTransport(
      async () => ({
        path: "C:\\Users\\test\\Pictures\\holiday.jpg",
        size: 2_000_000,
      }),
    );
    const documentTransport = new TauriTelegramTransport(
      async () => ({
        path: "C:\\Users\\test\\Documents\\notes.pdf",
        size: 500_000,
      }),
    );
    const photoRequests: TdObject[] = [];
    const documentRequests: TdObject[] = [];
    (photoTransport as unknown as TestableTransport).request = async (request) => {
      photoRequests.push(request);
      return { "@type": "ok" };
    };
    (documentTransport as unknown as TestableTransport).request = async (request) => {
      documentRequests.push(request);
      return { "@type": "ok" };
    };

    await expect(photoTransport.sendFile({ chatId: "7" })).resolves.toBe(true);
    await expect(documentTransport.sendFile({ chatId: "7" })).resolves.toBe(true);

    expect(photoRequests[0]).toMatchObject({
      "@type": "sendMessage",
      chat_id: 7,
      input_message_content: {
        "@type": "inputMessagePhoto",
        photo: {
          "@type": "inputPhoto",
          photo: {
            "@type": "inputFileLocal",
            path: "C:\\Users\\test\\Pictures\\holiday.jpg",
          },
        },
        caption: { "@type": "formattedText", text: "", entities: [] },
        has_spoiler: false,
      },
    });
    expect(documentRequests[0]).toMatchObject({
      "@type": "sendMessage",
      chat_id: 7,
      input_message_content: {
        "@type": "inputMessageDocument",
        document: {
          "@type": "inputDocument",
          document: {
            "@type": "inputFileLocal",
            path: "C:\\Users\\test\\Documents\\notes.pdf",
          },
          disable_content_type_detection: false,
        },
      },
    });
  });

  it("does not send when the native picker is cancelled and can cancel an active upload", async () => {
    const cancelledPicker = new TauriTelegramTransport(async () => undefined);
    const transport = new TauriTelegramTransport(async () => ({
      path: "C:\\tmp\\large.zip",
      size: 20_000_000,
    }));
    const pickerRequests: TdObject[] = [];
    const requests: TdObject[] = [];
    (cancelledPicker as unknown as TestableTransport).request = async (request) => {
      pickerRequests.push(request);
      return { "@type": "ok" };
    };
    (transport as unknown as TestableTransport).request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };

    await expect(cancelledPicker.sendFile({ chatId: "7" })).resolves.toBe(false);
    await transport.cancelFileUpload("7", "-91");

    expect(pickerRequests).toEqual([]);
    expect(requests).toEqual([{
      "@type": "deleteMessages",
      chat_id: 7,
      message_ids: [-91],
      revoke: true,
    }]);
  });

  it("sends photos over TDLib's size limit as documents", async () => {
    const transport = new TauriTelegramTransport(async () => ({
      path: "C:\\tmp\\large-photo.jpg",
      size: 10 * 1024 * 1024 + 1,
    }));
    const requests: TdObject[] = [];
    (transport as unknown as TestableTransport).request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };

    await transport.sendFile({ chatId: "7" });

    expect((requests[0].input_message_content as TdObject)["@type"])
      .toBe("inputMessageDocument");
  });

  it("merges separate edit and interaction updates into the known message", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const messages: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => messages.push(event);
    internal.emitMessage(rawMessage(12));
    messages.length = 0;

    internal.handleUpdate({
      "@type": "updateMessageEdited",
      chat_id: 7,
      message_id: 12,
      edit_date: 1_700_000_500,
      reply_markup: null,
    });
    internal.handleUpdate({
      "@type": "updateMessageInteractionInfo",
      chat_id: 7,
      message_id: 12,
      interaction_info: {
        view_count: 9,
        forward_count: 2,
        reply_info: null,
        reactions: {
          reactions: [{
            type: { "@type": "reactionTypeEmoji", emoji: "🔥" },
            total_count: 3,
            is_chosen: true,
            recent_sender_ids: [],
          }],
        },
      },
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: "message.upsert",
      message: { id: "12", editedAt: "2023-11-14T22:21:40.000Z" },
    });
    expect(messages[1]).toMatchObject({
      type: "message.upsert",
      message: {
        id: "12",
        editedAt: "2023-11-14T22:21:40.000Z",
        interaction: {
          viewCount: 9,
          forwardCount: 2,
          reactions: [{
            type: { kind: "emoji", emoji: "🔥" },
            totalCount: 3,
            chosen: true,
          }],
        },
      },
    });
  });

  it("does not resurrect a deleted message from a late edit update", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.emitMessage(rawMessage(13));
    events.length = 0;

    internal.handleUpdate({
      "@type": "updateDeleteMessages",
      chat_id: 7,
      message_ids: [13],
      is_permanent: true,
      from_cache: false,
    });
    internal.handleUpdate({
      "@type": "updateMessageEdited",
      chat_id: 7,
      message_id: 13,
      edit_date: 1_700_000_500,
      reply_markup: null,
    });

    expect(events).toEqual([{
      type: "message.remove",
      chatId: "7",
      messageId: "13",
    }]);
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
