import { expect, test, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

const horizontalOverflow = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>("body *")].some((element) => {
    if (element.closest(".rail-actions")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && (bounds.left < -1 || bounds.right > innerWidth + 1);
  }));

const revealVirtualMessage = async (page: Page, messageId: string) => {
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await messageList.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -1,
    }));
  });
  await expect.poll(() => messageList.evaluate((element, targetId) => {
    const target = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((row) => row.dataset.messageId === targetId);
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "auto" });
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      return true;
    }
    element.scrollTop = Math.max(0, element.scrollTop - Math.max(320, element.clientHeight * 0.75));
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    return false;
  }, messageId)).toBe(true);
  const row = page.locator(`[data-message-id="${messageId}"]`);
  await expect(row).toBeVisible();
  return row;
};

const waitForStableFrame = async (page: Page) => {
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0);
  await expect(page.locator('.motion-presence[data-motion-state="exiting"]')).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect.poll(() => page.locator(".stable-image").evaluateAll((images) => {
    const visible = images.filter((image) => {
      const bounds = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      return bounds.width > 0 && bounds.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    return visible.length === 0 || visible.every((element) => {
      const image = element as HTMLImageElement;
      return image.dataset.imageState === "ready" || (image.complete && image.naturalWidth === 0);
    });
  })).toBe(true);
};

test("async feedback suppresses short flashes and holds visible loading feedback", async ({ page }) => {
  await page.goto("/");
  const search = page.getByPlaceholder("搜索会话和消息");
  const loading = page.locator('[aria-label="正在搜索"]');
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { globalSearch: Record<string, unknown> };
        setState: (state: { globalSearch: Record<string, unknown> }) => void;
      };
    };
    const runtime = globalThis as typeof globalThis & {
      __motionLoadingMounted?: () => boolean;
      __settleMotionSearch?: (query: string) => void;
    };
    runtime.__settleMotionSearch = (query) => module.telegramStore.setState({
      globalSearch: {
        ...module.telegramStore.getState().globalSearch,
        query,
        filter: "all",
        chats: [],
        messages: [],
        totalCount: 0,
        nextOffset: undefined,
        loading: false,
        error: undefined,
      },
    });
    let loadingMounted = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector('[aria-label="正在搜索"]')) loadingMounted = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    runtime.__motionLoadingMounted = () => loadingMounted;
  }, "/src/store/telegramStore.ts");
  const settleSearch = (query: string) => page.evaluate((searchQuery) => (
    globalThis as typeof globalThis & { __settleMotionSearch?: (value: string) => void }
  ).__settleMotionSearch?.(searchQuery), query);

  const quickQuery = "motion-quick-result";
  await page.evaluate((query) => {
    const input = document.querySelector<HTMLInputElement>('input[placeholder="搜索会话和消息"]');
    if (!input) throw new Error("Search input is unavailable");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    globalThis.setTimeout(() => (
      globalThis as typeof globalThis & { __settleMotionSearch?: (value: string) => void }
    ).__settleMotionSearch?.(query), 40);
  }, quickQuery);
  await page.waitForTimeout(220);
  expect(await loading.count()).toBe(0);
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & { __motionLoadingMounted?: () => boolean }
  ).__motionLoadingMounted?.())).toBe(false);
  await expect(page.getByText("没有搜索结果", { exact: true })).toBeVisible();

  const longQuery = "motion-long-result";
  await search.fill(longQuery);
  await expect(loading).toBeVisible({ timeout: 400 });
  await settleSearch(longQuery);

  await page.waitForTimeout(150);
  await expect(loading).toBeVisible();
  await expect(page.getByText("没有搜索结果", { exact: true })).toBeVisible({ timeout: 700 });
  await expect(loading).toHaveCount(0);
});

test("mobile conversation handoff keeps only the active layer interactive", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/");

  const sidebar = page.locator(".chat-sidebar");
  const conversation = page.locator(".conversation").first();
  await page.locator(".chat-row").first().click();
  await expect(page.locator(".app-shell")).toHaveClass(/mobile-chat-open/);
  await expect.poll(() => sidebar.evaluate((element) => {
    const node = element as HTMLElement & { inert?: boolean };
    return { inert: node.inert === true, opacity: getComputedStyle(element).opacity };
  })).toEqual({ inert: true, opacity: "0" });
  await expect.poll(() => conversation.evaluate((element) => {
    const node = element as HTMLElement & { inert?: boolean };
    return { inert: node.inert === true, opacity: getComputedStyle(element).opacity };
  })).toEqual({ inert: false, opacity: "1" });
  await expect(page.getByRole("button", { name: "返回会话列表" })).toBeFocused();

  await page.getByRole("button", { name: "返回会话列表" }).click();
  await expect(page.locator(".app-shell")).not.toHaveClass(/mobile-chat-open/);
  await expect.poll(() => sidebar.evaluate((element) => {
    const node = element as HTMLElement & { inert?: boolean };
    return { inert: node.inert === true, opacity: getComputedStyle(element).opacity };
  })).toEqual({ inert: false, opacity: "1" });
  await expect.poll(() => conversation.evaluate((element) => {
    const node = element as HTMLElement & { inert?: boolean };
    return { inert: node.inert === true, opacity: getComputedStyle(element).opacity };
  })).toEqual({ inert: true, opacity: "0" });
  await expect(page.locator(".chat-row").first()).toBeFocused();
});

test("mobile settings handoff preserves layers and restores focus", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 600, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();

  const categories = page.locator(".settings-categories");
  const detail = page.locator(".settings-detail");
  const accountCategory = page.getByRole("button", { name: "我的账号" });
  await expect.poll(() => detail.evaluate((element) => ({
    inert: (element as HTMLElement & { inert?: boolean }).inert === true,
    opacity: getComputedStyle(element).opacity,
  }))).toEqual({ inert: true, opacity: "0" });

  await accountCategory.click();
  await expect.poll(() => categories.evaluate((element) => ({
    inert: (element as HTMLElement & { inert?: boolean }).inert === true,
    opacity: getComputedStyle(element).opacity,
  }))).toEqual({ inert: true, opacity: "0" });
  await expect.poll(() => detail.evaluate((element) => ({
    inert: (element as HTMLElement & { inert?: boolean }).inert === true,
    opacity: getComputedStyle(element).opacity,
  }))).toEqual({ inert: false, opacity: "1" });
  const back = page.getByRole("button", { name: "返回设置分类" });
  await expect(back).toBeFocused();

  await back.click();
  await expect.poll(() => categories.evaluate((element) => ({
    inert: (element as HTMLElement & { inert?: boolean }).inert === true,
    opacity: getComputedStyle(element).opacity,
  }))).toEqual({ inert: false, opacity: "1" });
  await expect(accountCategory).toBeFocused();
});

test("images remain hidden until their current source finishes decoding", async ({ page }) => {
  await page.addInitScript(() => {
    let released = false;
    const pending: Array<() => void> = [];
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value() {
        if (released) return Promise.resolve();
        return new Promise<void>((resolve) => pending.push(resolve));
      },
    });
    (globalThis as typeof globalThis & { __releaseImageDecode?: () => void }).__releaseImageDecode = () => {
      released = true;
      pending.splice(0).forEach((resolve) => resolve());
    };
  });
  await page.goto("/");

  const image = page.locator(".stable-image").first();
  await expect(image).toHaveAttribute("data-image-state", "decoding");
  await expect(image).toHaveCSS("opacity", "0");
  await page.evaluate(() => (
    globalThis as typeof globalThis & { __releaseImageDecode?: () => void }
  ).__releaseImageDecode?.());
  await expect(image).toHaveAttribute("data-image-state", "ready");
  await expect(image).toHaveCSS("opacity", "1");
});

for (const evictReadiness of [false, true]) {
  test(`folder switches preserve shared rows and avatars with ${evictReadiness ? "evicted" : "cached"} image readiness`, async ({ page }) => {
    await page.setViewportSize({ width: 1080, height: 900 });
    await page.goto("/");
    await expect(page.locator(".chat-list .chat-row")).toHaveCount(6);
    const sharedIds = await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const chats = new Map(telegramStore.getState().chats);
      const shared = [...chats.values()].filter((chat) =>
        chat.folderIds.includes("main") && chat.folderIds.includes("folder:work"));
      for (const chat of shared) chats.set(chat.id, {
        ...chat, avatar: { ...chat.avatar, imagePath: `/mock-video-poster.jpg?folder-avatar=${chat.id}` },
      });
      // Folder switching must preserve the visible images even without a data refresh.
      telegramStore.setState({ chats, connectionStatus: "offline" });
      return shared.map((chat) => chat.id);
    });
    expect(sharedIds).toHaveLength(3);
    await expect.poll(() => page.locator(".chat-list img").evaluateAll((images) =>
      images.length === 3 && images.every((image) =>
        (image as HTMLImageElement).complete && image.getAttribute("data-image-state") === "ready" &&
        getComputedStyle(image).opacity === "1"),
    )).toBe(true);

    const result = await page.evaluate(async ({ sharedIds, evictReadiness }) => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const { forgetDecodedImage } = await import("/src/media/decodedImages.ts" as string) as typeof import("../../src/media/decodedImages");
      const originalList = document.querySelector(".chat-list");
      const originalChats = telegramStore.getState().chats;
      const originals = sharedIds.map((id) => {
        const row = originalList?.querySelector<HTMLElement>(`[data-chat-id="${id}"]`);
        const image = row?.querySelector("img");
        if (!row || !image) throw new Error(`Missing initial avatar for ${id}`);
        return { id, row, image };
      });
      const failures = [];
      for (const folderId of ["folder:work", "main", "folder:work", "main", "folder:work", "main"]) {
        // Simulate evicted URL metadata without unloading the already displayed images.
        if (evictReadiness) originals.forEach(({ image }) => forgetDecodedImage(image.currentSrc));
        const folderButton = document.querySelector<HTMLButtonElement>(`.rail-actions [data-folder-id="${folderId}"]`);
        if (!folderButton) throw new Error(`Missing folder ${folderId}`);
        folderButton.click();
        for (let frame = 0; frame < 4; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const list = document.querySelector(".chat-list");
          const visibleIds = [...list?.querySelectorAll<HTMLElement>(".chat-row") ?? []].map((row) => row.dataset.chatId);
          const expectedIds = [...originalChats.values()].filter((chat) => chat.folderIds.includes(folderId)).map((chat) => chat.id);
          const rows = originals.map((original) => {
            const row = list?.querySelector(`[data-chat-id="${original.id}"]`);
            const image = row?.querySelector("img");
            return { id: original.id, sameRow: row === original.row, sameImage: image === original.image,
              state: image?.dataset.imageState, opacity: image ? getComputedStyle(image).opacity : null };
          });
          if (list !== originalList || telegramStore.getState().chatFilter !== folderId ||
            visibleIds.length !== expectedIds.length || expectedIds.some((id) => !visibleIds.includes(id)) ||
            rows.some((row) => !row.sameRow || !row.sameImage || row.state !== "ready" || row.opacity !== "1")) {
            failures.push({ folderId, frame, sameList: list === originalList, visibleIds, rows });
          }
        }
      }
      return { failures, sameChatData: telegramStore.getState().chats === originalChats };
    }, { sharedIds, evictReadiness });
    expect(result.sameChatData).toBe(true);
    expect(result.failures).toEqual([]);
  });
}

test("decoded message images restore without a second fade after remount", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const current = telegramStore.getState().messages.get("chat-product")!;
    telegramStore.setState({ messages: new Map(telegramStore.getState().messages).set("chat-product", [...current, {
      ...current.at(-1)!, id: "decoded-remount", mediaAlbumId: undefined, sentAt: "2027-01-01T00:00:00Z",
      content: { kind: "media", mediaType: "photo", fileName: "cached.jpg", sizeLabel: "18 KB",
        localPath: "/mock-video-poster.jpg?decoded-remount", width: 480, height: 240,
        isDownloaded: true, canDownload: false },
    }]) });
  });
  const image = page.locator('[data-message-id="decoded-remount"] img');
  await expect(image).toHaveCSS("opacity", "1");
  const frames = await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const original = document.querySelector('[data-message-id="decoded-remount"] img');
    const current = telegramStore.getState().messages.get("chat-product")!;
    telegramStore.setState({ messages: new Map(telegramStore.getState().messages).set("chat-product", current.map((message) =>
      message.id === "decoded-remount" ? { ...message, renderKey: "remounted-image" } : message)) });
    const frames = [];
    for (let frame = 0; frame < 20; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const img = document.querySelector<HTMLImageElement>('[data-message-id="decoded-remount"] img');
      frames.push({ remounted: img !== original, opacity: img ? getComputedStyle(img).opacity : null,
        state: img?.dataset.imageState });
    }
    return frames;
  });
  expect(frames.every((frame) => frame.remounted && frame.opacity === "1" && frame.state === "ready"), JSON.stringify(frames)).toBe(true);
});

test("a stale media decode cannot hide or acknowledge a newer source", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async () => {
    const original = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      if (this.currentSrc.includes("decode-obsolete")) {
        return new Promise<void>((resolve) => Object.assign(window, { releaseObsoleteDecode: resolve }));
      }
      return original.call(this);
    };
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const current = telegramStore.getState().messages.get("chat-product")!;
    telegramStore.setState({ messages: new Map(telegramStore.getState().messages).set("chat-product", [...current, {
      ...current.at(-1)!, id: "decode-generation", mediaAlbumId: undefined, sentAt: "2027-01-01T00:00:00Z",
      content: { kind: "media", mediaType: "photo", fileName: "decode.jpg", sizeLabel: "18 KB",
        localPath: "/mock-video-poster.jpg?decode-obsolete", width: 480, height: 240,
        isDownloaded: true, canDownload: false },
    }]) });
  });
  await page.waitForFunction(() => Boolean((window as unknown as { releaseObsoleteDecode?: () => void }).releaseObsoleteDecode));
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const current = telegramStore.getState().messages.get("chat-product")!;
    telegramStore.setState({ messages: new Map(telegramStore.getState().messages).set("chat-product", current.map((message) =>
      message.id === "decode-generation" ? { ...message, content: { ...message.content, localPath: "/mock-video-poster.jpg?decode-current" } } : message)) });
  });
  const image = page.locator('[data-message-id="decode-generation"] img');
  await expect(image).toHaveAttribute("data-image-state", "ready");
  await expect(image).toHaveCSS("opacity", "1");
  await page.evaluate(() => (window as unknown as { releaseObsoleteDecode: () => void }).releaseObsoleteDecode());
  await page.waitForTimeout(80);
  await expect(image).toHaveAttribute("data-image-state", "ready");
  await expect(image).toHaveCSS("opacity", "1");
});

test("captioned message media stays paint-contained across virtual remounts", async ({ page }) => {
  await page.setViewportSize({ width: 525, height: 812 });
  await page.goto("/");
  await page.locator('[data-chat-id="chat-product"]').click();
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");

  await page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Message[]> };
        setState: (partial: { messages: Map<string, Message[]> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const paintMessages: Message[] = [
      {
        id: "paint-contained-media",
        chatId: "chat-product",
        senderId: "u-mia",
        outgoing: false,
        sentAt: "2026-08-01T10:30:00+08:00",
        delivery: "read",
        content: {
          kind: "media",
          mediaType: "photo",
          fileName: "paint-containment.jpg",
          sizeLabel: "18 KB",
          localPath: "/mock-video-poster.jpg",
          width: 640,
          height: 360,
          caption: "带说明的图片消息",
          isDownloaded: true,
          isDownloading: false,
        },
      },
      {
        id: "paint-contained-text",
        chatId: "chat-product",
        senderId: "u-mia",
        outgoing: false,
        sentAt: "2026-08-01T10:31:00+08:00",
        delivery: "read",
        content: { kind: "text", text: "紧跟图片的普通消息" },
      },
    ];
    messages.set("chat-product", [...current, ...paintMessages]);
    module.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const mediaRow = page.locator('[data-message-id="paint-contained-media"]');
  const textRow = page.locator('[data-message-id="paint-contained-text"]');
  const scrollToLatest = () => messageList.press("End");
  const expectContainedGeometry = async () => {
    const report = await page.evaluate(() => {
      const media = document.querySelector<HTMLElement>('[data-message-id="paint-contained-media"]');
      const text = document.querySelector<HTMLElement>('[data-message-id="paint-contained-text"]');
      const mediaPreview = media?.querySelector<HTMLElement>(".photo-preview");
      const mediaShell = media?.querySelector<HTMLElement>(".message-bubble-shell");
      const textShell = text?.querySelector<HTMLElement>(".message-bubble-shell");
      const image = media?.querySelector<HTMLImageElement>(".stable-image");
      if (!media || !text || !mediaPreview || !mediaShell || !textShell || !image) return undefined;
      const mediaBounds = media.getBoundingClientRect();
      const textBounds = text.getBoundingClientRect();
      return {
        contain: getComputedStyle(mediaPreview).contain,
        activeImageAnimations: image.getAnimations().filter((animation) => animation.playState !== "finished").length,
        mediaBottom: mediaBounds.bottom,
        textTop: textBounds.top,
        mediaWidth: mediaShell.getBoundingClientRect().width,
        textWidth: textShell.getBoundingClientRect().width,
        sameVirtualItem: media.closest("[data-index]") === text.closest("[data-index]"),
      };
    });
    expect(report).toBeDefined();
    expect(report?.contain.split(" ")).toContain("paint");
    expect(report?.activeImageAnimations).toBe(0);
    expect((report?.mediaBottom ?? 0) - (report?.textTop ?? 0)).toBeLessThanOrEqual(0.5);
    expect(report?.textWidth).toBeLessThan(report?.mediaWidth ?? 0);
    expect(report?.sameVirtualItem).toBe(true);
  };

  await scrollToLatest();
  await expect(mediaRow).toBeVisible();
  await expect(textRow).toBeVisible();
  await expect(mediaRow.locator(".stable-image")).toHaveAttribute("data-image-state", "ready");
  await expect.poll(() => mediaRow.locator(".stable-image").evaluate((image) =>
    image.getAnimations().filter((animation) => animation.playState !== "finished").length,
  )).toBe(0);
  await expectContainedGeometry();

  await messageList.evaluate((element) => {
    // Leaving latest is user intent, not a virtualizer correction to preserve.
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(mediaRow).toHaveCount(0);
  await scrollToLatest();
  await expect(mediaRow).toBeVisible();
  await expect(textRow).toBeVisible();
  await expect(mediaRow.locator(".stable-image")).toHaveAttribute("data-image-state", "ready");
  await expect.poll(() => mediaRow.locator(".stable-image").evaluate((image) =>
    image.getAnimations().filter((animation) => animation.playState !== "finished").length,
  )).toBe(0);
  await expectContainedGeometry();
});

test("background visibility pauses continuous motion and resumes it on return", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await page.evaluate(() => {
    HTMLMediaElement.prototype.play = function play() {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    (globalThis as typeof globalThis & {
      __setMotionVisibility?: (next: DocumentVisibilityState) => void;
    }).__setMotionVisibility = (next) => {
      visibility = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const spinner = document.createElement("span");
    spinner.dataset.motionTestSpinner = "true";
    spinner.className = "spin";
    document.body.append(spinner);
  });

  await page.getByRole("button", { name: "播放 产品语音.m4a" }).click();
  const spectrum = page.locator('[data-message-id="p-audio"] .audio-spectrum');
  const spinner = page.locator('[data-motion-test-spinner="true"]');
  await expect(spectrum).toHaveAttribute("data-motion-active", "true");
  await expect(page.locator("html")).toHaveAttribute("data-motion-runtime", "active");

  await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __setMotionVisibility?: (next: DocumentVisibilityState) => void;
    }
  ).__setMotionVisibility?.("hidden"));
  await expect(page.locator("html")).toHaveAttribute("data-motion-runtime", "paused");
  await expect(spectrum).toHaveAttribute("data-motion-active", "false");
  await expect(spinner).toHaveCSS("animation-play-state", "paused");
  const hiddenFrame = await spectrum.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(180);
  expect(await spectrum.evaluate((element) => (element as HTMLCanvasElement).toDataURL()))
    .toBe(hiddenFrame);

  await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __setMotionVisibility?: (next: DocumentVisibilityState) => void;
    }
  ).__setMotionVisibility?.("visible"));
  await expect(page.locator("html")).toHaveAttribute("data-motion-runtime", "active");
  await expect(spectrum).toHaveAttribute("data-motion-active", "true");
  await expect(spinner).toHaveCSS("animation-play-state", "running");
});

test("rapid menus, jumps, conversation switches, scroll, and resize settle cleanly", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await expect(page.getByRole("log", { name: "消息列表" })).toHaveAttribute("aria-busy", "false");

  const moreActions = page.getByRole("button", { name: "更多操作" });
  const menu = page.getByRole("menu", { name: "会话操作" });
  await moreActions.click();
  await moreActions.click();
  await moreActions.click();
  await expect(menu).toBeVisible();
  await expect(page.locator('.motion-presence:has(.chat-action-menu)')).toHaveCount(1);

  await page.getByRole("log", { name: "消息列表" }).evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollTop - 320);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.setViewportSize({ width: 768, height: 720 });
  await expect(menu).toBeVisible();
  await page.setViewportSize({ width: 390, height: 720 });
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.motion-presence[data-motion-state="exiting"]')).toHaveCount(0);
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await moreActions.click();
  await expect(menu).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(moreActions).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(async () => {
    for (const chatId of ["chat-mia", "chat-forum", "chat-product", "chat-mia", "chat-product"]) {
      document.querySelector<HTMLElement>(`[data-chat-id="${chatId}"]`)?.click();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 24));
    }
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect(page.getByRole("log", { name: "消息列表" })).toHaveAttribute("aria-busy", "false");

  const source = await revealVirtualMessage(page, "p-channel-reply");
  await source.locator(".message-reply-preview").click();
  await expect(page.locator('[data-message-id="p-old-8"]')).toHaveClass(/is-notification-target/);
  await page.locator(".pinned-message-preview").click();
  await expect(page.locator('[data-message-id="p-4"]')).toBeVisible();
  await page.locator('[data-chat-id="chat-mia"]').click();
  await page.locator('[data-chat-id="chat-product"]').click();

  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect(page.locator(".message-list")).not.toHaveClass(/is-jump-transitioning/);
  await expect(page.locator("[data-conversation-switch-snapshot], [data-conversation-motion-snapshot]"))
    .toHaveCount(0, { timeout: 2_000 });
  await expect(page.locator('.motion-presence[data-motion-state="exiting"]'))
    .toHaveCount(0, { timeout: 2_000 });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator('.chat-row[aria-current="true"]')).toHaveCount(1);
  expect(await horizontalOverflow(page)).toBe(false);

  const unsafeKeyframeProperties = await page.evaluate(() => {
    const metadata = new Set(["offset", "computedOffset", "easing", "composite"]);
    return document.getAnimations().flatMap((animation) =>
      (animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [])
        .flatMap((frame) => Object.keys(frame))
        .filter((property) => !metadata.has(property) && property !== "opacity" && property !== "transform"));
  });
  expect(unsafeKeyframeProperties).toEqual([]);
});

for (const width of [390, 768, 1280]) {
  for (const reducedMotion of [false, true]) {
    const motion = reducedMotion ? "reduced" : "full";
    test(`visual motion baseline at ${width}px with ${motion} motion`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
      await page.setViewportSize({ width, height: 720 });
      await page.goto("/");
      await page.locator('[data-chat-id="chat-product"]').click();
      await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
      await expect(page.locator("html")).toHaveAttribute(
        "data-motion",
        reducedMotion ? "reduced" : "full",
      );
      await waitForStableFrame(page);
      await expect(page).toHaveScreenshot(`motion-${width}-${motion}.png`, {
        animations: "disabled",
        caret: "hide",
        maxDiffPixelRatio: 0.002,
      });
    });
  }
}
