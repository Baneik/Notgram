import {
  AtSign,
  Ban,
  ChevronRight,
  Flag,
  Fingerprint,
  Image,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  Network,
  Phone,
  RefreshCw,
  Shield,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { ProfileState } from "../store/profileState";
import type { Chat, ForwardMessagesResult, SharedMediaPage, SharedMediaSearchInput } from "../telegram/types";
import type { ChatReportOptions, ReportChatInput } from "../telegram/types";
import { useModalFocus } from "../hooks/useModalFocus";
import { useStableVisibility } from "../hooks/useStableVisibility";
import { useTelegramStore } from "../store/telegramStore";
import { usePreferencesStore } from "../store/preferencesStore";
import { colorThemeForThemeId } from "../theme/theme";
import { openMediaViewerWindow, syncMediaViewerWindow } from "../media/mediaViewerWindowBridge";
import type { PhotoMessage } from "../utils/mediaViewerModel";
import { Avatar } from "./Avatar";
import { MotionPresence } from "./MotionPresence";
import { SharedMediaBrowser } from "./SharedMediaBrowser";
import { ReportDialog } from "./SafetySettings";

interface ProfileDrawerProps {
  state: ProfileState;
  forwardTargets: Chat[];
  currentUserId?: string;
  onClose: () => void;
  onRetry: () => void;
  onOpenMessage: (chatId: string, messageId: string) => void;
  onStartPrivateChat: (userId: string) => Promise<void>;
  onManageChat: (chatId: string) => void;
  canManageChat?: boolean;
  isBlocked?: boolean;
  onToggleBlock: (senderId: string, kind: "user" | "chat", blocked: boolean) => Promise<boolean>;
  onGetReportOptions: (chatId: string, messageIds: string[]) => Promise<ChatReportOptions | undefined>;
  onReportChat: (input: ReportChatInput) => Promise<boolean>;
  reportChatId?: string;
  onDeleteChat?: () => Promise<boolean>;
  onOpenUserProfile: (userId: string) => void;
  onOpenChat: (chatId: string) => void;
  onLoadMoreMembers: (chatId: string) => Promise<boolean>;
  onLoadSharedMedia: (input: SharedMediaSearchInput, force?: boolean) => Promise<SharedMediaPage | undefined>;
  onDownloadFile: (fileId: number, fileName: string) => Promise<void>;
  onLoadMessageProperties: (chatId: string, messageId: string) => Promise<import("../telegram/types").MessagePermissions | undefined>;
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
  onManageChat,
  canManageChat,
  isBlocked,
  onToggleBlock,
  onGetReportOptions,
  onReportChat,
  reportChatId,
  onDeleteChat,
  onOpenUserProfile,
  onOpenChat,
  onLoadMoreMembers,
  onLoadSharedMedia,
  onDownloadFile,
  onLoadMessageProperties,
  onDeleteMessages,
  onForwardMessages,
}: ProfileDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalFocus<HTMLElement>(onClose, false, closeRef);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const cacheFile = useTelegramStore((store) => store.cacheFile);
  const colorTheme = usePreferencesStore((store) => colorThemeForThemeId(store.themeId));
  const profile = state.value;
  const waitingForProfile = state.loading && !profile;
  const showProfileLoading = useStableVisibility(waitingForProfile);
  const showMembersLoading = useStableVisibility(Boolean(state.membersLoading), { minimumVisible: 220 });
  const statusKind = showProfileLoading
    ? "loading"
    : !waitingForProfile && state.error && !profile
      ? "error"
      : !waitingForProfile && !profile ? "empty" : undefined;
  const profilePhotoMessages = useMemo<PhotoMessage[]>(() => (
    profile?.profilePhotos ?? []
  ).map((photo) => ({
    id: `profile-photo:${photo.id}`,
    chatId: `profile:${profile?.userId ?? profile?.id ?? "unknown"}`,
    senderId: profile?.userId ?? profile?.id ?? "unknown",
    outgoing: profile?.kind === "self",
    sentAt: photo.addedAt ?? "1970-01-01T00:00:00.000Z",
    delivery: "read",
    content: photo.content,
  })), [profile?.id, profile?.kind, profile?.profilePhotos, profile?.userId]);
  const downloadProfilePhoto = useCallback(async (fileId: number, fileName: string) => {
    await onDownloadFile(fileId, fileName);
    onRetry();
  }, [onDownloadFile, onRetry]);
  const openProfileAvatar = useCallback(() => {
    const active = profilePhotoMessages[0];
    if (!active) return;
    for (const photo of profilePhotoMessages.slice(0, 25)) {
      const content = photo.content;
      if (
        content.thumbnailFileId !== undefined &&
        content.thumbnailCanDownload === true &&
        !content.thumbnailPath &&
        !content.thumbnailIsDownloading
      ) {
        void cacheFile(content.thumbnailFileId, 32).catch(() => undefined);
      }
    }
    void openMediaViewerWindow({
      messages: profilePhotoMessages,
      activeMessageId: active.id,
      colorTheme,
    }, downloadProfilePhoto);
    const content = active.content;
    if (
      content.fileId !== undefined &&
      content.canDownload !== false &&
      !content.isDownloading &&
      !content.isDownloaded
    ) {
      void downloadProfilePhoto(content.fileId, content.fileName);
    }
  }, [cacheFile, colorTheme, downloadProfilePhoto, profilePhotoMessages]);
  const openCommonGroup = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const chatId = event.currentTarget.dataset.chatId;
    if (chatId) onOpenChat(chatId);
  }, [onOpenChat]);

  useEffect(() => {
    syncMediaViewerWindow(profilePhotoMessages, colorTheme);
  }, [colorTheme, profilePhotoMessages]);

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
          <MotionPresence present={Boolean(statusKind)} variant="status">
            {statusKind ? (
              <div key={statusKind} className={`profile-state ${statusKind === "error" ? "is-error" : ""}`.trim()} role={statusKind === "error" ? "alert" : "status"}>
                {statusKind === "loading" ? <LoaderCircle className="spin" size={22} /> : statusKind === "error" ? (
                  <><span>{state.error}</span><button className="dialog-secondary" type="button" onClick={onRetry}><RefreshCw size={15} /><span>重试</span></button></>
                ) : <span>没有可显示的资料</span>}
              </div>
            ) : null}
          </MotionPresence>
          {!statusKind && profile ? (
            <>
              <section className="profile-hero" aria-labelledby="profile-name">
                {profilePhotoMessages.length > 0 ? (
                  <button
                    className="profile-avatar-button"
                    type="button"
                    aria-label={`查看 ${profile.title} 的头像和历史头像`}
                    title="查看头像"
                    onClick={openProfileAvatar}
                  >
                    <Avatar avatar={profile.avatar} size="large" />
                    <span className="profile-avatar-open" aria-hidden="true"><Maximize2 size={14} /></span>
                  </button>
                ) : <span className="profile-avatar-static"><Avatar avatar={profile.avatar} size="large" /></span>}
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
                {canManageChat && profile.chatId && (profile.kind === "group" || profile.kind === "channel") && (
                  <button type="button" onClick={() => onManageChat(profile.chatId!)}>
                    <Shield size={18} /><span>管理</span>
                  </button>
                )}
                {profile.userId && profile.kind === "user" && (
                  <button type="button" onClick={() => void onToggleBlock(profile.userId!, "user", !isBlocked)}>
                    <Ban size={18} /><span>{isBlocked ? "解除屏蔽" : "屏蔽"}</span>
                  </button>
                )}
                {profile.chatId && profile.kind === "channel" && (
                  <button type="button" onClick={() => void onToggleBlock(profile.chatId!, "chat", !isBlocked)}>
                    <Ban size={18} /><span>{isBlocked ? "解除屏蔽" : "屏蔽频道"}</span>
                  </button>
                )}
                {(profile.chatId || reportChatId) && (profile.kind === "user" || profile.kind === "group" || profile.kind === "channel") && (
                  <button type="button" onClick={() => setReportOpen(true)}>
                    <Flag size={18} /><span>举报</span>
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
                <section className="profile-info-section" aria-labelledby="common-groups-heading">
                  <div className="profile-section-heading">
                    <h4 id="common-groups-heading">共同群组</h4>
                    <span>{profile.groupInCommonCount}</span>
                  </div>
                  {(profile.groupsInCommon?.length ?? 0) > 0 ? (
                    <div className="profile-common-group-list">
                      {profile.groupsInCommon?.map((group) => (
                        <button key={group.id} type="button" data-chat-id={group.id} onClick={openCommonGroup}>
                          <Avatar avatar={group.avatar} size="small" />
                          <span>
                            <strong>{group.title}</strong>
                            <small>{group.memberCount
                              ? `${group.memberCount.toLocaleString("zh-CN")} 位成员`
                              : "共同群组"}</small>
                          </span>
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  ) : <p>{profile.groupInCommonCount > 0 ? "暂时无法读取群组列表" : "没有共同群组"}</p>}
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
                    onLoadMessageProperties={onLoadMessageProperties}
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
                    <>
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
                    {profile.memberHasMore && profile.chatId && (
                      <button
                        className="dialog-secondary profile-member-more"
                        type="button"
                        disabled={state.membersLoading}
                        onClick={() => void onLoadMoreMembers(profile.chatId!)}
                      >
                        {showMembersLoading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                        <span>{state.membersLoading ? "正在加载成员" : "加载更多成员"}</span>
                      </button>
                    )}
                    {state.membersError && <p className="profile-state is-error" role="alert">{state.membersError}</p>}
                    </>
                  ) : (
                    <p>此频道不公开成员列表</p>
                  )}
                </section>
              )}
            </>
          ) : null}
        </div>
      </section>
      <MotionPresence present={Boolean(reportOpen && (profile?.chatId || reportChatId))}>
        {reportOpen && (profile?.chatId || reportChatId) ? <ReportDialog chatId={profile?.chatId ?? reportChatId!} messageIds={[]} title={profile?.title ?? "聊天"} onGetOptions={onGetReportOptions} onSubmit={onReportChat} onDeleteChat={onDeleteChat} onClose={() => setReportOpen(false)} /> : null}
      </MotionPresence>
    </div>
  );
}
