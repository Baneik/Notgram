import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9333";
const DEFAULT_MESSAGES = 180;
const DEFAULT_ROUNDS = 80;
const MOCK_CHAT_IDS = ["chat-chen", "chat-mia", "chat-product", "chat-release", "chat-saved"];

const parseArguments = () => {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    values.set(key.slice(2), value);
  }
  return {
    endpoint: values.get("endpoint") ?? DEFAULT_ENDPOINT,
    messages: Number(values.get("messages") ?? DEFAULT_MESSAGES),
    rounds: Number(values.get("rounds") ?? DEFAULT_ROUNDS),
    output: values.get("output") ?? "test-results/webview-stress/report.json",
    messagesOnly: values.get("messages-only") === "true",
  };
};

const delay = (durationMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      if (!payload.id) return;
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(`${payload.error.message} [${pending.expression ?? "unknown expression"}]`));
      else pending.resolve(payload.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("WebView2 DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener("error", rejectOpen, { once: true });
    });
    return new CdpClient(socket);
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, expression: params.expression });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const waitForTarget = async (endpoint) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/list`);
      const targets = await response.json();
      const target = targets.find((candidate) =>
        candidate.type === "page" &&
        candidate.webSocketDebuggerUrl &&
        new URL(candidate.url).search === "",
      );
      if (target) return target;
    } catch {
      // The WebView2 runtime may not have opened its DevTools endpoint yet.
    }
    await delay(250);
  }
  throw new Error(`No WebView2 page target appeared at ${endpoint}`);
};

const waitForSettingsTarget = async (endpoint) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${endpoint}/json/list`);
    const targets = await response.json();
    const target = targets.find((candidate) =>
      candidate.type === "page" &&
      candidate.webSocketDebuggerUrl &&
      new URL(candidate.url).searchParams.get("settingsWindow") === "1",
    );
    if (target) return target;
    await delay(100);
  }
  throw new Error("No standalone settings WebView appeared");
};

const main = async () => {
  const options = parseArguments();
  const outputPath = resolve(options.output);
  if (!Number.isInteger(options.messages) || options.messages < 0) {
    throw new Error("--messages must be a non-negative integer");
  }
  if (!Number.isInteger(options.rounds) || options.rounds < 1) {
    throw new Error("--rounds must be a positive integer");
  }

  const target = await waitForTarget(options.endpoint);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  const evaluate = async (expression) => {
    const result = await cdp.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "Runtime evaluation failed");
    }
    return result.result.value;
  };
  const waitFor = async (expression, label) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const frame = () => evaluate("new Promise((resolve) => requestAnimationFrame(() => resolve(true)))");
  const elementPoint = async (selector, text) => evaluate(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = ${text === undefined
      ? "candidates[0]"
      : `candidates.find((candidate) => candidate.textContent?.includes(${JSON.stringify(text)}))`};
    if (!(element instanceof HTMLElement)) return undefined;
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return undefined;
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  })()`);
  const click = async (selector, text) => {
    const point = await elementPoint(selector, text);
    if (!point) throw new Error(`Unable to click ${selector}${text ? ` containing ${text}` : ""}`);
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...point,
    });
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...point,
    });
  };
  const key = async (type, keyValue, code, modifiers = 0, virtualKeyCode = 0) => {
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: keyValue,
      code,
      modifiers,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
    });
  };
  const press = async (keyValue, code, virtualKeyCode, modifiers = 0) => {
    await key("keyDown", keyValue, code, modifiers, virtualKeyCode);
    await key("keyUp", keyValue, code, modifiers, virtualKeyCode);
  };
  const replaceText = async (value) => {
    await press("a", "KeyA", 65, 2);
    await press("Backspace", "Backspace", 8);
    if (value) await cdp.call("Input.insertText", { text: value });
  };
  const wheel = async (selector, deltaY) => {
    const point = await elementPoint(selector);
    if (!point) return;
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      deltaX: 0,
      deltaY,
      ...point,
    });
  };
  const metrics = async () => {
    const result = await cdp.call("Performance.getMetrics");
    return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
  };
  const webviewTimestamp = () => evaluate("Date.now()");
  const records = () => evaluate(`location.hostname === "127.0.0.1"
    ? import("/src/utils/performanceMonitor.ts")
        .then((module) => module.getPerformanceRecords())
        .catch(() => [])
    : []`);

  try {
    await cdp.call("Runtime.enable");
    await cdp.call("Page.bringToFront");
    await cdp.call("Performance.enable", { timeDomain: "timeTicks" });
    await waitFor(
      "document.readyState === 'complete' && document.querySelectorAll('.chat-row').length >= 5 && document.querySelector('.message-list')",
      "the mock chat interface",
    );

    const environment = await evaluate(`({
      title: document.title,
      url: location.href,
      userAgent: navigator.userAgent,
      hasTauriRuntime: "__TAURI_INTERNALS__" in window,
      supportedEntryTypes: PerformanceObserver.supportedEntryTypes ?? [],
      chatCount: document.querySelectorAll(".chat-row").length,
      chatIds: [...document.querySelectorAll(".chat-row[data-chat-id]")]
        .map((element) => element.getAttribute("data-chat-id"))
        .filter(Boolean)
        .sort(),
      initialMessageCount: document.querySelectorAll("[data-message-id]").length,
    })`);
    if (!environment.hasTauriRuntime) {
      throw new Error("The target is not running inside Tauri/WebView2");
    }
    if (JSON.stringify(environment.chatIds) !== JSON.stringify(MOCK_CHAT_IDS)) {
      throw new Error("Refusing to run: the WebView does not contain the exact mock fixture chats");
    }

    await evaluate(`(() => {
      const monitor = {
        running: true,
        phase: "seed",
        frames: 0,
        blankFrames: 0,
        protectedEmptyFrames: 0,
        unbackedProtectedEmptyFrames: 0,
        protectedEmptyFrameDetails: [],
        unbackedProtectedEmptyFrameDetails: [],
        duplicateIdFrames: 0,
        bottomRebounds: 0,
        blankFrameDetails: [],
        bottomReboundDetails: [],
        animationStarts: {},
        lastSeedFrame: undefined,
      };
      globalThis.__notgramMessageMonitor = monitor;
      document.addEventListener("animationstart", (event) => {
        if (!monitor.running || !event.animationName.startsWith("message-enter-")) return;
        const row = event.target instanceof Element
          ? event.target.closest("[data-message-id]")
          : undefined;
        const id = row?.getAttribute("data-message-id");
        if (id) monitor.animationStarts[id] = (monitor.animationStarts[id] ?? 0) + 1;
      }, true);
      const sample = () => {
        if (!monitor.running) return;
        monitor.frames += 1;
        const list = document.querySelector(".message-list");
        const activeChatId = document.querySelector(".chat-row.is-active")
          ?.getAttribute("data-chat-id");
        const rows = list ? [...list.querySelectorAll("[data-message-id]")] : [];
        const ids = rows.map((row) => row.getAttribute("data-message-id")).filter(Boolean);
        const shell = list?.closest(".message-list-shell");
        const hasSwitchSnapshot = Boolean(document.querySelector("[data-conversation-switch-snapshot]"));
        const hasPositioningPlaceholder = Boolean(document.querySelector(".message-positioning-placeholder"));
        const hasEmptyState = Boolean(document.querySelector(".messages-empty"));
        const hasRowProtection = shell?.dataset.conversationRows === "empty";
        const covered = hasSwitchSnapshot || hasPositioningPlaceholder || hasEmptyState || hasRowProtection;
        if (list && activeChatId && rows.length === 0 && hasRowProtection) {
          monitor.protectedEmptyFrames += 1;
          if (!hasSwitchSnapshot && !hasPositioningPlaceholder && !hasEmptyState) {
            monitor.unbackedProtectedEmptyFrames += 1;
            if (monitor.unbackedProtectedEmptyFrameDetails.length < 12) {
              monitor.unbackedProtectedEmptyFrameDetails.push({
                phase: monitor.phase,
                activeChatId,
                busy: list.getAttribute("aria-busy"),
                scrollTop: list.scrollTop,
                scrollHeight: list.scrollHeight,
                clientHeight: list.clientHeight,
                virtuosoKey: list.dataset.conversationVirtuosoKey,
              });
            }
          }
          if (monitor.protectedEmptyFrameDetails.length < 12) {
            monitor.protectedEmptyFrameDetails.push({
              phase: monitor.phase,
              activeChatId,
              hasSwitchSnapshot,
              hasPositioningPlaceholder,
              hasEmptyState,
              busy: list.getAttribute("aria-busy"),
              virtuosoKey: list.dataset.conversationVirtuosoKey,
            });
          }
        }
        if (list && activeChatId && rows.length === 0 && !covered) {
          monitor.blankFrames += 1;
          if (monitor.blankFrameDetails.length < 12) {
            monitor.blankFrameDetails.push({
              phase: monitor.phase,
              activeChatId,
              scrollTop: list.scrollTop,
              scrollHeight: list.scrollHeight,
              clientHeight: list.clientHeight,
              busy: list.getAttribute("aria-busy"),
              shellPositioning: list.closest(".message-list-shell")?.classList.contains("is-positioning"),
              conversationClass: list.closest(".conversation")?.className,
              searchOpen: Boolean(document.querySelector(".conversation.has-message-search")),
              searchValue: document.querySelector(".message-search-row input")?.value,
              virtualItems: list.querySelectorAll("[data-item-index]").length,
              virtuosoKey: list.dataset.conversationVirtuosoKey,
            });
          }
        }
        if (new Set(ids).size !== ids.length) monitor.duplicateIdFrames += 1;
        if (monitor.phase === "seed" && list && activeChatId === "chat-product") {
          const frameState = {
            scrollTop: list.scrollTop,
            distanceBottom: Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop),
          };
          if (
            !covered &&
            monitor.lastSeedFrame?.distanceBottom <= 32 &&
            frameState.distanceBottom <= 32 &&
            frameState.scrollTop < monitor.lastSeedFrame.scrollTop - 0.5
          ) {
            monitor.bottomRebounds += 1;
            if (monitor.bottomReboundDetails.length < 12) {
              monitor.bottomReboundDetails.push({
                previous: monitor.lastSeedFrame,
                current: frameState,
                rowCount: rows.length,
                busy: list.getAttribute("aria-busy"),
                covered,
              });
            }
          }
          monitor.lastSeedFrame = frameState;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return true;
    })()`);

    await click('[data-chat-id="chat-product"]');
    await click('textarea[aria-label="消息内容"]');
    await replaceText("");
    const seedRunId = String(await webviewTimestamp());
    const seedPrefix = `压力测试模拟消息 ${seedRunId}`;
    const seedStartedAt = await webviewTimestamp();
    for (let index = 1; index <= options.messages; index += 1) {
      await cdp.call("Input.insertText", { text: `${seedPrefix} ${index}` });
      await press("Enter", "Enter", 13);
      if (index % 12 === 0) await frame();
    }
    await delay(750);
    const seedFinishedAt = await webviewTimestamp();
    const seedDom = await evaluate(`import("/src/store/telegramStore.ts").then(({ telegramStore }) => {
      const chatMessages = telegramStore.getState().messages.get("chat-product") ?? [];
      const matching = chatMessages
        .filter((message) => message.content.kind === "text" &&
          message.content.text.startsWith(${JSON.stringify(seedPrefix)}));
      const matchingAcrossChats = [...telegramStore.getState().messages.entries()]
        .flatMap(([chatId, messages]) => messages
          .filter((message) => message.content.kind === "text" &&
            message.content.text.startsWith(${JSON.stringify(seedPrefix)}))
          .map((message) => ({ chatId, id: message.id, text: message.content.text })));
      return {
        activeChatId: document.querySelector(".chat-row.is-active")?.getAttribute("data-chat-id"),
        activeElement: document.activeElement?.tagName,
        composerValue: document.querySelector('textarea[aria-label="消息内容"]')?.value,
        composerBusy: document.querySelector('textarea[aria-label="消息内容"]')?.getAttribute("aria-busy"),
        renderedMessages: document.querySelectorAll("[data-message-id]").length,
        renderedVirtualItems: document.querySelectorAll(".message-list [data-item-index]").length,
        totalStoreMessages: chatMessages.length,
        recentTextMessages: chatMessages
          .filter((message) => message.content.kind === "text")
          .slice(-5)
          .map((message) => ({ id: message.id, text: message.content.text })),
        matchingAcrossChats,
        messageCounts: Object.fromEntries([...telegramStore.getState().messages.entries()]
          .map(([chatId, messages]) => [chatId, messages.length])),
        matchingStoreMessages: matching.length,
        uniqueStoreMessageIds: new Set(matching.map((message) => message.id)).size,
        removingMessages: (telegramStore.getState().removingMessages.get("chat-product") ?? []).length,
        awaitingEntranceRows: document.querySelectorAll(".is-awaiting-entrance").length,
      };
    })`);
    await evaluate(`globalThis.__notgramMessageMonitor.phase = "switching"`);

    if (
      seedDom.matchingStoreMessages !== options.messages ||
      seedDom.uniqueStoreMessageIds !== options.messages ||
      seedDom.removingMessages !== 0 ||
      seedDom.awaitingEntranceRows !== 0
    ) {
      throw new Error(`Message seed invariant failed: ${JSON.stringify(seedDom)}`);
    }

    const mixedRunId = `${seedRunId}-mixed`;
    const sendMixedText = async (index) => {
      await click('textarea[aria-label="消息内容"]');
      await replaceText(`WebView mixed outgoing ${mixedRunId} ${index}`);
      await press("Enter", "Enter", 13);
    };
    const dispatchIncoming = async (index, contentKind) => evaluate(`import("/src/telegram/mockData.ts").then(({ mockSnapshot }) => {
      const dispatch = globalThis.__notgramWebviewStressDispatch;
      if (typeof dispatch !== "function") throw new Error("WebView stress dispatcher is unavailable");
      const source = mockSnapshot.messages.find((message) =>
        message.chatId === "chat-product" && message.content.kind === ${JSON.stringify(contentKind)} &&
        (${JSON.stringify(contentKind)} !== "media" || message.content.mediaType === "photo"),
      );
      if (!source) throw new Error("Missing mock source for " + ${JSON.stringify(contentKind)});
      const id = ${JSON.stringify(mixedRunId)} + "-incoming-" + ${index};
      dispatch({
        type: "message.upsert",
        animateEntrance: true,
        message: {
          ...structuredClone(source),
          id,
          chatId: "chat-product",
          senderId: "u-mia",
          outgoing: false,
          sentAt: new Date(Date.now() + ${index} * 1_000).toISOString(),
          delivery: "read",
          mediaAlbumId: undefined,
          replyTo: ${JSON.stringify(contentKind)} === "media"
            ? { kind: "message", chatId: "chat-product", messageId: "p-4" }
            : source.replyTo,
          content: source.content.kind === "text"
            ? { kind: "text", text: "WebView mixed incoming " + ${JSON.stringify(mixedRunId)} + " " + ${index} }
            : structuredClone(source.content),
        },
      });
      return id;
    })`);
    const sendMixedPhoto = async (index) => evaluate(`import("/src/store/telegramStore.ts").then(async ({ telegramStore }) => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="900" height="1200" fill="#2c8f86"/><rect x="90" y="90" width="720" height="1020" fill="#ecf3f1"/></svg>';
      const fileName = ${JSON.stringify(mixedRunId)} + "-outgoing-" + ${index} + ".svg";
      const file = new File([svg], fileName, { type: "image/svg+xml" });
      const sent = await telegramStore.getState().sendFiles([{
        file,
        kind: "photo",
        width: ${index} % 2 === 0 ? 900 : 1500,
        height: ${index} % 2 === 0 ? 1200 : 720,
      }], "WebView mixed photo " + ${JSON.stringify(mixedRunId)} + " " + ${index});
      if (!sent) throw new Error("Unable to send mixed photo");
      return fileName;
    })`);

    const incomingContentKinds = ["text", "media", "service", "rich"];
    for (let index = 0; index < 12; index += 1) {
      if (index % 3 === 0) {
        await dispatchIncoming(index, incomingContentKinds[index / 3]);
      } else if (index % 3 === 1) {
        await sendMixedPhoto(index);
      } else {
        await sendMixedText(index);
      }
      await frame();
    }
    await delay(750);
    const mixedDom = await evaluate(`import("/src/store/telegramStore.ts").then(({ telegramStore }) => {
      const messages = telegramStore.getState().messages.get("chat-product") ?? [];
      const incoming = messages.filter((message) => message.id.startsWith(${JSON.stringify(mixedRunId)} + "-incoming-"));
      const outgoingPhotos = messages.filter((message) => message.outgoing &&
        message.content.kind === "media" &&
        message.content.fileName.startsWith(${JSON.stringify(mixedRunId)} + "-outgoing-"));
      const outgoingTexts = messages.filter((message) => message.outgoing &&
        message.content.kind === "text" &&
        message.content.text.startsWith("WebView mixed outgoing " + ${JSON.stringify(mixedRunId)}));
      const incomingMediaReplies = incoming.filter((message) =>
        message.content.kind === "media" && message.replyTo?.kind === "message");
      return {
        incomingCount: incoming.length,
        incomingKinds: [...new Set(incoming.map((message) => message.content.kind))].sort(),
        outgoingPhotoCount: outgoingPhotos.length,
        outgoingTextCount: outgoingTexts.length,
        incomingMediaReplyCount: incomingMediaReplies.length,
        uniqueIds: new Set([...incoming, ...outgoingPhotos, ...outgoingTexts].map((message) => message.id)).size,
        removingMessages: (telegramStore.getState().removingMessages.get("chat-product") ?? []).length,
        awaitingEntranceRows: document.querySelectorAll(".is-awaiting-entrance").length,
      };
    })`);
    if (
      mixedDom.incomingCount !== 4 ||
      JSON.stringify(mixedDom.incomingKinds) !== JSON.stringify(["media", "rich", "service", "text"]) ||
      mixedDom.outgoingPhotoCount !== 4 ||
      mixedDom.outgoingTextCount !== 4 ||
      mixedDom.incomingMediaReplyCount !== 1 ||
      mixedDom.uniqueIds !== 12 ||
      mixedDom.removingMessages !== 0 ||
      mixedDom.awaitingEntranceRows !== 0
    ) {
      throw new Error(`Mixed message invariant failed: ${JSON.stringify(mixedDom)}`);
    }

    const mixedReplyMessageId = `${mixedRunId}-incoming-3`;
    await evaluate(`(() => {
      globalThis.dispatchEvent(new CustomEvent("notgram:telegram-link-opened", {
        detail: { chatId: "chat-product", messageId: ${JSON.stringify(mixedReplyMessageId)} },
      }));
      return true;
    })()`);
    await waitFor(`document.querySelector('[data-message-id=${JSON.stringify(mixedReplyMessageId)}]')`,
      "the mixed media reply");
    await frame();
    const mixedReplyDom = await evaluate(`(() => {
      const row = document.querySelector('[data-message-id=${JSON.stringify(mixedReplyMessageId)}]');
      const bubble = row?.querySelector(".message-bubble.is-photo.has-reply");
      const reply = bubble?.querySelector(".message-reply-preview");
      return {
        rendered: Boolean(row),
        replyInsideBubble: Boolean(bubble && reply && bubble.contains(reply)),
        wholeRowHighlighted: row?.classList.contains("is-notification-target") === true,
      };
    })()`);
    if (!mixedReplyDom.rendered || !mixedReplyDom.replyInsideBubble || !mixedReplyDom.wholeRowHighlighted) {
      throw new Error(`Mixed media reply invariant failed: ${JSON.stringify(mixedReplyDom)}`);
    }

    const phases = [];
    const closedPhase = {
      name: "chat-pressure-monitor-closed",
      startedAt: await webviewTimestamp(),
      metricsBefore: await metrics(),
    };
    const chatIds = ["chat-product", "chat-mia", "chat-saved", "chat-chen", "chat-release"];
    for (let round = 0; round < options.rounds; round += 1) {
      await click(`[data-chat-id="${chatIds[round % chatIds.length]}"]`);
      await wheel(".message-list", round % 2 === 0 ? -560 : 560);
      if (round % 8 === 0) {
        await press("k", "KeyK", 75, 2);
        await delay(25);
        await click('.search-field input[type="search"]');
        await cdp.call("Input.insertText", { text: round % 16 === 0 ? "产品讨论历史消息" : "压力测试模拟消息" });
        await frame();
        await replaceText("");
        await press("Escape", "Escape", 27);
      }
      if (round % 10 === 0) await frame();
    }
    await delay(1_000);
    closedPhase.finishedAt = await webviewTimestamp();
    closedPhase.metricsAfter = await metrics();
    closedPhase.dom = await evaluate(`({
      activeChatId: document.querySelector(".chat-row.is-active")?.getAttribute("data-chat-id"),
      renderedMessages: document.querySelectorAll("[data-message-id]").length,
      performanceEntries: document.querySelectorAll(".performance-entry").length,
    })`);
    phases.push(closedPhase);

    await click('[data-chat-id="chat-product"]');
    await waitFor(`(() => {
      const list = document.querySelector(".message-list");
      return document.querySelector('.chat-row.is-active')?.getAttribute('data-chat-id') === "chat-product" &&
        list?.getAttribute("aria-busy") === "false" &&
        Boolean(list.querySelector("[data-message-id]"));
    })()`, "stable chat-product message list");
    await delay(120);
    await click('[data-chat-id="chat-product"]');
    await waitFor(`(() => {
      const list = document.querySelector(".message-list");
      return list && Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop) <= 0.5;
    })()`, "the selected conversation to converge to its latest message");
    const bottomBoundaryStart = await evaluate(`(() => {
      const list = document.querySelector(".message-list");
      return {
        scrollTop: list.scrollTop,
        distanceBottom: Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop),
      };
    })()`);
    if (bottomBoundaryStart.distanceBottom > 0.5) {
      throw new Error(`Bottom wheel precondition failed: ${JSON.stringify(bottomBoundaryStart)}`);
    }
    const bottomBoundarySamples = [];
    for (let index = 0; index < 12; index += 1) {
      await wheel(".message-list", 480);
      await frame();
      bottomBoundarySamples.push(await evaluate(`(() => {
        const list = document.querySelector(".message-list");
        return {
          scrollTop: list.scrollTop,
          distanceBottom: Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop),
        };
      })()`));
    }
    const bottomBoundary = {
      start: bottomBoundaryStart,
      samples: bottomBoundarySamples,
      scrollTopSpread: Math.max(...bottomBoundarySamples.map(({ scrollTop }) => scrollTop)) -
        Math.min(...bottomBoundarySamples.map(({ scrollTop }) => scrollTop)),
      maximumBottomDistance: Math.max(...bottomBoundarySamples.map(({ distanceBottom }) => distanceBottom)),
    };
    if (bottomBoundary.scrollTopSpread > 0.5 || bottomBoundary.maximumBottomDistance > 0.5) {
      throw new Error(`Bottom wheel boundary moved: ${JSON.stringify(bottomBoundary)}`);
    }

    await click('[data-chat-id="chat-mia"]');
    await waitFor(`(() => {
      const list = document.querySelector(".message-list");
      return document.querySelector('.chat-row.is-active')?.getAttribute('data-chat-id') === "chat-mia" &&
        list?.getAttribute("aria-busy") === "false";
    })()`, "the intermediate conversation");
    await click('[data-chat-id="chat-product"]');
    await waitFor(`(() => {
      const list = document.querySelector(".message-list");
      return document.querySelector('.chat-row.is-active')?.getAttribute('data-chat-id') === "chat-product" &&
        list?.getAttribute("aria-busy") === "false" && Boolean(list.querySelector("[data-message-id]"));
    })()`, "the restored latest position");
    await waitFor(`(() => {
      const list = document.querySelector(".message-list");
      return list && Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop) <= 0.5;
    })()`, "the restored bottom boundary");
    const bottomRestore = await evaluate(`(() => {
      const list = document.querySelector(".message-list");
      return {
        scrollTop: list.scrollTop,
        distanceBottom: Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop),
      };
    })()`);
    if (bottomRestore.distanceBottom > 0.5) {
      throw new Error(`Latest position was not restored: ${JSON.stringify(bottomRestore)}`);
    }

    if (!options.messagesOnly) {
      await click('button[aria-label="设置"]');
      const settingsTarget = await waitForSettingsTarget(options.endpoint);
      const settingsCdp = await CdpClient.connect(settingsTarget.webSocketDebuggerUrl);
      const settingsEvaluate = async (expression) => {
        const result = await settingsCdp.call("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description ?? "Settings evaluation failed");
        }
        return result.result.value;
      };
      const waitForSettings = async (expression, label) => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (await settingsEvaluate(`Boolean(${expression})`)) return;
          await delay(100);
        }
        throw new Error(`Timed out waiting for ${label}`);
      };
      const settingsElementPoint = async (selector, text) => settingsEvaluate(`(() => {
        const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const element = ${text === undefined
          ? "candidates[0]"
          : `candidates.find((candidate) => candidate.textContent?.includes(${JSON.stringify(text)}))`};
        if (!(element instanceof HTMLElement)) return undefined;
        element.scrollIntoView({ block: "nearest", inline: "nearest" });
        const bounds = element.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return undefined;
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      })()`);
      const settingsClick = async (selector, text) => {
        const point = await settingsElementPoint(selector, text);
        if (!point) throw new Error(`Unable to click settings ${selector}`);
        await settingsCdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        await settingsCdp.call("Input.dispatchMouseEvent", {
          type: "mousePressed", button: "left", clickCount: 1, ...point,
        });
        await settingsCdp.call("Input.dispatchMouseEvent", {
          type: "mouseReleased", button: "left", clickCount: 1, ...point,
        });
      };
      const settingsWheel = async (selector, deltaY) => {
        const point = await settingsElementPoint(selector);
        if (!point) return;
        await settingsCdp.call("Input.dispatchMouseEvent", {
          type: "mouseWheel", deltaX: 0, deltaY, ...point,
        });
      };
      const settingsFrame = () => settingsEvaluate(
        "new Promise((resolve) => requestAnimationFrame(() => resolve(true)))",
      );
      await settingsCdp.call("Runtime.enable");
      await settingsCdp.call("Page.bringToFront");
      await waitForSettings(
        "document.querySelector('[role=dialog][aria-labelledby=settings-title]')",
        "standalone settings dialog",
      );
      await settingsClick(".settings-category", "性能监控");
      await waitForSettings("document.querySelector('.performance-monitor')", "performance monitor");
      await settingsFrame();

      const openPhase = {
        name: "timeline-pressure-monitor-open",
        startedAt: await webviewTimestamp(),
        metricsBefore: await metrics(),
      };
      const filterNames = ["全部", "交互", "渲染", "数据", "启动"];
      for (let round = 0; round < options.rounds * 2; round += 1) {
        await settingsClick(".performance-filters button", filterNames[round % filterNames.length]);
        if (round % 3 === 0) {
          await settingsWheel(".performance-timeline", round % 2 === 0 ? 420 : -420);
        }
        if (round % 7 === 0) {
          const hasEntry = await settingsEvaluate(
            "Boolean(document.querySelector('.performance-entry-main'))",
          );
          if (hasEntry) await settingsClick(".performance-entry-main");
        }
        if (round % 12 === 0) await settingsFrame();
      }
      await delay(1_000);
      openPhase.finishedAt = await webviewTimestamp();
      openPhase.metricsAfter = await metrics();
      openPhase.dom = await settingsEvaluate(`({
        renderedEntries: document.querySelectorAll(".performance-entry").length,
        totalRecordLabel: [...document.querySelectorAll(".performance-summary strong")][0]?.textContent,
        issueLabel: [...document.querySelectorAll(".performance-summary strong")][1]?.textContent,
        blockingLabel: [...document.querySelectorAll(".performance-summary strong")][2]?.textContent,
        slowestLabel: [...document.querySelectorAll(".performance-summary strong")][3]?.textContent,
      })`);
      phases.push(openPhase);
      settingsCdp.close();
    }

    const messageMonitor = await evaluate(`(() => {
      const monitor = globalThis.__notgramMessageMonitor;
      monitor.running = false;
      const counts = Object.values(monitor.animationStarts);
      return {
        frames: monitor.frames,
        blankFrames: monitor.blankFrames,
        protectedEmptyFrames: monitor.protectedEmptyFrames,
        unbackedProtectedEmptyFrames: monitor.unbackedProtectedEmptyFrames,
        protectedEmptyFrameDetails: monitor.protectedEmptyFrameDetails,
        unbackedProtectedEmptyFrameDetails: monitor.unbackedProtectedEmptyFrameDetails,
        duplicateIdFrames: monitor.duplicateIdFrames,
        bottomRebounds: monitor.bottomRebounds,
        blankFrameDetails: monitor.blankFrameDetails,
        bottomReboundDetails: monitor.bottomReboundDetails,
        animatedMessageCount: counts.length,
        maximumAnimationStartsPerMessage: counts.length ? Math.max(...counts) : 0,
      };
    })()`);
    if (
      messageMonitor.blankFrames > 0 ||
      messageMonitor.unbackedProtectedEmptyFrames > 0 ||
      messageMonitor.duplicateIdFrames > 0 ||
      messageMonitor.bottomRebounds > 0 ||
      messageMonitor.maximumAnimationStartsPerMessage > 1 ||
      (options.messages > 0 && messageMonitor.animatedMessageCount === 0)
    ) {
      throw new Error(`Message frame invariant failed: ${JSON.stringify(messageMonitor)}`);
    }
    const finalRecords = await records();
    const report = {
      generatedAt: new Date().toISOString(),
      options,
      target: { title: target.title, type: target.type, url: target.url },
      environment,
      seed: {
        startedAt: seedStartedAt,
        finishedAt: seedFinishedAt,
        runId: seedRunId,
        requestedMessages: options.messages,
        dom: seedDom,
      },
      mixed: {
        runId: mixedRunId,
        dom: mixedDom,
        replyDom: mixedReplyDom,
      },
      messageMonitor,
      bottomBoundary,
      bottomRestore,
      phases,
      records: finalRecords,
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      output: options.output,
      recordCount: finalRecords.length,
      issueCount: finalRecords.filter((record) => record.severity !== "normal").length,
      messageMonitor,
      bottomBoundary: {
        scrollTopSpread: bottomBoundary.scrollTopSpread,
        maximumBottomDistance: bottomBoundary.maximumBottomDistance,
      },
      mixed: mixedDom,
      phases: phases.map((phase) => ({
        name: phase.name,
        durationMs: phase.finishedAt - phase.startedAt,
        dom: phase.dom,
      })),
    }, null, 2));
  } finally {
    cdp.close();
  }
};

await main();
