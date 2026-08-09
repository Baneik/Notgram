import type {
  ChatMessageSearchInput,
  ChatMessageSearchPage,
  Message,
} from "../telegram/types";

export interface ChatMessageSearchState {
  input?: ChatMessageSearchInput;
  messages: Message[];
  totalCount?: number;
  nextFromMessageId?: string;
  loading: boolean;
  loadingMore: boolean;
  error?: string;
}

export const emptyChatMessageSearch = (
  input?: ChatMessageSearchInput,
): ChatMessageSearchState => ({
  input,
  messages: [],
  loading: false,
  loadingMore: false,
});

export const chatMessageSearchInputKey = (input?: ChatMessageSearchInput) => input
  ? JSON.stringify({
      chatId: input.chatId,
      topicId: input.topicId ?? "",
      query: input.query?.trim() ?? "",
      senderId: input.senderId ?? "",
      filter: input.filter ?? "all",
      minDate: input.minDate ?? 0,
      maxDate: input.maxDate ?? 0,
    })
  : "";

export const mergeChatMessageSearchPage = (
  current: ChatMessageSearchState,
  page: ChatMessageSearchPage,
): ChatMessageSearchState => {
  const messages = [...current.messages];
  const indexes = new Map(messages.map((message, index) => [message.id, index]));
  for (const message of page.messages) {
    const index = indexes.get(message.id);
    if (index === undefined) {
      indexes.set(message.id, messages.length);
      messages.push(message);
    } else {
      messages[index] = message;
    }
  }
  return {
    ...current,
    messages,
    totalCount: page.totalCount ?? current.totalCount,
    nextFromMessageId: page.nextFromMessageId,
    loading: false,
    loadingMore: false,
    error: undefined,
  };
};
