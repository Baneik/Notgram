import {
  AtSign,
  Fingerprint,
  Image,
  LoaderCircle,
  MessageCircle,
  Network,
  Phone,
  RefreshCw,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import type { ProfileState } from "../store/profileState";
import type { Chat, ForwardMessagesResult, SharedMediaPage, SharedMediaSearchInput } from "../telegram/types";
import { useModalFocus } from "../hooks/useModalFocus";
import { Avatar } from "./Avatar";
import { SharedMediaBrowser } from "./SharedMediaBrowser";

interface ProfileDrawerProps {
  state: ProfileState;
  forwardTargets: Chat[];
  currentUserId?: string;
  onClose: () => void;
  onRetry: () => void;
  onOpenMessage: (chatId: string, messageId: string) => void;
  onStartPrivateChat: (userId: string) => Promise<void>;
  onOpenUserProfile: (userId: string) => void;
  onLoadSharedMedia: (input: SharedMediaSearchInput, force?: boolean) => Promise<SharedMediaPage | undefined>;
  onDownloadFile: (fileId: number, fileName: string) => Promise<void>;
  onDeleteMessages: (chatId: string, messageIds: string[], revoke: boolean) => Promise<boolean>;
  onForwardMessages: (fromChatId: string, messageIds: string[], toChatId: string) => Promise<ForwardMessagesResult | undefined>;
}

const roleLabel = (role: "owner" | "administrator" | "member") =>
  role === "owner" ? "群主" : role === "administrator" ? "管理员" : "成员";

export function ProfileDrawer({
  state,
  forwardTargets,
  currentUserId,
  onClose,
  onRetry,
  onOpenMessage,
  onStartPrivateChat,
  onOpenUserProfile,
  onLoadSharedMedia,
  onDownloadFile,
  onDeleteMessages,
  onForwardMessages,
}: ProfileDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalFocus<HTMLElement>(onClose, false, closeRef);
  const [mediaOpen, setMediaOpen] = useState(false);
  const profile = state.value;

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
          ) : state.error && !profile ? (
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
              {(profile.kind === "user" || profile.kind === "self") && (
                <section className="profile-identity-card" aria-label="用户账户信息">
                  {profile.username && (
                    <div><AtSign size={19} /><span><strong>@{profile.username}</strong><small>用户名</small></span></div>
                  )}
                  {profile.phoneNumber && profile.kind === "self" && (
                    <div><Phone size={19} /><span><strong>{profile.phoneNumber}</strong><small>手机号</small></span></div>
                  )}
                  <div><Fingerprint size={19} /><span><strong>{profile.userId}</strong><small>用户 ID</small></span></div>
                  <div><Network size={19} /><span><strong>{profile.dataCenterId ? `DC${profile.dataCenterId}, ${profile.dataCenterLocation}` : profile.dataCenterLocation}</strong><small>数据中心</small></span></div>
                </section>
              )}
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
                  </div>
                  <SharedMediaBrowser
                    chatId={profile.chatId}
                    forwardTargets={forwardTargets}
                    onLoad={onLoadSharedMedia}
                    onOpenMessage={onOpenMessage}
                    onDownload={onDownloadFile}
                    onDelete={onDeleteMessages}
                    onForward={onForwardMessages}
                  />
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
                          <button
                            className="profile-member-identity"
                            type="button"
                            onClick={() => onOpenUserProfile(member.user.id)}
                          >
                            <Avatar avatar={member.user.avatar} size="small" />
                            <span><strong>{member.user.displayName}</strong><small>{roleLabel(member.role)}</small></span>
                          </button>
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
