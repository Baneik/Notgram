import { describe, expect, it, vi } from "vitest";
import {
  createConversationNavigation,
  type ConversationNavigationLocation,
} from "./useConversationNavigation";

const location = (
  chatId: string,
  overrides: Partial<ConversationNavigationLocation> = {},
): ConversationNavigationLocation => ({
  chatId,
  chatFilter: "main",
  searchQuery: "",
  searchScope: { type: "global" },
  globalSearchFilter: "all",
  globalSearchPending: false,
  searchScrollTop: 0,
  mobileChatOpen: true,
  ...overrides,
});

describe("conversation navigation", () => {
  it("moves backward and forward through recorded locations", () => {
    const navigation = createConversationNavigation();
    const listener = vi.fn();
    navigation.subscribe(listener);

    navigation.initialize(location("chat-a"));
    expect(navigation.getState()).toEqual({ canGoBack: false, canGoForward: false });

    navigation.push(location("chat-b"));
    expect(navigation.getState()).toEqual({ canGoBack: true, canGoForward: false });
    expect(navigation.goBack()).toEqual(location("chat-a"));
    expect(navigation.getState()).toEqual({ canGoBack: false, canGoForward: true });
    expect(navigation.goForward()).toEqual(location("chat-b"));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("replaces the current source and drops forward history after a new jump", () => {
    const navigation = createConversationNavigation();
    const searchLocation = location("chat-a", {
      searchQuery: "release",
      searchScrollTop: 420,
    });

    navigation.initialize(location("chat-a"));
    navigation.push(location("chat-b"));
    expect(navigation.goBack()).toEqual(location("chat-a"));

    navigation.replace(searchLocation);
    navigation.push(location("chat-c"));
    expect(navigation.goBack()).toEqual(searchLocation);
    expect(navigation.goForward()).toEqual(location("chat-c"));
    expect(navigation.goForward()).toBeUndefined();
  });

  it("does not add an identical location twice", () => {
    const navigation = createConversationNavigation();
    navigation.initialize(location("chat-a"));
    navigation.push(location("chat-a"));

    expect(navigation.getState()).toEqual({ canGoBack: false, canGoForward: false });
    expect(navigation.goBack()).toBeUndefined();
  });
});
