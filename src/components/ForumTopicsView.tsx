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
import { FormEvent, useMemo, useState } from "react";
import { messageContentText } from "../telegram/messageContent";
import type { Chat, ForumTopic } from "../telegram/types";
import { Avatar } from "./Avatar";

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
}: ForumTopicsViewProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingTopicId, setEditingTopicId] = useState<string>();
  const [editingName, setEditingName] = useState("");
  const [menuTopicId, setMenuTopicId] = useState<string>();
  const [pendingTopicId, setPendingTopicId] = useState<string>();
  const canCreate = chat.canCreateTopics === true;
  const orderedTopics = useMemo(
    () => [...topics].sort((left, right) => Number(right.isPinned) - Number(left.isPinned) || Number(right.order) - Number(left.order)),
    [topics],
  );

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
    <section className="forum-topics-view" aria-label={`${chat.title} 话题`}>
      <header className="conversation-header forum-topics-header">
        <button className="mobile-back icon-button" type="button" aria-label="返回会话列表" title="返回会话列表" onClick={onBack}>
          <ArrowLeft size={20} strokeWidth={1.9} />
        </button>
        <button className="conversation-profile-trigger" type="button" aria-label={chat.title} title={chat.title}>
          <Avatar avatar={chat.avatar} size="medium" />
          <span className="conversation-title">
            <strong>{chat.title}</strong>
            <span className="conversation-typing-status">话题</span>
          </span>
        </button>
        {canCreate && (
          <button
            className="icon-button forum-topic-create"
            type="button"
            aria-label="创建话题"
            title="创建话题"
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
              placeholder="话题名称"
              onChange={(event) => setNewName(event.target.value)}
            />
            <button className="icon-button" type="submit" aria-label="确认创建" title="确认创建" disabled={!newName.trim() || pendingTopicId === "new"}>
              <Check size={18} strokeWidth={2} />
            </button>
            <button className="icon-button" type="button" aria-label="取消创建" title="取消创建" onClick={() => { setCreating(false); setNewName(""); }} disabled={pendingTopicId === "new"}>
              <X size={18} strokeWidth={2} />
            </button>
          </form>
        )}

        {loading && topics.length === 0 ? (
          <div className="forum-topics-state">正在加载话题</div>
        ) : orderedTopics.length === 0 ? (
          <div className="forum-topics-state">暂无话题</div>
        ) : (
          <div className="forum-topic-list">
            {orderedTopics.map((topic) => (
              <article className={`forum-topic-row ${topic.isClosed ? "is-closed" : ""}`} key={topic.id}>
                {editingTopicId === topic.id ? (
                  <form className="forum-topic-form forum-topic-edit" onSubmit={(event) => void submitEdit(event, topic.id)}>
                    <span className="forum-topic-icon" style={{ backgroundColor: topicIconColor(topic.iconColor) }}><Hash size={17} /></span>
                    <input autoFocus value={editingName} maxLength={128} onChange={(event) => setEditingName(event.target.value)} />
                    <button className="icon-button" type="submit" aria-label="保存话题" title="保存" disabled={!editingName.trim() || pendingTopicId === topic.id}><Check size={18} /></button>
                    <button className="icon-button" type="button" aria-label="取消编辑" title="取消" onClick={() => setEditingTopicId(undefined)} disabled={pendingTopicId === topic.id}><X size={18} /></button>
                  </form>
                ) : (
                  <>
                    <button className="forum-topic-main" type="button" onClick={() => onSelectTopic(topic.id)}>
                      <span className="forum-topic-icon" style={{ backgroundColor: topicIconColor(topic.iconColor) }}><Hash size={17} /></span>
                      <span className="forum-topic-copy">
                        <span className="forum-topic-name">{topic.name}</span>
                        <span className="forum-topic-preview">{topic.lastMessage ? messageContentText(topic.lastMessage.content) : "暂无消息"}</span>
                      </span>
                      <span className="forum-topic-meta">
                        {topic.isPinned && <Pin size={14} strokeWidth={1.9} aria-label="已置顶" />}
                        {topic.isClosed && <LockKeyhole size={14} strokeWidth={1.9} aria-label="已关闭" />}
                        {topic.unreadCount > 0 && <strong>{topic.unreadCount > 99 ? "99+" : topic.unreadCount}</strong>}
                      </span>
                    </button>
                    <div className="forum-topic-actions">
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`${topic.name} 更多操作`}
                        title="更多操作"
                        disabled={pendingTopicId === topic.id}
                        onClick={() => setMenuTopicId((value) => value === topic.id ? undefined : topic.id)}
                      >
                        <MoreVertical size={18} strokeWidth={1.8} />
                      </button>
                      {menuTopicId === topic.id && (
                        <div className="forum-topic-menu" role="menu">
                          <button type="button" role="menuitem" onClick={() => { setEditingTopicId(topic.id); setEditingName(topic.name); setMenuTopicId(undefined); }}><Pencil size={16} />重命名</button>
                          <button type="button" role="menuitem" onClick={() => void toggleTopic(topic, "pinned")}><Pin size={16} />{topic.isPinned ? "取消置顶" : "置顶"}</button>
                          <button type="button" role="menuitem" onClick={() => void toggleTopic(topic, "closed")}><LockKeyhole size={16} />{topic.isClosed ? "重新开启" : "关闭话题"}</button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
