import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { telegramStore, useTelegramStore } from "../store/telegramStore";
import type { ChatDraft, Message, MessageReplyQuote } from "../telegram/types";
import { composerMessageTarget, type ComposerMessageScope } from "../utils/composerMessageTarget";

interface ComposerMessageContextOptions extends ComposerMessageScope {
  identity: string;
  draftKey?: string;
  messages: readonly Message[];
  onClearDraftReply: (draft: ChatDraft) => void;
}

export function useComposerMessageContext(options: ComposerMessageContextOptions) {
  const { identity, draftKey, messages, chatId, topicId, hiddenUserIds } = options;
  const [replyingTo, setReplyingTo] = useState<Message>();
  const [replyQuote, setReplyQuote] = useState<MessageReplyQuote>();
  const [editingMessage, setEditingMessage] = useState<Message>();
  const [contextIdentity, setContextIdentity] = useState(identity);
  const draftReplyId = useTelegramStore(state => draftKey ? state.drafts.get(draftKey)?.replyToMessageId : undefined);
  const draftQuote = useTelegramStore(state => draftKey ? state.drafts.get(draftKey)?.replyQuote : undefined);
  const current = useRef({ options, replyingTo });
  current.current = { options, replyingTo: contextIdentity === identity ? replyingTo : undefined };

  // Reset before paint; reconciliation must wait until the new scope owns the state.
  // Otherwise an effect from the transition render can restore the previous target.
  useLayoutEffect(() => {
    setReplyingTo(undefined);
    setReplyQuote(undefined);
    setEditingMessage(undefined);
    setContextIdentity(identity);
  }, [identity]);

  const cancelReply = useCallback(() => {
    if (current.current.options.identity !== identity) return;
    setReplyingTo(undefined);
    setReplyQuote(undefined);
    const { draftKey: key, onClearDraftReply } = current.current.options;
    const draft = key ? telegramStore.getState().drafts.get(key) : undefined;
    if (draft?.replyToMessageId) onClearDraftReply(draft);
  }, [identity]);

  const getReplyTarget = useCallback((messageId?: string) => {
    const { options: scope, replyingTo: snapshot } = current.current;
    return composerMessageTarget(scope, scope.messages, messageId, snapshot);
  }, []);

  useEffect(() => {
    if (contextIdentity !== identity) return;
    const scope = { chatId, topicId, hiddenUserIds };
    if (editingMessage) {
      setEditingMessage(composerMessageTarget(scope, messages, editingMessage.id, editingMessage, true));
      return;
    }
    if (!draftReplyId) {
      setReplyingTo(undefined);
      setReplyQuote(undefined);
      return;
    }
    const target = composerMessageTarget(scope, messages, draftReplyId, replyingTo);
    if (!target) {
      // Unknown drafts can resolve when history arrives. Explicitly hidden or
      // invalid targets must also lose their persisted reference before sending.
      if (replyingTo || messages.some(message => message.chatId === chatId && message.id === draftReplyId)) cancelReply();
      return;
    }
    setReplyingTo(target);
    // Keep a locally selected quote authoritative over a normalized TDLib echo.
    if (replyingTo?.id !== target.id) setReplyQuote(draftQuote);
  }, [identity, contextIdentity, chatId, topicId, hiddenUserIds, messages, draftReplyId, draftQuote, editingMessage, replyingTo, cancelReply]);

  useEffect(() => telegramStore.getState().subscribeMessageChanges(event => {
    if (event.type !== "remove" || event.chatId !== chatId) return;
    const removed = new Set(event.messageIds);
    const { replyingTo: reply, options: scope } = current.current;
    const draftId = scope.draftKey ? telegramStore.getState().drafts.get(scope.draftKey)?.replyToMessageId : undefined;
    if ((reply && removed.has(reply.id)) || (draftId && removed.has(draftId))) cancelReply();
    setEditingMessage(message => message?.chatId === event.chatId && removed.has(message.id) ? undefined : message);
  }), [identity, chatId, cancelReply]);

  return { replyingTo, replyQuote, editingMessage, setReplyingTo, setReplyQuote, setEditingMessage, cancelReply, getReplyTarget };
}
