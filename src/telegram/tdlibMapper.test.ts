import { describe, expect, it } from "vitest";
import {
  mapTdChat,
  mapTdChatDraft,
  mapTdChatFolders,
  mapTdMessage,
  mapTdMessageContent,
  mapTdMessageProperties,
  mapTdUser,
} from "./tdlibMapper";

describe("TDLib mapper", () => {
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
      thumbnailFileId: 8,
      thumbnailCanDownload: false,
      thumbnailIsDownloading: false,
      previewDataUrl: "data:image/jpeg;base64,aGVsbG8=",
      width: 1280,
      height: 720,
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
          text: "Bold link code",
          entities: [
            { offset: 0, length: 4, type: { "@type": "textEntityTypeBold" } },
            {
              offset: 5,
              length: 4,
              type: { "@type": "textEntityTypeTextUrl", url: "https://example.com" },
            },
            { offset: 10, length: 4, type: { "@type": "textEntityTypeCode" } },
          ],
        },
      },
    });

    expect(message?.content).toEqual({
      kind: "text",
      text: "Bold link code",
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
      ],
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
        "2 位新成员加入了群聊",
      ],
      [
        { "@type": "messageChatJoinByLink" },
        "有成员通过邀请链接加入了群聊",
      ],
      [
        { "@type": "messageChatJoinByRequest" },
        "入群申请已通过",
      ],
      [
        { "@type": "messageChatChangeTitle", title: "设计讨论" },
        "群聊名称已更改：设计讨论",
      ],
      [
        { "@type": "messagePinMessage" },
        "置顶了一条消息",
      ],
      [
        { "@type": "messageVideoChatStarted" },
        "视频聊天已开始",
      ],
      [
        { "@type": "messageExpiredPhoto" },
        "照片已过期",
      ],
    ] as const;

    for (const [content, text] of cases) {
      expect(mapTdMessageContent(content)).toEqual({ kind: "service", text });
    }
  });

  it("maps additional interactive content instead of using an unsupported placeholder", () => {
    expect(mapTdMessageContent({
      "@type": "messageContact",
      contact: { first_name: "Mia", last_name: "Chen", phone_number: "+123" },
    })).toEqual({ kind: "text", text: "联系人 · Mia Chen · +123" });
    expect(mapTdMessageContent({
      "@type": "messagePoll",
      poll: { question: { "@type": "formattedText", text: "午餐吃什么？" } },
    })).toEqual({ kind: "text", text: "投票：午餐吃什么？" });
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

  it("keeps future TDLib message types diagnosable", () => {
    expect(mapTdMessageContent({ "@type": "messageFutureType" })).toEqual({
      kind: "unsupported",
      type: "messageFutureType",
      text: "收到新类型消息（messageFutureType）",
      raw: "{\n  \"@type\": \"messageFutureType\"\n}",
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
    if (mapped?.content.kind === "unsupported") {
      expect(JSON.parse(mapped.content.raw)).toEqual(rawMessage);
    }
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
