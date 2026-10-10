import { afterEach, describe, expect, it, vi } from "vitest";
import { forumTopicOrderStore, reconcileForumTopicOrder, removeAccountForumTopicOrder } from "./forumTopicOrder";

afterEach(() => vi.unstubAllGlobals());

describe("local forum topic order", () => {
  it("removes logged-out account records from memory and durable metadata without affecting others", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    forumTopicOrderStore.setState({ records: [] });
    forumTopicOrderStore.getState().setOrder("a", "forum", ["12", "1"]);
    forumTopicOrderStore.getState().setOrder("b", "forum", ["1", "12"]);
    removeAccountForumTopicOrder("a");
    forumTopicOrderStore.getState().setOrder("b", "other", ["18"]);
    const expected = [
      { accountId: "b", chatId: "forum", topicIds: ["1", "12"] },
      { accountId: "b", chatId: "other", topicIds: ["18"] },
    ];
    expect(forumTopicOrderStore.getState().records).toEqual(expected);
    expect(JSON.parse(localStorage.getItem("notgram:forum-topic-order:v1")!)).toEqual(expected);
  });
  it("keeps existing positions when activity changes and appends newly discovered topics", () => {
    expect(reconcileForumTopicOrder(["1", "12", "18"], [{ id: "18" }, { id: "1" }, { id: "12" }, { id: "30" }]))
      .toEqual(["1", "12", "18", "30"]);
  });
  it("adds All before an older order and keeps its dragged position across partial pages", () => {
    const topics = [{ id: "1" }, { id: "12" }];
    expect(reconcileForumTopicOrder(["12", "1"], topics, true)).toEqual(["__all__", "12", "1"]);
    expect(reconcileForumTopicOrder(["12", "__all__", "1"], [{ id: "1" }, { id: "18" }], true))
      .toEqual(["12", "__all__", "1", "18"]);
  });
  it("keeps partial pages from destroying remembered positions and isolates account and chat orders", () => {
    expect(reconcileForumTopicOrder(["18", "12", "1"], [{ id: "1" }])).toEqual(["18", "12", "1"]);
    const store = forumTopicOrderStore;
    store.setState({ records: [] });
    store.getState().setOrder("a", "forum", ["12", "1", "12"]);
    store.getState().setOrder("b", "forum", ["1", "12"]);
    store.getState().setOrder("a", "other", ["18"]);
    expect(store.getState().records).toEqual([
      { accountId: "a", chatId: "forum", topicIds: ["12", "1"] },
      { accountId: "b", chatId: "forum", topicIds: ["1", "12"] },
      { accountId: "a", chatId: "other", topicIds: ["18"] },
    ]);
  });
});
