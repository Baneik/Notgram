import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  CallbackQueryAnswer,
  MessageInlineKeyboard,
  MessageInlineKeyboardButton,
} from "../telegram/types";
import { writeClipboardText } from "../utils/clipboard";
import { openExternalLink } from "../utils/externalLinks";
import { motionLifecycleTiming } from "../utils/motionTokens";

// A callback answer can legitimately wait for the bot, but that request must
// not keep the local keyboard disabled until TDLib's network timeout.
const CALLBACK_PENDING_MAX_MS = 1_500;

interface InlineKeyboardProps {
  messageId: string;
  chatId?: string;
  markup: MessageInlineKeyboard;
  onCallback: (messageId: string, data: string, chatId?: string) => Promise<CallbackQueryAnswer | undefined>;
  onOpenUser: (userId: string) => void;
}

export function InlineKeyboard({
  messageId,
  chatId,
  markup,
  onCallback,
  onOpenUser,
}: InlineKeyboardProps) {
  const [pendingKey, setPendingKey] = useState<string>();
  const [copiedKey, setCopiedKey] = useState<string>();
  const [feedback, setFeedback] = useState<{ text: string; alert: boolean }>();
  const pendingKeyRef = useRef<string | undefined>(undefined);
  const pendingTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const interactionRef = useRef(0);
  const markupSignature = JSON.stringify(markup.rows);
  const previousMarkupSignatureRef = useRef(markupSignature);

  const clearPending = (interaction?: number) => {
    if (interaction !== undefined && interactionRef.current !== interaction) return;
    if (pendingTimerRef.current) globalThis.clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = undefined;
    pendingKeyRef.current = undefined;
    setPendingKey(undefined);
  };

  useEffect(() => {
    if (previousMarkupSignatureRef.current !== markupSignature) {
      previousMarkupSignatureRef.current = markupSignature;
      interactionRef.current += 1;
      clearPending();
    }
  }, [markupSignature]);

  useEffect(() => () => {
    if (pendingTimerRef.current) globalThis.clearTimeout(pendingTimerRef.current);
  }, []);

  const activate = async (button: MessageInlineKeyboardButton, key: string) => {
    if (pendingKeyRef.current) return;
    switch (button.kind) {
      case "callback": {
        const interaction = ++interactionRef.current;
        pendingKeyRef.current = key;
        setPendingKey(key);
        pendingTimerRef.current = globalThis.setTimeout(() => {
          clearPending(interaction);
        }, CALLBACK_PENDING_MAX_MS);
        try {
          const answer = await onCallback(messageId, button.data, chatId);
          if (interactionRef.current !== interaction) return;
          clearPending(interaction);
          if (answer?.url) await openExternalLink(answer.url);
          setFeedback(answer?.text ? { text: answer.text, alert: answer.showAlert } : undefined);
        } catch {
          // The store records the request error. The local indicator still has
          // to settle when an alternative transport implementation rejects.
          clearPending(interaction);
        }
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
