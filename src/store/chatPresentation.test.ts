import { afterEach, expect, it, vi } from "vitest";
import { chatPresentationStore, removeAccountChatPresentation } from "./chatPresentation";

afterEach(() => { chatPresentationStore.setState({ records: [] }); vi.unstubAllGlobals(); });

it("isolates avatar visibility by account and group, persists it, and removes logged-out records", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  chatPresentationStore.setState({ records: [] });
  const setHidden = chatPresentationStore.getState().setMessageAvatarsHidden;
  setHidden("a", "forum", true);
  setHidden("b", "forum", true);
  setHidden("a", "other", true);
  setHidden("a", "forum", false);
  expect(chatPresentationStore.getState().records).toEqual([
    { accountId: "b", chatId: "forum", hideMessageAvatars: true },
    { accountId: "a", chatId: "other", hideMessageAvatars: true },
  ]);
  removeAccountChatPresentation("a");
  expect(JSON.parse(values.get("notgram:chat-presentation:v1")!)).toEqual([
    { accountId: "b", chatId: "forum", hideMessageAvatars: true },
  ]);
});
