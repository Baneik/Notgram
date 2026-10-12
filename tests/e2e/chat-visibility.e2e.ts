import { expect, test, type Page } from "@playwright/test";
import type { TelegramEventListener } from "../../src/telegram/transport";
import type { Chat, TelegramEvent } from "../../src/telegram/types";
import type { TdObject } from "../../src/telegram/tdlibMapper";

type NativeVisibility = {
  listener: TelegramEventListener;
  upsertChat: (raw: TdObject) => void;
  finishInitialChatSync: (complete?: boolean) => void;
  handleUpdateBatch: (updates: TdObject[]) => void;
};
declare global {
  interface Window {
    __chatVisibilityDispatch: TelegramEventListener;
    __chatVisibilityConnect: () => void;
    __chatVisibilityNative: NativeVisibility;
  }
}

const transportModule = `
import { MockTelegramTransport } from '/src/telegram/mockTransport.ts';
import { mockSnapshot } from '/src/telegram/mockData.ts';
class CachedChatTransport extends MockTelegramTransport {
  constructor() { super({ connectionStatus: 'syncing' }); }
  async loadCachedSnapshot() {
    return await super.loadCachedSnapshot() || {
      ...mockSnapshot, version: 4, savedAt: new Date().toISOString(), activeChatId: 'chat-product',
      chats: [...mockSnapshot.chats, ...[-7, -8, -9].map(id => ({
        ...mockSnapshot.chats[0], id: String(id), title: 'Cached group ' + id,
        folderIds: ['main', 'folder:work'], pinned: false, pinnedFolderIds: [],
        listOrderByFolder: { main: '900', 'folder:work': '800' },
      }))],
    };
  }
  async connect(listener) {
    window.__chatVisibilityDispatch = listener;
    await new Promise(resolve => { window.__chatVisibilityConnect = resolve; });
    return super.connect(listener);
  }
}
export const createTelegramTransport = () => new CachedChatTransport();
`;
const row = (page: Page, id: string, folder = "main") =>
  page.locator(`.chat-list[data-folder-id="${folder}"] .chat-row[data-chat-id="${id}"]`);
const dispatch = (page: Page, event: TelegramEvent) => page.evaluate(event => window.__chatVisibilityDispatch(event), event);

for (const width of [1366, 390]) {
  test(`cached removed groups disappear at sync completion and stay hidden after restart at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.route(/\/src\/telegram\/createTransport\.ts(?:\?.*)?$/, route => route.fulfill({
      contentType: "application/javascript", body: transportModule,
    }));
    await page.goto("/");
    for (const id of ["-7", "-8", "-9"]) await expect(row(page, id)).toHaveCount(1);
    await dispatch(page, { type: "chats.upserted", chats: [] });
    await dispatch(page, { type: "sync.error", message: "OFFLINE" });
    await expect(row(page, "-7")).toHaveCount(1);
    await page.evaluate(() => window.__chatVisibilityConnect());
    await expect.poll(() => page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      return telegramStore.getState().phase;
    })).toBe("ready");
    await page.evaluate(async () => {
      const { TauriTelegramTransport } = await import("/src/telegram/tauriTransport.ts" as string) as typeof import("../../src/telegram/tauriTransport");
      const native = new TauriTelegramTransport() as unknown as NativeVisibility;
      window.__chatVisibilityNative = native;
      native.listener = window.__chatVisibilityDispatch;
      for (const id of [-7, -9]) native.upsertChat({ id, title: "Cached group " + id,
        type: { "@type": "chatTypeSupergroup", supergroup_id: -id },
        chat_lists: [{ "@type": "chatListMain" }],
        positions: id === -9 ? [{ list: { "@type": "chatListMain" }, order: "900" }] : [],
      });
      native.finishInitialChatSync(true);
    });
    for (const folder of ["main", "folder:work"]) {
      await expect(row(page, "-7", folder)).toHaveCount(0);
      await expect(row(page, "-8", folder)).toHaveCount(0);
    }
    await expect(row(page, "-9")).toHaveCount(1);
    if (width === 1366) {
      await row(page, "-9").click({ button: "right" });
      await expect(page.getByRole("menu", { name: "会话操作：Cached group -9", exact: true })).toBeVisible();
    }
    await page.evaluate(() => window.__chatVisibilityNative.handleUpdateBatch([
      { "@type": "updateChatPosition", chat_id: -9, position: { list: { "@type": "chatListMain" }, order: "0" } },
      { "@type": "updateChatTitle", chat_id: -9, title: "Left group" },
    ]));
    await expect(row(page, "-9")).toHaveCount(0);
    await expect(page.getByRole("menu", { name: /^会话操作：/ })).toHaveCount(0);
    await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      await telegramStore.getState().rebuildCachedSnapshot();
    });
    await page.reload();
    for (const id of ["-7", "-8", "-9"]) await expect(row(page, id)).toHaveCount(0);
    await page.evaluate(() => window.__chatVisibilityConnect());
    const chat: Chat = await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      return { ...telegramStore.getState().chats.get("-8")!, visibleFolderIds: ["main"] };
    });
    await dispatch(page, { type: "chat.upsert", chat });
    await expect(row(page, "-8")).toHaveCount(1);
  });
}
