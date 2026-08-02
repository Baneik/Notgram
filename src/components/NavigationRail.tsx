import { Archive, Bell, Bot, Folder, MessageCircle, Radio, Settings, UserRound, Users } from "lucide-react";
import type { ChatFilter } from "../store/telegramStore";
import type { ChatFolder, ConnectionStatus } from "../telegram/types";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";

interface NavigationRailProps {
  filter: ChatFilter;
  folders: ChatFolder[];
  onFilterChange: (filter: ChatFilter) => void;
  transportLabel: string;
  connectionStatus: ConnectionStatus;
  onOpenSettings: () => void;
}

export function NavigationRail({ folders, filter, onFilterChange, transportLabel, connectionStatus, onOpenSettings }: NavigationRailProps) {
  return (
    <nav className="navigation-rail" aria-label="聊天文件夹">
      <div className="rail-brand"><span className="brand-mark">N</span><span>Notgram</span></div>
      <div className="rail-actions">
        {folders.map((folder) => (
          <button className={`rail-button ${filter === folder.id ? "is-active" : ""}`} key={folder.id}
            type="button" aria-label={folder.title} aria-pressed={filter === folder.id} title={folder.title}
            onClick={() => onFilterChange(folder.id)}>
            <span className="rail-icon"><FolderIcon name={folder.iconName} /></span><span>{folder.title}</span>
          </button>
        ))}
      </div>
      <button className="rail-button rail-settings" type="button" aria-label="设置" title="设置" onClick={onOpenSettings}>
        <span className="rail-icon"><Settings size={22} strokeWidth={1.8} /></span><span>设置</span>
      </button>
      <ConnectionStatusIndicator
        className="rail-connection"
        status={connectionStatus}
        transportLabel={transportLabel}
        compact
      />
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
