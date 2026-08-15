import { copyCanvasContents } from "./copyCanvasContents";

export interface ConversationSwitchSnapshot {
  element: HTMLElement;
  content: HTMLElement;
}

let snapshotStyleSheet: CSSStyleSheet | undefined;

const getSnapshotStyleSheet = () => {
  if (snapshotStyleSheet) return snapshotStyleSheet;
  const rules: string[] = [];
  for (const sheet of document.styleSheets) {
    try {
      rules.push(...Array.from(sheet.cssRules, (rule) => rule.cssText));
    } catch {
      // Application styles are same-origin; inaccessible extension styles are irrelevant.
    }
  }
  snapshotStyleSheet = new CSSStyleSheet();
  snapshotStyleSheet.replaceSync(rules.join("\n"));
  return snapshotStyleSheet;
};

export const captureConversationSwitchSnapshot = (
  targetIdentity: string,
): ConversationSwitchSnapshot | undefined => {
  const source = document.querySelector<HTMLElement>(".conversation .message-list-shell");
  const sourceList = source?.querySelector<HTMLElement>(".message-list");
  const messageCount = sourceList?.querySelectorAll("[data-message-id]").length ?? 0;
  if (!source || !sourceList || messageCount === 0) return undefined;

  const bounds = source.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) return undefined;

  const element = document.createElement("div");
  element.className = "conversation-jump-snapshot conversation-switch-snapshot";
  element.dataset.conversationSwitchSnapshot = "true";
  element.dataset.snapshotMessageCount = String(messageCount);
  element.dataset.snapshotTarget = targetIdentity;
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("inert", "");
  Object.assign(element.style, {
    position: "fixed",
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
    zIndex: "69",
    overflow: "hidden",
    pointerEvents: "none",
    contain: "strict",
    background: getComputedStyle(source).getPropertyValue("--chat-canvas"),
  });

  const clone = source.cloneNode(true) as HTMLElement;
  copyCanvasContents(source, clone);
  clone.removeAttribute("id");
  clone.querySelector<HTMLElement>(".message-list-content")?.style.removeProperty("visibility");
  clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  clone.querySelectorAll("button, a, input, textarea, select, [contenteditable='true']")
    .forEach((node) => node.setAttribute("tabindex", "-1"));
  Object.assign(clone.style, {
    width: "100%",
    height: "100%",
    minHeight: "0",
    margin: "0",
    pointerEvents: "none",
  });

  const shadow = element.attachShadow({ mode: "closed" });
  shadow.adoptedStyleSheets = [getSnapshotStyleSheet()];
  const context = document.createElement("div");
  context.className = "conversation-jump-snapshot";
  Object.assign(context.style, {
    width: "100%",
    height: "100%",
    overflow: "hidden",
  });
  context.append(clone);
  shadow.append(context);
  document.body.append(element);

  const cloneList = clone.querySelector<HTMLElement>(".message-list");
  if (cloneList) {
    cloneList.classList.remove("is-jump-transitioning");
    cloneList.scrollTop = sourceList.scrollTop;
    cloneList.scrollLeft = sourceList.scrollLeft;
    const visibleRows = [...cloneList.querySelectorAll<HTMLElement>("[data-message-id]")]
      .filter((row) => {
        const rowBounds = row.getBoundingClientRect();
        const listBounds = cloneList.getBoundingClientRect();
        const style = getComputedStyle(row);
        return rowBounds.bottom > listBounds.top && rowBounds.top < listBounds.bottom &&
          style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
      });
    element.dataset.snapshotVisibleMessageCount = String(visibleRows.length);
  }
  return {
    element,
    content: clone.querySelector<HTMLElement>(".message-list-content") ?? clone,
  };
};

export const removeConversationSwitchSnapshot = (
  snapshot: ConversationSwitchSnapshot | undefined,
) => snapshot?.element.remove();
