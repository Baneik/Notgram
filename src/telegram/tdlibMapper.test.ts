import { describe, expect, it } from "vitest";
import { mapTdChat, mapTdChatFolders, mapTdMessage, mapTdUser } from "./tdlibMapper";

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
      folderIds: ["main"],
    });
  });

  it("maps user presence and incoming text messages", () => {
    const user = mapTdUser({
      id: 7,
      first_name: "Lin",
      last_name: "Ran",
      status: { "@type": "userStatusOnline", expires: 1_800_000_000 },
      profile_photo: {
        small: {
          id: 44,
          local: {
            is_downloading_completed: true,
            path: "C:\\avatars\\lin.jpg",
          },
        },
      },
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

    expect(user).toMatchObject({
      id: "7",
      displayName: "Lin Ran",
      presence: "online",
      avatar: { imagePath: "C:\\avatars\\lin.jpg" },
    });
    expect(message).toMatchObject({
      id: "1001",
      chatId: "99",
      senderId: "7",
      outgoing: false,
      content: { kind: "text", text: "hello" },
    });
  });

  it("keeps image documents as downloadable files", () => {
    const message = mapTdMessage({
      id: 1002,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      is_outgoing: true,
      date: 1_700_000_000,
      content: {
        "@type": "messageDocument",
        document: {
          file_name: "diagram.png",
          mime_type: "image/png",
          document: { size: 2048, expected_size: 2048 },
        },
        caption: { "@type": "formattedText", text: "", entities: [] },
      },
    });

    expect(message?.content).toMatchObject({
      kind: "file",
      fileName: "diagram.png",
      mimeType: "image/png",
      sizeLabel: "2 KB",
      size: 2048,
    });
  });

  it("maps photo file state and download progress", () => {
    const message = mapTdMessage({
      id: 1003,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      is_outgoing: false,
      date: 1_700_000_000,
      content: {
        "@type": "messagePhoto",
        caption: { "@type": "formattedText", text: "preview", entities: [] },
        photo: {
          minithumbnail: { width: 40, height: 22, data: "aGVsbG8=" },
          sizes: [
            {
              width: 90,
              height: 90,
              photo: {
                "@type": "file",
                id: 8,
                size: 900,
                local: { is_downloading_completed: true, path: "C:\\cache\\thumb.jpg" },
                remote: {},
              },
            },
            {
              width: 1280,
              height: 720,
              photo: {
                "@type": "file",
                id: 9,
                size: 4000,
                local: {
                  can_be_downloaded: true,
                  is_downloading_active: true,
                  is_downloading_completed: false,
                  downloaded_size: 1000,
                },
                remote: {},
              },
            },
          ],
        },
      },
    });

    expect(message?.content).toMatchObject({
      kind: "media",
      mediaType: "photo",
      fileId: 9,
      size: 4000,
      isDownloading: true,
      progress: 0.25,
      thumbnailPath: "C:\\cache\\thumb.jpg",
      previewDataUrl: "data:image/jpeg;base64,aGVsbG8=",
      width: 1280,
      height: 720,
    });
  });

  it("keeps retry information for failed outgoing messages", () => {
    const message = mapTdMessage({
      id: -10,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      is_outgoing: true,
      date: 1_700_000_000,
      sending_state: {
        "@type": "messageSendingStateFailed",
        can_retry: true,
      },
      content: {
        "@type": "messageText",
        text: { "@type": "formattedText", text: "retry me", entities: [] },
      },
    });

    expect(message).toMatchObject({ delivery: "failed", canRetry: true });
  });

  it("maps server folders, custom memberships, and downloaded chat photos", () => {
    const folders = mapTdChatFolders([
      {
        id: 12,
        name: { text: { text: "工作" } },
        icon: { name: "Custom" },
      },
    ], 1);
    const chat = mapTdChat({
      id: 200,
      type: { "@type": "chatTypeSupergroup", is_channel: false },
      title: "设计组",
      positions: [
        { list: { "@type": "chatListFolder", chat_folder_id: 12 }, order: 10 },
      ],
      chat_lists: [{ "@type": "chatListFolder", chat_folder_id: 12 }],
      photo: {
        small: {
          id: 9,
          local: { is_downloading_completed: true, path: "C:\\avatars\\group.jpg" },
        },
      },
    });

    expect(folders.map((folder) => folder.id)).toEqual(["folder:12", "main"]);
    expect(chat?.folderIds).toEqual(["folder:12"]);
    expect(chat?.avatar.imagePath).toBe("C:\\avatars\\group.jpg");
  });
});
