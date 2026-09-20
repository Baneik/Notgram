import { expect, test, type Page } from "@playwright/test";

async function prepareDraftEcho(page: Page, delayed = false) {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async delay => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const { MockTelegramTransport } = await (0, eval)('import("/src/telegram/mockTransport.ts")') as typeof import("../../src/telegram/mockTransport");
    const { mapTdFormattedText } = await (0, eval)('import("/src/telegram/tdlibMapper.ts")') as typeof import("../../src/telegram/tdlibMapper");
    const { formattedTextObject } = await (0, eval)('import("/src/telegram/tdlibRequests.ts")') as typeof import("../../src/telegram/tdlibRequests");
    const state = telegramStore.getState();
    const user = { ...state.users.get("u-mia")!, id: "11" };
    telegramStore.setState({
      users: new Map(state.users).set(user.id, user),
      getChatMentionSuggestions: async () => [user],
    });
    const original = MockTelegramTransport.prototype.setChatDraft;
    MockTelegramTransport.prototype.setChatDraft = async function (input) {
      if (delay) {
        document.body.dataset.heldDraft = input.text;
        await new Promise<void>(resolve => Reflect.set(window, "releaseDraftEcho", resolve));
      }
      // The regular mock echoes the same objects; native TDLib maps entities anew.
      await original.call(this, { ...input, ...mapTdFormattedText(formattedTextObject(input.text, input.entities)) });
      document.body.dataset.echoedDraft = input.text;
    };
  }, delayed);

  await page.getByRole("textbox", { name: "消息内容" }).evaluate(element => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), character => character.charCodeAt(0));
    data.items.add(new File([bytes], "draft-image.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect(page.getByRole("region", { name: "待发送附件" })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    return telegramStore.getState().localAttachmentDrafts.has("chat-product");
  })).toBe(true);
}

async function savedDraft(page: Page) {
  return page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    return {
      draft: state.drafts.get("chat-product"),
      attachments: (await state.loadLocalAttachmentDraft("chat-product")).map(attachment => attachment.file.name),
    };
  });
}

for (const format of ["mention", "bold"] as const) {
  test(`pasted images survive typing after a ${format} and native draft echoes`, async ({ page }) => {
    await prepareDraftEcho(page);
    const composer = page.getByRole("textbox", { name: "消息内容" });
    if (format === "mention") {
      await composer.fill("@mia");
      await page.locator('[data-mention-user-id="11"]').click();
    } else {
      await composer.fill("caption");
      await composer.press("Control+a");
      await composer.press("Control+Shift+b");
      await composer.press("ArrowRight");
    }
    await page.keyboard.insertText("x");
    const text = await composer.evaluate(element => Reflect.get(element, "value") as string);
    await expect(page.locator("body")).toHaveAttribute("data-echoed-draft", text);
    const preview = page.getByRole("region", { name: "待发送附件" });
    await expect(preview).toBeVisible();
    await expect.poll(() => savedDraft(page)).toMatchObject({
      draft: { text, pending: false, entities: [expect.objectContaining({ kind: format === "mention" ? "mentionName" : "bold" })] },
      attachments: ["draft-image.png"],
    });
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    await expect(composer).toHaveJSProperty("value", text);
    await expect(preview.getByRole("button", { name: "预览 draft-image.png" })).toBeVisible();
    await preview.getByRole("button", { name: "移除 draft-image.png" }).click();
    await expect(preview).toHaveCount(0);
    await expect.poll(() => savedDraft(page)).toMatchObject({ draft: { text }, attachments: [] });
  });
}

test("a delayed old draft echo preserves the newer caption and pasted image", async ({ page }) => {
  await prepareDraftEcho(page, true);
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("old caption");
  await expect(page.locator("body")).toHaveAttribute("data-held-draft", "old caption");
  await composer.fill("new caption");
  await expect.poll(() => savedDraft(page)).toMatchObject({ draft: { text: "new caption", pending: true } });
  await page.evaluate(() => Reflect.get(window, "releaseDraftEcho")());
  await expect(page.locator("body")).toHaveAttribute("data-echoed-draft", "old caption");
  await expect(page.locator("body")).toHaveAttribute("data-held-draft", "new caption");
  await expect(page.getByRole("region", { name: "待发送附件" })).toBeVisible();
  await expect(composer).toHaveJSProperty("value", "new caption");
  await page.evaluate(() => Reflect.get(window, "releaseDraftEcho")());
  await expect.poll(() => savedDraft(page)).toMatchObject({
    draft: { text: "new caption", pending: false }, attachments: ["draft-image.png"],
  });
});
