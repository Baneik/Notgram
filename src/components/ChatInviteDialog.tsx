import { Check, LoaderCircle, LockKeyhole, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { translate } from "../i18n";
import { useModalFocus } from "../hooks/useModalFocus";
import { telegramStore, useTelegramStore } from "../store/telegramStore";
import { chatJoinKey } from "../telegram/chatJoin";
import { connectionPresentation } from "../telegram/connectionState";
import type { ChatInvitePreview } from "../telegram/types";
import { Avatar } from "./Avatar";

export function ChatInviteDialog({ preview, accountId, onOpenChat, onClose }: {
  preview: ChatInvitePreview;
  accountId: string;
  onOpenChat: (chatId: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [joinedChatId, setJoinedChatId] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const targetChatId = joinedChatId ?? preview.chatId;
  const activeAccountId = useTelegramStore(state => state.activeAccountId);
  const status = useTelegramStore(state => state.chatJoinStates.get(chatJoinKey({ inviteLink: preview.inviteLink })));
  const chat = useTelegramStore(state => targetChatId ? state.chats.get(targetChatId) : undefined);
  const online = useTelegramStore(state => connectionPresentation(state.connectionStatus).operational);
  const join = useTelegramStore(state => state.joinChat);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  const pending = status === "joining" || refreshing;
  const requested = status === "requested";
  const joined = chat?.isMember === true;
  const close = () => { alive.current = false; onClose(); };
  const dialogRef = useModalFocus<HTMLElement>(close);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (activeAccountId !== accountId) onClose();
  }, [activeAccountId, accountId, onClose]);

  const submit = async () => {
    if (pending || requested || status === "joined" || preview.requiresSubscription) return;
    setError(undefined);
    const result = await join({ inviteLink: preview.inviteLink });
    if (!alive.current || telegramStore.getState().activeAccountId !== accountId) return;
    if (result?.kind === "joined") {
      if (telegramStore.getState().chats.get(result.chatId)?.isMember === true) { close(); onOpenChat(result.chatId); }
      else setJoinedChatId(result.chatId);
    }
    else if (!result) setError(telegramStore.getState().operationError);
  };
  const openJoinedChat = async () => {
    if (!targetChatId || pending) return;
    if (joined) { close(); onOpenChat(targetChatId); return; }
    setRefreshing(true);
    await telegramStore.getState().refreshChatMembership(targetChatId);
    if (!alive.current || telegramStore.getState().activeAccountId !== accountId) return;
    setRefreshing(false);
    if (telegramStore.getState().chats.get(targetChatId)?.isMember === true) { close(); onOpenChat(targetChatId); }
    else setError(telegramStore.getState().operationError ?? translate("无法读取会话状态"));
  };
  if (activeAccountId !== accountId) return null;
  return (
    <div className="message-delete-backdrop" role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialogRef} className="message-delete-dialog chat-invite-dialog" role="dialog"
        aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-info`} tabIndex={-1}>
        <button className="icon-button chat-invite-close" type="button" aria-label={translate("关闭")} onClick={close}><X size={19} /></button>
        <Avatar avatar={preview.avatar} size="large" />
        <h3 id={`${id}-title`}>{preview.title}</h3>
        <p className="chat-invite-count">{preview.kind === "channel"
          ? translate("{{value0}} 位订阅者", { value0: preview.memberCount })
          : translate("{{value0}} 位成员", { value0: preview.memberCount })}</p>
        {preview.description && <p className="chat-invite-description">{preview.description}</p>}
        <p id={`${id}-info`} className="chat-invite-info">
          {preview.requiresSubscription ? translate("此邀请需要付费订阅，Notgram 暂不支持通过此链接加入")
            : joined || status === "joined" ? translate("你已加入此会话")
              : preview.createsJoinRequest ? <><LockKeyhole size={15} />{translate("管理员批准后即可进入会话")}</>
                : translate("加入后即可在聊天列表中查看此会话")}
        </p>
        {error && <p className="settings-error" role="alert">{error}</p>}
        <button className="dialog-primary chat-invite-submit" type="button"
          disabled={!online || pending || (!joined && (requested || preview.requiresSubscription))}
          onClick={() => joined || status === "joined" ? void openJoinedChat() : void submit()}>
          {pending ? <LoaderCircle className="spin" size={17} /> : requested ? <Check size={17} /> : null}
          <span>{joined ? translate("打开会话") : status === "joined" ? translate("刷新会话状态") : requested ? translate("已申请，等待管理员批准")
            : pending ? translate("正在加入") : preview.createsJoinRequest ? translate("申请加入")
              : preview.kind === "channel" ? translate("加入频道") : translate("加入群组")}</span>
        </button>
      </section>
    </div>
  );
}
