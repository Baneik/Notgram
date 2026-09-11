import type { Message, MessagePermissions } from "../telegram/types";

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
}

/**
 * A live message update can replace the object being checked while TDLib is
 * loading its operation permissions. Retry only when that replacement caused
 * the stale result; ordinary failures should remain failures.
 */
export const loadMessageActionPermissions = async ({
  chatId,
  messageId,
  initialMessage,
  getCurrentMessage,
  load,
  signal,
}: LoadMessageActionPermissionsOptions): Promise<MessagePermissions | undefined> => {
  let requestedMessage = initialMessage;
  for (let attempt = 0; attempt < MAX_MESSAGE_PERMISSION_SNAPSHOTS; attempt += 1) {
    if (signal?.aborted || requestedMessage.isLocallyDeleted) return undefined;
    const permissions = await load(chatId, messageId, true, signal);
    if (signal?.aborted) return undefined;
    if (permissions) return permissions;

    const currentMessage = getCurrentMessage();
    if (!currentMessage || currentMessage === requestedMessage) return undefined;
    requestedMessage = currentMessage;
  }
  return undefined;
};
