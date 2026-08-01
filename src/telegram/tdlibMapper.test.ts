import { describe, expect, it } from "vitest";
import { mapTdChat, mapTdMessage, mapTdUser } from "./tdlibMapper";

describe("TDLib mapper", () => {
  it("maps a private saved-messages chat", () => {
    const chat = mapTdChat(
      {
        id: 99,
        type: { "@type": "chatTypePrivate", user_id: 7 },
        title: "Example User",
        positions: [
          { list: { "@type": "chatListMain" }, order: "100", is_pinned: true },
        ],
        chat_lists: [{ "@type": "chatListMain" }],
        unread_count: 2,
        notification_settings: { mute_for: 0 },
        last_message: {
          date: 1_700_000_000,
          content: {
            "@type": "messageText",
            text: { "@type": "formattedText", text: "hello", entities: [] },
          },
        },
      },
      "7",
    );

    expect(chat).toMatchObject({
      id: "99",
      kind: "saved",
      title: "收藏夹",
      preview: "hello",
      unreadCount: 2,
      pinned: true,
    });
  });

  it("maps user presence and incoming text messages", () => {
    const user = mapTdUser({
      id: 7,
      first_name: "Lin",
      last_name: "Ran",
      status: { "@type": "userStatusOnline", expires: 1_800_000_000 },
    });
    const message = mapTdMessage({
      id: 1001,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      is_outgoing: false,
      date: 1_700_000_000,
      content: {
        "@type": "messageText",
        text: { "@type": "formattedText", text: "hello", entities: [] },
      },
    });

    expect(user).toMatchObject({ id: "7", displayName: "Lin Ran", presence: "online" });
    expect(message).toMatchObject({
      id: "1001",
      chatId: "99",
      senderId: "7",
      outgoing: false,
      content: { kind: "text", text: "hello" },
    });
  });

  it("maps documents with file metadata", () => {
    const message = mapTdMessage({
      id: 1002,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      is_outgoing: true,
      date: 1_700_000_000,
      content: {
        "@type": "messageDocument",
        document: {
          file_name: "notes.pdf",
          document: { size: 2048, expected_size: 2048 },
        },
        caption: { "@type": "formattedText", text: "", entities: [] },
      },
    });

    expect(message?.content).toEqual({
      kind: "file",
      fileName: "notes.pdf",
      sizeLabel: "2 KB",
    });
  });
});
