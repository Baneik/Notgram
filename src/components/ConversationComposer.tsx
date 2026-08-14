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
import { inspectOutgoingAttachment } from "../media/outgoingAttachments";
import { usePreferencesStore } from "../store/preferencesStore";
import { useTelegramStore } from "../store/telegramStore";
import type { BotCommandSuggestion, ConnectionStatus, InlineQueryResultPage, Message, MessageReplyQuote, OutgoingAttachment } from "../telegram/types";
import { TELEGRAM_ALBUM_MAX_ITEMS } from "../telegram/types";
import {
  composerInlineQueryForDraft,
  insertComposerText,
  type ComposerTextInsertion,
} from "../utils/composerInsertion";
import { messageSummary } from "./conversationMessages";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";
import { EmojiPicker } from "./EmojiPicker";

interface ConversationComposerProps {
  chatId: string;
  draftKey?: string;
  editingMessage?: Message;
  replyingTo?: Message;
  replyQuote?: MessageReplyQuote;
  contextTitle?: string;
  defaultBotUsername?: string;
  textInsertion?: ComposerTextInsertion;
  knownNonBotUsernames?: ReadonlySet<string>;
  onTextInsertionApplied?: (id: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  connectionStatus: ConnectionStatus;
  queuedMessageCount: number;
  failedQueuedMessageCount: number;
  queuedAttachmentCount: number;
  failedAttachmentCount: number;
  onSendMessage: (text: string, replyToMessageId?: string, replyQuote?: MessageReplyQuote) => Promise<boolean>;
  onEditMessage: (messageId: string, text: string) => Promise<boolean>;
  onDraftChange: (chatId: string, text: string, replyToMessageId?: string, replyQuote?: MessageReplyQuote) => void;
  onTypingChange: (chatId: string, typing: boolean) => Promise<void>;
  onSendFiles: (attachments: OutgoingAttachment[], caption?: string) => Promise<boolean>;
  onCancelEditing: () => void;
  onCancelReply: () => void;
  onGetBotCommands: (query?: string, botUsername?: string) => Promise<BotCommandSuggestion[]>;
  onGetInlineResults: (botUsername: string, query: string, offset?: string) => Promise<InlineQueryResultPage | undefined>;
  onSendInlineResult: (botUserId: string, queryId: string, resultId: string, replyToMessageId?: string) => Promise<boolean>;
  onSendBotStart: (botUserId: string, parameter?: string) => Promise<boolean>;
}

const LOCAL_DRAFT_DELAY_MS = 750;
const TYPING_REFRESH_MS = 4_000;
const TYPING_IDLE_MS = 5_000;
const EMOJI_HOVER_OPEN_DELAY_MS = 260;
const EMOJI_HOVER_CLOSE_DELAY_MS = 80;

interface PendingAttachment {
  id: string;
  attachment: OutgoingAttachment;
  previewUrl?: string;
}

export const ConversationComposer = memo(function ConversationComposer({
  chatId,
  draftKey = chatId,
  editingMessage,
  replyingTo,
  replyQuote,
  contextTitle,
  defaultBotUsername,
  textInsertion,
  knownNonBotUsernames,
  onTextInsertionApplied,
  inputRef,
  connectionStatus,
  queuedMessageCount,
  failedQueuedMessageCount,
  queuedAttachmentCount,
  failedAttachmentCount,
  onSendMessage,
  onEditMessage,
  onDraftChange,
  onTypingChange,
  onSendFiles,
  onCancelEditing,
  onCancelReply,
  onGetBotCommands,
  onGetInlineResults,
  onSendInlineResult,
  onSendBotStart,
}: ConversationComposerProps) {
  const chatDraft = useTelegramStore((state) => state.drafts.get(draftKey));
  const activeReplyQuote = replyingTo ? replyQuote : chatDraft?.replyQuote;
  const [draft, setDraft] = useState(chatDraft?.text ?? "");
  const [composing, setComposing] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachmentPending, setAttachmentPending] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string>();
  const [attachmentMode, setAttachmentMode] = useState<"media" | "file">("media");
  const [attachmentSpoiler, setAttachmentSpoiler] = useState(false);
  const [attachmentCaptionAbove, setAttachmentCaptionAbove] = useState(false);
  const [muteVideos, setMuteVideos] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [botSuggestions, setBotSuggestions] = useState<BotCommandSuggestion[]>([]);
  const [activeBotSuggestionIndex, setActiveBotSuggestionIndex] = useState(0);
  const [inlineResults, setInlineResults] = useState<InlineQueryResultPage>();
  const [inlineLoading, setInlineLoading] = useState(false);
  const selectedBotRef = useRef<BotCommandSuggestion | undefined>(undefined);
  const botQueryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const botQueryGenerationRef = useRef(0);
  const sendOnEnter = usePreferencesStore((state) => state.sendOnEnter);
  const sendTypingStatus = usePreferencesStore((state) => state.sendTypingStatus);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  const composingRef = useRef(false);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingDraftRef = useRef<{
    text: string;
    replyToMessageId?: string;
    replyQuote?: MessageReplyQuote;
  } | undefined>(undefined);
  const localDraftDirtyRef = useRef(false);
  const previousEditingRef = useRef<Message | undefined>(undefined);
  const draftBeforeEditRef = useRef<string | undefined>(undefined);
  const typingActiveRef = useRef(false);
  const typingRefreshRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const typingIdleRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const replyToMessageIdRef = useRef(replyingTo?.id ?? chatDraft?.replyToMessageId);
  const replyQuoteRef = useRef<MessageReplyQuote | undefined>(activeReplyQuote);
  const emojiOpenTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const emojiCloseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const emojiOpenedByHoverRef = useRef(false);
  const pendingAttachmentsRef = useRef(pendingAttachments);
  const appliedTextInsertionRef = useRef<string | undefined>(undefined);

  pendingAttachmentsRef.current = pendingAttachments;

  useEffect(() => {
    const generation = ++botQueryGenerationRef.current;
    if (botQueryTimerRef.current) globalThis.clearTimeout(botQueryTimerRef.current);
    const slash = !editingMessage ? draft.match(/^\/([A-Za-z0-9_]*)(?:@([A-Za-z0-9_]{5,32}))?$/) : null;
    const inline = !editingMessage ? composerInlineQueryForDraft(draft, knownNonBotUsernames) : undefined;
    if (slash) {
      const username = slash[2] || defaultBotUsername;
      selectedBotRef.current = undefined;
      setBotSuggestions([]);
      setActiveBotSuggestionIndex(0);
      botQueryTimerRef.current = globalThis.setTimeout(() => {
        void onGetBotCommands(slash[1], username)
          .then((suggestions) => {
            if (botQueryGenerationRef.current === generation) {
              setBotSuggestions(suggestions);
              setActiveBotSuggestionIndex(0);
            }
          })
          .catch(() => {
            if (botQueryGenerationRef.current === generation) setBotSuggestions([]);
          });
      }, 80);
      setInlineResults(undefined);
    } else if (inline) {
      setBotSuggestions([]);
      setActiveBotSuggestionIndex(0);
      selectedBotRef.current = undefined;
      setInlineLoading(true);
      botQueryTimerRef.current = globalThis.setTimeout(() => {
        void onGetInlineResults(inline.username, inline.query)
          .then((page) => {
            if (botQueryGenerationRef.current !== generation) return;
            setInlineResults(page);
            setInlineLoading(false);
          })
          .catch(() => {
            if (botQueryGenerationRef.current !== generation) return;
            setInlineResults(undefined);
            setInlineLoading(false);
          });
      }, 180);
    } else {
      setBotSuggestions([]);
      setActiveBotSuggestionIndex(0);
      setInlineResults(undefined);
      setInlineLoading(false);
    }
    return () => {
      if (botQueryTimerRef.current) globalThis.clearTimeout(botQueryTimerRef.current);
    };
  }, [defaultBotUsername, draft, editingMessage, knownNonBotUsernames, onGetBotCommands, onGetInlineResults]);

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
    onDraftChange(chatId, pending.text, pending.replyToMessageId, pending.replyQuote);
  }, [chatId, onDraftChange]);

  const scheduleDraft = useCallback((
    text: string,
    replyToMessageId?: string,
    selectedReplyQuote?: MessageReplyQuote,
  ) => {
    if (draftTimerRef.current) globalThis.clearTimeout(draftTimerRef.current);
    pendingDraftRef.current = { text, replyToMessageId, replyQuote: selectedReplyQuote };
    localDraftDirtyRef.current = true;
    draftTimerRef.current = globalThis.setTimeout(flushDraft, LOCAL_DRAFT_DELAY_MS);
  }, [flushDraft]);

  const applyBotSuggestion = useCallback((suggestion: BotCommandSuggestion) => {
    selectedBotRef.current = suggestion;
    const includeUsername = Boolean(
      suggestion.botUsername &&
      suggestion.botUsername.toLocaleLowerCase() !== defaultBotUsername?.toLocaleLowerCase()
    );
    const next = `/${suggestion.command}${includeUsername ? `@${suggestion.botUsername}` : ""} `;
    draftRef.current = next;
    setDraft(next);
    scheduleDraft(next, replyingTo?.id ?? chatDraft?.replyToMessageId, activeReplyQuote);
    focusComposer();
  }, [activeReplyQuote, chatDraft?.replyToMessageId, defaultBotUsername, focusComposer, replyingTo?.id, scheduleDraft]);

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
    scheduleDraft(value, replyingTo?.id ?? chatDraft?.replyToMessageId, activeReplyQuote);
    keepTyping(value);
  }, [activeReplyQuote, chatDraft?.replyToMessageId, editingMessage, keepTyping, replyingTo?.id, scheduleDraft]);

  useEffect(() => {
    if (!textInsertion || textInsertion.draftKey !== draftKey || editingMessage || appliedTextInsertionRef.current === textInsertion.id) return;
    appliedTextInsertionRef.current = textInsertion.id;
    const input = inputRef.current;
    const result = insertComposerText(
      draftRef.current,
      textInsertion.text,
      input?.selectionStart ?? draftRef.current.length,
      input?.selectionEnd ?? draftRef.current.length,
    );
    draftRef.current = result.value;
    setDraft(result.value);
    commitInputSideEffects(result.value);
    onTextInsertionApplied?.(textInsertion.id);
    globalThis.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(result.cursor, result.cursor);
    });
  }, [commitInputSideEffects, draftKey, editingMessage, inputRef, onTextInsertionApplied, textInsertion]);

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
    const quoteChanged = JSON.stringify(replyQuoteRef.current) !== JSON.stringify(activeReplyQuote);
    if (replyToMessageIdRef.current === replyToMessageId && !quoteChanged) return;
    replyToMessageIdRef.current = replyToMessageId;
    replyQuoteRef.current = activeReplyQuote;
    if (!editingMessage) scheduleDraft(draftRef.current, replyToMessageId, activeReplyQuote);
  }, [activeReplyQuote, chatDraft?.replyToMessageId, editingMessage, replyingTo?.id, scheduleDraft]);

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
        replyQuote: replyQuoteRef.current,
      };
    }
    flushDraft();
    stopTyping();
  }, [editingMessage, flushDraft, stopTyping]);

  useEffect(() => () => {
    for (const attachment of pendingAttachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);

  const addPendingAttachments = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setPendingAttachments((current) => {
      const available = Math.max(0, TELEGRAM_ALBUM_MAX_ITEMS - current.length);
      const accepted = files.slice(0, available).map((file) => ({
        id: crypto.randomUUID(),
        attachment: {
          file,
          kind: "document" as const,
        },
        previewUrl: file.type.startsWith("image/") || file.type.startsWith("video/")
          ? URL.createObjectURL(file)
          : undefined,
      }));
      for (const pending of accepted) {
        void inspectOutgoingAttachment(pending.attachment.file).then((attachment) => {
          setPendingAttachments((latest) => latest.map((candidate) =>
            candidate.id === pending.id ? { ...candidate, attachment } : candidate,
          ));
        });
      }
      setAttachmentNotice(files.length > available
        ? `一次最多发送 ${TELEGRAM_ALBUM_MAX_ITEMS} 个附件`
        : undefined);
      return [...current, ...accepted];
    });
  }, []);

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((attachment) => attachment.id !== id);
    });
    setAttachmentNotice(undefined);
    focusComposer();
  }, [focusComposer]);

  const sendPendingAttachments = async () => {
    if (attachmentPending || pendingAttachments.length === 0) return;
    const caption = draftRef.current.trim();
    setAttachmentPending(true);
    try {
      const inspectedAttachments = await Promise.all(
        pendingAttachments.map(({ attachment }) => inspectOutgoingAttachment(attachment.file)),
      );
      const sent = await onSendFiles(
        inspectedAttachments.map((attachment) => ({
          ...attachment,
          kind: attachmentMode === "file"
            ? "document"
            : muteVideos && attachment.kind === "video"
              ? "animation"
              : attachment.kind,
          hasSpoiler: attachmentMode === "media" && attachmentSpoiler,
          showCaptionAboveMedia: attachmentMode === "media" && attachmentCaptionAbove,
        })),
        caption || undefined,
      );
      if (!sent) return;
      for (const attachment of pendingAttachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      setPendingAttachments([]);
      setAttachmentNotice(undefined);
      setAttachmentMode("media");
      setAttachmentSpoiler(false);
      setAttachmentCaptionAbove(false);
      setMuteVideos(false);
      if (draftTimerRef.current) globalThis.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = undefined;
      pendingDraftRef.current = undefined;
      localDraftDirtyRef.current = false;
      draftRef.current = "";
      setDraft("");
      onDraftChange(chatId, "", undefined, undefined);
      stopTyping();
      focusComposer();
    } finally {
      setAttachmentPending(false);
    }
  };

  const submitMessage = async () => {
    if (!editingMessage && pendingAttachments.length > 0) {
      closeEmojiPicker();
      await sendPendingAttachments();
      return;
    }
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

    const startCommand = submitted.match(/^\/start(?:@([A-Za-z0-9_]{5,32}))?(?:\s+(.+))?$/);
    const startBot = selectedBotRef.current;
    const requestedBotUsername = startCommand?.[1] ?? defaultBotUsername;
    const canUseBotStartApi = startCommand && startBot && startBot.command === "start" &&
      Boolean(requestedBotUsername) &&
      startBot.botUsername.toLocaleLowerCase() === requestedBotUsername?.toLocaleLowerCase();
    if (startCommand && startBot && canUseBotStartApi) {
      if (draftTimerRef.current) globalThis.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = undefined;
      pendingDraftRef.current = undefined;
      localDraftDirtyRef.current = false;
      draftRef.current = "";
      setDraft("");
      onDraftChange(chatId, "", undefined, undefined);
      stopTyping();
      setSending(true);
      const sent = await onSendBotStart(startBot.botUserId, startCommand[2]);
      setSending(false);
      if (!sent) { draftRef.current = submitted; setDraft(submitted); scheduleDraft(submitted, replyingTo?.id ?? chatDraft?.replyToMessageId, activeReplyQuote); }
      else onCancelReply();
      focusComposer();
      return;
    }

    if (draftTimerRef.current) globalThis.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = undefined;
    pendingDraftRef.current = undefined;
    localDraftDirtyRef.current = false;
    draftRef.current = "";
    setDraft("");
    onDraftChange(chatId, "", undefined, undefined);
    stopTyping();
    focusComposer();
    setSending(true);
    const sent = await onSendMessage(
      submitted,
      replyingTo?.id ?? chatDraft?.replyToMessageId,
      activeReplyQuote,
    );
    setSending(false);
    if (sent) {
      onCancelReply();
    } else {
      const restored = draftRef.current ? `${submitted}\n${draftRef.current}` : submitted;
      draftRef.current = restored;
      setDraft(restored);
      scheduleDraft(restored, replyingTo?.id ?? chatDraft?.replyToMessageId, activeReplyQuote);
    }
    focusComposer();
  };

  const cancelReply = useCallback(() => {
    if (draftTimerRef.current) globalThis.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = undefined;
    pendingDraftRef.current = undefined;
    localDraftDirtyRef.current = false;
    replyToMessageIdRef.current = undefined;
    replyQuoteRef.current = undefined;
    onDraftChange(chatId, draftRef.current, undefined, undefined);
    onCancelReply();
    focusComposer();
  }, [chatId, focusComposer, onCancelReply, onDraftChange]);

  const composerContextMessage = editingMessage ?? replyingTo;

  return (
    <div className="composer-wrap">
      {emojiPickerOpen && !editingMessage && (
        <EmojiPicker
          chatId={chatId}
          replyToMessageId={replyingTo?.id ?? chatDraft?.replyToMessageId}
          onEmoji={insertEmoji}
          onClose={closeEmojiPicker}
          onRequestComposerFocus={focusComposer}
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
        multiple
        onChange={async (event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) addPendingAttachments(files);
          event.target.value = "";
          focusComposer();
        }}
      />
      {pendingAttachments.length > 0 && (
        <section className="composer-attachment-preview" aria-label="待发送附件">
          <div className="composer-attachment-grid" data-count={pendingAttachments.length}>
            {pendingAttachments.map((attachment) => (
              <article className="composer-attachment-item" key={attachment.id}>
                {attachment.previewUrl ? (
                  attachment.attachment.kind === "video" ? (
                    <video src={attachment.previewUrl} aria-label={attachment.attachment.file.name} muted />
                  ) : (
                    <img src={attachment.previewUrl} alt={attachment.attachment.file.name} />
                  )
                ) : (
                  <span className="composer-file-preview"><Paperclip size={22} /></span>
                )}
                <span className="composer-attachment-kind">{attachment.attachment.kind}</span>
                <span className="composer-attachment-name">{attachment.attachment.file.name}</span>
                <button
                  type="button"
                  aria-label={`移除 ${attachment.attachment.file.name}`}
                  onClick={() => removePendingAttachment(attachment.id)}
                >
                  <X size={14} />
                </button>
              </article>
            ))}
          </div>
          <div className="composer-attachment-options">
            <fieldset className="attachment-mode-control">
              <legend className="sr-only">附件发送方式</legend>
              <label>
                <input
                  type="radio"
                  name="attachment-mode"
                  checked={attachmentMode === "media"}
                  onChange={() => setAttachmentMode("media")}
                />
                <span>媒体</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="attachment-mode"
                  checked={attachmentMode === "file"}
                  onChange={() => setAttachmentMode("file")}
                />
                <span>原文件</span>
              </label>
            </fieldset>
            <label>
              <input
                type="checkbox"
                checked={attachmentSpoiler}
                disabled={attachmentMode === "file"}
                onChange={(event) => setAttachmentSpoiler(event.target.checked)}
              />
              剧透
            </label>
            <label>
              <input
                type="checkbox"
                checked={attachmentCaptionAbove}
                disabled={attachmentMode === "file"}
                onChange={(event) => setAttachmentCaptionAbove(event.target.checked)}
              />
              说明置顶
            </label>
            {pendingAttachments.some(({ attachment }) => attachment.kind === "video") && (
              <label>
                <input
                  type="checkbox"
                  checked={muteVideos}
                  disabled={attachmentMode === "file"}
                  onChange={(event) => setMuteVideos(event.target.checked)}
                />
                作为静音动画
              </label>
            )}
          </div>
          <footer>
            <span role={attachmentNotice ? "alert" : "status"}>
              {attachmentNotice ?? `${pendingAttachments.length} / ${TELEGRAM_ALBUM_MAX_ITEMS}`}
            </span>
            <button
              className="dialog-primary"
              type="button"
              disabled={attachmentPending}
              onClick={() => void sendPendingAttachments()}
            >
              {attachmentPending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
              <span>发送附件</span>
            </button>
          </footer>
        </section>
      )}
      {connectionStatus !== "online" && connectionStatus !== "syncing" && (
        <ConnectionStatusIndicator
          className="composer-connection-status"
          status={connectionStatus}
        />
      )}
      {(queuedMessageCount > 0 || failedQueuedMessageCount > 0 || queuedAttachmentCount > 0 || failedAttachmentCount > 0) && (
        <div className="composer-outbox-status" role="status">
          {[
            failedQueuedMessageCount > 0 ? `${failedQueuedMessageCount} 条离线消息需要手动重试` : undefined,
            failedAttachmentCount > 0 ? `${failedAttachmentCount} 个离线附件需要手动重试` : undefined,
            queuedMessageCount > 0 ? `${queuedMessageCount} 条消息将在联网后发送` : undefined,
            queuedAttachmentCount > 0 ? `${queuedAttachmentCount} 个附件将在联网后上传` : undefined,
          ].filter(Boolean).join("；")}
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
            <small>{editingMessage
              ? messageSummary(composerContextMessage.content)
              : activeReplyQuote?.text ?? messageSummary(composerContextMessage.content)}</small>
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label={editingMessage ? "取消编辑" : "取消回复"}
            title={editingMessage ? "取消编辑" : "取消回复"}
            onClick={editingMessage ? onCancelEditing : cancelReply}
          >
            <X size={17} strokeWidth={1.9} />
          </button>
        </div>
      )}
      {botSuggestions.length > 0 && (
        <section className="bot-suggestion-panel" role="listbox" aria-label="机器人命令建议">
          {botSuggestions.map((suggestion, index) => (
            <button
              className={index === activeBotSuggestionIndex ? "is-active" : ""}
              key={`${suggestion.botUserId}-${suggestion.command}`}
              type="button"
              role="option"
              aria-selected={index === activeBotSuggestionIndex}
              onPointerEnter={() => setActiveBotSuggestionIndex(index)}
              onClick={() => applyBotSuggestion(suggestion)}
            >
              <span className="bot-suggestion-command">
                <strong>/{suggestion.command}</strong>
                {suggestion.botUsername && <small>@{suggestion.botUsername}</small>}
              </span>
              <span className="bot-suggestion-description">{suggestion.description}</span>
            </button>
          ))}
        </section>
      )}
      {(inlineLoading || inlineResults) && (
        <section className="inline-query-panel" aria-label="Inline 查询结果">
          {inlineLoading ? <div className="inline-query-loading"><LoaderCircle className="spin" size={18} />正在查询机器人</div> : inlineResults?.results.map((result) => <button key={result.id} type="button" className="inline-query-result" onClick={async () => { const inline = composerInlineQueryForDraft(draftRef.current, knownNonBotUsernames); if (!inline || !inlineResults) return; const bot = await onGetBotCommands("", inline.username); const botUserId = bot[0]?.botUserId ?? `bot:${inline.username}`; setSending(true); const sent = await onSendInlineResult(botUserId, inlineResults.queryId, result.id, replyingTo?.id ?? chatDraft?.replyToMessageId); setSending(false); if (sent) { draftRef.current = ""; setDraft(""); onDraftChange(chatId, "", undefined); setInlineResults(undefined); onCancelReply(); } focusComposer(); }}><span className="inline-query-result-kind">{result.kind === "photo" ? "图片" : result.kind === "file" ? "文件" : "结果"}</span><span><strong>{result.title}</strong><small>{result.description || result.messageText}</small></span></button>)}
          {inlineResults?.hasMore && <button type="button" className="inline-query-more" onClick={() => { const inline = composerInlineQueryForDraft(draftRef.current, knownNonBotUsernames); if (inline && inlineResults.nextOffset) { setInlineLoading(true); void onGetInlineResults(inline.username, inline.query, inlineResults.nextOffset).then((page) => { if (page) setInlineResults((current) => current ? { ...page, results: [...current.results, ...page.results] } : page); setInlineLoading(false); }).catch(() => setInlineLoading(false)); } }}>加载更多结果</button>}
        </section>
      )}
      <div className={`composer ${editingMessage ? "is-editing" : ""}`}>
        <button
          className="icon-button"
          type="button"
          aria-label="添加附件"
          title={composerContextMessage ? "完成当前消息操作后添加附件" : attachmentPending ? "正在选择文件" : "添加附件"}
          disabled={Boolean(composerContextMessage) || attachmentPending}
          onClick={() => {
            fileInputRef.current?.click();
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
          onPaste={(event) => {
            if (editingMessage || replyingTo) return;
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            addPendingAttachments(files);
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
            if (!event.nativeEvent.isComposing && !composingRef.current && botSuggestions.length > 0) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const direction = event.key === "ArrowDown" ? 1 : -1;
                setActiveBotSuggestionIndex((current) =>
                  (current + direction + botSuggestions.length) % botSuggestions.length
                );
                return;
              }
              if (
                (event.key === "Enter" || event.key === "Tab") &&
                !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
              ) {
                event.preventDefault();
                applyBotSuggestion(
                  botSuggestions[Math.min(activeBotSuggestionIndex, botSuggestions.length - 1)],
                );
                return;
              }
            }
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
          disabled={(!draft.trim() && pendingAttachments.length === 0) || sending || attachmentPending}
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
