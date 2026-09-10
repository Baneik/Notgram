import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { currentLanguage, translate } from "../i18n";
import { useTelegramStore } from "../store/telegramStore";
import { messagePreviewText } from "../telegram/messageContent";
import { REPORT_MESSAGE_LIMIT } from "../telegram/chatReport";
import type { ChatMessageSearchPage, Message } from "../telegram/types";

interface ReportMessagePickerProps {
  chatId: string;
  selected: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}

export function ReportMessagePicker({ chatId, selected, disabled, onChange }: ReportMessagePickerProps) {
  const load = useTelegramStore(state => state.loadReportMessages);
  const users = useTelegramStore(state => state.users);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [page, setPage] = useState<ChatMessageSearchPage>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const loadingMore = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    setPending(true);
    setError(false);
    setPage(undefined);
    void load({ chatId, query: appliedQuery }).then(result => {
      if (current === generation.current) setPage(result);
    }).catch(() => {
      if (current === generation.current) setError(true);
    }).finally(() => {
      if (current === generation.current) setPending(false);
    });
    return () => { generation.current += 1; loadingMore.current = false; };
  }, [chatId, appliedQuery, load, retry]);

  const loadMore = async () => {
    if (pending || loadingMore.current || !page?.hasMore || !page.nextFromMessageId) return;
    const current = generation.current;
    loadingMore.current = true;
    setPending(true);
    setError(false);
    try {
      const result = await load({ chatId, query: appliedQuery, fromMessageId: page.nextFromMessageId });
      if (current !== generation.current) return;
      const messages = new Map(page.messages.map(message => [message.id, message]));
      for (const message of result.messages) messages.set(message.id, message);
      setPage({ ...result, messages: [...messages.values()], hasMore: result.hasMore && result.nextFromMessageId !== page.nextFromMessageId });
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) { setPending(false); loadingMore.current = false; }
    }
  };
  const toggle = (message: Message) => {
    if (selected.includes(message.id)) onChange(selected.filter(id => id !== message.id));
    else if (selected.length < REPORT_MESSAGE_LIMIT) onChange([...selected, message.id]);
  };

  return <div className="report-message-picker">
    <p className="report-help">{translate("请选择需要举报的消息，可搜索或加载更早的消息。")}</p>
    <form className="report-message-search" onSubmit={event => { event.preventDefault(); setAppliedQuery(query.trim()); }}>
      <input type="search" value={query} onChange={event => setQuery(event.target.value)} disabled={disabled}
        aria-label={translate("搜索举报消息")} placeholder={translate("搜索消息内容")} />
      <button className="dialog-secondary" type="submit" disabled={disabled || pending}><Search size={15} />{translate("搜索")}</button>
    </form>
    <div className="report-message-selection">
      <span>{translate("已选择 {{count}} / {{limit}} 条消息", { count: selected.length, limit: REPORT_MESSAGE_LIMIT })}</span>
      {selected.length > 0 && <button type="button" className="report-text-button" disabled={disabled} onClick={() => onChange([])}>{translate("清空选择")}</button>}
    </div>
    <div className="report-message-list" aria-label={translate("可举报消息")} aria-busy={pending}>
      {page?.messages.map(message => <label key={message.id} className="report-message-row">
        <input type="checkbox" checked={selected.includes(message.id)} onChange={() => toggle(message)}
          disabled={disabled || (!selected.includes(message.id) && selected.length >= REPORT_MESSAGE_LIMIT)} />
        <span><span className="report-message-meta"><strong>{users.get(message.senderId)?.displayName ?? translate("消息")}</strong>
          <time dateTime={message.sentAt}>{new Date(message.sentAt).toLocaleString(currentLanguage(), { dateStyle: "short", timeStyle: "short" })}</time></span>
          <span className="report-message-preview">{messagePreviewText(message.content)}</span></span>
      </label>)}
      {pending && <p className="report-help" role="status"><LoaderCircle size={16} className="spin" />{translate("正在加载消息")}</p>}
      {page?.messages.length === 0 && !pending && <p className="report-help">{translate("没有找到可举报的消息")}</p>}
    </div>
    {error && <p className="report-error" role="alert">{translate("无法加载举报消息，请重试")}</p>}
    {(page?.hasMore || error) && <button className="dialog-secondary" type="button" disabled={disabled || pending}
      onClick={() => page ? void loadMore() : setRetry(value => value + 1)}>{error ? translate("重试") : translate("加载更多")}</button>}
  </div>;
}
