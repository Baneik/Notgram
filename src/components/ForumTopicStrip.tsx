import { translate } from "../i18n";
import { Hash, Layers, SlidersHorizontal } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { ForumTopic } from "../telegram/types";
import { FORUM_ALL_TOPIC_ID } from "../telegram/types";
import { useTelegramStore } from "../store/telegramStore";
import { forumTopicOrderStore, useForumTopicIds } from "../store/forumTopicOrder";
import { useFolderReorder } from "../hooks/useFolderReorder";
import { formatUnreadCount } from "../utils/formatters";

interface ForumTopicStripProps {
  topics: ForumTopic[];
  activeTopicId: string;
  onSelectTopic: (topicId: string) => void;
  chatId: string;
  onManageTopics: () => void;
}

const topicIconColor = (color: number) =>
  `#${(color >>> 0).toString(16).padStart(6, "0").slice(-6)}`;

const handleTopicTabsWheel = (event: WheelEvent) => {
  if (event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

  const tabs = event.currentTarget as HTMLDivElement | null;
  if (!tabs) return;
  const maximumScrollLeft = tabs.scrollWidth - tabs.clientWidth;
  if (maximumScrollLeft <= 0) return;

  const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? tabs.clientWidth
      : 1;
  const nextScrollLeft = Math.max(
    0,
    Math.min(maximumScrollLeft, tabs.scrollLeft + event.deltaY * deltaScale),
  );
  if (nextScrollLeft === tabs.scrollLeft) return;

  event.preventDefault();
  tabs.scrollLeft = nextScrollLeft;
};

export function ForumTopicStrip({
  topics,
  activeTopicId,
  onSelectTopic,
  chatId,
  onManageTopics,
}: ForumTopicStripProps) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const accountId = useTelegramStore(state => state.activeAccountId);
  const topicIds = useForumTopicIds(accountId, chatId, topics, true);
  const byId = new Map(topics.filter(topic => !topic.isHidden).map(topic => [topic.id, topic]));
  const orderedIds = topicIds.filter(id => id === FORUM_ALL_TOPIC_ID || byId.has(id));
  const saveOrder = (ids: string[]) => forumTopicOrderStore.getState().setOrder(accountId, chatId, ids);
  const drag = useFolderReorder({ containerRef: tabsRef, folderIds: orderedIds,
    disabled: false, accountId: `${accountId}:${chatId}`, axis: "horizontal", onReorder: saveOrder });
  const displayIds = drag.preview?.order ?? orderedIds;

  useLayoutEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs) return;
    tabs.addEventListener("wheel", handleTopicTabsWheel, { passive: false });
    return () => tabs.removeEventListener("wheel", handleTopicTabsWheel);
  }, [orderedIds.length]);

  return (
    <nav className="forum-topic-strip" aria-label={translate("话题切换")}>
      <div className="forum-topic-tablist" role="tablist" aria-label={translate("话题")}>
      <div
        ref={tabsRef}
        className="forum-topic-tabs"
        onClickCapture={drag.suppressClick}
      >
        {displayIds.map((id) => {
          const topic = byId.get(id);
          const all = id === FORUM_ALL_TOPIC_ID;
          const name = all ? translate("全部") : topic!.name;
          const active = id === activeTopicId;
          const displayUnreadCount = topic && topic.unreadCount > 0
            ? topic.unreadCount
            : topic?.unreadReactionCount ?? 0;
          const unreadLabel = topic && topic.unreadCount > 0
            ? translate("，{{value0}} 条未读消息", { value0: topic.unreadCount })
            : topic && topic.unreadReactionCount > 0
              ? translate("，{{value0}} 条未读回应", { value0: topic.unreadReactionCount })
              : "";
          return (
            <button
              key={id}
              className={`forum-topic-tab ${all ? "forum-topic-all" : ""} ${active ? "is-active" : ""} ${drag.preview?.folderId === id ? "is-dragging" : ""}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={`${name}${unreadLabel}`}
              title={translate("拖拽排序，或使用 Ctrl+Shift+方向键调整位置")}
              data-topic-id={id}
              data-folder-id={id}
              onPointerDown={event => drag.begin(event, id)}
              onKeyDown={event => {
                if (!event.ctrlKey || !event.shiftKey || event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
                event.preventDefault();
                const ids = [...orderedIds];
                const from = ids.indexOf(id);
                const to = Math.max(0, Math.min(ids.length - 1, from + (event.key === "ArrowLeft" ? -1 : 1)));
                ids.splice(from, 1); ids.splice(to, 0, id); saveOrder(ids);
              }}
              onClick={() => {
                if (!active) onSelectTopic(id);
              }}
            >
              <span
                className="forum-topic-tab-avatar"
                style={{ backgroundColor: all ? "var(--accent)" : topicIconColor(topic!.iconColor) }}
                aria-hidden="true"
              >
                {all ? <Layers size={14} strokeWidth={2.2} /> : <Hash size={14} strokeWidth={2.2} />}
                <strong className={`forum-topic-tab-count ${displayUnreadCount === 0 ? "is-empty" : ""} ${topic?.unreadCount === 0 ? "has-reaction" : ""}`}>
                  {formatUnreadCount(displayUnreadCount)}
                </strong>
              </span>
              <span className="forum-topic-tab-name">{name}</span>
            </button>
          );
        })}
      </div>
      </div>
      <button className="icon-button forum-topic-manage" type="button" aria-label={translate("管理话题")}
        title={translate("管理话题")} onClick={onManageTopics}><SlidersHorizontal size={18} /></button>
    </nav>
  );
}
