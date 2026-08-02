import { Folder, LoaderCircle, Plus, Save, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import type { Chat, ChatFolder } from "../telegram/types";
import { Avatar } from "./Avatar";

interface FolderManagerDialogProps {
  folders: ChatFolder[];
  chats: Chat[];
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
  pending,
  onCreate,
  onRename,
  onDelete,
  onSetMembership,
  onClose,
}: FolderManagerDialogProps) {
  const customFolders = folders.filter((folder) => folder.id.startsWith("folder:"));
  const [activeId, setActiveId] = useState(customFolders[0]?.id ?? NEW_FOLDER);
  const [title, setTitle] = useState(customFolders[0]?.title ?? "");
  const [selectedChatIds, setSelectedChatIds] = useState(() => new Set(
    customFolders[0]
      ? chats.filter((chat) => chat.folderIds.includes(customFolders[0].id)).map((chat) => chat.id)
      : [],
  ));
  const [query, setQuery] = useState("");
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

  const visibleChats = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return chats
      .filter((chat) => !normalized || chat.title.toLocaleLowerCase("zh-CN").includes(normalized))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }, [chats, query]);

  function selectFolder(folderId: string) {
    const folder = customFolders.find((item) => item.id === folderId);
    setActiveId(folder?.id ?? NEW_FOLDER);
    setTitle(folder?.title ?? "");
    setSelectedChatIds(new Set(folder
      ? chats.filter((chat) => chat.folderIds.includes(folder.id)).map((chat) => chat.id)
      : []));
    setQuery("");
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
          <h2 id="folder-dialog-title">聊天文件夹</h2>
          <button className="icon-button" type="button" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <div className="folder-dialog-body">
          <nav className="folder-list" aria-label="自定义文件夹">
            <button
              className={`folder-list-item ${activeId === NEW_FOLDER ? "is-active" : ""}`}
              type="button"
              onClick={() => selectFolder(NEW_FOLDER)}
            >
              <Plus size={17} />
              <span>新建文件夹</span>
            </button>
            {customFolders.map((folder) => (
              <button
                className={`folder-list-item ${activeId === folder.id ? "is-active" : ""}`}
                type="button"
                key={folder.id}
                onClick={() => selectFolder(folder.id)}
              >
                <Folder size={17} />
                <span>{folder.title}</span>
              </button>
            ))}
          </nav>
          <section className="folder-editor" aria-label={activeFolder ? `编辑 ${activeFolder.title}` : "新建文件夹"}>
            <label className="folder-name-field">
              <span>名称</span>
              <input
                value={title}
                maxLength={12}
                disabled={busy}
                aria-invalid={title.length > 0 && !titleValid}
                onChange={(event) => setTitle(event.target.value)}
              />
              <small>{[...title].length}/12</small>
            </label>
            <div className="folder-members-heading">
              <h3>包含的会话</h3>
              <span>{selectedChatIds.size}</span>
            </div>
            <label className="folder-chat-search">
              <Search size={16} />
              <span className="sr-only">筛选会话</span>
              <input
                type="search"
                value={query}
                placeholder="筛选会话"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="folder-chat-list">
              {visibleChats.map((chat) => (
                <label className="folder-chat-row" key={chat.id}>
                  <input
                    type="checkbox"
                    checked={selectedChatIds.has(chat.id)}
                    disabled={busy}
                    onChange={() => toggleChat(chat.id)}
                  />
                  <Avatar avatar={chat.avatar} size="small" />
                  <span>{chat.title}</span>
                </label>
              ))}
            </div>
            <footer className="folder-editor-actions">
              {activeFolder && (deleteConfirm ? (
                <div className="folder-delete-confirm">
                  <button type="button" disabled={busy} onClick={() => setDeleteConfirm(false)}>取消</button>
                  <button className="is-danger" type="button" disabled={busy} onClick={() => void remove()}>
                    删除文件夹
                  </button>
                </div>
              ) : (
                <button className="folder-delete" type="button" disabled={busy} aria-label="删除文件夹" title="删除文件夹" onClick={() => setDeleteConfirm(true)}>
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
                  <span>保存</span>
                </button>
              )}
            </footer>
          </section>
        </div>
      </div>
    </div>
  );
}
