import { currentLanguage, translate } from "../i18n";
import {
  ArrowLeft,
  AtSign,
  Ban,
  ChevronRight,
  Eye,
  EyeOff,
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
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import { useStableVisibility } from "../hooks/useStableVisibility";
import { openMediaViewerWindow, syncMediaViewerWindow } from "../media/mediaViewerWindowBridge";
import type { ProfileState } from "../store/profileState";
import { usePreferencesStore } from "../store/preferencesStore";
import { useLocalUserBlocks } from "../store/localUserBlocks";
import { useTelegramStore } from "../store/telegramStore";
import type { Chat, ForwardMessagesResult, SharedMediaPage, SharedMediaSearchInput } from "../telegram/types";
import type { ChatReportResult, ReportChatInput } from "../telegram/types";
import { colorThemeForThemeId } from "../theme/theme";
import { type PhotoMessage } from "../utils/mediaViewerModel";
import { Avatar } from "./Avatar";
import { MessageRichText } from "./MessageRichText";
import { MotionPresence } from "./MotionPresence";
import { ProfilePlaylist } from "./ProfilePlaylist";
import { ReportDialog } from "./ReportDialog";
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
  isAdministrator?: boolean;
  isBlocked?: boolean;
  onToggleBlock: (senderId: string, kind: "user" | "chat", blocked: boolean) => Promise<boolean>;
  onGetReportOptions: (chatId: string, messageIds: string[]) => Promise<ChatReportResult>;
  onReportChat: (input: ReportChatInput) => Promise<ChatReportResult>;
  reportChatId?: string;
  onLeaveChat?: () => Promise<boolean>;
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
  role === "owner" ? translate("群主") : role === "administrator" ? translate("管理员") : translate("成员");

const pageTitle = (page: ProfilePage) => {
  switch (page) {
    case "commonGroups": return translate("共同群组");
    case "members": return translate("成员");
    case "sharedMedia": return translate("共享媒体");
    case "playlist": return translate("音乐");
    default: return translate("资料");
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
  isAdministrator = false,
  isBlocked,
  onToggleBlock,
  onGetReportOptions,
  onReportChat,
  reportChatId,
  onLeaveChat,
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
  const [reportOpen, setReportOpen] = useState(false);
  const dialogRef = useModalFocus<HTMLElement>(onClose, false, closeRef, reportOpen);
  const [page, setPage] = useState<ProfilePage>("main");
  const cacheFile = useTelegramStore((store) => store.cacheFile);
  const activeAccountId = useTelegramStore((store) => store.activeAccountId);
  const localBlockedUsers = useLocalUserBlocks((store) => store.users);
  const blockLocalUser = useLocalUserBlocks((store) => store.blockUser);
  const unblockLocalUser = useLocalUserBlocks((store) => store.unblockUser);
  const markLocalBlockedUserReactionsRead = useTelegramStore((store) => store.markLocalBlockedUserReactionsRead);
  const colorTheme = usePreferencesStore((store) => colorThemeForThemeId(store.themeId));
  const profile = state.value;
  const users = useTelegramStore((store) => store.users);
  const profileIsBot = profile?.isBot === true || Boolean(
    profile?.userId && users.get(profile.userId)?.isBot,
  );
  const localBlockedUser = profile?.userId
    ? localBlockedUsers.find((user) =>
        user.accountId === activeAccountId && user.userId === profile.userId
      )
    : undefined;
  const waitingForProfile = state.loading && !profile;
  const showProfileLoading = useStableVisibility(waitingForProfile);
  const showProfileSkeleton = waitingForProfile || showProfileLoading;
  const showMembersLoading = useStableVisibility(Boolean(state.membersLoading), { minimumVisible: 220 });
  const statusKind = !showProfileSkeleton && state.error && !profile
    ? "error"
    : !showProfileSkeleton && !profile ? "empty" : undefined;
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
  const cacheProfilePhoto = useCallback(async (fileId: number, _fileName: string) => {
    await cacheFile(fileId, 24);
    onRetry();
  }, [cacheFile, onRetry]);
  const openProfileAvatar = useCallback(() => {
    const active = profilePhotoMessages[0];
    if (!active) return;
    void openMediaViewerWindow({
      messages: profilePhotoMessages,
      activeMessageId: active.id,
      colorTheme,
      allowSave: false,
    }, cacheProfilePhoto, async () => undefined, undefined, async (fileId, priority) => {
      await cacheFile(fileId, priority);
      onRetry();
    });
  }, [cacheFile, cacheProfilePhoto, colorTheme, onRetry, profilePhotoMessages]);
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
          <button className="icon-button" type="button" aria-label={translate("返回资料")} title={translate("返回")} onClick={() => setPage("main")}>
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
                        ? translate("{{value0}} 位成员", { value0: group.memberCount.toLocaleString(currentLanguage()) })
                        : translate("共同群组")}</small>
                    </span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                ))}
              </div>
            ) : <div className="profile-detail-empty" role="status">{(profile.groupInCommonCount ?? 0) > 0 ? translate("暂时无法读取群组列表") : translate("没有共同群组")}</div>
          ) : null}
          {page === "members" ? (
            profile.canViewMembers ? (
              <>
                <div className="profile-member-list">
                  {profile.members.map((member) => (
                    <div className="profile-member-row" key={member.user.id}>
                      <button className="profile-member-identity" type="button" onClick={() => onOpenUserProfile(member.user.id)}>
                        <Avatar avatar={member.user.avatar} size="small" />
                        <span>
                          <strong className={member.role === "owner" || member.role === "administrator" ? "is-administrator" : undefined}>
                            {member.user.displayName}
                          </strong>
                          <small className={member.role === "owner" || member.role === "administrator" ? "is-administrator" : undefined}>
                            {roleLabel(member.role)}
                          </small>
                        </span>
                      </button>
                      {member.user.id !== currentUserId ? (
                        <button
                          type="button"
                          aria-label={translate("向 {{value0}} 发消息", { value0: member.user.displayName })}
                          title={translate("发消息")}
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
                    <span>{state.membersLoading ? translate("正在加载成员") : translate("加载更多成员")}</span>
                  </button>
                ) : null}
                {state.membersError ? <p className="profile-state is-error" role="alert">{state.membersError}</p> : null}
              </>
            ) : <div className="profile-detail-empty" role="status">{translate("此频道不公开成员列表")}</div>
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
        aria-busy={showProfileSkeleton}
        aria-labelledby="profile-drawer-title"
        tabIndex={-1}
      >
        <h2 id="profile-drawer-title" className="sr-only">{translate("资料")}</h2>
        <button ref={closeRef} className="profile-close icon-button" type="button" aria-label={translate("关闭资料")} title={translate("关闭")} onClick={onClose}>
          <X size={19} />
        </button>
        {page !== "main" ? renderDetailPage() : (
          <div className={`profile-drawer-scroll ${showProfileSkeleton ? "is-loading" : ""}`.trim()}>
            {showProfileSkeleton ? (
              <section className={`profile-loading-shell ${showProfileLoading ? "is-active" : ""}`.trim()} role="status">
                <span className="sr-only">{translate("正在加载资料")}</span>
                <div className="profile-loading-hero" aria-hidden="true">
                  <span className="profile-loading-placeholder is-avatar" />
                  <span className="profile-loading-placeholder is-title" />
                  <span className="profile-loading-placeholder is-status" />
                </div>
              </section>
            ) : null}
            <MotionPresence present={Boolean(statusKind)} variant="status">
              {statusKind ? (
                <div key={statusKind} className={`profile-state ${statusKind === "error" ? "is-error" : ""}`.trim()} role={statusKind === "error" ? "alert" : "status"}>
                  {statusKind === "error" ? (
                    <><span>{state.error}</span><button className="dialog-secondary" type="button" onClick={onRetry}><RefreshCw size={15} /><span>{translate("重试")}</span></button></>
                  ) : <span>{translate("没有可显示的资料")}</span>}
                </div>
              ) : null}
            </MotionPresence>
            {!showProfileSkeleton && !statusKind && profile ? (
              <>
                <section className="profile-hero" aria-labelledby="profile-name">
                  {profilePhotoMessages.length > 0 ? (
                    <button
                      className="profile-avatar-button"
                      type="button"
                      aria-label={translate("查看 {{value0}} 的头像和历史头像", { value0: profile.title })}
                      title={translate("查看头像")}
                      onClick={openProfileAvatar}
                    >
                      <Avatar avatar={profile.avatar} size="large" />
                    </button>
                  ) : <span className="profile-avatar-static"><Avatar avatar={profile.avatar} size="large" /></span>}
                  <h3 id="profile-name" className={isAdministrator ? "is-administrator" : undefined}>{profile.title}</h3>
                  <span className={`profile-status ${profileIsBot ? "is-bot" : ""}`.trim()}>
                    {profileIsBot && isAdministrator
                      ? translate("机器人 · 管理员")
                      : profileIsBot ? translate("机器人") : isAdministrator ? translate("管理员") : profile.statusLabel}
                  </span>
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
                <div className="profile-secondary-content">
                  <div className="profile-actions">
                    {profile.kind === "user" && profile.userId && profile.userId !== currentUserId ? (
                      <button type="button" onClick={() => void onStartPrivateChat(profile.userId!)}>
                        <MessageCircle size={18} /><span>{translate("发消息")}</span>
                      </button>
                    ) : null}
                    {canManageChat && profile.chatId && (profile.kind === "group" || profile.kind === "channel") ? (
                      <button type="button" onClick={() => onManageChat(profile.chatId!)}>
                        <Shield size={18} /><span>{translate("管理")}</span>
                      </button>
                    ) : null}
                    {profile.userId && profile.kind === "user" ? (
                      <button
                        className={localBlockedUser ? "is-active" : undefined}
                        type="button"
                        aria-label={localBlockedUser ? translate("解除屏蔽") : translate("屏蔽")}
                        aria-pressed={Boolean(localBlockedUser)}
                        title={localBlockedUser ? translate("解除屏蔽") : translate("屏蔽")}
                        onClick={() => {
                          if (localBlockedUser) {
                            unblockLocalUser(activeAccountId, profile.userId!);
                          } else {
                            blockLocalUser(activeAccountId, {
                              id: profile.userId!,
                              displayName: profile.title,
                              avatar: profile.avatar,
                            });
                            void markLocalBlockedUserReactionsRead(profile.userId!);
                          }
                        }}
                      >
                        {localBlockedUser ? <Eye size={18} /> : <EyeOff size={18} />}
                        <span>{translate("屏蔽")}</span>
                      </button>
                    ) : null}
                    {profile.userId && profile.kind === "user" ? (
                      <button
                        className={isBlocked ? "is-active" : undefined}
                        type="button"
                        aria-label={isBlocked ? translate("移出黑名单") : translate("黑名单")}
                        aria-pressed={isBlocked}
                        title={isBlocked ? translate("移出黑名单") : translate("黑名单")}
                        onClick={() => void onToggleBlock(profile.userId!, "user", !isBlocked)}
                      >
                        {isBlocked ? <ShieldCheck size={18} /> : <Ban size={18} />}<span>{translate("黑名单")}</span>
                      </button>
                    ) : null}
                    {profile.chatId && profile.kind === "channel" ? (
                      <button type="button" onClick={() => void onToggleBlock(profile.chatId!, "chat", !isBlocked)}>
                        <Ban size={18} /><span>{isBlocked ? translate("解除屏蔽") : translate("屏蔽频道")}</span>
                      </button>
                    ) : null}
                    {(profile.chatId || reportChatId) && (profile.kind === "user" || profile.kind === "group" || profile.kind === "channel") ? (
                      <button type="button" onClick={() => setReportOpen(true)}>
                        <Flag size={18} /><span>{translate("举报")}</span>
                      </button>
                    ) : null}
                  </div>
                  {(profile.kind === "user" || profile.kind === "self") ? (
                    <section className="profile-identity-card" aria-label={translate("用户账户信息")}>
                      {profile.username ? (
                        <div><AtSign size={18} /><span><strong>@{profile.username}</strong><small>{translate("用户名")}</small></span></div>
                      ) : null}
                      {profile.phoneNumber && profile.kind === "self" ? (
                        <div><Phone size={18} /><span><strong>{profile.phoneNumber}</strong><small>{translate("手机号")}</small></span></div>
                      ) : null}
                      <div><Fingerprint size={18} /><span><strong>{profile.userId}</strong><small>{translate("用户 ID")}</small></span></div>
                      <div><Network size={18} /><span><strong>{profile.dataCenterId ? `DC${profile.dataCenterId}, ${profile.dataCenterLocation}` : profile.dataCenterLocation}</strong><small>{translate("数据中心")}</small></span></div>
                    </section>
                  ) : null}
                  <nav className="profile-navigation" aria-label={translate("资料详情")}>
                    {profile.groupInCommonCount !== undefined && profile.kind === "user" ? (
                      <button type="button" onClick={() => setPage("commonGroups")}>
                        <span className="profile-navigation-icon"><Users size={18} /></span>
                        <span><strong>{translate("共同群组")}</strong><small>{translate("查看你们都加入的群组")}</small></span>
                        <span className="profile-navigation-value">{profile.groupInCommonCount}</span>
                        <ChevronRight size={17} aria-hidden="true" />
                      </button>
                    ) : null}
                    {(profile.kind === "user" || profile.kind === "self") ? (
                      <button type="button" onClick={() => setPage("playlist")}>
                        <span className="profile-navigation-icon"><Headphones size={18} /></span>
                        <span><strong>{translate("音乐")}</strong><small>{translate("资料歌单")}</small></span>
                        <span className="profile-navigation-value">{profile.profileAudioCount ?? 0}</span>
                        <ChevronRight size={17} aria-hidden="true" />
                      </button>
                    ) : null}
                    {profile.chatId ? (
                      <button type="button" onClick={() => setPage("sharedMedia")}>
                        <span className="profile-navigation-icon"><Image size={18} /></span>
                        <span><strong>{translate("共享媒体")}</strong><small>{translate("图片、文件、链接与音频")}</small></span>
                        <ChevronRight size={17} aria-hidden="true" />
                      </button>
                    ) : null}
                    {(profile.kind === "group" || profile.kind === "channel") ? (
                      <button type="button" onClick={() => setPage("members")}>
                        <span className="profile-navigation-icon"><Users size={18} /></span>
                        <span><strong>{translate("成员")}</strong><small>{profile.canViewMembers ? translate("查看群组成员") : translate("成员列表未公开")}</small></span>
                        {profile.memberCount !== undefined ? <span className="profile-navigation-value">{profile.memberCount.toLocaleString(currentLanguage())}</span> : null}
                        <ChevronRight size={17} aria-hidden="true" />
                      </button>
                    ) : null}
                  </nav>
                </div>
              </>
            ) : null}
          </div>
        )}
      </section>
      <MotionPresence present={Boolean(reportOpen && (profile?.chatId || reportChatId))}>
        {reportOpen && (profile?.chatId || reportChatId) ? <ReportDialog chatId={profile?.chatId ?? reportChatId!} messageIds={[]} title={profile?.title ?? translate("聊天")} onGetOptions={onGetReportOptions} onSubmit={onReportChat} onLeaveChat={onLeaveChat} onClose={() => setReportOpen(false)} /> : null}
      </MotionPresence>
    </div>
  );
}
