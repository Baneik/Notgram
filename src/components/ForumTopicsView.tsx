import { translate } from "../i18n";
import { ChatMembershipBar, needsMembershipBar } from "./ChatMembershipBar";
import {
  ArrowLeft,
  Check,
  Hash,
  LockKeyhole,
  MoreVertical,
  Pencil,
  Pin,
  Plus,
  X,
} from "lucide-react";
import { FormEvent, useMemo, useRef, useState } from "react";
import { messagePreviewText } from "../telegram/messageContent";
import { useStableVisibility } from "../hooks/useStableVisibility";
import type { Chat, ForumTopic } from "../telegram/types";
import { Avatar } from "./Avatar";
import { MotionPresence } from "./MotionPresence";
import { useFlipListMotion } from "../hooks/useFlipListMotion";
import { formatUnreadCount } from "../utils/formatters";

interface ForumTopicsViewProps {
  chat: Chat;
  topics: ForumTopic[];
  loading: boolean;
  onBack: () => void;
  onSelectTopic: (topicId: string) => void;
  onCreateTopic: (name: string) => Promise<ForumTopic | undefined>;
  onEditTopic: (topicId: string, name: string) => Promise<boolean>;
  onSetTopicClosed: (topicId: string, closed: boolean) => Promise<boolean>;
  onSetTopicPinned: (topicId: string, pinned: boolean) => Promise<boolean>;
  mobileViewport?: boolean;
  mobileChatOpen?: boolean;
}

const topicIconColor = (color: number) => `#${(color >>> 0).toString(16).padStart(6, "0").slice(-6)}`;

export function ForumTopicsView({
  chat,
  topics,
  loading,
  onBack,
  onSelectTopic,
  onCreateTopic,
  onEditTopic,
  onSetTopicClosed,
  onSetTopicPinned,
  mobileViewport = false,
  mobileChatOpen = false,
}: ForumTopicsViewProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingTopicId, setEditingTopicId] = useState<string>();
  const [editingName, setEditingName] = useState("");
  const [menuTopicId, setMenuTopicId] = useState<string>();
  const [pendingTopicId, setPendingTopicId] = useState<string>();
  const topicsListRef = useRef<HTMLDivElement>(null);
  const canManage = chat.isMember !== false && chat.management?.canManageTopics === true;
  const canCreate = chat.isMember !== false && (canManage || chat.canCreateTopics === true);
  const showLoading = useStableVisibility(loading && topics.length === 0);
  const orderedTopics = useMemo(
    () => [...topics].sort((left, right) => Number(right.isPinned) - Number(left.isPinned) || Number(right.order) - Number(left.order)),
    [topics],
  );
  useFlipListMotion({
    containerRef: topicsListRef,
    itemSelector: ".forum-topic-row[data-motion-key]",
    dependencies: [orderedTopics],
  });

  const submitNewTopic = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setPendingTopicId("new");
    const topic = await onCreateTopic(name);
    setPendingTopicId(undefined);
    if (!topic) return;
    setNewName("");
    setCreating(false);
    onSelectTopic(topic.id);
  };

  const submitEdit = async (event: FormEvent<HTMLFormElement>, topicId: string) => {
    event.preventDefault();
    const name = editingName.trim();
    if (!name) return;
    setPendingTopicId(topicId);
    const updated = await onEditTopic(topicId, name);
    setPendingTopicId(undefined);
    if (updated) setEditingTopicId(undefined);
  };

  const toggleTopic = async (topic: ForumTopic, action: "closed" | "pinned") => {
    setPendingTopicId(topic.id);
    if (action === "closed") await onSetTopicClosed(topic.id, !topic.isClosed);
    else await onSetTopicPinned(topic.id, !topic.isPinned);
    setPendingTopicId(undefined);
    setMenuTopicId(undefined);
  };

  return (
    <section
      className="forum-topics-view"
      aria-label={translate("{{value0}} 话题", { value0: chat.title })}
      aria-hidden={mobileViewport && !mobileChatOpen ? true : undefined}
      inert={mobileViewport && !mobileChatOpen ? true : undefined}
    >
      <header className="conversation-header forum-topics-header">
        <button className="mobile-back icon-button" type="button" aria-label={translate("返回会话列表")} title={translate("返回会话列表")} onClick={onBack}>
          <ArrowLeft size={20} strokeWidth={1.9} />
        </button>
        <button className="conversation-profile-trigger" type="button" aria-label={chat.title} title={chat.title}>
          <Avatar avatar={chat.avatar} size="medium" />
          <span className="conversation-title">
            <strong>{chat.title}</strong>
            <span className="conversation-typing-status">{translate("话题")}</span>
          </span>
        </button>
        {canCreate && (
          <button
            className="icon-button forum-topic-create"
            type="button"
            aria-label={translate("创建话题")}
            title={translate("创建话题")}
            onClick={() => setCreating(true)}
          >
            <Plus size={20} strokeWidth={2} />
          </button>
        )}
      </header>

      <div className="forum-topics-content">
        {creating && (
          <form className="forum-topic-form" onSubmit={submitNewTopic}>
            <Hash size={18} aria-hidden="true" />
            <input
              autoFocus
              value={newName}
              maxLength={128}
              placeholder={translate("话题名称")}
              onChange={(event) => setNewName(event.target.value)}
            />
            <button className="icon-button" type="submit" aria-label={translate("确认创建")} title={translate("确认创建")} disabled={!newName.trim() || pendingTopicId === "new"}>
              <Check size={18} strokeWidth={2} />
            </button>
            <button className="icon-button" type="button" aria-label={translate("取消创建")} title={translate("取消创建")} onClick={() => { setCreating(false); setNewName(""); }} disabled={pendingTopicId === "new"}>
              <X size={18} strokeWidth={2} />
            </button>
          </form>
        )}

        <MotionPresence present={showLoading || (!loading && orderedTopics.length === 0)} variant="status">
          {showLoading || (!loading && orderedTopics.length === 0) ? (
            <div key={showLoading ? "loading" : "empty"} className="forum-topics-state" role="status">
              {showLoading ? translate("正在加载话题") : translate("暂无话题")}
            </div>
          ) : null}
        </MotionPresence>
        {orderedTopics.length > 0 && (
          <div className="forum-topic-list" ref={topicsListRef}>
            {orderedTopics.map((topic) => (
              <article className={`forum-topic-row ${topic.isClosed ? "is-closed" : ""}`} data-motion-key={topic.id} key={topic.id}>
                {editingTopicId === topic.id ? (
                  <form className="forum-topic-form forum-topic-edit" onSubmit={(event) => void submitEdit(event, topic.id)}>
                    <span className="forum-topic-icon" style={{ backgroundColor: topicIconColor(topic.iconColor) }}><Hash size={17} /></span>
                    <input autoFocus value={editingName} maxLength={128} onChange={(event) => setEditingName(event.target.value)} />
                    <button className="icon-button" type="submit" aria-label={translate("保存话题")} title={translate("保存")} disabled={!editingName.trim() || pendingTopicId === topic.id}><Check size={18} /></button>
                    <button className="icon-button" type="button" aria-label={translate("取消编辑")} title={translate("取消")} onClick={() => setEditingTopicId(undefined)} disabled={pendingTopicId === topic.id}><X size={18} /></button>
                  </form>
                ) : (
                  <>
                    <button className="forum-topic-main" type="button" onClick={() => onSelectTopic(topic.id)}>
                      <span className="forum-topic-icon" style={{ backgroundColor: topicIconColor(topic.iconColor) }}><Hash size={17} /></span>
                      <span className="forum-topic-copy">
                        <span className="forum-topic-name">{topic.name}</span>
                        <span className="forum-topic-preview">{topic.lastMessage ? messagePreviewText(topic.lastMessage.content) : translate("暂无消息")}</span>
                      </span>
                      <span className="forum-topic-meta">
                        {topic.isPinned && <Pin size={14} strokeWidth={1.9} aria-label={translate("已置顶")} />}
                        {topic.isClosed && <LockKeyhole size={14} strokeWidth={1.9} aria-label={translate("已关闭")} />}
                        {(topic.unreadCount > 0 || topic.unreadReactionCount > 0) && (
                          <strong
                            className={topic.unreadCount === 0 ? "has-reaction" : undefined}
                            aria-label={topic.unreadCount > 0
                              ? translate("{{value0}} 条未读消息", { value0: topic.unreadCount })
                              : translate("{{value0}} 条未读回应", { value0: topic.unreadReactionCount })}
                          >
                            {formatUnreadCount(topic.unreadCount > 0
                              ? topic.unreadCount
                              : topic.unreadReactionCount)}
                          </strong>
                        )}
                      </span>
                    </button>
                    {(canManage || topic.isOutgoing) && <div className="forum-topic-actions">
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={translate("{{value0}} 更多操作", { value0: topic.name })}
                        title={translate("更多操作")}
                        disabled={pendingTopicId === topic.id}
                        onClick={() => setMenuTopicId((value) => value === topic.id ? undefined : topic.id)}
                      >
                        <MoreVertical size={18} strokeWidth={1.8} />
                      </button>
                      <MotionPresence present={menuTopicId === topic.id} variant="popover">
                        {menuTopicId === topic.id ? <div className="forum-topic-menu" role="menu">
                          <button type="button" role="menuitem" onClick={() => { setEditingTopicId(topic.id); setEditingName(topic.name); setMenuTopicId(undefined); }}><Pencil size={16} />{translate("重命名")}</button>
                          {canManage && <button type="button" role="menuitem" onClick={() => void toggleTopic(topic, "pinned")}><Pin size={16} />{topic.isPinned ? translate("取消置顶") : translate("置顶")}</button>}
                          <button type="button" role="menuitem" onClick={() => void toggleTopic(topic, "closed")}><LockKeyhole size={16} />{topic.isClosed ? translate("重新开启") : translate("关闭话题")}</button>
                        </div> : null}
                      </MotionPresence>
                    </div>}
                  </>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
      {needsMembershipBar(chat) && <ChatMembershipBar chat={chat} />}
    </section>
  );
}
