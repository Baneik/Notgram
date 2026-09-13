import { expect, test } from "@playwright/test";
import { horizontalOverflow } from "./helpers";

test("channel sponsored messages stay in an independent timeline block and can be disabled", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  const sponsored = page.locator('[data-sponsored-message-id="sponsored-release-1"]');
  await expect(sponsored).toHaveCount(0);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: /Notgram/ }).click();
  await settings.getByRole("switch", { name: "屏蔽频道广告" }).uncheck();
  await settings.getByRole("button", { name: "关闭" }).click();
  await expect(sponsored).toBeVisible();
  await expect(sponsored).toContainText("Notgram Studio");
  await expect(page.locator('[data-message-id="sponsored-release-1"]')).toHaveCount(0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await settings.getByRole("button", { name: /Notgram/ }).click();
  await settings.getByRole("switch", { name: "屏蔽频道广告" }).check();
  await settings.getByRole("button", { name: "关闭" }).click();
  await expect(sponsored).toHaveCount(0);
});

test("channel owners can publish posts and toggle silent sending", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();

  const composer = page.getByRole("textbox", { name: "消息内容" });
  await expect(composer).toBeVisible();
  const silentToggle = page.getByRole("button", { name: "静默发送" });
  await expect(silentToggle).toHaveAttribute("aria-pressed", "false");

  await silentToggle.click();
  await expect(silentToggle).toHaveAttribute("aria-pressed", "true");
  await composer.fill("频道所有者发布的新帖子");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.locator(".message-list").getByText("频道所有者发布的新帖子", { exact: true })).toBeVisible();
});

test("channel posts expose views, forwards, and author metadata without a sync forward label", async ({ page }) => {
  await page.goto("/");
  const linked = page.locator('[data-message-id="p-channel-reply"]');
  await expect(linked).toBeVisible();
  await expect(linked.locator(".message-forward-label")).toHaveCount(0);
  await expect(linked.locator('[aria-label="转发 23 次"]')).toHaveText("23");
  await expect(linked.locator('[aria-label="22200 次观看"]')).toHaveText("22.2K");
  await expect(linked.locator(".message-channel-author")).toHaveText("Release editor");

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  const post = page.locator('[data-message-id="release-post-1"]');
  await expect(post).toBeVisible();
  await expect(post.locator('[aria-label="转发 23 次"]')).toHaveText("23");
  await expect(post.locator('[aria-label="22200 次观看"]')).toHaveText("22.2K");
  await expect(post.locator(".message-channel-author")).toHaveText("Release editor");
});

test("channel post metadata and discussion messages keep shared conversation geometry", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  await page.evaluate(async ([storePath, preferencesPath]) => {
    type TestMessage = {
      id: string;
      chatId: string;
      senderId: string;
      sentAt: string;
      content: { kind: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    const [{ telegramStore }, { preferencesStore }] = await Promise.all([
      import(storePath) as Promise<{ telegramStore: {
        getState: () => { messages: Map<string, TestMessage[]> };
        setState: (partial: Record<string, unknown>) => void;
      } }>,
      import(preferencesPath) as Promise<{ preferencesStore: {
        setState: (partial: Record<string, unknown>) => void;
      } }>,
    ]);
    preferencesStore.setState({
      chatFontSize: 18,
      messageGroupSpacing: 17,
      messageRowSpacing: 4,
      messageBubblePadding: 12,
    });
    const state = telegramStore.getState();
    const releaseMessages = state.messages.get("chat-release") ?? [];
    const root = releaseMessages.find((message) => message.id === "release-post-1")!;
    const commonPost = {
      chatId: "chat-release",
      senderId: "chat:chat-release",
      authorSignature: "Release editor",
      isChannelPost: true,
      outgoing: false,
      delivery: "read",
      interaction: {
        viewCount: 432,
        forwardCount: 7,
        replyCount: 0,
        reactions: [],
        hasDiscussion: false,
      },
    };
    const photoPost: TestMessage = {
      ...commonPost,
      id: "release-photo-post",
      sentAt: "2026-08-01T09:51:00+08:00",
      content: {
        kind: "media",
        mediaType: "photo",
        fileId: 9_911,
        fileName: "channel-photo.jpg",
        localPath: "/mock-video-poster.jpg",
        size: 4_096,
        width: 640,
        height: 360,
        isDownloaded: true,
      },
    };
    const filePost: TestMessage = {
      ...commonPost,
      id: "release-file-post",
      sentAt: "2026-08-01T09:52:00+08:00",
      editedAt: "2026-08-01T09:53:00+08:00",
      content: {
        kind: "file",
        fileId: 9_912,
        fileName: "notgram-channel-layout-regression-build.zip",
        mimeType: "application/zip",
        size: 9_500_000,
        canDownload: true,
        isDownloaded: false,
        isDownloading: false,
        caption: "文件说明与普通消息使用同一文本字号和水平内边距。",
      },
    };
    const longTextPost: TestMessage = {
      ...commonPost,
      id: "release-long-text-post",
      sentAt: "2026-08-01T09:54:00+08:00",
      isPinned: true,
      content: {
        kind: "text",
        text: "这是一条用于覆盖窄宽度、长文本、置顶状态以及频道统计信息换行的测试消息。",
      },
    };
    const replyTo = {
      kind: "message",
      chatId: "chat-release",
      messageId: root.id,
      content: root.content,
    };
    const comments: TestMessage[] = [
      {
        id: "release-comment-layout-text",
        chatId: "chat-release",
        senderId: "u-mia",
        outgoing: false,
        sentAt: "2026-08-01T09:55:00+08:00",
        delivery: "read",
        replyTo,
        content: { kind: "text", text: "讨论区普通文本样例" },
      },
      {
        id: "release-comment-layout-long",
        chatId: "chat-release",
        senderId: "u-mia",
        outgoing: false,
        sentAt: "2026-08-01T09:56:00+08:00",
        delivery: "read",
        replyTo,
        content: {
          kind: "text",
          text: "讨论区长文本需要与群组会话保持相同的头像占位、气泡边距、行间距和右下角时间布局。",
        },
      },
      {
        id: "release-comment-layout-file",
        chatId: "chat-release",
        senderId: "u-mia",
        outgoing: false,
        sentAt: "2026-08-01T09:57:00+08:00",
        delivery: "read",
        replyTo,
        content: {
          kind: "file",
          fileId: 9_913,
          fileName: "discussion-attachment-with-a-long-name.pdf",
          mimeType: "application/pdf",
          size: 1_024_000,
          canDownload: true,
          isDownloaded: false,
          isDownloading: false,
          caption: "讨论区附件说明",
        },
      },
      {
        id: "release-comment-layout-outgoing",
        chatId: "chat-release",
        senderId: "self",
        outgoing: true,
        sentAt: "2026-08-01T09:58:00+08:00",
        delivery: "read",
        replyTo,
        content: { kind: "text", text: "讨论区发出消息样例" },
      },
    ];
    const nextMessages = new Map(state.messages);
    nextMessages.set("chat-release", [
      ...releaseMessages.filter((message) => !message.id.startsWith("release-comment-")),
      photoPost,
      filePost,
      longTextPost,
      ...comments,
    ]);
    telegramStore.setState({
      messages: nextMessages,
      loadMessageThreadHistory: async () => ({ chatId: root.chatId, messageId: root.id, messages: [root, ...comments], hasMore: false }),
    });
  }, ["/src/store/telegramStore.ts", "/src/store/preferencesStore.ts"]);

  const photoPost = page.locator('[data-message-id="release-photo-post"]');
  const filePost = page.locator('[data-message-id="release-file-post"]');
  const textPost = page.locator('[data-message-id="release-long-text-post"]');
  await expect(photoPost).toBeVisible();
  await expect(filePost).toBeVisible();
  await expect(textPost).toBeVisible();

  const photoMeta = photoPost.locator(".message-meta.is-channel-meta");
  await expect(photoMeta).toHaveCSS("opacity", "1");
  await expect(photoMeta.locator('[aria-label="转发 7 次"]')).toBeVisible();
  await expect(photoMeta.locator('[aria-label="432 次观看"]')).toBeVisible();
  const [photoBubbleBounds, photoMetaBounds] = await Promise.all([
    photoPost.locator(".message-bubble").boundingBox(),
    photoMeta.boundingBox(),
  ]);
  expect(photoMetaBounds!.y + photoMetaBounds!.height).toBeLessThanOrEqual(
    photoBubbleBounds!.y + photoBubbleBounds!.height + 1,
  );

  const [fileBubbleBounds, fileContentBounds, fileMetaBounds, fileStatusBounds] = await Promise.all([
    filePost.locator(".message-bubble").boundingBox(),
    filePost.locator(".file-primary-action").boundingBox(),
    filePost.locator(".message-meta.is-channel-meta").boundingBox(),
    filePost.locator(".message-meta-status").boundingBox(),
  ]);
  expect(fileContentBounds!.x - fileBubbleBounds!.x).toBeCloseTo(14, 0);
  expect(fileMetaBounds!.x).toBeGreaterThanOrEqual(fileBubbleBounds!.x);
  expect(fileMetaBounds!.x + fileMetaBounds!.width).toBeLessThanOrEqual(
    fileBubbleBounds!.x + fileBubbleBounds!.width + 1,
  );
  expect(fileStatusBounds!.x + fileStatusBounds!.width).toBeLessThanOrEqual(
    fileBubbleBounds!.x + fileBubbleBounds!.width - 10,
  );

  const textMeta = textPost.locator(".message-meta.is-channel-meta");
  const [textStatsBounds, textStatusBounds] = await Promise.all([
    textMeta.locator(".message-meta-stats").boundingBox(),
    textMeta.locator(".message-meta-status").boundingBox(),
  ]);
  expect(textStatsBounds!.x + textStatsBounds!.width).toBeLessThanOrEqual(textStatusBounds!.x + 1);

  await page.locator('[data-message-id="release-post-1"]')
    .getByRole("button", { name: "2 条评论" })
    .click();
  const panel = page.locator(".channel-discussion-panel");
  const incoming = panel.locator('[data-message-id="release-comment-layout-text"]');
  const longIncoming = panel.locator('[data-message-id="release-comment-layout-long"]');
  const fileIncoming = panel.locator('[data-message-id="release-comment-layout-file"]');
  const outgoing = panel.locator('[data-message-id="release-comment-layout-outgoing"]');
  await expect(incoming).toBeVisible();
  await expect(longIncoming).toBeVisible();
  await expect(fileIncoming).toBeVisible();
  await expect(outgoing).toBeVisible();
  await expect(incoming.locator(".message-rich-text")).toHaveCSS("font-size", "18px");
  await expect(incoming).toHaveCSS("margin-top", "4px");
  await expect(incoming.locator(".message-bubble")).toHaveCSS("padding-top", "12px");
  const groupAncestor = "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' message-group ')]";
  const incomingGroup = incoming.locator(groupAncestor);
  await expect(incomingGroup).toHaveCSS("margin-bottom", "17px");
  await expect(incomingGroup.locator(".message-group-avatar .avatar")).toHaveCount(1);
  await expect(outgoing.locator(groupAncestor).locator(".message-group-avatar"))
    .toHaveCount(0);
  const [streamBounds, outgoingBubbleBounds, discussionFileBubbleBounds, discussionFileMetaBounds] = await Promise.all([
    panel.locator(".channel-discussion-stream").boundingBox(),
    outgoing.locator(".message-bubble").boundingBox(),
    fileIncoming.locator(".message-bubble").boundingBox(),
    fileIncoming.locator(".message-meta").boundingBox(),
  ]);
  expect(outgoingBubbleBounds!.x + outgoingBubbleBounds!.width).toBeLessThanOrEqual(
    streamBounds!.x + streamBounds!.width + 1,
  );
  expect(discussionFileMetaBounds!.x + discussionFileMetaBounds!.width).toBeLessThanOrEqual(
    discussionFileBubbleBounds!.x + discussionFileBubbleBounds!.width + 1,
  );
  await expect.poll(() => horizontalOverflow(page)).toBe(false);
});

test("channel posts integrate their comment action and load the linked discussion thread", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  const post = page.locator('[data-message-id="release-post-1"]');
  await expect(post).toBeVisible();
  // The mock account owns this channel; regular subscribers are covered separately.
  await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveCount(1);
  await expect(page.locator('[data-message-id="release-comment-1"]')).toHaveCount(0);

  const commentButton = post.getByRole("button", { name: "2 条评论" });
  await expect(commentButton).toHaveText("2条评论");
  const [bubbleBounds, buttonBounds, shellBounds, conversationBounds] = await Promise.all([
    post.locator(".message-bubble").boundingBox(),
    commentButton.boundingBox(),
    post.locator(".message-bubble-shell").boundingBox(),
    page.locator(".conversation").boundingBox(),
  ]);
  expect(buttonBounds!.y).toBeGreaterThanOrEqual(bubbleBounds!.y);
  expect(buttonBounds!.y + buttonBounds!.height).toBeLessThanOrEqual(
    bubbleBounds!.y + bubbleBounds!.height + 1,
  );
  expect(Math.abs(buttonBounds!.width - bubbleBounds!.width)).toBeLessThanOrEqual(2.5);
  expect(shellBounds!.width).toBeLessThanOrEqual(
    Math.min(conversationBounds!.width * 0.74, 720) + 1,
  );
  const [bubbleBackground, buttonBackground] = await Promise.all([
    post.locator(".message-bubble").evaluate((element) => getComputedStyle(element).backgroundColor),
    commentButton.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(buttonBackground).toBe(bubbleBackground);

  const meta = post.locator(".message-meta.is-channel-meta");
  const [statsBounds, statusBounds] = await Promise.all([
    meta.locator(".message-meta-stats").boundingBox(),
    meta.locator(".message-meta-status").boundingBox(),
  ]);
  expect(statsBounds!.x + statsBounds!.width).toBeLessThanOrEqual(statusBounds!.x + 1);

  await commentButton.click();
  const panel = page.locator(".channel-discussion-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".channel-discussion-heading")).toHaveText("Release Notes");
  await expect(panel.locator(".channel-discussion-heading-label")).toHaveCount(0);
  await expect(panel.locator(".channel-discussion-count")).toHaveCount(0);
  await expect(panel.locator('[data-message-id="release-comment-1"]')).toBeVisible();
  await expect(panel.locator('[data-message-id="release-comment-2"]')).toBeVisible();
  await expect(panel.getByText("还没有留言")).toHaveCount(0);
  await expect(panel.getByText("正在加载留言")).toHaveCount(0);

  const panelPost = panel.locator('[data-message-id="release-post-1"]');
  const discussionScroller = panel.locator(".channel-discussion-messages");
  await expect(panel.locator(".channel-discussion-post")).not.toHaveAttribute("title");
  await expect.poll(() => panelPost.evaluate((element) =>
    Boolean(element.closest(".channel-discussion-messages"))
  )).toBe(true);
  const [panelBounds, scrollerBounds, backBounds, headingBounds] = await Promise.all([
    panel.boundingBox(),
    discussionScroller.boundingBox(),
    panel.getByRole("button", { name: "返回频道" }).boundingBox(),
    panel.locator(".channel-discussion-heading").boundingBox(),
  ]);
  expect(Math.abs(
    panelBounds!.x + panelBounds!.width - (scrollerBounds!.x + scrollerBounds!.width),
  )).toBeLessThanOrEqual(1);
  expect(headingBounds!.x).toBeGreaterThanOrEqual(backBounds!.x + backBounds!.width);
  expect(headingBounds!.x).toBeLessThan(panelBounds!.x + panelBounds!.width * 0.25);
  await expect(panelPost.locator(".message-bubble")).toHaveCSS("border-radius", "10px");
  await expect(panelPost.locator(".message-bubble")).toHaveCSS("overflow", "hidden");
  const [panelPostBubbleBounds, panelPostMetaBounds] = await Promise.all([
    panelPost.locator(".message-bubble").boundingBox(),
    panelPost.locator(".message-meta.is-channel-meta").boundingBox(),
  ]);
  expect(panelPostBubbleBounds!.y + panelPostBubbleBounds!.height -
    (panelPostMetaBounds!.y + panelPostMetaBounds!.height)).toBeGreaterThanOrEqual(8);

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", { button: 3, bubbles: true, cancelable: true }));
  });
  await expect(panel).toHaveCount(0);
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", { button: 4, bubbles: true, cancelable: true }));
  });
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-message-id="release-comment-1"]')).toBeVisible();
  await panel.getByRole("button", { name: "返回频道" }).click();
  await expect(panel).toHaveCount(0);

  await page.evaluate(async (storePath) => {
    const { telegramStore } = await import(storePath) as {
      telegramStore: { setState: (state: Record<string, unknown>) => void };
    };
    telegramStore.setState({
      loadMessageThreadHistory: async () => new Promise(() => undefined),
    });
  }, "/src/store/telegramStore.ts");

  await commentButton.click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-message-id="release-comment-1"]')).toBeVisible();
  await expect(panel.locator('[data-message-id="release-comment-2"]')).toBeVisible();
  await expect(panel.getByText("正在加载留言")).toHaveCount(0);
  await expect(panel.locator(".channel-discussion-composer")).toHaveCSS("border-top-width", "0px");

  const composer = panel.locator(".composer");
  await expect(composer).toHaveCSS("box-shadow", /0px 1px 0px 0px inset$/);
  await expect(composer.getByRole("button", { name: "添加附件" })).toBeVisible();
  await expect(composer.getByRole("button", { name: "表情" })).toBeVisible();
  await composer.getByRole("textbox", { name: "消息内容" }).fill("E2E thread comment");
  await composer.getByRole("button", { name: "发送消息" }).click();
  await expect(panel.getByText("E2E thread comment")).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 320 });
  await discussionScroller.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect.poll(() => discussionScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => panelPost.evaluate((element) => {
    const scroller = element.closest(".channel-discussion-messages");
    if (!scroller) return Number.POSITIVE_INFINITY;
    const messageBounds = element.getBoundingClientRect();
    const scrollerBounds = scroller.getBoundingClientRect();
    return Math.max(0, Math.min(messageBounds.bottom, scrollerBounds.bottom) -
      Math.max(messageBounds.top, scrollerBounds.top));
  })).toBeLessThanOrEqual(1);

  await panel.getByRole("button", { name: "返回频道" }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(async (storePath) => {
    const { telegramStore } = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<{
          id: string;
          replyTo?: { kind: string; messageId?: string };
        }>> };
        setState: (state: Record<string, unknown>) => void;
      };
    };
    const messages = new Map(telegramStore.getState().messages);
    messages.set("chat-release", (messages.get("chat-release") ?? [])
      .filter((message) => message.replyTo?.kind !== "message" ||
        message.replyTo.messageId !== "release-post-1")
      .map((message) => message.id === "release-post-1"
        ? { ...message, discussionThread: undefined }
        : message));
    telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");
  await commentButton.click();
  const loading = panel.getByRole("status");
  await expect(loading).toHaveText("正在加载留言");
  await expect(loading).toHaveCSS("display", "flex");
  await expect(loading).toHaveCSS("align-items", "center");
  await expect(loading.locator("svg")).toHaveCount(1);
});

test("channel discussion actions use the linked group and preserve composer focus", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await page.evaluate(async (storePath) => {
    type TestMessage = {
      id: string;
      chatId: string;
      senderId: string;
      content: { kind: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    type TestChat = { id: string; title: string; [key: string]: unknown };
    type DiscussionCall = { kind: string; args: unknown[] };
    const { telegramStore } = await import(storePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, TestMessage[]>;
          chats: Map<string, TestChat>;
        };
        setState: (state: Record<string, unknown>) => void;
      };
    };
    const state = telegramStore.getState();
    const channelMessages = state.messages.get("chat-release") ?? [];
    const post = channelMessages.find((message) => message.id === "release-post-1")!;
    const discussionChatId = "chat-release-discussion";
    const discussionRoot: TestMessage = {
      ...post,
      id: "discussion-root",
      chatId: discussionChatId,
      isChannelPost: false,
      discussionThread: undefined,
    };
    const permissions = {
      canReply: true,
      canEdit: true,
      canDeleteOnlyForSelf: true,
      canDeleteForAllUsers: true,
      canForward: true,
    };
    const incoming: TestMessage = {
      id: "discussion-action-incoming",
      chatId: discussionChatId,
      senderId: "u-mia",
      outgoing: false,
      sentAt: "2026-08-01T10:01:00+08:00",
      delivery: "read",
      permissions,
      replyTo: { kind: "message", chatId: discussionChatId, messageId: discussionRoot.id },
      interaction: {
        viewCount: 0,
        forwardCount: 0,
        replyCount: 0,
        canGetAddedReactions: true,
        reactions: [{
          type: { kind: "emoji", emoji: "👍" },
          totalCount: 1,
          chosen: false,
          recentSenderIds: ["u-mia"],
        }],
      },
      content: {
        kind: "text",
        text: "请看 @mia_design #release",
        entities: [
          { offset: 3, length: 11, kind: "mention" },
          { offset: 15, length: 8, kind: "hashtag" },
        ],
      },
    };
    const outgoing: TestMessage = {
      id: "discussion-action-outgoing",
      chatId: discussionChatId,
      senderId: "self",
      outgoing: true,
      sentAt: "2026-08-01T10:02:00+08:00",
      delivery: "read",
      permissions,
      replyTo: { kind: "message", chatId: discussionChatId, messageId: discussionRoot.id },
      content: { kind: "text", text: "待编辑的讨论回复" },
    };
    const messages = new Map(state.messages);
    messages.set("chat-release", channelMessages.map((message) => message.id === post.id
      ? {
          ...message,
          discussionThread: { chatId: discussionChatId, messageId: discussionRoot.id },
        }
      : message));
    messages.set(discussionChatId, [discussionRoot, incoming, outgoing]);
    const chats = new Map(state.chats);
    chats.set(discussionChatId, {
      ...state.chats.get("chat-product")!,
      id: discussionChatId,
      title: "Release discussion",
      preview: "linked comments",
      unreadCount: 0,
      unreadMentionCount: 0,
    });
    const calls: DiscussionCall[] = [];
    (window as unknown as { __discussionActionCalls: DiscussionCall[] }).__discussionActionCalls = calls;
    telegramStore.setState({
      messages,
      chats,
      loadMessageThreadHistory: async () => ({ chatId: discussionRoot.chatId, messageId: discussionRoot.id, messages: [discussionRoot, incoming, outgoing], hasMore: false }),
      loadMessageProperties: async (...args: unknown[]) => {
        calls.push({ kind: "properties", args });
        return permissions;
      },
      getMessageReactionSenders: async (...args: unknown[]) => {
        calls.push({ kind: "reaction-senders", args });
        return {
          totalCount: 1,
          senders: [{
            senderId: "u-mia",
            type: { kind: "emoji", emoji: "👍" },
            outgoing: false,
          }],
        };
      },
      sendMessageToThread: async (...args: unknown[]) => {
        calls.push({ kind: "send", args });
        return true;
      },
      editMessage: async (...args: unknown[]) => {
        calls.push({ kind: "edit", args });
        return true;
      },
    });
  }, "/src/store/telegramStore.ts");

  const post = page.locator('[data-message-id="release-post-1"]');
  await post.getByRole("button", { name: "2 条评论" }).click();
  const panel = page.locator(".channel-discussion-panel");
  const composer = panel.getByRole("textbox", { name: "消息内容" });
  const incoming = panel.locator('[data-message-id="discussion-action-incoming"]');
  const outgoing = panel.locator('[data-message-id="discussion-action-outgoing"]');
  await expect(panel).toBeVisible();
  await expect(incoming).toBeVisible();
  await expect(outgoing).toBeVisible();
  await expect(composer).toBeFocused();

  const reaction = incoming.getByRole("button", { name: /👍，1 个回应/ });
  await reaction.click({ button: "right" });
  const reactionDetails = page.getByRole("menu", { name: "👍 的回应者" });
  await expect(reactionDetails.getByRole("menuitem", { name: "Mia Chen" })).toBeVisible();
  await expect(reactionDetails.locator(".is-error")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await incoming.locator(".message-rich-text").evaluate((surface) => {
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    if (!text) throw new Error("Missing discussion text node");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 2);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await incoming.locator(".message-bubble-shell").click({ button: "right" });
  let messageMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(messageMenu.getByRole("menuitem", { name: "回复" })).toBeVisible();
  await expect(messageMenu.getByRole("menuitem", { name: "转发", exact: true })).toBeVisible();
  await expect(messageMenu.getByRole("menuitem", { name: "复制" })).toBeVisible();
  await expect(messageMenu.getByRole("menuitem", { name: "删除" })).toBeVisible();
  await messageMenu.getByRole("menuitem", { name: "回复" }).click();
  await expect(panel.locator(".composer-context")).toContainText("请看");
  await expect(composer).toBeFocused();
  await composer.fill("带引用的讨论回复");
  await panel.getByRole("button", { name: "发送消息" }).click();
  await expect(composer).toBeFocused();

  await outgoing.locator(".message-bubble-shell").click({ button: "right" });
  messageMenu = page.getByRole("menu", { name: "消息操作" });
  await messageMenu.getByRole("menuitem", { name: "编辑" }).click();
  await expect(composer).toHaveValue("待编辑的讨论回复");
  await expect(composer).toBeFocused();
  await composer.fill("已编辑的讨论回复");
  await panel.getByRole("button", { name: "保存编辑" }).click();
  await expect(composer).toBeFocused();

  await incoming.locator(".message-bubble-shell").click({ button: "right" });
  messageMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(messageMenu.getByRole("menuitem").first()).toBeFocused();
  await expect(messageMenu.getByRole("menuitem", { name: "选择" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(composer).toBeFocused();

  const senderAvatar = incoming.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' message-group ')]")
    .locator(".message-group-avatar")
    .getByRole("button", { name: "查看 Mia Chen 的资料" });
  await senderAvatar.click({ button: "right" });
  const senderMenu = page.getByRole("menu", { name: "成员操作" });
  await senderMenu.getByRole("menuitem", { name: "@Mia Chen" }).click();
  await expect(composer).toHaveValue(/@Mia Chen/);
  await expect(composer).toBeFocused();
  await composer.fill("");

  await expect(incoming.getByRole("link", { name: "Mia Chen", exact: true })).toBeVisible();
  const hashtag = incoming.getByRole("link", { name: "#release" });
  await expect(hashtag).toBeVisible();

  const routedCalls = await page.evaluate(() => (
    window as unknown as { __discussionActionCalls: Array<{ kind: string; args: unknown[] }> }
  ).__discussionActionCalls);
  expect(routedCalls.find((call) => call.kind === "reaction-senders")?.args[3])
    .toBe("chat-release-discussion");
  const sendCall = routedCalls.find((call) => call.kind === "send");
  expect(sendCall?.args[0]).toBe("chat-release-discussion");
  expect(sendCall?.args[1]).toBe("discussion-action-incoming");
  expect(sendCall?.args[2]).toBe("带引用的讨论回复");
  expect(sendCall?.args[4]).toMatchObject({
    text: "请看",
    position: 0,
  });
  const editCall = routedCalls.find((call) => call.kind === "edit");
  expect(editCall?.args[0]).toBe("discussion-action-outgoing");
  expect(editCall?.args[1]).toBe("已编辑的讨论回复");
  expect(editCall?.args[3]).toBe("chat-release-discussion");

  await hashtag.click();
  await expect(page.getByRole("group", { name: "搜索范围：Release discussion" })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "搜索会话和消息" })).toHaveValue("#release");
});

test("channel discussions auto-load media and stickers with live file updates", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  await page.evaluate(async ([storePath, preferencesPath]) => {
    type TestMessage = {
      id: string;
      chatId: string;
      senderId: string;
      sentAt: string;
      content: { kind: string; fileId?: number; [key: string]: unknown };
      [key: string]: unknown;
    };
    const [{ telegramStore }, { preferencesStore }] = await Promise.all([
      import(storePath) as Promise<{ telegramStore: {
        getState: () => { messages: Map<string, TestMessage[]> };
        setState: (partial: Record<string, unknown>) => void;
      } }>,
      import(preferencesPath) as Promise<{ preferencesStore: {
        setState: (partial: Record<string, unknown>) => void;
      } }>,
    ]);
    preferencesStore.setState({ autoDownloadImages: true, autoDownloadLimitMb: 10 });
    const state = telegramStore.getState();
    const releaseMessages = state.messages.get("chat-release") ?? [];
    const root = releaseMessages.find((message) => message.id === "release-post-1")!;
    const replyTo = {
      kind: "message",
      chatId: "chat-release",
      messageId: root.id,
      content: root.content,
    };
    const mediaComment: TestMessage = {
      id: "release-comment-media",
      chatId: "chat-release",
      senderId: "u-mia",
      outgoing: false,
      sentAt: "2026-08-01T09:49:30+08:00",
      delivery: "read",
      replyTo,
      content: {
        kind: "media",
        mediaType: "photo",
        fileId: 9_901,
        fileName: "discussion-photo.jpg",
        size: 4_096,
        width: 640,
        height: 360,
        canDownload: true,
        isDownloaded: false,
        isDownloading: false,
      },
    };
    const stickerComment: TestMessage = {
      id: "release-comment-sticker",
      chatId: "chat-release",
      senderId: "self",
      outgoing: true,
      sentAt: "2026-08-01T09:49:40+08:00",
      delivery: "read",
      replyTo,
      content: {
        kind: "media",
        mediaType: "sticker",
        fileId: 9_902,
        stickerSetId: "7701",
        fileName: "discussion-sticker.webp",
        mimeType: "image/webp",
        size: 4_096,
        width: 512,
        height: 512,
        canDownload: true,
        isDownloaded: false,
        isDownloading: false,
      },
    };
    const messages = new Map(state.messages);
    messages.set("chat-release", [
      ...releaseMessages.filter((message) => !message.id.startsWith("release-comment-")),
      mediaComment,
      stickerComment,
    ]);
    (window as unknown as { __discussionCachedFiles: number[] }).__discussionCachedFiles = [];
    telegramStore.setState({
      messages,
      loadMessageThreadHistory: async () => ({ chatId: root.chatId, messageId: root.id, messages: [root, mediaComment, stickerComment], hasMore: false }),
      cacheFile: async (fileId: number) => {
        (window as unknown as { __discussionCachedFiles: number[] }).__discussionCachedFiles.push(fileId);
        const latest = telegramStore.getState().messages;
        const next = new Map(latest);
        next.set("chat-release", (next.get("chat-release") ?? []).map((message) =>
          message.content.fileId === fileId
            ? {
                ...message,
                content: {
                  ...message.content,
                  localPath: "/mock-video-poster.jpg",
                  canDownload: false,
                  isDownloaded: true,
                  isDownloading: false,
                },
              }
            : message
        ));
        telegramStore.setState({ messages: next });
      },
    });
  }, ["/src/store/telegramStore.ts", "/src/store/preferencesStore.ts"]);

  await page.locator('[data-message-id="release-post-1"]')
    .getByRole("button", { name: "2 条评论" })
    .click();
  const panel = page.locator(".channel-discussion-panel");
  const mediaComment = panel.locator('[data-message-id="release-comment-media"]');
  const stickerComment = panel.locator('[data-message-id="release-comment-sticker"]');
  await expect(mediaComment).toBeVisible();
  await expect(stickerComment).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __discussionCachedFiles: number[] }
  ).__discussionCachedFiles)).toEqual(expect.arrayContaining([9_901, 9_902]));
  await expect(mediaComment.locator('img[src*="mock-video-poster.jpg"]')).toBeVisible();
  await expect(stickerComment.locator('img[src*="mock-video-poster.jpg"]')).toBeVisible();

  const mediaPopupPromise = page.waitForEvent("popup");
  await mediaComment.locator(".photo-open").click();
  const mediaPopup = await mediaPopupPromise;
  await mediaPopup.waitForLoadState("domcontentloaded");
  await expect(mediaPopup.getByRole("dialog", { name: "图片查看器：discussion-photo.jpg" })).toBeVisible();
  await expect(mediaPopup.locator('.media-viewer-image[alt="discussion-photo.jpg"]')).toBeVisible();
  if (!mediaPopup.isClosed()) {
    const mediaPopupClosed = mediaPopup.waitForEvent("close");
    await mediaPopup.keyboard.down("Escape");
    await mediaPopupClosed;
  }
});
