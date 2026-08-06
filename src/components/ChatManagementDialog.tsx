import {
  ClipboardList,
  Check,
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
  ChatEvent,
  ChatInviteLink,
  ChatJoinRequest,
  ChatManagement,
  ChatMemberStatusInput,
  ChatPermissions,
  ManagedChatMember,
  User,
  CreateChatInviteLinkInput,
} from "../telegram/types";
import { DEFAULT_CHAT_ADMIN_RIGHTS, DEFAULT_CHAT_PERMISSIONS, CHAT_ADMIN_RIGHT_LABELS, CHAT_PERMISSION_LABELS } from "../telegram/chatManagement";
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
  onGetInviteLinks: () => Promise<{ links: ChatInviteLink[]; hasMore: boolean } | undefined>;
  onSaveInviteLink: (input: Omit<CreateChatInviteLinkInput, "chatId">, inviteLink?: string) => Promise<ChatInviteLink | undefined>;
  onRevokeInviteLink: (inviteLink: string) => Promise<boolean>;
  onGetJoinRequests: (inviteLink?: string) => Promise<{ requests: ChatJoinRequest[]; totalCount: number; hasMore: boolean } | undefined>;
  onProcessJoinRequest: (userId: string, approve: boolean) => Promise<boolean>;
  onProcessJoinRequests: (inviteLink: string | undefined, approve: boolean) => Promise<boolean>;
}

type Tab = "members" | "permissions" | "invites" | "audit";

const roleLabel = (member: ManagedChatMember) => {
  if (member.status === "owner") return "所有者";
  if (member.status === "administrator") return member.customTitle || "管理员";
  if (member.status === "restricted") return "受限成员";
  if (member.status === "banned") return "已封禁";
  if (member.status === "left") return "已离开";
  return "成员";
};

const formatSlowMode = (seconds: number) => seconds === 0 ? "关闭" : seconds >= 60 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`;

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
  const [joinRequests, setJoinRequests] = useState<ChatJoinRequest[]>([]);
  const [inviteName, setInviteName] = useState("");
  const [inviteExpiry, setInviteExpiry] = useState("");
  const [inviteLimit, setInviteLimit] = useState(0);
  const [inviteApproval, setInviteApproval] = useState(false);
  const [subscriptionStars, setSubscriptionStars] = useState(0);
  const [editingInviteLink, setEditingInviteLink] = useState<string>();

  useEffect(() => { void onLoad(); }, [onLoad]);
  useEffect(() => { if (management) setLocalPermissions(management.permissions); }, [management]);
  useEffect(() => {
    if (tab !== "audit") return;
    let cancelled = false;
    void onLoadEvents().then((page) => {
      if (!cancelled && page) { setEvents(page.events); setNextEventId(page.nextEventId); setHasMoreEvents(page.hasMore); }
    });
    return () => { cancelled = true; };
  }, [onLoadEvents, tab]);
  useEffect(() => {
    if (tab !== "invites") return;
    let cancelled = false;
    void Promise.all([onGetInviteLinks(), onGetJoinRequests()]).then(([links, requests]) => {
      if (cancelled) return;
      if (links) setInviteLinks(links.links);
      if (requests) setJoinRequests(requests.requests);
    });
    return () => { cancelled = true; };
  }, [onGetInviteLinks, onGetJoinRequests, tab]);

  const members = management?.members ?? [];
  const visibleContacts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return contacts.filter((user) => !members.some((member) => member.user.id === user.id && member.status !== "left" && member.status !== "banned"))
      .filter((user) => !normalized || `${user.displayName} ${user.username ?? ""}`.toLocaleLowerCase().includes(normalized));
  }, [contacts, members, query]);

  const togglePermission = (key: keyof ChatPermissions) => setLocalPermissions((current) => ({ ...current, [key]: !current[key] }));
  const savePermissions = async () => { setSaving(true); await onSetPermissions(localPermissions); setSaving(false); };
  const addSelected = async () => { if (selected.length === 0) return; setSaving(true); if (await onAddMembers(selected)) { setSelected([]); setQuery(""); } setSaving(false); };
  const updateMember = async (member: ManagedChatMember, action: "administrator" | "restricted" | "banned" | "member") => {
    setSaving(true);
    if (action === "administrator") await onSetMemberStatus(member.user.id, { kind: "administrator", rights: member.adminRights ?? DEFAULT_CHAT_ADMIN_RIGHTS });
    else if (action === "restricted") await onSetMemberStatus(member.user.id, { kind: "restricted", permissions: member.permissions ?? { ...DEFAULT_CHAT_PERMISSIONS, canSendBasicMessages: false } });
    else if (action === "banned") await onSetMemberStatus(member.user.id, { kind: "banned" });
    else await onSetMemberStatus(member.user.id, { kind: "member" });
    setSaving(false);
  };
  const transfer = async () => {
    if (!transferUserId || !transferPassword.trim()) return;
    setSaving(true); if (await onTransferOwnership(transferUserId, transferPassword)) { setTransferUserId(""); setTransferPassword(""); } setSaving(false);
  };
  const loadMoreEvents = async () => {
    if (!nextEventId) return;
    const page = await onLoadEvents(nextEventId);
    if (page) { setEvents((current) => [...current, ...page.events]); setNextEventId(page.nextEventId); setHasMoreEvents(page.hasMore); }
  };
  const resetInviteForm = () => { setInviteName(""); setInviteExpiry(""); setInviteLimit(0); setInviteApproval(false); setSubscriptionStars(0); setEditingInviteLink(undefined); };
  const saveInvite = async () => {
    setSaving(true);
    const saved = await onSaveInviteLink({ name: inviteName, expirationDate: inviteExpiry ? Math.floor(new Date(inviteExpiry).getTime() / 1000) : undefined, memberLimit: inviteLimit, createsJoinRequest: inviteApproval, subscriptionStars: subscriptionStars || undefined }, editingInviteLink);
    if (saved) { const page = await onGetInviteLinks(); if (page) setInviteLinks(page.links); resetInviteForm(); }
    setSaving(false);
  };
  const editInvite = (link: ChatInviteLink) => { setEditingInviteLink(link.inviteLink); setInviteName(link.name); setInviteExpiry(link.expiresAt ? new Date(link.expiresAt).toISOString().slice(0, 16) : ""); setInviteLimit(link.memberLimit); setInviteApproval(link.createsJoinRequest); setSubscriptionStars(link.subscriptionStars ?? 0); };
  const revokeInvite = async (inviteLink: string) => { setSaving(true); if (await onRevokeInviteLink(inviteLink)) setInviteLinks((current) => current.filter((link) => link.inviteLink !== inviteLink)); setSaving(false); };
  const processRequest = async (userId: string, approve: boolean) => { setSaving(true); if (await onProcessJoinRequest(userId, approve)) setJoinRequests((current) => current.filter((request) => request.user.id !== userId)); setSaving(false); };
  const processRequests = async (approve: boolean) => { setSaving(true); if (await onProcessJoinRequests(undefined, approve)) setJoinRequests([]); setSaving(false); };

  return (
    <div className="profile-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="chat-management-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-management-title" tabIndex={-1}>
        <header className="settings-dialog-header">
          <div><h2 id="chat-management-title">管理“{chat.title}”</h2><small>成员、权限和操作记录</small></div>
          <button ref={closeRef} className="icon-button" type="button" aria-label="关闭管理面板" onClick={onClose}><X size={19} /></button>
        </header>
        <nav className="chat-management-tabs" aria-label="管理分类">
          <button type="button" className={tab === "members" ? "is-active" : ""} onClick={() => setTab("members")}><UsersRound size={16} />成员</button>
          <button type="button" className={tab === "permissions" ? "is-active" : ""} onClick={() => setTab("permissions")}><Shield size={16} />权限</button>
          <button type="button" className={tab === "invites" ? "is-active" : ""} onClick={() => setTab("invites")}><Link size={16} />邀请</button>
          <button type="button" className={tab === "audit" ? "is-active" : ""} onClick={() => setTab("audit")}><ClipboardList size={16} />审计日志</button>
        </nav>
        <div className="chat-management-body">
          {loading && !management ? <div className="profile-state"><LoaderCircle className="spin" size={22} /></div> : error && !management ? <div className="profile-state is-error" role="alert">{error}<button className="dialog-secondary" type="button" onClick={() => void onLoad()}><LoaderCircle size={15} />重试</button></div> : (
            <>
              {tab === "members" && (
                <>
                  <section className="management-section">
                    <div className="management-section-heading"><h3>添加成员</h3><span>{selected.length ? `已选 ${selected.length}` : "从联系人中选择"}</span></div>
                    <label className="new-chat-search"><Search size={15} /><input aria-label="搜索联系人" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索联系人" /></label>
                    <div className="management-contact-list">
                      {visibleContacts.slice(0, 8).map((user) => <label className="management-contact-row" key={user.id}><input type="checkbox" checked={selected.includes(user.id)} onChange={() => setSelected((current) => current.includes(user.id) ? current.filter((id) => id !== user.id) : [...current, user.id])} /><Avatar avatar={user.avatar} size="small" /><span><strong>{user.displayName}</strong><small>{user.username ? `@${user.username}` : "联系人"}</small></span></label>)}
                      {visibleContacts.length === 0 && <p className="management-empty">没有可添加的联系人</p>}
                    </div>
                    <button className="dialog-primary" type="button" disabled={saving || selected.length === 0} onClick={() => void addSelected()}><UserPlus size={15} />添加成员</button>
                  </section>
                  <section className="management-section">
                    <div className="management-section-heading"><h3>成员与角色</h3><span>{management?.memberHasMore ? "可继续加载" : `${members.length} 人`}</span></div>
                    <div className="management-member-list">
                      {members.map((member) => <div className="management-member-row" key={member.user.id}>
                        <Avatar avatar={member.user.avatar} size="small" /><span className="management-member-identity"><strong>{member.user.displayName}{member.user.id === currentUserId ? "（我）" : ""}</strong><small>{roleLabel(member)}{member.untilDate ? ` · 至 ${new Date(member.untilDate * 1000).toLocaleDateString("zh-CN")}` : ""}</small></span>
                        {member.status !== "owner" && member.user.id !== currentUserId && <select aria-label={`设置 ${member.user.displayName} 的角色`} value={member.status === "left" ? "member" : member.status} disabled={saving} onChange={(event) => void updateMember(member, event.target.value as "administrator" | "restricted" | "banned" | "member")}><option value="member">成员</option><option value="administrator">管理员</option><option value="restricted">受限</option><option value="banned">封禁</option></select>}
                      </div>)}
                    </div>
                    {management?.memberHasMore && <button className="dialog-secondary" type="button" disabled={loading} onClick={() => void onLoad((management.memberOffset ?? 0) + members.length)}>加载更多成员</button>}
                  </section>
                  {management?.canTransferOwnership && <section className="management-section"><div className="management-section-heading"><h3>转移所有者</h3><span>需要两步验证密码</span></div><select aria-label="选择新的所有者" value={transferUserId} onChange={(event) => setTransferUserId(event.target.value)}><option value="">选择成员</option>{members.filter((member) => member.status === "member" || member.status === "administrator").map((member) => <option key={member.user.id} value={member.user.id}>{member.user.displayName}</option>)}</select><input aria-label="两步验证密码" type="password" value={transferPassword} onChange={(event) => setTransferPassword(event.target.value)} placeholder="两步验证密码" /><button className="dialog-danger" type="button" disabled={saving || !transferUserId || !transferPassword.trim()} onClick={() => void transfer()}>转移所有者</button></section>}
                </>
              )}
              {tab === "permissions" && <>
                <section className="management-section"><div className="management-section-heading"><h3>默认发送权限</h3><span>影响所有普通成员</span></div><div className="management-permission-grid">{(Object.keys(CHAT_PERMISSION_LABELS) as (keyof ChatPermissions)[]).map((key) => <label key={key}><input type="checkbox" checked={localPermissions[key]} disabled={!management?.canManagePermissions || saving} onChange={() => togglePermission(key)} /><span>{CHAT_PERMISSION_LABELS[key]}</span></label>)}</div><button className="dialog-primary" type="button" disabled={!management?.canManagePermissions || saving} onClick={() => void savePermissions()}>保存默认权限</button></section>
                <section className="management-section"><div className="management-section-heading"><h3>慢速模式</h3><span>{formatSlowMode(management?.slowModeDelay ?? 0)}</span></div><select aria-label="慢速模式间隔" disabled={!management?.canManagePermissions || saving} value={management?.slowModeDelay ?? 0} onChange={(event) => void onSetSlowMode(Number(event.target.value))}><option value={0}>关闭</option><option value={10}>10 秒</option><option value={30}>30 秒</option><option value={60}>1 分钟</option><option value={300}>5 分钟</option><option value={900}>15 分钟</option></select></section>
                {members.some((member) => member.status === "restricted") && <section className="management-section"><div className="management-section-heading"><h3>成员例外权限</h3><span>每位受限成员独立设置</span></div>{members.filter((member) => member.status === "restricted").map((member) => <div className="management-exception-editor" key={member.user.id}><div className="management-exception-row"><Avatar avatar={member.user.avatar} size="small" /><span>{member.user.displayName}</span><small>{Object.values(member.permissions ?? {}).filter(Boolean).length} 项允许</small></div><div className="management-permission-grid">{(Object.keys(CHAT_PERMISSION_LABELS) as (keyof ChatPermissions)[]).map((key) => <label key={key}><input type="checkbox" checked={(member.permissions ?? DEFAULT_CHAT_PERMISSIONS)[key]} disabled={saving} onChange={() => void onSetMemberStatus(member.user.id, { kind: "restricted", permissions: { ...(member.permissions ?? DEFAULT_CHAT_PERMISSIONS), [key]: !(member.permissions ?? DEFAULT_CHAT_PERMISSIONS)[key] } })} /><span>{CHAT_PERMISSION_LABELS[key]}</span></label>)}</div></div>)}</section>}
                {members.some((member) => member.status === "administrator") && <section className="management-section"><div className="management-section-heading"><h3>管理员权限</h3><span>完整权限矩阵</span></div>{members.filter((member) => member.status === "administrator").map((member) => <div className="management-exception-editor" key={member.user.id}><div className="management-exception-row"><Avatar avatar={member.user.avatar} size="small" /><span>{member.user.displayName}</span><small>管理员</small></div><div className="management-permission-grid">{(Object.keys(CHAT_ADMIN_RIGHT_LABELS) as (keyof typeof DEFAULT_CHAT_ADMIN_RIGHTS)[]).map((key) => <label key={key}><input type="checkbox" checked={(member.adminRights ?? DEFAULT_CHAT_ADMIN_RIGHTS)[key]} disabled={saving} onChange={() => void onSetMemberStatus(member.user.id, { kind: "administrator", rights: { ...(member.adminRights ?? DEFAULT_CHAT_ADMIN_RIGHTS), [key]: !(member.adminRights ?? DEFAULT_CHAT_ADMIN_RIGHTS)[key] } })} /><span>{CHAT_ADMIN_RIGHT_LABELS[key]}</span></label>)}</div></div>)}</section>}
              </>}
              {tab === "invites" && <>
                <section className="management-section"><div className="management-section-heading"><h3>{editingInviteLink ? "编辑邀请链接" : "新建邀请链接"}</h3><span>可设置有效期、人数或订阅</span></div><div className="invite-form-grid"><label><span>名称</span><input aria-label="邀请链接名称" value={inviteName} onChange={(event) => setInviteName(event.target.value)} maxLength={32} placeholder="例如：发布群" /></label><label><span>有效期</span><input aria-label="邀请链接有效期" type="datetime-local" value={inviteExpiry} onChange={(event) => setInviteExpiry(event.target.value)} /></label><label><span>使用人数</span><input aria-label="邀请链接使用人数" type="number" min={0} max={99999} value={inviteLimit} onChange={(event) => setInviteLimit(Math.max(0, Number(event.target.value)))} /></label><label><span>每月 Stars</span><input aria-label="订阅 Stars" type="number" min={0} max={1000000000} value={subscriptionStars} onChange={(event) => setSubscriptionStars(Math.max(0, Number(event.target.value)))} disabled={Boolean(editingInviteLink && !subscriptionStars)} /></label></div><label className="management-check"><input type="checkbox" checked={inviteApproval} disabled={subscriptionStars > 0} onChange={(event) => setInviteApproval(event.target.checked)} /><span>新成员需要管理员批准</span></label><div className="management-inline-actions"><button className="dialog-primary" type="button" disabled={saving || (!inviteName.trim() && !subscriptionStars)} onClick={() => void saveInvite()}>{editingInviteLink ? "保存链接" : "创建链接"}</button>{editingInviteLink && <button className="dialog-secondary" type="button" onClick={resetInviteForm}>取消编辑</button>}</div></section>
                <section className="management-section"><div className="management-section-heading"><h3>有效链接</h3><span>{inviteLinks.length} 条</span></div><div className="invite-link-list">{inviteLinks.map((link) => <div className="invite-link-row" key={link.inviteLink}><div className="invite-link-main"><strong>{link.name || "邀请链接"}{link.isPrimary ? " · 主链接" : ""}</strong><small>{link.subscriptionStars ? `${link.subscriptionStars} Stars/月` : link.createsJoinRequest ? "需要审批" : "直接加入"}{link.expiresAt ? ` · ${new Date(link.expiresAt).toLocaleDateString("zh-CN")} 到期` : ""}</small><code>{link.inviteLink}</code></div><div className="invite-source-stats" aria-label={`${link.name} 成员来源统计`}><span><strong>{link.memberCount}</strong><small>已加入</small></span><span><strong>{link.pendingJoinRequestCount}</strong><small>待审批</small></span><span><strong>{link.expiredMemberCount}</strong><small>已过期</small></span></div><div className="management-inline-actions"><button className="icon-button" type="button" aria-label={`复制 ${link.name}`} title="复制链接" onClick={() => void navigator.clipboard.writeText(link.inviteLink)}><Copy size={15} /></button><button className="dialog-secondary" type="button" disabled={saving} onClick={() => editInvite(link)}>编辑</button><button className="dialog-danger" type="button" disabled={saving} onClick={() => void revokeInvite(link.inviteLink)}>撤销</button></div></div>)}{inviteLinks.length === 0 && <p className="management-empty">暂无有效邀请链接</p>}</div></section>
                <section className="management-section"><div className="management-section-heading"><h3>入群申请</h3><span>{joinRequests.length} 个待处理</span></div>{joinRequests.length > 0 && <div className="management-inline-actions"><button className="dialog-primary" type="button" disabled={saving} onClick={() => void processRequests(true)}><Check size={14} />全部批准</button><button className="dialog-danger" type="button" disabled={saving} onClick={() => void processRequests(false)}>全部拒绝</button></div>}<div className="join-request-list">{joinRequests.map((request) => <div className="join-request-row" key={request.user.id}><Avatar avatar={request.user.avatar} size="small" /><span><strong>{request.user.displayName}</strong><small>{request.bio || new Date(request.date).toLocaleString("zh-CN")}</small></span><div className="management-inline-actions"><button className="dialog-primary" type="button" aria-label={`批准 ${request.user.displayName}`} disabled={saving} onClick={() => void processRequest(request.user.id, true)}>批准</button><button className="dialog-secondary" type="button" aria-label={`拒绝 ${request.user.displayName}`} disabled={saving} onClick={() => void processRequest(request.user.id, false)}>拒绝</button></div></div>)}{joinRequests.length === 0 && <p className="management-empty">暂无待处理申请</p>}</div></section>
              </>}
              {tab === "audit" && <section className="management-section"><div className="management-section-heading"><h3>管理操作</h3><span>{events.length} 条</span></div><div className="management-event-list">{events.map((event) => <div className="management-event-row" key={event.id}><div><strong>{event.summary}</strong><small>{event.actor?.displayName ?? "系统"} · {new Date(event.date).toLocaleString("zh-CN")}</small></div></div>)}{events.length === 0 && <p className="management-empty">暂无管理事件</p>}</div>{hasMoreEvents && <button className="dialog-secondary" type="button" onClick={() => void loadMoreEvents()}>加载更早记录</button>}</section>}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
