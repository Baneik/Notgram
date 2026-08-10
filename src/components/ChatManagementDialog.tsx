import {
  Check,
  ClipboardList,
  Copy,
  Link,
  LoaderCircle,
  Search,
  Shield,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Chat,
  ChatAdminRightKey,
  ChatAdminRights,
  ChatEvent,
  ChatInviteLink,
  ChatInviteLinkPage,
  ChatJoinRequest,
  ChatJoinRequestPage,
  ChatManagement,
  ChatManagementCapabilities,
  ChatMemberStatusInput,
  ChatPermissions,
  CreateChatInviteLinkInput,
  ManagedChatMember,
  User,
} from "../telegram/types";
import {
  CHAT_ADMIN_RIGHT_LABELS,
  CHAT_PERMISSION_LABELS,
  DEFAULT_CHAT_ADMIN_RIGHTS,
  DEFAULT_CHAT_PERMISSIONS,
} from "../telegram/chatManagement";
import { useModalFocus } from "../hooks/useModalFocus";
import { Avatar } from "./Avatar";

interface ChatManagementDialogProps {
  chat: Chat;
  currentUserId?: string;
  contacts: User[];
  management?: ChatManagement;
  loading: boolean;
  error?: string;
  onLoad: (offset?: number) => Promise<ChatManagement | undefined>;
  onClose: () => void;
  onAddMembers: (userIds: string[]) => Promise<boolean>;
  onSetMemberStatus: (userId: string, status: ChatMemberStatusInput) => Promise<boolean>;
  onSetPermissions: (permissions: ChatPermissions) => Promise<boolean>;
  onSetSlowMode: (seconds: number) => Promise<boolean>;
  onTransferOwnership: (userId: string, password: string) => Promise<boolean>;
  onLoadEvents: (fromEventId?: string) => Promise<{ events: ChatEvent[]; nextEventId?: string; hasMore: boolean } | undefined>;
  onGetInviteLinks: (offsetDate?: number, offsetLink?: string) => Promise<ChatInviteLinkPage | undefined>;
  onSaveInviteLink: (input: Omit<CreateChatInviteLinkInput, "chatId">, inviteLink?: string) => Promise<ChatInviteLink | undefined>;
  onRevokeInviteLink: (inviteLink: string) => Promise<boolean>;
  onGetJoinRequests: (inviteLink?: string, offsetUserId?: string, offsetDate?: number) => Promise<ChatJoinRequestPage | undefined>;
  onProcessJoinRequest: (userId: string, approve: boolean) => Promise<boolean>;
  onProcessJoinRequests: (inviteLink: string | undefined, approve: boolean) => Promise<boolean>;
}

type Tab = "members" | "permissions" | "invites" | "audit";

interface JoinRequestBucket extends ChatJoinRequestPage {
  inviteLink?: string;
}

const roleLabel = (member: ManagedChatMember) => {
  if (member.status === "owner") return "所有者";
  if (member.status === "administrator") return member.customTitle || "管理员";
  if (member.status === "restricted") return "受限成员";
  if (member.status === "banned") return "已封禁";
  if (member.status === "left") return "已离开";
  return "成员";
};

const formatSlowMode = (seconds: number) => seconds === 0
  ? "关闭"
  : seconds >= 60 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`;

const ownershipTransferMessage = (management?: ChatManagement) => {
  const transfer = management?.ownershipTransfer;
  if (!transfer || transfer.available) return undefined;
  const wait = transfer.retryAfter ? `，约 ${Math.ceil(transfer.retryAfter / 3600)} 小时后重试` : "";
  if (transfer.reason === "passwordNeeded") return "需要先为 Telegram 账号启用两步验证";
  if (transfer.reason === "passwordTooFresh") return `两步验证启用时间过短${wait}`;
  if (transfer.reason === "sessionTooFresh") return `当前登录会话时间过短${wait}`;
  return "当前会话暂时不能转移所有权";
};

const visibleAdminRights = (chat: Chat, capabilities: ChatManagementCapabilities) =>
  (Object.keys(CHAT_ADMIN_RIGHT_LABELS) as ChatAdminRightKey[]).filter((key) => {
    if (["canPostMessages", "canEditMessages", "canManageDirectMessages"].includes(key)) {
      return capabilities.chatType === "channel";
    }
    if (key === "canPinMessages" || key === "canManageTags") return capabilities.chatType !== "channel";
    if (key === "canManageTopics") return capabilities.chatType === "supergroup" && chat.isForum === true;
    if (key === "canPromoteMembers") return capabilities.chatType !== "basicGroup";
    if (key === "isAnonymous") return capabilities.chatType === "supergroup";
    if (["canManageChat", "canPostStories", "canEditStories", "canDeleteStories"].includes(key)) {
      return capabilities.chatType !== "basicGroup";
    }
    return true;
  });

const promotionRights = (capabilities: ChatManagementCapabilities): ChatAdminRights => {
  const base = capabilities.status === "administrator" && capabilities.adminRights
    ? capabilities.adminRights
    : DEFAULT_CHAT_ADMIN_RIGHTS;
  return {
    ...base,
    canPromoteMembers: false,
    isAnonymous: false,
  };
};

const deduplicateRequests = (buckets: JoinRequestBucket[]) => [
  ...new Map(buckets.flatMap((bucket) => bucket.requests).map((request) => [request.user.id, request])).values(),
];

export function ChatManagementDialog({
  chat,
  currentUserId,
  contacts,
  management,
  loading,
  error,
  onLoad,
  onClose,
  onAddMembers,
  onSetMemberStatus,
  onSetPermissions,
  onSetSlowMode,
  onTransferOwnership,
  onLoadEvents,
  onGetInviteLinks,
  onSaveInviteLink,
  onRevokeInviteLink,
  onGetJoinRequests,
  onProcessJoinRequest,
  onProcessJoinRequests,
}: ChatManagementDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalFocus<HTMLElement>(onClose, false, closeRef);
  const capabilities = management?.capabilities ?? chat.management;
  const [tab, setTab] = useState<Tab>("members");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [nextEventId, setNextEventId] = useState<string>();
  const [hasMoreEvents, setHasMoreEvents] = useState(false);
  const [transferUserId, setTransferUserId] = useState("");
  const [transferPassword, setTransferPassword] = useState("");
  const [localPermissions, setLocalPermissions] = useState<ChatPermissions>(management?.permissions ?? DEFAULT_CHAT_PERMISSIONS);
  const [inviteLinks, setInviteLinks] = useState<ChatInviteLink[]>([]);
  const [inviteHasMore, setInviteHasMore] = useState(false);
  const [nextInviteDate, setNextInviteDate] = useState<number>();
  const [nextInviteLink, setNextInviteLink] = useState<string>();
  const [joinRequestBuckets, setJoinRequestBuckets] = useState<JoinRequestBucket[]>([]);
  const [inviteName, setInviteName] = useState("");
  const [inviteExpiry, setInviteExpiry] = useState("");
  const [inviteLimit, setInviteLimit] = useState(0);
  const [inviteApproval, setInviteApproval] = useState(false);
  const [subscriptionStars, setSubscriptionStars] = useState(0);
  const [editingInviteLink, setEditingInviteLink] = useState<string>();
  const [adminTitleDrafts, setAdminTitleDrafts] = useState<Record<string, string>>({});

  useEffect(() => { void onLoad(); }, [onLoad]);
  useEffect(() => { if (management) setLocalPermissions(management.permissions); }, [management]);
  useEffect(() => {
    if (!management) return;
    setAdminTitleDrafts(Object.fromEntries(
      management.members
        .filter((member) => member.status === "administrator")
        .map((member) => [member.user.id, member.customTitle ?? ""]),
    ));
  }, [management]);
  useEffect(() => {
    if (!capabilities?.canOpenManagement) onClose();
  }, [capabilities?.canOpenManagement, onClose]);
  useEffect(() => {
    if (tab !== "audit" || !capabilities?.canViewEventLog) return;
    let cancelled = false;
    void onLoadEvents().then((page) => {
      if (!cancelled && page) {
        setEvents(page.events);
        setNextEventId(page.nextEventId);
        setHasMoreEvents(page.hasMore);
      }
    });
    return () => { cancelled = true; };
  }, [capabilities?.canViewEventLog, onLoadEvents, tab]);
  useEffect(() => {
    if (tab !== "invites" || !capabilities?.canManageInvites) return;
    let cancelled = false;
    void onGetInviteLinks().then(async (links) => {
      if (cancelled || !links) return;
      setInviteLinks(links.links);
      setInviteHasMore(links.hasMore);
      setNextInviteDate(links.nextOffsetDate);
      setNextInviteLink(links.nextOffsetLink);
      const requestLinks = capabilities.canManageAllInvites
        ? [undefined]
        : links.links.map((link) => link.inviteLink);
      const pages = await Promise.all(requestLinks.map(async (inviteLink) => {
        const page = await onGetJoinRequests(inviteLink);
        return page ? { ...page, inviteLink } : undefined;
      }));
      if (!cancelled) setJoinRequestBuckets(pages.flatMap((page) => page ? [page] : []));
    });
    return () => { cancelled = true; };
  }, [capabilities?.canManageAllInvites, capabilities?.canManageInvites, onGetInviteLinks, onGetJoinRequests, tab]);

  const members = management?.members ?? [];
  const joinRequests = useMemo(() => deduplicateRequests(joinRequestBuckets), [joinRequestBuckets]);
  const visibleContacts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return contacts
      .filter((user) => !members.some((member) => member.user.id === user.id && member.status !== "left" && member.status !== "banned"))
      .filter((user) => !normalized || `${user.displayName} ${user.username ?? ""}`.toLocaleLowerCase().includes(normalized));
  }, [contacts, members, query]);
  const adminRightKeys = useMemo(
    () => capabilities ? visibleAdminRights(chat, capabilities) : [],
    [capabilities, chat],
  );

  const canChangeMemberTo = (member: ManagedChatMember, action: "administrator" | "restricted" | "banned" | "member") => {
    if (!capabilities || member.status === "owner" || member.user.id === currentUserId) return false;
    if (member.status === "administrator" && member.canBeEdited === false) return false;
    if (action === "administrator") return capabilities.canPromoteMembers;
    if (action === "restricted" || action === "banned") {
      return capabilities.canRestrictMembers && (member.status !== "administrator" || capabilities.canPromoteMembers);
    }
    if (member.status === "administrator") return capabilities.canPromoteMembers;
    if (member.status === "restricted" || member.status === "banned") return capabilities.canRestrictMembers;
    if (member.status === "left") return capabilities.canAddMembers;
    return true;
  };

  const togglePermission = (key: keyof ChatPermissions) => {
    setLocalPermissions((current) => ({ ...current, [key]: !current[key] }));
  };
  const savePermissions = async () => {
    if (!capabilities?.canManagePermissions) return;
    setSaving(true);
    await onSetPermissions(localPermissions);
    setSaving(false);
  };
  const addSelected = async () => {
    if (!capabilities?.canAddMembers || selected.length === 0) return;
    setSaving(true);
    if (await onAddMembers(selected)) {
      setSelected([]);
      setQuery("");
    }
    setSaving(false);
  };
  const setMemberStatus = async (userId: string, status: ChatMemberStatusInput) => {
    setSaving(true);
    const updated = await onSetMemberStatus(userId, status);
    setSaving(false);
    return updated;
  };
  const updateMember = async (member: ManagedChatMember, action: "administrator" | "restricted" | "banned" | "member") => {
    if (!canChangeMemberTo(member, action)) return;
    if (action === "administrator") {
      await setMemberStatus(member.user.id, {
        kind: "administrator",
        rights: member.adminRights ?? promotionRights(capabilities!),
        customTitle: member.customTitle,
      });
    } else if (action === "restricted") {
      await setMemberStatus(member.user.id, {
        kind: "restricted",
        permissions: member.permissions ?? { ...DEFAULT_CHAT_PERMISSIONS, canSendBasicMessages: false },
      });
    } else if (action === "banned") {
      await setMemberStatus(member.user.id, { kind: "banned" });
    } else {
      await setMemberStatus(member.user.id, { kind: "member" });
    }
  };
  const updateAdministrator = async (
    member: ManagedChatMember,
    rights: ChatAdminRights = member.adminRights ?? DEFAULT_CHAT_ADMIN_RIGHTS,
    customTitle: string = adminTitleDrafts[member.user.id] ?? member.customTitle ?? "",
  ) => {
    if (!capabilities?.canPromoteMembers || member.canBeEdited === false) return;
    await setMemberStatus(member.user.id, {
      kind: "administrator",
      rights,
      customTitle: customTitle.trim() || undefined,
    });
  };
  const canEditAdminTags = capabilities?.canManageTags === true && capabilities.chatType !== "channel";
  const transfer = async () => {
    if (!capabilities?.canTransferOwnership || !transferUserId || !transferPassword.trim()) return;
    setSaving(true);
    if (await onTransferOwnership(transferUserId, transferPassword)) {
      setTransferUserId("");
      setTransferPassword("");
    }
    setSaving(false);
  };
  const loadMoreEvents = async () => {
    if (!nextEventId || !capabilities?.canViewEventLog) return;
    const page = await onLoadEvents(nextEventId);
    if (page) {
      setEvents((current) => [...current, ...page.events.filter((event) => !current.some((item) => item.id === event.id))]);
      setNextEventId(page.nextEventId);
      setHasMoreEvents(page.hasMore);
    }
  };
  const loadMoreInvites = async () => {
    if (!inviteHasMore || !nextInviteLink || !capabilities?.canManageInvites) return;
    const page = await onGetInviteLinks(nextInviteDate, nextInviteLink);
    if (!page) return;
    setInviteLinks((current) => [...current, ...page.links.filter((link) => !current.some((item) => item.inviteLink === link.inviteLink))]);
    setInviteHasMore(page.hasMore);
    setNextInviteDate(page.nextOffsetDate);
    setNextInviteLink(page.nextOffsetLink);
    if (!capabilities.canManageAllInvites && page.links.length > 0) {
      const pages = await Promise.all(page.links.map(async (link) => {
        const requests = await onGetJoinRequests(link.inviteLink);
        return requests ? { ...requests, inviteLink: link.inviteLink } : undefined;
      }));
      setJoinRequestBuckets((current) => [
        ...current,
        ...pages.flatMap((requests) => requests && !current.some((bucket) => bucket.inviteLink === requests.inviteLink)
          ? [requests]
          : []),
      ]);
    }
  };
  const loadMoreRequests = async () => {
    const pendingBuckets = joinRequestBuckets.filter((bucket) => bucket.hasMore && bucket.nextOffsetUserId);
    const pages = await Promise.all(pendingBuckets.map(async (bucket) => {
      const page = await onGetJoinRequests(bucket.inviteLink, bucket.nextOffsetUserId, bucket.nextOffsetDate);
      return page ? { ...page, inviteLink: bucket.inviteLink } : undefined;
    }));
    setJoinRequestBuckets((current) => current.map((bucket) => {
      const page = pages.find((item) => item?.inviteLink === bucket.inviteLink);
      if (!page) return bucket;
      return {
        ...page,
        requests: [...bucket.requests, ...page.requests.filter((request) => !bucket.requests.some((item) => item.user.id === request.user.id))],
      };
    }));
  };
  const resetInviteForm = () => {
    setInviteName("");
    setInviteExpiry("");
    setInviteLimit(0);
    setInviteApproval(false);
    setSubscriptionStars(0);
    setEditingInviteLink(undefined);
  };
  const saveInvite = async () => {
    if (!capabilities?.canManageInvites) return;
    setSaving(true);
    const saved = await onSaveInviteLink({
      name: inviteName,
      expirationDate: subscriptionStars > 0 || !inviteExpiry ? undefined : Math.floor(new Date(inviteExpiry).getTime() / 1000),
      memberLimit: subscriptionStars > 0 || inviteApproval ? 0 : inviteLimit,
      createsJoinRequest: subscriptionStars === 0 && inviteApproval,
      subscriptionStars: subscriptionStars || undefined,
    }, editingInviteLink);
    if (saved) {
      const page = await onGetInviteLinks();
      if (page) {
        setInviteLinks(page.links);
        setInviteHasMore(page.hasMore);
        setNextInviteDate(page.nextOffsetDate);
        setNextInviteLink(page.nextOffsetLink);
      }
      resetInviteForm();
    }
    setSaving(false);
  };
  const editInvite = (link: ChatInviteLink) => {
    setEditingInviteLink(link.inviteLink);
    setInviteName(link.name);
    setInviteExpiry(link.expiresAt ? new Date(link.expiresAt).toISOString().slice(0, 16) : "");
    setInviteLimit(link.memberLimit);
    setInviteApproval(link.createsJoinRequest);
    setSubscriptionStars(link.subscriptionStars ?? 0);
  };
  const revokeInvite = async (inviteLink: string) => {
    if (!capabilities?.canManageInvites) return;
    setSaving(true);
    if (await onRevokeInviteLink(inviteLink)) {
      setInviteLinks((current) => current.filter((link) => link.inviteLink !== inviteLink));
    }
    setSaving(false);
  };
  const processRequest = async (userId: string, approve: boolean) => {
    if (!capabilities?.canManageInvites) return;
    setSaving(true);
    if (await onProcessJoinRequest(userId, approve)) {
      setJoinRequestBuckets((current) => current.map((bucket) => ({
        ...bucket,
        requests: bucket.requests.filter((request) => request.user.id !== userId),
        totalCount: Math.max(0, bucket.totalCount - 1),
      })));
    }
    setSaving(false);
  };
  const processRequests = async (approve: boolean) => {
    if (!capabilities?.canManageInvites) return;
    setSaving(true);
    const targets = capabilities.canManageAllInvites
      ? [undefined]
      : [...new Set(joinRequestBuckets.map((bucket) => bucket.inviteLink).filter((value): value is string => Boolean(value)))];
    const results = await Promise.all(targets.map((inviteLink) => onProcessJoinRequests(inviteLink, approve)));
    if (results.every(Boolean)) setJoinRequestBuckets([]);
    setSaving(false);
  };

  const permissionTabVisible = Boolean(capabilities && (
    capabilities.canManagePermissions || capabilities.canManageSlowMode ||
    capabilities.canRestrictMembers || capabilities.canPromoteMembers
  ));
  const transferUnavailable = capabilities?.status === "owner" ? ownershipTransferMessage(management) : undefined;

  return (
    <div className="profile-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="chat-management-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-management-title" tabIndex={-1}>
        <header className="settings-dialog-header">
          <div><h2 id="chat-management-title">管理“{chat.title}”</h2><small>成员、权限和操作记录</small></div>
          <button ref={closeRef} className="icon-button" type="button" aria-label="关闭管理面板" onClick={onClose}><X size={19} /></button>
        </header>
        <nav className="chat-management-tabs" aria-label="管理分类">
          <button type="button" className={tab === "members" ? "is-active" : ""} onClick={() => setTab("members")}><UsersRound size={16} />成员</button>
          {permissionTabVisible && <button type="button" className={tab === "permissions" ? "is-active" : ""} onClick={() => setTab("permissions")}><Shield size={16} />权限</button>}
          {capabilities?.canManageInvites && <button type="button" className={tab === "invites" ? "is-active" : ""} onClick={() => setTab("invites")}><Link size={16} />邀请</button>}
          {capabilities?.canViewEventLog && <button type="button" className={tab === "audit" ? "is-active" : ""} onClick={() => setTab("audit")}><ClipboardList size={16} />审计日志</button>}
        </nav>
        <div className="chat-management-body">
          {loading && !management ? <div className="profile-state"><LoaderCircle className="spin" size={22} /></div> : error && !management ? <div className="profile-state is-error" role="alert">{error}<button className="dialog-secondary" type="button" onClick={() => void onLoad()}><LoaderCircle size={15} />重试</button></div> : (
            <>
              {tab === "members" && (
                <>
                  {capabilities?.canAddMembers && <section className="management-section">
                    <div className="management-section-heading"><h3>添加成员</h3><span>{selected.length ? `已选 ${selected.length}` : "从联系人中选择"}</span></div>
                    <label className="new-chat-search"><Search size={15} /><input aria-label="搜索联系人" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索联系人" /></label>
                    <div className="management-contact-list">
                      {visibleContacts.slice(0, 20).map((user) => <label className="management-contact-row" key={user.id}><input type="checkbox" checked={selected.includes(user.id)} onChange={() => setSelected((current) => current.includes(user.id) ? current.filter((id) => id !== user.id) : [...current, user.id])} /><Avatar avatar={user.avatar} size="small" /><span><strong>{user.displayName}</strong><small>{user.username ? `@${user.username}` : "联系人"}</small></span></label>)}
                      {visibleContacts.length === 0 && <p className="management-empty">没有可添加的联系人</p>}
                    </div>
                    <button className="dialog-primary" type="button" disabled={saving || selected.length === 0} onClick={() => void addSelected()}><UserPlus size={15} />添加成员</button>
                  </section>}
                  <section className="management-section">
                    <div className="management-section-heading"><h3>成员与角色</h3><span>{management?.memberCount ?? members.length} 人</span></div>
                    <div className="management-member-list">
                      {members.map((member) => {
                        const canChangeAny = (["member", "administrator", "restricted", "banned"] as const).some((action) => canChangeMemberTo(member, action));
                        return <div className="management-member-row" key={member.user.id}>
                          <Avatar avatar={member.user.avatar} size="small" />
                          <span className="management-member-identity"><strong>{member.user.displayName}{member.user.id === currentUserId ? "（我）" : ""}</strong><small>{roleLabel(member)}{member.untilDate ? ` · 至 ${new Date(member.untilDate * 1000).toLocaleDateString("zh-CN")}` : ""}</small></span>
                          {canChangeAny && <select aria-label={`设置 ${member.user.displayName} 的角色`} value={member.status === "left" ? "member" : member.status} disabled={saving} onChange={(event) => void updateMember(member, event.target.value as "administrator" | "restricted" | "banned" | "member")}>
                            <option value="member" disabled={!canChangeMemberTo(member, "member")}>成员</option>
                            <option value="administrator" disabled={!canChangeMemberTo(member, "administrator")}>管理员</option>
                            <option value="restricted" disabled={!canChangeMemberTo(member, "restricted")}>受限</option>
                            <option value="banned" disabled={!canChangeMemberTo(member, "banned")}>封禁</option>
                          </select>}
                        </div>;
                      })}
                    </div>
                    {management?.memberHasMore && <button className="dialog-secondary" type="button" disabled={loading} onClick={() => void onLoad((management.memberOffset ?? 0) + members.length)}>加载更多成员</button>}
                  </section>
                  {capabilities?.status === "owner" && <section className="management-section">
                    <div className="management-section-heading"><h3>转移所有者</h3><span>{transferUnavailable ?? "需要两步验证密码"}</span></div>
                    {capabilities.canTransferOwnership ? <>
                      <select aria-label="选择新的所有者" value={transferUserId} onChange={(event) => setTransferUserId(event.target.value)}><option value="">选择成员</option>{members.filter((member) => member.status === "member" || member.status === "administrator").map((member) => <option key={member.user.id} value={member.user.id}>{member.user.displayName}</option>)}</select>
                      <input aria-label="两步验证密码" type="password" value={transferPassword} onChange={(event) => setTransferPassword(event.target.value)} placeholder="两步验证密码" />
                      <button className="dialog-danger" type="button" disabled={saving || !transferUserId || !transferPassword.trim()} onClick={() => void transfer()}>转移所有者</button>
                    </> : <p className="management-empty">{transferUnavailable}</p>}
                  </section>}
                </>
              )}
              {tab === "permissions" && permissionTabVisible && <>
                {capabilities?.canManagePermissions && <section className="management-section"><div className="management-section-heading"><h3>默认发送权限</h3><span>影响所有普通成员</span></div><div className="management-permission-grid">{(Object.keys(CHAT_PERMISSION_LABELS) as (keyof ChatPermissions)[]).map((key) => <label key={key}><input type="checkbox" checked={localPermissions[key]} disabled={saving} onChange={() => togglePermission(key)} /><span>{CHAT_PERMISSION_LABELS[key]}</span></label>)}</div><button className="dialog-primary" type="button" disabled={saving} onClick={() => void savePermissions()}>保存默认权限</button></section>}
                {capabilities?.canManageSlowMode && <section className="management-section"><div className="management-section-heading"><h3>慢速模式</h3><span>{formatSlowMode(management?.slowModeDelay ?? 0)}</span></div><select aria-label="慢速模式间隔" disabled={saving} value={management?.slowModeDelay ?? 0} onChange={async (event) => { setSaving(true); await onSetSlowMode(Number(event.target.value)); setSaving(false); }}><option value={0}>关闭</option><option value={5}>5 秒</option><option value={10}>10 秒</option><option value={30}>30 秒</option><option value={60}>1 分钟</option><option value={300}>5 分钟</option><option value={900}>15 分钟</option><option value={3600}>1 小时</option></select></section>}
                {capabilities?.canRestrictMembers && members.some((member) => member.status === "restricted") && <section className="management-section"><div className="management-section-heading"><h3>成员例外权限</h3><span>每位受限成员独立设置</span></div>{members.filter((member) => member.status === "restricted").map((member) => <div className="management-exception-editor" key={member.user.id}><div className="management-exception-row"><Avatar avatar={member.user.avatar} size="small" /><span>{member.user.displayName}</span><small>{Object.values(member.permissions ?? {}).filter(Boolean).length} 项允许</small></div><div className="management-permission-grid">{(Object.keys(CHAT_PERMISSION_LABELS) as (keyof ChatPermissions)[]).map((key) => <label key={key}><input type="checkbox" checked={(member.permissions ?? DEFAULT_CHAT_PERMISSIONS)[key]} disabled={saving} onChange={() => void setMemberStatus(member.user.id, { kind: "restricted", permissions: { ...(member.permissions ?? DEFAULT_CHAT_PERMISSIONS), [key]: !(member.permissions ?? DEFAULT_CHAT_PERMISSIONS)[key] } })} /><span>{CHAT_PERMISSION_LABELS[key]}</span></label>)}</div></div>)}</section>}
                {capabilities?.canPromoteMembers && members.some((member) => member.status === "administrator" && member.canBeEdited !== false) && <section className="management-section"><div className="management-section-heading"><h3>管理员权限</h3><span>只能授予自身拥有的权限</span></div>{members.filter((member) => member.status === "administrator" && member.canBeEdited !== false && member.user.id !== currentUserId).map((member) => <div className="management-exception-editor" key={member.user.id}><div className="management-exception-row"><Avatar avatar={member.user.avatar} size="small" /><span>{member.user.displayName}</span><small>{member.customTitle || "管理员"}</small></div><div className="management-permission-grid">{adminRightKeys.map((key) => {
                  const actorCanGrant = capabilities.status === "owner" || capabilities.adminRights?.[key] === true;
                  return <label key={key}><input type="checkbox" checked={(member.adminRights ?? DEFAULT_CHAT_ADMIN_RIGHTS)[key]} disabled={saving || !actorCanGrant} onChange={() => void updateAdministrator(member, { ...(member.adminRights ?? DEFAULT_CHAT_ADMIN_RIGHTS), [key]: !(member.adminRights ?? DEFAULT_CHAT_ADMIN_RIGHTS)[key] })} /><span>{CHAT_ADMIN_RIGHT_LABELS[key]}</span></label>;
                })}</div>{canEditAdminTags && <div className="management-admin-title"><label><span>管理员头衔</span><input aria-label={`设置 ${member.user.displayName} 的管理员头衔`} value={adminTitleDrafts[member.user.id] ?? member.customTitle ?? ""} maxLength={16} disabled={saving} onChange={(event) => setAdminTitleDrafts((current) => ({ ...current, [member.user.id]: event.target.value }))} /></label><button className="dialog-secondary" type="button" disabled={saving || (adminTitleDrafts[member.user.id] ?? "") === (member.customTitle ?? "")} onClick={() => void updateAdministrator(member)}>保存头衔</button></div>}</div>)}</section>}
              </>}
              {tab === "invites" && capabilities?.canManageInvites && <>
                <section className="management-section"><div className="management-section-heading"><h3>{editingInviteLink ? "编辑邀请链接" : "新建邀请链接"}</h3><span>可设置有效期、人数或订阅</span></div><div className="invite-form-grid"><label><span>名称</span><input aria-label="邀请链接名称" value={inviteName} onChange={(event) => setInviteName(event.target.value)} maxLength={32} placeholder="例如：发布群" /></label><label><span>有效期</span><input aria-label="邀请链接有效期" type="datetime-local" value={inviteExpiry} onChange={(event) => setInviteExpiry(event.target.value)} disabled={subscriptionStars > 0} /></label><label><span>使用人数</span><input aria-label="邀请链接使用人数" type="number" min={0} max={99999} value={inviteLimit} onChange={(event) => setInviteLimit(Math.max(0, Number(event.target.value)))} disabled={subscriptionStars > 0 || inviteApproval} /></label><label><span>每月 Stars</span><input aria-label="订阅 Stars" type="number" min={0} max={1000000000} value={subscriptionStars} onChange={(event) => { const value = Math.max(0, Number(event.target.value)); setSubscriptionStars(value); if (value > 0) setInviteApproval(false); }} disabled={Boolean(editingInviteLink && !subscriptionStars) || chat.kind !== "channel"} /></label></div><label className="management-check"><input type="checkbox" checked={inviteApproval} disabled={subscriptionStars > 0} onChange={(event) => { setInviteApproval(event.target.checked); if (event.target.checked) setInviteLimit(0); }} /><span>新成员需要管理员批准</span></label><div className="management-inline-actions"><button className="dialog-primary" type="button" disabled={saving} onClick={() => void saveInvite()}>{editingInviteLink ? "保存链接" : "创建链接"}</button>{editingInviteLink && <button className="dialog-secondary" type="button" onClick={resetInviteForm}>取消编辑</button>}</div></section>
                <section className="management-section"><div className="management-section-heading"><h3>有效链接</h3><span>{inviteLinks.length} 条</span></div><div className="invite-link-list">{inviteLinks.map((link) => <div className="invite-link-row" key={link.inviteLink}><div className="invite-link-main"><strong>{link.name || "邀请链接"}{link.isPrimary ? " · 主链接" : ""}</strong><small>{link.subscriptionStars ? `${link.subscriptionStars} Stars/月` : link.createsJoinRequest ? "需要审批" : "直接加入"}{link.expiresAt ? ` · ${new Date(link.expiresAt).toLocaleDateString("zh-CN")} 到期` : ""}</small><code>{link.inviteLink}</code></div><div className="invite-source-stats" aria-label={`${link.name} 成员来源统计`}><span><strong>{link.memberCount}</strong><small>已加入</small></span><span><strong>{link.pendingJoinRequestCount}</strong><small>待审批</small></span><span><strong>{link.expiredMemberCount}</strong><small>已过期</small></span></div><div className="management-inline-actions"><button className="icon-button" type="button" aria-label={`复制 ${link.name}`} title="复制链接" onClick={() => void navigator.clipboard.writeText(link.inviteLink)}><Copy size={15} /></button><button className="dialog-secondary" type="button" disabled={saving} onClick={() => editInvite(link)}>编辑</button><button className="dialog-danger" type="button" disabled={saving} onClick={() => void revokeInvite(link.inviteLink)}>撤销</button></div></div>)}{inviteLinks.length === 0 && <p className="management-empty">暂无有效邀请链接</p>}</div>{inviteHasMore && <button className="dialog-secondary" type="button" disabled={saving} onClick={() => void loadMoreInvites()}>加载更多链接</button>}</section>
                <section className="management-section"><div className="management-section-heading"><h3>入群申请</h3><span>{joinRequests.length} 个待处理</span></div>{joinRequests.length > 0 && <div className="management-inline-actions"><button className="dialog-primary" type="button" disabled={saving} onClick={() => void processRequests(true)}><Check size={14} />全部批准</button><button className="dialog-danger" type="button" disabled={saving} onClick={() => void processRequests(false)}>全部拒绝</button></div>}<div className="join-request-list">{joinRequests.map((request) => <div className="join-request-row" key={request.user.id}><Avatar avatar={request.user.avatar} size="small" /><span><strong>{request.user.displayName}</strong><small>{request.bio || new Date(request.date).toLocaleString("zh-CN")}</small></span><div className="management-inline-actions"><button className="dialog-primary" type="button" aria-label={`批准 ${request.user.displayName}`} disabled={saving} onClick={() => void processRequest(request.user.id, true)}>批准</button><button className="dialog-secondary" type="button" aria-label={`拒绝 ${request.user.displayName}`} disabled={saving} onClick={() => void processRequest(request.user.id, false)}>拒绝</button></div></div>)}{joinRequests.length === 0 && <p className="management-empty">暂无待处理申请</p>}</div>{joinRequestBuckets.some((bucket) => bucket.hasMore) && <button className="dialog-secondary" type="button" disabled={saving} onClick={() => void loadMoreRequests()}>加载更多申请</button>}</section>
              </>}
              {tab === "audit" && capabilities?.canViewEventLog && <section className="management-section"><div className="management-section-heading"><h3>管理操作</h3><span>{events.length} 条</span></div><div className="management-event-list">{events.map((event) => <div className="management-event-row" key={event.id}><div><strong>{event.summary}</strong><small>{event.actor?.displayName ?? "未知操作者"} · {new Date(event.date).toLocaleString("zh-CN")}</small></div></div>)}{events.length === 0 && <p className="management-empty">暂无管理事件</p>}</div>{hasMoreEvents && <button className="dialog-secondary" type="button" onClick={() => void loadMoreEvents()}>加载更早记录</button>}</section>}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
