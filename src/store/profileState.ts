import type { ChatProfile } from "../telegram/types";

export type ProfileTarget =
  | { kind: "current" }
  | { kind: "chat"; chatId: string }
  | { kind: "user"; userId: string };

export interface ProfileState {
  target?: ProfileTarget;
  value?: ChatProfile;
  loading: boolean;
  membersLoading?: boolean;
  membersError?: string;
  updating?: boolean;
  error?: string;
  updateError?: string;
}

export const emptyProfileState = (): ProfileState => ({ loading: false });
