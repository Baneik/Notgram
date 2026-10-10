import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Activity, ArrowRight, BookOpen, ChevronRight, CircleAlert, FileText, Link, LoaderCircle, Search, Settings2, Shield, UsersRound, X } from "lucide-react";
import { currentLanguage, translate } from "../i18n";
import type { Chat, ChatEventPage, ChatManagement, ChatMemberStatusInput, ChatPermissions, GetManagedMembersInput, ManagedMemberPage, UpdateChatManagementInput, User } from "../telegram/types";
import { useModalFocus } from "../hooks/useModalFocus";
import { Avatar } from "./Avatar";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { ManagementMemberPanel } from "./ManagementMemberPanel";
import { ManagementSettingsPanel } from "./ManagementSettingsPanel";
import { ManagementInvitesPanel, type ManagementInvitesProps } from "./ManagementInvitesPanel";
import { ForumTopicsView } from "./ForumTopicsView";
import "./chatManagement.css";

export type ManagementTab = "overview" | "members" | "admins" | "permissions" | "invites" | "topics" | "audit" | "ownership";
interface Props extends Omit<ManagementInvitesProps, "channel" | "allInvites" | "onDirtyChange" | "onBusyChange"> {
  chat: Chat;
  currentUserId?: string;
  contacts: User[];
  linkedChats: Chat[];
  initialTab?: ManagementTab;
  topics: Omit<ComponentProps<typeof ForumTopicsView>, "chat" | "onBack" | "managementMode">;
  management?: ChatManagement;
  loading: boolean;
  error?: string;
  onLoad: (offset?: number) => Promise<ChatManagement | undefined>;
  onClose: () => void;
  onAddMembers: (userIds: string[]) => Promise<boolean>;
  onSetMemberStatus: (userId: string, status: ChatMemberStatusInput) => Promise<boolean>;
  onSetMemberTag: (userId: string, tag: string) => Promise<boolean>;
  onSetPermissions: (value: ChatPermissions) => Promise<boolean>;
  onSetSlowMode: (seconds: number) => Promise<boolean>;
  onSetAutoDelete: (seconds: number) => Promise<boolean>;
  onTransferOwnership: (userId: string, password: string) => Promise<boolean>;
  onLoadEvents: (fromEventId?: string, query?: string) => Promise<ChatEventPage | undefined>;
  onSearchMembers: (input: GetManagedMembersInput) => Promise<ManagedMemberPage | undefined>;
  onUpdateSettings: (input: UpdateChatManagementInput) => Promise<boolean>;
}

export function ChatManagementDialog(props: Props) {
  const { chat, management, loading, error, onLoad, onClose, currentUserId, contacts, linkedChats } = props;
  const c = management?.capabilities ?? chat.management;
  const [tab, setTab] = useState<ManagementTab>(props.initialTab ?? "overview");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState<() => void>();
  const closeRef = useRef<HTMLButtonElement>(null);
  const navigate = (action: () => void) => {
    if (busy || loading) return;
    if (dirty) setDiscard(() => action);
    else action();
  };
  const close = () => navigate(onClose);
  const ref = useModalFocus<HTMLElement>(close, busy, closeRef);
  useEffect(() => { void onLoad(); }, [onLoad]);
  const nav = [
    { key: "overview", label: translate("概览与资料"), icon: Activity, show: true },
    { key: "members", label: translate("成员"), icon: UsersRound, show: true },
    { key: "admins", label: translate("管理员"), icon: Shield, show: true },
    { key: "permissions", label: chat.kind === "channel" ? translate("频道设置") : translate("权限与安全"), icon: Settings2, show: Boolean(c?.canChangeInfo || c?.canManagePermissions || c?.canManageSlowMode || c?.canRestrictMembers || c?.status === "owner") },
    { key: "invites", label: translate("邀请与申请"), icon: Link, show: c?.canManageInvites },
    { key: "topics", label: translate("话题"), icon: BookOpen, show: chat.isForum && c?.canManageTopics },
    { key: "audit", label: translate("最近操作"), icon: FileText, show: c?.canViewEventLog && c.chatType !== "basicGroup" },
    { key: "ownership", label: translate("所有权"), icon: Shield, show: c?.status === "owner" },
  ] as const;
  const available = nav.filter(item => item.show);
  const selectedTab = available.some(item => item.key === tab) ? tab : "overview";
  const title = available.find(item => item.key === selectedTab)?.label;
  const count = management?.memberCount ?? chat.memberCount;
  const stats = [
    { key: "members", label: chat.kind === "channel" ? translate("订阅者") : translate("成员"), value: count, icon: UsersRound },
    { key: "admins", label: translate("管理员"), value: management?.settings?.administratorCount ?? (management?.administratorLabels ? Object.keys(management.administratorLabels).length : undefined), icon: Shield },
    { key: "permissions", label: translate("受限成员"), value: management?.settings?.restrictedCount, icon: Settings2 },
  ] as const;
  const settingsProps = { chat, management: management!, linkedChats, onUpdate: props.onUpdateSettings, onPermissions: props.onSetPermissions, onSlowMode: props.onSetSlowMode, onAutoDelete: props.onSetAutoDelete, onDirtyChange: setDirty, onBusyChange: setBusy };
  return <>
    <div className="profile-backdrop management-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}><section ref={ref} className="management-workspace" role="dialog" aria-modal="true" aria-labelledby="chat-management-title" tabIndex={-1}>
      <header className="management-workspace-header"><div className="management-header-identity"><Avatar avatar={chat.avatar} size="small" /><div><p className="management-eyebrow">{chat.kind === "channel" ? translate("频道管理") : chat.isForum ? translate("话题群组管理") : translate("群组管理")}</p><h2 id="chat-management-title">{chat.title}</h2><span>{c?.status === "owner" ? translate("所有者") : translate("管理员")}{count !== undefined ? ` · ${translate("{{value0}} 人", { value0: count })}` : ""}</span></div></div><button ref={closeRef} className="icon-button" type="button" disabled={busy} aria-label={translate("关闭管理面板")} onClick={close}><X size={20} /></button></header>
      <div className="management-workspace-layout"><nav className="management-sidebar" aria-label={translate("管理分类")}>{available.map(item => { const Icon = item.icon; return <button key={item.key} type="button" disabled={busy || loading} aria-current={selectedTab === item.key ? "page" : undefined} className={selectedTab === item.key ? "is-active" : ""} onClick={() => navigate(() => { setDirty(false); setTab(item.key); })}><Icon size={17} /><span>{item.label}</span><ChevronRight size={14} /></button>; })}</nav>
        <div className="management-workspace-main" key={selectedTab}><div className="management-page-heading"><h3>{title}</h3>{loading && management && <LoaderCircle className="spin" size={17} />}</div>
          {loading && !management ? <p className="management-empty" role="status"><LoaderCircle className="spin" size={22} />{translate("正在读取管理资料")}</p> : !management ? <div className="management-state" role="alert"><CircleAlert size={22} /><p>{error || translate("读取失败，请重试")}</p><button className="dialog-secondary" type="button" onClick={() => void onLoad()}>{translate("重试")}</button></div> : <>
            {error && <p role="alert" className="management-hint">{error}<button className="dialog-secondary" type="button" onClick={() => void onLoad()}>{translate("重试")}</button></p>}
            {selectedTab === "overview" && <><div className="management-stat-grid">{stats.filter(item => item.key !== "permissions" || chat.kind !== "channel").map(item => { const Icon = item.icon; return <button type="button" key={item.key} onClick={() => navigate(() => setTab(item.key))}><Icon size={18} /><strong>{item.value ?? "—"}</strong><span>{item.label}</span><ArrowRight size={15} /></button>; })}</div><ManagementSettingsPanel {...settingsProps} section="info" /><p className="management-hint">{translate("管理操作以 Telegram 返回的权限与状态为准。")}</p></>}
            {(selectedTab === "members" || selectedTab === "admins") && <ManagementMemberPanel chat={chat} capabilities={c!} currentUserId={currentUserId} contacts={contacts} administrators={selectedTab === "admins"} onSearch={props.onSearchMembers} onAdd={props.onAddMembers} onSetStatus={props.onSetMemberStatus} onSetTag={props.onSetMemberTag} onDirtyChange={setDirty} onBusyChange={setBusy} />}
            {selectedTab === "permissions" && <ManagementSettingsPanel {...settingsProps} section="permissions" />}
            {selectedTab === "invites" && <ManagementInvitesPanel channel={chat.kind === "channel"} allInvites={c!.canManageAllInvites} onGetInviteLinks={props.onGetInviteLinks} onGetInviteCreators={props.onGetInviteCreators} onSaveInviteLink={props.onSaveInviteLink} onRevokeInviteLink={props.onRevokeInviteLink} onGetJoinRequests={props.onGetJoinRequests} onProcessJoinRequest={props.onProcessJoinRequest} onProcessJoinRequests={props.onProcessJoinRequests} onDirtyChange={setDirty} onBusyChange={setBusy} />}
            {selectedTab === "topics" && <ForumTopicsView {...props.topics} onSelectTopic={topicId => navigate(() => props.topics.onSelectTopic(topicId))} chat={chat} managementMode onDirtyChange={setDirty} onBusyChange={setBusy} onBack={close} />}
            {selectedTab === "audit" && <ManagementEvents onLoad={props.onLoadEvents} />}
            {selectedTab === "ownership" && <ManagementOwnership chat={chat} management={management} onSearch={props.onSearchMembers} onTransfer={props.onTransferOwnership} onDirtyChange={setDirty} onBusyChange={setBusy} />}
          </>}
        </div></div>
    </section></div>
    {discard && <ConfirmActionDialog title={translate("放弃未保存的修改？")} description={translate("离开此页面后，未保存的修改将被丢弃。")} confirmLabel={translate("放弃修改")} onConfirm={async () => { setDirty(false); discard(); return true; }} onClose={() => setDiscard(undefined)} />}
  </>;
}

function ManagementEvents({ onLoad }: { onLoad: Props["onLoadEvents"] }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<ChatEventPage>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => { const id = ++generation.current; setLoading(true); setFailed(false); setPage(undefined); const timer = setTimeout(() => { void onLoad(undefined, query).then(value => { if (id === generation.current) { setPage(value); setFailed(!value); setLoading(false); } }); }, query ? 250 : 0); return () => { clearTimeout(timer); generation.current++; }; }, [query, onLoad, revision]);
  const more = async () => { if (!page?.hasMore || loading) return; const id = generation.current; setLoading(true); const next = await onLoad(page.nextEventId, query); if (id !== generation.current) return; setLoading(false); if (next) setPage({ ...next, events: [...page.events, ...next.events.filter(event => !page.events.some(old => old.id === event.id))] }); else setFailed(true); };
  return <section className="management-card"><label className="management-search"><Search size={16} /><input value={query} maxLength={128} onChange={event => setQuery(event.target.value)} aria-label={translate("搜索管理记录")} placeholder={translate("搜索管理记录")} /></label><div className="management-event-timeline">{page?.events.map(event => <article key={event.id}><Activity size={16} /><div><strong>{event.summary}</strong><small>{event.actor?.displayName ?? translate("未知操作者")} · {new Date(event.date).toLocaleString(currentLanguage())}</small></div></article>)}</div>{loading && <p className="management-empty" role="status"><LoaderCircle className="spin" size={18} />{translate("正在加载")}</p>}{failed && <p role="alert" className="management-empty">{translate("读取失败，请重试")}<button className="dialog-secondary" type="button" onClick={() => setRevision(value => value + 1)}>{translate("重试")}</button></p>}{!loading && !failed && !page?.events.length && <p className="management-empty">{translate("暂无管理事件")}</p>}{page?.hasMore && <button className="dialog-secondary" type="button" disabled={loading} onClick={() => void more()}>{translate("加载更早记录")}</button>}</section>;
}

function ManagementOwnership({ chat, management, onSearch, onTransfer, onDirtyChange, onBusyChange }: { chat: Chat; management: ChatManagement; onSearch: Props["onSearchMembers"]; onTransfer: Props["onTransferOwnership"]; onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<ManagedMemberPage>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<User>();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const generation = useRef(0);
  useEffect(() => { onDirtyChange(Boolean(password || selected)); return () => onDirtyChange(false); }, [password, selected, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => { const id = ++generation.current; setLoading(true); setFailed(false); const timer = setTimeout(() => { void onSearch({ chatId: chat.id, filter: "members", query }).then(value => { if (id === generation.current) { setPage(value); setLoading(false); setFailed(!value); } }); }, 250); return () => { clearTimeout(timer); generation.current++; }; }, [chat.id, onSearch, query, retry]);
  const availability = management.ownershipTransfer;
  const reason = availability?.reason === "passwordNeeded" ? translate("需要先为 Telegram 账号启用两步验证") : availability?.reason === "passwordTooFresh" ? translate("两步验证启用时间过短") : availability?.reason === "sessionTooFresh" ? translate("当前登录会话时间过短") : translate("当前会话暂时不能转移所有权");
  return <section className="management-card management-ownership"><h3>{translate("转移所有者")}</h3><p className="management-hint">{translate("新所有者将获得完整控制权。转移需要 Telegram 两步验证密码。")}</p>{!management.capabilities.canTransferOwnership ? <p role="status">{reason}{availability?.retryAfter ? ` · ${translate("约 {{hours}} 小时后重试", { hours: Math.ceil(availability.retryAfter / 3600) })}` : ""}</p> : <><label className="management-search"><Search size={16} /><input aria-label={translate("搜索新的所有者")} value={query} maxLength={128} disabled={busy} onChange={event => setQuery(event.target.value)} placeholder={translate("搜索新的所有者")} /></label><div className="management-people">{page?.members.filter(member => (member.status === "member" || member.status === "administrator") && !member.user.isBot).map(member => <label className="management-contact-row" key={member.user.id}><input type="radio" name="ownership-candidate" checked={selected?.id === member.user.id} disabled={busy} onChange={() => setSelected(member.user)} /><Avatar avatar={member.user.avatar} size="small" /><span>{member.user.displayName}</span></label>)}</div>{loading && <p role="status" className="management-empty">{translate("正在加载")}</p>}{failed && <p role="alert">{translate("读取失败，请重试")}<button className="dialog-secondary" type="button" onClick={() => setRetry(value => value + 1)}>{translate("重试")}</button></p>}{!loading && !failed && !page?.members.length && <p className="management-empty">{translate("没有符合条件的成员")}</p>}{selected && <p>{translate("新的所有者：{{name}}", { name: selected.displayName })}</p>}<label className="management-field"><span>{translate("两步验证密码")}</span><input type="password" autoComplete="off" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label><button className="dialog-danger" type="button" disabled={busy || !selected || !password.trim()} onClick={() => setConfirm(true)}>{translate("转移所有者")}</button></>}
    {confirm && selected && <ConfirmActionDialog title={translate("确认转移所有权")} description={translate("将完整控制权交给 {{name}}，请确认对象。", { name: selected.displayName })} confirmLabel={translate("转移所有者")} error={translate("操作失败，请重试")} onConfirm={async () => { setBusy(true); try { const ok = await onTransfer(selected.id, password); if (ok) { setPassword(""); setSelected(undefined); } return ok; } finally { setBusy(false); } }} onClose={() => setConfirm(false)} />}
  </section>;
}
