import { expect, test, type Page } from "@playwright/test";

const paragraph = "本次更新新增 Windows 多点触控支持，改进桌面窗口交互，并为折叠标题布局增加内容内边距支持，同时提供可独立交互的开关组件。";
const code = `commonMain.dependencies {\n    implementation("example:${"long_dependency_name".repeat(12)}")\n\n    // Optional integration\n    implementation("example:navigation:3.0.0-beta02")\n}`;

async function showRichPost(page: Page, reactions: boolean) {
  await page.evaluate(async ({ paragraph, code, reactions }) => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const { mapTdMessageContent } = await (0, eval)('import("/src/telegram/tdlibMapper.ts")') as typeof import("../../src/telegram/tdlibMapper");
    const state = telegramStore.getState();
    const source = state.messages.get("chat-release")!.find(message => message.id === "release-post-1")!;
    const plain = (text: string) => ({ "@type": "richTextPlain", text });
    const blocks = [
      { "@type": "pageBlockParagraph", text: plain(paragraph) },
      { "@type": "pageBlockBlockQuote", blocks: [
        { "@type": "pageBlockParagraph", text: { "@type": "richTexts", texts: [
          plain("稳定版发布前，标记为 "),
          { "@type": "richTextFixed", text: plain("@UnstableApi") },
          plain(" 的 API 仍可能调整。"),
        ] } },
      ] },
      { "@type": "pageBlockSectionHeading", size: 2, text: plain("安装") },
      { "@type": "pageBlockPreformatted", language: "kotlin", text: plain(code) },
      { "@type": "pageBlockSectionHeading", size: 2, text: plain("兼容性") },
      { "@type": "pageBlockList", items: ["Kotlin", "Compose Multiplatform", "Jetpack Compose", "Android"].map(name => ({
        "@type": "pageBlockListItem", label: "•", blocks: [
          { "@type": "pageBlockParagraph", text: plain(`${name}：支持当前版本`) },
        ],
      })) },
      ...Array.from({ length: 6 }, (_, index) => [
        { "@type": "pageBlockSectionHeading", size: 3, text: plain(`更新 ${index + 1}`) },
        { "@type": "pageBlockParagraph", text: plain(paragraph) },
      ]).flat(),
    ];
    telegramStore.setState({ messages: new Map(state.messages).set(source.chatId, [{
      ...source, id: "channel-rich-layout", replyTo: undefined, editedAt: undefined,
      content: mapTdMessageContent({ "@type": "messageRichMessage", message: {
        "@type": "richMessage", is_full: true, is_rtl: false, blocks,
      } }),
      interaction: { viewCount: 200, forwardCount: 0, replyCount: 0, reactions: reactions
        ? [{ type: { kind: "emoji", emoji: "🎉" }, totalCount: 33, chosen: false, recentSenderIds: [] }] : [] },
    }]) });
  }, { paragraph, code, reactions });
}

for (const scenario of [
  { name: "desktop", width: 1366, theme: "notgram-light", scale: 100 },
  { name: "screenshot-width", width: 574, theme: "notgram-light", scale: 100 },
  { name: "narrow-dark", width: 390, theme: "notgram-dark", scale: 100 },
  { name: "narrow-dark-zoom", width: 390, theme: "notgram-dark", scale: 125 },
] as const) {
  for (const reactions of [false, true]) {
    test(`channel rich blocks preserve content insets (${scenario.name}, reactions=${reactions})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: scenario.width, height: 900 });
      await page.goto("/");
      await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
      await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
      await page.evaluate(async ({ theme, scale }) => {
        const { preferencesStore } = await (0, eval)('import("/src/store/preferencesStore.ts")') as typeof import("../../src/store/preferencesStore");
        preferencesStore.getState().setPreference("themeId", theme);
        preferencesStore.getState().setPreference("interfaceScale", scale);
      }, scenario);
      await showRichPost(page, reactions);
      const row = page.locator('[data-message-id="channel-rich-layout"]');
      const rich = row.locator(".rich-message-content");
      await expect(rich).toHaveCount(1);
      await expect(page.locator(".conversation-switch-snapshot")).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);

      const geometry = await rich.evaluate(element => {
        const bubble = element.closest<HTMLElement>(".message-bubble")!;
        const bounds = bubble.getBoundingClientRect();
        const scale = bounds.width / bubble.offsetWidth;
        const first = element.firstElementChild!.getBoundingClientRect();
        const last = element.lastElementChild!.getBoundingClientRect();
        const sender = bubble.querySelector<HTMLElement>(".message-sender")!.getBoundingClientRect();
        const blocks = [...element.children].map(block => block.getBoundingClientRect());
        return {
          inset: Number.parseFloat(getComputedStyle(bubble).getPropertyValue("--channel-post-inline-padding")),
          leftInset: (first.left - bounds.left) / scale,
          rightInset: (bounds.right - first.right) / scale,
          senderAlignment: (first.left - sender.left) / scale,
          bottomInset: (element.getBoundingClientRect().bottom - last.bottom) / scale,
          blocksContained: blocks.every(block => block.left >= first.left - 0.5 && block.right <= first.right + 0.5),
          overflow: element.scrollWidth - element.clientWidth,
          viewportContained: bounds.left >= 0 && bounds.right <= innerWidth + 0.5,
        };
      });
      expect(geometry.leftInset).toBeCloseTo(geometry.inset + 1, 0);
      expect(geometry.rightInset).toBeCloseTo(geometry.inset + 1, 0);
      expect(geometry.senderAlignment).toBeCloseTo(0, 1);
      expect(geometry.bottomInset).toBeCloseTo(10, 1);
      expect(geometry.blocksContained).toBe(true);
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.viewportContained).toBe(true);
      expect(await rich.locator("code.rich-pre").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

      await rich.locator("p").first().scrollIntoViewIfNeeded();
      await expect(rich.locator("p").first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("rich-post-top.png") });
      await row.locator(".message-meta").scrollIntoViewIfNeeded();
      await expect(row.locator(".message-meta")).toBeVisible();
      await expect(row.locator(".message-reactions")).toHaveCount(reactions ? 1 : 0);
      await page.screenshot({ path: testInfo.outputPath("rich-post-footer.png") });
    });
  }
}
