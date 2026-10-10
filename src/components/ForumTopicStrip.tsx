import { translate } from "../i18n";
import { Hash, Layers, SlidersHorizontal } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { ForumTopic } from "../telegram/types";
import { FORUM_ALL_TOPIC_ID } from "../telegram/types";
import { useTelegramStore } from "../store/telegramStore";
import { forumTopicOrderStore, useOrderedForumTopics } from "../store/forumTopicOrder";
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
  const orderedTopics = useOrderedForumTopics(accountId, chatId, topics);
  const saveOrder = (ids: string[]) => forumTopicOrderStore.getState().setOrder(accountId, chatId, ids);
  const drag = useFolderReorder({ containerRef: tabsRef, folderIds: orderedTopics.map(topic => topic.id),
    disabled: false, accountId: `${accountId}:${chatId}`, axis: "horizontal", onReorder: saveOrder });
  const displayTopics = drag.preview
    ? drag.preview.order.map(id => orderedTopics.find(topic => topic.id === id)!).filter(Boolean)
    : orderedTopics;

  useLayoutEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs) return;
    tabs.addEventListener("wheel", handleTopicTabsWheel, { passive: false });
    return () => tabs.removeEventListener("wheel", handleTopicTabsWheel);
  }, [orderedTopics.length]);

  return (
    <nav className="forum-topic-strip" aria-label={translate("话题切换")}>
      <div className="forum-topic-tablist" role="tablist" aria-label={translate("话题")}>
      <button className={`forum-topic-tab forum-topic-all ${activeTopicId === FORUM_ALL_TOPIC_ID ? "is-active" : ""}`}
        type="button" role="tab" aria-selected={activeTopicId === FORUM_ALL_TOPIC_ID}
        data-topic-id={FORUM_ALL_TOPIC_ID} onClick={() => onSelectTopic(FORUM_ALL_TOPIC_ID)}>
        <Layers size={17} aria-hidden="true" /><span className="forum-topic-tab-name">{translate("所有")}</span>
      </button>
      <div
        ref={tabsRef}
        className="forum-topic-tabs"
        onClickCapture={drag.suppressClick}
      >
        {displayTopics.map((topic) => {
          const active = topic.id === activeTopicId;
          const displayUnreadCount = topic.unreadCount > 0
            ? topic.unreadCount
            : topic.unreadReactionCount;
          const unreadLabel = topic.unreadCount > 0
            ? translate("，{{value0}} 条未读消息", { value0: topic.unreadCount })
            : topic.unreadReactionCount > 0
              ? translate("，{{value0}} 条未读回应", { value0: topic.unreadReactionCount })
              : "";
          return (
            <button
              key={topic.id}
              className={`forum-topic-tab ${active ? "is-active" : ""} ${drag.preview?.folderId === topic.id ? "is-dragging" : ""}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={`${topic.name}${unreadLabel}`}
              title={translate("拖拽排序，或使用 Ctrl+Shift+方向键调整位置")}
              data-topic-id={topic.id}
              data-folder-id={topic.id}
              onPointerDown={event => drag.begin(event, topic.id)}
              onKeyDown={event => {
                if (!event.ctrlKey || !event.shiftKey || event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
                event.preventDefault();
                const ids = orderedTopics.map(candidate => candidate.id);
                const from = ids.indexOf(topic.id);
                const to = Math.max(0, Math.min(ids.length - 1, from + (event.key === "ArrowLeft" ? -1 : 1)));
                ids.splice(from, 1); ids.splice(to, 0, topic.id); saveOrder(ids);
              }}
              onClick={() => {
                if (!active) onSelectTopic(topic.id);
              }}
            >
              <span
                className="forum-topic-tab-avatar"
                style={{ backgroundColor: topicIconColor(topic.iconColor) }}
                aria-hidden="true"
              >
                <Hash size={14} strokeWidth={2.2} />
              </span>
              <span className="forum-topic-tab-name">{topic.name}</span>
                <strong aria-hidden={displayUnreadCount === 0} className={`forum-topic-tab-count ${displayUnreadCount === 0 ? "is-empty" : ""} ${topic.unreadCount === 0 ? "has-reaction" : ""}`}>
                  {formatUnreadCount(displayUnreadCount)}
                </strong>
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
