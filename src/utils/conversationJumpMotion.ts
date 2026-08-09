export type ConversationJumpDirection = "older" | "newer";

export interface ConversationJumpMotion {
  exit: Keyframe[];
  enter: Keyframe[];
  exitTiming: KeyframeAnimationOptions;
  enterTiming: KeyframeAnimationOptions;
}

export const conversationJumpMotion = (
  direction: ConversationJumpDirection,
): ConversationJumpMotion => {
  const travel = direction === "older" ? 14 : -14;
  return {
    exit: [
      { opacity: 1, transform: "translateY(0)" },
      { opacity: 0.22, transform: `translateY(${travel}px)` },
    ],
    enter: [
      { opacity: 0.22, transform: `translateY(${-travel}px)` },
      { opacity: 1, transform: "translateY(0)" },
    ],
    exitTiming: {
      duration: 110,
      easing: "cubic-bezier(0.4, 0, 1, 1)",
      fill: "forwards",
    },
    enterTiming: {
      duration: 210,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      fill: "both",
    },
  };
};
