import {
  Check,
  Edit3,
  FileText,
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type RefObject,
} from "react";
import { useComposerAutoResize } from "../hooks/useComposerAutoResize";
import { useStableVisibility } from "../hooks/useStableVisibility";
import {
  canPreviewOutgoingAttachment,
  canSendAttachmentAsMedia,
  classifyOutgoingAttachment,
  inspectOutgoingAttachment,
} from "../media/outgoingAttachments";
import {
  closeMediaViewerWindowSession,
  openMediaViewerWindow,
  syncMediaViewerWindowSession,
} from "../media/mediaViewerWindowBridge";
import {
  closeVideoPreviewWindow,
  openVideoPreviewWindow,
} from "../media/videoWindowBridge";
import { usePreferencesStore } from "../store/preferencesStore";
import { useTelegramStore } from "../store/telegramStore";
import { colorThemeForThemeId } from "../theme/theme";
import type { AttachmentSendMode, BotCommandSuggestion, ConnectionStatus, InlineQueryResultPage, Message, MessageReplyQuote, MessageTextEntity, OutgoingAttachment } from "../telegram/types";
import { TELEGRAM_ALBUM_MAX_ITEMS } from "../telegram/types";
import type { PhotoMessage } from "../utils/mediaViewerModel";
import { motionLifecycleTiming } from "../utils/motionTokens";
import {
  composerInlineQueryForDraft,
  insertComposerMention,
  insertComposerText,
  type ComposerTextInsertion,
} from "../utils/composerInsertion";
import {
  prependComposerFormattedText,
  reconcileComposerMentionEntities,
  trimComposerFormattedText,
} from "../utils/composerMentions";
import { messageSummary } from "./conversationMessages";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";
import { EmojiPicker } from "./EmojiPicker";
import { MotionPresence } from "./MotionPresence";
import { MediaSpoiler } from "./Spoiler";
import { StableImage } from "./StableImage";

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
  onGeometryChange?: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  connectionStatus: ConnectionStatus;
  queuedMessageCount: number;
  failedQueuedMessageCount: number;
  queuedAttachmentCount: number;
  failedAttachmentCount: number;
  onSendMessage: (text: string, replyToMessageId?: string, replyQuote?: MessageReplyQuote, entities?: MessageTextEntity[]) => Promise<boolean>;
  onEditMessage: (messageId: string, text: string, entities?: MessageTextEntity[]) => Promise<boolean>;
  onDraftChange: (chatId: string, text: string, replyToMessageId?: string, replyQuote?: MessageReplyQuote, entities?: MessageTextEntity[]) => void;
  onTypingChange: (chatId: string, typing: boolean) => Promise<void>;
  onSendFiles: (attachments: OutgoingAttachment[], caption?: string, captionEntities?: MessageTextEntity[]) => Promise<boolean>;
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

interface PendingAttachment {
  id: string;
  attachment: OutgoingAttachment;
  previewUrl?: string;
}

type AttachmentPreviewSession =
  | { kind: "photo"; id: string; draftKey: string }
  | { kind: "video"; id: string; draftKey: string; attachmentId: string };

const ATTACHMENT_KIND_LABELS: Record<OutgoingAttachment["kind"], string> = {
  photo: "图片",
  video: "视频",
  audio: "音频",
  animation: "GIF",
  document: "文件",
};

const attachmentSizeLabel = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

const pendingAttachmentFrom = (attachment: OutgoingAttachment): PendingAttachment => ({
  id: crypto.randomUUID(),
  attachment,
  previewUrl: canPreviewOutgoingAttachment(attachment.kind)
    ? URL.createObjectURL(attachment.file)
    : undefined,
});

const ignoreViewerFileAction = async () => undefined;

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
  onGeometryChange,
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
  const localAttachmentDraft = useTelegramStore((state) => state.localAttachmentDrafts.get(draftKey));
  const loadLocalAttachmentDraft = useTelegramStore((state) => state.loadLocalAttachmentDraft);
  const saveLocalAttachmentDraft = useTelegramStore((state) => state.saveLocalAttachmentDraft);
  const updateLocalAttachmentDraftOptions = useTelegramStore((state) => state.updateLocalAttachmentDraftOptions);
  const clearLocalAttachmentDraft = useTelegramStore((state) => state.clearLocalAttachmentDraft);
  const activeReplyQuote = replyingTo ? replyQuote : chatDraft?.replyQuote;
  const composerContextMessage = editingMessage ?? replyingTo;
  const composerContextKey = editingMessage
    ? `edit:${editingMessage.id}`
    : replyingTo
      ? `reply:${replyingTo.id}`
      : "";
  const [draft, setDraft] = useState(chatDraft?.text ?? "");
  const [composing, setComposing] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachmentPending, setAttachmentPending] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string>();
  const [attachmentMode, setAttachmentMode] = useState<AttachmentSendMode>(localAttachmentDraft?.mode ?? "media");
  const [attachmentSpoiler, setAttachmentSpoiler] = useState(localAttachmentDraft?.hasSpoiler ?? false);
  const [muteVideos, setMuteVideos] = useState(localAttachmentDraft?.muteVideos ?? false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [botSuggestions, setBotSuggestions] = useState<BotCommandSuggestion[]>([]);
  const [activeBotSuggestionIndex, setActiveBotSuggestionIndex] = useState(0);
  const [inlineResults, setInlineResults] = useState<InlineQueryResultPage>();
  const [inlineLoading, setInlineLoading] = useState(false);
  const showSending = useStableVisibility(sending, { minimumVisible: 220 });
  const showAttachmentPending = useStableVisibility(attachmentPending, { minimumVisible: 220 });
  const showInlineLoading = useStableVisibility(inlineLoading);
  const selectedBotRef = useRef<BotCommandSuggestion | undefined>(undefined);
  const botQueryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const botQueryGenerationRef = useRef(0);
  const sendOnEnter = usePreferencesStore((state) => state.sendOnEnter);
  const sendTypingStatus = usePreferencesStore((state) => state.sendTypingStatus);
  const colorTheme = usePreferencesStore((state) => colorThemeForThemeId(state.themeId));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  const mentionEntitiesRef = useRef<MessageTextEntity[]>(chatDraft?.entities ?? []);
  const composingRef = useRef(false);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingDraftRef = useRef<{
    text: string;
    entities?: MessageTextEntity[];
    replyToMessageId?: string;
    replyQuote?: MessageReplyQuote;
  } | undefined>(undefined);
  const localDraftDirtyRef = useRef(false);
  const previousEditingRef = useRef<Message | undefined>(undefined);
  const draftBeforeEditRef = useRef<string | undefined>(undefined);
  const entitiesBeforeEditRef = useRef<MessageTextEntity[] | undefined>(undefined);
  const typingActiveRef = useRef(false);
  const typingRefreshRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const typingIdleRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const replyToMessageIdRef = useRef(replyingTo?.id ?? chatDraft?.replyToMessageId);
  const replyQuoteRef = useRef<MessageReplyQuote | undefined>(activeReplyQuote);
  const emojiOpenTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const emojiCloseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const emojiOpenedByHoverRef = useRef(false);
  const pendingAttachmentsRef = useRef(pendingAttachments);
  const pendingAttachmentDraftKeyRef = useRef<string | undefined>(undefined);
  const localAttachmentBatchIdRef = useRef<string | undefined>(undefined);
  const attachmentPreviewSessionRef = useRef<AttachmentPreviewSession | undefined>(undefined);
  const attachmentPreviewGenerationRef = useRef(0);
  const attachmentModeRef = useRef(attachmentMode);
  const attachmentSpoilerRef = useRef(attachmentSpoiler);
  const muteVideosRef = useRef(muteVideos);
  const fileDragDepthRef = useRef(0);
  const appliedTextInsertionRef = useRef<string | undefined>(undefined);
  const previousComposerContextKeyRef = useRef(composerContextKey);
  const mediaModeAvailable = pendingAttachments.length > 0 && pendingAttachments.every(
    ({ attachment }) => canSendAttachmentAsMedia(attachment.kind),
  );
  const hasPreviewableAttachments = pendingAttachments.some(
    ({ attachment, previewUrl }) => previewUrl && canPreviewOutgoingAttachment(attachment.kind),
  );
  const photoPreviewMessages = useMemo<PhotoMessage[]>(() => pendingAttachments.flatMap((pending) =>
    pending.previewUrl && ["photo", "animation"].includes(pending.attachment.kind)
      ? [{
          id: pending.id,
          chatId: `attachment-draft:${draftKey}`,
          senderId: "self",
          outgoing: true,
          sentAt: new Date(pending.attachment.file.lastModified || 0).toISOString(),
          delivery: "read",
          content: {
            kind: "media",
            mediaType: "photo",
            fileName: pending.attachment.file.name,
            mimeType: pending.attachment.file.type || undefined,
            size: pending.attachment.file.size,
            sizeLabel: attachmentSizeLabel(pending.attachment.file.size),
            width: pending.attachment.width,
            height: pending.attachment.height,
            previewDataUrl: pending.previewUrl,
          },
        }]
      : [],
  ), [draftKey, pendingAttachments]);

  const closeAttachmentPreviewSession = useCallback(() => {
    attachmentPreviewGenerationRef.current += 1;
    const session = attachmentPreviewSessionRef.current;
    attachmentPreviewSessionRef.current = undefined;
    if (!session) return;
    if (session.kind === "photo") closeMediaViewerWindowSession(session.id);
    else closeVideoPreviewWindow(session.id);
  }, []);

  const openPendingAttachmentPreview = useCallback((pending: PendingAttachment) => {
    const { attachment, previewUrl } = pending;
    if (!previewUrl || !canPreviewOutgoingAttachment(attachment.kind)) return;
    closeAttachmentPreviewSession();
    const generation = attachmentPreviewGenerationRef.current;

    if (attachment.kind === "photo" || attachment.kind === "animation") {
      if (!photoPreviewMessages.some((message) => message.id === pending.id)) return;
      void openMediaViewerWindow({
        messages: photoPreviewMessages,
        activeMessageId: pending.id,
        colorTheme,
      }, ignoreViewerFileAction, ignoreViewerFileAction).then((id) => {
        if (!id) return;
        const stillStaged = generation === attachmentPreviewGenerationRef.current &&
          pendingAttachmentDraftKeyRef.current === draftKey &&
          pendingAttachmentsRef.current.some((candidate) => candidate.id === pending.id);
        if (!stillStaged) {
          closeMediaViewerWindowSession(id);
          return;
        }
        attachmentPreviewSessionRef.current = { kind: "photo", id, draftKey };
      });
      return;
    }

    if (attachment.kind === "video") {
      void openVideoPreviewWindow({
        source: previewUrl,
        label: attachment.file.name,
        width: attachment.width,
        height: attachment.height,
        duration: attachment.duration,
        colorTheme,
      }).then((id) => {
        if (!id) return;
        const stillStaged = generation === attachmentPreviewGenerationRef.current &&
          pendingAttachmentDraftKeyRef.current === draftKey &&
          pendingAttachmentsRef.current.some((candidate) => candidate.id === pending.id);
        if (!stillStaged) {
          closeVideoPreviewWindow(id);
          return;
        }
        attachmentPreviewSessionRef.current = {
          kind: "video",
          id,
          draftKey,
          attachmentId: pending.id,
        };
      });
    }
  }, [closeAttachmentPreviewSession, colorTheme, draftKey, photoPreviewMessages]);

  pendingAttachmentsRef.current = pendingAttachments;
  attachmentModeRef.current = attachmentMode;
  attachmentSpoilerRef.current = attachmentSpoiler;
  muteVideosRef.current = muteVideos;

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

  useComposerAutoResize(inputRef, draft, !composing, chatId, onGeometryChange);

  useLayoutEffect(() => {
    if (previousComposerContextKeyRef.current === composerContextKey) return;
    previousComposerContextKeyRef.current = composerContextKey;
    onGeometryChange?.();
  }, [composerContextKey, onGeometryChange]);

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
    }, motionLifecycleTiming.popoverHoverOpen);
  }, [clearEmojiCloseTimer, editingMessage, emojiPickerOpen]);

  const scheduleEmojiPickerClose = useCallback(() => {
    clearEmojiOpenTimer();
    clearEmojiCloseTimer();
    emojiCloseTimerRef.current = globalThis.setTimeout(() => {
      emojiCloseTimerRef.current = undefined;
      emojiOpenedByHoverRef.current = false;
      setEmojiPickerOpen(false);
    }, motionLifecycleTiming.popoverHoverClose);
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
    onDraftChange(
      chatId,
      pending.text,
      pending.replyToMessageId,
      pending.replyQuote,
      pending.entities,
    );
  }, [chatId, onDraftChange]);

  const scheduleDraft = useCallback((
    text: string,
    replyToMessageId?: string,
    selectedReplyQuote?: MessageReplyQuote,
    entities: MessageTextEntity[] = mentionEntitiesRef.current,
  ) => {
    if (draftTimerRef.current) globalThis.clearTimeout(draftTimerRef.current);
    pendingDraftRef.current = {
      text,
      replyToMessageId,
      replyQuote: selectedReplyQuote,
      ...(entities.length ? { entities: [...entities] } : {}),
    };
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
    mentionEntitiesRef.current = [];
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
    const previousText = draftRef.current;
    const selectionStart = input?.selectionStart ?? previousText.length;
    const selectionEnd = input?.selectionEnd ?? previousText.length;
    let insertedMention: MessageTextEntity | undefined;
    let result = insertComposerText(
      previousText,
      textInsertion.text,
      selectionStart,
      selectionEnd,
    );
    if (textInsertion.userId) {
      const mentionResult = insertComposerMention(
        previousText,
        textInsertion.text,
        textInsertion.userId,
        selectionStart,
        selectionEnd,
      );
      insertedMention = mentionResult.entity;
      result = mentionResult;
    }
    mentionEntitiesRef.current = [
      ...reconcileComposerMentionEntities(
        previousText,
        result.value,
        mentionEntitiesRef.current,
      ),
      ...(insertedMention ? [insertedMention] : []),
    ].sort((left, right) => left.offset - right.offset);
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
    mentionEntitiesRef.current = reconcileComposerMentionEntities(
      draftRef.current,
      value,
      mentionEntitiesRef.current,
    );
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
      if (!previous) entitiesBeforeEditRef.current = mentionEntitiesRef.current;
      if (draftTimerRef.current) flushDraft();
      draftRef.current = editingMessage.content.kind === "text" ? editingMessage.content.text : "";
      mentionEntitiesRef.current = editingMessage.content.kind === "text"
        ? editingMessage.content.entities ?? []
        : [];
      setDraft(draftRef.current);
      stopTyping();
      focusComposer();
    } else if (!editingMessage && previous) {
      draftRef.current = draftBeforeEditRef.current ?? chatDraft?.text ?? "";
      mentionEntitiesRef.current = entitiesBeforeEditRef.current ?? chatDraft?.entities ?? [];
      draftBeforeEditRef.current = undefined;
      entitiesBeforeEditRef.current = undefined;
      setDraft(draftRef.current);
      focusComposer();
    }
    previousEditingRef.current = editingMessage;
  }, [chatDraft?.entities, chatDraft?.text, editingMessage, flushDraft, focusComposer, stopTyping]);

  useEffect(() => {
    if (editingMessage || localDraftDirtyRef.current) return;
    const incoming = chatDraft?.text ?? "";
    mentionEntitiesRef.current = chatDraft?.entities ?? [];
    if (incoming === draftRef.current) return;
    draftRef.current = incoming;
    setDraft(incoming);
  }, [chatDraft?.entities, chatDraft?.text, editingMessage]);

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
        ...(mentionEntitiesRef.current.length
          ? { entities: [...mentionEntitiesRef.current] }
          : {}),
        replyToMessageId: replyToMessageIdRef.current,
        replyQuote: replyQuoteRef.current,
      };
    }
    flushDraft();
    stopTyping();
  }, [editingMessage, flushDraft, stopTyping]);

  useEffect(() => () => {
    closeAttachmentPreviewSession();
    for (const attachment of pendingAttachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }, [closeAttachmentPreviewSession]);

  useEffect(() => {
    const session = attachmentPreviewSessionRef.current;
    if (!session) return;
    if (session.draftKey !== draftKey) {
      closeAttachmentPreviewSession();
      return;
    }
    if (session.kind === "photo") {
      if (
        photoPreviewMessages.length === 0 ||
        !syncMediaViewerWindowSession(session.id, photoPreviewMessages, colorTheme)
      ) {
        attachmentPreviewSessionRef.current = undefined;
      }
      return;
    }
    if (!pendingAttachments.some((pending) => pending.id === session.attachmentId)) {
      closeAttachmentPreviewSession();
    }
  }, [closeAttachmentPreviewSession, colorTheme, draftKey, pendingAttachments, photoPreviewMessages]);

  useEffect(() => {
    const switchedDraft = pendingAttachmentDraftKeyRef.current !== draftKey;
    const batchChanged = localAttachmentBatchIdRef.current !== localAttachmentDraft?.batchId;
    if (
      !switchedDraft &&
      !batchChanged &&
      (!localAttachmentDraft || pendingAttachmentsRef.current.length > 0)
    ) return;
    pendingAttachmentDraftKeyRef.current = draftKey;
    localAttachmentBatchIdRef.current = localAttachmentDraft?.batchId;
    if (!switchedDraft && localAttachmentDraft && pendingAttachmentsRef.current.length > 0) return;

    closeAttachmentPreviewSession();
    for (const pending of pendingAttachmentsRef.current) {
      if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
    }
    pendingAttachmentsRef.current = [];
    setPendingAttachments([]);
    setAttachmentNotice(undefined);
    setAttachmentMode(localAttachmentDraft?.mode ?? "media");
    setAttachmentSpoiler(localAttachmentDraft?.hasSpoiler ?? false);
    setMuteVideos(localAttachmentDraft?.muteVideos ?? false);
    if (!localAttachmentDraft) return;

    let cancelled = false;
    setAttachmentPending(true);
    void loadLocalAttachmentDraft(draftKey).then((attachments) => {
      if (cancelled) return;
      const restored = attachments.map(pendingAttachmentFrom);
      pendingAttachmentsRef.current = restored;
      setPendingAttachments(restored);
    }).finally(() => {
      if (!cancelled) setAttachmentPending(false);
    });
    return () => {
      cancelled = true;
    };
  }, [closeAttachmentPreviewSession, draftKey, loadLocalAttachmentDraft, localAttachmentDraft]);

  const persistPendingAttachments = useCallback((next: PendingAttachment[]) => {
    if (next.length === 0) {
      void clearLocalAttachmentDraft(draftKey);
      return;
    }
    void saveLocalAttachmentDraft(
      draftKey,
      chatId,
      next.map(({ attachment }) => attachment),
      {
        mode: attachmentModeRef.current,
        hasSpoiler: attachmentSpoilerRef.current,
        muteVideos: muteVideosRef.current,
      },
    ).then((saved) => {
      if (!saved) return;
      updateLocalAttachmentDraftOptions(draftKey, {
        mode: attachmentModeRef.current,
        hasSpoiler: attachmentSpoilerRef.current,
        muteVideos: muteVideosRef.current,
      });
    });
  }, [chatId, clearLocalAttachmentDraft, draftKey, saveLocalAttachmentDraft, updateLocalAttachmentDraftOptions]);

  const updateAttachmentOptions = useCallback((options: Partial<{
    mode: AttachmentSendMode;
    hasSpoiler: boolean;
    muteVideos: boolean;
  }>) => {
    if (options.mode !== undefined) {
      attachmentModeRef.current = options.mode;
      setAttachmentMode(options.mode);
    }
    if (options.hasSpoiler !== undefined) {
      attachmentSpoilerRef.current = options.hasSpoiler;
      setAttachmentSpoiler(options.hasSpoiler);
    }
    if (options.muteVideos !== undefined) {
      muteVideosRef.current = options.muteVideos;
      setMuteVideos(options.muteVideos);
    }
    updateLocalAttachmentDraftOptions(draftKey, options);
  }, [draftKey, updateLocalAttachmentDraftOptions]);

  const addPendingAttachments = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const current = pendingAttachmentsRef.current;
    const available = Math.max(0, TELEGRAM_ALBUM_MAX_ITEMS - current.length);
    const accepted = files.slice(0, available).map((file) => pendingAttachmentFrom({
      file,
      kind: classifyOutgoingAttachment(file),
    }));
    const next = [...current, ...accepted];
    const mediaEligible = next.every(({ attachment }) => canSendAttachmentAsMedia(attachment.kind));
    if (!mediaEligible) {
      updateAttachmentOptions({ mode: "file", hasSpoiler: false, muteVideos: false });
    } else if (current.length === 0) {
      updateAttachmentOptions({ mode: "media" });
    }
    pendingAttachmentsRef.current = next;
    setPendingAttachments(next);
    setAttachmentNotice(files.length > available
      ? `一次最多发送 ${TELEGRAM_ALBUM_MAX_ITEMS} 个附件`
      : undefined);
    persistPendingAttachments(next);

    for (const pending of accepted) {
      void inspectOutgoingAttachment(pending.attachment.file).then((attachment) => {
        const latest = pendingAttachmentsRef.current;
        if (!latest.some((candidate) => candidate.id === pending.id)) return;
        const inspected = latest.map((candidate) =>
          candidate.id === pending.id ? { ...candidate, attachment } : candidate,
        );
        pendingAttachmentsRef.current = inspected;
        setPendingAttachments(inspected);
      });
    }
  }, [persistPendingAttachments, updateAttachmentOptions]);

  const removePendingAttachment = useCallback((id: string) => {
    closeAttachmentPreviewSession();
    const current = pendingAttachmentsRef.current;
    const removed = current.find((attachment) => attachment.id === id);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    const next = current.filter((attachment) => attachment.id !== id);
    pendingAttachmentsRef.current = next;
    setPendingAttachments(next);
    if (next.some(({ attachment }) => !canSendAttachmentAsMedia(attachment.kind))) {
      updateAttachmentOptions({ mode: "file", hasSpoiler: false, muteVideos: false });
    }
    persistPendingAttachments(next);
    setAttachmentNotice(undefined);
    focusComposer();
  }, [closeAttachmentPreviewSession, focusComposer, persistPendingAttachments, updateAttachmentOptions]);

  const sendPendingAttachments = async () => {
    if (attachmentPending || pendingAttachments.length === 0) return;
    const caption = trimComposerFormattedText(draftRef.current, mentionEntitiesRef.current);
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
          hasSpoiler: attachmentMode === "media" &&
            canPreviewOutgoingAttachment(attachment.kind) &&
            attachmentSpoiler,
        })),
        caption.text || undefined,
        caption.entities,
      );
      if (!sent) return;
      closeAttachmentPreviewSession();
      for (const attachment of pendingAttachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      pendingAttachmentsRef.current = [];
      setPendingAttachments([]);
      setAttachmentNotice(undefined);
      setAttachmentMode("media");
      setAttachmentSpoiler(false);
      setMuteVideos(false);
      await clearLocalAttachmentDraft(draftKey);
      if (draftTimerRef.current) globalThis.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = undefined;
      pendingDraftRef.current = undefined;
      localDraftDirtyRef.current = false;
      draftRef.current = "";
      mentionEntitiesRef.current = [];
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
    const submitted = trimComposerFormattedText(draftRef.current, mentionEntitiesRef.current);
    if (!submitted.text || sending) return;
    closeEmojiPicker();
    if (editingMessage) {
      setSending(true);
      const edited = await onEditMessage(editingMessage.id, submitted.text, submitted.entities);
      setSending(false);
      if (edited) onCancelEditing();
      focusComposer();
      return;
    }

    const startCommand = submitted.text.match(/^\/start(?:@([A-Za-z0-9_]{5,32}))?(?:\s+(.+))?$/);
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
      mentionEntitiesRef.current = [];
      setDraft("");
      onDraftChange(chatId, "", undefined, undefined);
      stopTyping();
      setSending(true);
      const sent = await onSendBotStart(startBot.botUserId, startCommand[2]);
      setSending(false);
      if (!sent) {
        draftRef.current = submitted.text;
        mentionEntitiesRef.current = submitted.entities;
        setDraft(submitted.text);
        scheduleDraft(submitted.text, replyingTo?.id ?? chatDraft?.replyToMessageId, activeReplyQuote);
      }
      else onCancelReply();
      focusComposer();
      return;
    }

    if (draftTimerRef.current) globalThis.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = undefined;
    pendingDraftRef.current = undefined;
    localDraftDirtyRef.current = false;
    draftRef.current = "";
    mentionEntitiesRef.current = [];
    setDraft("");
    onDraftChange(chatId, "", undefined, undefined);
    stopTyping();
    focusComposer();
    setSending(true);
    const sent = await onSendMessage(
      submitted.text,
      replyingTo?.id ?? chatDraft?.replyToMessageId,
      activeReplyQuote,
      submitted.entities,
    );
    setSending(false);
    if (sent) {
      onCancelReply();
    } else {
      const restored = prependComposerFormattedText(
        submitted,
        draftRef.current,
        mentionEntitiesRef.current,
      );
      draftRef.current = restored.text;
      mentionEntitiesRef.current = restored.entities;
      setDraft(restored.text);
      scheduleDraft(restored.text, replyingTo?.id ?? chatDraft?.replyToMessageId, activeReplyQuote);
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
    onDraftChange(
      chatId,
      draftRef.current,
      undefined,
      undefined,
      mentionEntitiesRef.current,
    );
    onCancelReply();
    focusComposer();
  }, [chatId, focusComposer, onCancelReply, onDraftChange]);

  const handleFileDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (composerContextMessage || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setDraggingFiles(true);
  }, [composerContextMessage]);

  const handleFileDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (composerContextMessage || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, [composerContextMessage]);

  const handleFileDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setDraggingFiles(false);
  }, []);

  const handleFileDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (composerContextMessage || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    fileDragDepthRef.current = 0;
    setDraggingFiles(false);
    addPendingAttachments(Array.from(event.dataTransfer.files));
    focusComposer();
  }, [addPendingAttachments, composerContextMessage, focusComposer]);

  return (
    <div
      className={`composer-wrap ${draggingFiles ? "is-file-dragging" : ""}`}
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      <MotionPresence present={emojiPickerOpen && !editingMessage} variant="popover">
        {emojiPickerOpen && !editingMessage ? (
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
        ) : null}
      </MotionPresence>
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
          <header className="composer-attachment-header">
            <strong>待发送</strong>
            <span>{pendingAttachments.length} 项</span>
          </header>
          <div className="composer-attachment-grid" data-count={pendingAttachments.length}>
            {pendingAttachments.map((pending) => {
              const { attachment } = pending;
              const concealed = attachmentMode === "media" &&
                attachmentSpoiler &&
                canPreviewOutgoingAttachment(attachment.kind);
              return (
                <article className="composer-attachment-item" key={pending.id}>
                  <div className="composer-attachment-open">
                    {pending.previewUrl ? (
                      <MediaSpoiler
                        active={concealed}
                        resetKey={`${draftKey}:${pending.id}:${attachmentSpoiler ? "concealed" : "plain"}`}
                      >
                        <button
                          className="composer-attachment-media-button"
                          type="button"
                          aria-label={`预览 ${attachment.file.name}`}
                          title="预览附件"
                          onClick={() => openPendingAttachmentPreview(pending)}
                        >
                          {attachment.kind === "video" ? (
                            <video src={pending.previewUrl} aria-hidden="true" muted />
                          ) : (
                            <StableImage src={pending.previewUrl} alt="" />
                          )}
                        </button>
                      </MediaSpoiler>
                    ) : (
                      <span className="composer-file-preview"><FileText size={25} /></span>
                    )}
                    <span className="composer-attachment-kind">{ATTACHMENT_KIND_LABELS[attachment.kind]}</span>
                  </div>
                  <span className="composer-attachment-copy">
                    <strong>{attachment.file.name}</strong>
                    <small>{attachmentSizeLabel(attachment.file.size)}</small>
                  </span>
                  <button
                    className="composer-attachment-remove"
                    type="button"
                    aria-label={`移除 ${attachment.file.name}`}
                    title="移除附件"
                    onClick={() => removePendingAttachment(pending.id)}
                  >
                    <X size={14} />
                  </button>
                </article>
              );
            })}
          </div>
          <div className="composer-attachment-options">
            <fieldset className="attachment-mode-control">
              <legend className="sr-only">附件发送方式</legend>
              <label>
                <input
                  type="radio"
                  name="attachment-mode"
                  checked={attachmentMode === "media"}
                  disabled={!mediaModeAvailable}
                  onChange={() => updateAttachmentOptions({ mode: "media" })}
                />
                <span>媒体</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="attachment-mode"
                  checked={attachmentMode === "file"}
                  onChange={() => updateAttachmentOptions({
                    mode: "file",
                    hasSpoiler: false,
                    muteVideos: false,
                  })}
                />
                <span>原文件</span>
              </label>
            </fieldset>
            <label>
              <input
                type="checkbox"
                checked={attachmentSpoiler}
                disabled={attachmentMode === "file" || !hasPreviewableAttachments}
                onChange={(event) => updateAttachmentOptions({ hasSpoiler: event.target.checked })}
              />
              剧透
            </label>
            {pendingAttachments.some(({ attachment }) => attachment.kind === "video") && (
              <label>
                <input
                  type="checkbox"
                  checked={muteVideos}
                  disabled={attachmentMode === "file"}
                  onChange={(event) => updateAttachmentOptions({ muteVideos: event.target.checked })}
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
              {showAttachmentPending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
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
      <MotionPresence present={botSuggestions.length > 0} variant="popover">
        {botSuggestions.length > 0 ? (
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
        ) : null}
      </MotionPresence>
      <MotionPresence present={Boolean(showInlineLoading || inlineResults)} variant="popover">
        {showInlineLoading || inlineResults ? (
          <section className="inline-query-panel" aria-label="Inline 查询结果">
            {inlineResults ? inlineResults.results.map((result) => <button key={result.id} type="button" className="inline-query-result" onClick={async () => { const inline = composerInlineQueryForDraft(draftRef.current, knownNonBotUsernames); if (!inline || !inlineResults) return; const bot = await onGetBotCommands("", inline.username); const botUserId = bot[0]?.botUserId ?? `bot:${inline.username}`; setSending(true); const sent = await onSendInlineResult(botUserId, inlineResults.queryId, result.id, replyingTo?.id ?? chatDraft?.replyToMessageId); setSending(false); if (sent) { draftRef.current = ""; mentionEntitiesRef.current = []; setDraft(""); onDraftChange(chatId, "", undefined); setInlineResults(undefined); onCancelReply(); } focusComposer(); }}><span className="inline-query-result-kind">{result.kind === "photo" ? "图片" : result.kind === "file" ? "文件" : "结果"}</span><span><strong>{result.title}</strong><small>{result.description || result.messageText}</small></span></button>) : <div className="inline-query-loading"><LoaderCircle className="spin" size={18} />正在查询机器人</div>}
            {inlineResults?.hasMore && <button type="button" className="inline-query-more" disabled={inlineLoading} onClick={() => { const inline = composerInlineQueryForDraft(draftRef.current, knownNonBotUsernames); if (inline && inlineResults.nextOffset) { setInlineLoading(true); void onGetInlineResults(inline.username, inline.query, inlineResults.nextOffset).then((page) => { if (page) setInlineResults((current) => current ? { ...page, results: [...current.results, ...page.results] } : page); setInlineLoading(false); }).catch(() => setInlineLoading(false)); } }}>{showInlineLoading && <LoaderCircle className="spin" size={15} />}加载更多结果</button>}
          </section>
        ) : null}
      </MotionPresence>
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
          {showAttachmentPending
            ? <LoaderCircle className="spin" size={19} strokeWidth={1.8} />
            : <Paperclip size={20} strokeWidth={1.8} />}
        </button>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => {
            const value = event.target.value;
            mentionEntitiesRef.current = reconcileComposerMentionEntities(
              draftRef.current,
              value,
              mentionEntitiesRef.current,
            );
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
          {showSending
            ? <LoaderCircle className="spin" size={19} strokeWidth={1.8} />
            : editingMessage
              ? <Check size={19} strokeWidth={2.2} />
              : <Send size={19} strokeWidth={2} />}
        </button>
      </div>
      {draggingFiles && (
        <div className="composer-file-drop-overlay" role="status">
          <Paperclip size={24} />
          <strong>添加到待发送附件</strong>
        </div>
      )}
    </div>
  );
});
