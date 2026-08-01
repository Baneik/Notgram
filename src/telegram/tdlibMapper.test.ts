import { describe, expect, it } from "vitest";
import {
  mapTdChat,
  mapTdChatDraft,
  mapTdChatFolders,
  mapTdMessage,
  mapTdMessageProperties,
  mapTdUser,
} from "./tdlibMapper";

describe("TDLib mapper", () => {
  it("maps text drafts and their reply target", () => {
    expect(mapTdChatDraft(7, {
      "@type": "draftMessage",
      reply_to: {
        "@type": "inputMessageReplyToMessage",
        message_id: 12,
      },
      date: 1_700_000_000,
      content: {
        "@type": "draftMessageContentText",
        text: { "@type": "formattedText", text: "unfinished text", entities: [] },
      },
    })).toEqual({
      chatId: "7",
      text: "unfinished text",
      replyToMessageId: "12",
      updatedAt: "2023-11-14T22:13:20.000Z",
    });
    expect(mapTdChatDraft(7, {
      "@type": "draftMessage",
      content: { "@type": "draftMessageContentVoiceNote" },
    })).toBeUndefined();
  });

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

  it("maps stickers and video notes as playable media", () => {
    const sticker = mapTdMessage({
      id: 1004,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      date: 1_700_000_000,
      content: {
        "@type": "messageSticker",
        sticker: {
          emoji: "🙂",
          width: 512,
          height: 512,
          sticker: { id: 17, size: 2048, local: { can_be_downloaded: true } },
        },
      },
    });
    const videoNote = mapTdMessage({
      id: 1005,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      date: 1_700_000_000,
      content: {
        "@type": "messageVideoNote",
        video_note: {
          length: 240,
          video: { id: 18, size: 4096, local: { can_be_downloaded: true } },
        },
      },
    });

    expect(sticker?.content).toMatchObject({
      kind: "media",
      mediaType: "sticker",
      fileName: "🙂",
      fileId: 17,
      width: 512,
      height: 512,
    });
    expect(videoNote?.content).toMatchObject({
      kind: "media",
      mediaType: "videoNote",
      fileId: 18,
      width: 240,
      height: 240,
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

  it("maps outgoing file upload progress from TDLib remote state", () => {
    const message = mapTdMessage({
      id: -11,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      is_outgoing: true,
      date: 1_700_000_000,
      sending_state: { "@type": "messageSendingStatePending" },
      content: {
        "@type": "messageDocument",
        caption: { "@type": "formattedText", text: "", entities: [] },
        document: {
          file_name: "archive.zip",
          mime_type: "application/zip",
          document: {
            "@type": "file",
            id: 91,
            size: 4_000,
            local: {},
            remote: {
              is_uploading_active: true,
              uploaded_size: 1_000,
            },
          },
        },
      },
    });

    expect(message).toMatchObject({
      delivery: "sending",
      content: {
        kind: "file",
        fileId: 91,
        isUploading: true,
        uploadedSize: 1_000,
        progress: 0.25,
      },
    });
  });

  it("maps reply, forward, edit, and reaction metadata", () => {
    const message = mapTdMessage({
      id: 1004,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      is_outgoing: false,
      date: 1_700_000_000,
      edit_date: 1_700_000_100,
      reply_to: {
        "@type": "messageReplyToMessage",
        chat_id: 88,
        message_id: 900,
        quote: {
          text: { "@type": "formattedText", text: "quoted text", entities: [] },
        },
        origin: { "@type": "messageOriginHiddenUser", sender_name: "Hidden Sender" },
        origin_send_date: 1_699_999_000,
        content: {
          "@type": "messageText",
          text: { "@type": "formattedText", text: "source preview", entities: [] },
        },
      },
      forward_info: {
        origin: {
          "@type": "messageOriginChannel",
          chat_id: 77,
          message_id: 800,
          author_signature: "Editor",
        },
        date: 1_699_998_000,
        source: {
          chat_id: 77,
          message_id: 800,
          sender_id: { "@type": "messageSenderChat", chat_id: 77 },
          sender_name: "",
          date: 1_699_998_000,
          is_outgoing: false,
        },
        public_service_announcement_type: "",
      },
      interaction_info: {
        view_count: 12,
        forward_count: 3,
        reply_info: { reply_count: 2 },
        reactions: {
          reactions: [
            {
              type: { "@type": "reactionTypeEmoji", emoji: "👍" },
              total_count: 4,
              is_chosen: true,
              recent_sender_ids: [
                { "@type": "messageSenderUser", user_id: 7 },
                { "@type": "messageSenderChat", chat_id: 77 },
              ],
            },
            {
              type: { "@type": "reactionTypeCustomEmoji", custom_emoji_id: "123456789" },
              total_count: 1,
              is_chosen: false,
              recent_sender_ids: [],
            },
          ],
        },
      },
      content: {
        "@type": "messageText",
        text: { "@type": "formattedText", text: "hello", entities: [] },
      },
    });

    expect(message).toMatchObject({
      editedAt: "2023-11-14T22:15:00.000Z",
      replyTo: {
        kind: "message",
        chatId: "88",
        messageId: "900",
        quote: "quoted text",
        origin: { kind: "hiddenUser", senderName: "Hidden Sender" },
        content: { kind: "text", text: "source preview" },
      },
      forwardInfo: {
        origin: {
          kind: "channel",
          chatId: "77",
          messageId: "800",
          authorSignature: "Editor",
        },
        source: { chatId: "77", messageId: "800", senderId: "chat:77" },
      },
      interaction: {
        viewCount: 12,
        forwardCount: 3,
        replyCount: 2,
        reactions: [
          {
            type: { kind: "emoji", emoji: "👍" },
            totalCount: 4,
            chosen: true,
            recentSenderIds: ["7", "chat:77"],
          },
          {
            type: { kind: "customEmoji", customEmojiId: "123456789" },
            totalCount: 1,
            chosen: false,
          },
        ],
      },
    });
  });

  it("maps message operation permissions without inferring missing rights", () => {
    expect(mapTdMessageProperties({
      "@type": "messageProperties",
      can_be_replied: true,
      can_be_edited: false,
      can_be_deleted_only_for_self: true,
      can_be_deleted_for_all_users: false,
      can_be_forwarded: true,
    })).toEqual({
      canReply: true,
      canEdit: false,
      canDeleteOnlyForSelf: true,
      canDeleteForAllUsers: false,
      canForward: true,
    });
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
