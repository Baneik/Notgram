import { expect, test, type Page } from "@playwright/test";

const panel = (page: Page, id: string) => page.locator(`.chat-list[data-folder-id="${id}"]`);
const selectFolder = (page: Page, id: string) => page.locator(`.rail-actions [data-folder-id="${id}"]`).click();

async function seedFolders(page: Page) {
  await page.setViewportSize({ width: 1080, height: 700 });
  await page.goto("/");
  await expect(panel(page, "folder:work")).toHaveAttribute("inert", "");
  await expect(panel(page, "archive")).toHaveAttribute("inert", "");
  await page.evaluate(async () => {
    const { telegramStore: store } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const state = store.getState();
    const sample = state.chats.get("chat-product")!;
    const chats = new Map(state.chats);
    for (const folderId of ["folder:alpha", "folder:beta"]) {
      for (let index = 0; index < 45; index++) {
        const id = index === 0 ? "qa-shared" : `${folderId}-${index}`;
        chats.set(id, {
          ...sample, id, title: id, unreadCount: 0,
          folderIds: index === 0 ? ["folder:alpha", "folder:beta"] : [folderId],
          pinnedFolderIds: ["folder:alpha", "folder:beta"],
          listOrderByFolder: { "folder:alpha": String(1000 - index), "folder:beta": String(1000 - index) },
          avatar: { ...sample.avatar, fileId: undefined, imagePath: `/mock-video-poster.jpg?sidebar=${id}` },
        });
      }
    }
    const folders = [...state.folders,
      { id: "folder:alpha", title: "QA Alpha", iconName: "Custom" },
      { id: "folder:beta", title: "QA Beta", iconName: "Custom" },
    ];
    store.setState({ chats, folders, connectionStatus: "offline",
      chatLists: new Map(folders.map((folder) => [folder.id, { loading: false, hasMore: false }])),
    });
  });
  await expect(panel(page, "folder:alpha").locator(".chat-row")).toHaveCount(45);
  await expect(panel(page, "folder:beta").locator(".chat-row")).toHaveCount(45);
}

for (const evictReadiness of [false, true]) {
  test(`unvisited folders decode avatars and preserve nodes through switches and search (evict=${evictReadiness})`, async ({ page }) => {
    await seedFolders(page);
    for (const id of ["folder:alpha", "folder:beta"]) {
      await expect(panel(page, id)).toHaveAttribute("data-active", "false");
      await expect(panel(page, id).locator(".chat-row").first().locator("img")).toHaveAttribute("data-image-state", "ready");
      await expect.poll(() => panel(page, id).locator("img").evaluateAll((images) => images.every((image) =>
        image.getAttribute("data-image-state") === "ready" && getComputedStyle(image).opacity === "1"))).toBe(true);
      expect(await panel(page, id).locator("img").count()).toBeLessThan(45);
    }
    const first = await panel(page, "folder:alpha").locator(".chat-row").first().elementHandle();
    const failures = await page.evaluate(async (evict) => {
      const { forgetDecodedImage } = await import("/src/media/decodedImages.ts" as string) as typeof import("../../src/media/decodedImages");
      const originals = ["folder:alpha", "folder:beta"].map((id) => {
        const list = document.querySelector<HTMLElement>(`.chat-list[data-folder-id="${id}"]`)!;
        const rows = [...list.querySelectorAll(".chat-row")];
        const images = [...list.querySelectorAll<HTMLImageElement>("img")];
        return { id, list, rows, images };
      });
      const failures: string[] = [];
      for (const id of ["folder:alpha", "folder:beta", "main", "folder:beta", "folder:alpha"]) {
        if (evict) originals.forEach(({ images }) => images.forEach((image) => forgetDecodedImage(image.currentSrc)));
        document.querySelector<HTMLButtonElement>(`.rail-actions [data-folder-id="${id}"]`)!.click();
        for (let frame = 0; frame < 5; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          if (document.querySelectorAll('.chat-list[data-active="true"]').length !== 1) failures.push("multiple active panels");
          for (const original of originals) {
            const list = document.querySelector(`.chat-list[data-folder-id="${original.id}"]`);
            const rows = [...list!.querySelectorAll(".chat-row")];
            if (list !== original.list || rows.some((row, index) => row !== original.rows[index])) failures.push("remounted rows");
            if (original.images.some((image) => !image.isConnected || image.dataset.imageState !== "ready" || getComputedStyle(image).opacity !== "1")) {
              failures.push(`avatar flash in ${id} frame ${frame}`);
            }
          }
        }
      }
      return failures;
    }, evictReadiness);
    expect(failures).toEqual([]);
    await expect(panel(page, "main")).toHaveCount(0);
    await page.getByPlaceholder("搜索会话和消息").fill("qa");
    await expect(page.locator('.chat-list[data-active="true"]')).toHaveCount(0);
    await expect(panel(page, "folder:alpha")).toHaveCount(1);
    await page.getByPlaceholder("搜索会话和消息").fill("");
    expect(await first!.evaluate((row) => row.isConnected && row === document.querySelector('.chat-list[data-active="true"] .chat-row'))).toBe(true);
  });
}

test("wheel, keyboard and late scroll events stay inside their folder", async ({ page }) => {
  await seedFolders(page);
  await selectFolder(page, "folder:alpha");
  await panel(page, "folder:alpha").evaluate((list) => { list.scrollTop = 350; });
  await selectFolder(page, "folder:beta");
  await panel(page, "folder:beta").evaluate((list) => { list.scrollTop = 180; });
  await selectFolder(page, "folder:alpha");
  await expect.poll(() => panel(page, "folder:alpha").evaluate((list) => list.scrollTop)).toBe(350);
  await panel(page, "folder:alpha").hover();
  await page.mouse.wheel(0, 220);
  await expect.poll(() => panel(page, "folder:alpha").evaluate((list) => list.scrollTop)).toBeGreaterThan(350);
  expect(await panel(page, "folder:beta").evaluate((list) => list.scrollTop)).toBe(180);
  await panel(page, "folder:alpha").locator(".chat-row").nth(10).focus();
  const beforeKey = await panel(page, "folder:alpha").evaluate((list) => list.scrollTop);
  await page.keyboard.press("PageDown");
  await expect.poll(() => panel(page, "folder:alpha").evaluate((list) => list.scrollTop)).toBeGreaterThan(beforeKey);
  expect(await panel(page, "folder:beta").evaluate((list) => list.scrollTop)).toBe(180);
  await panel(page, "folder:alpha").evaluate((list) => { list.scrollTop = list.scrollHeight; });
  await panel(page, "folder:alpha").hover();
  await page.mouse.wheel(0, 900);
  await expect(panel(page, "folder:alpha")).toHaveAttribute("data-active", "true");
  expect(await page.locator(".sidebar-list-stack").evaluate((stack) => stack.scrollTop)).toBe(0);
  expect(await panel(page, "folder:beta").evaluate((list) => list.scrollTop)).toBe(180);
  const hiddenResult = await panel(page, "folder:beta").evaluate(async (list) => {
    const { telegramStore: store } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const before = store.getState().activeChatId;
    const row = list.querySelector<HTMLButtonElement>(".chat-row")!;
    row.focus(); row.click(); row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { selected: store.getState().activeChatId === before, focusOutside: !list.contains(document.activeElement) };
  });
  expect(hiddenResult).toEqual({ selected: true, focusOutside: true });
});

test("hidden panels never paginate and an in-flight page keeps its folder owner", async ({ page }) => {
  await seedFolders(page);
  await page.evaluate(async () => {
    const { telegramStore: store } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const calls: string[] = [];
    Object.assign(window, { sidebarCalls: calls });
    const lists = new Map(store.getState().chatLists);
    for (const id of ["folder:alpha", "folder:beta"]) lists.set(id, { loading: false, hasMore: true });
    store.setState({ chatLists: lists, loadMoreChats: async (id = "main") => {
      calls.push(id);
      store.setState({ chatLists: new Map(store.getState().chatLists).set(id, { loading: true, hasMore: true }) });
      await new Promise<void>((resolve) => { Object.assign(window, { sidebarRelease: resolve }); });
      store.setState({ chatLists: new Map(store.getState().chatLists).set(id, { loading: false, hasMore: false }) });
    } });
  });
  await panel(page, "folder:beta").evaluate((list) => { list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event("scroll")); });
  expect(await page.evaluate(() => (window as unknown as { sidebarCalls: string[] }).sidebarCalls)).toEqual([]);
  await selectFolder(page, "folder:alpha");
  await panel(page, "folder:alpha").evaluate((list) => { list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event("scroll")); });
  await expect.poll(() => page.evaluate(() => (window as unknown as { sidebarCalls: string[] }).sidebarCalls)).toEqual(["folder:alpha"]);
  // Reset the hidden test's synthetic offset so activating beta is not a genuine pagination intent.
  await panel(page, "folder:beta").evaluate((list) => { list.scrollTop = 0; });
  await selectFolder(page, "folder:beta");
  await page.evaluate(() => (window as unknown as { sidebarRelease: () => void }).sidebarRelease());
  await expect.poll(() => page.evaluate(async () => {
    const { telegramStore: store } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    return [...store.getState().chatLists].filter(([id]) => id === "folder:alpha" || id === "folder:beta");
  })).toEqual([["folder:alpha", { loading: false, hasMore: false }], ["folder:beta", { loading: false, hasMore: true }]]);
  expect(await page.evaluate(() => (window as unknown as { sidebarCalls: string[] }).sidebarCalls)).toEqual(["folder:alpha"]);
});

test("startup warms one page per folder with bounded requests and resumes after reconnect", async ({ page }) => {
  await seedFolders(page);
  await page.evaluate(async () => {
    const { telegramStore: store } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const calls: string[] = [];
    const releases: Record<string, () => void> = {};
    Object.assign(window, { sidebarCalls: calls, sidebarReleases: releases });
    store.setState({ folders: [...store.getState().folders, ...[0, 1, 2, 3].map((i) => ({ id: `folder:warm-${i}`, title: `Warm ${i}`, iconName: "Custom" }))],
      loadMoreChats: async (id = "main") => {
        calls.push(id);
        store.setState({ chatLists: new Map(store.getState().chatLists).set(id, { loading: true, hasMore: true }) });
        await new Promise<void>((resolve) => { releases[id] = resolve; });
        store.setState({ chatLists: new Map(store.getState().chatLists).set(id, { loading: false, hasMore: true }) });
      },
    });
  });
  await expect(panel(page, "folder:warm-3")).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { sidebarCalls: string[] }).sidebarCalls)).toEqual([]);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    telegramStore.setState({ connectionStatus: "online" });
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { sidebarCalls: string[] }).sidebarCalls.length)).toBe(2);
  await page.evaluate(() => (window as unknown as { sidebarReleases: Record<string, () => void> }).sidebarReleases["folder:warm-0"]());
  await expect.poll(() => page.evaluate(() => (window as unknown as { sidebarCalls: string[] }).sidebarCalls.length)).toBe(3);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    telegramStore.setState({ folders: telegramStore.getState().folders.filter((folder) => folder.id !== "folder:warm-3") });
    const releases = (window as unknown as { sidebarReleases: Record<string, () => void> }).sidebarReleases;
    releases["folder:warm-1"](); releases["folder:warm-2"]();
  });
  await expect(panel(page, "folder:warm-3")).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    return [...telegramStore.getState().chatLists.values()].filter((list) => list.loading).length;
  })).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { sidebarCalls: string[] }).sidebarCalls)).toEqual(["folder:warm-0", "folder:warm-1", "folder:warm-2"]);
});

test("switching folders cancels captured pin drags and closes their menus", async ({ page }) => {
  await seedFolders(page);
  await selectFolder(page, "folder:alpha");
  const source = panel(page, "folder:alpha").locator(".chat-row").first();
  const bounds = (await source.boundingBox())!;
  await page.mouse.move(bounds.x + 30, bounds.y + 25);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 30, bounds.y + bounds.height + 20, { steps: 5 });
  await expect(source).toHaveAttribute("aria-grabbed", "true");
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    telegramStore.setState({ chatFilter: "folder:beta" });
  });
  await expect(source).toHaveAttribute("aria-grabbed", "false");
  await expect(page.locator("html")).not.toHaveClass(/is-reordering-pinned/);
  await page.mouse.up();
  await expect(panel(page, "folder:alpha").locator(".chat-row").first()).toHaveAttribute("data-chat-id", "qa-shared");
  await panel(page, "folder:beta").locator(".chat-row").first().click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await selectFolder(page, "folder:alpha");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("account changes discard every old panel and its local state", async ({ page }) => {
  await seedFolders(page);
  const oldPanel = await panel(page, "folder:work").elementHandle();
  const customPanel = await panel(page, "folder:alpha").elementHandle();
  await selectFolder(page, "folder:alpha");
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    await telegramStore.getState().switchAccount("account-secondary");
  });
  await expect.poll(() => oldPanel!.evaluate((list) => list.isConnected)).toBe(false);
  expect(await customPanel!.evaluate((list) => list.isConnected)).toBe(false);
  await expect(panel(page, "folder:alpha")).toHaveCount(0);
});

test("hidden folders download only nearby avatars and visible scrolling loads the rest", async ({ page }) => {
  await seedFolders(page);
  await page.evaluate(async () => {
    const { telegramStore: store } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const calls: { fileId: number; priority?: number }[] = [];
    Object.assign(window, { avatarRequests: calls });
    const chats = new Map(store.getState().chats);
    for (const chat of chats.values()) {
      if (chat.id !== "qa-shared" && !chat.id.startsWith("folder:alpha-") && !chat.id.startsWith("folder:beta-")) continue;
      const index = chat.id === "qa-shared" ? 0 : Number(chat.id.split("-").at(-1));
      const fileId = (chat.id.startsWith("folder:beta") ? 2000 : 1000) + index;
      chats.set(chat.id, { ...chat, avatar: { ...chat.avatar, imagePath: undefined, fileId, canDownload: true, isDownloading: false } });
    }
    store.setState({ chats, cacheFile: async (fileId, priority) => {
      calls.push({ fileId, priority });
      await new Promise<void>(() => undefined);
    } });
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    avatarRequests: { fileId: number }[];
  }).avatarRequests.length)).toBeGreaterThan(0);
  const background = await page.evaluate(() => (window as unknown as {
    avatarRequests: { fileId: number; priority: number }[];
  }).avatarRequests);
  expect(new Set(background.map((request) => request.fileId)).size).toBeLessThan(45);
  expect(background.every((request) => request.priority === 4)).toBe(true);
  expect(background.some((request) => request.fileId === 1000)).toBe(true);
  expect(background.some((request) => request.fileId === 1044 || request.fileId === 2044)).toBe(false);
  await selectFolder(page, "folder:alpha");
  await panel(page, "folder:alpha").locator(".chat-row").last().scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    avatarRequests: { fileId: number }[];
  }).avatarRequests.some((request) => request.fileId === 1044))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as {
    avatarRequests: { fileId: number }[];
  }).avatarRequests.some((request) => request.fileId === 2044))).toBe(false);
});

test("hidden reorders update rows without running animations on reveal", async ({ page }) => {
  await seedFolders(page);
  await selectFolder(page, "folder:alpha");
  await selectFolder(page, "folder:beta");
  await page.evaluate(async () => {
    const { telegramStore: store } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const animations: string[] = [];
    Object.assign(window, { sidebarAnimations: animations });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...parameters) {
      if (this.matches(".chat-row")) animations.push(this.closest<HTMLElement>(".chat-list")!.dataset.folderId!);
      return animate.apply(this, parameters);
    };
    const chats = new Map(store.getState().chats);
    const chat = chats.get("folder:alpha-3")!;
    chats.set(chat.id, { ...chat, title: "Updated while hidden", listOrderByFolder: { "folder:alpha": "9000" } });
    store.setState({ chats });
  });
  await expect(panel(page, "folder:alpha").locator(".chat-row").first()).toHaveAttribute("data-chat-id", "folder:alpha-3");
  await selectFolder(page, "folder:alpha");
  await expect(panel(page, "folder:alpha").locator(".chat-row").first()).toContainText("Updated while hidden");
  expect(await page.evaluate(() => (window as unknown as { sidebarAnimations: string[] }).sidebarAnimations)).toEqual([]);
});
