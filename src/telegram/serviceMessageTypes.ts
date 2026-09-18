export interface ServiceMessageMoney {
  currency: string;
  amount: number;
}

/** Normalized display data only; never retain payment credentials or Passport payloads. */
export interface ServiceMessageEvent {
  type: string;
  actorId?: string;
  memberIds?: string[];
  recipientId?: string;
  title?: string;
  text?: string;
  enabled?: boolean;
  count?: number;
  completedCount?: number;
  reopenedCount?: number;
  duration?: number;
  startsAt?: number;
  expiresAt?: number;
  money?: ServiceMessageMoney;
  prize?: ServiceMessageMoney;
  months?: number;
  days?: number;
  isVideo?: boolean;
  isMissed?: boolean;
  isDeclined?: boolean;
  isActive?: boolean;
  isExpired?: boolean;
  isRefunded?: boolean;
  isChannel?: boolean;
  target?: { messageId: string; chatId?: string };
  photo?: { localPath?: string; previewDataUrl?: string };
}

export type ServiceMessagePart =
  | { kind: "text"; text: string }
  | { kind: "person"; id: string; text: string }
  | { kind: "message"; messageId: string; chatId?: string; text: string };

export interface ServiceMessagePresentation {
  parts: ServiceMessagePart[];
  details: ServiceMessagePart[][];
}
