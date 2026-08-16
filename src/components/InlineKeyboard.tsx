import { Check, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type {
  CallbackQueryAnswer,
  MessageInlineKeyboard,
  MessageInlineKeyboardButton,
} from "../telegram/types";
import { writeClipboardText } from "../utils/clipboard";
import { openExternalLink } from "../utils/externalLinks";
import { motionLifecycleTiming } from "../utils/motionTokens";

interface InlineKeyboardProps {
  messageId: string;
  markup: MessageInlineKeyboard;
  onCallback: (messageId: string, data: string) => Promise<CallbackQueryAnswer | undefined>;
  onOpenUser: (userId: string) => void;
}

export function InlineKeyboard({
  messageId,
  markup,
  onCallback,
  onOpenUser,
}: InlineKeyboardProps) {
  const [pendingKey, setPendingKey] = useState<string>();
  const [copiedKey, setCopiedKey] = useState<string>();
  const [feedback, setFeedback] = useState<{ text: string; alert: boolean }>();

  const activate = async (button: MessageInlineKeyboardButton, key: string) => {
    if (pendingKey) return;
    switch (button.kind) {
      case "callback": {
        setPendingKey(key);
        const answer = await onCallback(messageId, button.data);
        setPendingKey(undefined);
        if (answer?.url) await openExternalLink(answer.url);
        setFeedback(answer?.text ? { text: answer.text, alert: answer.showAlert } : undefined);
        return;
      }
      case "url":
      case "webApp":
        await openExternalLink(button.url);
        return;
      case "user":
        onOpenUser(button.userId);
        return;
      case "copyText":
        await writeClipboardText(button.copyText);
        setCopiedKey(key);
        globalThis.setTimeout(
          () => setCopiedKey((current) => current === key ? undefined : current),
          motionLifecycleTiming.transientIndicatorHold,
        );
        return;
      case "unsupported":
        return;
    }
  };

  return (
    <div className="message-inline-keyboard" aria-label="机器人快捷操作">
      {markup.rows.map((row, rowIndex) => (
        <div
          className="message-inline-keyboard-row"
          key={`${messageId}:${rowIndex}`}
          style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
        >
          {row.map((button, buttonIndex) => {
            const key = `${rowIndex}:${buttonIndex}`;
            const disabled = button.kind === "unsupported" || Boolean(pendingKey && pendingKey !== key);
            return (
              <button
                className={`is-${button.style}`}
                data-inline-keyboard-button-type={button.kind}
                disabled={disabled}
                key={key}
                type="button"
                title={button.kind === "unsupported" ? "暂不支持此操作" : button.text}
                onClick={() => void activate(button, key)}
              >
                {pendingKey === key
                  ? <LoaderCircle className="spin" size={14} />
                  : copiedKey === key ? <Check size={14} /> : button.text}
              </button>
            );
          })}
        </div>
      ))}
      {feedback && (
        <div className="message-inline-keyboard-feedback" role={feedback.alert ? "alert" : "status"}>
          {feedback.text}
        </div>
      )}
    </div>
  );
}
