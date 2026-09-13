import { currentLanguage, translate } from "../i18n";
import { ChevronDown, Folder, LoaderCircle, Plus, Save, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import type { Chat, ChatFolder, User } from "../telegram/types";
import { filterFolderChats, folderChatKind, type FolderChatFilter } from "../utils/folderChatSelection";
import { Avatar } from "./Avatar";

interface FolderManagerDialogProps {
  folders: ChatFolder[];
  chats: Chat[];
  users: ReadonlyMap<string, User>;
  initialFolderId?: string;
  pending: boolean;
  onCreate: (title: string, chatIds: string[]) => Promise<string | undefined>;
  onRename: (folderId: string, title: string) => Promise<boolean>;
  onDelete: (folderId: string) => Promise<boolean>;
  onSetMembership: (folderId: string, chatId: string, included: boolean) => Promise<boolean>;
  onClose: () => void;
}

const NEW_FOLDER = "new";

export function FolderManagerDialog({
  folders,
  chats,
  users,
  initialFolderId,
  pending,
  onCreate,
  onRename,
  onDelete,
  onSetMembership,
  onClose,
}: FolderManagerDialogProps) {
  const customFolders = folders.filter((folder) => folder.id.startsWith("folder:"));
  const initialFolder = customFolders.find((folder) => folder.id === initialFolderId) ??
    customFolders[0];
  const [activeId, setActiveId] = useState(initialFolder?.id ?? NEW_FOLDER);
  const [title, setTitle] = useState(initialFolder?.title ?? "");
  const [selectedChatIds, setSelectedChatIds] = useState(() => new Set(
    initialFolder
      ? chats.filter((chat) => chat.folderIds.includes(initialFolder.id)).map((chat) => chat.id)
      : [],
  ));
  // Freeze selected-first priority for this editing session; toggles and saves must not move rows.
  const [sortPriorityIds, setSortPriorityIds] = useState(selectedChatIds);
  const [query, setQuery] = useState("");
  const [chatFilter, setChatFilter] = useState<FolderChatFilter>("all");
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const dialogRef = useModalFocus<HTMLDivElement>(onClose, pending || saving);
  const activeFolder = customFolders.find((folder) => folder.id === activeId);
  const busy = pending || saving;
  const normalizedTitle = title.trim();
  const titleValid = [...normalizedTitle].length >= 1 &&
    [...normalizedTitle].length <= 12 && !/[\r\n]/.test(normalizedTitle);

  useEffect(() => {
    if (activeId === NEW_FOLDER || activeFolder) return;
    const fallback = customFolders[0];
    selectFolder(fallback?.id ?? NEW_FOLDER);
  }, [activeFolder, activeId, customFolders]);

  const language = currentLanguage();
  const visibleChats = useMemo(() => filterFolderChats(
    chats, users, sortPriorityIds, query, chatFilter, language,
  ), [chats, users, sortPriorityIds, query, chatFilter, language]);
  const selectedVisibleCount = visibleChats.filter((chat) => selectedChatIds.has(chat.id)).length;
  const allVisibleSelected = visibleChats.length > 0 && selectedVisibleCount === visibleChats.length;
  const kindLabels = {
    direct: translate("私聊"),
    bot: translate("机器人"),
    group: translate("群聊"),
    channel: translate("频道"),
    saved: translate("收藏夹"),
  };

  function clearFilters() {
    setQuery("");
    setChatFilter("all");
  }

  function selectFolder(folderId: string) {
    const folder = customFolders.find((item) => item.id === folderId);
    setActiveId(folder?.id ?? NEW_FOLDER);
    setTitle(folder?.title ?? "");
    const memberIds = new Set(folder
      ? chats.filter((chat) => chat.folderIds.includes(folder.id)).map((chat) => chat.id)
      : []);
    setSelectedChatIds(memberIds);
    setSortPriorityIds(memberIds);
    clearFilters();
    setDeleteConfirm(false);
  }

  const toggleChat = (chatId: string) => {
    setSelectedChatIds((current) => {
      const next = new Set(current);
      if (next.has(chatId)) next.delete(chatId);
      else next.add(chatId);
      return next;
    });
  };

  const toggleVisibleChats = () => {
    setSelectedChatIds((current) => {
      const next = new Set(current);
      for (const chat of visibleChats) {
        if (allVisibleSelected) next.delete(chat.id);
        else next.add(chat.id);
      }
      return next;
    });
  };

  const save = async () => {
    if (busy || !titleValid || (activeId === NEW_FOLDER && selectedChatIds.size === 0)) return;
    setSaving(true);
    try {
      if (activeId === NEW_FOLDER) {
        const folderId = await onCreate(normalizedTitle, [...selectedChatIds]);
        if (folderId) setActiveId(folderId);
        return;
      }
      if (activeFolder && normalizedTitle !== activeFolder.title) {
        if (!await onRename(activeId, normalizedTitle)) return;
      }
      for (const chat of chats) {
        const included = chat.folderIds.includes(activeId);
        const desired = selectedChatIds.has(chat.id);
        if (included !== desired && !await onSetMembership(activeId, chat.id, desired)) return;
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!activeFolder || busy) return;
    setSaving(true);
    try {
      if (await onDelete(activeFolder.id)) selectFolder(NEW_FOLDER);
    } finally {
      setSaving(false);
      setDeleteConfirm(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <div
        ref={dialogRef}
        className="folder-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-dialog-title"
        tabIndex={-1}
      >
        <header className="folder-dialog-header">
          <h2 id="folder-dialog-title"><Folder size={20} aria-hidden="true" />{translate("聊天文件夹")}</h2>
          <button className="icon-button" type="button" aria-label={translate("关闭")} title={translate("关闭")} disabled={busy} onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <div className="folder-dialog-body">
          <nav className="folder-list" aria-label={translate("自定义文件夹")}>
            <button
              className={`folder-list-item ${activeId === NEW_FOLDER ? "is-active" : ""}`}
              type="button"
              disabled={busy}
              aria-pressed={activeId === NEW_FOLDER}
              onClick={() => selectFolder(NEW_FOLDER)}
            >
              <Plus size={17} />
              <span>{translate("新建文件夹")}</span>
            </button>
            {customFolders.map((folder) => (
              <button
                className={`folder-list-item ${activeId === folder.id ? "is-active" : ""}`}
                type="button"
                disabled={busy}
                aria-pressed={activeId === folder.id}
                key={folder.id}
                onClick={() => selectFolder(folder.id)}
              >
                <Folder size={17} />
                <span>{folder.title}</span>
              </button>
            ))}
          </nav>
          <section className="folder-editor" aria-label={activeFolder ? translate("编辑 {{value0}}", { value0: activeFolder.title }) : translate("新建文件夹")}>
            <label className="folder-name-field">
              <span>{translate("名称")}</span>
              <input
                aria-label={translate("名称")}
                value={title}
                maxLength={12}
                disabled={busy}
                aria-invalid={title.length > 0 && !titleValid}
                onChange={(event) => setTitle(event.target.value)}
              />
              <small>{[...title].length}/12</small>
            </label>
            <div className="folder-members-heading">
              <h3>{translate("包含的会话")}</h3>
              <span className="folder-selected-count">{translate("已选 {{value0}}", { value0: selectedChatIds.size })}</span>
            </div>
            <div className="folder-chat-filters">
              <label className="folder-chat-search">
                <Search size={16} aria-hidden="true" />
                <span className="sr-only">{translate("筛选会话")}</span>
                <input
                  type="search"
                  value={query}
                  placeholder={translate("筛选会话")}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <label className="folder-chat-type">
                <span className="sr-only">{translate("聊天类型")}</span>
                <select value={chatFilter} onChange={(event) => setChatFilter(event.target.value as FolderChatFilter)}>
                  <option value="all">{translate("全部类型")}</option>
                  {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  <option value="uncategorized">{translate("未分类")}</option>
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </label>
            </div>
            <div className="folder-chat-results">
              <div className="folder-chat-list-meta">
                <label className="folder-chat-select-all">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(element) => {
                      if (element) element.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected;
                    }}
                    disabled={busy || visibleChats.length === 0}
                    onChange={toggleVisibleChats}
                  />
                  <span>{translate("全选当前结果")}</span>
                </label>
                <span role="status">{translate("{{value0}} 个会话", { value0: visibleChats.length })}</span>
              </div>
              <div className="folder-chat-list">
                {visibleChats.map((chat) => (
                  <label className="folder-chat-row" key={chat.id}>
                    <input
                      type="checkbox"
                      aria-label={chat.title}
                      checked={selectedChatIds.has(chat.id)}
                      disabled={busy}
                      onChange={() => toggleChat(chat.id)}
                    />
                    <Avatar avatar={chat.avatar} size="small" />
                    <span className="folder-chat-title" title={chat.title}>{chat.title}</span>
                    <small className="folder-chat-kind">{kindLabels[folderChatKind(chat, users)]}</small>
                  </label>
                ))}
                {visibleChats.length === 0 && (
                  <div className="folder-chat-empty">
                    <Search size={24} aria-hidden="true" />
                    <span>{translate("没有匹配的会话")}</span>
                    {(query || chatFilter !== "all") && <button type="button" onClick={clearFilters}>{translate("清除筛选")}</button>}
                  </div>
                )}
              </div>
            </div>
            <footer className="folder-editor-actions">
              {activeFolder && (deleteConfirm ? (
                <div className="folder-delete-confirm">
                  <button type="button" disabled={busy} onClick={() => setDeleteConfirm(false)}>{translate("取消")}</button>
                  <button className="is-danger" type="button" disabled={busy} onClick={() => void remove()}>{translate("删除文件夹")}</button>
                </div>
              ) : (
                <button className="folder-delete" type="button" disabled={busy} aria-label={translate("删除文件夹")} title={translate("删除文件夹")} onClick={() => setDeleteConfirm(true)}>
                  <Trash2 size={17} />
                </button>
              ))}
              {!deleteConfirm && (
                <button
                  className="dialog-save"
                  type="button"
                  disabled={busy || !titleValid || (activeId === NEW_FOLDER && selectedChatIds.size === 0)}
                  onClick={() => void save()}
                >
                  {busy ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}
                  <span>{translate("保存")}</span>
                </button>
              )}
            </footer>
          </section>
        </div>
      </div>
    </div>
  );
}
