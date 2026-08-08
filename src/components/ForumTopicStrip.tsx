import { Hash } from "lucide-react";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { ForumTopic } from "../telegram/types";

interface ForumTopicStripProps {
  topics: ForumTopic[];
  activeTopicId: string;
  onSelectTopic: (topicId: string) => void;
}

const topicIconColor = (color: number) =>
  `#${(color >>> 0).toString(16).padStart(6, "0").slice(-6)}`;

const compareTopicOrder = (left: ForumTopic, right: ForumTopic) => {
  if (left.isPinned !== right.isPinned) return Number(right.isPinned) - Number(left.isPinned);
  try {
    const difference = BigInt(right.order) - BigInt(left.order);
    return difference > 0n ? 1 : difference < 0n ? -1 : 0;
  } catch {
    return right.order.localeCompare(left.order, undefined, { numeric: true });
  }
};

export function ForumTopicStrip({
  topics,
  activeTopicId,
  onSelectTopic,
}: ForumTopicStripProps) {
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const orderedTopics = useMemo(
    () => [...topics].filter((topic) => !topic.isHidden).sort(compareTopicOrder),
    [topics],
  );

  useLayoutEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [activeTopicId]);

  if (orderedTopics.length === 0) return null;

  return (
    <nav className="forum-topic-strip" aria-label="话题切换">
      <div className="forum-topic-tabs" role="tablist" aria-label="话题">
        {orderedTopics.map((topic) => {
          const active = topic.id === activeTopicId;
          const unreadLabel = topic.unreadCount > 0 ? `，${topic.unreadCount} 条未读消息` : "";
          return (
            <button
              key={topic.id}
              ref={active ? activeTabRef : undefined}
              className={`forum-topic-tab ${active ? "is-active" : ""}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={`${topic.name}${unreadLabel}`}
              data-topic-id={topic.id}
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
              {topic.unreadCount > 0 && (
                <strong className="forum-topic-tab-count">
                  {topic.unreadCount > 99 ? "99+" : topic.unreadCount}
                </strong>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
