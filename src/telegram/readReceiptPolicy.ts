import { preferencesStore } from "../store/preferencesStore";

export class ReadReceiptPolicyChanged extends Error {
  constructor() { super("Reading policy changed before the request was sent"); }
}

/** Recheck after async preparation: a setting change can retire an already queued read. */
export const assertReadReceiptAllowed = (request: Record<string, unknown>) => {
  if (!preferencesStore.getState().blockReadReceipts) return;
  if (["viewMessages", "openMessageContent", "readAllChatReactions", "readAllForumTopicReactions",
    "readAllChatMentions", "readAllForumTopicMentions"].includes(String(request["@type"])) ||
    (request["@type"] === "toggleChatIsMarkedAsUnread" && request.is_marked_as_unread === false)) {
    throw new ReadReceiptPolicyChanged();
  }
};
