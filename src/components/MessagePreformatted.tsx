import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { translate } from "../i18n";
import { writeClipboardText } from "../utils/clipboard";
import { motionLifecycleTiming } from "../utils/motionTokens";

interface MessagePreformattedProps {
  text: string;
  language?: string;
  children: ReactNode;
}

export function MessagePreformatted({ text, language, children }: MessagePreformattedProps) {
  useTranslation();
  const [feedback, setFeedback] = useState<"copied" | "failed">();
  const operationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    setFeedback(undefined);
    return () => {
      operationRef.current += 1;
      clearTimeout(timerRef.current);
    };
  }, [text]);

  const copy = async () => {
    const operation = ++operationRef.current;
    clearTimeout(timerRef.current);
    let result: "copied" | "failed";
    try {
      await writeClipboardText(text);
      result = "copied";
    } catch {
      result = "failed";
    }
    if (operation !== operationRef.current) return;
    setFeedback(result);
    timerRef.current = setTimeout(() => setFeedback(undefined), motionLifecycleTiming.transientIndicatorHold);
  };
  const label = feedback === "copied" ? translate("已复制")
    : feedback === "failed" ? translate("无法访问剪贴板，请使用键盘快捷键") : translate("复制文本");

  return (
    <span className="message-preformatted">
      <code className="rich-pre" data-language={language}>{children}</code>
      <button
        className={`message-preformatted-copy${feedback ? " has-feedback" : ""}`}
        type="button"
        aria-label={label}
        title={label}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); void copy(); }}
      >
        {feedback === "copied" ? <Check size={14} /> : feedback === "failed" ? <X size={14} /> : <Copy size={14} />}
      </button>
    </span>
  );
}
