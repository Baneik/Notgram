import { Check, LoaderCircle } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

interface MessageStreamingStatusProps {
  active: boolean;
  announceCompletion?: boolean;
}

const COMPLETION_VISIBLE_MS = 1_100;

export function MessageStreamingStatus({
  active,
  announceCompletion = false,
}: MessageStreamingStatusProps) {
  const previousActiveRef = useRef(active);
  const [showCompletion, setShowCompletion] = useState(false);

  useLayoutEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = active;
    if (active) {
      setShowCompletion(false);
      return;
    }
    if (!announceCompletion || !wasActive) return;

    setShowCompletion(true);
    const timer = globalThis.setTimeout(() => setShowCompletion(false), COMPLETION_VISIBLE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [active, announceCompletion]);

  if (!active && !showCompletion) return null;
  const complete = !active;
  return (
    <span
      className={`message-streaming-status ${complete ? "is-complete" : "is-active"}`}
      role="status"
      aria-live="polite"
      aria-label={complete ? "消息生成完成" : "机器人仍在生成消息"}
    >
      {complete
        ? <Check size={13} strokeWidth={2.4} />
        : <LoaderCircle className="spin" size={13} strokeWidth={2.1} />}
      <span>{complete ? "生成完成" : "正在生成"}</span>
      {!complete && (
        <span className="message-streaming-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
    </span>
  );
}
