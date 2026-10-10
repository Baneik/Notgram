import { useEffect, useRef, useState } from "react";
import { Check, Copy, Link, LoaderCircle, Plus } from "lucide-react";
import { translate, currentLanguage } from "../i18n";
import type { ChatInviteCreator, ChatInviteLink, ChatInviteLinkPage, ChatJoinRequestPage, CreateChatInviteLinkInput } from "../telegram/types";
import { Avatar } from "./Avatar";
import { ConfirmActionDialog } from "./ConfirmActionDialog";

interface Bucket extends ChatJoinRequestPage { inviteLink?: string }
export interface ManagementInvitesProps {
  channel: boolean;
  allInvites: boolean;
  onGetInviteLinks: (offsetDate?: number, offsetLink?: string, creatorUserId?: string) => Promise<ChatInviteLinkPage | undefined>;
  onGetInviteCreators: () => Promise<ChatInviteCreator[] | undefined>;
  onSaveInviteLink: (input: Omit<CreateChatInviteLinkInput, "chatId">, inviteLink?: string) => Promise<ChatInviteLink | undefined>;
  onRevokeInviteLink: (link: string) => Promise<boolean>;
  onGetJoinRequests: (link?: string, offsetUserId?: string, offsetDate?: number) => Promise<ChatJoinRequestPage | undefined>;
  onProcessJoinRequest: (id: string, approve: boolean) => Promise<boolean>;
  onProcessJoinRequests: (link: string | undefined, approve: boolean) => Promise<boolean>;
  onDirtyChange: (value: boolean) => void;
  onBusyChange: (value: boolean) => void;
}
const localDate = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export function ManagementInvitesPanel({ channel, allInvites, onGetInviteLinks, onGetInviteCreators, onSaveInviteLink, onRevokeInviteLink, onGetJoinRequests, onProcessJoinRequest, onProcessJoinRequests, onDirtyChange, onBusyChange }: ManagementInvitesProps) {
  const [page, setPage] = useState<ChatInviteLinkPage>();
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [requestsFailed, setRequestsFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<ChatInviteLink | "new">();
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [limit, setLimit] = useState(0);
  const [approval, setApproval] = useState(false);
  const [stars, setStars] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [scope, setScope] = useState("");
  const [creators, setCreators] = useState<ChatInviteCreator[]>([]);
  const [creatorId, setCreatorId] = useState("");
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; run: () => Promise<boolean> }>();
  const gate = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => { let cancelled = false; if (allInvites) void onGetInviteCreators().then(value => { if (!cancelled && value) setCreators(value); }); return () => { cancelled = true; }; }, [allInvites, onGetInviteCreators]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setFailed(false); setRequestsFailed(false); setBuckets([]);
    void (async () => {
      try {
        const links = await onGetInviteLinks(undefined, undefined, creatorId || undefined);
        if (cancelled) return;
        if (!links) { setFailed(true); return; }
        setPage(links);
        const targets = allInvites ? [scope || undefined] : links.links.map(link => link.inviteLink);
        const results = await Promise.all(targets.map(async inviteLink => { const value = await onGetJoinRequests(inviteLink); return value ? { ...value, inviteLink } : undefined; }));
        if (!cancelled) { setBuckets(results.flatMap(value => value ? [value] : [])); setRequestsFailed(results.some(value => !value)); }
      } catch { if (!cancelled) setFailed(true); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [allInvites, onGetInviteLinks, onGetJoinRequests, revision, scope, creatorId]);
  const run = async (action: () => Promise<boolean>) => {
    if (gate.current) return false;
    gate.current = true; setBusy(true); setNotice("");
    try { const ok = await action(); if (alive.current) setNotice(ok ? translate("已完成") : translate("操作失败，请重试")); return ok; }
    catch { if (alive.current) setNotice(translate("操作失败，请重试")); return false; }
    finally { gate.current = false; if (alive.current) setBusy(false); }
  };
  const edit = (link: ChatInviteLink | "new") => {
    if (dirty) return;
    setEditor(link); setName(link === "new" ? "" : link.name); setExpiry(link === "new" ? "" : localDate(link.expiresAt));
    setLimit(link === "new" ? 0 : link.memberLimit); setApproval(link === "new" ? false : link.createsJoinRequest); setStars(link === "new" ? 0 : link.subscriptionStars ?? 0); setDirty(false);
  };
  const closeEditor = () => {
    const close = async () => { setEditor(undefined); setDirty(false); return true; };
    if (dirty) setConfirmation({ title: translate("放弃未保存的修改？"), description: translate("离开此页面后，未保存的修改将被丢弃。"), run: close });
    else void close();
  };
  const expiryValid = !expiry || Number.isFinite(new Date(expiry).getTime()) && new Date(expiry).getTime() > Date.now();
  const save = () => run(async () => {
    if (!editor || !expiryValid && !stars) return false;
    const saved = await onSaveInviteLink({ name: name.trim(), expirationDate: !stars && expiry ? Math.floor(new Date(expiry).getTime() / 1000) : undefined, memberLimit: stars || approval ? 0 : limit, createsJoinRequest: !stars && approval, subscriptionStars: stars || undefined }, editor === "new" ? undefined : editor.inviteLink);
    if (saved && alive.current) { setEditor(undefined); setCreatorId(""); setDirty(false); setRevision(value => value + 1); }
    return Boolean(saved);
  });
  const moreLinks = () => run(async () => {
    if (!page?.hasMore) return false;
    const next = await onGetInviteLinks(page.nextOffsetDate, page.nextOffsetLink, creatorId || undefined);
    if (!next || !alive.current) return false;
    setPage({ ...next, links: [...page.links, ...next.links.filter(link => !page.links.some(old => old.inviteLink === link.inviteLink))] });
    if (!allInvites) {
      const results = await Promise.all(next.links.map(async link => { const value = await onGetJoinRequests(link.inviteLink); return value ? { ...value, inviteLink: link.inviteLink } : undefined; }));
      if (alive.current) { setBuckets(current => [...current, ...results.flatMap(value => value && !current.some(old => old.inviteLink === value.inviteLink) ? [value] : [])]); setRequestsFailed(results.some(value => !value)); }
    }
    return true;
  });
  const moreRequests = () => run(async () => {
    const pending = buckets.filter(bucket => bucket.hasMore && bucket.nextOffsetUserId && (!scope || bucket.inviteLink === scope));
    const results = await Promise.all(pending.map(async bucket => { const value = await onGetJoinRequests(bucket.inviteLink, bucket.nextOffsetUserId, bucket.nextOffsetDate); return value ? { ...value, inviteLink: bucket.inviteLink } : undefined; }));
    if (alive.current) setBuckets(current => current.map(bucket => { const next = results.find(value => value?.inviteLink === bucket.inviteLink); return next ? { ...next, requests: [...bucket.requests, ...next.requests.filter(request => !bucket.requests.some(old => old.user.id === request.user.id))] } : bucket; }));
    return results.every(Boolean);
  });
  const process = (id: string, approve: boolean) => run(async () => {
    if (!await onProcessJoinRequest(id, approve)) return false;
    if (alive.current) setBuckets(current => current.map(bucket => ({ ...bucket, totalCount: Math.max(0, bucket.totalCount - (bucket.requests.some(request => request.user.id === id) ? 1 : 0)), requests: bucket.requests.filter(request => request.user.id !== id) })));
    return true;
  });
  const bulk = (approve: boolean) => setConfirmation({ title: approve ? translate("全部批准") : translate("全部拒绝"), description: translate("将处理当前来源下的全部申请，包括尚未加载的申请。"), run: () => run(async () => {
    const targets = allInvites ? [scope || undefined] : [...new Set(buckets.filter(bucket => !scope || bucket.inviteLink === scope).map(bucket => bucket.inviteLink))];
    const results = await Promise.all(targets.map(async inviteLink => ({ inviteLink, ok: await onProcessJoinRequests(inviteLink, approve) })));
    if (alive.current) setBuckets(current => current.map(bucket => results.some(value => value.ok && (value.inviteLink === undefined || value.inviteLink === bucket.inviteLink)) ? { ...bucket, requests: [], totalCount: 0, hasMore: false } : bucket));
    return results.every(value => value.ok);
  }) });
  const visibleBuckets = buckets.filter(bucket => !scope || bucket.inviteLink === scope);
  const requests = [...new Map(visibleBuckets.flatMap(bucket => bucket.requests).filter(request => !scope || request.inviteLink === scope).map(request => [request.user.id, request])).values()];
  const count = allInvites ? buckets[0]?.totalCount : visibleBuckets.reduce((sum, bucket) => sum + bucket.totalCount, 0);
  return <>
    {notice && <p className="management-feedback" role="status"><Check size={16} />{notice}</p>}
    {!allInvites && <p className="management-hint">{translate("当前仅管理自己的邀请链接和对应申请。")}</p>}
    {allInvites && creators.length > 0 && <label className="management-field"><span>{translate("邀请链接创建者")}</span><select value={creatorId} disabled={busy || dirty} onChange={event => { setCreatorId(event.target.value); setScope(""); }}><option value="">{translate("我的链接")}</option>{creators.map(value => <option key={value.user.id} value={value.user.id}>{value.user.displayName} · {value.activeCount}</option>)}</select></label>}
    {editor && <section className="management-card"><h3>{editor === "new" ? translate("新建邀请链接") : translate("编辑邀请链接")}</h3><div className="management-form-grid"><label className="management-field"><span>{translate("名称")}</span><input aria-label={translate("邀请链接名称")} value={name} maxLength={32} disabled={busy} onChange={event => { setName(event.target.value); setDirty(true); }} /></label><label className="management-field"><span>{translate("有效期")}</span><input aria-label={translate("邀请链接有效期")} type="datetime-local" value={expiry} disabled={busy || stars > 0} onChange={event => { setExpiry(event.target.value); setDirty(true); }} /><small>{expiryValid ? translate("留空表示永不过期") : translate("有效期必须晚于当前时间")}</small></label><label className="management-field"><span>{translate("使用人数")}</span><input aria-label={translate("邀请链接使用人数")} type="number" min={0} max={99999} value={limit} disabled={busy || stars > 0 || approval} onChange={event => { setLimit(Math.max(0, Math.min(99999, Number(event.target.value)))); setDirty(true); }} /><small>{translate("0 表示不限制")}</small></label>{channel && <label className="management-field"><span>{translate("每月 Stars")}</span><input aria-label={translate("订阅 Stars")} type="number" min={0} max={1000000000} value={stars} disabled={busy || editor !== "new"} onChange={event => { setStars(Math.max(0, Math.min(1000000000, Number(event.target.value)))); setApproval(false); setDirty(true); }} /></label>}</div><label className="management-switch-row"><span>{translate("新成员需要管理员批准")}</span><input type="checkbox" checked={approval} disabled={busy || stars > 0} onChange={event => { setApproval(event.target.checked); setDirty(true); }} /></label><div className="management-savebar"><button className="dialog-secondary" type="button" disabled={busy} onClick={closeEditor}>{translate("取消编辑")}</button><button className="dialog-primary" type="button" disabled={busy || !expiryValid && !stars} onClick={() => void save()}>{editor === "new" ? translate("创建链接") : translate("保存链接")}</button></div></section>}
    <section className="management-card"><div className="management-card-heading"><div><h3>{translate("有效链接")}</h3><p>{translate("{{value0}} 条链接", { value0: page?.links.length ?? 0 })}</p></div><button className="dialog-primary" type="button" disabled={busy || dirty || loading} onClick={() => edit("new")}><Plus size={15} />{translate("新建邀请链接")}</button></div>
      {loading && <p className="management-empty" role="status"><LoaderCircle className="spin" size={18} />{translate("正在加载")}</p>}
      {failed && <p className="management-empty" role="alert">{translate("读取失败，请重试")}<button type="button" className="dialog-secondary" onClick={() => setRevision(value => value + 1)}>{translate("重试")}</button></p>}
      <div className="management-link-list">{page?.links.map(link => <article key={link.inviteLink}><div className="management-link-heading"><Link size={16} /><div><strong>{link.name || translate("邀请链接")}{link.isPrimary ? ` · ${translate("主链接")}` : ""}</strong><small>{link.subscriptionStars ? translate("{{value0}} Stars/月", { value0: link.subscriptionStars }) : link.createsJoinRequest ? translate("需要审批") : translate("直接加入")}{link.expiresAt ? ` · ${new Date(link.expiresAt).toLocaleString(currentLanguage())}` : ""}</small></div></div><code>{link.inviteLink}</code><div className="management-link-footer"><span>{translate("{{count}} 人加入 · {{pending}} 待审批", { count: link.memberCount, pending: link.pendingJoinRequestCount })}{link.memberLimit ? ` / ${link.memberLimit}` : ""}</span><div><button className="dialog-secondary" type="button" disabled={busy} aria-label={translate("复制 {{value0}}", { value0: link.name })} onClick={() => void run(async () => { await navigator.clipboard.writeText(link.inviteLink); return true; })}><Copy size={14} />{translate("复制链接")}</button><button className="dialog-secondary" type="button" disabled={busy || dirty} onClick={() => edit(link)}>{translate("编辑")}</button><button className="management-text-danger" type="button" disabled={busy} onClick={() => setConfirmation({ title: translate("撤销邀请链接"), description: translate("链接失效后无法继续用于加入；已加入成员不受影响。"), run: () => run(async () => { if (!await onRevokeInviteLink(link.inviteLink)) return false; if (alive.current) setRevision(value => value + 1); return true; }) })}>{translate("撤销")}</button></div></div></article>)}</div>
      {!loading && !failed && !page?.links.length && <p className="management-empty">{translate("暂无有效邀请链接")}</p>}{page?.hasMore && <button className="dialog-secondary" type="button" disabled={busy} onClick={() => void moreLinks()}>{translate("加载更多链接")}</button>}</section>
    <section className="management-card"><div className="management-card-heading"><div><h3>{translate("入群申请")}</h3><p>{translate("{{value0}} 个待处理", { value0: count ?? 0 })}</p></div>{requests.length > 0 && <div className="management-actions"><button className="dialog-primary" type="button" disabled={busy} onClick={() => bulk(true)}>{translate("全部批准")}</button><button className="management-text-danger" type="button" disabled={busy} onClick={() => bulk(false)}>{translate("全部拒绝")}</button></div>}</div>
      <label className="management-field"><span>{translate("申请来源")}</span><select value={scope} disabled={busy} onChange={event => setScope(event.target.value)}><option value="">{translate("所有已加载来源")}</option>{page?.links.map(link => <option key={link.inviteLink} value={link.inviteLink}>{link.name || link.inviteLink}</option>)}</select></label>
      {requestsFailed && <p role="alert" className="management-hint">{translate("部分申请读取失败，请重试")}<button className="dialog-secondary" type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>{translate("重试")}</button></p>}
      <div className="management-request-list">{requests.map(request => <div key={request.user.id}><Avatar avatar={request.user.avatar} size="small" /><span><strong>{request.user.displayName}</strong><small>{request.bio || new Date(request.date).toLocaleString(currentLanguage())}</small></span><div className="management-actions"><button className="dialog-primary" type="button" aria-label={translate("批准 {{value0}}", { value0: request.user.displayName })} disabled={busy} onClick={() => void process(request.user.id, true)}>{translate("批准")}</button><button className="dialog-secondary" type="button" aria-label={translate("拒绝 {{value0}}", { value0: request.user.displayName })} disabled={busy} onClick={() => void process(request.user.id, false)}>{translate("拒绝")}</button></div></div>)}</div>
      {!loading && !requestsFailed && !requests.length && <p className="management-empty">{translate("暂无待处理申请")}</p>}{visibleBuckets.some(bucket => bucket.hasMore) && <button className="dialog-secondary" type="button" disabled={busy} onClick={() => void moreRequests()}>{translate("加载更多申请")}</button>}</section>
    {confirmation && <ConfirmActionDialog title={confirmation.title} description={confirmation.description} confirmLabel={translate("确认")} onConfirm={confirmation.run} error={translate("操作失败，请重试")} onClose={() => setConfirmation(undefined)} />}
  </>;
}
