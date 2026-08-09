export type MotionPreference = {
  reduceMotion: boolean;
  systemReduceMotion: boolean;
};

export const effectiveReduceMotion = ({
  reduceMotion,
  systemReduceMotion,
}: MotionPreference) => reduceMotion || systemReduceMotion;

export const autoplayAllowed = (
  autoplayAnimations: boolean,
  preference: MotionPreference,
) => autoplayAnimations && !effectiveReduceMotion(preference);

export const motionScrollBehavior = <Behavior extends "auto" | "smooth">(
  behavior: Behavior,
  preference: MotionPreference,
): Behavior => (effectiveReduceMotion(preference) ? "auto" : behavior) as Behavior;
