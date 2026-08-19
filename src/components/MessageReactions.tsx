import { LoaderCircle } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type {
  Chat,
  MessageReaction,
  MessageReactionSender,
  MessageReactionSenderPage,
  MessageReactionType,
  User,
} from "../telegram/types";
import { Avatar } from "./Avatar";
import {
  ContextMenuPanel,
  ContextMenuSurface,
  type ContextMenuPoint,
} from "./ContextMenuSurface";

interface MessageReactionsProps {
  messageId: string;
  reactions: MessageReaction[];
  canGetAddedReactions?: boolean;
  users: ReadonlyMap<string, User>;
  chats: ReadonlyMap<string, Chat>;
  onReaction: (messageId: string, emoji: string, chosen: boolean) => Promise<void>;
  onLoadSenders: (
    messageId: string,
    type: MessageReactionType,
    offset?: string,
  ) => Promise<MessageReactionSenderPage>;
  onOpenSenderProfile: (senderId: string) => void;
}

interface ReactionDetailsState {
  reaction: MessageReaction;
  point: ContextMenuPoint;
  returnFocus: HTMLButtonElement;
  senders: MessageReactionSender[];
  totalCount: number;
  nextOffset?: string;
  loading: boolean;
  error?: string;
  limited: boolean;
  requestId: number;
}

const reactionKey = (type: MessageReactionType) => {
  if (type.kind === "emoji") return `emoji:${type.emoji}`;
  if (type.kind === "customEmoji") return `custom:${type.customEmojiId}`;
  return "paid";
};

const reactionLabel = (reaction: MessageReaction) => {
  if (reaction.type.kind === "emoji") return reaction.type.emoji;
  if (reaction.type.kind === "paid") return "★";
  return "◇";
};

const senderPresentation = (
  senderId: string,
  users: ReadonlyMap<string, User>,
  chats: ReadonlyMap<string, Chat>,
) => {
  if (senderId.startsWith("chat:")) {
    const chat = chats.get(senderId.slice("chat:".length));
    if (chat) return { name: chat.title, avatar: chat.avatar, available: true };
  } else {
    const user = users.get(senderId);
    if (user) return { name: user.displayName, avatar: user.avatar, available: true };
  }
  return {
    name: "Telegram 用户",
    avatar: { label: "?", color: "#73828c" },
    available: false,
  };
};

const mergeSenders = (
  current: MessageReactionSender[],
  incoming: MessageReactionSender[],
) => {
  const byId = new Map(current.map((sender) => [sender.senderId, sender]));
  for (const sender of incoming) byId.set(sender.senderId, sender);
  return [...byId.values()];
};

export function MessageReactions({
  messageId,
  reactions,
  canGetAddedReactions,
  users,
  chats,
  onReaction,
  onLoadSenders,
  onOpenSenderProfile,
}: MessageReactionsProps) {
  const [reactionPending, setReactionPending] = useState<string>();
  const [details, setDetails] = useState<ReactionDetailsState>();
  const requestIdRef = useRef(0);

  const closeDetails = useCallback(() => {
    requestIdRef.current += 1;
    setDetails(undefined);
  }, []);

  const loadDetailsPage = useCallback(async (
    reaction: MessageReaction,
    requestId: number,
    offset?: string,
  ) => {
    try {
      const page = await onLoadSenders(messageId, reaction.type, offset);
      if (requestIdRef.current !== requestId) return;
      setDetails((current) => current?.requestId === requestId ? {
        ...current,
        senders: mergeSenders(current.senders, page.senders),
        totalCount: page.totalCount,
        nextOffset: page.nextOffset,
        loading: false,
        error: undefined,
        limited: false,
      } : current);
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setDetails((current) => current?.requestId === requestId ? {
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "无法读取回应者",
      } : current);
    }
  }, [messageId, onLoadSenders]);

  const openDetails = useCallback((
    reaction: MessageReaction,
    point: ContextMenuPoint,
    returnFocus: HTMLButtonElement,
  ) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const canLoad = canGetAddedReactions !== false && reaction.type.kind !== "paid";
    setDetails({
      reaction,
      point,
      returnFocus,
      senders: reaction.recentSenderIds.map((senderId) => ({
        senderId,
        type: reaction.type,
        outgoing: false,
      })),
      totalCount: reaction.totalCount,
      loading: canLoad,
      limited: !canLoad && reaction.totalCount > reaction.recentSenderIds.length,
      requestId,
    });
    if (canLoad) void loadDetailsPage(reaction, requestId);
  }, [canGetAddedReactions, loadDetailsPage]);

  const loadMore = useCallback(() => {
    if (!details?.nextOffset || details.loading) return;
    setDetails((current) => current ? { ...current, loading: true, error: undefined } : current);
    void loadDetailsPage(details.reaction, details.requestId, details.nextOffset);
  }, [details, loadDetailsPage]);

  const toggleReaction = useCallback(async (reaction: MessageReaction) => {
    if (reactionPending || reaction.type.kind !== "emoji") return;
    const emoji = reaction.type.emoji;
    setReactionPending(emoji);
    try {
      await onReaction(messageId, emoji, !reaction.chosen);
    } finally {
      setReactionPending(undefined);
    }
  }, [messageId, onReaction, reactionPending]);

  const openProfile = useCallback((senderId: string) => {
    closeDetails();
    onOpenSenderProfile(senderId);
  }, [closeDetails, onOpenSenderProfile]);

  return (
    <>
      <div className="message-reactions" role="group" aria-label="消息回应">
        {reactions.map((reaction) => {
          const label = reactionLabel(reaction);
          const avatarIds = reaction.recentSenderIds.slice(0, 3);
          const overflowCount = Math.max(0, reaction.totalCount - avatarIds.length);
          const pending = reaction.type.kind === "emoji" && reactionPending === reaction.type.emoji;
          return (
            <button
              type="button"
              className={reaction.chosen ? "is-chosen" : ""}
              key={reactionKey(reaction.type)}
              aria-pressed={reaction.type.kind === "emoji" ? reaction.chosen : undefined}
              aria-label={`${label}，${reaction.totalCount} 个回应，右键查看回应者`}
              aria-disabled={reaction.type.kind !== "emoji" || pending}
              onClick={() => void toggleReaction(reaction)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openDetails(
                  reaction,
                  { x: event.clientX, y: event.clientY },
                  event.currentTarget,
                );
              }}
              onKeyDown={(event) => {
                if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                event.preventDefault();
                event.stopPropagation();
                const bounds = event.currentTarget.getBoundingClientRect();
                openDetails(
                  reaction,
                  { x: bounds.left + bounds.width / 2, y: bounds.bottom + 4 },
                  event.currentTarget,
                );
              }}
            >
              <span className="message-reaction-emoji" aria-hidden="true">
                {pending ? <LoaderCircle className="spin" size={14} /> : label}
              </span>
              {avatarIds.length > 0 && (
                <span className="message-reaction-avatars" aria-hidden="true">
                  {avatarIds.map((senderId) => {
                    const sender = senderPresentation(senderId, users, chats);
                    return <Avatar key={senderId} avatar={sender.avatar} size="small" />;
                  })}
                </span>
              )}
              {(overflowCount > 0 || avatarIds.length === 0) && (
                <span className="message-reaction-count">
                  {avatarIds.length > 0 ? `+${overflowCount}` : reaction.totalCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {details && (
        <ContextMenuSurface
          label={`${reactionLabel(details.reaction)} 的回应者`}
          point={details.point}
          className="reaction-details-surface"
          restoreFocus={() => details.returnFocus.focus({ preventScroll: true })}
          onClose={closeDetails}
        >
          <ContextMenuPanel className="reaction-details-panel">
            <div className="reaction-details-list">
              {details.senders.map((sender) => {
                const presentation = senderPresentation(sender.senderId, users, chats);
                return (
                  <button
                    type="button"
                    role="menuitem"
                    className="reaction-details-user"
                    key={sender.senderId}
                    disabled={!presentation.available}
                    onClick={() => openProfile(sender.senderId)}
                  >
                    <Avatar avatar={presentation.avatar} size="small" />
                    <span>{presentation.name}</span>
                  </button>
                );
              })}
              {details.senders.length === 0 && !details.loading && !details.error && (
                <p className="reaction-details-status">暂无可显示的回应者</p>
              )}
            </div>
            {details.error && <p className="reaction-details-status is-error" role="status">{details.error}</p>}
            {details.limited && (
              <p className="reaction-details-status">Telegram 仅提供最近的回应者</p>
            )}
            {details.nextOffset && !details.loading && (
              <button className="reaction-details-more" type="button" role="menuitem" onClick={loadMore}>
                加载更多
              </button>
            )}
          </ContextMenuPanel>
        </ContextMenuSurface>
      )}
    </>
  );
}
