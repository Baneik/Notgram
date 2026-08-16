import { CircleAlert, LoaderCircle, X } from "lucide-react";
import {
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { ChatSidebar } from "../components/ChatSidebar";
import { Conversation } from "../components/Conversation";
import { ForumTopicsView } from "../components/ForumTopicsView";
import { NavigationRail } from "../components/NavigationRail";
import { AuthorizationScreen } from "../components/AuthorizationScreen";
import { SettingsDialog } from "../components/SettingsDialog";
import { DownloadManagerDialog } from "../components/DownloadManagerDialog";
import { MotionPresence } from "../components/MotionPresence";
import { ProfileDrawer } from "../components/ProfileDrawer";
import { FolderManagerDialog } from "../components/FolderManagerDialog";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";
import { NewChatDialog } from "../components/NewChatDialog";
import { ChatManagementDialog } from "../components/ChatManagementDialog";
import { AudioPlaybackHost } from "../components/AudioPlaybackHost";
import { filterAndSortChats, telegramStore, useTelegramStore } from "../store/telegramStore";
import { preferencesStore, usePreferencesStore } from "../store/preferencesStore";
import { messageContentText } from "../telegram/messageContent";
import type { Message, TelegramLinkTarget } from "../telegram/types";
import { isTelegramUserLink } from "../telegram/telegramLinks";
import { connectionPresentation } from "../telegram/connectionState";
import {
  listenForDesktopNotificationOpen,
  showDesktopNotification,
  type DesktopNotificationRoute,
} from "../notifications/desktopNotifications";
import {
  notificationPresentation,
  shouldNotifyMessage,
} from "../notifications/messageNotificationPolicy";
import {
  clearPendingNotificationRoute,
  readPendingNotificationRoute,
  savePendingNotificationRoute,
} from "../notifications/notificationRouting";
import { mediaPlaybackCoordinator } from "../media/mediaPlayback";
import {
  captureActiveConversationScrollState,
  hasConversationScrollMemory,
  type ConversationScrollRequest,
  type ConversationScrollRequestInput,
} from "../hooks/useConversationScroll";
import { useSidebarSearch } from "../hooks/useSidebarSearch";
import type { SidebarSearchSenderOption } from "../components/GlobalSearchView";
import {
  beginConversationSwitch,
  isConversationSwitchActive,
  logPerformance,
  markConversationSwitch,
} from "../utils/performanceMonitor";
import { openSettingsWindow } from "../windows/settingsWindow";
import {
  ManagedDownloadIndex,
  readManagedDownloadRequests,
  type ManagedDownloadRequest,
  writeManagedDownloadRequests,
} from "../utils/downloadManager";
import {
  useConversationNavigation,
  type ConversationNavigationLocation,
} from "../hooks/useConversationNavigation";
import {
  captureConversationSwitchSnapshot,
  removeConversationSwitchSnapshot,
  type ConversationSwitchSnapshot,
} from "../utils/conversationSwitchSnapshot";

const DEFAULT_SIDEBAR_WIDTH = 360;
const SIDEBAR_WIDTH_STORAGE_KEY = "notgram.sidebar-width";
const CONVERSATION_SNAPSHOT_MAX_MS = 1_500;
const CONVERSATION_SNAPSHOT_RELEASE_MS = 90;
const EMPTY_MESSAGES: Message[] = [];

const conversationIdentityFor = (chatId: string, topicId?: string) =>
  topicId ? `${chatId}:topic:${topicId}` : chatId;

type PendingConfirmation =
  | { kind: "leaveGroup"; chatId: string; title: string }
  | { kind: "deleteFolder"; folderId: string; title: string };

const readSidebarWidth = () => {
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= 250 ? stored : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
};

export function App() {
  const phase = useTelegramStore((state) => state.phase);
  const error = useTelegramStore((state) => state.error);
  const operationError = useTelegramStore((state) => state.operationError);
  const chatFilter = useTelegramStore((state) => state.chatFilter);
  const searchQuery = useTelegramStore((state) => state.searchQuery);
  const activeChatId = useTelegramStore((state) => state.activeChatId);
  const activeChatMessages = useTelegramStore((state) =>
    activeChatId ? state.messages.get(activeChatId) ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  );
  const activeRemovingSource = useTelegramStore((state) =>
    activeChatId ? state.removingMessages.get(activeChatId) ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  );
  const activeTopicId = useTelegramStore((state) => state.activeTopicId);
  const activeAccountId = useTelegramStore((state) => state.activeAccountId);
  const accounts = useTelegramStore((state) => state.accounts);
  const accountPending = useTelegramStore((state) => state.accountPending);
  const chats = useTelegramStore((state) => state.chats);
  const chatListReady = useTelegramStore((state) => state.chatListReady);
  const chatLists = useTelegramStore((state) => state.chatLists);
  const folders = useTelegramStore((state) => state.folders);
  const users = useTelegramStore((state) => state.users);
  const contacts = useTelegramStore((state) => state.contacts);
  const contactsLoading = useTelegramStore((state) => state.contactsLoading);
  const contactsError = useTelegramStore((state) => state.contactsError);
  const subscribeMessageChanges = useTelegramStore((state) => state.subscribeMessageChanges);
  const forumTopics = useTelegramStore((state) => state.forumTopics);
  const forumTopicsLoading = useTelegramStore((state) => state.forumTopicsLoading);
  const topicHistories = useTelegramStore((state) => state.topicHistories);
  const typingUserIds = useTelegramStore((state) => state.typingUserIds);
  const outbox = useTelegramStore((state) => state.outbox);
  const histories = useTelegramStore((state) => state.histories);
  const globalSearch = useTelegramStore((state) => state.globalSearch);
  const profile = useTelegramStore((state) => state.profile);
  const currentUserId = useTelegramStore((state) => state.currentUserId);
  const chatManagementPending = useTelegramStore((state) => state.chatManagementPending);
  const folderManagementPending = useTelegramStore((state) => state.folderManagementPending);
  const chatCreationPending = useTelegramStore((state) => state.chatCreationPending);
  const groupManagement = useTelegramStore((state) => state.groupManagement);
  const groupManagementLoading = useTelegramStore((state) => state.groupManagementLoading);
  const groupManagementError = useTelegramStore((state) => state.groupManagementError);
  const blockedSenders = useTelegramStore((state) => state.blockedSenders);
  const connectionStatus = useTelegramStore((state) => state.connectionStatus);
  const authorization = useTelegramStore((state) => state.authorization);
  const authorizationPending = useTelegramStore((state) => state.authorizationPending);
  const authorizationError = useTelegramStore((state) => state.authorizationError);
  const initialize = useTelegramStore((state) => state.initialize);
  const addAccount = useTelegramStore((state) => state.addAccount);
  const switchAccount = useTelegramStore((state) => state.switchAccount);
  const loadForumTopics = useTelegramStore((state) => state.loadForumTopics);
  const createForumTopic = useTelegramStore((state) => state.createForumTopic);
  const editForumTopic = useTelegramStore((state) => state.editForumTopic);
  const setForumTopicClosed = useTelegramStore((state) => state.setForumTopicClosed);
  const setForumTopicPinned = useTelegramStore((state) => state.setForumTopicPinned);
  const loadMessage = useTelegramStore((state) => state.loadMessage);
  const loadChatProfile = useTelegramStore((state) => state.loadChatProfile);
  const loadMoreChatProfileMembers = useTelegramStore((state) => state.loadMoreChatProfileMembers);
  const loadUserProfile = useTelegramStore((state) => state.loadUserProfile);
  const loadCurrentUserProfile = useTelegramStore((state) => state.loadCurrentUserProfile);
  const clearProfile = useTelegramStore((state) => state.clearProfile);
  const startPrivateChat = useTelegramStore((state) => state.startPrivateChat);
  const loadContacts = useTelegramStore((state) => state.loadContacts);
  const createChat = useTelegramStore((state) => state.createChat);
  const loadChatManagement = useTelegramStore((state) => state.loadChatManagement);
  const addChatMembers = useTelegramStore((state) => state.addChatMembers);
  const setChatMemberStatus = useTelegramStore((state) => state.setChatMemberStatus);
  const setChatMemberTag = useTelegramStore((state) => state.setChatMemberTag);
  const setChatPermissions = useTelegramStore((state) => state.setChatPermissions);
  const setChatSlowModeDelay = useTelegramStore((state) => state.setChatSlowModeDelay);
  const transferChatOwnership = useTelegramStore((state) => state.transferChatOwnership);
  const loadChatEventLog = useTelegramStore((state) => state.loadChatEventLog);
  const getChatInviteLinks = useTelegramStore((state) => state.getChatInviteLinks);
  const createChatInviteLink = useTelegramStore((state) => state.createChatInviteLink);
  const editChatInviteLink = useTelegramStore((state) => state.editChatInviteLink);
  const revokeChatInviteLink = useTelegramStore((state) => state.revokeChatInviteLink);
  const getChatJoinRequests = useTelegramStore((state) => state.getChatJoinRequests);
  const processChatJoinRequest = useTelegramStore((state) => state.processChatJoinRequest);
  const processChatJoinRequests = useTelegramStore((state) => state.processChatJoinRequests);
  const getBotCommandSuggestions = useTelegramStore((state) => state.getBotCommandSuggestions);
  const getCallbackQueryAnswer = useTelegramStore((state) => state.getCallbackQueryAnswer);
  const getInlineQueryResults = useTelegramStore((state) => state.getInlineQueryResults);
  const sendInlineQueryResultMessage = useTelegramStore((state) => state.sendInlineQueryResultMessage);
  const sendBotStartMessage = useTelegramStore((state) => state.sendBotStartMessage);
  const setMessageSenderBlocked = useTelegramStore((state) => state.setMessageSenderBlocked);
  const getChatReportOptions = useTelegramStore((state) => state.getChatReportOptions);
  const reportChat = useTelegramStore((state) => state.reportChat);
  const loadMoreChats = useTelegramStore((state) => state.loadMoreChats);
  const reorderPinnedChats = useTelegramStore((state) => state.reorderPinnedChats);
  const setChatPinned = useTelegramStore((state) => state.setChatPinned);
  const setChatMuted = useTelegramStore((state) => state.setChatMuted);
  const setChatArchived = useTelegramStore((state) => state.setChatArchived);
  const leaveGroup = useTelegramStore((state) => state.leaveGroup);
  const createChatFolder = useTelegramStore((state) => state.createChatFolder);
  const renameChatFolder = useTelegramStore((state) => state.renameChatFolder);
  const deleteChatFolder = useTelegramStore((state) => state.deleteChatFolder);
  const setChatFolderMembership = useTelegramStore((state) => state.setChatFolderMembership);
  const markChatFolderRead = useTelegramStore((state) => state.markChatFolderRead);
  const markActiveChatRead = useTelegramStore((state) => state.markActiveChatRead);
  const setSearchQuery = useTelegramStore((state) => state.setSearchQuery);
  const setChatFilter = useTelegramStore((state) => state.setChatFilter);
  const sendMessage = useTelegramStore((state) => state.sendMessage);
  const editMessage = useTelegramStore((state) => state.editMessage);
  const deleteMessage = useTelegramStore((state) => state.deleteMessage);
  const updateChatDraft = useTelegramStore((state) => state.updateChatDraft);
  const setChatTyping = useTelegramStore((state) => state.setChatTyping);
  const forwardMessages = useTelegramStore((state) => state.forwardMessages);
  const loadMessageProperties = useTelegramStore((state) => state.loadMessageProperties);
  const setMessageReaction = useTelegramStore((state) => state.setMessageReaction);
  const setPollAnswer = useTelegramStore((state) => state.setPollAnswer);
  const loadPinnedMessages = useTelegramStore((state) => state.loadPinnedMessages);
  const pinMessage = useTelegramStore((state) => state.pinMessage);
  const unpinMessage = useTelegramStore((state) => state.unpinMessage);
  const setChatMessageAutoDeleteTime = useTelegramStore((state) => state.setChatMessageAutoDeleteTime);
  const loadSharedMedia = useTelegramStore((state) => state.loadSharedMedia);
  const deleteMessagesFromChat = useTelegramStore((state) => state.deleteMessagesFromChat);
  const searchChatMessages = useTelegramStore((state) => state.searchChatMessages);
  const chatMessageSearch = useTelegramStore((state) => state.chatMessageSearch);
  const loadMoreChatMessages = useTelegramStore((state) => state.loadMoreChatMessages);
  const clearChatMessageSearch = useTelegramStore((state) => state.clearChatMessageSearch);
  const searchGlobal = useTelegramStore((state) => state.searchGlobal);
  const loadMoreGlobalSearch = useTelegramStore((state) => state.loadMoreGlobalSearch);
  const cancelGlobalSearch = useTelegramStore((state) => state.cancelGlobalSearch);
  const clearGlobalSearch = useTelegramStore((state) => state.clearGlobalSearch);
  const downloadFile = useTelegramStore((state) => state.downloadFile);
  const cancelFileDownload = useTelegramStore((state) => state.cancelFileDownload);
  const openFile = useTelegramStore((state) => state.openFile);
  const saveFileAs = useTelegramStore((state) => state.saveFileAs);
  const openDownloadDirectory = useTelegramStore((state) => state.openDownloadDirectory);
  const streamFile = useTelegramStore((state) => state.streamFile);
  const suspendFileStream = useTelegramStore((state) => state.suspendFileStream);
  const retryMessage = useTelegramStore((state) => state.retryMessage);
  const sendFiles = useTelegramStore((state) => state.sendFiles);
  const cancelFileUpload = useTelegramStore((state) => state.cancelFileUpload);
  const loadMoreHistory = useTelegramStore((state) => state.loadMoreHistory);
  const clearError = useTelegramStore((state) => state.clearError);
  const clearOperationError = useTelegramStore((state) => state.clearOperationError);
  const clearMediaCache = useTelegramStore((state) => state.clearMediaCache);
  const recoverFile = useTelegramStore((state) => state.recoverFile);
  const cacheRetentionDays = usePreferencesStore((state) => state.cacheRetentionDays);
  const authenticate = useTelegramStore((state) => state.authenticate);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [downloadManagerOpen, setDownloadManagerOpen] = useState(false);
  const [managedDownloadRequests, setManagedDownloadRequests] = useState<ReadonlyMap<string, ManagedDownloadRequest>>(
    readManagedDownloadRequests,
  );
  const managedDownloadRequestsRef = useRef(managedDownloadRequests);
  managedDownloadRequestsRef.current = managedDownloadRequests;
  const [managedDownloadIndex] = useState(
    () => new ManagedDownloadIndex(telegramStore.getState().messages),
  );
  const [downloadIndexRevision, setDownloadIndexRevision] = useState(0);
  const [folderManagerOpen, setFolderManagerOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [managementChatId, setManagementChatId] = useState<string>();
  const [folderManagerInitialId, setFolderManagerInitialId] = useState<string>();
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const requestedDownloadsForAccount = useMemo(() => [...managedDownloadRequests.values()]
    .filter((request) => request.accountId === activeAccountId), [activeAccountId, managedDownloadRequests]);
  const managedDownloads = useMemo(
    () => managedDownloadIndex.collect(chats, requestedDownloadsForAccount),
    [chats, downloadIndexRevision, managedDownloadIndex, requestedDownloadsForAccount],
  );
  useEffect(() => subscribeMessageChanges((event) => {
    const changedFileIds = event.type === "reset"
      ? managedDownloadIndex.rebuild(event.messages)
      : event.type === "upsert"
        ? managedDownloadIndex.upsert(event.messages)
        : event.type === "replace"
          ? managedDownloadIndex.replace(event.oldMessageId, event.message)
          : managedDownloadIndex.remove(event.chatId, event.messageIds);
    if (changedFileIds.size === 0) return;
    const accountId = telegramStore.getState().activeAccountId;
    for (const fileId of changedFileIds) {
      if (!managedDownloadRequestsRef.current.has(`${accountId}:${fileId}`)) continue;
      setDownloadIndexRevision((revision) => revision + 1);
      break;
    }
  }), [managedDownloadIndex, subscribeMessageChanges]);
  useEffect(() => subscribeMessageChanges((event) => {
    if (event.type !== "upsert" || event.liveMessages.length === 0) return;
    const state = telegramStore.getState();
    const preferences = preferencesStore.getState();
    for (const message of event.liveMessages) {
      const chat = state.chats.get(message.chatId);
      if (!shouldNotifyMessage({
        outgoing: message.outgoing,
        notificationsEnabled: preferences.notificationsEnabled,
        muted: chat?.muted ?? false,
        activeChat: message.chatId === state.activeChatId,
        appVisible: document.visibilityState === "visible",
      })) continue;
      const presentation = notificationPresentation({
        showPreview: preferences.notificationPreview,
        chatTitle: chat?.title,
        messageText: messageContentText(message.content),
      });
      void showDesktopNotification({
        ...presentation,
        sound: preferences.notificationSound,
        route: {
          accountId: state.activeAccountId,
          chatId: message.chatId,
          messageId: message.id,
        },
      });
    }
  }), [subscribeMessageChanges]);
  useEffect(() => {
    writeManagedDownloadRequests(managedDownloadRequests.values());
  }, [managedDownloadRequests]);
  const requestDownload = useCallback((fileId: number, fileName: string) => {
    const key = `${activeAccountId}:${fileId}`;
    setManagedDownloadRequests((current) => {
      const next = new Map(current);
      next.set(key, managedDownloadIndex.createRequest(
        activeAccountId,
        fileId,
        fileName,
        chats,
        current.get(key),
      ));
      return next;
    });
    return downloadFile(fileId, fileName).then(() => {
      setManagedDownloadRequests((current) => {
        const record = current.get(key);
        if (!record) return current;
        const next = new Map(current);
        next.set(key, {
          ...record,
          status: "completed",
          error: undefined,
          updatedAt: new Date().toISOString(),
        });
        return next;
      });
    }).catch((error: unknown) => {
      setManagedDownloadRequests((current) => {
        const record = current.get(key);
        if (!record || record.status === "cancelled") return current;
        const message = error instanceof Error ? error.message : "文件下载失败";
        const next = new Map(current);
        next.set(key, {
          ...record,
          status: message.includes("取消") ? "cancelled" : "failed",
          error: message,
          updatedAt: new Date().toISOString(),
        });
        return next;
      });
    });
  }, [activeAccountId, chats, downloadFile, managedDownloadIndex]);
  const cancelManagedDownload = useCallback((fileId: number) => {
    const key = `${activeAccountId}:${fileId}`;
    setManagedDownloadRequests((current) => {
      const record = current.get(key);
      if (!record) return current;
      const next = new Map(current);
      next.set(key, {
        ...record,
        status: "cancelled",
        error: undefined,
        updatedAt: new Date().toISOString(),
      });
      return next;
    });
    return cancelFileDownload(fileId);
  }, [activeAccountId, cancelFileDownload]);
  const removeDownloadRecords = useCallback((fileIds: number[]) => {
    setManagedDownloadRequests((current) => {
      const next = new Map(current);
      for (const fileId of fileIds) next.delete(`${activeAccountId}:${fileId}`);
      return next;
    });
  }, [activeAccountId]);
  const sidebarSearch = useSidebarSearch({
    query: searchQuery,
    chatMessageSearch,
    onQueryChange: setSearchQuery,
    onSearchMessages: searchChatMessages,
    onClearSearch: clearChatMessageSearch,
  });
  const {
    scope: sidebarSearchScope,
    chatId: sidebarSearchChatId,
    senderId: chatSearchSenderId,
    stateMatchesInput: chatSearchStateMatchesInput,
    enterChat: enterChatSearch,
    exitScope: exitSidebarSearchScope,
    restoreScope: restoreSidebarSearchScope,
    setSenderId: setChatSearchSenderId,
  } = sidebarSearch;
  const sidebarSearchMessages = useTelegramStore((state) =>
    sidebarSearchChatId ? state.messages.get(sidebarSearchChatId) ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  );
  const conversationNavigation = useConversationNavigation();
  const {
    initialize: initializeConversationNavigation,
    reset: resetConversationNavigation,
    replace: replaceConversationNavigation,
    push: pushConversationNavigation,
    goBack: goBackConversationNavigation,
    goForward: goForwardConversationNavigation,
  } = conversationNavigation;
  useEffect(() => {
    if (phase !== "ready" || cacheRetentionDays <= 0) return;
    const key = `notgram:cache-cleanup:${activeAccountId}`;
    const lastRun = Number(globalThis.localStorage?.getItem(key) ?? 0);
    if (Date.now() - lastRun < 86_400_000) return;
    void clearMediaCache(["image", "video", "audio", "document", "other"], cacheRetentionDays)
      .then((succeeded) => {
        if (succeeded) globalThis.localStorage?.setItem(key, String(Date.now()));
      });
  }, [activeAccountId, cacheRetentionDays, clearMediaCache, phase]);
  const openChatManagement = useCallback((chatId: string) => {
    if (chats.get(chatId)?.management?.canOpenManagement !== true) return;
    clearProfile();
    setManagementChatId(chatId);
    void loadContacts();
  }, [chats, clearProfile, loadContacts]);
  const managementChat = managementChatId ? chats.get(managementChatId) : undefined;
  const loadManagement = useCallback((offset = 0) => managementChatId ? loadChatManagement(managementChatId, offset) : Promise.resolve(undefined), [loadChatManagement, managementChatId]);
  const addManagementMembers = useCallback((userIds: string[]) => managementChatId ? addChatMembers(managementChatId, userIds) : Promise.resolve(false), [addChatMembers, managementChatId]);
  const setManagementMemberStatus = useCallback((userId: string, status: import("../telegram/types").ChatMemberStatusInput) => managementChatId ? setChatMemberStatus(managementChatId, userId, status) : Promise.resolve(false), [managementChatId, setChatMemberStatus]);
  const setManagementMemberTag = useCallback((userId: string, tag: string) => managementChatId ? setChatMemberTag(managementChatId, userId, tag) : Promise.resolve(false), [managementChatId, setChatMemberTag]);
  const setManagementPermissions = useCallback((permissions: import("../telegram/types").ChatPermissions) => managementChatId ? setChatPermissions(managementChatId, permissions) : Promise.resolve(false), [managementChatId, setChatPermissions]);
  const setManagementSlowMode = useCallback((seconds: number) => managementChatId ? setChatSlowModeDelay(managementChatId, seconds) : Promise.resolve(false), [managementChatId, setChatSlowModeDelay]);
  const transferManagementOwnership = useCallback((userId: string, password: string) => managementChatId ? transferChatOwnership(managementChatId, userId, password) : Promise.resolve(false), [managementChatId, transferChatOwnership]);
  const loadManagementEvents = useCallback((fromEventId?: string) => managementChatId ? loadChatEventLog({ chatId: managementChatId, fromEventId, limit: 30 }) : Promise.resolve(undefined), [loadChatEventLog, managementChatId]);
  const getManagementInviteLinks = useCallback((offsetDate = 0, offsetLink = "") => managementChatId ? getChatInviteLinks({ chatId: managementChatId, creatorUserId: currentUserId, revoked: false, offsetDate, offsetLink, limit: 50 }) : Promise.resolve(undefined), [currentUserId, getChatInviteLinks, managementChatId]);
  const saveManagementInviteLink = useCallback((input: Omit<import("../telegram/types").CreateChatInviteLinkInput, "chatId">, inviteLink?: string) => {
    if (!managementChatId) return Promise.resolve(undefined);
    return inviteLink ? editChatInviteLink({ ...input, chatId: managementChatId, inviteLink }) : createChatInviteLink({ ...input, chatId: managementChatId });
  }, [createChatInviteLink, editChatInviteLink, managementChatId]);
  const revokeManagementInviteLink = useCallback((inviteLink: string) => managementChatId ? revokeChatInviteLink(managementChatId, inviteLink) : Promise.resolve(false), [managementChatId, revokeChatInviteLink]);
  const getManagementJoinRequests = useCallback((inviteLink?: string, offsetUserId?: string, offsetDate = 0) => managementChatId ? getChatJoinRequests({ chatId: managementChatId, inviteLink, offsetUserId, offsetDate, limit: 50 }) : Promise.resolve(undefined), [getChatJoinRequests, managementChatId]);
  const processManagementJoinRequest = useCallback((userId: string, approve: boolean) => managementChatId ? processChatJoinRequest(managementChatId, userId, approve) : Promise.resolve(false), [managementChatId, processChatJoinRequest]);
  const processManagementJoinRequests = useCallback((inviteLink: string | undefined, approve: boolean) => managementChatId ? processChatJoinRequests(managementChatId, inviteLink, approve) : Promise.resolve(false), [managementChatId, processChatJoinRequests]);
  const getComposerBotCommands = useCallback((query = "", botUsername?: string) => activeChatId
    ? getBotCommandSuggestions(activeChatId, query, botUsername)
    : Promise.resolve([]), [activeChatId, getBotCommandSuggestions]);
  const getComposerInlineResults = useCallback((botUsername: string, query: string, offset = "") => activeChatId ? getInlineQueryResults(activeChatId, botUsername, query, offset) : Promise.resolve(undefined), [activeChatId, getInlineQueryResults]);
  const sendComposerInlineResult = useCallback((botUserId: string, queryId: string, resultId: string, replyToMessageId?: string) => activeChatId ? sendInlineQueryResultMessage(activeChatId, botUserId, queryId, resultId, replyToMessageId, activeTopicId) : Promise.resolve(false), [activeChatId, activeTopicId, sendInlineQueryResultMessage]);
  const sendComposerBotStart = useCallback((botUserId: string, parameter = "") => activeChatId ? sendBotStartMessage(activeChatId, botUserId, parameter) : Promise.resolve(false), [activeChatId, sendBotStartMessage]);
  const toggleProfileBlock = useCallback((senderId: string, kind: "user" | "chat", blocked: boolean) => setMessageSenderBlocked(senderId, kind, blocked), [setMessageSenderBlocked]);
  const [conversationScrollRequest, setConversationScrollRequest] =
    useState<ConversationScrollRequest>();
  const conversationScrollRequestIdRef = useRef(0);
  const chatOpenGenerationRef = useRef(0);
  const issueConversationScrollRequest = useCallback((
    request: ConversationScrollRequestInput,
  ): ConversationScrollRequest => {
    const next = {
      ...request,
      requestId: ++conversationScrollRequestIdRef.current,
    } as ConversationScrollRequest;
    setConversationScrollRequest(next);
    return next;
  }, []);
  const conversationSnapshotRef = useRef<ConversationSwitchSnapshot | undefined>(undefined);
  const conversationSnapshotTargetRef = useRef<string | undefined>(undefined);
  const conversationSnapshotTimerRef =
    useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const discardConversationSnapshot = useCallback(() => {
    if (conversationSnapshotTimerRef.current !== undefined) {
      globalThis.clearTimeout(conversationSnapshotTimerRef.current);
      conversationSnapshotTimerRef.current = undefined;
    }
    removeConversationSwitchSnapshot(conversationSnapshotRef.current);
    conversationSnapshotRef.current = undefined;
    conversationSnapshotTargetRef.current = undefined;
  }, []);
  const beginConversationSnapshot = useCallback((
    targetIdentity: string,
    targetRendersConversation: boolean,
  ) => {
    const state = telegramStore.getState();
    const currentIdentity = state.activeChatId
      ? conversationIdentityFor(state.activeChatId, state.activeTopicId)
      : undefined;
    if (currentIdentity === targetIdentity) return;

    if (!targetRendersConversation) {
      captureActiveConversationScrollState();
      discardConversationSnapshot();
      return;
    }
    if (conversationSnapshotRef.current?.element.classList.contains("is-releasing")) {
      discardConversationSnapshot();
    }
    if (!conversationSnapshotRef.current) {
      conversationSnapshotRef.current = captureConversationSwitchSnapshot(targetIdentity);
    }
    captureActiveConversationScrollState();
    const snapshot = conversationSnapshotRef.current;
    if (!snapshot) return;

    conversationSnapshotTargetRef.current = targetIdentity;
    snapshot.element.dataset.snapshotTarget = targetIdentity;
    if (conversationSnapshotTimerRef.current !== undefined) {
      globalThis.clearTimeout(conversationSnapshotTimerRef.current);
    }
    conversationSnapshotTimerRef.current = globalThis.setTimeout(
      discardConversationSnapshot,
      CONVERSATION_SNAPSHOT_MAX_MS,
    );
  }, [discardConversationSnapshot]);
  const finishConversationSnapshot = useCallback((identity: string) => {
    if (
      conversationSnapshotTargetRef.current !== identity ||
      !conversationSnapshotRef.current
    ) return;
    const state = telegramStore.getState();
    const activeIdentity = state.activeChatId
      ? conversationIdentityFor(state.activeChatId, state.activeTopicId)
      : undefined;
    if (activeIdentity !== identity) return;

    if (conversationSnapshotTimerRef.current !== undefined) {
      globalThis.clearTimeout(conversationSnapshotTimerRef.current);
    }
    if (document.documentElement.classList.contains("reduce-motion")) {
      discardConversationSnapshot();
      return;
    }
    conversationSnapshotRef.current.element.classList.add("is-releasing");
    conversationSnapshotTimerRef.current = globalThis.setTimeout(
      discardConversationSnapshot,
      CONVERSATION_SNAPSHOT_RELEASE_MS,
    );
  }, [discardConversationSnapshot]);
  useEffect(() => {
    globalThis.addEventListener("resize", discardConversationSnapshot, { passive: true });
    return () => {
      globalThis.removeEventListener("resize", discardConversationSnapshot);
      discardConversationSnapshot();
    };
  }, [discardConversationSnapshot]);
  const openSettings = useCallback(() => {
    void openSettingsWindow()
      .then((opened) => { if (!opened) setSettingsOpen(true); })
      .catch(() => setSettingsOpen(true));
  }, []);

  const closeSearch = useCallback((restoreFocus = false, preserveGlobalResults = false) => {
    exitSidebarSearchScope(false);
    cancelGlobalSearch();
    if (!preserveGlobalResults) clearGlobalSearch();
    if (restoreFocus) {
      globalThis.setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [cancelGlobalSearch, clearGlobalSearch, exitSidebarSearchScope]);
  const searchAccountRef = useRef(activeAccountId);
  useEffect(() => {
    if (searchAccountRef.current === activeAccountId) return;
    searchAccountRef.current = activeAccountId;
    closeSearch();
  }, [activeAccountId, closeSearch]);

  const updateSearchQuery = useCallback((value: string) => {
    if (!value.trim()) {
      cancelGlobalSearch();
      clearGlobalSearch();
    }
    setSearchQuery(value);
  }, [cancelGlobalSearch, clearGlobalSearch, setSearchQuery]);

  const captureConversationLocation = useCallback((): ConversationNavigationLocation => {
    return {
      chatId: telegramStore.getState().activeChatId,
      topicId: telegramStore.getState().activeTopicId,
      chatFilter,
      searchQuery,
      searchScope: sidebarSearchScope,
      searchSenderId: chatSearchSenderId,
      globalSearchFilter: globalSearch.filter,
      globalSearchPending: globalSearch.loading,
      searchScrollTop: document.querySelector<HTMLElement>(
        ".global-search-results-panel .global-search-results",
      )?.scrollTop ?? 0,
      mobileChatOpen,
    };
  }, [chatFilter, chatSearchSenderId, globalSearch.filter, globalSearch.loading, mobileChatOpen, searchQuery, sidebarSearchScope]);

  const recordConversationNavigation = useCallback((location: ConversationNavigationLocation) => {
    replaceConversationNavigation(captureConversationLocation());
    pushConversationNavigation(location);
  }, [captureConversationLocation, pushConversationNavigation, replaceConversationNavigation]);

  const syncConversationNavigation = useCallback((location: ConversationNavigationLocation) => {
    resetConversationNavigation(location);
  }, [resetConversationNavigation]);

  const locationForChat = useCallback((chatId: string, topicId?: string): ConversationNavigationLocation => ({
    ...captureConversationLocation(),
    chatId,
    topicId,
    searchQuery: "",
    searchScope: { type: "global" },
    searchSenderId: undefined,
    globalSearchPending: false,
    searchScrollTop: 0,
    mobileChatOpen: true,
  }), [captureConversationLocation]);

  const restoreConversationLocation = useCallback(async (location: ConversationNavigationLocation) => {
    setChatFilter(location.chatFilter);
    setMobileChatOpen(location.mobileChatOpen);
    restoreSidebarSearchScope(location.searchScope, location.searchSenderId);
    setSearchQuery(location.searchQuery);
    let searchRestore: Promise<void> | undefined;
    if (location.searchScope.type === "global" && location.searchQuery.trim()) {
      const currentSearch = telegramStore.getState().globalSearch;
      if (
        location.globalSearchPending ||
        currentSearch.query !== location.searchQuery.trim() ||
        currentSearch.filter !== location.globalSearchFilter
      ) {
        searchRestore = searchGlobal(location.searchQuery, location.globalSearchFilter);
      }
    } else if (location.searchScope.type === "chat" && (
      location.searchQuery.trim() || location.searchSenderId
    )) {
      searchRestore = searchChatMessages({
        chatId: location.searchScope.chatId,
        query: location.searchQuery,
        senderId: location.searchSenderId,
        filter: "all",
      });
    } else {
      cancelGlobalSearch();
      clearGlobalSearch();
    }
    const restoreSearchScroll = () => requestAnimationFrame(() => requestAnimationFrame(() => {
      const results = document.querySelector<HTMLElement>(
        ".global-search-results-panel .global-search-results",
      );
      if (results) results.scrollTop = location.searchScrollTop;
    }));
    if (location.chatId) {
      const state = telegramStore.getState();
      const targetChat = state.chats.get(location.chatId);
      beginConversationSnapshot(
        conversationIdentityFor(location.chatId, location.topicId),
        !targetChat?.isForum || Boolean(location.topicId),
      );
      flushSync(() => {
        issueConversationScrollRequest({ kind: "entry", chatId: location.chatId! });
        state.selectChat(location.chatId!, {
          forumTopicId: location.topicId,
        });
      });
    }
    await (searchRestore ?? Promise.resolve());
    restoreSearchScroll();
  }, [beginConversationSnapshot, cancelGlobalSearch, clearGlobalSearch, issueConversationScrollRequest, restoreSidebarSearchScope, searchChatMessages, searchGlobal, setChatFilter, setSearchQuery]);

  const navigateBack = useCallback(() => {
    const location = goBackConversationNavigation();
    if (location) void restoreConversationLocation(location);
  }, [goBackConversationNavigation, restoreConversationLocation]);

  const navigateForward = useCallback(() => {
    const location = goForwardConversationNavigation();
    if (location) void restoreConversationLocation(location);
  }, [goForwardConversationNavigation, restoreConversationLocation]);

  useEffect(() => {
    if (!chatListReady || authorization.kind !== "ready") return;
    initializeConversationNavigation(captureConversationLocation());
  }, [authorization.kind, captureConversationLocation, chatListReady, initializeConversationNavigation]);

  useEffect(() => {
    const routePointerButton = (event: PointerEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.button === 3) navigateBack();
      else navigateForward();
    };
    window.addEventListener("pointerdown", routePointerButton, true);
    return () => window.removeEventListener("pointerdown", routePointerButton, true);
  }, [navigateBack, navigateForward]);

  const openChatSearch = useCallback((chatId: string, senderId?: string) => {
    if (!chatId) return;
    cancelGlobalSearch();
    clearGlobalSearch();
    enterChatSearch(chatId, senderId);
    clearProfile();
    setMobileChatOpen(false);
    globalThis.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);
  }, [cancelGlobalSearch, clearGlobalSearch, clearProfile, enterChatSearch]);

  const openFolderManager = useCallback((folderId?: string) => {
    setFolderManagerInitialId(folderId);
    setFolderManagerOpen(true);
  }, []);

  const closeFolderManager = useCallback(() => {
    setFolderManagerOpen(false);
    setFolderManagerInitialId(undefined);
  }, []);

  const openGlobalSearchChat = useCallback((chatId: string, recordNavigation = false) => {
    const state = telegramStore.getState();
    const targetTopicId = state.chats.get(chatId)?.isForum
      ? state.lastForumTopicIds.get(chatId) ?? state.forumTopics.get(chatId)?.find((topic) => !topic.isHidden)?.id
      : undefined;
    const targetMessages = (state.messages.get(chatId) ?? [])
      .filter((message) => !targetTopicId || message.topicId === targetTopicId);
    const performanceTraceId = beginConversationSwitch({
      cached: targetMessages.length > 0,
      messageCount: targetMessages.length,
      viewTransition: false,
      navigationKind: 3,
    });
    markConversationSwitch(performanceTraceId, "transitionStarted");
    markConversationSwitch(performanceTraceId, "selectionCommitted");
    const targetLocation = locationForChat(chatId, targetTopicId);
    if (recordNavigation) recordConversationNavigation(targetLocation);
    else syncConversationNavigation(targetLocation);
    closeSearch(false, true);
    chatOpenGenerationRef.current += 1;
    beginConversationSnapshot(
      conversationIdentityFor(chatId, targetTopicId),
      !state.chats.get(chatId)?.isForum || Boolean(targetTopicId),
    );
    flushSync(() => {
      setMobileChatOpen(true);
      issueConversationScrollRequest({
        kind: "latest",
        chatId,
        performanceTraceId,
      });
      state.selectChat(chatId, { forumTopicId: targetTopicId });
    });
    requestAnimationFrame(() => {
      markConversationSwitch(performanceTraceId, "transitionFinished");
    });
  }, [beginConversationSnapshot, closeSearch, issueConversationScrollRequest, locationForChat, recordConversationNavigation, syncConversationNavigation]);

  const openGlobalSearchMessage = useCallback(async (
    chatId: string,
    messageId: string,
    options?: {
      behavior?: "auto" | "smooth";
      highlight?: boolean;
      loadContext?: boolean;
      recordNavigation?: boolean;
    },
  ) => {
    const generation = chatOpenGenerationRef.current + 1;
    chatOpenGenerationRef.current = generation;
    const state = telegramStore.getState();
    const cachedTarget = state.messages.get(chatId)?.find((message) => message.id === messageId);
    const targetMessages = (state.messages.get(chatId) ?? [])
      .filter((message) => !cachedTarget?.topicId || message.topicId === cachedTarget.topicId);
    const performanceTraceId = beginConversationSwitch({
      cached: Boolean(cachedTarget),
      messageCount: targetMessages.length,
      viewTransition: false,
      navigationKind: 3,
    });
    if (!cachedTarget || options?.loadContext) {
      markConversationSwitch(performanceTraceId, "asyncWaitStarted");
      let loadFailed = true;
      try {
        loadFailed = !(await loadMessage(
          chatId,
          messageId,
          { forceContext: Boolean(options?.loadContext) },
        ));
      } finally {
        markConversationSwitch(performanceTraceId, "asyncWaitFinished", { failed: loadFailed });
      }
      if (chatOpenGenerationRef.current !== generation) return;
    }
    if (chatOpenGenerationRef.current !== generation) return;
    const loadedState = telegramStore.getState();
    const targetTopicId = loadedState.chats.get(chatId)?.isForum
      ? loadedState.messages.get(chatId)?.find((message) => message.id === messageId)?.topicId
      : undefined;
    const targetLocation = locationForChat(chatId, targetTopicId);
    if (options?.recordNavigation) recordConversationNavigation(targetLocation);
    else syncConversationNavigation(targetLocation);
    const destinationAlreadyActive = loadedState.activeChatId === chatId && (
      !loadedState.chats.get(chatId)?.isForum ||
      !targetTopicId ||
      loadedState.activeTopicId === targetTopicId
    );
    closeSearch(false, true);
    markConversationSwitch(performanceTraceId, "transitionStarted");
    markConversationSwitch(performanceTraceId, "selectionCommitted");
    beginConversationSnapshot(
      conversationIdentityFor(chatId, targetTopicId),
      true,
    );
    flushSync(() => {
      setMobileChatOpen(true);
      issueConversationScrollRequest({
        kind: "message",
        chatId,
        messageId,
        performanceTraceId,
        behavior: options?.behavior,
        highlight: options?.highlight,
      });
      if (!destinationAlreadyActive) {
        loadedState.selectChat(chatId, { forumTopicId: targetTopicId });
      }
    });
    requestAnimationFrame(() => {
      markConversationSwitch(performanceTraceId, "transitionFinished");
    });
  }, [beginConversationSnapshot, closeSearch, issueConversationScrollRequest, loadMessage, locationForChat, recordConversationNavigation, syncConversationNavigation]);

  const openProfileMessage = useCallback((chatId: string, messageId: string) => {
    clearProfile();
    void openGlobalSearchMessage(chatId, messageId);
  }, [clearProfile, openGlobalSearchMessage]);

  useEffect(() => {
    const openTelegramLink = (event: Event) => {
      const detail = (event as CustomEvent<TelegramLinkTarget>).detail;
      if (detail && isTelegramUserLink(detail)) {
        void loadUserProfile(detail.userId);
        return;
      }
      if (!detail || !("chatId" in detail)) return;
      if (typeof detail?.chatId !== "string" || !detail.chatId) return;
      if (typeof detail.messageId === "string" && detail.messageId) {
        void openGlobalSearchMessage(detail.chatId, detail.messageId, { recordNavigation: true });
      } else {
        void openGlobalSearchChat(detail.chatId, true);
      }
    };
    globalThis.addEventListener("notgram:telegram-link-opened", openTelegramLink);
    return () => globalThis.removeEventListener("notgram:telegram-link-opened", openTelegramLink);
  }, [loadUserProfile, openGlobalSearchChat, openGlobalSearchMessage]);

  const openProfilePrivateChat = useCallback(async (userId: string) => {
    const chatId = await startPrivateChat(userId);
    if (!chatId) return;
    clearProfile();
    openGlobalSearchChat(chatId);
  }, [clearProfile, openGlobalSearchChat, startPrivateChat]);

  const openMentionProfile = useCallback(async (username?: string, userId?: string) => {
    const link = userId
      ? `tg://user?id=${encodeURIComponent(userId)}`
      : username ? `https://t.me/${encodeURIComponent(username)}` : undefined;
    if (!link) return;
    const target = await telegramStore.getState().resolveTelegramLink(link);
    if (!target || ("kind" in target && target.kind === "unsupported")) return;
    if (isTelegramUserLink(target)) {
      void loadUserProfile(target.userId);
    } else {
      void loadChatProfile(target.chatId);
    }
  }, [loadChatProfile, loadUserProfile]);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const routeMediaSpacebar = (event: globalThis.KeyboardEvent) => {
      if (
        (event.code !== "Space" && event.key !== " ") ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat
      ) {
        return;
      }
      const target = event.target;
      const isTextEntry = target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLInputElement && [
          "text", "search", "email", "url", "tel", "password", "number",
        ].includes(target.type)) ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (isTextEntry || !mediaPlaybackCoordinator.toggleKeyboardTarget()) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    };
    window.addEventListener("keydown", routeMediaSpacebar, { capture: true });
    return () => window.removeEventListener("keydown", routeMediaSpacebar, { capture: true });
  }, []);

  useEffect(() => {
    const openSearch = (event: globalThis.KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
        !event.repeat && event.key.toLocaleLowerCase() === "j"
      ) {
        event.preventDefault();
        setSettingsOpen(false);
        setDownloadManagerOpen(true);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setSettingsOpen(false);
        setMobileChatOpen(false);
        clearProfile();
        globalThis.setTimeout(() => searchInputRef.current?.focus(), 0);
        return;
      }
      if (
        !activeChatId ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.repeat ||
        event.key.toLocaleLowerCase() !== "f" ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      ) return;
      event.preventDefault();
      openChatSearch(activeChatId);
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, [activeChatId, clearProfile, openChatSearch]);

  const openNotificationRoute = useCallback(async (route: DesktopNotificationRoute) => {
    const state = telegramStore.getState();
    if (route.accountId !== state.activeAccountId) {
      savePendingNotificationRoute(route);
      if (!await state.switchAccount(route.accountId)) clearPendingNotificationRoute();
      return;
    }

    exitSidebarSearchScope(false);
    state.clearGlobalSearch();
    state.clearProfile();
    const generation = chatOpenGenerationRef.current + 1;
    chatOpenGenerationRef.current = generation;
    await telegramStore.getState().loadMessage(route.chatId, route.messageId);
    if (chatOpenGenerationRef.current !== generation) return;
    const loadedState = telegramStore.getState();
    const targetTopicId = loadedState.chats.get(route.chatId)?.isForum
      ? loadedState.messages.get(route.chatId)?.find((message) => message.id === route.messageId)?.topicId
      : undefined;
    syncConversationNavigation(locationForChat(route.chatId, targetTopicId));
    clearPendingNotificationRoute();
    beginConversationSnapshot(
      conversationIdentityFor(route.chatId, targetTopicId),
      true,
    );
    flushSync(() => {
      setMobileChatOpen(true);
      issueConversationScrollRequest({
        kind: "message",
        chatId: route.chatId,
        messageId: route.messageId,
      });
      loadedState.selectChat(route.chatId, { forumTopicId: targetTopicId });
    });
  }, [beginConversationSnapshot, exitSidebarSearchScope, issueConversationScrollRequest, locationForChat, syncConversationNavigation]);

  useEffect(() => {
    let disposed = false;
    let unlisten: () => void = () => undefined;
    void listenForDesktopNotificationOpen((route) => {
      if (!disposed) void openNotificationRoute(route);
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, [openNotificationRoute]);

  useEffect(() => {
    if (!chatListReady || authorization.kind !== "ready") return;
    const pendingRoute = readPendingNotificationRoute();
    if (pendingRoute?.accountId === activeAccountId) {
      void openNotificationRoute(pendingRoute);
    }
  }, [activeAccountId, authorization.kind, chatListReady, openNotificationRoute]);

  useEffect(() => {
    const markWhenVisible = () => {
      if (document.visibilityState === "visible") void markActiveChatRead();
    };
    document.addEventListener("visibilitychange", markWhenVisible);
    window.addEventListener("focus", markWhenVisible);
    return () => {
      document.removeEventListener("visibilitychange", markWhenVisible);
      window.removeEventListener("focus", markWhenVisible);
    };
  }, [markActiveChatRead]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // A blocked preference store should not affect the messaging UI.
    }
  }, [sidebarWidth]);

  const previewSidebarWidth = useCallback((width: number) => {
    document.documentElement.style.setProperty("--chat-sidebar-width", `${width}px`);
  }, []);

  useLayoutEffect(() => {
    previewSidebarWidth(sidebarWidth);
  }, [previewSidebarWidth, sidebarWidth]);

  const visibleChats = useMemo(
    () => filterAndSortChats(chats.values(), chatFilter, searchQuery),
    [chatFilter, chats, searchQuery],
  );
  const forwardTargets = useMemo(
    () => [...chats.values()].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    ),
    [chats],
  );
  const chatSearchSenderOptions = useMemo<SidebarSearchSenderOption[]>(() => {
    if (!sidebarSearchChatId) return [];
    const seen = new Set<string>();
    const options: SidebarSearchSenderOption[] = [];
    const add = (id: string, label: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      options.push({ id, label });
    };
    const management = groupManagement?.chatId === sidebarSearchChatId ? groupManagement : undefined;
    for (const member of management?.members ?? []) add(member.user.id, member.user.displayName);
    for (const message of sidebarSearchMessages) {
      if (message.senderId === "self") add(message.senderId, "我");
      else if (message.senderId.startsWith("chat:")) {
        const senderChat = chats.get(message.senderId.slice("chat:".length));
        add(message.senderId, senderChat?.title ?? "群组账号");
      } else {
        add(message.senderId, users.get(message.senderId)?.displayName ?? "Telegram 用户");
      }
    }
    return options.sort((left, right) => left.label.localeCompare(right.label, "zh-Hans"));
  }, [chats, groupManagement, sidebarSearchChatId, sidebarSearchMessages, users]);
  const activeOutbox = activeChatId
    ? outbox.filter((item) => item.chatId === activeChatId && item.topicId === activeTopicId)
    : [];

  const openLatestConversation = (chatId: string) => {
    chatOpenGenerationRef.current += 1;
    setMobileChatOpen(true);
    const state = telegramStore.getState();
    const targetTopicId = state.chats.get(chatId)?.isForum ? state.activeTopicId : undefined;
    const targetMessages = (state.messages.get(chatId) ?? [])
      .filter((message) => !targetTopicId || message.topicId === targetTopicId);
    const performanceTraceId = beginConversationSwitch({
      cached: targetMessages.length > 0,
      messageCount: targetMessages.length,
      viewTransition: false,
      navigationKind: 2,
    });
    markConversationSwitch(performanceTraceId, "transitionStarted");
    markConversationSwitch(performanceTraceId, "selectionCommitted");
    beginConversationSnapshot(
      conversationIdentityFor(chatId, targetTopicId),
      !state.chats.get(chatId)?.isForum || Boolean(targetTopicId),
    );
    flushSync(() => {
      issueConversationScrollRequest({
        kind: "latest",
        chatId,
        performanceTraceId,
      });
    });
    requestAnimationFrame(() => {
      markConversationSwitch(performanceTraceId, "transitionFinished");
    });
    if (state.activeChatId !== chatId || (state.chats.get(chatId)?.isForum && !state.activeTopicId)) {
      state.selectChat(chatId);
    }
  };

  const openForumTopic = (topicId: string) => {
    const state = telegramStore.getState();
    const chatId = state.activeChatId;
    if (!chatId || !state.chats.get(chatId)?.isForum || state.activeTopicId === topicId) return;
    const generation = chatOpenGenerationRef.current + 1;
    chatOpenGenerationRef.current = generation;
    const targetMessages = (state.messages.get(chatId) ?? [])
      .filter((message) => message.topicId === topicId);
    const targetTopic = state.forumTopics.get(chatId)?.find((topic) => topic.id === topicId);
    const targetScrollScope = `${activeAccountId}:topic:${topicId}`;
    const restoreLocally = hasConversationScrollMemory(targetScrollScope, chatId);
    const serverMessageId = !restoreLocally && (targetTopic?.unreadCount ?? 0) > 0
      ? targetTopic?.lastReadInboxMessageId
      : undefined;
    const serverMessageLoaded = Boolean(
      serverMessageId && targetMessages.some((message) => message.id === serverMessageId),
    );
    const performanceTraceId = beginConversationSwitch({
      cached: targetMessages.length > 0,
      messageCount: targetMessages.length,
      viewTransition: false,
      navigationKind: 4,
    });
    syncConversationNavigation(locationForChat(chatId, topicId));
    markConversationSwitch(performanceTraceId, "transitionStarted");
    beginConversationSnapshot(
      conversationIdentityFor(chatId, topicId),
      true,
    );
    flushSync(() => {
      issueConversationScrollRequest({
        kind: "entry",
        chatId,
        serverMessageId,
        performanceTraceId,
      });
      state.selectForumTopic(topicId);
    });
    markConversationSwitch(performanceTraceId, "selectionCommitted");
    requestAnimationFrame(() => {
      markConversationSwitch(performanceTraceId, "transitionFinished");
    });
    if (serverMessageId && !serverMessageLoaded) {
      void (async () => {
        markConversationSwitch(performanceTraceId, "asyncWaitStarted");
        let loaded = false;
        try {
          loaded = await telegramStore.getState().loadMessage(chatId, serverMessageId);
        } finally {
          markConversationSwitch(performanceTraceId, "asyncWaitFinished", { failed: !loaded });
        }
        if (loaded || chatOpenGenerationRef.current !== generation) return;
        flushSync(() => {
          issueConversationScrollRequest({
            kind: "entry",
            chatId,
            performanceTraceId,
          });
        });
      })();
    }
  };

  const activeMessages = useMemo(
    () => activeTopicId
      ? activeChatMessages.filter((message) => message.topicId === activeTopicId)
      : activeChatMessages,
    [activeChatMessages, activeTopicId],
  );
  const activeRemovingMessages = useMemo(
    () => activeTopicId
      ? activeRemovingSource.filter((message) => message.topicId === activeTopicId)
      : activeRemovingSource,
    [activeRemovingSource, activeTopicId],
  );
  const activeDisplayMessages = useMemo(
    () => activeRemovingMessages.length > 0
      ? [...activeMessages, ...activeRemovingMessages].sort((left, right) =>
          Date.parse(left.sentAt) - Date.parse(right.sentAt),
        )
      : activeMessages,
    [activeMessages, activeRemovingMessages],
  );

  if (!chatListReady && (authorization.kind === "preparing" || authorization.kind === "ready")) {
    return phase === "error" ? (
      <div className="startup-screen startup-error" role="alert">
        <CircleAlert size={19} />
        <span>{error ?? "无法载入会话"}</span>
      </div>
    ) : (
      <div className="startup-screen" role="status">
        <LoaderCircle className="spin" size={19} />
        <span>{connectionPresentation(connectionStatus).label}</span>
      </div>
    );
  }

  if (authorization.kind !== "ready" && authorization.kind !== "preparing") {
    return (
      <>
      <AuthorizationScreen
        state={authorization}
        pending={authorizationPending}
        error={authorizationError}
        connectionStatus={connectionStatus}
        onSubmit={authenticate}
        onOpenSettings={openSettings}
      />
      <MotionPresence present={settingsOpen}>
        {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      </MotionPresence>
      </>
    );
  }

  const activeChat = activeChatId ? chats.get(activeChatId) : undefined;
  const activeTopics = activeChatId ? forumTopics.get(activeChatId) ?? [] : [];
  const activeTopic = activeTopicId ? activeTopics.find((topic) => topic.id === activeTopicId) : undefined;
  const activeHistory = activeChatId
    ? (activeTopicId
      ? topicHistories.get(`${activeChatId}:topic:${activeTopicId}`)
      : histories.get(activeChatId)) ?? { loading: false, hasMore: true, initialized: false }
    : { loading: false, hasMore: false, initialized: false };
  const activeChatList = chatLists.get(chatFilter) ?? { loading: false, hasMore: true };

  return (
    <>
      <main
        inert={settingsOpen || downloadManagerOpen || folderManagerOpen || newChatOpen || Boolean(pendingConfirmation) || Boolean(managementChatId)}
        aria-hidden={settingsOpen || downloadManagerOpen || folderManagerOpen || newChatOpen || Boolean(pendingConfirmation) || Boolean(managementChatId) || undefined}
        className={`app-shell ${mobileChatOpen ? "mobile-chat-open" : ""}`}
      >
        <NavigationRail
          folders={folders}
          chats={[...chats.values()]}
          account={currentUserId ? users.get(currentUserId) : undefined}
          accounts={accounts}
          activeAccountId={activeAccountId}
          accountPending={accountPending}
          filter={chatFilter}
          folderManagementPending={folderManagementPending}
          onFilterChange={(filter) => {
            closeSearch();
            setChatFilter(filter);
          }}
          onManageFolders={() => openFolderManager()}
          onEditFolder={openFolderManager}
          onMarkFolderRead={markChatFolderRead}
          onRequestDeleteFolder={(folder) => setPendingConfirmation({
            kind: "deleteFolder",
            folderId: folder.id,
            title: folder.title,
          })}
          onOpenSettings={openSettings}
          onAddAccount={addAccount}
          onSwitchAccount={switchAccount}
        />
        <ChatSidebar
          chats={visibleChats}
          allChats={chats}
          users={users}
          folders={folders}
          activeChatId={activeChatId}
          folderId={chatFilter}
          folderTitle={folders.find((folder) => folder.id === chatFilter)?.title ?? "聊天"}
          searchQuery={searchQuery}
          searchInputRef={searchInputRef}
          onSearchChange={updateSearchQuery}
          globalSearch={globalSearch}
          onSearchMessages={searchGlobal}
          onLoadMoreSearchMessages={loadMoreGlobalSearch}
          onCancelMessageSearch={cancelGlobalSearch}
          onOpenSearchMessage={(chatId, messageId) => {
            void openGlobalSearchMessage(chatId, messageId);
          }}
          searchScope={sidebarSearchScope}
          chatMessageSearch={chatMessageSearch}
          chatSearchSenderId={chatSearchSenderId}
          chatSearchSenderOptions={chatSearchSenderOptions}
          chatSearchStateMatchesInput={chatSearchStateMatchesInput}
          onChatSearchSenderChange={setChatSearchSenderId}
          onLoadMoreChatSearch={loadMoreChatMessages}
          onExitSearchScope={(preserveQuery) => {
            exitSidebarSearchScope(preserveQuery);
            if (preserveQuery) {
              cancelGlobalSearch();
              clearGlobalSearch();
            }
          }}
          onSelect={(chatId) => {
            if (searchQuery.trim()) void openGlobalSearchChat(chatId);
            else {
              setMobileChatOpen(true);
              const state = telegramStore.getState();
              if (state.activeChatId === chatId) {
                openLatestConversation(chatId);
                return;
              }
              const generation = chatOpenGenerationRef.current + 1;
              chatOpenGenerationRef.current = generation;
              const targetChat = state.chats.get(chatId);
              const restoredTopicId = targetChat?.isForum
                ? state.lastForumTopicIds.get(chatId) ??
                  state.forumTopics.get(chatId)?.find((topic) => !topic.isHidden)?.id
                : undefined;
              const restoredTopic = restoredTopicId
                ? state.forumTopics.get(chatId)?.find((topic) => topic.id === restoredTopicId)
                : undefined;
              syncConversationNavigation(locationForChat(chatId, restoredTopicId));
              const serverMessageId = restoredTopicId
                ? (restoredTopic?.unreadCount ?? 0) > 0
                  ? restoredTopic?.lastReadInboxMessageId
                  : undefined
                : targetChat && targetChat.unreadCount > 0
                  ? targetChat.lastReadInboxMessageId
                  : undefined;
              const serverMessageLoaded = Boolean(
                serverMessageId &&
                (state.messages.get(chatId) ?? []).some(
                  (message) => message.id === serverMessageId && (
                    !restoredTopicId || message.topicId === restoredTopicId
                  ),
                ),
              );
              const targetScrollScope = restoredTopicId
                ? `${activeAccountId}:topic:${restoredTopicId}`
                : activeAccountId;
              const restoreLocally = hasConversationScrollMemory(targetScrollScope, chatId);
              const targetMessages = (state.messages.get(chatId) ?? [])
                .filter((message) => !restoredTopicId || message.topicId === restoredTopicId);
              const performanceTraceId = beginConversationSwitch({
                cached: targetMessages.length > 0,
                messageCount: targetMessages.length,
                viewTransition: false,
                navigationKind: 1,
              });
              markConversationSwitch(performanceTraceId, "transitionStarted");
              markConversationSwitch(performanceTraceId, "selectionCommitted");
              beginConversationSnapshot(
                conversationIdentityFor(chatId, restoredTopicId),
                !targetChat?.isForum || Boolean(restoredTopicId),
              );
              flushSync(() => {
                issueConversationScrollRequest({
                  kind: "entry",
                  chatId,
                  serverMessageId: restoreLocally ? undefined : serverMessageId,
                  performanceTraceId,
                });
                state.selectChat(chatId);
              });
              requestAnimationFrame(() => {
                markConversationSwitch(performanceTraceId, "transitionFinished");
              });
              if (serverMessageId && !serverMessageLoaded && !restoreLocally) {
                void (async () => {
                  markConversationSwitch(performanceTraceId, "asyncWaitStarted");
                  let loaded = false;
                  try {
                    loaded = await telegramStore.getState().loadMessage(
                      chatId,
                      serverMessageId,
                    );
                  } finally {
                    markConversationSwitch(performanceTraceId, "asyncWaitFinished", { failed: !loaded });
                  }
                  if (loaded || chatOpenGenerationRef.current !== generation) return;
                  flushSync(() => {
                    issueConversationScrollRequest({
                      kind: "entry",
                      chatId,
                      performanceTraceId,
                    });
                  });
                })();
              }
            }
          }}
          loadingMore={activeChatList.loading}
          hasMore={activeChatList.hasMore}
          onLoadMore={() => loadMoreChats(chatFilter)}
          onReorderPinned={(chatIds) => { void reorderPinnedChats(chatFilter, chatIds); }}
          chatManagementPending={chatManagementPending}
          folderManagementPending={folderManagementPending}
          onSetPinned={setChatPinned}
          onSetFolderMembership={setChatFolderMembership}
          onRequestLeaveGroup={(chat) => setPendingConfirmation({
            kind: "leaveGroup",
            chatId: chat.id,
            title: chat.title,
          })}
          onCreateChat={() => setNewChatOpen(true)}
          width={sidebarWidth}
          onWidthPreview={previewSidebarWidth}
          onWidthChange={setSidebarWidth}
        />
        {activeChat?.isForum && (!activeTopicId || !activeTopic) ? (
          <ForumTopicsView
            chat={activeChat}
            topics={activeTopics}
            loading={activeChatId ? forumTopicsLoading.has(activeChatId) : false}
            onBack={() => setMobileChatOpen(false)}
            onSelectTopic={openForumTopic}
            onCreateTopic={(name) => activeChatId ? createForumTopic(activeChatId, name) : Promise.resolve(undefined)}
            onEditTopic={(topicId, name) => activeChatId ? editForumTopic(activeChatId, topicId, name) : Promise.resolve(false)}
            onSetTopicClosed={(topicId, closed) => activeChatId ? setForumTopicClosed(activeChatId, topicId, closed) : Promise.resolve(false)}
            onSetTopicPinned={(topicId, pinned) => activeChatId ? setForumTopicPinned(activeChatId, topicId, pinned) : Promise.resolve(false)}
          />
        ) : (
          <Profiler
            id="conversation"
            onRender={(_id, phase, actualDuration, baseDuration, startTime) => {
              const performanceTraceId = conversationScrollRequest?.chatId === activeChatId
                ? conversationScrollRequest?.performanceTraceId
                : undefined;
              queueMicrotask(() => {
                const tracing = isConversationSwitchActive(performanceTraceId);
                markConversationSwitch(performanceTraceId, "reactCommitted", {
                  durationMs: actualDuration,
                });
                if (actualDuration >= 4) {
                  logPerformance("ui_react_commit", {
                    startTimeMs: startTime,
                    durationMs: actualDuration,
                    baseDurationMs: baseDuration,
                    phaseKind: phase === "mount" ? 1 : 2,
                    componentKind: 1,
                    traceId: tracing ? performanceTraceId : undefined,
                    duringConversationSwitch: tracing,
                  });
                }
              });
            }}
          >
            <Conversation
              key={activeTopicId ? `${activeChatId}:topic:${activeTopicId}` : activeChatId ?? "empty-conversation"}
              chat={activeChat}
          topic={activeTopic}
          topics={activeTopics}
          onSelectTopic={openForumTopic}
          scrollScope={activeTopicId ? `${activeAccountId}:topic:${activeTopicId}` : activeAccountId}
          scrollRequest={conversationScrollRequest}
          messages={activeDisplayMessages}
          chatMessages={activeChatMessages}
          forwardTargets={forwardTargets}
          forumTopics={forumTopics}
          users={users}
          historyLoading={activeHistory.loading}
          historyInitialized={activeHistory.initialized === true}
          hasOlderMessages={activeHistory.hasMore}
          connectionStatus={connectionStatus}
          queuedMessageCount={activeOutbox.filter((item) => item.status === "queued" && !item.attachments?.length).length}
          failedQueuedMessageCount={activeOutbox.filter((item) => item.status === "failed" && !item.attachments?.length).length}
          queuedAttachmentCount={activeOutbox
            .filter((item) => item.status === "queued")
            .reduce((count, item) => count + (item.attachments?.length ?? 0), 0)}
          failedAttachmentCount={activeOutbox
            .filter((item) => item.status === "failed")
            .reduce((count, item) => count + (item.attachments?.length ?? 0), 0)}
          typingUserIds={activeChatId ? typingUserIds.get(activeChatId) ?? [] : []}
          chatListId={activeChat?.folderIds.includes(chatFilter)
            ? chatFilter
            : activeChat?.folderIds.includes("archive") ? "archive" : "main"}
          chatManagementPending={activeChatId
            ? chatManagementPending.has(activeChatId)
            : false}
          onSendMessage={sendMessage}
          onEditMessage={editMessage}
          onDeleteMessage={deleteMessage}
          onDraftChange={updateChatDraft}
          onTypingChange={setChatTyping}
          onForwardMessages={forwardMessages}
          onLoadForumTopics={loadForumTopics}
          onLoadMessageProperties={loadMessageProperties}
          onSetMessageReaction={setMessageReaction}
          onSetPollAnswer={setPollAnswer}
          onBotCallback={getCallbackQueryAnswer}
          onLoadPinnedMessages={loadPinnedMessages}
          onPinMessage={pinMessage}
          onUnpinMessage={unpinMessage}
          onSetChatMessageAutoDeleteTime={setChatMessageAutoDeleteTime}
          onDownloadFile={requestDownload}
          onCancelFileDownload={cancelManagedDownload}
          onRecoverFile={recoverFile}
          onOpenFile={openFile}
          onSaveFileAs={saveFileAs}
          onOpenDownloadDirectory={openDownloadDirectory}
          onStreamFile={streamFile}
          onSuspendFileStream={suspendFileStream}
          onRetryMessage={retryMessage}
          onSendFiles={sendFiles}
          onCancelFileUpload={cancelFileUpload}
          onLoadOlder={() => activeChatId ? loadMoreHistory(activeChatId) : Promise.resolve()}
          onOpenProfile={() => { if (activeChatId) void loadChatProfile(activeChatId); }}
          onViewportReady={finishConversationSnapshot}
          onOpenMessage={(chatId, messageId, options) => {
            void openGlobalSearchMessage(chatId, messageId, {
              ...options,
              recordNavigation: true,
            });
          }}
          onOpenMessageSearch={(senderId) => {
            if (activeChatId) openChatSearch(activeChatId, senderId);
          }}
          onOpenChat={(chatId) => {
            void openGlobalSearchChat(chatId, true);
          }}
          onOpenSenderProfile={(senderId) => {
            if (senderId.startsWith("chat:")) void loadChatProfile(senderId.slice("chat:".length));
            else void loadUserProfile(senderId);
          }}
          onOpenMention={openMentionProfile}
          onStartPrivateChat={(senderId) => { void openProfilePrivateChat(senderId); }}
          onSetChatPinned={(pinned) => activeChatId
            ? setChatPinned(
                activeChat?.folderIds.includes(chatFilter)
                  ? chatFilter
                  : activeChat?.folderIds.includes("archive") ? "archive" : "main",
                activeChatId,
                pinned,
              )
            : Promise.resolve(false)}
          onSetChatMuted={(muted) => activeChatId
            ? setChatMuted(activeChatId, muted)
            : Promise.resolve(false)}
          onSetChatArchived={(archived) => activeChatId
            ? setChatArchived(activeChatId, archived)
            : Promise.resolve(false)}
          onGetBotCommands={getComposerBotCommands}
          onGetInlineResults={getComposerInlineResults}
          onSendInlineResult={sendComposerInlineResult}
          onSendBotStart={sendComposerBotStart}
          onGetReportOptions={getChatReportOptions}
          onReportChat={reportChat}
          onBack={() => setMobileChatOpen(false)}
            />
          </Profiler>
        )}
      </main>
      <AudioPlaybackHost />
      <MotionPresence present={Boolean(error)}>
        {error ? <div className="runtime-error" role="alert">
          <CircleAlert size={17} />
          <span>{error}</span>
          <button type="button" aria-label="关闭错误提示" title="关闭" onClick={clearError}><X size={16} /></button>
        </div> : null}
      </MotionPresence>
      <MotionPresence present={Boolean(operationError)}>
        {operationError ? <div className="operation-error" role="alert">
          <CircleAlert size={17} />
          <span>{operationError}</span>
          <button type="button" aria-label="关闭操作提示" title="关闭" onClick={clearOperationError}><X size={16} /></button>
        </div> : null}
      </MotionPresence>
      <MotionPresence present={settingsOpen}>
        {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      </MotionPresence>
      <MotionPresence present={downloadManagerOpen}>
        {downloadManagerOpen ? <DownloadManagerDialog
          items={managedDownloads}
          onDownload={requestDownload}
          onCancel={cancelManagedDownload}
          onRemove={removeDownloadRecords}
          onOpenDirectory={openDownloadDirectory}
          onClose={() => setDownloadManagerOpen(false)}
        /> : null}
      </MotionPresence>
      <MotionPresence present={folderManagerOpen}>
        {folderManagerOpen ? <FolderManagerDialog
          folders={folders}
          chats={[...chats.values()]}
          initialFolderId={folderManagerInitialId}
          pending={folderManagementPending}
          onCreate={createChatFolder}
          onRename={renameChatFolder}
          onDelete={deleteChatFolder}
          onSetMembership={setChatFolderMembership}
          onClose={closeFolderManager}
        /> : null}
      </MotionPresence>
      <MotionPresence present={newChatOpen}>
        {newChatOpen ? <NewChatDialog
          contacts={contacts}
          currentUserId={currentUserId}
          contactsLoading={contactsLoading}
          contactsError={contactsError}
          pending={chatCreationPending}
          onLoadContacts={loadContacts}
          onCreate={async (input) => {
            const chatId = await createChat(input);
            if (chatId) setMobileChatOpen(true);
            return chatId;
          }}
          onClose={() => { if (!chatCreationPending) setNewChatOpen(false); }}
        /> : null}
      </MotionPresence>
      <MotionPresence present={Boolean(pendingConfirmation)}>
        {pendingConfirmation ? <ConfirmActionDialog
          title={pendingConfirmation.kind === "leaveGroup"
            ? `退出“${pendingConfirmation.title}”？`
            : `删除“${pendingConfirmation.title}”？`}
          description={pendingConfirmation.kind === "leaveGroup"
            ? "退出后，您将无法继续在这个群组中收发消息。"
            : "只会删除文件夹，不会删除其中的聊天。"}
          confirmLabel={pendingConfirmation.kind === "leaveGroup" ? "退出群组" : "删除"}
          onConfirm={() => pendingConfirmation.kind === "leaveGroup"
            ? leaveGroup(pendingConfirmation.chatId)
            : deleteChatFolder(pendingConfirmation.folderId)}
          onClose={() => setPendingConfirmation(undefined)}
        /> : null}
      </MotionPresence>
      <MotionPresence present={Boolean(profile.target)}>
        {profile.target ? <ProfileDrawer
          state={profile}
          forwardTargets={forwardTargets}
          currentUserId={currentUserId}
          onClose={clearProfile}
          onRetry={() => {
            if (profile.target?.kind === "current") void loadCurrentUserProfile();
            else if (profile.target?.kind === "chat") void loadChatProfile(profile.target.chatId);
            else if (profile.target?.kind === "user") void loadUserProfile(profile.target.userId);
          }}
          onOpenMessage={openProfileMessage}
          onStartPrivateChat={openProfilePrivateChat}
          onManageChat={openChatManagement}
          canManageChat={profile.value?.chatId ? chats.get(profile.value.chatId)?.management?.canOpenManagement === true : false}
          isBlocked={profile.value?.userId ? blockedSenders.some((sender) => sender.kind === "user" && sender.id === profile.value?.userId) : profile.value?.chatId ? blockedSenders.some((sender) => sender.kind === "chat" && sender.id === profile.value?.chatId) : false}
          onToggleBlock={toggleProfileBlock}
          onGetReportOptions={getChatReportOptions}
          onReportChat={reportChat}
          reportChatId={activeChatId}
          onDeleteChat={profile.target?.kind === "chat" && activeChatId === profile.target.chatId && profile.value?.kind === "group" ? () => leaveGroup(activeChatId) : undefined}
          onOpenUserProfile={(userId) => { void loadUserProfile(userId); }}
          onLoadMoreMembers={(chatId) => loadMoreChatProfileMembers(chatId)}
          onLoadSharedMedia={loadSharedMedia}
          onDownloadFile={requestDownload}
          onLoadMessageProperties={loadMessageProperties}
          onDeleteMessages={deleteMessagesFromChat}
          onForwardMessages={forwardMessages}
        /> : null}
      </MotionPresence>
      <MotionPresence present={Boolean(managementChat?.management?.canOpenManagement && managementChatId)}>
        {managementChat?.management?.canOpenManagement && managementChatId ? <ChatManagementDialog
          chat={managementChat}
          currentUserId={currentUserId}
          contacts={contacts}
          management={groupManagement?.chatId === managementChatId ? groupManagement : undefined}
          loading={groupManagementLoading}
          error={groupManagementError}
          onLoad={loadManagement}
          onClose={() => setManagementChatId(undefined)}
          onAddMembers={addManagementMembers}
          onSetMemberStatus={setManagementMemberStatus}
          onSetMemberTag={setManagementMemberTag}
          onSetPermissions={setManagementPermissions}
          onSetSlowMode={setManagementSlowMode}
          onTransferOwnership={transferManagementOwnership}
          onLoadEvents={loadManagementEvents}
          onGetInviteLinks={getManagementInviteLinks}
          onSaveInviteLink={saveManagementInviteLink}
          onRevokeInviteLink={revokeManagementInviteLink}
          onGetJoinRequests={getManagementJoinRequests}
          onProcessJoinRequest={processManagementJoinRequest}
          onProcessJoinRequests={processManagementJoinRequests}
        /> : null}
      </MotionPresence>
    </>
  );
}
