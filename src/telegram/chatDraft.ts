import type { ChatDraft } from "./types";

type DraftContent = Pick<ChatDraft, "text" | "replyToMessageId">;

export const hasChatDraftContent = <Draft extends DraftContent>(
  draft: Draft | undefined,
): draft is Draft => Boolean(
  draft && (draft.text.trim().length > 0 || draft.replyToMessageId),
);
