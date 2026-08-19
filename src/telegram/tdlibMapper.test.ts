import { describe, expect, it } from "vitest";
import {
  mapTdChat,
  mapTdChatDraft,
  mapTdChatFolders,
  mapTdForumTopic,
  mapTdMessage,
  mapTdMessageContent,
  mapTdMessageProperties,
  mapTdMessageReactionSenders,
  mapTdUser,
} from "./tdlibMapper";

describe("TDLib mapper", () => {
  it("maps forum chats, topic metadata, topic drafts, and message topic ids", () => {
    expect(mapTdChat({
      id: 77,
      type: { "@type": "chatTypeSupergroup", supergroup_id: 91, is_channel: false },
      title: "Forum",
      permissions: { can_create_topics: true },
    }, undefined, {
      "@type": "supergroup",
      id: 91,
      is_forum: true,
    })).toMatchObject({ id: "77", isForum: true, canCreateTopics: true });

    expect(mapTdForumTopic({
      "@type": "forumTopic",
      info: {
        "@type": "forumTopicInfo",
        chat_id: 77,
        forum_topic_id: 12,
        name: "Releases",
        icon: { "@type": "forumTopicIcon", color: 7_321_072, custom_emoji_id: 99 },
        creation_date: 1_700_000_000,
        is_outgoing: true,
        is_closed: false,
      },
      last_message: {
        id: 1001,
        chat_id: 77,
        topic_id: { "@type": "messageTopicForum", forum_topic_id: 12 },
        sender_id: { "@type": "messageSenderUser", user_id: 7 },
        date: 1_700_000_100,
        content: { "@type": "messageText", text: { text: "v1 ready", entities: [] } },
      },
      order: "9223372036854775000",
      is_pinned: true,
      unread_count: 3,
      notification_settings: { use_default_mute_for: false, mute_for: 60 },
      draft_message: {
        "@type": "draftMessage",
        date: 1_700_000_200,
        content: { "@type": "draftMessageContentText", text: { text: "release note", entities: [] } },
      },
    })).toMatchObject({
      id: "12",
      chatId: "77",
      name: "Releases",
      iconCustomEmojiId: "99",
      isPinned: true,
      unreadCount: 3,
      muted: true,
      useDefaultMuteFor: false,
      order: "9223372036854775000",
      lastMessage: { id: "1001", topicId: "12" },
      draft: { chatId: "77", topicId: "12", text: "release note" },
    });
  });

  it("maps live group status into management capabilities", () => {
    expect(mapTdChat(
      {
        id: 78,
        type: { "@type": "chatTypeSupergroup", supergroup_id: 92, is_channel: false },
        title: "Managed",
      },
      "7",
      {
        "@type": "supergroup",
        id: 92,
        status: {
          "@type": "chatMemberStatusAdministrator",
          can_be_edited: true,
          rights: { can_manage_chat: true, can_invite_users: true, can_restrict_members: true },
        },
      },
    )).toMatchObject({
      management: {
        status: "administrator",
        canOpenManagement: true,
        canAddMembers: true,
        canManagePermissions: true,
        canViewEventLog: true,
      },
    });

    expect(mapTdChat(
      {
        id: 79,
        type: { "@type": "chatTypeSupergroup", supergroup_id: 93, is_channel: false },
        title: "Member",
      },
      "7",
      { "@type": "supergroup", id: 93, status: { "@type": "chatMemberStatusMember" } },
    )?.management).toMatchObject({ canOpenManagement: false });
  });

  it("preserves non-zero media album ids without creating zero albums", () => {
    const base = {
      id: 1000,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      date: 1_700_000_000,
      content: {
        "@type": "messagePhoto",
        photo: { sizes: [] },
        caption: { "@type": "formattedText", text: "", entities: [] },
      },
    };

    expect(mapTdMessage({ ...base, media_album_id: "9223372036854775000" }))
      .toMatchObject({ mediaAlbumId: "9223372036854775000" });
    expect(mapTdMessage({ ...base, media_album_id: "0" })?.mediaAlbumId).toBeUndefined();
  });

  it("maps text drafts and their reply target", () => {
    expect(mapTdChatDraft(7, {
      "@type": "draftMessage",
      reply_to: {
        "@type": "inputMessageReplyToMessage",
        message_id: 12,
        quote: {
          "@type": "inputTextQuote",
          text: {
            "@type": "formattedText",
            text: "selected draft text",
            entities: [{
              offset: 0,
              length: 8,
              type: { "@type": "textEntityTypeBold" },
            }],
          },
          position: 3,
        },
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
      replyQuote: {
        text: "selected draft text",
        position: 3,
        entities: [{ offset: 0, length: 8, kind: "bold" }],
      },
      updatedAt: "2023-11-14T22:13:20.000Z",
    });
    expect(mapTdChatDraft(7, {
      "@type": "draftMessage",
      content: { "@type": "draftMessageContentVoiceNote" },
    })).toBeUndefined();
  });

  it("maps custom emoji and date-time entities needed by reply quotes", () => {
    expect(mapTdChatDraft(7, {
      "@type": "draftMessage",
      reply_to: {
        "@type": "inputMessageReplyToMessage",
        message_id: 12,
        quote: {
          "@type": "inputTextQuote",
          text: {
            "@type": "formattedText",
            text: "😀 2026",
            entities: [
              {
                offset: 0,
                length: 2,
                type: { "@type": "textEntityTypeCustomEmoji", custom_emoji_id: "99" },
              },
              {
                offset: 3,
                length: 4,
                type: {
                  "@type": "textEntityTypeDateTime",
                  unix_time: 1_800_000_000,
                  formatting_type: {
                    "@type": "dateTimeFormattingTypeAbsolute",
                    time_precision: { "@type": "dateTimePartPrecisionShort" },
                    date_precision: { "@type": "dateTimePartPrecisionLong" },
                    show_day_of_week: true,
                  },
                },
              },
            ],
          },
          position: 1,
        },
      },
      date: 1_700_000_000,
      content: {
        "@type": "draftMessageContentText",
        text: { "@type": "formattedText", text: "reply", entities: [] },
      },
    })?.replyQuote).toEqual({
      text: "😀 2026",
      position: 1,
      entities: [
        { offset: 0, length: 2, kind: "customEmoji", customEmojiId: "99" },
        {
          offset: 3,
          length: 4,
          kind: "dateTime",
          dateTime: {
            unixTime: 1_800_000_000,
            mode: "absolute",
            timePrecision: "short",
            datePrecision: "long",
            showDayOfWeek: true,
          },
        },
      ],
    });
  });

  it("maps animated emoji to its downloadable sticker media", () => {
    expect(mapTdMessageContent({
      "@type": "messageAnimatedEmoji",
      emoji: "😡",
      animated_emoji: {
        "@type": "animatedEmoji",
        emoji: "😡",
        sticker: {
          "@type": "sticker",
          emoji: "😡",
          format: { "@type": "stickerFormatTgs" },
          width: 512,
          height: 512,
          sticker: {
            "@type": "file",
            id: 45,
            expected_size: 8_308,
            local: {
              "@type": "localFile",
              can_be_downloaded: true,
              is_downloading_active: false,
              is_downloading_completed: false,
              path: "",
            },
          },
          thumbnail: {
            "@type": "thumbnail",
            file: {
              "@type": "file",
              id: 44,
              local: {
                "@type": "localFile",
                can_be_downloaded: true,
                is_downloading_active: false,
                is_downloading_completed: false,
                path: "",
              },
            },
          },
        },
      },
    })).toMatchObject({
      kind: "media",
      mediaType: "sticker",
      fileName: "😡",
      mimeType: "application/x-tgsticker",
      fileId: 45,
      size: 8_308,
      canDownload: true,
      isDownloaded: false,
      thumbnailFileId: 44,
      thumbnailCanDownload: true,
      width: 512,
      height: 512,
    });
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
        unread_mention_count: 1,
        last_read_inbox_message_id: "6917529027641081856",
        notification_settings: { mute_for: 0 },
        last_message: {
          sender_id: { "@type": "messageSenderUser", user_id: 7 },
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
      previewSenderId: "7",
      unreadCount: 2,
      unreadMentionCount: 1,
      lastReadInboxMessageId: "6917529027641081856",
      pinned: true,
      pinnedFolderIds: ["main"],
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
      sender_tag: "值班",
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
      senderTag: "值班",
      outgoing: false,
      content: { kind: "text", text: "hello" },
    });
    expect(mapTdUser({
      id: 8,
      first_name: "Helper",
      type: { "@type": "userTypeBot" },
      status: { "@type": "userStatusOffline" },
    })).toMatchObject({ id: "8", isBot: true });
  });

  it("renders safe image documents as photo media without losing file metadata", () => {
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
          minithumbnail: {
            width: 1,
            height: 1,
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          },
          document: {
            id: 81,
            size: 2048,
            expected_size: 2048,
            local: {
              can_be_downloaded: true,
              is_downloading_active: false,
              is_downloading_completed: false,
            },
          },
        },
        caption: { "@type": "formattedText", text: "diagram caption", entities: [] },
      },
    });

    expect(message?.content).toMatchObject({
      kind: "media",
      mediaType: "photo",
      fileName: "diagram.png",
      mimeType: "image/png",
      sizeLabel: "2 KB",
      size: 2048,
      fileId: 81,
      caption: "diagram caption",
      canDownload: true,
      isDownloaded: false,
      previewDataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/),
    });
  });

  it("keeps vector image documents as files", () => {
    const message = mapTdMessage({
      id: 1002,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      date: 1_700_000_000,
      content: {
        "@type": "messageDocument",
        document: {
          file_name: "diagram.svg",
          mime_type: "image/svg+xml",
          document: { id: 82, size: 1024 },
        },
        caption: { "@type": "formattedText", text: "", entities: [] },
      },
    });

    expect(message?.content).toMatchObject({
      kind: "file",
      fileName: "diagram.svg",
      mimeType: "image/svg+xml",
      fileId: 82,
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
        has_spoiler: true,
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
                remote: { id: "AwADBAADewAPKgQ", uploaded_size: 4000 },
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
      dataCenterId: 4,
      size: 4000,
      isDownloading: true,
      progress: 0.25,
      thumbnailPath: "C:\\cache\\thumb.jpg",
      thumbnailFileId: 8,
      thumbnailCanDownload: false,
      thumbnailIsDownloading: false,
      previewDataUrl: "data:image/jpeg;base64,aGVsbG8=",
      width: 1280,
      height: 720,
      hasSpoiler: true,
    });

    expect(mapTdMessageContent({
      "@type": "messageVideo",
      has_spoiler: true,
      video: {
        mime_type: "video/mp4",
        video: {
          id: 33,
          size: 2_000_000,
          local: { can_be_downloaded: true, is_downloading_completed: false },
        },
      },
    })).toMatchObject({
      kind: "media",
      mediaType: "video",
      fileName: "视频_33.mp4",
      hasSpoiler: true,
    });

    expect(mapTdMessageContent({
      "@type": "messageAnimation",
      has_spoiler: true,
      animation: { file_name: "preview.gif", animation: { id: 36 } },
    })).toMatchObject({
      kind: "media",
      mediaType: "animation",
      hasSpoiler: true,
    });

    expect(mapTdMessageContent({
      "@type": "messageVideo",
      video: {
        file_name: "录像",
        mime_type: "video/webm",
        video: { id: 35 },
      },
    })).toMatchObject({ fileName: "录像.webm" });
  });

  it("uses local downloaded bytes instead of the completed remote upload", () => {
    expect(mapTdMessageContent({
      "@type": "messageVideo",
      video: {
        file_name: "large-video.mp4",
        mime_type: "video/mp4",
        video: {
          id: 34,
          size: 10_000_000,
          expected_size: 10_000_000,
          local: {
            can_be_downloaded: true,
            is_downloading_active: true,
            is_downloading_completed: false,
            downloaded_size: 2_500_000,
          },
          remote: { uploaded_size: 10_000_000 },
        },
      },
    })).toMatchObject({
      fileName: "large-video.mp4",
      size: 10_000_000,
      downloadedSize: 2_500_000,
      progress: 0.25,
    });
  });

  it("preserves supported TDLib rich-text entities", () => {
    const message = mapTdMessage({
      id: 1003,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      date: 1_700_000_000,
      content: {
        "@type": "messageText",
        text: {
          "@type": "formattedText",
          text: "Bold link code #release",
          entities: [
            { offset: 0, length: 4, type: { "@type": "textEntityTypeBold" } },
            {
              offset: 5,
              length: 4,
              type: { "@type": "textEntityTypeTextUrl", url: "https://example.com" },
            },
            { offset: 10, length: 4, type: { "@type": "textEntityTypeCode" } },
            { offset: 15, length: 8, type: { "@type": "textEntityTypeHashtag" } },
          ],
        },
      },
    });

    expect(message?.content).toEqual({
      kind: "text",
      text: "Bold link code #release",
      entities: [
        { offset: 0, length: 4, kind: "bold", href: undefined, language: undefined },
        {
          offset: 5,
          length: 4,
          kind: "textUrl",
          href: "https://example.com",
          language: undefined,
        },
        { offset: 10, length: 4, kind: "code", href: undefined, language: undefined },
        { offset: 15, length: 8, kind: "hashtag", href: undefined, language: undefined },
      ],
    });
  });

  it("uses an outgoing upload's local path before TDLib marks it downloaded", () => {
    const message = mapTdMessage({
      id: -1004,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      is_outgoing: true,
      date: 1_700_000_000,
      content: {
        "@type": "messagePhoto",
        caption: { "@type": "formattedText", text: "local preview", entities: [] },
        photo: {
          sizes: [{
            width: 1280,
            height: 720,
            photo: {
              "@type": "file",
              id: 10,
              size: 4000,
              local: {
                path: "C:\\cache\\.notgram-sent-media\\upload.jpg",
                is_downloading_completed: false,
              },
              remote: { is_uploading_active: true, uploaded_size: 1000 },
            },
          }],
        },
      },
    });

    expect(message?.content).toMatchObject({
      kind: "media",
      mediaType: "photo",
      localPath: "C:\\cache\\.notgram-sent-media\\upload.jpg",
      isDownloaded: true,
      isUploading: true,
      progress: 0.25,
    });
  });

  it("maps a video cover and its downloadable thumbnail", () => {
    const content = mapTdMessageContent({
      "@type": "messageVideo",
      caption: {
        "@type": "formattedText",
        text: "review",
        entities: [{ offset: 0, length: 6, type: { "@type": "textEntityTypeBold" } }],
      },
      video: {
        file_name: "review.mp4",
        mime_type: "video/mp4",
        width: 1280,
        height: 720,
        minithumbnail: { data: "aGVsbG8=" },
        thumbnail: {
          file: {
            id: 31,
            local: {
              can_be_downloaded: true,
              is_downloading_active: false,
              is_downloading_completed: false,
            },
          },
        },
        video: {
          id: 32,
          size: 8_000_000,
          local: { can_be_downloaded: true, is_downloading_completed: false },
        },
      },
    });

    expect(content).toMatchObject({
      kind: "media",
      mediaType: "video",
      fileId: 32,
      size: 8_000_000,
      mimeType: "video/mp4",
      caption: "review",
      captionEntities: [{ offset: 0, length: 6, kind: "bold" }],
      thumbnailFileId: 31,
      thumbnailCanDownload: true,
      thumbnailIsDownloading: false,
      previewDataUrl: "data:image/jpeg;base64,aGVsbG8=",
      width: 1280,
      height: 720,
    });
  });

  it("keeps voice-note duration and degrades safely when its file is unavailable", () => {
    expect(mapTdMessageContent({
      "@type": "messageVoiceNote",
      caption: { "@type": "formattedText", text: "voice caption", entities: [] },
      voice_note: {
        duration: 37,
        mime_type: "audio/ogg",
        voice: {
          id: 81,
          size: 240_000,
          local: { can_be_downloaded: true, is_downloading_completed: false },
        },
      },
    })).toMatchObject({
      kind: "media",
      mediaType: "voice",
      fileName: "语音消息",
      fileId: 81,
      size: 240_000,
      duration: 37,
      mimeType: "audio/ogg",
      caption: "voice caption",
    });

    expect(mapTdMessageContent({
      "@type": "messageVoiceNote",
      voice_note: { duration: 12, mime_type: "audio/ogg" },
    })).toMatchObject({
      kind: "media",
      mediaType: "voice",
      fileName: "语音消息",
      fileId: undefined,
      size: 0,
      duration: 12,
    });
  });

  it("maps polls and quiz results into interactive message content", () => {
    expect(mapTdMessageContent({
      "@type": "messagePoll",
      poll: {
        id: "9007199254740993",
        question: { "@type": "formattedText", text: "2 + 2?", entities: [] },
        options: [
          {
            id: "three",
            text: { "@type": "formattedText", text: "3", entities: [] },
            voter_count: 2,
            vote_percentage: 20,
            is_chosen: true,
            is_being_chosen: false,
          },
          {
            id: "four",
            text: { "@type": "formattedText", text: "4", entities: [] },
            voter_count: 8,
            vote_percentage: 80,
            is_chosen: false,
            is_being_chosen: false,
          },
        ],
        total_voter_count: 10,
        can_see_results: true,
        is_anonymous: true,
        allows_multiple_answers: false,
        allows_revoting: false,
        type: {
          "@type": "pollTypeQuiz",
          correct_option_ids: [1],
          explanation: { "@type": "formattedText", text: "基础算术", entities: [] },
        },
        is_closed: false,
        vote_restriction_reason: null,
      },
    })).toEqual({
      kind: "poll",
      pollId: "9007199254740993",
      question: "2 + 2?",
      questionEntities: undefined,
      options: [
        {
          id: "three",
          position: 0,
          text: "3",
          entities: undefined,
          voterCount: 2,
          votePercentage: 20,
          chosen: true,
          beingChosen: false,
          correct: false,
        },
        {
          id: "four",
          position: 1,
          text: "4",
          entities: undefined,
          voterCount: 8,
          votePercentage: 80,
          chosen: false,
          beingChosen: false,
          correct: true,
        },
      ],
      totalVoterCount: 10,
      type: "quiz",
      allowsMultipleAnswers: false,
      allowsRevoting: false,
      isAnonymous: true,
      isClosed: false,
      canSeeResults: true,
      restrictionReason: undefined,
      explanation: "基础算术",
      explanationEntities: undefined,
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
          set_id: "5368324170671202286",
          width: 512,
          height: 512,
          format: { "@type": "stickerFormatWebm" },
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
      stickerSetId: "5368324170671202286",
      mimeType: "video/webm",
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

  it("maps join events and other service messages to readable notices", () => {
    const cases = [
      [
        { "@type": "messageChatAddMembers", member_user_ids: [7, 8] },
        { kind: "service", text: "2 位新成员加入了群聊", memberUserIds: ["7", "8"] },
      ],
      [
        { "@type": "messageChatJoinByLink" },
        { kind: "service", text: "有成员通过邀请链接加入了群聊", memberUserIds: [] },
      ],
      [
        { "@type": "messageChatJoinByRequest" },
        { kind: "service", text: "入群申请已通过", memberUserIds: [] },
      ],
      [
        { "@type": "messageChatChangeTitle", title: "设计讨论" },
        { kind: "service", text: "群聊名称已更改：设计讨论" },
      ],
      [
        { "@type": "messagePinMessage" },
        { kind: "service", text: "置顶了一条消息" },
      ],
      [
        { "@type": "messageVideoChatStarted" },
        { kind: "service", text: "视频聊天已开始" },
      ],
      [
        { "@type": "messageExpiredPhoto" },
        { kind: "service", text: "照片已过期" },
      ],
    ] as const;

    for (const [content, expected] of cases) {
      expect(mapTdMessageContent(content)).toEqual(expected);
    }

    expect(mapTdMessage({
      id: 100,
      chat_id: 9,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      date: 1_700_000_000,
      content: { "@type": "messageChatJoinByLink" },
    })?.content).toEqual({
      kind: "service",
      text: "有成员通过邀请链接加入了群聊",
      memberUserIds: ["7"],
    });
  });

  it("maps additional interactive content instead of using an unsupported placeholder", () => {
    expect(mapTdMessageContent({
      "@type": "messageContact",
      contact: { first_name: "Mia", last_name: "Chen", phone_number: "+123" },
    })).toEqual({ kind: "text", text: "联系人 · Mia Chen · +123" });
    expect(mapTdMessageContent({
      "@type": "messagePoll",
      poll: { question: { "@type": "formattedText", text: "午餐吃什么？" } },
    })).toEqual({
      kind: "poll",
      pollId: "",
      question: "午餐吃什么？",
      options: [],
      totalVoterCount: 0,
      type: "regular",
      allowsMultipleAnswers: false,
      allowsRevoting: false,
      isAnonymous: false,
      isClosed: false,
      canSeeResults: false,
      questionEntities: undefined,
      restrictionReason: undefined,
      explanation: undefined,
      explanationEntities: undefined,
    });
    expect(mapTdMessageContent({
      "@type": "messageDice",
      emoji: "🎲",
      value: 6,
    })).toEqual({ kind: "text", text: "🎲 6" });
  });

  it("maps rich message headings, nested formatting, lists, and quotes", () => {
    const mapped = mapTdMessageContent({
      "@type": "messageRichMessage",
      message: {
        "@type": "richMessage",
        is_full: true,
        is_rtl: false,
        blocks: [
          {
            "@type": "pageBlockSectionHeading",
            size: 1,
            text: { "@type": "richTextPlain", text: "今日小贴士" },
          },
          {
            "@type": "pageBlockParagraph",
            text: { "@type": "richTextPlain", text: "保持专注，也别忘了适当休息。" },
          },
          {
            "@type": "pageBlockList",
            items: [{
              "@type": "pageBlockListItem",
              label: "•",
              type: "",
              has_checkbox: false,
              is_checked: false,
              blocks: [{
                "@type": "pageBlockParagraph",
                text: {
                  "@type": "richTextBold",
                  text: { "@type": "richTextPlain", text: "优先处理最重要的一件事" },
                },
              }],
            }],
          },
          {
            "@type": "pageBlockBlockQuote",
            blocks: [{
              "@type": "pageBlockParagraph",
              text: {
                "@type": "richTexts",
                texts: [
                  {
                    "@type": "richTextBold",
                    text: { "@type": "richTextPlain", text: "输入" },
                  },
                  { "@type": "richTextPlain", text: " " },
                  {
                    "@type": "richTextFixed",
                    text: { "@type": "richTextPlain", text: "5,709 tokens" },
                  },
                ],
              },
            }],
          },
        ],
      },
    });

    expect(mapped.kind).toBe("rich");
    if (mapped.kind !== "rich") return;
    expect(mapped).toMatchObject({
      isFull: true,
      isRtl: false,
      blocks: [
        { kind: "heading", level: 1, text: [{ text: "今日小贴士" }] },
        { kind: "paragraph", text: [{ text: "保持专注，也别忘了适当休息。" }] },
        {
          kind: "list",
          ordered: false,
          items: [{
            blocks: [{
              kind: "paragraph",
              text: [{ text: "优先处理最重要的一件事", bold: true }],
            }],
          }],
        },
        {
          kind: "quote",
          blocks: [{
            kind: "paragraph",
            text: [
              { text: "输入", bold: true },
              { text: " " },
              { text: "5,709 tokens", code: true },
            ],
          }],
        },
      ],
    });
    expect(mapped.text).toContain("今日小贴士\n保持专注，也别忘了适当休息。");
    expect(mapped.text).toContain("优先处理最重要的一件事");
    expect(mapped.text).toContain("输入 5,709 tokens");
  });

  it("preserves the complete Bot API rich-text semantics", () => {
    const plain = (text: string) => ({ "@type": "richTextPlain", text });
    const mapped = mapTdMessageContent({
      "@type": "messageRichMessage",
      message: {
        "@type": "richMessage",
        is_full: true,
        is_rtl: false,
        blocks: [{
          "@type": "pageBlockParagraph",
          text: {
            "@type": "richTexts",
            texts: [
              { "@type": "richTextMarked", text: plain("marked") },
              { "@type": "richTextDateTime", text: plain("tomorrow"), unix_time: 1_800_000_000,
                formatting_type: { "@type": "dateTimeFormattingTypeRelative" } },
              { "@type": "richTextMention", text: plain("@notgram"), username: "notgram" },
              { "@type": "richTextMentionName", text: plain("Mia"), user_id: 7 },
              { "@type": "richTextHashtag", text: plain("#release"), hashtag: "release" },
              { "@type": "richTextCashtag", text: plain("$USD"), cashtag: "USD" },
              { "@type": "richTextBankCardNumber", text: plain("4242"), bank_card_number: "4242" },
              { "@type": "richTextBotCommand", text: plain("/start"), bot_command: "start" },
              { "@type": "richTextCustomEmoji", custom_emoji_id: "99", alternative_text: "✨" },
              { "@type": "richTextMathematicalExpression", expression: "x^2" },
              { "@type": "richTextAnchor", name: "chapter" },
              { "@type": "richTextAnchorLink", text: plain("jump"), anchor_name: "chapter" },
              { "@type": "richTextReference", name: "note", text: plain("definition") },
              { "@type": "richTextReferenceLink", text: plain("footnote"), reference_name: "note" },
            ],
          },
        }],
      },
    });

    expect(mapped.kind).toBe("rich");
    if (mapped.kind !== "rich" || mapped.blocks[0]?.kind !== "paragraph") return;
    const runs = mapped.blocks[0].text;
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "marked", marked: true }),
      expect.objectContaining({
        text: "tomorrow",
        dateTime: { unixTime: 1_800_000_000, mode: "relative" },
      }),
      expect.objectContaining({ text: "@notgram", href: "tg://resolve?domain=notgram" }),
      expect.objectContaining({ text: "Mia", href: "tg://user?id=7" }),
      expect.objectContaining({ text: "#release", semantic: "hashtag" }),
      expect.objectContaining({ text: "$USD", semantic: "cashtag" }),
      expect.objectContaining({ text: "4242", semantic: "bankCard" }),
      expect.objectContaining({ text: "/start", semantic: "botCommand" }),
      expect.objectContaining({ text: "✨", customEmojiId: "99" }),
      expect.objectContaining({ text: "x^2", mathematicalExpression: "x^2" }),
      expect.objectContaining({ text: "", anchor: { kind: "anchor", name: "chapter" } }),
      expect.objectContaining({ text: "jump", linkTarget: { kind: "anchor", name: "chapter" } }),
      expect.objectContaining({ text: "definition", anchor: { kind: "reference", name: "note" } }),
      expect.objectContaining({ text: "footnote", linkTarget: { kind: "reference", name: "note" } }),
    ]));
  });

  it("preserves Bot API rich blocks, layout metadata, and media files", () => {
    const text = (value: string) => ({ "@type": "richTextPlain", text: value });
    const file = (id: number) => ({
      "@type": "file",
      id,
      size: 2048,
      local: {
        can_be_downloaded: true,
        is_downloading_active: false,
        is_downloading_completed: false,
        downloaded_size: 0,
      },
      remote: { is_uploading_active: false, uploaded_size: 0 },
    });
    const caption = { "@type": "pageBlockCaption", text: text("caption"), credit: text("credit") };
    const photo = {
      "@type": "photo",
      sizes: [{ "@type": "photoSize", width: 640, height: 480, photo: file(41) }],
    };
    const mapped = mapTdMessageContent({
      "@type": "messageRichMessage",
      message: {
        "@type": "richMessage",
        is_full: true,
        is_rtl: false,
        blocks: [
          { "@type": "pageBlockFooter", footer: text("footer") },
          { "@type": "pageBlockThinking", text: text("thinking") },
          { "@type": "pageBlockMathematicalExpression", expression: "E=mc^2" },
          { "@type": "pageBlockAnchor", name: "start" },
          {
            "@type": "pageBlockList",
            items: [{
              "@type": "pageBlockListItem",
              label: "iv.",
              blocks: [{ "@type": "pageBlockParagraph", text: text("item") }],
              has_checkbox: true,
              is_checked: true,
              value: 4,
              type: "i",
            }],
          },
          { "@type": "pageBlockPullQuote", text: text("quote"), credit: text("author") },
          {
            "@type": "pageBlockTable",
            caption: text("table"),
            is_bordered: true,
            is_striped: true,
            cells: [[{
              "@type": "pageBlockTableCell",
              text: text("cell"),
              is_header: true,
              colspan: 2,
              rowspan: 1,
              align: { "@type": "pageBlockHorizontalAlignmentCenter" },
              valign: { "@type": "pageBlockVerticalAlignmentMiddle" },
            }]],
          },
          {
            "@type": "pageBlockDetails",
            header: text("summary"),
            blocks: [{ "@type": "pageBlockParagraph", text: text("details") }],
            is_open: true,
          },
          {
            "@type": "pageBlockMap",
            location: { "@type": "location", latitude: 41.9, longitude: 12.5, horizontal_accuracy: 4 },
            zoom: 14,
            width: 640,
            height: 360,
            caption,
          },
          { "@type": "pageBlockPhoto", photo, caption, url: "", has_spoiler: true },
          {
            "@type": "pageBlockAnimation",
            animation: { file_name: "demo.gif", mime_type: "image/gif", animation: file(42) },
            caption,
            need_autoplay: true,
            has_spoiler: false,
          },
          {
            "@type": "pageBlockAudio",
            audio: { file_name: "demo.mp3", mime_type: "audio/mpeg", audio: file(43), duration: 12 },
            caption,
          },
          {
            "@type": "pageBlockVideo",
            video: {
              file_name: "demo.mp4",
              mime_type: "video/mp4",
              video: file(44),
              width: 1280,
              height: 720,
              duration: 20,
            },
            caption,
            need_autoplay: false,
            is_looped: true,
            has_spoiler: true,
          },
          {
            "@type": "pageBlockVoiceNote",
            voice_note: { mime_type: "audio/ogg", voice: file(45), duration: 8 },
            caption,
          },
          {
            "@type": "pageBlockCollage",
            blocks: [{ "@type": "pageBlockPhoto", photo, caption: null, url: "", has_spoiler: false }],
            caption,
          },
        ],
      },
    });

    expect(mapped.kind).toBe("rich");
    if (mapped.kind !== "rich") return;
    expect(mapped.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "footer", text: [{ text: "footer" }] }),
      expect.objectContaining({ kind: "thinking", text: [{ text: "thinking" }] }),
      { kind: "mathematicalExpression", expression: "E=mc^2" },
      { kind: "anchor", name: "start" },
      expect.objectContaining({
        kind: "list",
        ordered: true,
        items: [expect.objectContaining({ label: "iv.", value: 4, type: "i", checked: true })],
      }),
      expect.objectContaining({ kind: "quote", pull: true, credit: [{ text: "author" }] }),
      expect.objectContaining({
        kind: "table",
        bordered: true,
        striped: true,
        rows: [[expect.objectContaining({ align: "center", valign: "middle", visible: true })]],
      }),
      expect.objectContaining({ kind: "details", open: true }),
      expect.objectContaining({ kind: "map", latitude: 41.9, longitude: 12.5, zoom: 14 }),
      expect.objectContaining({
        kind: "media",
        media: expect.objectContaining({
          mediaType: "photo",
          fileId: 41,
          width: 640,
          height: 480,
          hasSpoiler: true,
          caption: { text: [{ text: "caption" }], credit: [{ text: "credit" }] },
        }),
      }),
      expect.objectContaining({
        kind: "media",
        media: expect.objectContaining({ mediaType: "animation", fileId: 42, autoplay: true }),
      }),
      expect.objectContaining({
        kind: "media",
        media: expect.objectContaining({ mediaType: "audio", fileId: 43, duration: 12 }),
      }),
      expect.objectContaining({
        kind: "media",
        media: expect.objectContaining({
          mediaType: "video",
          fileId: 44,
          loop: true,
          hasSpoiler: true,
        }),
      }),
      expect.objectContaining({
        kind: "media",
        media: expect.objectContaining({ mediaType: "voice", fileId: 45, duration: 8 }),
      }),
      expect.objectContaining({ kind: "collection", layout: "collage" }),
    ]));
  });

  it("renders a stable fallback for future TDLib message types", () => {
    expect(mapTdMessageContent({ "@type": "messageFutureType" })).toEqual({
      kind: "unsupported",
      type: "messageFutureType",
      text: "收到新类型消息（messageFutureType）",
    });

    const rawMessage = {
      "@type": "message",
      id: 41,
      chat_id: 9,
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      date: 1_700_000_000,
      content: { "@type": "messageFutureType", payload: { answer: 42 } },
    };
    const mapped = mapTdMessage(rawMessage);
    expect(mapped?.content).toMatchObject({
      kind: "unsupported",
      type: "messageFutureType",
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
        error: { "@type": "error", code: 400, message: "QUOTE_TEXT_INVALID" },
        can_retry: true,
        need_another_reply_quote: true,
        need_drop_reply: false,
        need_another_sender: false,
        required_paid_message_star_count: 0,
        retry_after: 0,
      },
      content: {
        "@type": "messageText",
        text: { "@type": "formattedText", text: "retry me", entities: [] },
      },
    });

    expect(message).toMatchObject({
      delivery: "failed",
      canRetry: false,
      sendFailure: {
        code: 400,
        message: "QUOTE_TEXT_INVALID",
        needAnotherReplyQuote: true,
        needDropReply: false,
        needAnotherSender: false,
        requiredPaidMessageStarCount: "0",
        retryAfter: 0,
      },
    });
  });

  it("preserves UTF-16 mention entities for users and bots", () => {
    expect(mapTdMessageContent({
      "@type": "messageText",
      text: {
        "@type": "formattedText",
        text: "@i00pro  把 @RyougiShikiBot 拉进来",
        entities: [
          {
            offset: 0,
            length: 7,
            type: { "@type": "textEntityTypeMention" },
          },
          {
            offset: 11,
            length: 15,
            type: { "@type": "textEntityTypeMention" },
          },
        ],
      },
    })).toEqual({
      kind: "text",
      text: "@i00pro  把 @RyougiShikiBot 拉进来",
      entities: [
        { offset: 0, length: 7, kind: "mention" },
        { offset: 11, length: 15, kind: "mention" },
      ],
    });

    expect(mapTdMessageContent({
      "@type": "messageText",
      text: {
        text: "Telegram 用户",
        entities: [{
          offset: 0,
          length: 11,
          type: { "@type": "textEntityTypeMentionName", user_id: 5348619655 },
        }],
      },
    })).toMatchObject({
      entities: [{ kind: "mentionName", userId: "5348619655" }],
    });
  });

  it("maps the TDLib messageVideo cover photo when video.thumbnail is absent", () => {
    const content = mapTdMessageContent({
      "@type": "messageVideo",
      cover: {
        "@type": "photo",
        minithumbnail: { data: "Y292ZXI=" },
        sizes: [{
          "@type": "photoSize",
          width: 320,
          height: 180,
          photo: {
            "@type": "file",
            id: 41,
            local: {
              can_be_downloaded: true,
              is_downloading_active: false,
              is_downloading_completed: false,
            },
          },
        }],
      },
      video: {
        file_name: "cover-field.mp4",
        mime_type: "video/mp4",
        width: 1280,
        height: 720,
        video: {
          id: 42,
          size: 8_000_000,
          local: { can_be_downloaded: true, is_downloading_completed: false },
        },
      },
    });

    expect(content).toMatchObject({
      mediaType: "video",
      fileId: 42,
      thumbnailFileId: 41,
      thumbnailCanDownload: true,
      thumbnailIsDownloading: false,
      previewDataUrl: "data:image/jpeg;base64,Y292ZXI=",
    });
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
      is_channel_post: true,
      author_signature: "Channel editor",
      contains_unread_mention: true,
      date: 1_700_000_000,
      edit_date: 1_700_000_100,
      reply_to: {
        "@type": "messageReplyToMessage",
        chat_id: 88,
        message_id: 900,
        sender_id: { "@type": "messageSenderUser", user_id: 42 },
        quote: {
          "@type": "textQuote",
          text: { "@type": "formattedText", text: "quoted text", entities: [] },
          position: 7,
          is_manual: true,
        },
        origin: { "@type": "messageOriginHiddenUser", sender_name: "Hidden Sender" },
        origin_send_date: 1_699_999_000,
        is_outgoing: true,
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
          can_get_added_reactions: true,
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
      isChannelPost: true,
      authorSignature: "Channel editor",
      editedAt: "2023-11-14T22:15:00.000Z",
      containsUnreadMention: true,
      replyTo: {
        kind: "message",
        chatId: "88",
        messageId: "900",
        senderId: "42",
        quote: "quoted text",
        origin: { kind: "hiddenUser", senderName: "Hidden Sender" },
        content: { kind: "text", text: "source preview" },
        outgoing: true,
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
        canGetAddedReactions: true,
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

  it("maps paged message reaction senders", () => {
    expect(mapTdMessageReactionSenders({
      "@type": "addedReactions",
      total_count: 3,
      reactions: [
        {
          type: { "@type": "reactionTypeEmoji", emoji: "🔥" },
          sender_id: { "@type": "messageSenderUser", user_id: 7 },
          is_outgoing: true,
          date: 1_700_000_000,
        },
        {
          type: { "@type": "reactionTypeCustomEmoji", custom_emoji_id: "123456789" },
          sender_id: { "@type": "messageSenderChat", chat_id: 77 },
          is_outgoing: false,
          date: 1_700_000_001,
        },
      ],
      next_offset: "next-page",
    })).toEqual({
      totalCount: 3,
      senders: [
        {
          senderId: "7",
          type: { kind: "emoji", emoji: "🔥" },
          outgoing: true,
          addedAt: "2023-11-14T22:13:20.000Z",
        },
        {
          senderId: "chat:77",
          type: { kind: "customEmoji", customEmojiId: "123456789" },
          outgoing: false,
          addedAt: "2023-11-14T22:13:21.000Z",
        },
      ],
      nextOffset: "next-page",
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

  it("maps inline bot keyboards from raw TDLib messages", () => {
    const message = mapTdMessage({
      id: 22134390784,
      chat_id: 99,
      sender_id: { "@type": "messageSenderUser", user_id: 5762373625 },
      date: 1_700_000_000,
      content: {
        "@type": "messageText",
        text: { "@type": "formattedText", text: "anime", entities: [] },
      },
      reply_markup: {
        "@type": "replyMarkupInlineKeyboard",
        rows: [
          [
            { text: "👥", style: { "@type": "buttonStyleDefault" }, type: { "@type": "inlineKeyboardButtonTypeCallback", data: "Y2F0ZWdvcnk9MA==" } },
            { text: "📢", style: { "@type": "buttonStyleDefault" }, type: { "@type": "inlineKeyboardButtonTypeCallback", data: "Y2F0ZWdvcnk9MQ==" } },
          ],
          [
            { text: "下一页", style: { "@type": "buttonStylePrimary" }, type: { "@type": "inlineKeyboardButtonTypeCallback", data: "cGFnZT0y" } },
          ],
        ],
      },
    });

    expect(message?.replyMarkup).toEqual({
      kind: "inlineKeyboard",
      rows: [
        [
          { kind: "callback", style: "default", text: "👥", data: "Y2F0ZWdvcnk9MA==" },
          { kind: "callback", style: "default", text: "📢", data: "Y2F0ZWdvcnk9MQ==" },
        ],
        [{ kind: "callback", style: "primary", text: "下一页", data: "cGFnZT0y" }],
      ],
    });
  });

  it("maps pin state, pin permissions, and chat auto-delete settings", () => {
    expect(mapTdMessageProperties({
      can_be_replied: true,
      can_be_edited: false,
      can_be_deleted_only_for_self: false,
      can_be_deleted_for_all_users: false,
      can_be_forwarded: true,
      can_be_pinned: true,
    })).toMatchObject({
      canPin: true,
    });
    expect(mapTdChat({
      id: 7,
      type: { "@type": "chatTypeBasicGroup" },
      title: "Group",
      message_auto_delete_time: 604800,
    })).toMatchObject({ messageAutoDeleteTime: 604800 });
    expect(mapTdMessage({
      id: 12,
      chat_id: 7,
      sender_id: { "@type": "messageSenderUser", user_id: 9 },
      is_outgoing: false,
      is_pinned: true,
      date: 1_700_000_000,
      content: { "@type": "messageText", text: { text: "pinned", entities: [] } },
    })).toMatchObject({ id: "12", isPinned: true });
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
        {
          list: { "@type": "chatListFolder", chat_folder_id: 12 },
          order: 10,
          is_pinned: true,
        },
      ],
      chat_lists: [{ "@type": "chatListFolder", chat_folder_id: 12 }],
      photo: {
        small: {
          id: 9,
          local: { is_downloading_completed: true, path: "C:\\avatars\\group.jpg" },
        },
      },
    });

    expect(folders.map((folder) => folder.id)).toEqual(["folder:12", "main", "archive"]);
    expect(chat?.folderIds).toEqual(["folder:12"]);
    expect(chat?.pinnedFolderIds).toEqual(["folder:12"]);
    expect(chat?.avatar.imagePath).toBe("C:\\avatars\\group.jpg");
  });
});
