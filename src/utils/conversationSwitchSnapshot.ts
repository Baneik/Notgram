let cachedStylesheetText: string | undefined;

const stylesheetText = () => {
  if (cachedStylesheetText !== undefined) return cachedStylesheetText;
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      rules.push(...Array.from(sheet.cssRules, (rule) => rule.cssText));
    } catch {
      // Cross-origin stylesheets cannot be read; the app's own stylesheet is same-origin.
    }
  }
  cachedStylesheetText = rules.join("\n");
  return cachedStylesheetText;
};

export const captureConversationSwitchSnapshot = (): HTMLElement | undefined => {
  const source = document.querySelector<HTMLElement>(".conversation .message-list-shell");
  const sourceList = source?.querySelector<HTMLElement>(".message-list");
  if (!source || !sourceList) return undefined;

  const bounds = source.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) return undefined;

  const host = document.createElement("div");
  host.className = "conversation-switch-snapshot";
  host.dataset.conversationSwitchSnapshot = "true";
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("inert", "");
  Object.assign(host.style, {
    position: "fixed",
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
    zIndex: "70",
    overflow: "hidden",
    pointerEvents: "none",
    contain: "strict",
    background: getComputedStyle(source).backgroundColor,
  });

  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = stylesheetText();
  shadow.append(style);

  const context = document.createElement("div");
  context.className = [
    ...Array.from(document.documentElement.classList),
    ...Array.from(document.body.classList),
  ].join(" ");
  Object.assign(context.style, {
    width: "100%",
    height: "100%",
    overflow: "hidden",
    background: getComputedStyle(source).backgroundColor,
  });

  const clone = source.cloneNode(true) as HTMLElement;
  clone.removeAttribute("id");
  Object.assign(clone.style, {
    width: "100%",
    height: "100%",
    minHeight: "0",
  });
  clone.querySelectorAll(".message-positioning-placeholder").forEach((element) => element.remove());
  clone.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
  clone.querySelectorAll("button, a, input, textarea, select, [contenteditable='true']")
    .forEach((element) => {
      element.setAttribute("tabindex", "-1");
    });
  host.dataset.snapshotMessageCount = String(
    clone.querySelectorAll("[data-message-id]").length,
  );
  context.append(clone);
  shadow.append(context);
  document.body.append(host);

  const cloneList = clone.querySelector<HTMLElement>(".message-list");
  if (cloneList) {
    cloneList.scrollTop = sourceList.scrollTop;
    cloneList.scrollLeft = sourceList.scrollLeft;
  }
  return host;
};

export const removeConversationSwitchSnapshot = (snapshot: HTMLElement | undefined) => {
  snapshot?.remove();
};
