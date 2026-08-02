import { LoaderCircle, MessageCircle, RefreshCw, Search, UserRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { User } from "../telegram/types";
import { Avatar } from "./Avatar";

interface ContactsViewProps {
  contacts: User[];
  currentUser?: User;
  loading: boolean;
  error?: string;
  pendingUserId?: string;
  onRetry: () => void;
  onOpenCurrentProfile: () => void;
  onOpen: (userId: string) => void;
  onClose: () => void;
}

export function ContactsView({
  contacts,
  currentUser,
  loading,
  error,
  pendingUserId,
  onRetry,
  onOpenCurrentProfile,
  onOpen,
  onClose,
}: ContactsViewProps) {
  const [query, setQuery] = useState("");
  const visibleContacts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? contacts.filter((user) => user.displayName.toLocaleLowerCase().includes(normalized))
      : contacts;
  }, [contacts, query]);

  return (
    <section className="contacts-view" aria-labelledby="contacts-title">
      <header className="contacts-header">
        <h1 id="contacts-title">联系人</h1>
        <button className="icon-button" type="button" aria-label="关闭联系人" title="关闭" onClick={onClose}>
          <X size={19} />
        </button>
      </header>
      <div className="contacts-controls">
        <label className="global-search-field">
          <Search size={18} strokeWidth={1.8} />
          <span className="sr-only">搜索联系人</span>
          <input autoFocus type="search" value={query} placeholder="搜索联系人" onChange={(event) => setQuery(event.target.value)} />
          {query && (
            <button type="button" aria-label="清除联系人搜索" title="清除" onClick={() => setQuery("")}>
              <X size={16} />
            </button>
          )}
        </label>
      </div>
      <div className="contacts-results" aria-live="polite">
        {currentUser && (
          <button className="contacts-self" type="button" onClick={onOpenCurrentProfile}>
            <Avatar avatar={currentUser.avatar} size="medium" />
            <span className="contact-copy">
              <strong>{currentUser.displayName}</strong>
              <small>我的资料</small>
            </span>
            <UserRound size={19} strokeWidth={1.8} />
          </button>
        )}
        {loading && contacts.length === 0 ? (
          <div className="contacts-state" role="status"><LoaderCircle className="spin" size={21} /></div>
        ) : error ? (
          <div className="contacts-state is-error" role="alert">
            <span>{error}</span>
            <button className="dialog-secondary" type="button" onClick={onRetry}>
              <RefreshCw size={15} /><span>重试</span>
            </button>
          </div>
        ) : visibleContacts.length === 0 ? (
          <div className="contacts-state">没有匹配的联系人</div>
        ) : (
          <div className="contacts-list">
            {visibleContacts.map((user) => (
              <button className="contact-row" type="button" key={user.id} disabled={Boolean(pendingUserId)} onClick={() => onOpen(user.id)}>
                <Avatar avatar={user.avatar} size="medium" />
                <span className="contact-copy">
                  <strong>{user.displayName}</strong>
                  <small>{user.presence === "online" ? "在线" : user.lastSeenLabel ?? "离线"}</small>
                </span>
                <span className="contact-command" aria-hidden="true">
                  {pendingUserId === user.id ? <LoaderCircle className="spin" size={18} /> : <MessageCircle size={18} />}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
