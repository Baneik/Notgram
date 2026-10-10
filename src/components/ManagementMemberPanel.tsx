import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, LoaderCircle, Search, UserPlus } from "lucide-react";
import { translate, currentLanguage } from "../i18n";
import { CHAT_ADMIN_RIGHT_LABELS, CHAT_PERMISSION_LABELS, DEFAULT_CHAT_ADMIN_RIGHTS, DEFAULT_CHAT_PERMISSIONS, chatMemberTagError } from "../telegram/chatManagement";
import type { Chat, ChatAdminRightKey, ChatAdminRights, ChatManagementCapabilities, ChatMemberStatusInput, ChatPermissions, GetManagedMembersInput, ManagedChatMember, ManagedMemberFilter, ManagedMemberPage, User } from "../telegram/types";
import { Avatar } from "./Avatar";
import { ConfirmActionDialog } from "./ConfirmActionDialog";

export const managedRoleLabel = (member: ManagedChatMember) => member.status === "owner" ? translate("所有者") : member.status === "administrator" ? translate("管理员") : member.status === "restricted" ? translate("受限成员") : member.status === "banned" ? translate("已封禁") : member.status === "left" ? translate("已离开") : translate("成员");

interface Props {
  chat: Chat;
  capabilities: ChatManagementCapabilities;
  currentUserId?: string;
  contacts: User[];
  administrators?: boolean;
  onSearch: (input: GetManagedMembersInput) => Promise<ManagedMemberPage | undefined>;
  onAdd: (ids: string[]) => Promise<boolean>;
  onSetStatus: (id: string, status: ChatMemberStatusInput) => Promise<boolean>;
  onSetTag: (id: string, tag: string) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}

const administratorKeys = (chat: Chat, c: ChatManagementCapabilities) => (Object.keys(CHAT_ADMIN_RIGHT_LABELS) as ChatAdminRightKey[]).filter(key => {
  if (["canPostMessages", "canEditMessages", "canManageDirectMessages"].includes(key)) return c.chatType === "channel";
  if (key === "isAnonymous") return c.chatType === "supergroup";
  if (["canPinMessages", "canManageTags"].includes(key)) return c.chatType !== "channel";
  if (key === "canManageTopics") return chat.isForum === true;
  if (["canManageChat", "canPromoteMembers", "canPostStories", "canEditStories", "canDeleteStories"].includes(key)) return c.chatType !== "basicGroup";
  return true;
});

export function ManagementMemberPanel({ chat, capabilities: c, currentUserId, contacts, administrators = false, onSearch, onAdd, onSetStatus, onSetTag, onDirtyChange, onBusyChange }: Props) {
  const [filter, setFilter] = useState<ManagedMemberFilter>(administrators ? "administrators" : "members");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<ManagedMemberPage>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<ManagedChatMember>();
  const [status, setStatus] = useState<ChatMemberStatusInput["kind"]>("member");
  const [rights, setRights] = useState<ChatAdminRights>(DEFAULT_CHAT_ADMIN_RIGHTS);
  const [permissions, setPermissions] = useState<ChatPermissions>(DEFAULT_CHAT_PERMISSIONS);
  const [duration, setDuration] = useState(0);
  const [tag, setTag] = useState("");
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [contactQuery, setContactQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [statusDirty, setStatusDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; run: () => Promise<boolean> }>();
  const generation = useRef(0);
  const operation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    const id = ++generation.current;
    setLoading(true); setFailed(false); setPage(undefined);
    const timer = setTimeout(() => {
      void onSearch({ chatId: chat.id, filter, query }).then(value => {
        if (id !== generation.current) return;
        setPage(value); setFailed(!value); setLoading(false);
      }).catch(() => { if (id === generation.current) { setFailed(true); setLoading(false); } });
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); generation.current++; };
  }, [chat.id, filter, query, onSearch, revision]);

  const run = async (action: () => Promise<boolean>) => {
    if (operation.current) return false;
    operation.current = true; setBusy(true); setMessage("");
    try {
      const ok = await action();
      if (mounted.current) { setMessage(ok ? translate("已保存") : translate("操作失败，请重试")); if (ok) setRevision(value => value + 1); }
      return ok;
    } catch { if (mounted.current) setMessage(translate("操作失败，请重试")); return false; }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  const startEdit = (member: ManagedChatMember) => {
    setEditing(member); setStatus(member.status === "owner" || member.status === "left" ? "member" : member.status);
    const base = c.status === "owner" ? DEFAULT_CHAT_ADMIN_RIGHTS : c.adminRights ?? DEFAULT_CHAT_ADMIN_RIGHTS;
    setRights(member.adminRights ?? { ...base, canPromoteMembers: false, isAnonymous: false });
    setPermissions(member.permissions ?? { ...DEFAULT_CHAT_PERMISSIONS, canSendBasicMessages: false });
    setDuration(member.untilDate && member.untilDate > Math.floor(Date.now() / 1000) ? -1 : 0); setTag(member.customTitle ?? ""); setDirty(false); setStatusDirty(false); setMessage("");
  };
  const protectedMember = !editing || editing.user.id === currentUserId || editing.status === "owner" || editing.status === "administrator" && (editing.canBeEdited === false || !c.canPromoteMembers);
  const canPromote = !protectedMember && c.canPromoteMembers;
  const canRestrict = !protectedMember && c.canRestrictMembers;
  const canRestore = !protectedMember && (["banned", "restricted"].includes(editing?.status ?? "") ? c.canRestrictMembers : c.canPromoteMembers);
  const canTag = c.canManageTags && editing?.user.id !== currentUserId && !["left", "banned"].includes(editing?.status ?? "");
  const adminKeys = administratorKeys(chat, c);
  const markDirty = () => { setDirty(true); setStatusDirty(true); };
  const leaveEditor = () => {
    const close = async () => { setEditing(undefined); setAdding(false); setDirty(false); setSelected([]); return true; };
    if (dirty) setConfirmation({ title: translate("放弃未保存的修改？"), description: translate("离开此页面后，未保存的修改将被丢弃。"), run: close });
    else void close();
  };
  const saveMember = async () => {
    if (!editing) return false;
    const member = editing;
    const tagChanged = canTag && tag !== (member.customTitle ?? "");
    const tagError = tagChanged ? chatMemberTagError(tag) : undefined;
    if (tagError) { setMessage(tagError); return false; }
    const untilDate = duration === -1 ? member.untilDate : duration > 0 ? Math.floor(Date.now() / 1000) + duration : 0;
    const input: ChatMemberStatusInput = status === "administrator" ? { kind: status, rights } : status === "restricted" ? { kind: status, permissions, untilDate } : status === "banned" ? { kind: status, untilDate } : { kind: "member" };
    const statusEditable = statusDirty && (status === "administrator" ? canPromote : ["restricted", "banned"].includes(status) ? canRestrict : canRestore);
    const ok = await run(async () => {
      if (statusEditable && !await onSetStatus(member.user.id, input)) return false;
      return !tagChanged || await onSetTag(member.user.id, tag);
    });
    if (ok && mounted.current) { setDirty(false); setEditing(undefined); }
    return ok;
  };
  const save = () => {
    if (status === "banned" && editing?.status !== "banned") setConfirmation({ title: translate("封禁成员"), description: translate("{{name}} 将无法加入或参与此聊天。", { name: editing?.user.displayName }), run: saveMember });
    else if (editing?.status === "administrator" && status !== "administrator") setConfirmation({ title: translate("移除管理员权限"), description: translate("{{name}} 将失去管理员权限。", { name: editing?.user.displayName }), run: saveMember });
    else void saveMember();
  };
  const loadMore = async () => {
    if (!page?.hasMore || loading) return;
    const id = generation.current; setLoading(true);
    try {
      const next = await onSearch({ chatId: chat.id, filter, query, offset: page.nextOffset });
      if (id !== generation.current) return;
      if (next) setPage({ ...next, members: [...page.members, ...next.members.filter(member => !page.members.some(old => old.user.id === member.user.id))] });
      else setFailed(true);
    } finally { if (id === generation.current) setLoading(false); }
  };

  return <>
    {editing ? <section className="management-card">
      <button className="management-back" type="button" disabled={busy} onClick={leaveEditor}><ArrowLeft size={16} />{translate("返回成员列表")}</button>
      <div className="management-person-heading"><Avatar avatar={editing.user.avatar} size="medium" /><div><h3>{editing.user.displayName}</h3><p>{managedRoleLabel(editing)}{editing.user.username ? ` · @${editing.user.username}` : ""}</p></div></div>
      {protectedMember && <p className="management-hint">{translate("此成员的角色由 Telegram 保护，当前账号无法修改。")}</p>}
      {!protectedMember && <label className="management-field"><span>{translate("角色与状态")}</span><select value={status} disabled={busy} onChange={event => { setStatus(event.target.value as typeof status); markDirty(); }}>
        <option value="member" disabled={editing.status === "banned" || !canRestore && editing.status !== "member"}>{translate("成员")}</option>
        <option value="administrator" disabled={!canPromote}>{translate("管理员")}</option>
        {c.chatType === "supergroup" && <option value="restricted" disabled={!canRestrict}>{translate("受限成员")}</option>}
        <option value="banned" disabled={!canRestrict}>{translate("已封禁")}</option>
      </select></label>}
      {status === "administrator" && <><h4>{translate("管理员权限")}</h4><p className="management-hint">{translate("只能授予自身拥有的权限")}</p><div className="management-switch-list">{adminKeys.map(key => <label key={key}><span>{CHAT_ADMIN_RIGHT_LABELS[key]}</span><input type="checkbox" checked={rights[key]} disabled={busy || !canPromote || c.status !== "owner" && c.adminRights?.[key] !== true} onChange={event => { setRights(value => ({ ...value, [key]: event.target.checked })); markDirty(); }} /></label>)}</div></>}
      {(status === "restricted" || status === "banned") && canRestrict && <label className="management-field"><span>{translate("限制期限")}</span><select value={duration} disabled={busy} onChange={event => { setDuration(Number(event.target.value)); markDirty(); }}>
        {editing.untilDate && editing.untilDate > Math.floor(Date.now() / 1000) ? <option value={-1}>{translate("保留期限：{{date}}", { date: new Date(editing.untilDate * 1000).toLocaleString(currentLanguage()) })}</option> : null}
        <option value={0}>{translate("永久")}</option><option value={3600}>{translate("1 小时")}</option><option value={86400}>{translate("1 天")}</option><option value={604800}>{translate("1 周")}</option><option value={2592000}>{translate("30 天")}</option>
      </select></label>}
      {status === "restricted" && canRestrict && <div className="management-switch-list">{(Object.keys(CHAT_PERMISSION_LABELS) as (keyof ChatPermissions)[]).filter(key => key !== "canCreateTopics" || chat.isForum).map(key => <label key={key}><span>{CHAT_PERMISSION_LABELS[key]}</span><input type="checkbox" checked={permissions[key]} disabled={busy} onChange={event => { setPermissions(value => ({ ...value, [key]: event.target.checked })); markDirty(); }} /></label>)}</div>}
      {!protectedMember && canRestrict && <button className="management-text-danger" type="button" disabled={busy} onClick={() => setConfirmation({ title: editing.status === "banned" ? translate("解除封禁") : translate("移除成员"), description: editing.status === "banned" ? translate("此用户可以重新加入，但不会自动被添加回聊天。") : translate("此成员将离开聊天，之后仍可通过邀请重新加入。"), run: async () => { const ok = await run(() => onSetStatus(editing.user.id, { kind: "left" })); if (ok && mounted.current) { setEditing(undefined); setDirty(false); } return ok; } })}>{editing.status === "banned" ? translate("解除封禁") : translate("移除成员")}</button>}
      {canTag && <label className="management-field"><span>{translate("成员标签")}</span><input value={tag} maxLength={16} disabled={busy} onChange={event => { setTag(event.target.value); setDirty(true); }} /><small>{translate("成员标签需要包含 0 至 16 个非表情字符且不能换行")}</small></label>}
      <div className="management-savebar"><span role="status">{message || (dirty ? translate("有未保存的修改") : "")}</span><button className="dialog-primary" type="button" disabled={busy || !dirty} onClick={save}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{translate("保存修改")}</button></div>
    </section> : adding ? <section className="management-card">
      <button className="management-back" type="button" disabled={busy} onClick={leaveEditor}><ArrowLeft size={16} />{translate("返回成员列表")}</button><h3>{translate("添加成员")}</h3>
      <label className="management-search"><Search size={16} /><input aria-label={translate("搜索联系人")} value={contactQuery} onChange={event => setContactQuery(event.target.value)} placeholder={translate("搜索联系人")} /></label>
      <div className="management-people">{contacts.filter(user => user.id !== currentUserId && !page?.members.some(member => member.user.id === user.id) && `${user.displayName} ${user.username ?? ""}`.toLocaleLowerCase().includes(contactQuery.trim().toLocaleLowerCase())).map(user => <label className="management-contact-row" key={user.id}><input type="checkbox" checked={selected.includes(user.id)} disabled={busy} onChange={() => { setSelected(value => value.includes(user.id) ? value.filter(id => id !== user.id) : [...value, user.id]); setDirty(true); }} /><Avatar avatar={user.avatar} size="small" /><span><strong>{user.displayName}</strong><small>{user.username ? `@${user.username}` : translate("联系人")}</small></span></label>)}</div>
      {contacts.length === 0 && <p className="management-empty">{translate("没有可添加的联系人")}</p>}
      <div className="management-savebar"><span>{translate("已选 {{value0}}", { value0: selected.length })}</span><button className="dialog-primary" type="button" disabled={busy || !selected.length || selected.length > 200} onClick={() => void run(() => onAdd(selected)).then(ok => { if (ok && mounted.current) { setAdding(false); setSelected([]); setDirty(false); } })}>{translate("添加成员")}</button></div>
    </section> : <section className="management-card">
      <div className="management-card-heading"><div><h3>{administrators ? translate("管理员") : translate("成员与角色")}</h3><p>{page?.totalCount === undefined ? translate("搜索和管理聊天成员") : translate("{{value0}} 人", { value0: page.totalCount })}</p></div>{c.canAddMembers && !administrators && <button className="dialog-primary" type="button" onClick={() => { setAdding(true); setMessage(""); }}><UserPlus size={15} />{translate("添加成员")}</button>}</div>
      {!administrators && <div className="management-filter-row">{([{ value: "members", label: translate("成员") }, { value: "restricted", label: translate("受限成员") }, { value: "banned", label: translate("已封禁") }, { value: "bots", label: translate("机器人") }] as const).filter(item => item.value !== "restricted" || c.chatType === "supergroup").map(item => <button key={item.value} type="button" aria-pressed={filter === item.value} className={filter === item.value ? "is-active" : ""} onClick={() => setFilter(item.value)}>{item.label}</button>)}</div>}
      <label className="management-search"><Search size={16} /><input aria-label={translate("搜索成员")} placeholder={translate("搜索成员")} value={query} maxLength={128} onChange={event => setQuery(event.target.value)} /></label>
      <div className="management-people">{page?.members.map(member => <button className="management-person-row" type="button" key={member.user.id} onClick={() => startEdit(member)}><Avatar avatar={member.user.avatar} size="small" /><span><strong>{member.user.displayName}{member.user.id === currentUserId ? translate("（我）") : ""}</strong><small>{member.customTitle || (member.user.username ? `@${member.user.username}` : managedRoleLabel(member))}</small></span><span className={`management-role role-${member.status}`}>{managedRoleLabel(member)}</span></button>)}</div>
      {loading && <p className="management-empty" role="status"><LoaderCircle className="spin" size={18} />{translate("正在加载")}</p>}
      {failed && <p className="management-empty" role="alert">{translate("读取失败，请重试")}<button type="button" className="dialog-secondary" onClick={() => setRevision(value => value + 1)}>{translate("重试")}</button></p>}
      {!loading && !failed && page?.members.length === 0 && <p className="management-empty">{translate("没有符合条件的成员")}</p>}
      {page?.hasMore && <button className="dialog-secondary" type="button" disabled={loading} onClick={() => void loadMore()}>{translate("加载更多成员")}</button>}
      {message && <p role="status" className="management-hint">{message}</p>}
    </section>}
    {confirmation && <ConfirmActionDialog title={confirmation.title} description={confirmation.description} confirmLabel={translate("确认")} onConfirm={confirmation.run} error={translate("操作失败，请重试")} onClose={() => setConfirmation(undefined)} />}
  </>;
}
