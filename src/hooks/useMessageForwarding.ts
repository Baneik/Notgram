import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { addMessageSelectionGroups, isSelectableMessage, messageSelectionGroups, toggleMessageSelectionGroup } from "../utils/messageSelection";
import { messageCanBeSaved } from "../telegram/messageLifecycle";
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
  onSelectionCancelled?: () => void;
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
  onSelectionCancelled,
  onLoadMessageProperties,
  onForwardMessages,
}: MessageForwardingOptions) => {
  const [selectionActive, setSelectionActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [permissionRetry, setPermissionRetry] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [forwardMessageIds, setForwardMessageIds] = useState<string[]>([]);
  const [initialTargetId, setInitialTargetId] = useState<string>();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [pendingTargetId, setPendingTargetId] = useState<string>();
  const [targetSnapshot, setTargetSnapshot] = useState<Chat[]>(() => getTargetsSnapshot?.() ?? targets);
  const selectionPermissionRequestsRef = useRef(new Set<string>());
  const operationGenerationRef = useRef(0);

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
    selectionPermissionRequestsRef.current.clear();
    return () => { operationGenerationRef.current += 1; };
  }, [conversationIdentity ?? chatId]);

  useEffect(() => {
    setSelectedIds((current) => {
      const available = new Set([...current].filter((messageId) => messagesById.has(messageId) && !messagesById.get(messageId)?.isRemoving));
      return available.size === current.size ? current : available;
    });
    setForwardMessageIds((current) => {
      const available = current.filter((messageId) => messagesById.has(messageId));
      return available.length === current.length ? current : available;
    });
  }, [messagesById]);

  const clearSelection = useCallback(() => {
    setSelectionActive(false);
    setSelectedIds(new Set());
  }, []);

  const cancelSelection = useCallback(() => {
    // Cancelling remounts the editor. Its new node must exist before requesting focus.
    flushSync(clearSelection);
    onSelectionCancelled?.();
  }, [clearSelection, onSelectionCancelled]);

  useEffect(() => {
    if (!selectionActive) return;
    const closeWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (!dialogOpen && document.activeElement?.closest('[role="dialog"], [inert]')) return;
      if (dialogOpen && !pending) {
        event.preventDefault();
        setDialogOpen(false);
        setForwardMessageIds([]);
        setInitialTargetId(undefined);
        setQuery("");
      } else if (!pending) {
        event.preventDefault();
        cancelSelection();
      }
    };
    document.addEventListener("keydown", closeWithKeyboard);
    return () => document.removeEventListener("keydown", closeWithKeyboard);
  }, [cancelSelection, dialogOpen, pending, selectionActive]);

  const startSelection = useCallback((message?: Message) => {
    setTargetSnapshot(captureTargets());
    setDialogOpen(false);
    setForwardMessageIds([]);
    setInitialTargetId(undefined);
    setQuery("");
    selectionPermissionRequestsRef.current.clear();
    setSelectionActive(true);
    setSelectedIds(message ? new Set([message.id]) : new Set());
  }, [captureTargets]);

  const toggleSelection = useCallback((message: Message) => {
    if (!isSelectableMessage(message)) return;
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(message.id)) next.delete(message.id);
      else if (next.size < 100) next.add(message.id);
      return next;
    });
  }, []);

  const selectMessages = useCallback((range: Message[], baseIds?: ReadonlySet<string>) => {
    setSelectedIds(current => {
      const next = addMessageSelectionGroups(baseIds ?? current, messageSelectionGroups(range));
      return next.size === current.size && [...next].every(id => current.has(id)) ? current : next;
    });
  }, []);

  const toggleSelectionGroup = useCallback((group: Message[]) => {
    setSelectedIds(current => toggleMessageSelectionGroup(current, group));
  }, []);

  // Selection is independent of forwarding permission: protected messages can
  // still be deleted by their author or a group administrator.
  useEffect(() => {
    if (!selectionActive) return;
    const generation = operationGenerationRef.current;
    const unresolved = [...selectedIds].map(id => messagesById.get(id)).filter((message): message is Message =>
      Boolean(message && !message.isLocallyDeleted && !message.permissions &&
        !selectionPermissionRequestsRef.current.has(message.id)));
    if (!unresolved.length) return;
    unresolved.forEach(message => selectionPermissionRequestsRef.current.add(message.id));
    setLoadingIds(current => new Set([...current, ...unresolved.map(message => message.id)]));
    void Promise.allSettled(unresolved.map(message => onLoadMessageProperties(message.chatId, message.id)))
      .then(() => {
        if (generation !== operationGenerationRef.current) return;
        setLoadingIds(current => {
          const next = new Set(current);
          unresolved.forEach(message => next.delete(message.id));
          return next;
        });
      });
  }, [selectedIds, messagesById, onLoadMessageProperties, selectionActive, permissionRetry]);

  const retrySelectionPermissions = useCallback(() => {
    selectionPermissionRequestsRef.current.clear();
    setPermissionRetry(value => value + 1);
  }, []);

  const selectedMessages = messages.filter(message => selectedIds.has(message.id));
  const selectionReady = selectedMessages.length > 0 && selectedMessages.every(message =>
    message.isLocallyDeleted || Boolean(message.permissions));
  const canCopySelection = selectionReady && selectedMessages.every(messageCanBeSaved);
  const canForwardSelection = selectionReady && selectedMessages.every(message =>
    message.isLocallyDeleted || message.permissions?.canForward === true);

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
    if (canForwardSelection) openDialogForMessages(selectedIds);
  }, [canForwardSelection, openDialogForMessages, selectedIds]);

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
    const generation = operationGenerationRef.current;
    setPending(true);
    setPendingTargetId(target.id);
    await onForwardMessages(chatId, ordered, target.id);
    if (generation !== operationGenerationRef.current) return;
    setPending(false);
    setPendingTargetId(undefined);
  }, [chatId, onForwardMessages, openDialogForMessages, orderedMessageIds, pending]);

  const confirm = useCallback(async (
    selectedTargets: ForwardTargetSelection[],
    description: string,
  ) => {
    if (!chatId || pending || forwardMessageIds.length === 0 || selectedTargets.length === 0) return;
    const generation = operationGenerationRef.current;
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
      if (generation !== operationGenerationRef.current) return;
      if (!result) {
        forwardMessageIds.forEach((messageId) => failedMessageIds.add(messageId));
        // A cancelled account batch must not start another target on the new account.
        break;
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
    selectedMessages,
    canCopySelection,
    canForwardSelection,
    retrySelectionPermissions,
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
    cancelSelection,
    startSelection,
    toggleSelection,
    toggleSelectionGroup,
    selectMessages,
    openDialogForMessages,
    openSelectedDialog,
    quickForward,
    closeDialog,
    setQuery,
    confirm,
  };
};
