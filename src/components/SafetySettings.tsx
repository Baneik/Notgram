import { Ban, Check, LoaderCircle, LogOut, MonitorSmartphone, ShieldAlert, UserRoundX } from "lucide-react";
import { useEffect, useState } from "react";
import { useTelegramStore } from "../store/telegramStore";
import type { ChatReportOptions, DeviceSession, PrivacyRule, PrivacySettingKey, ReportChatInput } from "../telegram/types";
import { Avatar } from "./Avatar";

interface ReportDialogProps {
  chatId: string;
  messageIds: string[];
  title: string;
  onGetOptions: (chatId: string, messageIds: string[]) => Promise<ChatReportOptions | undefined>;
  onSubmit: (input: ReportChatInput) => Promise<boolean>;
  onDeleteChat?: () => Promise<boolean>;
  onClose: () => void;
}

export const reportReasonLabel = (title: string) => {
  const normalized = title.trim().toLowerCase();
  if (/spam|scam|垃圾|诈骗/.test(normalized)) return "垃圾信息或诈骗";
  if (/violence|danger|physical harm|暴力|危险/.test(normalized)) return "暴力或危险内容";
  if (/porn|sexual|adult content|色情|成人内容/.test(normalized)) return "色情或成人内容";
  if (/child|minor|儿童|未成年/.test(normalized)) return "儿童伤害";
  if (/copyright|intellectual property|trademark|counterfeit|版权|商标|假冒商品/.test(normalized)) return "侵犯知识产权";
  if (/unrelated location|location-based|wrong location|位置无关|地点无关/.test(normalized)) return "与标注地点无关";
  if (/\bfake\b|impersonat|pretending to be|虚假账号|冒充/.test(normalized)) return "虚假账号或冒充他人";
  if (/illegal drugs|narcotic|drug sale|毒品|违禁药物/.test(normalized)) return "毒品或违禁药物";
  if (/personal details|private (?:data|information)|dox|个人信息|隐私信息/.test(normalized)) return "泄露个人信息";
  if (/hate speech|仇恨言论/.test(normalized)) return "仇恨言论";
  if (/terror|极端主义|恐怖主义/.test(normalized)) return "恐怖主义或极端主义";
  if (/harass|bully|骚扰|霸凌/.test(normalized)) return "骚扰或霸凌";
  if (/self[- ]?harm|suicide|自残|自杀/.test(normalized)) return "自残或自杀内容";
  if (/^other$|^custom$|^something else$|^don't like$|其他|不喜欢/.test(normalized)) return "其他原因";
  if (/[\u3400-\u9fff]/u.test(title)) return title;
  return title.trim() || "其他原因";
};

export function ReportDialog({ chatId, messageIds, title, onGetOptions, onSubmit, onDeleteChat, onClose }: ReportDialogProps) {
  const [options, setOptions] = useState<ChatReportOptions>();
  const [optionId, setOptionId] = useState("");
  const [text, setText] = useState("");
  const [deleteChat, setDeleteChat] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { let active = true; void onGetOptions(chatId, messageIds).then((value) => { if (active) { setOptions(value); setOptionId(value?.options[0]?.id ?? ""); } }); return () => { active = false; }; }, [chatId, messageIds, onGetOptions]);
  const displayOptions = options?.options.filter((option, index, all) => {
    const label = reportReasonLabel(option.title);
    return all.findIndex((candidate) => reportReasonLabel(candidate.title) === label) === index;
  });
  const selected = options?.options.find((option) => option.id === optionId);
  const submit = async () => {
    if (!optionId) return;
    setPending(true); setError(undefined);
    const reported = await onSubmit({ chatId, messageIds, optionId, text: text.trim() || undefined });
    if (reported) { if (deleteChat && onDeleteChat) await onDeleteChat(); onClose(); }
    else setError("举报未提交，请检查说明后重试");
    setPending(false);
  };
  return <div className="profile-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="report-dialog" role="dialog" aria-modal="true" aria-labelledby="report-dialog-title"><header><div><h2 id="report-dialog-title">举报“{title}”</h2><small>{messageIds.length > 1 ? `已选择 ${messageIds.length} 条消息` : "举报会发送给 Telegram 审核"}</small></div><button className="icon-button" type="button" aria-label="关闭举报" onClick={onClose}>×</button></header>{!options ? <div className="profile-state"><LoaderCircle className="spin" size={22} /></div> : <div className="report-dialog-body"><div><span>举报原因</span><div className="report-reason-options" role="radiogroup" aria-label="举报原因">{displayOptions?.map((option) => <button className={option.id === optionId ? "is-selected" : ""} key={option.id} type="button" role="radio" aria-checked={option.id === optionId} onClick={() => setOptionId(option.id)}>{reportReasonLabel(option.title)}</button>)}</div></div>{selected?.requiresText && <label><span>补充说明</span><textarea aria-label="举报说明" value={text} onChange={(event) => setText(event.target.value)} maxLength={1000} rows={4} placeholder="请描述具体问题" /> </label>}{onDeleteChat && <label className="management-check"><input type="checkbox" checked={deleteChat} onChange={(event) => setDeleteChat(event.target.checked)} /><span>同时删除这个会话</span></label>}{error && <div className="profile-state is-error" role="alert">{error}</div>}<footer><button className="dialog-secondary" type="button" onClick={onClose}>取消</button><button className="dialog-danger" type="button" disabled={pending || !optionId || Boolean(selected?.requiresText && !text.trim())} onClick={() => void submit()}>{pending ? <LoaderCircle className="spin" size={15} /> : <ShieldAlert size={15} />}提交举报</button></footer></div>}</section></div>;
}

export function SafetySettings() {
  const blockedSenders = useTelegramStore((state) => state.blockedSenders);
  const loading = useTelegramStore((state) => state.blockedSendersLoading);
  const load = useTelegramStore((state) => state.loadBlockedSenders);
  const setBlocked = useTelegramStore((state) => state.setMessageSenderBlocked);
  const [pending, setPending] = useState<string>();
  const [privacyPending, setPrivacyPending] = useState<PrivacySettingKey>();
  const [privacyError, setPrivacyError] = useState<string>();
  const getSessions = useTelegramStore((state) => state.getActiveSessions);
  const terminateSession = useTelegramStore((state) => state.terminateSession);
  const terminateAllOtherSessions = useTelegramStore((state) => state.terminateAllOtherSessions);
  const getPrivacyRules = useTelegramStore((state) => state.getPrivacySettingRules);
  const setPrivacyRules = useTelegramStore((state) => state.setPrivacySettingRules);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [privacyRules, setPrivacyRulesState] = useState<Partial<Record<PrivacySettingKey, PrivacyRule[]>>>({});
  const privacySettings: Array<{ key: PrivacySettingKey; label: string }> = [
    { key: "showStatus", label: "最后上线与在线状态" }, { key: "showPhoneNumber", label: "手机号码" }, { key: "showProfilePhoto", label: "头像" }, { key: "allowCalls", label: "来电" }, { key: "allowChatInvites", label: "新聊天邀请" }, { key: "allowSecretChats", label: "秘密聊天" },
  ];
  useEffect(() => {
    void load();
    void getSessions().then(setSessions);
    void Promise.all(privacySettings.map(async ({ key }) => [key, await getPrivacyRules(key)] as const)).then((entries) => setPrivacyRulesState(Object.fromEntries(entries)));
  }, [getPrivacyRules, getSessions, load]);
  const refreshSessions = async () => setSessions(await getSessions());
  const updatePrivacy = async (key: PrivacySettingKey, value: PrivacyRule["kind"]) => {
    if (privacyPending) return;
    const rules = [{ kind: value } satisfies PrivacyRule];
    setPrivacyPending(key);
    setPrivacyError(undefined);
    try {
      if (await setPrivacyRules(key, rules)) setPrivacyRulesState((current) => ({ ...current, [key]: rules }));
      else setPrivacyError("隐私设置未保存");
    } catch (error) {
      setPrivacyError(error instanceof Error ? error.message : "隐私设置未保存");
    } finally {
      setPrivacyPending(undefined);
    }
  };
  return (
    <div className="settings-group safety-settings">
      <section className="settings-section" aria-labelledby="blocked-senders-heading">
        <div className="settings-section-heading">
          <Ban size={18} />
          <div>
            <h4 id="blocked-senders-heading">黑名单</h4>
            <span>屏蔽对象不会再出现在消息通知中</span>
          </div>
        </div>
        <div className="blocked-sender-list" aria-busy={loading}>
          {loading ? (
            <div className="settings-loading"><LoaderCircle className="spin" size={18} /></div>
          ) : blockedSenders.length === 0 ? (
            <p className="settings-empty">暂无屏蔽对象</p>
          ) : blockedSenders.map((sender) => (
            <div className="blocked-sender-row" key={`${sender.kind}:${sender.id}`}>
              <Avatar avatar={sender.avatar} size="small" />
              <span>
                <strong>{sender.title}</strong>
                <small>{sender.kind === "user" ? "用户" : "频道"}</small>
              </span>
              <button
                className="dialog-secondary"
                type="button"
                disabled={pending === sender.id}
                onClick={async () => {
                  setPending(sender.id);
                  await setBlocked(sender.id, sender.kind, false);
                  setPending(undefined);
                }}
              >
                {pending === sender.id
                  ? <LoaderCircle className="spin" size={14} />
                  : <UserRoundX size={14} />}
                解除屏蔽
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="sessions-heading">
        <div className="settings-section-heading">
          <MonitorSmartphone size={18} />
          <div>
            <h4 id="sessions-heading">设备会话</h4>
            <span>可以随时终止陌生设备</span>
          </div>
        </div>
        <div className="session-list">
          {sessions.map((session) => (
            <div className="session-row" key={session.id}>
              <div>
                <strong>{session.applicationName} · {session.deviceModel}</strong>
                <small>
                  {session.platform} {session.systemVersion} · {session.location || session.ipAddress || "未知位置"} · 最近活动 {new Date(session.lastActiveAt).toLocaleString("zh-CN")}
                </small>
              </div>
              {session.isCurrent ? (
                <span className="session-current">当前设备</span>
              ) : (
                <button
                  className="dialog-secondary"
                  type="button"
                  onClick={async () => {
                    if (await terminateSession(session.id)) await refreshSessions();
                  }}
                >
                  <LogOut size={14} />
                  终止
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          className="dialog-danger"
          type="button"
          disabled={sessions.filter((session) => !session.isCurrent).length === 0}
          onClick={async () => {
            if (await terminateAllOtherSessions()) await refreshSessions();
          }}
        >
          终止其他所有会话
        </button>
      </section>

      <section className="settings-section" aria-labelledby="privacy-rules-heading">
        <div className="settings-section-heading">
          <ShieldAlert size={18} />
          <div>
            <h4 id="privacy-rules-heading">Telegram 隐私规则</h4>
            <span>设置状态、手机号、头像、来电和新聊天默认范围</span>
          </div>
        </div>
        <div className="privacy-rule-list">
          {privacySettings.map(({ key, label }) => {
            const selected = privacyRules[key]?.[0]?.kind ?? "allowContacts";
            return (
              <label className="privacy-rule-row" key={key}>
                <span>{label}</span>
                <select
                  aria-label={label}
                  disabled={privacyPending !== undefined}
                  value={selected}
                  onChange={(event) => void updatePrivacy(
                    key,
                    event.target.value as PrivacyRule["kind"],
                  )}
                >
                  <option value="allowAll">所有人</option>
                  <option value="allowContacts">我的联系人</option>
                  <option value="restrictAll">没人</option>
                </select>
              </label>
            );
          })}
        </div>
        {privacyError && <p className="settings-error" role="alert">{privacyError}</p>}
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <Check size={18} />
          <div>
            <h4>举报与恢复</h4>
            <span>举报后仍可在聊天资料中恢复屏蔽或重新加入会话</span>
          </div>
        </div>
        <p className="settings-help">举报会包含你选择的消息范围和原因；提交前可选择同时删除会话。</p>
      </section>
    </div>
  );
}
