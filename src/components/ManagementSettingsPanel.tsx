import { useEffect, useRef, useState } from "react";
import { Check, ImagePlus, LoaderCircle, Save, Trash2 } from "lucide-react";
import { translate } from "../i18n";
import { CHAT_PERMISSION_LABELS, DEFAULT_CHAT_PERMISSIONS } from "../telegram/chatManagement";
import type { Chat, ChatManagement, ChatPermissions, UpdateChatManagementInput } from "../telegram/types";
import { Avatar } from "./Avatar";
import { ConfirmActionDialog } from "./ConfirmActionDialog";

interface Props {
  chat: Chat;
  management: ChatManagement;
  linkedChats: Chat[];
  section: "info" | "permissions";
  onUpdate: (input: UpdateChatManagementInput) => Promise<boolean>;
  onPermissions: (value: ChatPermissions) => Promise<boolean>;
  onSlowMode: (seconds: number) => Promise<boolean>;
  onAutoDelete: (seconds: number) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}
export function ManagementSettingsPanel({ chat, management, linkedChats, section, onUpdate, onPermissions, onSlowMode, onAutoDelete, onDirtyChange, onBusyChange }: Props) {
  const c = management.capabilities;
  const original = management.settings;
  const owner = c.status === "owner";
  const supergroup = c.chatType === "supergroup";
  const channel = c.chatType === "channel";
  const [title, setTitle] = useState(chat.title);
  const [description, setDescription] = useState(original?.description ?? "");
  const [username, setUsername] = useState(original?.username ?? "");
  const [linkedChatId, setLinkedChatId] = useState(original?.linkedChatId ?? "");
  const [draft, setDraft] = useState<UpdateChatManagementInput>({});
  const [permissions, setPermissions] = useState(management.permissions);
  const [slowMode, setSlowMode] = useState(management.slowModeDelay);
  const [autoDelete, setAutoDelete] = useState(chat.messageAutoDeleteTime ?? 0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; run: () => Promise<boolean> }>();
  const gate = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const permissionsDirty = JSON.stringify(permissions) !== JSON.stringify(management.permissions);
  const infoDirty = title !== chat.title || description !== (original?.description ?? "") || username !== (original?.username ?? "") || linkedChatId !== (original?.linkedChatId ?? "");
  const behaviorDirty = Object.keys(draft).length > 0 || slowMode !== management.slowModeDelay || autoDelete !== (chat.messageAutoDeleteTime ?? 0);
  const dirty = section === "info" ? infoDirty : permissionsDirty || behaviorDirty;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  const run = async (action: () => Promise<boolean>) => {
    if (gate.current) return false;
    gate.current = true; setBusy(true); setNotice("");
    try { const ok = await action(); if (alive.current) setNotice(ok ? translate("已保存") : translate("操作失败，请重试")); return ok; }
    catch { if (alive.current) setNotice(translate("操作失败，请重试")); return false; }
    finally { gate.current = false; if (alive.current) setBusy(false); }
  };
  const saveInfo = () => run(async () => {
    const input: UpdateChatManagementInput = {};
    if (title !== chat.title) input.title = title.trim();
    if (description !== (original?.description ?? "")) input.description = description;
    if (username !== (original?.username ?? "")) input.username = username.trim();
    if (linkedChatId !== (original?.linkedChatId ?? "")) input.linkedChatId = linkedChatId;
    return onUpdate(input);
  });
  const saveBehavior = () => run(async () => {
    if (Object.keys(draft).length) {
      if (!await onUpdate(draft)) return false;
      if (alive.current) setDraft({});
    }
    if (slowMode !== management.slowModeDelay && !await onSlowMode(slowMode)) return false;
    if (autoDelete !== (chat.messageAutoDeleteTime ?? 0) && !await onAutoDelete(autoDelete)) return false;
    return true;
  });
  const setOption = (key: keyof UpdateChatManagementInput, value: boolean) => {
    setDraft(current => { const next = { ...current, [key]: value }; if (value === original?.[key as keyof NonNullable<typeof original>]) delete next[key]; return next; });
  };
  const options = [
    { key: "historyAvailable", label: translate("新成员历史消息"), help: translate("允许新成员查看加入之前的消息。"), show: supergroup && c.canChangeInfo, disabled: Boolean(original?.linkedChatId || original?.username || original?.isForum) },
    { key: "joinByRequest", label: translate("加入审批"), help: translate("直接加入的用户需经管理员批准；邀请链接单独设置。"), show: supergroup && c.canRestrictMembers },
    { key: "hiddenMembers", label: translate("隐藏成员列表"), help: translate("普通成员仅能查看管理员和机器人。"), show: supergroup && c.canRestrictMembers && original?.canHideMembers },
    { key: "aggressiveAntiSpam", label: translate("严格反垃圾"), help: translate("使用 Telegram 的自动反垃圾检查。"), show: supergroup && c.canRestrictMembers && original?.canToggleAntiSpam },
    { key: "signMessages", label: translate("频道签名"), help: translate("在频道消息中显示发布者签名。"), show: channel && c.canChangeInfo },
    { key: "showMessageSender", label: translate("显示发布者资料"), help: translate("频道消息可链接到发布者账号。"), show: channel && c.canChangeInfo },
    { key: "protectedContent", label: translate("保护内容"), help: translate("限制转发与保存聊天中的内容。"), show: owner },
    { key: "isForum", label: translate("话题模式"), help: translate("按话题组织群组消息；关闭后已有话题保留在 Telegram。"), show: owner && supergroup && !original?.linkedChatId },
  ] as const;
  const saveOptions = () => {
    if (draft.isForum !== undefined) setConfirmation({ title: translate("更改话题模式"), description: translate("此更改会影响所有成员的会话结构。"), run: saveBehavior });
    else void saveBehavior();
  };
  const saveButton = (label: string, disabled: boolean, action: () => void) => <button className="dialog-primary" type="button" disabled={busy || disabled} onClick={action}>{busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{label}</button>;
  const usernameValid = !username.trim() || /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username.trim());
  return <>
    {section === "info" && !c.canChangeInfo && <section className="management-card"><h3>{translate("资料与访问")}</h3><p className="management-hint">{original?.description || chat.title}</p>{original?.username && <p className="management-hint">t.me/{original.username}</p>}</section>}
    {notice && <div className="management-feedback" role="status"><Check size={16} />{notice}</div>}
    {section === "info" && c.canChangeInfo && <section className="management-card"><div className="management-card-heading"><div><h3>{translate("资料与访问")}</h3><p>{translate("名称、简介和公开地址")}</p></div></div>
      <div className="management-avatar-edit"><Avatar avatar={chat.avatar} size="medium" /><div><button className="dialog-secondary" type="button" disabled={busy} onClick={() => void run(() => onUpdate({ selectPhoto: true }))}><ImagePlus size={15} />{translate("更换头像")}</button><button className="management-text-danger" type="button" disabled={busy} onClick={() => setConfirmation({ title: translate("移除头像"), description: translate("聊天将使用默认头像。"), run: () => run(() => onUpdate({ removePhoto: true })) })}><Trash2 size={14} />{translate("移除头像")}</button></div></div>
      <label className="management-field"><span>{translate("名称")}</span><input value={title} maxLength={128} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
      <label className="management-field"><span>{translate("简介")}</span><textarea rows={3} value={description} maxLength={255} disabled={busy} onChange={event => setDescription(event.target.value)} /><small>{Array.from(description).length}/255</small></label>
      {owner && c.chatType !== "basicGroup" && <label className="management-field"><span>{translate("公开用户名")}</span><div className="management-username"><span>t.me/</span><input value={username} maxLength={32} disabled={busy} aria-invalid={!usernameValid} onChange={event => setUsername(event.target.value)} /></div><small>{usernameValid ? translate("留空设为私有；公开地址需至少 5 个字符。") : translate("5-32 位，以字母开头")}</small></label>}
      {owner && channel && <label className="management-field"><span>{translate("讨论群组")}</span><select value={linkedChatId} disabled={busy} onChange={event => setLinkedChatId(event.target.value)}><option value="">{translate("未关联")}</option>{original?.linkedChatId && !linkedChats.some(value => value.id === original.linkedChatId) && <option value={original.linkedChatId}>{original.linkedChatId}</option>}{linkedChats.filter(value => value.id !== chat.id && value.management?.chatType === "supergroup" && value.management.status === "owner" && !value.isForum).map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</select><small>{translate("可关联自己拥有的非话题超级群组，用于频道评论。")}</small></label>}
      <div className="management-savebar"><span>{infoDirty ? translate("有未保存的修改") : ""}</span>{saveButton(translate("保存资料"), !infoDirty || !title.trim() || !usernameValid, () => void saveInfo())}</div>
    </section>}
    {section === "permissions" && (options.some(option => option.show) || c.canManageSlowMode || c.canChangeInfo) && <section className="management-card"><div className="management-card-heading"><div><h3>{translate("会话与安全")}</h3><p>{translate("进入方式、消息留存与会话结构")}</p></div></div><div className="management-switch-list">{options.filter(option => option.show).map(option => <label key={option.key}><span><strong>{option.label}</strong><small>{option.help}</small></span><input type="checkbox" checked={Boolean(draft[option.key] ?? original?.[option.key])} disabled={busy || ("disabled" in option && option.disabled)} onChange={event => setOption(option.key, event.target.checked)} /></label>)}</div>
      {c.canManageSlowMode && <label className="management-field"><span>{translate("慢速模式")}</span><select value={slowMode} disabled={busy} onChange={event => setSlowMode(Number(event.target.value))}>{[0, 5, 10, 30, 60, 300, 900, 3600].map(value => <option key={value} value={value}>{value === 0 ? translate("关闭") : value >= 60 ? translate("{{value0}} 分钟", { value0: value / 60 }) : translate("{{value0}} 秒", { value0: value })}</option>)}</select></label>}
      {c.canChangeInfo && <label className="management-field"><span>{translate("自动删除消息")}</span><select value={autoDelete} disabled={busy} onChange={event => setAutoDelete(Number(event.target.value))}>{autoDelete && ![86400, 604800, 2592000].includes(autoDelete) ? <option value={autoDelete}>{translate("{{value0}} 秒", { value0: autoDelete })}</option> : null}<option value={0}>{translate("关闭")}</option><option value={86400}>{translate("1 天")}</option><option value={604800}>{translate("1 周")}</option><option value={2592000}>{translate("30 天")}</option></select><small>{translate("仅对设置后发送的消息生效。")}</small></label>}
      <div className="management-savebar"><span>{behaviorDirty ? translate("有未保存的修改") : ""}</span>{saveButton(translate("保存设置"), !behaviorDirty, saveOptions)}</div></section>}
    {section === "permissions" && c.canManagePermissions && <section className="management-card"><div className="management-card-heading"><div><h3>{translate("默认成员权限")}</h3><p>{translate("适用于普通成员；个人限制在成员页编辑。")}</p></div></div>
      <div className="management-filter-row"><button className="dialog-secondary" type="button" disabled={busy} onClick={() => setPermissions({ ...DEFAULT_CHAT_PERMISSIONS })}>{translate("标准权限")}</button><button className="dialog-secondary" type="button" disabled={busy} onClick={() => setPermissions(Object.fromEntries(Object.keys(permissions).map(key => [key, false])) as ChatPermissions)}>{translate("只读模式")}</button></div>
      <div className="management-switch-list">{(Object.keys(CHAT_PERMISSION_LABELS) as (keyof ChatPermissions)[]).filter(key => key !== "canCreateTopics" || chat.isForum).map(key => <label key={key}><span>{CHAT_PERMISSION_LABELS[key]}</span><input type="checkbox" checked={permissions[key]} disabled={busy} onChange={event => setPermissions(value => ({ ...value, [key]: event.target.checked }))} /></label>)}</div>
      <div className="management-savebar"><span>{permissionsDirty ? translate("有未保存的修改") : ""}</span>{saveButton(translate("保存默认权限"), !permissionsDirty, () => void run(() => onPermissions(permissions)))}</div></section>}
    {confirmation && <ConfirmActionDialog title={confirmation.title} description={confirmation.description} confirmLabel={translate("确认")} onConfirm={confirmation.run} error={translate("操作失败，请重试")} onClose={() => setConfirmation(undefined)} />}
  </>;
}
