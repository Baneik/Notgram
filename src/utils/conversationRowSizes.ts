/** Observe real virtual rows, never the content spacer whose size changes in
 * response to scrolling. Deliver genuine resizes before the browser paints. */
export const observeConversationRowSizes = (
  list: HTMLElement,
  onResize: (changes: Array<{ element: Element; delta: number }>) => void,
) => {
  const rows = new Map<Element, number | undefined>();
  const observer = new ResizeObserver((entries) => {
    const changes: Array<{ element: Element; delta: number }> = [];
    for (const entry of entries) {
      if (!rows.has(entry.target)) continue;
      const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
      const previous = rows.get(entry.target);
      rows.set(entry.target, height);
      // Several subpixel row changes can add up to a visible baseline shift.
      // Leave scroll-write tolerances to the coordinator, not individual rows.
      if (previous !== undefined && previous !== height) {
        changes.push({ element: entry.target, delta: height - previous });
      }
    }
    if (changes.length > 0) onResize(changes);
  });
  const syncRows = () => {
    for (const row of rows.keys()) {
      if (list.contains(row)) continue;
      observer.unobserve(row);
      rows.delete(row);
    }
    for (const row of list.querySelectorAll("[data-index], [data-message-id]")) {
      if (rows.has(row)) continue;
      rows.set(row, row.getBoundingClientRect().height);
      observer.observe(row, { box: "border-box" });
    }
  };
  const mutations = new MutationObserver((records) => {
    if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) =>
      node instanceof Element && (node.matches("[data-index], [data-message-id]") ||
        node.querySelector("[data-index], [data-message-id]")),
    ))) syncRows();
  });
  mutations.observe(list, { childList: true, subtree: true });
  syncRows();
  return () => {
    mutations.disconnect();
    observer.disconnect();
    rows.clear();
  };
};
