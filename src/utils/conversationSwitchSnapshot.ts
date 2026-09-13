import { getConversationSnapshotStyleSheet } from "./conversationSnapshotStyles";
import { cloneConversationSnapshot, prepareConversationSnapshotClone } from "./conversationSnapshotUtils";

export interface ConversationSwitchSnapshot {
  element: HTMLElement;
  content: HTMLElement;
}

export const captureConversationSwitchSnapshot = (
  targetIdentity: string,
): ConversationSwitchSnapshot | undefined => {
  const source = document.querySelector<HTMLElement>(".conversation .message-list-shell");
  const sourceList = source?.querySelector<HTMLElement>(".message-list");
  const messageCount = sourceList?.querySelectorAll("[data-message-id]").length ?? 0;
  if (!source || !sourceList || messageCount === 0) return undefined;

  const shellBounds = source.getBoundingClientRect();
  const header = source.parentElement?.querySelector<HTMLElement>(".conversation-header");
  const headerBounds = header?.getBoundingClientRect();
  const bounds = { left: shellBounds.left, top: headerBounds?.top ?? shellBounds.top,
    width: shellBounds.width, height: shellBounds.bottom - (headerBounds?.top ?? shellBounds.top) };
  if (bounds.width < 1 || bounds.height < 1) return undefined;

  const element = document.createElement("div");
  element.className = "conversation-jump-snapshot conversation-switch-snapshot";
  element.dataset.conversationSwitchSnapshot = "true";
  element.dataset.snapshotMessageCount = String(messageCount);
  element.dataset.snapshotTarget = targetIdentity;
  element.setAttribute("aria-hidden", "true");
  Object.assign(element.style, {
    position: "fixed",
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
    zIndex: "69",
    overflow: "hidden",
    pointerEvents: "auto",
    contain: "strict",
    background: getComputedStyle(source).getPropertyValue("--chat-canvas"),
  });
  element.addEventListener("pointerdown", (event) => event.preventDefault());
  element.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });

  const clone = cloneConversationSnapshot(source);
  clone.removeAttribute("id");
  clone.querySelector<HTMLElement>(".message-list-content")?.style.removeProperty("visibility");
  clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  clone.querySelectorAll("button, a, input, textarea, select, [contenteditable='true']")
    .forEach((node) => node.setAttribute("tabindex", "-1"));
  Object.assign(clone.style, {
    width: "100%",
    height: `${shellBounds.height}px`,
    position: "absolute",
    top: `${shellBounds.top - bounds.top}px`,
    minHeight: "0",
    margin: "0",
    pointerEvents: "none",
  });

  const shadow = element.attachShadow({ mode: "closed" });
  shadow.adoptedStyleSheets = [getConversationSnapshotStyleSheet()];
  const context = document.createElement("div");
  context.className = "conversation-jump-snapshot";
  context.inert = true;
  Object.assign(context.style, {
    width: "100%",
    height: "100%",
    overflow: "hidden",
  });
  if (header && headerBounds) {
    const headerClone = header.cloneNode(true) as HTMLElement;
    headerClone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    Object.assign(headerClone.style, { position: "absolute", top: "0", left: "0",
      width: `${headerBounds.width}px`, height: `${headerBounds.height}px` });
    context.append(headerClone);
  }
  context.append(clone);
  shadow.append(context);
  document.body.append(element);

  const cloneList = clone.querySelector<HTMLElement>(".message-list");
  if (cloneList) {
    cloneList.classList.remove("is-jump-transitioning");
    prepareConversationSnapshotClone(sourceList, cloneList);
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
