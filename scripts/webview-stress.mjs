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
      if (payload.error) pending.reject(new Error(payload.error.message));
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
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
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
        !candidate.url.includes("videoWindow="),
      );
      if (target) return target;
    } catch {
      // The WebView2 runtime may not have opened its DevTools endpoint yet.
    }
    await delay(250);
  }
  throw new Error(`No WebView2 page target appeared at ${endpoint}`);
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

    await click('[data-chat-id="chat-product"]');
    await click('textarea[aria-label="消息内容"]');
    const seedStartedAt = await webviewTimestamp();
    for (let index = 1; index <= options.messages; index += 1) {
      await cdp.call("Input.insertText", { text: `压力测试模拟消息 ${index}` });
      await press("Enter", "Enter", 13);
      if (index % 12 === 0) await frame();
    }
    await delay(750);
    const seedFinishedAt = await webviewTimestamp();
    const seedDom = await evaluate(`({
      activeChatId: document.querySelector('.chat-row.is-active')?.getAttribute('data-chat-id'),
      renderedMessages: document.querySelectorAll('[data-message-id]').length,
      renderedVirtualItems: document.querySelectorAll('.message-list [data-item-index]').length,
    })`);

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

    await click('button[aria-label="设置"]');
    await waitFor("document.querySelector('[role=dialog][aria-labelledby=settings-title]')", "settings dialog");
    await click(".settings-category", "性能监控");
    await waitFor("document.querySelector('.performance-monitor')", "performance monitor");
    await frame();

    const openPhase = {
      name: "timeline-pressure-monitor-open",
      startedAt: await webviewTimestamp(),
      metricsBefore: await metrics(),
    };
    const filterNames = ["全部", "交互", "渲染", "数据", "启动"];
    for (let round = 0; round < options.rounds * 2; round += 1) {
      await click(".performance-filters button", filterNames[round % filterNames.length]);
      if (round % 3 === 0) await wheel(".performance-timeline", round % 2 === 0 ? 420 : -420);
      if (round % 7 === 0) {
        const hasEntry = await evaluate("Boolean(document.querySelector('.performance-entry-main'))");
        if (hasEntry) await click(".performance-entry-main");
      }
      if (round % 12 === 0) await frame();
    }
    await delay(1_000);
    openPhase.finishedAt = await webviewTimestamp();
    openPhase.metricsAfter = await metrics();
    openPhase.dom = await evaluate(`({
      renderedEntries: document.querySelectorAll(".performance-entry").length,
      totalRecordLabel: [...document.querySelectorAll(".performance-summary strong")][0]?.textContent,
      issueLabel: [...document.querySelectorAll(".performance-summary strong")][1]?.textContent,
      blockingLabel: [...document.querySelectorAll(".performance-summary strong")][2]?.textContent,
      slowestLabel: [...document.querySelectorAll(".performance-summary strong")][3]?.textContent,
    })`);
    phases.push(openPhase);

    const finalRecords = await records();
    const report = {
      generatedAt: new Date().toISOString(),
      options,
      target: { title: target.title, type: target.type, url: target.url },
      environment,
      seed: {
        startedAt: seedStartedAt,
        finishedAt: seedFinishedAt,
        requestedMessages: options.messages,
        dom: seedDom,
      },
      phases,
      records: finalRecords,
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      output: options.output,
      recordCount: finalRecords.length,
      issueCount: finalRecords.filter((record) => record.severity !== "normal").length,
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
