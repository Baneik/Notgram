import { motionEasing, motionLifecycleTiming } from "./motionTokens";

// Animate the contents, never the measured message/virtual rows. Scroll anchors
// and ResizeObserver must always see the final layout during a visual fall.
const surfaces = (list: HTMLElement) => {
  const result = new Map<string, HTMLElement>();
  for (const row of list.querySelectorAll<HTMLElement>(".message-row[data-message-id]")) {
    if (row.classList.contains("is-removing")) continue;
    const album = row.closest<HTMLElement>("[data-media-album-id]");
    const surface = album ?? row.querySelector<HTMLElement>(".message-bubble-shell");
    if (surface) result.set(album ? `album:${album.dataset.mediaAlbumId}` : `message:${row.dataset.messageId}`, surface);
  }
  for (const element of list.querySelectorAll<HTMLElement>("[data-removal-surface]")) {
    if (element.hasAttribute("data-removing")) continue;
    result.set(element.dataset.removalSurface!, element);
  }
  return result;
};

export const captureMessageRemoval = (
  list: HTMLElement,
  nextIds: ReadonlyMap<string, number>,
  handledIds?: ReadonlySet<string>,
) => {
  if (!list.querySelector(".message-row.is-removing")) return;
  const rows = [...list.querySelectorAll<HTMLElement>(".message-row[data-message-id]")];
  const removed = rows.filter(row => row.classList.contains("is-removing") &&
    !nextIds.has(row.dataset.messageId!) && !handledIds?.has(row.dataset.messageId!));
  if (removed.length === 0) return;
  const lastRemovedIndex = Math.max(...removed.map(row => rows.indexOf(row)));
  const lower = rows.slice(lastRemovedIndex + 1).find(row => nextIds.has(row.dataset.messageId!));
  const bounds = list.getBoundingClientRect();
  const anchor = lower ? {
    messageId: lower.dataset.messageId!,
    offset: lower.getBoundingClientRect().top - bounds.top,
  } : undefined;
  const before = new Map([...surfaces(list)].map(([key, element]) => [key, element.getBoundingClientRect().top]));

  return {
    removedIds: new Set(removed.map(row => row.dataset.messageId!)),
    anchor,
    start(reduced: boolean) {
      const animations = new Map<HTMLElement, { animation: Animation; delta: number }>();
      const startedAt = performance.now();
      const refresh = () => {
        if (reduced) return;
        const measurements = [...surfaces(list)].flatMap(([key, element]) => {
          const top = before.get(key);
          if (top === undefined) return [];
          const previous = animations.get(element);
          const transform = previous ? getComputedStyle(element).transform : "none";
          const offset = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
          return [{ element, delta: top - element.getBoundingClientRect().top + offset, previous }];
        });
        for (const { element, delta, previous } of measurements) {
          if (previous && Math.abs(previous.delta - delta) < 0.1) continue;
          if (!previous && Math.abs(delta) < 0.5) continue;
          const keyframes = [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }];
          if (previous) {
            (previous.animation.effect as KeyframeEffect).setKeyframes(keyframes);
            previous.delta = delta;
          } else {
            const animation = element.animate(keyframes, {
              duration: motionLifecycleTiming.messageRemovalSettle,
              easing: motionEasing.standard,
              fill: "both",
            });
            animation.currentTime = performance.now() - startedAt;
            element.dataset.removalMotion = "settling";
            animations.set(element, { animation, delta });
          }
        }
      };
      refresh();
      return {
        refresh,
        cancel() {
          for (const [element, { animation }] of animations) {
            animation.cancel();
            delete element.dataset.removalMotion;
          }
          animations.clear();
        },
      };
    },
  };
};
