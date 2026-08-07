const endpoint = process.env.NOTGRAM_WEBVIEW_ENDPOINT ?? "http://127.0.0.1:9333";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(payload.error.message));
      else pending.resolve(payload.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(socket);
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const listTargets = async () => fetch(`${endpoint}/json/list`).then((response) => response.json());

const waitFor = async (callback, label) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const mainTarget = await waitFor(async () => {
  const targets = await listTargets();
  return targets.find((target) => target.type === "page" &&
    target.webSocketDebuggerUrl && !new URL(target.url).search);
}, "the main Notgram WebView");
const main = await CdpClient.connect(mainTarget.webSocketDebuggerUrl);
const evaluate = async (client, expression) => {
  const response = await client.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? "WebView evaluation failed");
  }
  return response.result.value;
};

try {
  await main.call("Page.navigate", {
    url: new URL("?settingsWindow=1", mainTarget.url).href,
  });
  const settings = main;
  await waitFor(() => evaluate(settings,
    "document.querySelectorAll('.settings-category').length >= 7"), "settings categories");
  await evaluate(settings, `(() => {
    const privacyCategory = document.querySelectorAll(".settings-category")[6];
    if (!(privacyCategory instanceof HTMLButtonElement)) throw new Error("Privacy category is unavailable");
    privacyCategory.click();
    return true;
  })()`);
  await waitFor(() => evaluate(settings,
    "document.querySelectorAll('.privacy-rule-row select').length === 6"), "privacy controls");

  const result = await evaluate(settings, `(() => {
    const select = document.querySelector(".privacy-rule-row select");
    if (!(select instanceof HTMLSelectElement)) throw new Error("Privacy select is unavailable");
    const before = select.value;
    const next = before === "allowAll" ? "restrictAll" : "allowAll";
    select.value = next;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { before, next, controlCount: document.querySelectorAll(".privacy-rule-row select").length };
  })()`);
  await waitFor(() => evaluate(settings, `(() => {
    const select = document.querySelector(".privacy-rule-row select");
    return select instanceof HTMLSelectElement && !select.disabled && select.value === ${JSON.stringify(result.next)};
  })()`), "privacy rule persistence");

  console.log(JSON.stringify({
    target: new URL("?settingsWindow=1", mainTarget.url).href,
    controlCount: result.controlCount,
    previousValue: result.before,
    persistedValue: result.next,
  }, null, 2));
} finally {
  main.close();
}
