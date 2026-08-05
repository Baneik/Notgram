import {
  Check,
  Edit3,
  LoaderCircle,
  Paperclip,
  Reply,
  Send,
  Smile,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useComposerAutoResize } from "../hooks/useComposerAutoResize";
import { usePreferencesStore } from "../store/preferencesStore";
import { useTelegramStore } from "../store/telegramStore";
import type { ConnectionStatus, Message } from "../telegram/types";
import { messageSummary } from "./conversationMessages";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";
import { EmojiPicker } from "./EmojiPicker";

interface ConversationComposerProps {
  chatId: string;
  editingMessage?: Message;
  replyingTo?: Message;
  contextTitle?: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  transportKind: "mock" | "tauri";
  connectionStatus: ConnectionStatus;
  queuedMessageCount: number;
  failedQueuedMessageCount: number;
  onSendMessage: (text: string, replyToMessageId?: string) => Promise<boolean>;
  onEditMessage: (messageId: string, text: string) => Promise<boolean>;
  onDraftChange: (chatId: string, text: string, replyToMessageId?: string) => void;
  onTypingChange: (chatId: string, typing: boolean) => Promise<void>;
  onSendFile: (file?: File) => Promise<boolean>;
  onCancelEditing: () => void;
  onCancelReply: () => void;
}

const LOCAL_DRAFT_DELAY_MS = 750;
const TYPING_REFRESH_MS = 4_000;
const TYPING_IDLE_MS = 5_000;
const EMOJI_HOVER_OPEN_DELAY_MS = 260;
const EMOJI_HOVER_CLOSE_DELAY_MS = 80;

export const ConversationComposer = memo(function ConversationComposer({
  chatId,
  editingMessage,
  replyingTo,
  contextTitle,
  inputRef,
  transportKind,
  connectionStatus,
  queuedMessageCount,
  failedQueuedMessageCount,
  onSendMessage,
  onEditMessage,
  onDraftChange,
  onTypingChange,
  onSendFile,
  onCancelEditing,
  onCancelReply,
}: ConversationComposerProps) {
  const chatDraft = useTelegramStore((state) => state.drafts.get(chatId));
  const [draft, setDraft] = useState(chatDraft?.text ?? "");
  const [composing, setComposing] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachmentPending, setAttachmentPending] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const sendOnEnter = usePreferencesStore((state) => state.sendOnEnter);
  const sendTypingStatus = usePreferencesStore((state) => state.sendTypingStatus);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  const composingRef = useRef(false);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingDraftRef = useRef<{ text: string; replyToMessageId?: string } | undefined>(undefined);
  const localDraftDirtyRef = useRef(false);
  const previousEditingRef = useRef<Message | undefined>(undefined);
  const draftBeforeEditRef = useRef<string | undefined>(undefined);
  const typingActiveRef = useRef(false);
  const typingRefreshRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const typingIdleRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const replyToMessageIdRef = useRef(replyingTo?.id ?? chatDraft?.replyToMessageId);
  const emojiOpenTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const emojiCloseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const emojiOpenedByHoverRef = useRef(false);

  useComposerAutoResize(inputRef, draft, !composing, chatId);

  const focusComposer = useCallback(() => {
    globalThis.setTimeout(() => inputRef.current?.focus(), 0);
  }, [inputRef]);

  const clearEmojiOpenTimer = useCallback(() => {
    if (emojiOpenTimerRef.current) globalThis.clearTimeout(emojiOpenTimerRef.current);
    emojiOpenTimerRef.current = undefined;
  }, []);

  const clearEmojiCloseTimer = useCallback(() => {
    if (emojiCloseTimerRef.current) globalThis.clearTimeout(emojiCloseTimerRef.current);
    emojiCloseTimerRef.current = undefined;
  }, []);

  const closeEmojiPicker = useCallback(() => {
    clearEmojiOpenTimer();
    clearEmojiCloseTimer();
    emojiOpenedByHoverRef.current = false;
    setEmojiPickerOpen(false);
  }, [clearEmojiCloseTimer, clearEmojiOpenTimer]);

  const scheduleEmojiPickerOpen = useCallback(() => {
    clearEmojiCloseTimer();
    if (editingMessage || emojiPickerOpen || emojiOpenTimerRef.current) return;
    emojiOpenTimerRef.current = globalThis.setTimeout(() => {
      emojiOpenTimerRef.current = undefined;
      emojiOpenedByHoverRef.current = true;
      setEmojiPickerOpen(true);
    }, EMOJI_HOVER_OPEN_DELAY_MS);
  }, [clearEmojiCloseTimer, editingMessage, emojiPickerOpen]);

  const scheduleEmojiPickerClose = useCallback(() => {
    clearEmojiOpenTimer();
    clearEmojiCloseTimer();
    emojiCloseTimerRef.current = globalThis.setTimeout(() => {
      emojiCloseTimerRef.current = undefined;
      emojiOpenedByHoverRef.current = false;
      setEmojiPickerOpen(false);
    }, EMOJI_HOVER_CLOSE_DELAY_MS);
  }, [clearEmojiCloseTimer, clearEmojiOpenTimer]);

  const toggleEmojiPicker = useCallback(() => {
    clearEmojiOpenTimer();
    clearEmojiCloseTimer();
    setEmojiPickerOpen((open) => {
      if (open && emojiOpenedByHoverRef.current) {
        emojiOpenedByHoverRef.current = false;
        return true;
      }
      emojiOpenedByHoverRef.current = false;
      return !open;
    });
  }, [clearEmojiCloseTimer, clearEmojiOpenTimer]);

  const flushDraft = useCallback(() => {
    if (draftTimerRef.current) globalThis.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = undefined;
    const pending = pendingDraftRef.current;
    pendingDraftRef.current = undefined;
    if (!pending) return;
    localDraftDirtyRef.current = false;
    onDraftChange(chatId, pending.text, pending.replyToMessageId);
  }, [chatId, onDraftChange]);

  const scheduleDraft = useCallback((text: string, replyToMessageId?: string) => {
    if (draftTimerRef.current) globalThis.clearTimeout(draftTimerRef.current);
    pendingDraftRef.current = { text, replyToMessageId };
    localDraftDirtyRef.current = true;
    draftTimerRef.current = globalThis.setTimeout(flushDraft, LOCAL_DRAFT_DELAY_MS);
  }, [flushDraft]);

  const stopTyping = useCallback(() => {
    if (typingRefreshRef.current) globalThis.clearInterval(typingRefreshRef.current);
    if (typingIdleRef.current) globalThis.clearTimeout(typingIdleRef.current);
    typingRefreshRef.current = undefined;
    typingIdleRef.current = undefined;
    if (!typingActiveRef.current) return;
    typingActiveRef.current = false;
    void onTypingChange(chatId, false);
  }, [chatId, onTypingChange]);

  const keepTyping = useCallback((text: string) => {
    if (!sendTypingStatus || editingMessage || !text.trim()) {
      stopTyping();
      return;
    }
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      void onTypingChange(chatId, true);
      typingRefreshRef.current = globalThis.setInterval(() => {
        if (typingActiveRef.current) void onTypingChange(chatId, true);
      }, TYPING_REFRESH_MS);
    }
    if (typingIdleRef.current) globalThis.clearTimeout(typingIdleRef.current);
    typingIdleRef.current = globalThis.setTimeout(stopTyping, TYPING_IDLE_MS);
  }, [chatId, editingMessage, onTypingChange, sendTypingStatus, stopTyping]);

  const commitInputSideEffects = useCallback((value: string) => {
    if (editingMessage) return;
    scheduleDraft(value, replyingTo?.id ?? chatDraft?.replyToMessageId);
    keepTyping(value);
  }, [chatDraft?.replyToMessageId, editingMessage, keepTyping, replyingTo?.id, scheduleDraft]);

  const finishComposition = useCallback((value: string) => {
    if (!composingRef.current) return;
    composingRef.current = false;
    setComposing(false);
    draftRef.current = value;
    setDraft(value);
    commitInputSideEffects(value);
  }, [commitInputSideEffects]);

  const insertEmoji = useCallback((emoji: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? draftRef.current.length;
    const end = input?.selectionEnd ?? start;
    const value = `${draftRef.current.slice(0, start)}${emoji}${draftRef.current.slice(end)}`;
    draftRef.current = value;
    setDraft(value);
    commitInputSideEffects(value);
    globalThis.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }, [commitInputSideEffects, inputRef]);

  useEffect(() => {
    const previous = previousEditingRef.current;
    if (editingMessage && previous?.id !== editingMessage.id) {
      if (!previous) draftBeforeEditRef.current = draftRef.current;
      if (draftTimerRef.current) flushDraft();
      draftRef.current = editingMessage.content.kind === "text" ? editingMessage.content.text : "";
      setDraft(draftRef.current);
      stopTyping();
      focusComposer();
    } else if (!editingMessage && previous) {
      draftRef.current = draftBeforeEditRef.current ?? chatDraft?.text ?? "";
      draftBeforeEditRef.current = undefined;
      setDraft(draftRef.current);
      focusComposer();
    }
    previousEditingRef.current = editingMessage;
  }, [chatDraft?.text, editingMessage, flushDraft, focusComposer, stopTyping]);

  useEffect(() => {
    if (editingMessage || localDraftDirtyRef.current) return;
    const incoming = chatDraft?.text ?? "";
    if (incoming === draftRef.current) return;
    draftRef.current = incoming;
    setDraft(incoming);
  }, [chatDraft?.text, editingMessage]);

  useEffect(() => {
    const replyToMessageId = replyingTo?.id ?? chatDraft?.replyToMessageId;
    if (replyToMessageIdRef.current === replyToMessageId) return;
    replyToMessageIdRef.current = replyToMessageId;
    if (!editingMessage) scheduleDraft(draftRef.current, replyToMessageId);
  }, [chatDraft?.replyToMessageId, editingMessage, replyingTo?.id, scheduleDraft]);

  useEffect(() => {
    if (!sendTypingStatus || editingMessage) stopTyping();
  }, [editingMessage, sendTypingStatus, stopTyping]);

  useEffect(() => {
    if (editingMessage) closeEmojiPicker();
  }, [closeEmojiPicker, editingMessage]);

  useEffect(() => () => {
    clearEmojiOpenTimer();
    clearEmojiCloseTimer();
  }, [clearEmojiCloseTimer, clearEmojiOpenTimer]);

  useEffect(() => () => {
    if (composingRef.current && !editingMessage) {
      pendingDraftRef.current = {
        text: draftRef.current,
        replyToMessageId: replyToMessageIdRef.current,
      };
    }
    flushDraft();
    stopTyping();
  }, [editingMessage, flushDraft, stopTyping]);

  const sendAttachment = async (file?: File) => {
    if (attachmentPending) return;
    setAttachmentPending(true);
    try {
      await onSendFile(file);
    } finally {
      setAttachmentPending(false);
    }
  };

  const submitMessage = async () => {
    const submitted = draftRef.current.trim();
    if (!submitted || sending) return;
    closeEmojiPicker();
    if (editingMessage) {
      setSending(true);
      const edited = await onEditMessage(editingMessage.id, submitted);
      setSending(false);
      if (edited) onCancelEditing();
      focusComposer();
      return;
    }

    if (draftTimerRef.current) globalThis.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = undefined;
    pendingDraftRef.current = undefined;
    localDraftDirtyRef.current = false;
    draftRef.current = "";
    setDraft("");
    onDraftChange(chatId, "", undefined);
    stopTyping();
    focusComposer();
    setSending(true);
    const sent = await onSendMessage(
      submitted,
      replyingTo?.id ?? chatDraft?.replyToMessageId,
    );
    setSending(false);
    if (sent) {
      onCancelReply();
    } else {
      const restored = draftRef.current ? `${submitted}\n${draftRef.current}` : submitted;
      draftRef.current = restored;
      setDraft(restored);
      scheduleDraft(restored, replyingTo?.id ?? chatDraft?.replyToMessageId);
    }
    focusComposer();
  };

  const composerContextMessage = editingMessage ?? replyingTo;

  return (
    <div className="composer-wrap">
      {emojiPickerOpen && !editingMessage && (
        <EmojiPicker
          chatId={chatId}
          replyToMessageId={replyingTo?.id ?? chatDraft?.replyToMessageId}
          onEmoji={insertEmoji}
          onClose={closeEmojiPicker}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") clearEmojiCloseTimer();
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") scheduleEmojiPickerClose();
          }}
        />
      )}
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (file) await sendAttachment(file);
          event.target.value = "";
        }}
      />
      {connectionStatus !== "online" && (
        <ConnectionStatusIndicator
          className="composer-connection-status"
          status={connectionStatus}
        />
      )}
      {(queuedMessageCount > 0 || failedQueuedMessageCount > 0) && (
        <div className="composer-outbox-status" role="status">
          {failedQueuedMessageCount > 0
            ? `${failedQueuedMessageCount} 条离线消息需要手动重试`
            : `${queuedMessageCount} 条消息将在联网后发送`}
        </div>
      )}
      {composerContextMessage && (
        <div className={`composer-context ${editingMessage ? "is-editing" : "is-replying"}`}>
          <span className="composer-context-icon">
            {editingMessage
              ? <Edit3 size={18} strokeWidth={1.9} />
              : <Reply size={18} strokeWidth={1.9} />}
          </span>
          <span className="composer-context-copy">
            <strong>{contextTitle}</strong>
            <small>{messageSummary(composerContextMessage.content)}</small>
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label={editingMessage ? "取消编辑" : "取消回复"}
            title={editingMessage ? "取消编辑" : "取消回复"}
            onClick={editingMessage ? onCancelEditing : onCancelReply}
          >
            <X size={17} strokeWidth={1.9} />
          </button>
        </div>
      )}
      <div className={`composer ${editingMessage ? "is-editing" : ""}`}>
        <button
          className="icon-button"
          type="button"
          aria-label="添加附件"
          title={composerContextMessage ? "完成当前消息操作后添加附件" : attachmentPending ? "正在选择文件" : "添加附件"}
          disabled={Boolean(composerContextMessage) || attachmentPending}
          onClick={() => {
            if (transportKind === "tauri") void sendAttachment();
            else fileInputRef.current?.click();
          }}
        >
          {attachmentPending
            ? <LoaderCircle className="spin" size={19} strokeWidth={1.8} />
            : <Paperclip size={20} strokeWidth={1.8} />}
        </button>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => {
            const value = event.target.value;
            draftRef.current = value;
            setDraft(value);
            if (!composingRef.current) commitInputSideEffects(value);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            setComposing(true);
            if (draftTimerRef.current) globalThis.clearTimeout(draftTimerRef.current);
            draftTimerRef.current = undefined;
            stopTyping();
          }}
          onCompositionEnd={(event) => finishComposition(event.currentTarget.value)}
          onFocus={() => {
            if (!composingRef.current) keepTyping(draftRef.current);
          }}
          onBlur={(event) => {
            finishComposition(event.currentTarget.value);
            stopTyping();
          }}
          onKeyDown={(event) => {
            const submitWithKeyboard = event.key === "Enter" && (
              (sendOnEnter && !event.shiftKey) ||
              (!sendOnEnter && (event.ctrlKey || event.metaKey))
            );
            if (!submitWithKeyboard || event.nativeEvent.isComposing || composingRef.current) return;
            event.preventDefault();
            void submitMessage();
          }}
          rows={1}
          placeholder={editingMessage ? "编辑消息" : "写一条消息"}
          aria-label="消息内容"
          aria-busy={sending}
        />
        <button
          className={`icon-button emoji-trigger ${emojiPickerOpen ? "is-active" : ""}`}
          type="button"
          aria-label="表情"
          aria-expanded={emojiPickerOpen}
          aria-controls="emoji-picker"
          title="表情"
          disabled={Boolean(editingMessage)}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") scheduleEmojiPickerOpen();
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") scheduleEmojiPickerClose();
          }}
          onClick={toggleEmojiPicker}
        >
          <Smile size={21} strokeWidth={1.8} />
        </button>
        <button
          className="send-button icon-button"
          type="button"
          aria-label={editingMessage ? "保存编辑" : "发送消息"}
          title={editingMessage ? "保存编辑" : "发送消息"}
          disabled={!draft.trim() || sending}
          onClick={() => void submitMessage()}
        >
          {editingMessage
            ? <Check size={19} strokeWidth={2.2} />
            : <Send size={19} strokeWidth={2} />}
        </button>
      </div>
    </div>
  );
});
