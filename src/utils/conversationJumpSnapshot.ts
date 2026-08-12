export interface ConversationJumpSnapshot {
  element: HTMLElement;
  content: HTMLElement;
}

export const captureConversationJumpSnapshot = (
  scroller: HTMLElement,
): ConversationJumpSnapshot | undefined => {
  const bounds = scroller.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) return undefined;

  const element = document.createElement("div");
  element.className = "conversation-jump-snapshot";
  element.dataset.conversationMotionSnapshot = "jump";
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
  });

  const clone = scroller.cloneNode(true) as HTMLElement;
  clone.removeAttribute("id");
  clone.removeAttribute("role");
  clone.removeAttribute("tabindex");
  clone.removeAttribute("aria-label");
  clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  clone.querySelectorAll("[data-message-id]")
    .forEach((node) => node.removeAttribute("data-message-id"));
  clone.querySelectorAll("button, a, input, textarea, select, [contenteditable='true']")
    .forEach((node) => node.setAttribute("tabindex", "-1"));
  Object.assign(clone.style, {
    width: "100%",
    height: "100%",
    margin: "0",
    pointerEvents: "none",
    scrollbarWidth: "none",
  });
  element.append(clone);
  document.body.append(element);
  clone.scrollTop = scroller.scrollTop;
  clone.scrollLeft = scroller.scrollLeft;

  return {
    element,
    content: clone.querySelector<HTMLElement>(".message-list-content") ?? clone,
  };
};

export const removeConversationJumpSnapshot = (
  snapshot: ConversationJumpSnapshot | undefined,
) => snapshot?.element.remove();
