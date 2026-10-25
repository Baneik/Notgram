import type { Message, MessagePermissions } from "../telegram/types";
import { messagePermissionRevision } from "./messagePermissionRevision";

const MAX_MESSAGE_PERMISSION_SNAPSHOTS = 3;

interface LoadMessageActionPermissionsOptions {
  chatId: string;
  messageId: string;
  initialMessage: Message;
  getCurrentMessage: () => Message | undefined;
  load: (
    chatId: string,
    messageId: string,
    force?: boolean,
    signal?: AbortSignal,
  ) => Promise<MessagePermissions | undefined>;
  signal?: AbortSignal;
  force?: boolean;
}

/**
 * Retry only when permission-relevant state changed during a TDLib lookup.
 * Presentation replacements and ordinary failures must not start retry loops.
 */
export const loadMessageActionPermissions = async ({
  chatId,
  messageId,
  initialMessage,
  getCurrentMessage,
  load,
  signal,
  force = false,
}: LoadMessageActionPermissionsOptions): Promise<MessagePermissions | undefined> => {
  let requestedMessage = initialMessage;
  for (let attempt = 0; attempt < MAX_MESSAGE_PERMISSION_SNAPSHOTS; attempt += 1) {
    if (signal?.aborted || requestedMessage.isLocallyDeleted) return undefined;
    const permissions = await load(chatId, messageId, force, signal);
    if (signal?.aborted) return undefined;
    if (permissions) return permissions;

    const currentMessage = getCurrentMessage();
    if (!currentMessage || messagePermissionRevision(currentMessage) === messagePermissionRevision(requestedMessage)) return undefined;
    requestedMessage = currentMessage;
  }
  return undefined;
};
