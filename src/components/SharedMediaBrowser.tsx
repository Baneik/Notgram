import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import {
  Download,
  FileText,
  Forward,
  Headphones,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Chat,
  ForwardMessagesResult,
  Message,
  SharedMediaCategory,
  SharedMediaPage,
  SharedMediaSearchInput,
} from "../telegram/types";
import { messageContentText } from "../telegram/messageContent";
import { formatChatTime } from "../utils/formatters";
import { useTelegramStore } from "../store/telegramStore";
import { ConfirmActionDialog } from "./ConfirmActionDialog";

const CATEGORIES: { id: SharedMediaCategory; label: string; icon: typeof ImageIcon }[] = [
  { id: "media", label: "图片与视频", icon: ImageIcon },
  { id: "file", label: "文件", icon: FileText },
  { id: "link", label: "链接", icon: Link2 },
  { id: "audio", label: "音频", icon: Headphones },
];

interface SharedMediaBrowserProps {
  chatId: string;
  forwardTargets: Chat[];
  onLoad: (input: SharedMediaSearchInput, force?: boolean) => Promise<SharedMediaPage | undefined>;
  onOpenMessage: (chatId: string, messageId: string) => void;
  onDownload: (fileId: number, fileName: string) => Promise<void>;
  onDelete: (chatId: string, messageIds: string[], revoke: boolean) => Promise<boolean>;
  onForward: (fromChatId: string, messageIds: string[], toChatId: string) => Promise<ForwardMessagesResult | undefined>;
}

const mediaSource = (message: Message) => {
  if (message.content.kind !== "media") return undefined;
  const source = message.content.localPath ?? message.content.thumbnailPath ?? message.content.previewDataUrl;
  if (!source || source.startsWith("data:") || !isTauri()) return source;
  return convertFileSrc(source);
};

const mediaSourceFileId = (message: Message) => {
  if (message.content.kind !== "media") return undefined;
  return message.content.localPath
    ? message.content.fileId
    : message.content.thumbnailPath ? message.content.thumbnailFileId : undefined;
};

const messageFile = (message: Message) => {
  const content = message.content;
  if (content.kind !== "media" && content.kind !== "file") return undefined;
  if (content.fileId === undefined) return undefined;
  return { fileId: content.fileId, fileName: content.fileName };
};

export function SharedMediaBrowser({
  chatId,
  forwardTargets,
  onLoad,
  onOpenMessage,
  onDownload,
  onDelete,
  onForward,
}: SharedMediaBrowserProps) {
  const recoverFile = useTelegramStore((state) => state.recoverFile);
  const generationRef = useRef(0);
  const attemptedRecoveryRef = useRef(new Set<string>());
  const [category, setCategory] = useState<SharedMediaCategory>("media");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState<SharedMediaPage>({ messages: [], hasMore: false });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [forwardTargetId, setForwardTargetId] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [deleteScope, setDeleteScope] = useState<"self" | "all">();
  const [failedMediaSources, setFailedMediaSources] = useState<ReadonlySet<string>>(() => new Set());

  const loadFirstPage = async (force = false, nextQuery = appliedQuery) => {
    const generation = ++generationRef.current;
    setLoading(true);
    setSelected(new Set());
    const result = await onLoad({ chatId, category, query: nextQuery, limit: 40 }, force);
    if (generation === generationRef.current && result) setPage(result);
    if (generation === generationRef.current) setLoading(false);
  };

  useEffect(() => {
    void loadFirstPage(false, appliedQuery);
  // The request generation prevents a late category response from replacing the active page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, category, appliedQuery]);

  const visibleMessages = useMemo(() => page.messages.filter((message) => {
    const date = message.sentAt.slice(0, 10);
    return (!fromDate || date >= fromDate) && (!toDate || date <= toDate);
  }), [fromDate, page.messages, toDate]);
  const selectedMessages = page.messages.filter((message) => selected.has(message.id));

  const toggleSelected = (messageId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else if (next.size < 100) next.add(messageId);
      return next;
    });
  };

  const loadMore = async () => {
    if (!page.hasMore || !page.nextFromMessageId || loadingMore) return;
    setLoadingMore(true);
    const result = await onLoad({
      chatId,
      category,
      query: appliedQuery,
      fromMessageId: page.nextFromMessageId,
      limit: 40,
    });
    if (result) setPage(result);
    setLoadingMore(false);
  };

  const downloadSelected = async () => {
    const files = selectedMessages.map(messageFile).filter((file): file is NonNullable<typeof file> => Boolean(file));
    if (files.length === 0 || actionPending) return;
    setActionPending(true);
    for (const file of files) await onDownload(file.fileId, file.fileName);
    setActionPending(false);
  };

  const forwardSelected = async () => {
    if (!forwardTargetId || selected.size === 0 || actionPending) return;
    setActionPending(true);
    const result = await onForward(chatId, [...selected], forwardTargetId);
    if (result && result.failedMessageIds.length === 0) setSelected(new Set());
    setActionPending(false);
  };

  const deleteSelected = async (revoke: boolean) => {
    if (selected.size === 0) return false;
    const ids = [...selected];
    const succeeded = await onDelete(chatId, ids, revoke);
    if (succeeded) {
      const removed = new Set(ids);
      setPage((current) => ({
        ...current,
        messages: current.messages.filter((message) => !removed.has(message.id)),
        totalCount: current.totalCount === undefined ? undefined : Math.max(0, current.totalCount - ids.length),
      }));
      setSelected(new Set());
    }
    return succeeded;
  };

  return (
    <div className="shared-media-browser">
      <div className="shared-media-tabs" role="tablist" aria-label="共享媒体分类">
        {CATEGORIES.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={category === id} onClick={() => setCategory(id)}>
            <Icon size={15} /><span>{label}</span>
          </button>
        ))}
      </div>
      <form className="shared-media-search" onSubmit={(event) => {
        event.preventDefault();
        setAppliedQuery(query.trim());
      }}>
        <Search size={15} />
        <input aria-label="搜索共享媒体" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" />
        <button type="submit">搜索</button>
      </form>
      <div className="shared-media-date-filter">
        <label>开始日期<input aria-label="共享媒体开始日期" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
        <label>结束日期<input aria-label="共享媒体结束日期" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
      </div>
      {selected.size > 0 && (
        <div className="shared-media-selection" role="toolbar" aria-label="共享媒体批量操作">
          <strong>{selected.size} 项</strong>
          <button type="button" disabled={actionPending || selectedMessages.every((message) => !messageFile(message))} onClick={() => void downloadSelected()}><Download size={15} />下载</button>
          <select aria-label="共享媒体转发目标" value={forwardTargetId} onChange={(event) => setForwardTargetId(event.target.value)} disabled={actionPending}>
            <option value="">转发到...</option>
            {forwardTargets.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}
          </select>
          <button type="button" disabled={actionPending || !forwardTargetId} onClick={() => void forwardSelected()}><Forward size={15} />转发</button>
          <button className="is-danger" type="button" disabled={actionPending} onClick={() => setDeleteScope("self")}><Trash2 size={15} />仅对我删除</button>
          <button className="is-danger" type="button" disabled={actionPending} onClick={() => setDeleteScope("all")}><Trash2 size={15} />为所有人删除</button>
        </div>
      )}
      <div className={`shared-media-results ${category === "media" ? "is-grid" : ""}`} aria-busy={loading}>
        {loading ? <div className="shared-media-empty"><LoaderCircle className="spin" size={19} />正在读取</div> : visibleMessages.length === 0 ? (
          <div className="shared-media-empty">没有匹配的内容</div>
        ) : visibleMessages.map((message) => {
          const source = mediaSource(message);
          const usableSource = source && !failedMediaSources.has(source) ? source : undefined;
          return (
            <div className={`shared-media-item ${selected.has(message.id) ? "is-selected" : ""}`} key={message.id}>
              <label className="shared-media-check"><input type="checkbox" aria-label={`选择 ${message.id}`} checked={selected.has(message.id)} onChange={() => toggleSelected(message.id)} /></label>
              <button className="shared-media-open" type="button" onClick={() => onOpenMessage(message.chatId, message.id)}>
                {category === "media" ? usableSource ? <img
                  src={usableSource}
                  alt=""
                  onError={() => {
                    setFailedMediaSources((current) => new Set(current).add(usableSource));
                    const fileId = mediaSourceFileId(message);
                    if (fileId === undefined || attemptedRecoveryRef.current.has(usableSource)) return;
                    attemptedRecoveryRef.current.add(usableSource);
                    void recoverFile(fileId, 24).then((recovered) => {
                      if (!recovered) return;
                      setFailedMediaSources((current) => {
                        const next = new Set(current);
                        next.delete(usableSource);
                        return next;
                      });
                    });
                  }}
                /> : <span className="shared-media-fallback"><ImageIcon size={22} /></span> : (
                  <span className="shared-media-type-icon">{category === "file" ? <FileText size={19} /> : category === "link" ? <Link2 size={19} /> : <Headphones size={19} />}</span>
                )}
                <span className="shared-media-copy"><strong>{messageContentText(message.content) || "媒体消息"}</strong><time dateTime={message.sentAt}>{formatChatTime(message.sentAt)}</time></span>
              </button>
            </div>
          );
        })}
      </div>
      {!loading && page.hasMore && <button className="shared-media-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore && <LoaderCircle className="spin" size={15} />}{loadingMore ? "正在加载" : "加载更多"}</button>}
      <div className="shared-media-count">{page.totalCount ?? page.messages.length} 项</div>
      {deleteScope && (
        <ConfirmActionDialog
          title={`删除 ${selected.size} 条消息`}
          description={deleteScope === "all" ? "这些消息将为所有人删除。" : "这些消息只会从你的聊天记录中删除。"}
          confirmLabel={deleteScope === "all" ? "为所有人删除" : "仅对我删除"}
          onConfirm={() => deleteSelected(deleteScope === "all")}
          onClose={() => setDeleteScope(undefined)}
        />
      )}
    </div>
  );
}
