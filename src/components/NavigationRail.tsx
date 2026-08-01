import { Archive, Bell, MessageCircle, Settings } from "lucide-react";
import type { ChatFilter } from "../store/telegramStore";

interface NavigationRailProps {
  filter: ChatFilter;
  onFilterChange: (filter: ChatFilter) => void;
  transportLabel: string;
  onOpenProxy: () => void;
}

const items = [
  { filter: "all" as const, label: "全部聊天", Icon: MessageCircle },
  { filter: "unread" as const, label: "未读", Icon: Bell },
  { filter: "archive" as const, label: "已归档", Icon: Archive },
];

export function NavigationRail({ filter, onFilterChange, transportLabel, onOpenProxy }: NavigationRailProps) {
  return (
    <nav className="navigation-rail" aria-label="聊天文件夹">
      <div className="rail-brand"><span className="brand-mark">N</span><span>Notgram</span></div>
      <div className="rail-actions">
        {items.map(({ filter: itemFilter, label, Icon }) => (
          <button className={`rail-button ${filter === itemFilter ? "is-active" : ""}`} key={itemFilter}
            type="button" aria-label={label} aria-pressed={filter === itemFilter} title={label}
            onClick={() => onFilterChange(itemFilter)}>
            <span className="rail-icon"><Icon size={23} strokeWidth={1.8} /></span><span>{label}</span>
          </button>
        ))}
      </div>
      <button className="rail-button rail-settings" type="button" aria-label="代理设置" title="代理设置" onClick={onOpenProxy}>
        <span className="rail-icon"><Settings size={22} strokeWidth={1.8} /></span><span>设置</span>
      </button>
      <div className="rail-connection" title={`连接：${transportLabel}`}><span className="connection-dot" />{transportLabel}</div>
    </nav>
  );
}
