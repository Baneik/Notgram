import { expect, test } from "@playwright/test";
import { horizontalOverflow, latestMessageBottomGap, revealVirtualMessage } from "./helpers";

test("conversation suppresses horizontal scrolling and reveals its vertical scrollbar only while scrolling", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toBeVisible();
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect(messageList).not.toHaveClass(/is-history-adjusting/);
  await expect(messageList).not.toHaveClass(/is-scrolling/);
  await expect.poll(() => messageList.evaluate((element) => (
    getComputedStyle(element).scrollbarColor.startsWith("rgba(0, 0, 0, 0)")
  ))).toBe(true);

  const idle = await messageList.evaluate((element) => {
    const content = element.querySelector<HTMLElement>(".message-list-content");
    return {
      clientWidth: element.clientWidth,
      contentWidth: content?.getBoundingClientRect().width,
      horizontalOverflow: element.scrollWidth > (element as HTMLElement).offsetWidth,
      overflowX: getComputedStyle(element).overflowX,
    };
  });
  expect(idle.overflowX).toBe("hidden");
  expect(idle.horizontalOverflow).toBe(false);

  await messageList.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -160 }));
    element.scrollTop = Math.max(0, element.scrollTop - 160);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(messageList).toHaveClass(/is-scrolling/);
  await expect.poll(() => messageList.evaluate((element) => (
    getComputedStyle(element).scrollbarColor.startsWith("rgba(0, 0, 0, 0)")
  ))).toBe(false);

  const scrolling = await messageList.evaluate((element) => ({
    clientWidth: element.clientWidth,
    contentWidth: element.querySelector<HTMLElement>(".message-list-content")
      ?.getBoundingClientRect().width,
  }));
  expect(scrolling.clientWidth).toBe(idle.clientWidth);
  expect(scrolling.contentWidth).toBe(idle.contentWidth);

  await expect(messageList).not.toHaveClass(/is-scrolling/, { timeout: 2_000 });
  await expect.poll(() => messageList.evaluate((element) => element.clientWidth))
    .toBe(idle.clientWidth);
});

test("message viewport reaches the composer and keeps a scrollable bottom gap", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  const geometry = await page.evaluate(() => {
    const latest = document.querySelector<HTMLElement>('[data-message-id="p-video"]');
    const list = latest?.closest<HTMLElement>(".message-list");
    const composer = document.querySelector<HTMLElement>(".composer");
    const sentinel = list?.querySelector<HTMLElement>(".message-list-end-sentinel");
    if (!latest || !list || !composer || !sentinel) return null;
    return {
      latestGap: composer.getBoundingClientRect().top - latest.getBoundingClientRect().bottom,
      viewportGap: composer.getBoundingClientRect().top - list.getBoundingClientRect().bottom,
      bottomSpacer: sentinel.getBoundingClientRect().height,
      distanceBottom: list.scrollHeight - list.scrollTop - list.clientHeight,
    };
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.viewportGap).toBeCloseTo(0, 1);
  expect(geometry!.bottomSpacer).toBeCloseTo(12, 1);
  expect(geometry!.latestGap).toBeGreaterThanOrEqual(0);
  expect(geometry!.latestGap).toBeLessThanOrEqual(geometry!.bottomSpacer + 1);
  expect(Math.abs(
    geometry!.latestGap + geometry!.distanceBottom - geometry!.bottomSpacer,
  )).toBeLessThanOrEqual(0.5);
});

test("outgoing messages stay inside the conversation at narrow widths and interface zoom", async ({ page }) => {
  for (const scenario of [
    { width: 464, zoom: "1" },
    { width: 580, zoom: "1.25" },
  ]) {
    await page.setViewportSize({ width: scenario.width, height: 620 });
    await page.goto("/");
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    await expect(page.locator(".message-row.is-outgoing").last()).toBeVisible();
    await page.locator("html").evaluate((element, zoom) => { element.style.zoom = zoom; }, scenario.zoom);

    const layout = await page.locator(".message-list").evaluate((list) => {
      const content = list.querySelector<HTMLElement>(".message-list-content");
      const outgoing = [...list.querySelectorAll<HTMLElement>(".message-row.is-outgoing")];
      const listBounds = list.getBoundingClientRect();
      const contentBounds = content?.getBoundingClientRect();
      const scale = listBounds.width / (list as HTMLElement).offsetWidth;
      const paddingRight = Number.parseFloat(getComputedStyle(list).paddingRight) * scale;
      const contentRightLimit = listBounds.left
        + ((list as HTMLElement).clientWidth * scale)
        - paddingRight;
      return {
        contentRight: contentBounds?.right ?? Number.POSITIVE_INFINITY,
        contentRightLimit,
        listRight: listBounds.right,
        overflowX: getComputedStyle(list).overflowX,
        outgoingRightEdges: outgoing.map((row) => {
          const shell = row.querySelector<HTMLElement>(".message-bubble-shell");
          const bubble = row.querySelector<HTMLElement>(".message-bubble");
          return {
            shell: shell?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
            bubble: bubble?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
          };
        }),
      };
    });

    expect(layout.overflowX).toBe("hidden");
    expect(layout.contentRight).toBeLessThanOrEqual(layout.contentRightLimit + 1);
    expect(layout.contentRight).toBeLessThan(layout.listRight);
    for (const edge of layout.outgoingRightEdges) {
      expect(edge.shell).toBeLessThanOrEqual(layout.contentRight + 1);
      expect(edge.bubble).toBeLessThanOrEqual(layout.contentRight + 1);
    }
  }
});

test("incoming virtual blocks preserve the sender avatar column", async ({ page }) => {
  await page.setViewportSize({ width: 525, height: 812 });
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toBeVisible();
  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        };
        setState: (partial: {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-product", Array.from({ length: 6 }, (_, index) => ({
      id: `virtual-incoming-${index + 1}`,
      chatId: "chat-product",
      senderId: "u-mia",
      outgoing: false,
      sentAt: new Date(Date.UTC(2026, 7, 4, 0, 0, index)).toISOString(),
      delivery: "read",
      content: { kind: "text", text: `连续来信 ${index + 1}` },
    })));
    const histories = new Map(state.histories);
    histories.set("chat-product", { loading: false, hasMore: false });
    storeModule.telegramStore.setState({ messages, histories });
  }, "/src/store/telegramStore.ts");

  await expect(page.locator('[data-message-id="virtual-incoming-6"]')).toBeVisible();
  const incomingGroups = page.locator(".message-group.is-incoming");
  await expect(incomingGroups).toHaveCount(2);
  const alignment = await incomingGroups.evaluateAll((groups) => {
    const content = groups[0]?.closest(".message-list-content");
    const contentLeft = content?.getBoundingClientRect().left ?? Number.NEGATIVE_INFINITY;
    return groups.map((group) => ({
      avatarSlots: group.querySelectorAll(".message-group-avatar").length,
      avatars: group.querySelectorAll(".message-group-avatar .avatar").length,
      avatarPosition: group.querySelector<HTMLElement>(".message-sender-avatar")
        ? getComputedStyle(group.querySelector<HTMLElement>(".message-sender-avatar")!).position
        : null,
      stackOffset: Math.round(
        (group.querySelector<HTMLElement>(".message-group-stack")?.getBoundingClientRect().left
          ?? Number.POSITIVE_INFINITY) - contentLeft,
      ),
    }));
  });
  expect(alignment).toEqual([
    { avatarSlots: 1, avatars: 0, avatarPosition: null, stackOffset: 42 },
    { avatarSlots: 1, avatars: 1, avatarPosition: "sticky", stackOffset: 42 },
  ]);
  const visibleAvatar = incomingGroups.nth(1).locator(".message-group-avatar .avatar");
  await expect(visibleAvatar).toHaveCSS("position", "relative");
  await expect(visibleAvatar).toHaveCSS("overflow", "hidden");
  await expect(visibleAvatar).toHaveCSS("border-radius", "50%");
});

test("long quotes collapse under the pointer without intermediate viewport movement", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("notgram:preferences:v1", JSON.stringify({ quoteCollapseLines: 5 })));
  await page.goto("/");
  await page.getByRole("button", { name: /收藏夹/ }).click();
  const row = page.locator('[data-message-id="saved-long-quote"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/is-outgoing/);
  await expect(row.locator(".message-rich-text")).toContainText("引用内容会保持消息正文可读");
  const quote = row.locator(".rich-blockquote");
  await expect(quote).toHaveAttribute("data-quote-state", "collapsed");
  await expect.poll(async () => Number(await quote.getAttribute("data-quote-line-count")))
    .toBeGreaterThan(5);
  await expect(quote.getByRole("button", { name: /展开引用/ })).toBeVisible();
  const collapsed = await quote.evaluate((element) => {
    const content = element.querySelector<HTMLElement>(".rich-blockquote-content")!;
    const fade = element.querySelector<HTMLElement>(".rich-blockquote-fade")!;
    return {
      height: element.getBoundingClientRect().height,
      contentHeight: content.scrollHeight,
      lineHeight: Number.parseFloat(getComputedStyle(content).lineHeight),
      backdropFilter: getComputedStyle(fade).backdropFilter,
    };
  });
  expect(Math.abs(collapsed.height - collapsed.lineHeight * 3.5)).toBeLessThanOrEqual(1);
  expect(collapsed.contentHeight).toBeGreaterThan(collapsed.height);
  expect(collapsed.backdropFilter).toContain("blur");

  await quote.click({ position: { x: 12, y: 8 } });
  await expect(quote).toHaveAttribute("data-quote-state", "expanded");
  await expect(quote.getByRole("button", { name: "收起引用" })).toBeVisible();
  const expandedHeight = await quote.evaluate((element) => element.getBoundingClientRect().height);
  expect(expandedHeight).toBeGreaterThan(collapsed.lineHeight * 5);

  await page.evaluate(() => {
    const originalAnimate = Element.prototype.animate;
    const records: number[] = [];
    (globalThis as typeof globalThis & { __notgramQuoteCollapseAnimations?: typeof records })
      .__notgramQuoteCollapseAnimations = records;
    Element.prototype.animate = function (keyframes, options) {
      if (this.classList.contains("message-list-content") && Array.isArray(keyframes)) {
        records.push(performance.now());
      }
      return originalAnimate.call(this, keyframes, options);
    };
  });
  const collapseButton = quote.getByRole("button", { name: "收起引用" });
  await collapseButton.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const recordCollapsePointer = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : undefined;
      if (!target?.closest(".rich-blockquote-collapse")) return;
      (globalThis as typeof globalThis & { __notgramQuoteCollapsePointerY?: number })
        .__notgramQuoteCollapsePointerY = event.clientY;
      const samples: number[] = [];
      (globalThis as typeof globalThis & { __notgramQuoteCollapseFrames?: Promise<number[]> })
        .__notgramQuoteCollapseFrames = new Promise(resolve => {
          const started = performance.now();
          const sample = () => requestAnimationFrame(() => setTimeout(() => {
            const icon = document.querySelector('.message-list [data-message-id="saved-long-quote"] .rich-blockquote-expand > svg');
            const bounds = icon?.getBoundingClientRect();
            samples.push(bounds ? (bounds.top + bounds.bottom) / 2 - event.clientY : Number.MAX_SAFE_INTEGER);
            if (performance.now() - started < 900) sample();
            else resolve(samples);
          }, 0));
          sample();
        });
      document.removeEventListener("click", recordCollapsePointer, true);
    };
    document.addEventListener("click", recordCollapsePointer, true);
  });
  await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);
  await collapseButton.click();
  const collapsePointerY = await page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramQuoteCollapsePointerY?: number }
  ).__notgramQuoteCollapsePointerY ?? Number.NaN);
  expect(Number.isFinite(collapsePointerY)).toBe(true);
  await expect(quote).toHaveAttribute("data-quote-state", "collapsed");
  const samples = await page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramQuoteCollapseFrames?: Promise<number[]> }
  ).__notgramQuoteCollapseFrames!);
  expect(samples.length).toBeGreaterThan(10);
  expect(Math.max(...samples.map(Math.abs)), JSON.stringify(samples)).toBeLessThanOrEqual(8.5);
  expect(Math.max(...samples) - Math.min(...samples), JSON.stringify(samples)).toBeLessThanOrEqual(1);
  const animations = await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __notgramQuoteCollapseAnimations?: number[];
    }
  ).__notgramQuoteCollapseAnimations ?? []);
  expect(animations).toEqual([]);
  await expect(page.locator(".message-list")).not.toHaveClass(/is-jump-transitioning/);
  const expandIcon = quote.locator(".rich-blockquote-expand > svg");
  await expect(expandIcon).toBeVisible();
  await expect.poll(() => expandIcon.evaluate((element, pointerY) => {
    const bounds = element.getBoundingClientRect();
    return pointerY >= bounds.top - 1 && pointerY <= bounds.bottom + 1;
  }, collapsePointerY)).toBe(true);
  await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);
});

test("text message time releases reserved inline space when it wraps", async ({ page }) => {
  await page.goto("/");
  const shortMessage = page.locator('[data-message-id="p-rich-entities"]');
  await expect(shortMessage.locator('.message-rich-text[data-rich-text="entities"]')).toBeVisible();
  const shortGeometry = await shortMessage.evaluate((element) => {
    const text = element.querySelector<HTMLElement>(".message-rich-text");
    const meta = element.querySelector<HTMLElement>(".message-meta");
    const shell = element.querySelector<HTMLElement>(".message-bubble-shell");
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const stack = element.closest<HTMLElement>(".message-group-stack");
    if (!text || !meta || !shell || !bubble || !stack) return undefined;
    const range = document.createRange();
    range.selectNodeContents(text);
    const lastLine = [...range.getClientRects()].at(-1);
    const metaBounds = meta.getBoundingClientRect();
    return {
      lastLineTop: lastLine?.top,
      lastLineBottom: lastLine?.bottom,
      lastLineRight: lastLine?.right,
      metaTop: metaBounds.top,
      metaBottom: metaBounds.bottom,
      metaLeft: metaBounds.left,
      metaRight: metaBounds.right,
      bubbleRight: bubble.getBoundingClientRect().right,
      shellWidth: shell.getBoundingClientRect().width,
      stackWidth: stack.getBoundingClientRect().width,
    };
  });
  expect(shortGeometry).toBeTruthy();
  expect(shortGeometry!.metaBottom - shortGeometry!.lastLineBottom!).toBeGreaterThanOrEqual(2);
  expect(shortGeometry!.metaBottom - shortGeometry!.lastLineBottom!).toBeLessThanOrEqual(3);
  expect(shortGeometry!.metaLeft).toBeGreaterThan(shortGeometry!.lastLineRight!);
  expect(Math.abs(shortGeometry!.metaRight - (shortGeometry!.bubbleRight - 10))).toBeLessThanOrEqual(1);
  expect(shortGeometry!.shellWidth).toBeLessThanOrEqual(Math.min(shortGeometry!.stackWidth * 0.74, 720) + 1);

  await page.evaluate(async (storePath) => {
    const { telegramStore } = await import(storePath);
    const state = telegramStore.getState() as {
      messages: Map<string, Array<Record<string, unknown>>>;
    };
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) => (
      message.id === "p-rich-entities"
        ? {
            ...message,
            senderId: "self",
            outgoing: true,
            editedAt: "2026-08-01T09:49:00+08:00",
            delivery: "read",
            content: {
              kind: "text",
              text: "而且现在服务端已有自动重试的能力了，加一个异常匹配的事情",
            },
          }
        : message
    )));
    telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const longMessage = shortMessage;
  // Changing sender/outgoing state can move the message into another group.
  // Wait for that commit before resizing the group used by the wrap assertion.
  await expect(longMessage.locator(".message-rich-text")).toHaveText("而且现在服务端已有自动重试的能力了，加一个异常匹配的事情");
  await longMessage.evaluate((element) => {
    const group = element.closest<HTMLElement>(".message-group");
    if (group) group.style.width = "648px";
  });
  await expect(longMessage.locator(".message-bubble")).toHaveClass(/has-wrapped-meta/);
  await expect(longMessage.locator(".message-bubble")).toHaveCSS("padding-bottom", "0px");
  await expect(longMessage.locator(".message-meta")).toHaveCSS("float", "none");
  const releasedGeometry = await longMessage.locator(".message-bubble-shell").evaluate((shell) => {
    const text = shell.querySelector<HTMLElement>(".message-rich-text");
    const meta = shell.querySelector<HTMLElement>(".message-meta");
    const bubble = shell.querySelector<HTMLElement>(".message-bubble");
    const flow = shell.querySelector<HTMLElement>(".message-text-flow");
    if (!text || !meta || !bubble || !flow) return undefined;
    const range = document.createRange();
    range.selectNodeContents(text);
    const lastLine = [...range.getClientRects()].filter((rect) => rect.width > 0).at(-1);
    if (!lastLine) return undefined;
    const flowBounds = flow.getBoundingClientRect();
    const flowStyle = getComputedStyle(flow);
    const metaBounds = meta.getBoundingClientRect();
    return {
      availableInlineSpace: flowBounds.right - Number.parseFloat(flowStyle.paddingRight) - lastLine.right,
      textWidth: lastLine.width,
      metaWidth: metaBounds.width,
      metaRight: metaBounds.right,
      bubbleWidth: bubble.getBoundingClientRect().width,
      bubbleRight: bubble.getBoundingClientRect().right,
      metaTop: metaBounds.top,
      lastLineBottom: lastLine.bottom,
      lineHeight: Number.parseFloat(getComputedStyle(text).lineHeight),
    };
  });
  expect(releasedGeometry).toBeTruthy();
  expect(Math.abs(releasedGeometry!.bubbleWidth - releasedGeometry!.textWidth - 20)).toBeLessThanOrEqual(1);
  expect(releasedGeometry!.availableInlineSpace).toBeLessThan(releasedGeometry!.metaWidth + 8);
  expect(Math.abs(releasedGeometry!.metaRight - (releasedGeometry!.bubbleRight - 10))).toBeLessThanOrEqual(1);
  const wrappedGap = releasedGeometry!.metaTop - releasedGeometry!.lastLineBottom;
  expect(wrappedGap).toBeGreaterThanOrEqual(1);
  expect(wrappedGap).toBeLessThan(releasedGeometry!.lineHeight * 0.4);

  await longMessage.evaluate((element) => {
    const group = element.closest<HTMLElement>(".message-group");
    if (group) group.style.width = "900px";
  });
  await expect(longMessage.locator(".message-text-flow")).not.toHaveClass(/is-meta-wrapped/);
  await expect(longMessage.locator(".message-meta")).toHaveCSS("float", "right");
});

test("media cards preserve media width while giving captions a stable reading width", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Mia Chen/ }).first().click();

  const geometryFor = async (messageId: string) => {
    const row = page.locator(`[data-message-id="${messageId}"]`);
    await row.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "auto" }));
    await expect.poll(() => row.locator(".photo-preview img").evaluate((image) => {
      const media = image as HTMLImageElement;
      return media.complete && media.naturalWidth > 0 && media.naturalHeight > 0;
    })).toBe(true);
    return row.evaluate((element) => {
      const shell = element.querySelector<HTMLElement>(".message-bubble-shell");
      const preview = element.querySelector<HTMLElement>(".photo-preview");
      const image = element.querySelector<HTMLImageElement>(".photo-preview img");
      const caption = element.querySelector<HTMLElement>(".photo-caption");
      const meta = element.querySelector<HTMLElement>(".message-meta");
      if (!shell || !preview || !image || !caption || !meta) return undefined;
      const shellBounds = shell.getBoundingClientRect();
      const previewBounds = preview.getBoundingClientRect();
      const scale = Math.min(
        previewBounds.width / image.naturalWidth,
        previewBounds.height / image.naturalHeight,
      );
      const range = document.createRange();
      range.selectNodeContents(caption);
      const captionLastLine = [...range.getClientRects()].at(-1);
      const metaBounds = meta.getBoundingClientRect();
      return {
        shellWidth: shellBounds.width,
        previewWidth: previewBounds.width,
        previewHeight: previewBounds.height,
        captionHeight: caption.getBoundingClientRect().height,
        captionLastLineBottom: captionLastLine?.bottom,
        captionLastLineRight: captionLastLine?.right,
        metaTop: metaBounds.top,
        metaBottom: metaBounds.bottom,
        metaLeft: metaBounds.left,
        metaRight: metaBounds.right,
        captionFlowHeight: element.querySelector<HTMLElement>(".photo-caption-flow")?.getBoundingClientRect().height,
        horizontalLetterbox: (previewBounds.width - image.naturalWidth * scale) / 2,
        verticalLetterbox: (previewBounds.height - image.naturalHeight * scale) / 2,
        objectFit: getComputedStyle(image).objectFit,
      };
    });
  };

  const tall = await geometryFor("m-tall-caption");
  expect(tall).toBeDefined();
  expect(tall?.shellWidth).toBeCloseTo(320, 0);
  expect(Math.abs((tall?.shellWidth ?? 0) - (tall?.previewWidth ?? 1))).toBeLessThanOrEqual(1);
  expect(tall?.captionHeight).toBeLessThan(50);
  expect(tall?.horizontalLetterbox).toBeGreaterThan(50);
  expect(tall?.verticalLetterbox).toBeLessThanOrEqual(1);
  expect(tall?.objectFit).toBe("contain");

  const wide = await geometryFor("m-wide-caption");
  expect(wide).toBeDefined();
  expect(wide?.shellWidth).toBeCloseTo(390, 0);
  expect(Math.abs((wide?.shellWidth ?? 0) - (wide?.previewWidth ?? 1))).toBeLessThanOrEqual(1);
  expect(wide?.horizontalLetterbox).toBeLessThanOrEqual(1);
  expect(wide?.verticalLetterbox).toBeLessThanOrEqual(1);
  expect(wide?.objectFit).toBe("contain");
  expect(wide?.captionLastLineBottom).toBeDefined();
  expect(wide?.captionLastLineRight).toBeDefined();
  expect(Math.abs(wide!.metaBottom! - wide!.captionLastLineBottom!)).toBeLessThan(5);
  expect(wide!.metaLeft!).toBeGreaterThan(wide!.captionLastLineRight!);
  expect(wide!.captionFlowHeight!).toBeLessThan(32);

  await page.evaluate(async (storePath) => {
    const { telegramStore } = await import(storePath);
    const state = telegramStore.getState() as {
      messages: Map<string, Array<Record<string, unknown>>>;
    };
    const chatMessages = state.messages.get("chat-mia") ?? [];
    const source = chatMessages.find((message) => message.id === "m-tall-caption");
    if (!source) throw new Error("Missing portrait media fixture");
    const messages = new Map(state.messages);
    messages.set("chat-mia", [
      ...chatMessages,
      {
        ...source,
        id: "m-tall-caption-outgoing",
        senderId: "self",
        outgoing: true,
        sentAt: "2026-08-01T09:27:00+08:00",
        editedAt: "2026-08-01T09:28:00+08:00",
        content: {
          ...(source.content as Record<string, unknown>),
          caption: "媒体说明".repeat(15),
        },
      },
    ]);
    telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const outgoingTall = await geometryFor("m-tall-caption-outgoing");
  expect(outgoingTall).toBeDefined();
  expect(Math.abs(outgoingTall!.shellWidth - tall!.shellWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(outgoingTall!.previewHeight - tall!.previewHeight)).toBeLessThanOrEqual(1);
  const outgoingCaption = page.locator('[data-message-id="m-tall-caption-outgoing"] .photo-caption-flow');
  await expect(outgoingCaption).toHaveClass(/is-meta-wrapped/);
  await expect(outgoingCaption.locator(".message-meta")).toHaveCSS("float", "none");

  await page.setViewportSize({ width: 360, height: 760 });
  const narrowTall = await geometryFor("m-tall-caption");
  expect(narrowTall).toBeDefined();
  expect(narrowTall!.previewWidth).toBeLessThan(320);
  expect(narrowTall!.previewWidth / narrowTall!.previewHeight).toBeCloseTo(320 / 420, 2);
});

test("mobile chat switching has no horizontal overflow", { tag: "@smoke" }, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator(".chat-list[data-active=true] .chat-row").first().click();

  await expect(page.locator(".conversation")).toBeVisible();
  await expect(page.locator(".mobile-back")).toBeVisible();
  await expect(page.locator(".message-row")).not.toHaveCount(0);
  expect(await horizontalOverflow(page)).toBe(false);
});

test("minimum window remains operable at Windows 125, 150, and 200 percent scaling", async ({ browser }) => {
  for (const deviceScaleFactor of [1.25, 1.5, 2]) {
    const context = await browser.newContext({
      viewport: { width: 680, height: 560 },
      deviceScaleFactor,
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.locator(".chat-list[data-active=true] .chat-row").first().click();

    await expect(page.locator(".conversation")).toBeVisible();
    await expect(page.locator(".mobile-back")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
    expect(await page.evaluate(() => devicePixelRatio)).toBe(deviceScaleFactor);
    expect(await horizontalOverflow(page)).toBe(false);
    await context.close();
  }
});

test("Markdown and TDLib rich text render as structured message content", async ({ page }) => {
  const mathAssetRequests: string[] = [];
  page.on("request", (request) => {
    if (/RichMathExpression|katex/i.test(request.url())) {
      mathAssetRequests.push(request.url());
    }
  });
  await page.goto("/");
  const productChat = page.getByRole("button", { name: /产品讨论/ }).first();
  await expect(productChat).toBeVisible();
  expect(mathAssetRequests).toEqual([]);
  await productChat.click();

  const markdownRow = await revealVirtualMessage(page, "p-markdown");
  const markdown = markdownRow.locator(".message-rich-text");
  await expect(markdown).toHaveAttribute("data-rich-text", "markdown");
  await expect(markdown.locator("strong")).toHaveText("Markdown 粗体");
  await expect(markdown.locator("em")).toHaveText("斜体");
  await expect(markdown.locator("del")).toHaveText("删除线");
  await expect(markdown.locator("li")).toHaveCount(2);
  await expect(markdown.locator("code")).toHaveText("code");
  const markdownLink = markdown.locator('a[href="https://t.me/mia_design"]');
  await expect(markdownLink).toHaveText("链接");

  const entities = (await revealVirtualMessage(page, "p-rich-entities"))
    .locator(".message-rich-text");
  await expect(entities).toHaveAttribute("data-rich-text", "entities");
  await expect(entities.locator("strong")).toHaveText("bold");
  await expect(entities.locator('a[href="https://t.me/addtheme/NotgramTheme"]')).toHaveText("link");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await messageList.focus();
  await page.keyboard.press("End");
  await expect(page.locator('[data-message-id="p-video"] .photo-caption strong'))
    .toHaveText("昨晚");

  const richMessage = (await revealVirtualMessage(page, "p-rich-message"))
    .locator(".rich-message-content");
  await expect(richMessage).toHaveAttribute("data-rich-text", "rich-message");
  await expect(richMessage.locator("h1")).toHaveText("今日小贴士");
  await expect(richMessage.locator("li")).toHaveCount(3);
  await expect(richMessage.locator("li").first().locator("strong"))
    .toHaveText("优先处理最重要的一件事");
  await expect(richMessage.locator("blockquote")).toHaveCount(2);
  await expect(richMessage.locator("code").first()).toHaveText("5,709 tokens");
  await expect(richMessage.locator(".katex")).toContainText("E");
  expect(mathAssetRequests.some((url) => url.includes("/src/components/RichMathExpression.tsx"))).toBe(true);
  expect(mathAssetRequests.some((url) => /katex(?:\.min)?\.css/i.test(url))).toBe(true);
  await expect(richMessage.locator("table caption")).toHaveText("Status");
  await expect(richMessage.locator("table th")).toHaveText("Metric");
  await expect(richMessage.locator("table td")).toHaveText("Ready");
  const anchorLink = richMessage.locator('a[href^="#rich-message-p-rich-message-anchor-"]');
  await expect(anchorLink).toHaveText("jump");
  const anchorHref = await anchorLink.getAttribute("href");
  expect(anchorHref).toBeTruthy();
  await expect(richMessage.locator(anchorHref!)).toHaveCount(1);
  await richMessage.locator("details summary").click();
  await expect(richMessage.locator("details")).toContainText("Advanced details");
  await expect(richMessage.locator('.rich-media-photo img[alt="Bot chart"]')).toBeVisible();

  const globalSearch = page.getByPlaceholder("搜索会话和消息");
  await globalSearch.fill("热搜");
  await page.locator(".global-message-result").filter({ hasText: "热搜" }).first().click();
  const botQuoteRow = page.locator('[data-message-id="archive-bot-quote"]');
  const botQuote = botQuoteRow.locator(".rich-blockquote");
  await botQuoteRow.scrollIntoViewIfNeeded();
  await expect(botQuote).toHaveCount(1);
  await expect(botQuote.locator("a")).toHaveCount(10);
  const quoteGeometry = await botQuote.evaluate((element) => {
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const range = document.createRange();
    range.selectNodeContents(element);
    const lineTops = [...range.getClientRects()].reduce<number[]>((tops, rect) => {
      if (!tops.some((top) => Math.abs(top - rect.top) < 1)) tops.push(rect.top);
      return tops;
    }, []);
    return { lineCount: lineTops.length, height: element.getBoundingClientRect().height, lineHeight };
  });
  expect(quoteGeometry.lineCount).toBeLessThanOrEqual(3);
  expect(quoteGeometry.height).toBeLessThanOrEqual(quoteGeometry.lineHeight * 3.2);
  const senderRow = botQuoteRow.locator(".message-sender-row");
  await expect(senderRow.locator(".message-sender-label")).toHaveText("热点机器人");
  await expect(senderRow).not.toContainText("管理员");
  await expect(senderRow.locator(".message-sender")).toHaveClass(/is-administrator/);
  await expect(senderRow.locator(".message-sender-label")).toHaveClass(/is-administrator/);
  const senderGeometry = await senderRow.evaluate((element) => {
    const label = element.querySelector<HTMLElement>(".message-sender-label")!;
    const bubble = element.closest<HTMLElement>(".message-bubble")!;
    return {
      rightGap: bubble.getBoundingClientRect().right - label.getBoundingClientRect().right,
      topGap: label.getBoundingClientRect().top - bubble.getBoundingClientRect().top,
      fontSize: Number.parseFloat(getComputedStyle(label).fontSize),
    };
  });
  expect(senderGeometry.rightGap).toBeCloseTo(10, 0);
  expect(senderGeometry.topGap).toBeGreaterThanOrEqual(6);
  expect(senderGeometry.topGap).toBeLessThanOrEqual(10);
  expect(senderGeometry.fontSize).toBeGreaterThanOrEqual(11);
});

test("saved and direct messages align to the conversation edges", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /收藏夹/ }).click();
  const savedMessage = page.locator('[data-message-id="s-2"]');
  await expect(savedMessage).toBeVisible();
  await expect(savedMessage).toHaveClass(/is-outgoing/);
  await expect(savedMessage.locator(".message-delivery-status")).toHaveAttribute("data-delivery", "read");
  const savedChat = page.locator('.chat-list[data-active=true] [data-chat-id="chat-saved"]');
  await expect(savedChat.locator(".avatar-icon")).toBeVisible();
  await expect(savedChat.locator(".avatar img, .chat-preview svg")).toHaveCount(0);

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="m-1"]')).toBeVisible();
  await expect(page.locator('[data-message-id="m-2"]')).toBeVisible();
  await expect(page.locator(".message-group-avatar")).toHaveCount(0);
  const alignment = await page.locator(".message-list").evaluate((list) => {
    const content = list.querySelector<HTMLElement>(".message-list-content");
    const incoming = list.querySelector<HTMLElement>('[data-message-id="m-1"] .message-bubble-shell');
    const outgoing = list.querySelector<HTMLElement>('[data-message-id="m-2"] .message-bubble-shell');
    if (!content || !incoming || !outgoing) return undefined;
    const contentBounds = content.getBoundingClientRect();
    const incomingBounds = incoming.getBoundingClientRect();
    const outgoingBounds = outgoing.getBoundingClientRect();
    const style = getComputedStyle(list);
    return {
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      incomingOffset: incomingBounds.left - contentBounds.left,
      outgoingOffset: contentBounds.right - outgoingBounds.right,
    };
  });
  expect(alignment).toEqual({
    paddingLeft: "10px",
    paddingRight: "10px",
    incomingOffset: 0,
    outgoingOffset: 0,
  });
});

test("group service messages render as centered notices", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const notice = await revealVirtualMessage(page, "p-service");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveClass(/is-service/);
  await expect(notice.locator(".message-bubble")).toHaveText("Mia Chen 加入了群聊");
  const member = notice.getByRole("button", { name: "查看 Mia Chen 资料" });
  await expect(member).toBeVisible();
  await expect(notice.locator(".message-meta")).toHaveCount(0);
  const centerDelta = await notice.evaluate((row) => {
    const shell = row.querySelector<HTMLElement>(".message-bubble-shell");
    if (!shell) return Number.POSITIVE_INFINITY;
    const rowBounds = row.getBoundingClientRect();
    const shellBounds = shell.getBoundingClientRect();
    return Math.abs(
      (rowBounds.left + rowBounds.right) / 2 - (shellBounds.left + shellBounds.right) / 2,
    );
  });
  expect(centerDelta).toBeLessThanOrEqual(1);
  await member.click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile.getByRole("heading", { name: "Mia Chen" })).toBeVisible();
});

test("date separators are centered and only upward user scrolling exposes the visible day", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const separatorMessage = await revealVirtualMessage(page, "p-service");
  const separator = page.locator(".message-day").filter({ hasText: "8月1日" }).first();
  await expect(separator).toBeVisible();
  const spacing = await separator.evaluate((label) => {
    const next = document.querySelector<HTMLElement>('[data-message-id="p-service"]');
    const labelBounds = label.getBoundingClientRect();
    const previous = [...document.querySelectorAll<HTMLElement>("[data-message-id]")]
      .filter((row) => row.dataset.messageId !== "p-service")
      .filter((row) => row.getBoundingClientRect().bottom <= labelBounds.top + 1)
      .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom)[0];
    if (!previous || !next) return undefined;
    return {
      before: labelBounds.top - previous.getBoundingClientRect().bottom,
      after: next.getBoundingClientRect().top - labelBounds.bottom,
    };
  });
  expect(spacing).toBeTruthy();
  expect(Math.abs(spacing!.before - spacing!.after)).toBeLessThanOrEqual(1);

  const indicator = page.locator(".conversation-date-indicator");
  const messageList = page.locator(".message-list");
  await messageList.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.getByRole("textbox", { name: "消息内容" }).fill("日期标签不应被输入触发");
  await page.getByRole("button", { name: "表情", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "表情、贴纸与 GIF" })).toBeVisible();
  await expect(indicator).toHaveCount(0);
  await page.getByRole("button", { name: "关闭表情面板" }).click();

  const remountedSeparatorMessage = await revealVirtualMessage(page, "p-service");
  await remountedSeparatorMessage.evaluate((element) => {
    element.scrollIntoView({ block: "start", behavior: "auto" });
  });
  await messageList.hover();
  await page.mouse.wheel(0, -120);
  await expect(indicator).toHaveText("7月30日");
  await expect(indicator).toHaveClass(/is-visible/);

  await expect(indicator).not.toHaveClass(/is-visible/, { timeout: 2_000 });
  await messageList.focus();
  await page.keyboard.press("End");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await messageList.hover();
  await page.mouse.wheel(0, -160);
  await expect(indicator).toHaveText("8月1日");
  await expect(indicator).toHaveClass(/is-visible/);
  await expect(indicator).toHaveCSS("pointer-events", "none");

  await messageList.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(indicator).not.toHaveClass(/is-visible/);
});

test("large emoji and sticker replies keep compact transparent geometry", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "表情", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "表情、贴纸与 GIF" });
  await picker.getByRole("button", { name: /发送贴纸/ }).first().click();
  await expect(page.locator('[data-media-type="sticker"]').last()).toBeVisible();

  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    const stickerTemplate = [...current].reverse().find((message) => {
      const content = message.content as { kind?: string; mediaType?: string } | undefined;
      return content?.kind === "media" && content.mediaType === "sticker";
    });
    if (!latest || !stickerTemplate) return;
    const timestamp = Date.now() + 10_000;
    const replyTarget = {
      ...latest,
      id: "p-sticker-reply-target",
      renderKey: undefined,
      senderId: "me",
      outgoing: true,
      sentAt: new Date(timestamp).toISOString(),
      replyTo: undefined,
      content: { kind: "text", text: "被引用的文本消息" },
    };
    current.push(
      replyTarget,
      {
        ...latest,
        id: "p-large-emoji",
        renderKey: undefined,
        senderId: "u-emoji",
        outgoing: false,
        sentAt: new Date(timestamp + 1_000).toISOString(),
        replyTo: undefined,
        content: { kind: "text", text: "😀" },
      },
      {
        ...stickerTemplate,
        id: "p-sticker-group-first",
        renderKey: undefined,
        senderId: "u-sticker",
        senderTag: "Administrator",
        outgoing: false,
        sentAt: new Date(timestamp + 2_000).toISOString(),
        replyTo: undefined,
      },
      {
        ...latest,
        id: "p-sticker-group-last",
        renderKey: undefined,
        senderId: "u-sticker",
        outgoing: false,
        sentAt: new Date(timestamp + 3_000).toISOString(),
        replyTo: undefined,
        content: { kind: "text", text: "同组的下一条消息" },
      },
      {
        ...stickerTemplate,
        id: "p-sticker-with-reply",
        renderKey: undefined,
        senderId: "u-reply-sticker",
        outgoing: false,
        sentAt: new Date(timestamp + 4_000).toISOString(),
        replyTo: {
          kind: "message",
          messageId: replyTarget.id,
          outgoing: true,
          senderName: "我",
          text: "被引用的文本消息",
          content: replyTarget.content,
        },
      },
    );
    messages.set("chat-product", current);
    module.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const emoji = page.locator('[data-message-id="p-large-emoji"]');
  await emoji.scrollIntoViewIfNeeded();
  const emojiGeometry = await emoji.evaluate((element) => {
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const flow = element.querySelector<HTMLElement>(".message-text-flow.is-large-emoji");
    const richText = element.querySelector<HTMLElement>(".message-rich-text");
    return {
      bubbleHeight: bubble?.getBoundingClientRect().height ?? 0,
      flowHeight: flow?.getBoundingClientRect().height ?? 0,
      richTextHeight: richText?.getBoundingClientRect().height ?? 0,
    };
  });
  expect(emojiGeometry.richTextHeight).toBeGreaterThan(30);
  expect(emojiGeometry.flowHeight).toBeLessThanOrEqual(52);
  expect(emojiGeometry.bubbleHeight).toBeLessThanOrEqual(68);

  const firstSticker = page.locator('[data-message-id="p-sticker-group-first"]');
  await firstSticker.scrollIntoViewIfNeeded();
  await expect(firstSticker).toHaveClass(/group-first/);
  await expect(firstSticker.locator(".message-sender-row")).toHaveCount(0);
  const firstStickerStyle = await firstSticker.locator(".message-bubble").evaluate((element) => ({
    backgroundColor: getComputedStyle(element).backgroundColor,
    boxShadow: getComputedStyle(element).boxShadow,
  }));
  expect(firstStickerStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(firstStickerStyle.boxShadow).toBe("none");

  const repliedSticker = page.locator('[data-message-id="p-sticker-with-reply"]');
  await repliedSticker.scrollIntoViewIfNeeded();
  const repliedStickerStyle = await repliedSticker.evaluate((element) => {
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const preview = element.querySelector<HTMLElement>(".message-reply-preview");
    const media = element.querySelector<HTMLElement>('[data-media-type="sticker"]');
    const previewBounds = preview?.getBoundingClientRect();
    const mediaBounds = media?.getBoundingClientRect();
    return {
      bubbleBackground: bubble ? getComputedStyle(bubble).backgroundColor : "",
      previewBackground: preview ? getComputedStyle(preview).backgroundColor : "",
      verticalGap: previewBounds && mediaBounds ? mediaBounds.top - previewBounds.bottom : -1,
    };
  });
  expect(repliedStickerStyle.bubbleBackground).toBe("rgba(0, 0, 0, 0)");
  expect(repliedStickerStyle.previewBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(repliedStickerStyle.verticalGap).toBeGreaterThanOrEqual(0);
  expect(repliedStickerStyle.verticalGap).toBeLessThanOrEqual(4);
});

for (const refreshRate of [60, 240]) test(`media bottom geometry uses measured row spacing at ${refreshRate} Hz`, async ({ page }) => {
  if (refreshRate === 240) await page.addInitScript(() => {
    // Exercise the native display's short frame budget without shortening
    // timers used by the virtualizer's independent scroll retries.
    window.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 1000 / 240);
    window.cancelAnimationFrame = handle => window.clearTimeout(handle);
  });
  await page.setViewportSize({ width: 1080, height: 960 });
  await page.goto("/");
  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const messages = new Map(telegramStore.getState().messages);
    const caption = "视频说明包含多行正文，最后的引用来源和时间应当保持完整，不能被输入栏遮挡。\n\nSource";
    messages.set("chat-product", messages.get("chat-product")!.map(message =>
      message.id === "p-video" && message.content.kind === "media" ? {
        ...message, outgoing: false,
        content: { ...message.content, width: 640, height: 480, caption, captionEntities: [
          { kind: "bold", offset: 0, length: caption.length },
          { kind: "blockquote", offset: caption.indexOf("Source"), length: 6 },
        ] },
      } : message));
    telegramStore.setState({ messages });
  });
  const latest = page.locator('[data-message-id="p-video"]');
  await expect(latest.locator(".photo-caption-flow .rich-blockquote")).toBeVisible();
  await list.press("End");
  await page.waitForTimeout(500);

  const rowGaps = await list.evaluate(element => {
    const rows = [...element.querySelectorAll(".message-list-content > [data-index]")]
      .map(row => row.getBoundingClientRect());
    return rows.slice(1).map((row, index) => row.top - rows[index].bottom);
  });
  expect(rowGaps.length).toBeGreaterThan(2);
  expect(Math.max(...rowGaps.map(Math.abs)), JSON.stringify(rowGaps)).toBeLessThanOrEqual(0.5);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await list.evaluate(element => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      element.scrollTop = 100;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(page.locator(".jump-to-latest")).toBeVisible();
    const samples = await page.evaluate(async () => {
      const element = document.querySelector<HTMLElement>(".message-list")!;
      const read = () => {
        const latest = element.querySelector('[data-message-id="p-video"]');
        const rowBounds = latest?.getBoundingClientRect();
        const listBounds = element.getBoundingClientRect();
        return {
          distance: element.scrollHeight - element.clientHeight - element.scrollTop,
          gap: rowBounds ? listBounds.bottom - rowBounds.bottom : null,
          visible: Boolean(rowBounds && rowBounds.top < listBounds.bottom && rowBounds.bottom > listBounds.top),
        };
      };
      const samples: Array<ReturnType<typeof read>> = [];
      const started = performance.now();
      document.querySelector<HTMLButtonElement>(".jump-to-latest")!.click();
      while (performance.now() - started < 1200) {
        await new Promise<void>(resolve => requestAnimationFrame(() => { setTimeout(resolve, 0); }));
        samples.push(read());
      }
      return samples;
    });
    const visible = samples.filter(sample => sample.visible && sample.gap !== null);
    const rebounds = visible.slice(1).map((sample, index) => visible[index].gap! - sample.gap!)
      .filter(delta => delta > 2);
    expect(rebounds, JSON.stringify(samples)).toHaveLength(0);
    expect(samples.at(-1)!.distance).toBeLessThanOrEqual(1);
    expect(samples.at(-1)!.gap).toBeGreaterThanOrEqual(10);
    expect(samples.at(-1)!.gap).toBeLessThanOrEqual(13);
    expect(await latest.locator(".message-meta").evaluate(meta =>
      document.querySelector(".composer")!.getBoundingClientRect().top - meta.getBoundingClientRect().bottom,
    )).toBeGreaterThanOrEqual(10);
  }
});
