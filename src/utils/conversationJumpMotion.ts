import { motionDistance, motionDuration, motionEasing } from "./motionTokens";

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
  const travel = direction === "older" ? motionDistance.standard : -motionDistance.standard;
  return {
    exit: [
      { opacity: 1, transform: "translateY(0)" },
      { opacity: 0.72, transform: `translateY(${travel}px)` },
    ],
    enter: [
      { opacity: 0.72, transform: `translateY(${-travel}px)` },
      { opacity: 1, transform: "translateY(0)" },
    ],
    exitTiming: {
      duration: motionDuration.fast,
      easing: motionEasing.exit,
      fill: "forwards",
    },
    enterTiming: {
      duration: motionDuration.standard,
      easing: motionEasing.enter,
      fill: "both",
    },
  };
};
