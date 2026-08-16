import {
  Camera,
  LoaderCircle,
  Radio,
  Search,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import { useStableVisibility } from "../hooks/useStableVisibility";
import type { CreateChatInput, NewChatKind, User } from "../telegram/types";
import { Avatar } from "./Avatar";
import { MotionPresence } from "./MotionPresence";

interface NewChatDialogProps {
  contacts: User[];
  currentUserId?: string;
  contactsLoading: boolean;
  contactsError?: string;
  pending: boolean;
  onLoadContacts: () => Promise<void>;
  onCreate: (input: CreateChatInput) => Promise<string | undefined>;
  onClose: () => void;
}

export function NewChatDialog({
  contacts,
  currentUserId,
  contactsLoading,
  contactsError,
  pending,
  onLoadContacts,
  onCreate,
  onClose,
}: NewChatDialogProps) {
  const dialogRef = useModalFocus<HTMLDivElement>(onClose, pending);
  const [kind, setKind] = useState<NewChatKind>("basicGroup");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [memberUserIds, setMemberUserIds] = useState(new Set<string>());
  const [isPublic, setIsPublic] = useState(false);
  const [username, setUsername] = useState("");
  const [historyAvailable, setHistoryAvailable] = useState(true);
  const [permissionTemplate, setPermissionTemplate] = useState<CreateChatInput["permissionTemplate"]>("open");
  const [selectPhoto, setSelectPhoto] = useState(false);

  useEffect(() => {
    if (contacts.length === 0 && !contactsLoading) void onLoadContacts();
  }, [contacts.length, contactsLoading, onLoadContacts]);

  useEffect(() => {
    if (kind === "basicGroup") setIsPublic(false);
  }, [kind]);

  const visibleContacts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return contacts
      .filter((user) => user.id !== currentUserId)
      .filter((user) => !normalized || `${user.displayName} ${user.username ?? ""}`
        .toLocaleLowerCase("zh-CN").includes(normalized));
  }, [contacts, currentUserId, query]);
  const contactsPrimaryLoading = contactsLoading && contacts.length === 0;
  const showContactsLoading = useStableVisibility(contactsPrimaryLoading);
  const showPending = useStableVisibility(pending, { minimumVisible: 220 });
  const contactsStatus = showContactsLoading ? "loading" : !contactsPrimaryLoading && contactsError && contacts.length === 0
    ? "error"
    : !contactsPrimaryLoading && visibleContacts.length === 0 ? "empty" : undefined;

  const normalizedTitle = title.trim();
  const normalizedUsername = username.trim();
  const titleValid = normalizedTitle.length > 0 && [...normalizedTitle].length <= 128 && !/[\r\n]/.test(normalizedTitle);
  const usernameValid = !isPublic || /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(normalizedUsername);
  const canSubmit = titleValid && usernameValid && [...description.trim()].length <= 255;

  const toggleMember = (userId: string) => {
    setMemberUserIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const submit = async () => {
    if (pending || !canSubmit) return;
    const chatId = await onCreate({
      kind,
      title: normalizedTitle,
      description: kind === "basicGroup" ? undefined : description.trim() || undefined,
      memberUserIds: [...memberUserIds],
      isPublic: kind === "basicGroup" ? false : isPublic,
      username: isPublic ? normalizedUsername : undefined,
      historyAvailable: kind === "supergroup" ? historyAvailable : undefined,
      permissionTemplate: kind === "channel" ? undefined : permissionTemplate,
      selectPhoto,
    });
    if (chatId) onClose();
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <div
        ref={dialogRef}
        className="new-chat-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-chat-title"
        tabIndex={-1}
      >
        <header className="new-chat-header">
          <h2 id="new-chat-title">新建聊天</h2>
          <button className="icon-button" type="button" aria-label="关闭" title="关闭" disabled={pending} onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <div className="new-chat-body">
          <div className="new-chat-kind" role="radiogroup" aria-label="聊天类型">
            {([
              ["basicGroup", "普通群组", Users],
              ["supergroup", "超级群组", Users],
              ["channel", "频道", Radio],
            ] as const).map(([value, label, Icon]) => (
              <label key={value}>
                <input type="radio" name="new-chat-kind" value={value} checked={kind === value} disabled={pending} onChange={() => setKind(value)} />
                <span><Icon size={17} />{label}</span>
              </label>
            ))}
          </div>

          <label className="new-chat-field">
            <span>名称</span>
            <input aria-label="名称" autoFocus value={title} maxLength={128} disabled={pending} aria-invalid={title.length > 0 && !titleValid} onChange={(event) => setTitle(event.target.value)} />
            <small>{[...title].length}/128</small>
          </label>

          {kind !== "basicGroup" && (
            <label className="new-chat-field is-textarea">
              <span>简介</span>
              <textarea aria-label="简介" value={description} maxLength={255} disabled={pending} onChange={(event) => setDescription(event.target.value)} />
              <small>{[...description].length}/255</small>
            </label>
          )}

          <div className="new-chat-options">
            <label>
              <input type="checkbox" checked={selectPhoto} disabled={pending} onChange={(event) => setSelectPhoto(event.target.checked)} />
              <Camera size={17} /><span>创建后选择头像</span>
            </label>
            {kind !== "basicGroup" && (
              <label>
                <input type="checkbox" checked={isPublic} disabled={pending} onChange={(event) => setIsPublic(event.target.checked)} />
                <span>公开聊天</span>
              </label>
            )}
            {kind === "supergroup" && (
              <label>
                <input type="checkbox" checked={historyAvailable} disabled={pending} onChange={(event) => setHistoryAvailable(event.target.checked)} />
                <span>新成员可见历史消息</span>
              </label>
            )}
          </div>

          {kind !== "basicGroup" && isPublic && (
            <label className="new-chat-field">
              <span>公开用户名</span>
              <div className="new-chat-username"><span>t.me/</span><input aria-label="公开用户名" value={username} maxLength={32} disabled={pending} aria-invalid={username.length > 0 && !usernameValid} onChange={(event) => setUsername(event.target.value)} /></div>
              {!usernameValid && username.length > 0 && <small className="is-error">5-32 位，以字母开头</small>}
            </label>
          )}

          {kind !== "channel" && (
            <label className="new-chat-select">
              <span>成员权限模板</span>
              <select aria-label="成员权限模板" value={permissionTemplate} disabled={pending} onChange={(event) => setPermissionTemplate(event.target.value as CreateChatInput["permissionTemplate"])}>
                <option value="open">开放协作</option>
                <option value="restricted">仅文本</option>
              </select>
            </label>
          )}

          <section className="new-chat-members" aria-labelledby="new-chat-members-title">
            <div className="new-chat-section-heading">
              <h3 id="new-chat-members-title">初始成员</h3>
              <span>{memberUserIds.size}</span>
            </div>
            <label className="new-chat-search">
              <Search size={16} /><span className="sr-only">筛选联系人</span>
              <input type="search" value={query} placeholder="筛选联系人" disabled={pending} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <div className="new-chat-member-list" aria-busy={contactsPrimaryLoading}>
              <MotionPresence present={Boolean(contactsStatus)} variant="status">
                {contactsStatus ? <div key={contactsStatus} className="new-chat-loading" role={contactsStatus === "error" ? "alert" : "status"}>
                  {contactsStatus === "loading" ? <LoaderCircle className="spin" size={18} /> : contactsStatus === "error" ? (
                    <button className="dialog-secondary" type="button" onClick={() => void onLoadContacts()}>重试联系人</button>
                  ) : "没有匹配的联系人"}
                </div> : null}
              </MotionPresence>
              {!contactsStatus && visibleContacts.map((user) => (
                <label className="new-chat-member-row" key={user.id}>
                  <input type="checkbox" checked={memberUserIds.has(user.id)} disabled={pending} onChange={() => toggleMember(user.id)} />
                  <Avatar avatar={user.avatar} size="small" />
                  <span><strong>{user.displayName}</strong><small>{user.username ? `@${user.username}` : user.lastSeenLabel ?? "联系人"}</small></span>
                </label>
              ))}
            </div>
          </section>
        </div>

        <footer className="new-chat-footer">
          <button className="dialog-secondary" type="button" disabled={pending} onClick={onClose}>取消</button>
          <button className="dialog-primary" type="button" disabled={pending || !canSubmit} onClick={() => void submit()}>
            {showPending && <LoaderCircle className="spin" size={16} />}
            <span>创建</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
