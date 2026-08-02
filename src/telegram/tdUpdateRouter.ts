import { asTdObject, type TdObject } from "./tdlibMapper";

export interface TdUpdateHandlers {
  authorization: (update: TdObject) => void;
  connection: (update: TdObject) => void;
  upsertUser: (user?: TdObject) => void;
  updateUserStatus: (update: TdObject) => void;
  updateChatFolders: (update: TdObject) => void;
  upsertChat: (chat?: TdObject) => void;
  emitDraft: (chatId: unknown, draft: unknown) => void;
  patchChat: (chatId: unknown, patch: TdObject) => void;
  patchChatWithPositions: (chatId: unknown, patch: TdObject, positions: unknown) => void;
  updateChatPosition: (update: TdObject) => void;
  updateChatList: (update: TdObject, added: boolean) => void;
  emitMessage: (message?: TdObject) => void;
  replaceSentMessage: (update: TdObject) => void;
  updateMessageContent: (update: TdObject) => void;
  patchMessage: (chatId: unknown, messageId: unknown, patch: TdObject) => void;
  updateReadOutbox: (update: TdObject) => void;
  deleteMessages: (update: TdObject) => void;
  updateFile: (file?: TdObject) => void;
}

export const routeTdUpdate = (update: TdObject, handlers: TdUpdateHandlers) => {
  switch (update["@type"]) {
    case "updateAuthorizationState":
      handlers.authorization(update);
      return;
    case "updateConnectionState":
      handlers.connection(update);
      return;
    case "updateUser":
      handlers.upsertUser(asTdObject(update.user));
      return;
    case "updateUserStatus":
      handlers.updateUserStatus(update);
      return;
    case "updateChatFolders":
      handlers.updateChatFolders(update);
      return;
    case "updateNewChat": {
      const chat = asTdObject(update.chat);
      handlers.upsertChat(chat);
      handlers.emitDraft(update.chat_id ?? chat?.id, chat?.draft_message);
      return;
    }
    case "updateChatTitle":
      handlers.patchChat(update.chat_id, { title: update.title });
      return;
    case "updateChatPhoto":
      handlers.patchChat(update.chat_id, { photo: update.photo });
      return;
    case "updateChatLastMessage":
      handlers.patchChatWithPositions(
        update.chat_id,
        { last_message: update.last_message },
        update.positions,
      );
      return;
    case "updateChatDraftMessage":
      handlers.patchChatWithPositions(
        update.chat_id,
        { draft_message: update.draft_message },
        update.positions,
      );
      handlers.emitDraft(update.chat_id, update.draft_message);
      return;
    case "updateChatPosition":
      handlers.updateChatPosition(update);
      return;
    case "updateChatAddedToList":
      handlers.updateChatList(update, true);
      return;
    case "updateChatRemovedFromList":
      handlers.updateChatList(update, false);
      return;
    case "updateChatReadInbox":
      handlers.patchChat(update.chat_id, { unread_count: update.unread_count });
      return;
    case "updateChatNotificationSettings":
      handlers.patchChat(update.chat_id, {
        notification_settings: update.notification_settings,
      });
      return;
    case "updateNewMessage":
      handlers.emitMessage(asTdObject(update.message));
      return;
    case "updateMessageSendSucceeded":
    case "updateMessageSendFailed":
      handlers.replaceSentMessage(update);
      return;
    case "updateMessageContent":
      handlers.updateMessageContent(update);
      return;
    case "updateMessageEdited":
      handlers.patchMessage(update.chat_id, update.message_id, {
        edit_date: update.edit_date,
        reply_markup: update.reply_markup,
      });
      return;
    case "updateMessageInteractionInfo":
      handlers.patchMessage(update.chat_id, update.message_id, {
        interaction_info: update.interaction_info,
      });
      return;
    case "updateChatReadOutbox":
      handlers.updateReadOutbox(update);
      return;
    case "updateDeleteMessages":
      handlers.deleteMessages(update);
      return;
    case "updateFile":
      handlers.updateFile(asTdObject(update.file));
  }
};
