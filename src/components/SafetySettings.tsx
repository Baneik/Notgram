import { currentLanguage, translate } from "../i18n";
import { Ban, Check, EyeOff, LoaderCircle, LogOut, MonitorSmartphone, ShieldAlert, UserRoundX } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocalUserBlocks } from "../store/localUserBlocks";
import { useTelegramStore } from "../store/telegramStore";
import { useStableVisibility } from "../hooks/useStableVisibility";
import type { DeviceSession, PrivacyRule, PrivacySettingKey } from "../telegram/types";
import { Avatar } from "./Avatar";

export function SafetySettings() {
  const activeAccountId = useTelegramStore((state) => state.activeAccountId);
  const localBlockedUsers = useLocalUserBlocks((state) => state.users)
    .filter((user) => user.accountId === activeAccountId);
  const unblockLocalUser = useLocalUserBlocks((state) => state.unblockUser);
  const blockedSenders = useTelegramStore((state) => state.blockedSenders);
  const loading = useTelegramStore((state) => state.blockedSendersLoading);
  const showLoading = useStableVisibility(loading);
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
    { key: "showStatus", label: translate("最后上线与在线状态") }, { key: "showPhoneNumber", label: translate("手机号码") }, { key: "showProfilePhoto", label: translate("头像") }, { key: "allowCalls", label: translate("来电") }, { key: "allowChatInvites", label: translate("新聊天邀请") }, { key: "allowSecretChats", label: translate("秘密聊天") },
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
      else setPrivacyError(translate("隐私设置未保存"));
    } catch (error) {
      setPrivacyError(error instanceof Error ? error.message : translate("隐私设置未保存"));
    } finally {
      setPrivacyPending(undefined);
    }
  };
  return (
    <div className="settings-group safety-settings">
      <section className="settings-section" aria-labelledby="local-blocked-users-heading">
        <div className="settings-section-heading">
          <EyeOff size={18} />
          <div>
            <h4 id="local-blocked-users-heading">{translate("屏蔽管理")}</h4>
            <span>{translate("在所有群聊中用动物身份遮罩这些用户")}</span>
          </div>
        </div>
        <div className="blocked-sender-list local-blocked-user-list">
          {localBlockedUsers.length === 0 ? (
            <p className="settings-empty">{translate("暂无屏蔽用户")}</p>
          ) : localBlockedUsers.map((user) => (
            <div className="blocked-sender-row" key={`${user.accountId}:${user.userId}`}>
              <Avatar avatar={user.realAvatar} size="small" />
              <span>
                <strong>{user.realName}</strong>
                <small>{translate("群聊中显示为 {{value0}} {{value1}}", { value0: user.alias, value1: user.aliasAvatar.label })}</small>
              </span>
              <button
                className="dialog-secondary"
                type="button"
                onClick={() => unblockLocalUser(activeAccountId, user.userId)}
              >
                <UserRoundX size={14} />{translate("解除屏蔽")}</button>
            </div>
          ))}
        </div>
      </section>
      <section className="settings-section" aria-labelledby="blocked-senders-heading">
        <div className="settings-section-heading">
          <Ban size={18} />
          <div>
            <h4 id="blocked-senders-heading">{translate("Telegram 黑名单")}</h4>
            <span>{translate("屏蔽对象不会再出现在消息通知中")}</span>
          </div>
        </div>
        <div className="blocked-sender-list" aria-busy={loading}>
          {showLoading ? (
            <div className="settings-loading"><LoaderCircle className="spin" size={18} /></div>
          ) : blockedSenders.length === 0 ? (
            <p className="settings-empty">{translate("暂无屏蔽对象")}</p>
          ) : blockedSenders.map((sender) => (
            <div className="blocked-sender-row" key={`${sender.kind}:${sender.id}`}>
              <Avatar avatar={sender.avatar} size="small" />
              <span>
                <strong>{sender.title}</strong>
                <small>{sender.kind === "user" ? translate("用户") : translate("频道")}</small>
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
                  : <UserRoundX size={14} />}{translate("解除屏蔽")}</button>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="sessions-heading">
        <div className="settings-section-heading">
          <MonitorSmartphone size={18} />
          <div>
            <h4 id="sessions-heading">{translate("设备会话")}</h4>
            <span>{translate("可以随时终止陌生设备")}</span>
          </div>
        </div>
        <div className="session-list">
          {sessions.map((session) => (
            <div className="session-row" key={session.id}>
              <div>
                <strong>{session.applicationName} · {session.deviceModel}</strong>
                <small>
                  {session.platform} {session.systemVersion} · {translate("{{value0}} · 最近活动 {{value1}}", {
                    value0: session.location || session.ipAddress || translate("未知位置"),
                    value1: new Date(session.lastActiveAt).toLocaleString(currentLanguage()),
                  })}
                </small>
              </div>
              {session.isCurrent ? (
                <span className="session-current">{translate("当前设备")}</span>
              ) : (
                <button
                  className="dialog-secondary"
                  type="button"
                  onClick={async () => {
                    if (await terminateSession(session.id)) await refreshSessions();
                  }}
                >
                  <LogOut size={14} />{translate("终止")}</button>
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
        >{translate("终止其他所有会话")}</button>
      </section>

      <section className="settings-section" aria-labelledby="privacy-rules-heading">
        <div className="settings-section-heading">
          <ShieldAlert size={18} />
          <div>
            <h4 id="privacy-rules-heading">{translate("Telegram 隐私规则")}</h4>
            <span>{translate("设置状态、手机号、头像、来电和新聊天默认范围")}</span>
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
                  <option value="allowAll">{translate("所有人")}</option>
                  <option value="allowContacts">{translate("我的联系人")}</option>
                  <option value="restrictAll">{translate("没人")}</option>
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
            <h4>{translate("举报与群组退出")}</h4>
            <span>{translate("举报时可以选择在成功后退出群组")}</span>
          </div>
        </div>
        <p className="settings-help">{translate("举报会包含你选择的消息、原因和补充说明；退出群组只会在举报成功后执行。")}</p>
      </section>
    </div>
  );
}
