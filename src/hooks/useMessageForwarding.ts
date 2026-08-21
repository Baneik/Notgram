import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Chat,
  ForwardMessagesResult,
  Message,
  MessagePermissions,
} from "../telegram/types";

export interface ForwardTargetSelection {
  chat: Chat;
  topicId?: string;
}

interface MessageForwardingOptions {
  chatId?: string;
  conversationIdentity?: string;
  messages: Message[];
  messagesById: Map<string, Message>;
  targets: Chat[];
  getTargetsSnapshot?: () => Chat[];
  onLoadMessageProperties: (
    chatId: string,
    messageId: string,
  ) => Promise<MessagePermissions | undefined>;
  onForwardMessages: (
    fromChatId: string,
    messageIds: string[],
    toChatId: string,
    toTopicId?: string,
    description?: string,
  ) => Promise<ForwardMessagesResult | undefined>;
}

export const forwardTargetKey = (target: Pick<ForwardTargetSelection, "chat" | "topicId">) =>
  `${target.chat.id}\u0000${target.topicId ?? ""}`;

export const useMessageForwarding = ({
  chatId,
  conversationIdentity,
  messages,
  messagesById,
  targets,
  getTargetsSnapshot,
  onLoadMessageProperties,
  onForwardMessages,
}: MessageForwardingOptions) => {
  const [selectionActive, setSelectionActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [forwardMessageIds, setForwardMessageIds] = useState<string[]>([]);
  const [initialTargetId, setInitialTargetId] = useState<string>();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [pendingTargetId, setPendingTargetId] = useState<string>();
  const [targetSnapshot, setTargetSnapshot] = useState<Chat[]>(() => getTargetsSnapshot?.() ?? targets);

  const captureTargets = useCallback(
    () => getTargetsSnapshot?.() ?? targets,
    [getTargetsSnapshot, targets],
  );

  const filteredTargets = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? targetSnapshot.filter((target) => target.title.toLocaleLowerCase().includes(normalized))
      : targetSnapshot;
  }, [query, targetSnapshot]);

  useEffect(() => {
    setSelectionActive(false);
    setSelectedIds(new Set());
    setLoadingIds(new Set());
    setDialogOpen(false);
    setForwardMessageIds([]);
    setInitialTargetId(undefined);
    setQuery("");
    setPending(false);
    setPendingTargetId(undefined);
    setTargetSnapshot(captureTargets());
  }, [conversationIdentity ?? chatId]);

  useEffect(() => {
    setSelectedIds((current) => {
      const available = new Set([...current].filter((messageId) => messagesById.has(messageId)));
      return available.size === current.size ? current : available;
    });
    setForwardMessageIds((current) => {
      const available = current.filter((messageId) => messagesById.has(messageId));
      return available.length === current.length ? current : available;
    });
  }, [messagesById]);

  useEffect(() => {
    if (!selectionActive) return;
    const closeWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (dialogOpen && !pending) {
        setDialogOpen(false);
        setForwardMessageIds([]);
        setInitialTargetId(undefined);
        setQuery("");
      } else if (!pending) {
        setSelectionActive(false);
        setSelectedIds(new Set());
      }
    };
    document.addEventListener("keydown", closeWithKeyboard);
    return () => document.removeEventListener("keydown", closeWithKeyboard);
  }, [dialogOpen, pending, selectionActive]);

  const clearSelection = useCallback(() => {
    setSelectionActive(false);
    setSelectedIds(new Set());
  }, []);

  const startSelection = useCallback((message?: Message) => {
    setTargetSnapshot(captureTargets());
    setDialogOpen(false);
    setForwardMessageIds([]);
    setInitialTargetId(undefined);
    setQuery("");
    setSelectionActive(true);
    setSelectedIds(message ? new Set([message.id]) : new Set());
  }, [captureTargets]);

  const toggleSelection = useCallback(async (message: Message) => {
    if (selectedIds.has(message.id)) {
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(message.id);
        return next;
      });
      return;
    }
    if (selectedIds.size >= 100 || loadingIds.has(message.id)) return;

    let permissions = message.permissions;
    if (!permissions) {
      setLoadingIds((current) => new Set(current).add(message.id));
      permissions = await onLoadMessageProperties(message.chatId, message.id);
      setLoadingIds((current) => {
        const next = new Set(current);
        next.delete(message.id);
        return next;
      });
    }
    if (!permissions?.canForward) return;
    setSelectedIds((current) => current.size >= 100
      ? current
      : new Set(current).add(message.id));
  }, [loadingIds, onLoadMessageProperties, selectedIds]);

  const orderedMessageIds = useCallback((messageIds: Iterable<string>) => {
    const requested = new Set(messageIds);
    return messages
      .filter((message) => requested.has(message.id))
      .map((message) => message.id)
      .slice(0, 100);
  }, [messages]);

  const openDialogForMessages = useCallback((
    messageIds: Iterable<string>,
    targetId?: string,
  ) => {
    const ordered = orderedMessageIds(messageIds);
    if (ordered.length === 0 || pending) return;
    setTargetSnapshot(captureTargets());
    setForwardMessageIds(ordered);
    setInitialTargetId(targetId);
    setQuery("");
    setDialogOpen(true);
  }, [captureTargets, orderedMessageIds, pending]);

  const openSelectedDialog = useCallback(() => {
    openDialogForMessages(selectedIds);
  }, [openDialogForMessages, selectedIds]);

  const quickForward = useCallback(async (
    messageIds: Iterable<string>,
    target: Chat,
  ) => {
    const ordered = orderedMessageIds(messageIds);
    if (!chatId || ordered.length === 0 || pending) return;
    if (target.isForum) {
      openDialogForMessages(ordered, target.id);
      return;
    }
    setPending(true);
    setPendingTargetId(target.id);
    await onForwardMessages(chatId, ordered, target.id);
    setPending(false);
    setPendingTargetId(undefined);
  }, [chatId, onForwardMessages, openDialogForMessages, orderedMessageIds, pending]);

  const confirm = useCallback(async (
    selectedTargets: ForwardTargetSelection[],
    description: string,
  ) => {
    if (!chatId || pending || forwardMessageIds.length === 0 || selectedTargets.length === 0) return;
    setPending(true);
    const failedMessageIds = new Set<string>();
    for (const target of selectedTargets) {
      setPendingTargetId(forwardTargetKey(target));
      const result = await onForwardMessages(
        chatId,
        forwardMessageIds,
        target.chat.id,
        target.topicId,
        description.trim() || undefined,
      );
      if (!result) {
        forwardMessageIds.forEach((messageId) => failedMessageIds.add(messageId));
      } else {
        result.failedMessageIds.forEach((messageId) => failedMessageIds.add(messageId));
      }
    }
    setPending(false);
    setPendingTargetId(undefined);
    setDialogOpen(false);
    setForwardMessageIds([]);
    setInitialTargetId(undefined);
    setQuery("");
    if (!selectionActive) return;
    if (failedMessageIds.size > 0) {
      setSelectedIds(failedMessageIds);
      return;
    }
    clearSelection();
  }, [chatId, clearSelection, forwardMessageIds, onForwardMessages, pending, selectionActive]);

  const closeDialog = useCallback(() => {
    if (pending) return;
    setDialogOpen(false);
    setForwardMessageIds([]);
    setInitialTargetId(undefined);
    setQuery("");
  }, [pending]);

  return {
    selectedIds,
    loadingIds,
    selectionMode: selectionActive,
    dialogOpen,
    forwardMessageIds,
    initialTargetId,
    query,
    pending,
    pendingTargetId,
    filteredTargets,
    clearSelection,
    startSelection,
    toggleSelection,
    openDialogForMessages,
    openSelectedDialog,
    quickForward,
    closeDialog,
    setQuery,
    confirm,
  };
};
