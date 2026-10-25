import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import { translate } from "../i18n";
import type { Message } from "../telegram/types";
import { messageSelectionDeleteScopes } from "../utils/messageSelection";
import { DeleteMessagesDialog } from "./ConversationOverlays";
import { MotionPresence } from "./MotionPresence";

interface Props {
  messages: Message[];
  permissionsLoading: boolean;
  onRetryPermissions: () => void;
  onDelete: (chatId: string, messageIds: string[], revoke: boolean) => Promise<boolean>;
}

export function MessageSelectionDeleteAction({ messages, permissionsLoading, onRetryPermissions, onDelete }: Props) {
  const [requestedIds, setRequestedIds] = useState<Set<string>>();
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selected = requestedIds ? messages.filter(message => requestedIds.has(message.id)) : messages;
  const scopes = messageSelectionDeleteScopes(selected);
  const available = scopes.self.length > 0 || scopes.all.length > 0;
  const permissionsReady = selected.every(message => message.isLocallyDeleted || Boolean(message.permissions));
  useEffect(() => {
    if (requestedIds && !pending && !available) setRequestedIds(undefined);
  }, [available, pending, requestedIds]);
  const confirm = async (revoke: boolean) => {
    const targets = revoke ? scopes.all : scopes.self;
    if (pending || !targets.length) return;
    setPending(true);
    try {
      const succeeded = await onDelete(targets[0].chatId, targets.map(message => message.id), revoke);
      if (mounted.current && succeeded) setRequestedIds(undefined);
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  return <>
    {!permissionsReady && !permissionsLoading && messages.length > 0 && <button
      className="icon-button"
      type="button"
      aria-label={translate("重试")}
      title={translate("无法读取操作权限")}
      onClick={onRetryPermissions}
    ><RotateCcw size={18} /></button>}
    <button
      className="icon-button is-danger"
      type="button"
      aria-label={translate("删除已选消息")}
      title={permissionsLoading ? translate("正在读取操作权限") : messages.length > 0 && permissionsReady && !available ? translate("所选消息没有删除权限") : translate("删除已选消息")}
      disabled={!available || !permissionsReady || pending}
      onClick={() => setRequestedIds(new Set(messages.map(message => message.id)))}
    >
      {permissionsLoading ? <LoaderCircle className="spin" size={18} /> : <Trash2 size={18} strokeWidth={1.9} />}
    </button>
    <MotionPresence present={Boolean(requestedIds && available)}>
      {requestedIds && available ? <DeleteMessagesDialog
        batch
        count={selected.length}
        selfCount={scopes.self.length}
        allCount={scopes.all.length}
        canDeleteOnlyForSelf={scopes.self.length > 0}
        canDeleteForAllUsers={scopes.all.length > 0}
        pending={pending}
        onConfirm={revoke => void confirm(revoke)}
        onClose={() => { if (!pending) setRequestedIds(undefined); }}
      /> : null}
    </MotionPresence>
  </>;
}
