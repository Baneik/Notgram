import { Archive, Bell, Bot, Folder, FolderCog, MessageCircle, Radio, UserRound, Users } from "lucide-react";
import type { ChatFilter } from "../store/telegramStore";
import type { ChatFolder } from "../telegram/types";

interface NavigationRailProps {
  filter: ChatFilter;
  folders: ChatFolder[];
  onFilterChange: (filter: ChatFilter) => void;
  onManageFolders: () => void;
  onOpenSettings: () => void;
}

export function NavigationRail({
  folders,
  filter,
  onFilterChange,
  onManageFolders,
  onOpenSettings,
}: NavigationRailProps) {
  return (
    <nav className="navigation-rail" aria-label="聊天文件夹">
      <button
        className="rail-brand"
        type="button"
        aria-label="设置"
        title="设置"
        onClick={onOpenSettings}
      >
        <span className="brand-mark">N</span><span>Notgram</span>
      </button>
      <div className="rail-actions">
        {folders.map((folder) => (
          <button className={`rail-button ${filter === folder.id ? "is-active" : ""}`} key={folder.id}
            type="button" aria-label={folder.title} aria-pressed={filter === folder.id} title={folder.title}
            onClick={() => onFilterChange(folder.id)}>
            <span className="rail-icon"><FolderIcon name={folder.iconName} /></span><span>{folder.title}</span>
          </button>
        ))}
        <button className="rail-button" type="button" aria-label="管理文件夹" title="管理文件夹" onClick={onManageFolders}>
          <span className="rail-icon"><FolderCog size={23} strokeWidth={1.8} /></span><span>管理</span>
        </button>
      </div>
    </nav>
  );
}

function FolderIcon({ name }: { name: string }) {
  const props = { size: 23, strokeWidth: 1.8 };
  switch (name) {
    case "All": return <MessageCircle {...props} />;
    case "Archive": return <Archive {...props} />;
    case "Unread": return <Bell {...props} />;
    case "Bots": return <Bot {...props} />;
    case "Channels": return <Radio {...props} />;
    case "Groups": return <Users {...props} />;
    case "Private": return <UserRound {...props} />;
    default: return <Folder {...props} />;
  }
}
