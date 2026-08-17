import {
  ArrowLeft,
  AtSign,
  Ban,
  ChevronRight,
  Fingerprint,
  Flag,
  Headphones,
  Image,
  LoaderCircle,
  MessageCircle,
  Network,
  Phone,
  RefreshCw,
  Shield,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import { useStableVisibility } from "../hooks/useStableVisibility";
import { openMediaViewerWindow, syncMediaViewerWindow } from "../media/mediaViewerWindowBridge";
import type { ProfileState } from "../store/profileState";
import { usePreferencesStore } from "../store/preferencesStore";
import { useTelegramStore } from "../store/telegramStore";
import type { Chat, ForwardMessagesResult, SharedMediaPage, SharedMediaSearchInput } from "../telegram/types";
import type { ChatReportOptions, ReportChatInput } from "../telegram/types";
import { colorThemeForThemeId } from "../theme/theme";
import type { PhotoMessage } from "../utils/mediaViewerModel";
import { Avatar } from "./Avatar";
import { MessageRichText } from "./MessageRichText";
import { MotionPresence } from "./MotionPresence";
import { ProfilePlaylist } from "./ProfilePlaylist";
import { ReportDialog } from "./SafetySettings";
import { SharedMediaBrowser } from "./SharedMediaBrowser";

type ProfilePage = "main" | "commonGroups" | "members" | "sharedMedia" | "playlist";

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
  onOpenMention: (username?: string, userId?: string) => void;
  onSearchHashtag: (hashtag: string) => void;
  onOpenChat: (chatId: string) => void;
  onLoadMoreMembers: (chatId: string) => Promise<boolean>;
  onLoadSharedMedia: (input: SharedMediaSearchInput, force?: boolean) => Promise<SharedMediaPage | undefined>;
  onDownloadFile: (fileId: number, fileName: string) => Promise<void>;
  onCancelFileDownload: (fileId: number) => Promise<void>;
  onRecoverFile: (fileId: number, priority?: number) => Promise<boolean>;
  onStreamFile: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onSuspendFileStream: (fileId: number) => Promise<void>;
  onLoadMessageProperties: (chatId: string, messageId: string) => Promise<import("../telegram/types").MessagePermissions | undefined>;
  onDeleteMessages: (chatId: string, messageIds: string[], revoke: boolean) => Promise<boolean>;
  onForwardMessages: (fromChatId: string, messageIds: string[], toChatId: string) => Promise<ForwardMessagesResult | undefined>;
}

const roleLabel = (role: "owner" | "administrator" | "member") =>
  role === "owner" ? "群主" : role === "administrator" ? "管理员" : "成员";

const pageTitle = (page: ProfilePage) => {
  switch (page) {
    case "commonGroups": return "共同群组";
    case "members": return "成员";
    case "sharedMedia": return "共享媒体";
    case "playlist": return "音乐";
    default: return "资料";
  }
};

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
  onOpenMention,
  onSearchHashtag,
  onOpenChat,
  onLoadMoreMembers,
  onLoadSharedMedia,
  onDownloadFile,
  onCancelFileDownload,
  onRecoverFile,
  onStreamFile,
  onSuspendFileStream,
  onLoadMessageProperties,
  onDeleteMessages,
  onForwardMessages,
}: ProfileDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalFocus<HTMLElement>(onClose, false, closeRef);
  const [page, setPage] = useState<ProfilePage>("main");
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

  useEffect(() => {
    setPage("main");
  }, [profile?.id]);

  const renderDetailPage = () => {
    if (!profile || page === "main") return null;
    return (
      <div className="profile-detail-page">
        <header className="profile-detail-header">
          <button className="icon-button" type="button" aria-label="返回资料" title="返回" onClick={() => setPage("main")}>
            <ArrowLeft size={19} />
          </button>
          <div>
            <h3>{pageTitle(page)}</h3>
            <small>{profile.title}</small>
          </div>
        </header>
        <div className="profile-detail-body">
          {page === "commonGroups" ? (
            (profile.groupsInCommon?.length ?? 0) > 0 ? (
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
            ) : <div className="profile-detail-empty" role="status">{(profile.groupInCommonCount ?? 0) > 0 ? "暂时无法读取群组列表" : "没有共同群组"}</div>
          ) : null}
          {page === "members" ? (
            profile.canViewMembers ? (
              <>
                <div className="profile-member-list">
                  {profile.members.map((member) => (
                    <div className="profile-member-row" key={member.user.id}>
                      <button className="profile-member-identity" type="button" onClick={() => onOpenUserProfile(member.user.id)}>
                        <Avatar avatar={member.user.avatar} size="small" />
                        <span><strong>{member.user.displayName}</strong><small>{roleLabel(member.role)}</small></span>
                      </button>
                      {member.user.id !== currentUserId ? (
                        <button
                          type="button"
                          aria-label={`向 ${member.user.displayName} 发消息`}
                          title="发消息"
                          onClick={() => void onStartPrivateChat(member.user.id)}
                        >
                          <MessageCircle size={16} />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
                {profile.memberHasMore && profile.chatId ? (
                  <button
                    className="dialog-secondary profile-member-more"
                    type="button"
                    disabled={state.membersLoading}
                    onClick={() => void onLoadMoreMembers(profile.chatId!)}
                  >
                    {showMembersLoading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                    <span>{state.membersLoading ? "正在加载成员" : "加载更多成员"}</span>
                  </button>
                ) : null}
                {state.membersError ? <p className="profile-state is-error" role="alert">{state.membersError}</p> : null}
              </>
            ) : <div className="profile-detail-empty" role="status">此频道不公开成员列表</div>
          ) : null}
          {page === "sharedMedia" && profile.chatId ? (
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
          ) : null}
          {page === "playlist" ? (
            <ProfilePlaylist
              profileId={profile.id}
              title={profile.title}
              audios={profile.profileAudios ?? []}
              totalCount={profile.profileAudioCount ?? profile.profileAudios?.length ?? 0}
              loading={state.loading}
              onDownload={onDownloadFile}
              onCancelDownload={onCancelFileDownload}
              onRecoverFile={onRecoverFile}
              onRequestStream={onStreamFile}
              onSuspendStream={onSuspendFileStream}
            />
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="profile-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        ref={dialogRef}
        className={`profile-drawer ${page === "main" ? "is-main" : "is-detail"}`}
        role="dialog"
        aria-modal="true"
        aria-busy={waitingForProfile}
        aria-labelledby="profile-drawer-title"
        tabIndex={-1}
      >
        <h2 id="profile-drawer-title" className="sr-only">资料</h2>
        <button ref={closeRef} className="profile-close icon-button" type="button" aria-label="关闭资料" title="关闭" onClick={onClose}>
          <X size={19} />
        </button>
        {page !== "main" ? renderDetailPage() : (
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
                    </button>
                  ) : <span className="profile-avatar-static"><Avatar avatar={profile.avatar} size="large" /></span>}
                  <h3 id="profile-name">{profile.title}</h3>
                  <span className="profile-status">{profile.statusLabel}</span>
                  {profile.bio ? (
                    <MessageRichText
                      className="profile-bio"
                      text={profile.bio}
                      entities={profile.bioEntities}
                      onOpenMention={onOpenMention}
                      onSearchHashtag={onSearchHashtag}
                    />
                  ) : null}
                </section>
                <div className="profile-actions">
                  {profile.kind === "user" && profile.userId && profile.userId !== currentUserId ? (
                    <button type="button" onClick={() => void onStartPrivateChat(profile.userId!)}>
                      <MessageCircle size={18} /><span>发消息</span>
                    </button>
                  ) : null}
                  {canManageChat && profile.chatId && (profile.kind === "group" || profile.kind === "channel") ? (
                    <button type="button" onClick={() => onManageChat(profile.chatId!)}>
                      <Shield size={18} /><span>管理</span>
                    </button>
                  ) : null}
                  {profile.userId && profile.kind === "user" ? (
                    <button type="button" onClick={() => void onToggleBlock(profile.userId!, "user", !isBlocked)}>
                      <Ban size={18} /><span>{isBlocked ? "解除屏蔽" : "屏蔽"}</span>
                    </button>
                  ) : null}
                  {profile.chatId && profile.kind === "channel" ? (
                    <button type="button" onClick={() => void onToggleBlock(profile.chatId!, "chat", !isBlocked)}>
                      <Ban size={18} /><span>{isBlocked ? "解除屏蔽" : "屏蔽频道"}</span>
                    </button>
                  ) : null}
                  {(profile.chatId || reportChatId) && (profile.kind === "user" || profile.kind === "group" || profile.kind === "channel") ? (
                    <button type="button" onClick={() => setReportOpen(true)}>
                      <Flag size={18} /><span>举报</span>
                    </button>
                  ) : null}
                </div>
                {(profile.kind === "user" || profile.kind === "self") ? (
                  <section className="profile-identity-card" aria-label="用户账户信息">
                    {profile.username ? (
                      <div><AtSign size={18} /><span><strong>@{profile.username}</strong><small>用户名</small></span></div>
                    ) : null}
                    {profile.phoneNumber && profile.kind === "self" ? (
                      <div><Phone size={18} /><span><strong>{profile.phoneNumber}</strong><small>手机号</small></span></div>
                    ) : null}
                    <div><Fingerprint size={18} /><span><strong>{profile.userId}</strong><small>用户 ID</small></span></div>
                    <div><Network size={18} /><span><strong>{profile.dataCenterId ? `DC${profile.dataCenterId}, ${profile.dataCenterLocation}` : profile.dataCenterLocation}</strong><small>数据中心</small></span></div>
                  </section>
                ) : null}
                <nav className="profile-navigation" aria-label="资料详情">
                  {profile.groupInCommonCount !== undefined && profile.kind === "user" ? (
                    <button type="button" onClick={() => setPage("commonGroups")}>
                      <span className="profile-navigation-icon"><Users size={18} /></span>
                      <span><strong>共同群组</strong><small>查看你们都加入的群组</small></span>
                      <span className="profile-navigation-value">{profile.groupInCommonCount}</span>
                      <ChevronRight size={17} aria-hidden="true" />
                    </button>
                  ) : null}
                  {(profile.kind === "user" || profile.kind === "self") ? (
                    <button type="button" onClick={() => setPage("playlist")}>
                      <span className="profile-navigation-icon"><Headphones size={18} /></span>
                      <span><strong>音乐</strong><small>资料歌单</small></span>
                      <span className="profile-navigation-value">{profile.profileAudioCount ?? 0}</span>
                      <ChevronRight size={17} aria-hidden="true" />
                    </button>
                  ) : null}
                  {profile.chatId ? (
                    <button type="button" onClick={() => setPage("sharedMedia")}>
                      <span className="profile-navigation-icon"><Image size={18} /></span>
                      <span><strong>共享媒体</strong><small>图片、文件、链接与音频</small></span>
                      <ChevronRight size={17} aria-hidden="true" />
                    </button>
                  ) : null}
                  {(profile.kind === "group" || profile.kind === "channel") ? (
                    <button type="button" onClick={() => setPage("members")}>
                      <span className="profile-navigation-icon"><Users size={18} /></span>
                      <span><strong>成员</strong><small>{profile.canViewMembers ? "查看群组成员" : "成员列表未公开"}</small></span>
                      {profile.memberCount !== undefined ? <span className="profile-navigation-value">{profile.memberCount.toLocaleString("zh-CN")}</span> : null}
                      <ChevronRight size={17} aria-hidden="true" />
                    </button>
                  ) : null}
                </nav>
              </>
            ) : null}
          </div>
        )}
      </section>
      <MotionPresence present={Boolean(reportOpen && (profile?.chatId || reportChatId))}>
        {reportOpen && (profile?.chatId || reportChatId) ? <ReportDialog chatId={profile?.chatId ?? reportChatId!} messageIds={[]} title={profile?.title ?? "聊天"} onGetOptions={onGetReportOptions} onSubmit={onReportChat} onDeleteChat={onDeleteChat} onClose={() => setReportOpen(false)} /> : null}
      </MotionPresence>
    </div>
  );
}
