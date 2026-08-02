import type { ChatProfile } from "../telegram/types";

export type ProfileTarget =
  | { kind: "current" }
  | { kind: "chat"; chatId: string };

export interface ProfileState {
  target?: ProfileTarget;
  value?: ChatProfile;
  loading: boolean;
  error?: string;
}

export const emptyProfileState = (): ProfileState => ({ loading: false });
