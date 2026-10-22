import type { Message } from "../telegram/types";
import { isEditableMessageContent } from "../telegram/messageContent";
import { isLocalHiddenMessage } from "./localBlockedMessages";

export interface ComposerMessageScope {
  chatId?: string;
  topicId?: string;
  hiddenUserIds: ReadonlySet<string>;
}

export const composerMessageTarget = (
  scope: ComposerMessageScope,
  messages: readonly Message[],
  messageId?: string,
  snapshot?: Message,
  editing = false,
) => {
  if (!scope.chatId || !messageId) return undefined;
  const matches = (message: Message) => message.chatId === scope.chatId && message.id === messageId;
  // A cache miss can be eviction or a different history window, not deletion.
  const target = messages.find(matches) ?? (snapshot && matches(snapshot) ? snapshot : undefined);
  if (!target || (scope.topicId && target.topicId !== scope.topicId) || target.isRemoving ||
    isLocalHiddenMessage(target, scope.hiddenUserIds)) return undefined;
  if (editing && (target.isLocallyDeleted || target.permissions?.canEdit === false ||
    !isEditableMessageContent(target.content))) return undefined;
  return target;
};
