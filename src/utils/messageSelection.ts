import type { Message } from "../telegram/types";

export const isSelectableMessage = (message: Message) =>
  !message.isRemoving && message.content.kind !== "service" && message.content.kind !== "unsupported";

export function messageSelectionDeleteScopes(messages: Message[]) {
  const available = messages.filter(message => !message.isRemoving);
  return {
    self: available.filter(message => message.isLocallyDeleted || message.permissions?.canDeleteOnlyForSelf === true),
    all: available.filter(message => !message.isLocallyDeleted && message.permissions?.canDeleteForAllUsers === true),
  };
}
