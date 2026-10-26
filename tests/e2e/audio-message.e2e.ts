import { expect, test, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

async function audioMessage(page: Page) {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
  await page.evaluate(async ({ storePath, mapperPath }) => {
    const { telegramStore } = await import(storePath);
    const { mapTdMessageContent } = await import(mapperPath);
    const state = telegramStore.getState() as { messages: Map<string, Message[]> };
    const messages = new Map(state.messages);
    const content = mapTdMessageContent({ "@type": "messageAudio", audio: {
      file_name: "track.mp3", title: "A long song title ".repeat(12), performer: "An artist name ".repeat(12),
      duration: 150, mime_type: "audio/mpeg", audio: { id: 4242, size: 2_400_000,
        local: { path: "/mock-video.mp4", is_downloading_completed: true } },
    }, caption: { text: "Audio description" } });
    messages.set("chat-product", (messages.get("chat-product") ?? []).map(message =>
      message.id === "p-video" ? { ...message, content } : message));
    telegramStore.setState({ messages });
    // Keep playback events deterministic while the existing decoder fixture loads.
    HTMLMediaElement.prototype.play = function () {
      Object.defineProperty(this, "paused", { configurable: true, value: false });
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      Object.defineProperty(this, "paused", { configurable: true, value: true });
      this.dispatchEvent(new Event("pause"));
    };
  }, { storePath: "/src/store/telegramStore.ts", mapperPath: "/src/telegram/tdlibMapper.ts" });
  return page.getByRole("log").locator('[data-message-id="p-video"]');
}

test("audio CD follows play and pause and respects both reduced motion preferences", async ({ page }) => {
  const row = await audioMessage(page);
  const player = row.locator(".audio-player");
  const disc = player.locator(".audio-disc");
  await expect(player.locator(".audio-quality")).toHaveText("≈128K");
  await expect(player.locator(".audio-quality")).toHaveAttribute("title", "估算平均码率：128 kbps");
  await expect(disc).toHaveCSS("animation-play-state", "paused");
  await player.getByRole("button", { name: "播放 track.mp3" }).click();
  await expect(disc).toHaveCSS("animation-play-state", "running");
  await player.getByRole("button", { name: "暂停 track.mp3" }).click();
  await expect(disc).toHaveCSS("animation-play-state", "paused");
  await player.getByRole("button", { name: "播放 track.mp3" }).click();
  await expect(disc).toHaveCSS("animation-play-state", "running");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(disc).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("html").evaluate(element => element.classList.add("reduce-motion"));
  await expect(disc).toHaveCSS("animation-name", "none");
  await player.getByRole("button", { name: "暂停 track.mp3" }).click();
  await expect(player.getByRole("button", { name: "播放 track.mp3" })).toBeVisible();
});

test("audio metadata and download controls fit a narrow zoomed message with an inset caption divider", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const row = await audioMessage(page);
  await page.locator("html").evaluate(element => {
    element.dataset.theme = "notgram-dark";
    element.style.zoom = "1.25";
  });
  await page.evaluate(async storePath => {
    const { telegramStore } = await import(storePath);
    const state = telegramStore.getState() as { messages: Map<string, Message[]> };
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map(message =>
      message.id === "p-video" ? { ...message, content: { ...message.content,
        isDownloaded: false, canDownload: true, isDownloading: true, progress: 0.5 } } : message));
    telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");
  const player = row.locator(".audio-player");
  await expect(player.getByRole("button", { name: "取消下载 track.mp3" })).toBeVisible();
  await expect(player.locator("strong")).toHaveCSS("text-overflow", "ellipsis");
  await expect(player.locator(".audio-player-artist")).toHaveText("An artist name ".repeat(12).trim());
  await expect.poll(() => player.evaluate(element => {
    const parent = element.getBoundingClientRect();
    return [...element.querySelectorAll("button, input, .audio-disc, .audio-quality, .audio-volume-value")]
      .every(child => {
        const bounds = child.getBoundingClientRect();
        return bounds.left >= parent.left - 0.5 && bounds.right <= parent.right + 0.5;
      });
  })).toBe(true);
  const caption = row.locator(".attachment-caption");
  await expect(caption).toHaveText("Audio description");
  const divider = await caption.evaluate(element => {
    const style = getComputedStyle(element, "::before");
    return { left: parseFloat(style.left), right: parseFloat(style.right), height: style.height };
  });
  expect(divider.left).toBeGreaterThan(0);
  expect(divider.right).toBeGreaterThan(0);
  expect(divider.height).toBe("1px");
});

async function voiceMessages(page: Page, downloadable = false) {
  await audioMessage(page);
  await page.evaluate(async ({ storePath, mapperPath, downloadable }) => {
    const { telegramStore } = await import(storePath);
    const { mapTdMessageContent } = await import(mapperPath);
    const state = telegramStore.getState() as { messages: Map<string, Message[]> };
    const messages = new Map(state.messages);
    const current = messages.get("chat-product") ?? [];
    const template = current.find(message => message.id === "p-video")!;
    const incomingSender = current.find(message => !message.outgoing)!.senderId;
    const samples = Array.from({ length: 100 }, (_, index) => Math.round(3 + 28 * Math.abs(Math.sin(index * 0.37) * Math.cos(index * 0.11))));
    const packWaveform = (amplitudes: number[]) => {
      const packed = new Uint8Array(Math.ceil(amplitudes.length * 5 / 8));
      amplitudes.forEach((value, index) => {
        const bit = index * 5;
        packed[bit >> 3] |= value << (bit & 7);
        if ((bit & 7) > 3) packed[(bit >> 3) + 1] |= value >> (8 - (bit & 7));
      });
      return btoa(String.fromCharCode(...packed));
    };
    const content = mapTdMessageContent({ "@type": "messageVoiceNote", voice_note: {
      duration: 70, waveform: packWaveform(samples), mime_type: "audio/ogg",
      voice: { id: 93, size: 120_000, local: { path: downloadable ? undefined : "/mock-video.mp4",
        can_be_downloaded: true, is_downloading_completed: !downloadable } },
    } });
    messages.set("chat-product", [
      { ...template, outgoing: false, senderId: incomingSender },
      { ...template, id: "p-voice-incoming", renderKey: undefined, outgoing: false, senderId: incomingSender,
        sentAt: "2026-08-01T09:52:00+08:00", content },
      { ...template, id: "p-voice-outgoing", renderKey: undefined,
        sentAt: "2026-08-01T09:53:00+08:00", content: downloadable ? { ...content, duration: 1,
          waveform: packWaveform(Array.from({ length: 100 }, (_, index) =>
            index >= 32 && index <= 47 ? Math.round(2 + 29 * Math.sin((index - 32) / 15 * Math.PI)) : 2)) } : content },
    ]);
    telegramStore.setState({ messages });
  }, { storePath: "/src/store/telegramStore.ts", mapperPath: "/src/telegram/tdlibMapper.ts", downloadable });
  const incoming = page.getByRole("log").locator('[data-message-id="p-voice-incoming"]');
  const outgoing = page.getByRole("log").locator('[data-message-id="p-voice-outgoing"]');
  await expect(incoming.locator(".voice-player")).toBeVisible();
  await expect(outgoing.locator(".voice-player")).toBeVisible();
  return { incoming, outgoing };
}

for (const theme of ["notgram-light", "notgram-dark"]) {
  for (const width of [1366, 390]) {
    test(`voice waveforms preserve message direction and music has its own color at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const { incoming, outgoing } = await voiceMessages(page, true);
      await page.locator("html").evaluate((element, selectedTheme) => {
        element.dataset.theme = selectedTheme;
        if (window.innerWidth < 500) element.style.zoom = "1.25";
      }, theme);
      for (const row of [incoming, outgoing]) {
        const player = row.locator(".voice-player");
        await expect(player.locator(".audio-disc, .audio-quality, .audio-player-artist")).toHaveCount(0);
        await expect(player.locator(".voice-time")).toHaveText(row === outgoing ? "0:01" : "1:10");
        await expect(player.locator(".playback-rate")).toHaveCount(0);
        await expect(player.getByRole("button", { name: "下载 语音消息", exact: true })).toBeVisible();
        await expect(row.locator(".message-meta")).toHaveCount(1);
        await expect(player.locator(".voice-player-meta .message-meta")).toBeVisible();
        expect(await row.locator(".message-bubble").evaluate(element => element.getBoundingClientRect().height /
          (Number(getComputedStyle(document.documentElement).zoom) || 1))).toBeLessThanOrEqual(56);
        await expect(player.locator(".voice-waveform path").first()).toHaveAttribute("d", /v(?!4(?: |$))/);
        await expect(player.getByRole("slider", { name: "播放进度" })).toBeDisabled();
        expect(await row.locator(".message-bubble").evaluate(element => {
          const expected = element.closest(".message-row")!.classList.contains("is-outgoing")
            ? "--color-message-outgoing" : "--color-message-incoming";
          const probe = document.createElement("span");
          probe.style.backgroundColor = `var(${expected})`;
          element.append(probe);
          const matches = getComputedStyle(element).backgroundColor === getComputedStyle(probe).backgroundColor;
          probe.remove();
          return matches;
        })).toBe(true);
        expect(await player.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          return [...element.querySelectorAll("button, input, .voice-time")].every(child => {
            const rect = child.getBoundingClientRect();
            return rect.left >= bounds.left - .5 && rect.right <= bounds.right + .5;
          });
        })).toBe(true);
      }
      const music = page.getByRole("log").locator('[data-message-id="p-video"]');
      await expect(music.locator(".audio-disc")).toBeVisible();
      expect(await music.locator(".message-bubble").evaluate(element => getComputedStyle(element).backgroundColor))
        .not.toBe(await outgoing.locator(".message-bubble").evaluate(element => getComputedStyle(element).backgroundColor));
      await page.locator(".conversation").screenshot({ path: testInfo.outputPath("voice-and-music.png") });
      await outgoing.locator(".message-bubble").screenshot({ path: testInfo.outputPath("short-voice-bubble.png") });
    });
  }
}

test("voice waveform pointer and keyboard seeking share playback, rate and floating voice identity", async ({ page }) => {
  const { incoming } = await voiceMessages(page);
  const player = incoming.locator(".voice-player");
  await player.getByRole("button", { name: "播放 语音消息", exact: true }).click();
  await expect(player.getByRole("button", { name: "暂停 语音消息", exact: true })).toBeVisible();
  const slider = player.getByRole("slider", { name: "播放进度" });
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveAttribute("max", "3");
  await slider.click({ position: { x: (await slider.boundingBox())!.width / 2, y: 18 } });
  await expect.poll(() => slider.inputValue().then(Number)).toBeGreaterThan(1.2);
  await expect.poll(() => slider.inputValue().then(Number)).toBeLessThan(1.8);
  await expect(player.locator(".voice-waveform-played")).not.toHaveCSS("clip-path", "inset(0px 100% 0px 0px)");
  await slider.press("Home");
  await slider.press("ArrowRight");
  await expect.poll(() => slider.inputValue().then(Number)).toBeCloseTo(.1, 1);
  await player.getByRole("button", { name: "播放速度 1 倍" }).click();
  await expect(player.getByRole("button", { name: "播放速度 1.25 倍" })).toBeVisible();
  const floating = page.locator(".audio-floating-controller");
  await expect(floating.locator(".audio-voice-symbol")).toBeVisible();
  await expect(floating.locator(".audio-disc, .audio-quality")).toHaveCount(0);
  await floating.getByRole("button", { name: "缩小播放器" }).click();
  await expect(floating.locator(".audio-voice-symbol")).toHaveCSS("width", "28px");
  await player.getByRole("button", { name: "暂停 语音消息", exact: true }).click();
  await expect(player.getByRole("button", { name: "播放 语音消息", exact: true })).toBeVisible();
});

test("voice notes retain download progress and use a native seek control in forced colors", async ({ page }) => {
  const { incoming } = await voiceMessages(page);
  await page.evaluate(async storePath => {
    const { telegramStore } = await import(storePath);
    const state = telegramStore.getState() as { messages: Map<string, Message[]> };
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map(message =>
      message.id === "p-voice-incoming" ? { ...message, content: { ...message.content,
        localPath: undefined, isDownloaded: false, canDownload: true, isDownloading: true, progress: .45 } } : message));
    // Synthetic message IDs are absent from the transport's own snapshot.
    telegramStore.setState({ messages, cancelFileDownload: async (fileId: number) => {
      document.documentElement.dataset.cancelledVoiceFile = String(fileId);
      const current = telegramStore.getState() as { messages: Map<string, Message[]> };
      const updated = new Map(current.messages);
      updated.set("chat-product", (updated.get("chat-product") ?? []).map(message =>
        message.id === "p-voice-incoming" ? { ...message, content: { ...message.content,
          isDownloading: false, progress: undefined } } : message));
      telegramStore.setState({ messages: updated });
    }, downloadFile: async (fileId: number) => {
      document.documentElement.dataset.downloadedVoiceFile = String(fileId);
      return undefined;
    } });
  }, "/src/store/telegramStore.ts");
  const cancel = incoming.getByRole("button", { name: "取消下载 语音消息" });
  await expect(cancel).toBeVisible();
  await expect(cancel.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "45");
  await cancel.click();
  await expect(page.locator("html")).toHaveAttribute("data-cancelled-voice-file", "93");
  await expect(incoming.getByRole("button", { name: "下载 语音消息", exact: true })).toBeVisible();
  await incoming.getByRole("button", { name: "下载 语音消息", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-downloaded-voice-file", "93");
  await page.emulateMedia({ forcedColors: "active" });
  await expect(incoming.locator(".voice-waveform input")).toHaveCSS("opacity", "1");
  await expect(incoming.locator(".voice-waveform svg").first()).toBeHidden();
});

test("voice fallbacks and rich voice blocks stay distinct from ordinary OGG audio", async ({ page }) => {
  const { incoming, outgoing } = await voiceMessages(page);
  await page.evaluate(async ({ storePath, mapperPath }) => {
    const { telegramStore } = await import(storePath);
    const { mapTdMessageContent } = await import(mapperPath);
    const state = telegramStore.getState() as { messages: Map<string, Message[]> };
    const messages = new Map(state.messages);
    const richVoice = mapTdMessageContent({ "@type": "messageRichMessage", message: {
      "@type": "richMessage", is_full: true, blocks: [{ "@type": "pageBlockVoiceNote", voice_note: {
        duration: 8, waveform: "IIjxISI=", mime_type: "audio/ogg", voice: { id: 4245, size: 12000 },
      }, caption: { text: { "@type": "richTextPlain", text: "Rich voice caption" } } }],
    } });
    messages.set("chat-product", (messages.get("chat-product") ?? []).map(message => {
      if (message.id === "p-voice-incoming") return { ...message, content: { ...message.content,
        waveform: undefined, localPath: undefined, fileId: undefined, size: 0, caption: "Voice caption" } };
      if (message.id === "p-voice-outgoing") return { ...message, content: richVoice };
      return { ...message, content: { ...message.content, fileName: "recording.ogg", mimeType: "audio/ogg" } };
    }));
    telegramStore.setState({ messages });
  }, { storePath: "/src/store/telegramStore.ts", mapperPath: "/src/telegram/tdlibMapper.ts" });
  await expect(incoming.getByRole("button", { name: "语音消息 暂不可播放" })).toBeDisabled();
  const flatPath = await incoming.locator(".voice-waveform path").first().getAttribute("d");
  expect(flatPath?.split(" ").every(segment => /,14v4$/.test(segment))).toBe(true);
  await expect(incoming.locator(".attachment-caption")).toHaveText("Voice caption");
  await expect(outgoing.locator(".rich-media-voice .voice-player")).toBeVisible();
  await expect(outgoing.locator(".rich-media-voice figcaption")).toHaveText("Rich voice caption");
  await expect(outgoing.locator(".audio-disc, .audio-player-artist")).toHaveCount(0);
  const ordinaryAudio = page.getByRole("log").locator('[data-message-id="p-video"]');
  await expect(ordinaryAudio.locator(".audio-disc")).toBeVisible();
  await expect(ordinaryAudio.locator(".voice-player")).toHaveCount(0);
});

test("voice captions and reactions keep one readable timestamp outside the player", async ({ page }) => {
  const { outgoing } = await voiceMessages(page);
  for (const variant of ["caption", "reaction"]) {
    await page.evaluate(async ({ storePath, variant }) => {
      const { telegramStore } = await import(storePath);
      const state = telegramStore.getState() as { messages: Map<string, Message[]> };
      const messages = new Map(state.messages);
      messages.set("chat-product", (messages.get("chat-product") ?? []).map(message => message.id === "p-voice-outgoing"
        ? { ...message, content: { ...message.content, caption: variant === "caption" ? "Voice caption" : undefined },
          interaction: { viewCount: 0, forwardCount: 0, replyCount: 0,
            reactions: variant === "reaction" ? [{ type: { kind: "emoji", emoji: "👍" }, totalCount: 1,
              chosen: false, recentSenderIds: [] }] : [] } }
        : message));
      telegramStore.setState({ messages });
    }, { storePath: "/src/store/telegramStore.ts", variant });
    await expect(outgoing.locator(".message-meta")).toHaveCount(1);
    await expect(outgoing.locator(".message-meta time")).toHaveText("09:53:00");
    await expect(outgoing.locator(".voice-player .message-meta")).toHaveCount(0);
    if (variant === "caption") await expect(outgoing.locator(".attachment-caption")).toHaveText("Voice caption");
    else await expect(outgoing.locator(".message-reactions")).toBeVisible();
  }
});

test("failed voice retry retains its error color and edited details fit a narrow footer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const { outgoing } = await voiceMessages(page);
  await page.evaluate(async storePath => {
    const { telegramStore } = await import(storePath);
    const state = telegramStore.getState() as { messages: Map<string, Message[]> };
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map(message => message.id === "p-voice-outgoing"
      ? { ...message, delivery: "failed", canRetry: true, editedAt: message.sentAt, isPinned: true } : message));
    telegramStore.setState({ messages });
    document.documentElement.dataset.theme = "notgram-dark";
    document.documentElement.style.zoom = "1.25";
  }, "/src/store/telegramStore.ts");
  const retry = outgoing.getByRole("button", { name: "重试发送" });
  await expect(retry).toBeEnabled();
  await expect(retry).toHaveCSS("height", "17px");
  expect(await retry.evaluate(element => {
    const probe = document.createElement("span");
    probe.style.color = "var(--color-status-danger)";
    element.append(probe);
    const matches = getComputedStyle(element).color === getComputedStyle(probe).color;
    probe.remove();
    return matches;
  })).toBe(true);
  await expect(outgoing.locator(".message-meta")).toHaveCount(1);
  await expect(outgoing.locator(".message-meta")).toContainText("已编辑");
  expect(await outgoing.locator(".voice-player").evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll("button, .message-meta")].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= bounds.left - .5 && rect.right <= bounds.right + .5 && rect.bottom <= bounds.bottom + .5;
    });
  })).toBe(true);
});
