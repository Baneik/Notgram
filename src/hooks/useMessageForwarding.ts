import { useEffect, useMemo, useState } from "react";
import type {
  Chat,
  ForwardMessagesResult,
  Message,
  MessagePermissions,
} from "../telegram/types";

interface MessageForwardingOptions {
  chatId?: string;
  messages: Message[];
  messagesById: Map<string, Message>;
  targets: Chat[];
  onLoadMessageProperties: (
    chatId: string,
    messageId: string,
  ) => Promise<MessagePermissions | undefined>;
  onForwardMessages: (
    fromChatId: string,
    messageIds: string[],
    toChatId: string,
  ) => Promise<ForwardMessagesResult | undefined>;
}

export const useMessageForwarding = ({
  chatId,
  messages,
  messagesById,
  targets,
  onLoadMessageProperties,
  onForwardMessages,
}: MessageForwardingOptions) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [pendingTargetId, setPendingTargetId] = useState<string>();
  const selectionMode = selectedIds.size > 0;

  const filteredTargets = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? targets.filter((target) => target.title.toLocaleLowerCase().includes(normalized))
      : targets;
  }, [query, targets]);

  useEffect(() => {
    setSelectedIds(new Set());
    setLoadingIds(new Set());
    setDialogOpen(false);
    setQuery("");
    setPending(false);
    setPendingTargetId(undefined);
  }, [chatId]);

  useEffect(() => {
    setSelectedIds((current) => {
      const available = new Set([...current].filter((messageId) => messagesById.has(messageId)));
      return available.size === current.size ? current : available;
    });
  }, [messagesById]);

  useEffect(() => {
    if (!selectionMode) return;
    const closeWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (dialogOpen && !pending) {
        setDialogOpen(false);
        setQuery("");
      } else if (!pending) {
        setSelectedIds(new Set());
      }
    };
    document.addEventListener("keydown", closeWithKeyboard);
    return () => document.removeEventListener("keydown", closeWithKeyboard);
  }, [dialogOpen, pending, selectionMode]);

  const clearSelection = () => setSelectedIds(new Set());

  const startSelection = (message: Message) => {
    setDialogOpen(false);
    setQuery("");
    setSelectedIds(new Set([message.id]));
  };

  const toggleSelection = async (message: Message) => {
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
  };

  const confirm = async (target: Chat) => {
    if (!chatId || pending) return;
    const messageIds = messages
      .filter((message) => selectedIds.has(message.id))
      .map((message) => message.id);
    if (messageIds.length === 0) return;
    setPending(true);
    setPendingTargetId(target.id);
    const result = await onForwardMessages(chatId, messageIds, target.id);
    setPending(false);
    setPendingTargetId(undefined);
    setDialogOpen(false);
    setQuery("");
    if (!result) return;
    if (result.failedMessageIds.length > 0) {
      setSelectedIds(new Set(result.failedMessageIds));
      return;
    }
    setSelectedIds(new Set());
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setQuery("");
  };

  return {
    selectedIds,
    loadingIds,
    selectionMode,
    dialogOpen,
    query,
    pending,
    pendingTargetId,
    filteredTargets,
    clearSelection,
    startSelection,
    toggleSelection,
    openDialog: () => setDialogOpen(true),
    closeDialog,
    setQuery,
    confirm,
  };
};
