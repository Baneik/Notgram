/** Floating notices share the measured timeline center, including scrollbar gutters and UI zoom. */
export const observeConversationNoticeAlignment = (list: HTMLElement) => {
  const shell = list.closest<HTMLElement>(".message-list-shell");
  if (!shell) return;
  let content: HTMLElement | null = null;
  let lastCenter = "";
  const measure = () => {
    if (!content || !list.isConnected) return;
    const bounds = shell.getBoundingClientRect();
    const timeline = content.getBoundingClientRect();
    if (bounds.width <= 0 || shell.offsetWidth <= 0) return;
    const center = `${((timeline.left + timeline.width / 2 - bounds.left) * shell.offsetWidth / bounds.width).toFixed(3)}px`;
    if (center !== lastCenter) {
      lastCenter = center;
      shell.style.setProperty("--conversation-notice-center", center);
    }
  };
  const resize = new ResizeObserver(measure);
  const sync = () => {
    const next = list.querySelector<HTMLElement>(".message-list-content");
    if (next === content) return;
    if (content) resize.unobserve(content);
    content = next;
    if (content) resize.observe(content);
    measure();
  };
  resize.observe(list);
  resize.observe(shell);
  const mutations = new MutationObserver(sync);
  mutations.observe(list, { childList: true, subtree: true });
  sync();
  return () => {
    mutations.disconnect();
    resize.disconnect();
    shell.style.removeProperty("--conversation-notice-center");
  };
};
