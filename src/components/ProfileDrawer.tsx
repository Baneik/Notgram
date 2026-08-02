import {
  Image,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { ProfileState } from "../store/profileState";
import type { Message } from "../telegram/types";
import { messageContentText } from "../telegram/messageContent";
import { formatChatTime } from "../utils/formatters";
import { useModalFocus } from "../hooks/useModalFocus";
import { Avatar } from "./Avatar";

interface ProfileDrawerProps {
  state: ProfileState;
  messages: Message[];
  currentUserId?: string;
  onClose: () => void;
  onRetry: () => void;
  onOpenMessage: (chatId: string, messageId: string) => void;
  onStartPrivateChat: (userId: string) => Promise<void>;
}

const roleLabel = (role: "owner" | "administrator" | "member") =>
  role === "owner" ? "群主" : role === "administrator" ? "管理员" : "成员";

export function ProfileDrawer({
  state,
  messages,
  currentUserId,
  onClose,
  onRetry,
  onOpenMessage,
  onStartPrivateChat,
}: ProfileDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalFocus<HTMLElement>(onClose, false, closeRef);
  const [mediaOpen, setMediaOpen] = useState(false);
  const profile = state.value;
  const sharedMedia = useMemo(
    () => messages.filter((message) =>
      message.content.kind === "media" || message.content.kind === "file",
    ),
    [messages],
  );

  return (
    <div className="profile-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        ref={dialogRef}
        className="profile-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-drawer-title"
        tabIndex={-1}
      >
        <header className="profile-drawer-header">
          <button ref={closeRef} className="icon-button" type="button" aria-label="关闭资料" title="关闭" onClick={onClose}>
            <X size={19} />
          </button>
          <h2 id="profile-drawer-title">资料</h2>
          <span />
        </header>
        <div className="profile-drawer-scroll">
          {state.loading && !profile ? (
            <div className="profile-state" role="status"><LoaderCircle className="spin" size={22} /></div>
          ) : state.error ? (
            <div className="profile-state is-error" role="alert">
              <span>{state.error}</span>
              <button className="dialog-secondary" type="button" onClick={onRetry}>
                <RefreshCw size={15} />
                <span>重试</span>
              </button>
            </div>
          ) : profile ? (
            <>
              <section className="profile-hero" aria-labelledby="profile-name">
                <Avatar avatar={profile.avatar} size="large" />
                <h3 id="profile-name">{profile.title}</h3>
                <span className="profile-status">{profile.statusLabel}</span>
                {profile.bio && <p>{profile.bio}</p>}
              </section>
              <div className="profile-actions">
                {profile.kind === "user" && profile.userId && profile.userId !== currentUserId && (
                  <button type="button" onClick={() => void onStartPrivateChat(profile.userId!)}>
                    <MessageCircle size={18} /><span>发消息</span>
                  </button>
                )}
                {profile.chatId && (
                  <button type="button" onClick={() => setMediaOpen((open) => !open)} aria-pressed={mediaOpen}>
                    <Image size={18} /><span>共享媒体</span>
                  </button>
                )}
              </div>
              {profile.groupInCommonCount !== undefined && profile.kind === "user" && (
                <section className="profile-info-section">
                  <h4>共同群组</h4>
                  <p>{profile.groupInCommonCount} 个共同群组</p>
                </section>
              )}
              {profile.chatId && mediaOpen && (
                <section className="profile-info-section" aria-labelledby="shared-media-heading">
                  <div className="profile-section-heading">
                    <h4 id="shared-media-heading">共享媒体</h4>
                    <span>{sharedMedia.length}</span>
                  </div>
                  {sharedMedia.length > 0 ? (
                    <div className="profile-media-list">
                      {sharedMedia.map((message) => (
                        <button
                          type="button"
                          key={message.id}
                          onClick={() => onOpenMessage(message.chatId, message.id)}
                        >
                          <Image size={16} />
                          <span>{messageContentText(message.content) || "媒体消息"}</span>
                          <time dateTime={message.sentAt}>{formatChatTime(message.sentAt)}</time>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p>当前已加载历史中没有媒体</p>
                  )}
                </section>
              )}
              {(profile.kind === "group" || profile.kind === "channel") && (
                <section className="profile-info-section" aria-labelledby="profile-members-heading">
                  <div className="profile-section-heading">
                    <h4 id="profile-members-heading">成员</h4>
                    {profile.memberCount !== undefined && <span>{profile.memberCount}</span>}
                  </div>
                  {profile.canViewMembers ? (
                    <div className="profile-member-list">
                      {profile.members.map((member) => (
                        <div className="profile-member-row" key={member.user.id}>
                          <Avatar avatar={member.user.avatar} size="small" />
                          <span><strong>{member.user.displayName}</strong><small>{roleLabel(member.role)}</small></span>
                          {member.user.id !== currentUserId && (
                            <button
                              type="button"
                              aria-label={`向 ${member.user.displayName} 发消息`}
                              title="发消息"
                              onClick={() => void onStartPrivateChat(member.user.id)}
                            >
                              <MessageCircle size={16} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p>此频道不公开成员列表</p>
                  )}
                </section>
              )}
            </>
          ) : (
            <div className="profile-state">没有可显示的资料</div>
          )}
        </div>
      </section>
    </div>
  );
}
