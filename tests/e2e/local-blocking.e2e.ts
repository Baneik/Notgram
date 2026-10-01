import { expect, test, type Page } from "@playwright/test";
import { openConversationMessageSearch, revealVirtualMessage } from "./helpers";

const blockMia = async (page: Page, mode: "mask" | "hide" = "mask") => {
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async mode => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const { localUserBlocksStore } = await import("/src/store/localUserBlocks.ts" as string) as typeof import("../../src/store/localUserBlocks");
    const state = telegramStore.getState();
    localUserBlocksStore.getState().blockUser(state.activeAccountId!, state.users.get("u-mia")!);
    if (mode === "hide") localUserBlocksStore.getState().setUserMode(state.activeAccountId!, "u-mia", mode);
  }, mode);
};

test("native metadata mode changes propagate between independent windows", async ({ page, context }) => {
  const settings = await context.newPage();
  const records = new Map<string, unknown[]>();
  for (const windowPage of [page, settings]) {
    await windowPage.route("**/__metadata-sync", route => route.fulfill({
      contentType: "text/html", body: "<!doctype html><html><head></head><body></body></html>",
    }));
    await windowPage.exposeFunction("__metadataInvoke", (command: string, args: { key: string; records?: unknown[] }) => {
      if (command === "telegram_write_account_metadata") {
        records.set(args.key, structuredClone(args.records!));
        return;
      }
      if (command === "telegram_read_account_metadata") return records.get(args.key) ?? null;
      throw new Error(`Unexpected metadata command: ${command}`);
    });
    await windowPage.addInitScript(() => {
      const native = globalThis as unknown as {
        isTauri: boolean;
        __metadataInvoke: (command: string, args: unknown) => Promise<unknown>;
        __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
      };
      native.isTauri = true;
      native.__TAURI_INTERNALS__ = { invoke: (command, args) => native.__metadataInvoke(command, args) };
    });
    await windowPage.goto("/__metadata-sync");
    await windowPage.evaluate(async () => {
      await import("/src/store/localUserBlocks.ts" as string);
      const metadata = await import("/src/store/accountMetadata.ts" as string) as typeof import("../../src/store/accountMetadata");
      await metadata.initializeAccountMetadata();
    });
  }
  await settings.evaluate(async () => {
    const { localUserBlocksStore } = await import("/src/store/localUserBlocks.ts" as string) as typeof import("../../src/store/localUserBlocks");
    localUserBlocksStore.getState().blockUser("one", { id: "alice", displayName: "Alice", avatar: { label: "A", color: "#647d90" } });
    localUserBlocksStore.getState().setUserMode("one", "alice", "hide");
    const metadata = await import("/src/store/accountMetadata.ts" as string) as typeof import("../../src/store/accountMetadata");
    await metadata.flushAccountMetadata();
  });
  await expect.poll(() => page.evaluate(async () => {
    const { localUserBlocksStore } = await import("/src/store/localUserBlocks.ts" as string) as typeof import("../../src/store/localUserBlocks");
    return localUserBlocksStore.getState().users[0]?.mode;
  })).toBe("hide");
  await page.evaluate(async () => {
    const { localUserBlocksStore } = await import("/src/store/localUserBlocks.ts" as string) as typeof import("../../src/store/localUserBlocks");
    localUserBlocksStore.getState().setUserMode("one", "alice", "mask");
  });
  await expect.poll(() => settings.evaluate(async () => {
    const { localUserBlocksStore } = await import("/src/store/localUserBlocks.ts" as string) as typeof import("../../src/store/localUserBlocks");
    return localUserBlocksStore.getState().users[0]?.mode;
  })).toBe("mask");
  await settings.close();
});

for (const width of [1280, 390]) {
  test(`masked sender tags keep row height when revealing one message or the sender at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const state = telegramStore.getState(), messages = new Map(state.messages);
      const template = messages.get("chat-product")!.find(message => message.senderId === "u-mia")!;
      messages.set("chat-product", [0, 1, 2].map(index => ({
        ...template, id: `blocked-tag-${index}`, renderKey: undefined,
        outgoing: false, senderTag: "Long custom member tag", mediaAlbumId: undefined,
        replyTo: undefined, forwardInfo: undefined, interaction: undefined, isPinned: false,
        content: { kind: "text" as const, text: "Brief message" },
      })));
      telegramStore.setState({ messages });
    });
    await blockMia(page);
    const row = page.locator('[role="log"] [data-message-id="blocked-tag-0"]');
    const shell = row.locator(":scope > .message-bubble-shell");
    await expect(shell).toHaveClass(/is-local-block-concealed/);
    await expect(row.locator(".message-sender-label")).toBeHidden();
    const masked = await row.boundingBox();
    await shell.locator(".local-block-message-reveal").click();
    await expect(shell).not.toHaveClass(/is-local-block-concealed/);
    expect((await row.boundingBox())!.height).toBeCloseTo(masked!.height, 1);
    await page.getByRole("button", { name: /显示 小熊 的连续消息和真实身份/ }).click();
    await expect(row.locator(".message-sender-label")).toBeVisible();
    expect((await row.boundingBox())!.height).toBeCloseTo(masked!.height, 1);
  });
}

test("hide mode persists per user and excludes history, replies and search without reveal controls", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await blockMia(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: /诊断与隐私/ }).click();
  const mode = settings.getByRole("combobox", { name: "Mia Chen 的屏蔽模式" });
  await expect(mode).toHaveValue("mask");
  await mode.selectOption("hide");
  await expect(settings.getByText("完全隐藏此用户的消息", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(page.locator('[role="log"] [data-local-block-group]')).toHaveCount(0);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState(), messages = new Map(state.messages);
    const source = messages.get("chat-product")!;
    const blocked = source.find(message => message.senderId === "u-mia")!;
    const other = source.find(message => !message.outgoing && message.senderId !== "u-mia")!;
    messages.set("chat-product", [blocked, {
      ...other, id: "reply-to-hidden", renderKey: undefined, mediaAlbumId: undefined, forwardInfo: undefined,
      replyTo: { kind: "message", messageId: blocked.id, senderId: blocked.senderId, quote: "Hidden quote" },
      content: { kind: "text", text: "Visible answer" },
    }]);
    telegramStore.setState({ messages });
  });
  await expect(page.locator('[role="log"] .local-block-message-reveal')).toHaveCount(0);
  const reply = await revealVirtualMessage(page, "reply-to-hidden");
  await expect(reply.locator(".message-reply-preview")).toHaveCount(0);
  await page.reload();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[role="log"] [data-local-block-group]')).toHaveCount(0);
  await openConversationMessageSearch(page);
  await page.getByRole("searchbox", { name: "搜索会话和消息" }).fill("desktop-layout-review.pdf");
  await expect(page.locator('.global-search-results[data-search-state="settled"]')).toBeVisible();
  await expect(page.locator('[data-search-message-id="p-3"]')).toHaveCount(0);
});

test("complete hiding also applies to channel discussions and direct messages", async ({ page }) => {
  await page.goto("/");
  await blockMia(page, "hide");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  expect(await page.locator('[role="log"] [data-message-id]').evaluateAll(rows => rows.every(row =>
    row.classList.contains("is-outgoing")))).toBe(true);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
  await expect(page.locator(".channel-discussion-panel")).toBeVisible();
  await expect(page.locator('.channel-discussion-panel [data-message-id="release-comment-1"]')).toHaveCount(0);
  await expect(page.locator('.channel-discussion-panel .local-block-message-reveal')).toHaveCount(0);
});

test("hidden senders cannot reappear through pinned messages or shared files", async ({ page }) => {
  await page.goto("/");
  await blockMia(page, "hide");
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState(), messages = new Map(state.messages);
    messages.set("chat-product", messages.get("chat-product")!.map(message => ({ ...message,
      senderId: message.id === "p-1" ? "u-mia" : message.senderId,
      isPinned: message.id === "p-1" || message.id === "p-2",
    })));
    telegramStore.setState({ messages });
  });
  await page.locator('.pinned-message-banner').getByRole("button", { name: "查看全部置顶消息" }).click();
  const pins = page.getByRole("log", { name: "置顶消息列表" });
  await expect(pins.locator('[data-message-id="p-1"]')).toHaveCount(0);
  await expect(pins.locator('[data-message-id="p-2"]')).toBeVisible();
  await page.getByRole("button", { name: "返回会话", exact: true }).click();
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await profile.getByRole("button", { name: "共享媒体" }).click();
  await profile.getByRole("tab", { name: "文件", exact: true }).click();
  await expect(profile.locator(".shared-media-results")).toHaveAttribute("aria-busy", "false");
  await expect(profile.locator(".shared-media-item")).toHaveCount(0);
  await expect(profile.getByText("research-notes.zip", { exact: true })).toHaveCount(0);
  await expect(profile.getByText("desktop-layout-review.pdf", { exact: true })).toHaveCount(0);
});

test("masked album captions retain their height when the whole sender group is revealed", async ({ page }) => {
  await page.goto("/");
  await blockMia(page);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState(), messages = new Map(state.messages);
    messages.set("chat-product", messages.get("chat-product")!.filter(message => message.mediaAlbumId === "mock-album-product").slice(0, 2)
      .map(message => message.mediaAlbumId === "mock-album-product" &&
      message.content.kind === "media" ? { ...message, content: { ...message.content,
        caption: message.id === "p-tall" ? "One caption for the whole album" : undefined,
      } } : message));
    telegramStore.setState({ messages });
  });
  const target = await revealVirtualMessage(page, "p-tall");
  const album = target.locator("xpath=ancestor::*[contains(@class, 'media-album') and @data-media-album-id]");
  const caption = album.locator(".media-album-caption");
  await expect(caption).toHaveClass(/is-local-block-concealed/);
  const before = await album.boundingBox();
  await page.getByRole("button", { name: /显示 小熊 的连续消息和真实身份/ }).click();
  await expect(caption).not.toHaveClass(/is-local-block-concealed/);
  expect((await album.boundingBox())!.height).toBeCloseTo(before!.height, 1);
});

for (const mixed of [false, true]) {
  test(`blocked reactions never flash a jump button while a read is delayed; mixed=${mixed}`, async ({ page }) => {
    await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `${await response.text()}\n{
        const connect = MockTelegramTransport.prototype.connect;
        MockTelegramTransport.prototype.connect = async function(listener) {
          globalThis.__sendBlockedReaction = () => {
            const base = this.snapshot.messages.find(m => m.chatId === "chat-product");
            const unread = [{senderId:"u-mia",type:{kind:"emoji",emoji:"🔥"}}];
            if (${mixed}) unread.push({senderId:"u-jules",type:{kind:"emoji",emoji:"🔥"}});
            const message = {...base,id:"blocked-unread",renderKey:undefined,outgoing:true,senderId:"self",
              replyTo:undefined,containsUnreadMention:false,containsUnreadReaction:true,unreadReactions:unread,
              interaction:{viewCount:0,forwardCount:0,replyCount:0,reactions:[{
                type:{kind:"emoji",emoji:"🔥"},totalCount:unread.length,chosen:false,recentSenderIds:unread.map(r=>r.senderId)
              }]},content:{kind:"text",text:"Reaction test"}};
            this.snapshot.messages.push(message);
            listener({type:"message.upsert",message});
          };
          return connect.call(this, listener);
        };
        MockTelegramTransport.prototype.markAllChatReactionsRead = async function() {
          globalThis.__blockedReadCalls = (globalThis.__blockedReadCalls || 0)+1;
          await new Promise(resolve => {globalThis.__releaseBlockedRead=resolve});
        };
      }` });
    });
    await page.goto("/");
    await blockMia(page);
    await page.evaluate(() => {
      const state = globalThis as unknown as { __sendBlockedReaction: () => void; __jumpAppearances: number };
      state.__jumpAppearances = 0;
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches(".jump-to-attention") || node.querySelector(".jump-to-attention"))) {
            state.__jumpAppearances += 1;
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
      state.__sendBlockedReaction();
    });
    if (mixed) await expect(page.locator(".jump-to-attention")).toBeVisible();
    else await expect(page.locator(".jump-to-attention")).toHaveCount(0);
    await page.evaluate(() => new Promise<void>(resolve => {
      let frames = 0;
      const sample = () => { if (++frames >= 30) resolve(); else requestAnimationFrame(sample); };
      requestAnimationFrame(sample);
    }));
    const result = await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const state = globalThis as unknown as { __jumpAppearances: number; __blockedReadCalls?: number; __releaseBlockedRead?: () => void };
      const result = { appearances: state.__jumpAppearances, reads: state.__blockedReadCalls ?? 0,
        indexed: telegramStore.getState().unreadAttentionMessageIds.get("chat-product")?.includes("blocked-unread") ?? false };
      state.__releaseBlockedRead?.();
      return result;
    });
    expect(result).toEqual(mixed ? { appearances: 1, reads: 0, indexed: true } : { appearances: 0, reads: 1, indexed: false });
  });
}
