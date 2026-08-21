import {
  Check,
  ChevronLeft,
  Forward,
  Hash,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  forwardTargetKey,
  type ForwardTargetSelection,
} from "../hooks/useMessageForwarding";
import { useModalFocus } from "../hooks/useModalFocus";
import type { Chat, ForumTopic, ForumTopicPage } from "../telegram/types";
import { Avatar } from "./Avatar";
import { messageSummary } from "./conversationMessages";

interface ForwardMessagesDialogProps {
  selectedCount: number;
  targets: Chat[];
  topicsByChat: Map<string, ForumTopic[]>;
  currentChatId: string;
  initialTargetId?: string;
  query: string;
  pending: boolean;
  pendingTargetId?: string;
  onQueryChange: (query: string) => void;
  onLoadTopics: (chatId: string) => Promise<ForumTopicPage | undefined>;
  onConfirm: (targets: ForwardTargetSelection[], description: string) => void;
  onClose: () => void;
}

export function ForwardMessagesDialog({
  selectedCount,
  targets,
  topicsByChat,
  currentChatId,
  initialTargetId,
  query,
  pending,
  pendingTargetId,
  onQueryChange,
  onLoadTopics,
  onConfirm,
  onClose,
}: ForwardMessagesDialogProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalFocus<HTMLElement>(onClose, pending, searchRef);
  const [selectedTargets, setSelectedTargets] = useState<ForwardTargetSelection[]>([]);
  const [forumTarget, setForumTarget] = useState<Chat>();
  const [topicQuery, setTopicQuery] = useState("");
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [description, setDescription] = useState("");
  const topics = forumTarget
    ? (topicsByChat.get(forumTarget.id) ?? []).filter((topic) => {
        const normalized = topicQuery.trim().toLocaleLowerCase();
        return !topic.isHidden && (!normalized || topic.name.toLocaleLowerCase().includes(normalized));
      })
    : [];

  useEffect(() => {
    if (!initialTargetId) return;
    const target = targets.find((candidate) => candidate.id === initialTargetId);
    if (target?.isForum) setForumTarget(target);
  }, [initialTargetId, targets]);

  useEffect(() => {
    if (!forumTarget || topicsByChat.has(forumTarget.id)) return;
    setTopicsLoading(true);
    void onLoadTopics(forumTarget.id).finally(() => setTopicsLoading(false));
  }, [forumTarget, onLoadTopics, topicsByChat]);

  const isSelected = (target: ForwardTargetSelection) => selectedTargets.some(
    (candidate) => forwardTargetKey(candidate) === forwardTargetKey(target),
  );
  const selectedTopicCount = (chatId: string) => selectedTargets.filter(
    (target) => target.chat.id === chatId && target.topicId,
  ).length;
  const toggleTarget = (target: ForwardTargetSelection) => {
    const key = forwardTargetKey(target);
    setSelectedTargets((current) => current.some((candidate) => forwardTargetKey(candidate) === key)
      ? current.filter((candidate) => forwardTargetKey(candidate) !== key)
      : [...current, target]);
  };
  const chooseTarget = (target: Chat) => {
    if (!target.isForum) {
      toggleTarget({ chat: target });
      return;
    }
    setForumTarget(target);
    setTopicQuery("");
  };
  const chooseTopic = (topic: ForumTopic) => {
    if (!forumTarget || topic.isClosed) return;
    toggleTarget({ chat: forumTarget, topicId: topic.id });
  };

  return (
    <div
      className="message-delete-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="message-forward-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-forward-title"
        tabIndex={-1}
      >
        <header className="message-forward-heading">
          {forumTarget ? (
            <button
              className="message-forward-heading-icon"
              type="button"
              aria-label="返回会话选择"
              title="返回"
              disabled={pending}
              onClick={() => setForumTarget(undefined)}
            >
              <ChevronLeft size={18} strokeWidth={1.9} />
            </button>
          ) : (
            <span className="message-forward-heading-icon"><Forward size={18} strokeWidth={1.9} /></span>
          )}
          <div>
            <h3 id="message-forward-title">转发 {selectedCount} 条消息</h3>
            <p>{forumTarget
              ? `选择“${forumTarget.title}”中的话题`
              : selectedTargets.length > 0 ? `已选择 ${selectedTargets.length} 个会话` : "选择一个或多个目标会话"}</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭转发"
            title="关闭"
            disabled={pending}
            onClick={onClose}
          >
            <X size={18} strokeWidth={1.9} />
          </button>
        </header>
        <label className="forward-target-search">
          <Search size={16} strokeWidth={1.8} />
          <span className="sr-only">{forumTarget ? "搜索目标话题" : "搜索目标会话"}</span>
          <input
            ref={searchRef}
            value={forumTarget ? topicQuery : query}
            onChange={(event) => forumTarget ? setTopicQuery(event.target.value) : onQueryChange(event.target.value)}
            placeholder={forumTarget ? "搜索话题" : "搜索会话"}
            type="search"
            disabled={pending}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              event.currentTarget.closest(".message-forward-dialog")
                ?.querySelector<HTMLButtonElement>(".forward-target-row:not([disabled])")
                ?.focus();
            }}
          />
        </label>
        <div
          className="forward-target-list"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              ".forward-target-row:not([disabled])",
            )];
            if (rows.length === 0) return;
            event.preventDefault();
            const index = rows.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "ArrowUp" && index <= 0) {
              searchRef.current?.focus();
              return;
            }
            const nextIndex = event.key === "Home"
              ? 0
              : event.key === "End"
                ? rows.length - 1
                : event.key === "ArrowDown"
                  ? Math.min(rows.length - 1, index + 1)
                  : Math.max(0, index - 1);
            rows[nextIndex]?.focus();
          }}
        >
          {forumTarget ? topicsLoading && topics.length === 0 ? (
            <div className="forward-target-empty"><LoaderCircle className="spin" size={18} />正在加载话题</div>
          ) : topics.length === 0 ? (
            <div className="forward-target-empty">没有匹配的话题</div>
          ) : topics.map((topic) => {
            const selection = { chat: forumTarget, topicId: topic.id };
            const selected = isSelected(selection);
            return (
              <button
                className={`forward-target-row ${selected ? "is-selected" : ""}`}
                type="button"
                key={topic.id}
                disabled={pending || topic.isClosed}
                aria-pressed={selected}
                onClick={() => chooseTopic(topic)}
              >
                <span className="forward-topic-icon"><Hash size={17} /></span>
                <span><strong>{topic.name}</strong><small>{topic.isClosed ? "话题已关闭" : topic.lastMessage ? messageSummary(topic.lastMessage.content) : "暂无消息"}</small></span>
                {pending && pendingTargetId === forwardTargetKey(selection)
                  ? <LoaderCircle className="spin" size={16} />
                  : <span className="forward-target-check" aria-hidden="true">{selected ? <Check size={15} strokeWidth={2.4} /> : null}</span>}
              </button>
            );
          }) : targets.length === 0 ? (
            <div className="forward-target-empty">没有匹配的会话</div>
          ) : targets.map((target) => {
            const selection = { chat: target };
            const selected = !target.isForum && isSelected(selection);
            const topicCount = target.isForum ? selectedTopicCount(target.id) : 0;
            return (
              <button
                className={`forward-target-row ${selected || topicCount > 0 ? "is-selected" : ""}`}
                type="button"
                key={target.id}
                disabled={pending}
                aria-pressed={target.isForum ? undefined : selected}
                onClick={() => chooseTarget(target)}
              >
                <Avatar avatar={target.avatar} size="medium" />
                <span>
                  <strong>{target.title}</strong>
                  <small>{topicCount > 0
                    ? `已选择 ${topicCount} 个话题`
                    : target.id === currentChatId ? "当前会话" : target.preview}</small>
                </span>
                {target.isForum
                  ? <ChevronLeft className="forward-target-arrow" size={18} strokeWidth={1.8} />
                  : pending && pendingTargetId === forwardTargetKey(selection)
                    ? <LoaderCircle className="spin" size={16} />
                    : <span className="forward-target-check" aria-hidden="true">{selected ? <Check size={15} strokeWidth={2.4} /> : null}</span>}
              </button>
            );
          })}
        </div>
        <footer className="forward-dialog-footer">
          <label className="forward-description-field">
            <textarea
              value={description}
              maxLength={1024}
              rows={2}
              aria-label="转发附言"
              placeholder="附带一条消息（可选）"
              disabled={pending}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <button
            className={`forward-confirm-button ${selectedTargets.length > 0 ? "is-ready" : ""}`}
            type="button"
            disabled={pending || selectedTargets.length === 0}
            onClick={() => onConfirm(selectedTargets, description)}
          >
            {pending ? <LoaderCircle className="spin" size={16} /> : <Forward size={16} />}
            转发
          </button>
        </footer>
      </section>
    </div>
  );
}
