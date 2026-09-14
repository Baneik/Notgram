import { describe, expect, it, vi } from "vitest";
import { mapChatInvitePreview, mapChatJoinResult } from "./chatJoin";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";
import type { TelegramEvent } from "./types";

const rawChat = { "@type": "chat", id: -10072, title: "Join test", type: { "@type": "chatTypeSupergroup", supergroup_id: 72, is_channel: false }, positions: [], permissions: { can_send_basic_messages: true } };
const invite = { "@type": "chatInviteLinkInfo", chat_id: 0, type: { "@type": "inviteLinkChatTypeSupergroup" }, title: "Private test", description: "Approval required", member_count: 12, creates_join_request: true };

function harness(responses: (request: TdObject) => Promise<TdObject>) {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as { request: (r: TdObject) => Promise<TdObject>; listener: (event: TelegramEvent) => void; sessionGeneration: number; initialChatSyncPending: boolean };
  const request = vi.fn(responses);
  const events: TelegramEvent[] = [];
  internal.request = request;
  internal.initialChatSyncPending = false;
  internal.listener = event => events.push(event);
  return { transport, internal, request, events };
}

describe("chat joining with the pinned TDLib contract", () => {
  it("previews approval-only invitations without joining or reading history", async () => {
    const { transport, request } = harness(async () => invite);
    const result = await transport.resolveTelegramLink("tg://join?invite=private_A-1");
    expect(result).toMatchObject({ kind: "chatInvite", preview: { createsJoinRequest: true, title: "Private test", chatId: undefined, description: "Approval required" } });
    expect(request.mock.calls.map(([r]) => r["@type"])).toEqual(["checkChatInviteLink"]);
  });

  it("does not treat temporary preview access as membership", async () => {
    const { transport, request } = harness(async request => {
      if (request["@type"] === "checkChatInviteLink") return { ...invite, chat_id: -10072, accessible_for: 300 };
      if (request["@type"] === "getChat") return rawChat;
      return { "@type": "supergroup", id: 72, status: { "@type": "chatMemberStatusLeft" } };
    });
    expect(await transport.resolveTelegramLink("https://t.me/+temporary")).toMatchObject({ kind: "chatInvite" });
    expect(request.mock.calls.some(([r]) => r["@type"] === "getChatHistory")).toBe(false);
  });

  it("opens an existing membership directly", async () => {
    const { transport } = harness(async request => {
      if (request["@type"] === "checkChatInviteLink") return { ...invite, chat_id: -10072 };
      if (request["@type"] === "getChat") return rawChat;
      return { "@type": "supergroup", id: 72, status: { "@type": "chatMemberStatusMember" } };
    });
    expect(await transport.resolveTelegramLink("https://t.me/+member")).toEqual({ chatId: "-10072" });
  });

  it("refreshes membership and permissions before opening a public chat", async () => {
    const { transport, events } = harness(async request => {
      if (request["@type"] === "getInternalLinkType") return { "@type": "internalLinkTypePublicChat", chat_username: "public_group" };
      if (request["@type"] === "getSupergroup") return { id: 72, join_by_request: true, status: { "@type": "chatMemberStatusLeft" } };
      return rawChat;
    });
    expect(await transport.resolveTelegramLink("https://t.me/public_group")).toEqual({ chatId: "-10072" });
    expect(events.at(-1)).toMatchObject({ type: "chat.upsert", chat: { isMember: false, joinByRequest: true, canSendMessages: false } });
  });

  it("keeps a successful application distinct from a joined chat", async () => {
    const { transport, request, events } = harness(async () => ({ "@type": "chatJoinResultRequestSent" }));
    expect(await transport.joinChat({ chatId: "-10072" })).toEqual({ kind: "requested" });
    expect(request).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
  });

  it("joins invitations only after checking for subscriptions and refreshes server status", async () => {
    const { transport, request, events } = harness(async request => {
      if (request["@type"] === "checkChatInviteLink") return { ...invite, creates_join_request: false };
      if (request["@type"] === "joinChatByInviteLink") return { "@type": "chatJoinResultSuccess", chat_id: -10072 };
      if (request["@type"] === "getChat") return rawChat;
      return { id: 72, status: { "@type": "chatMemberStatusMember" } };
    });
    expect(await transport.joinChat({ inviteLink: "https://telegram.me/joinchat/plain" })).toEqual({ kind: "joined", chatId: "-10072" });
    expect(request.mock.calls.map(([r]) => r["@type"])).toEqual(["checkChatInviteLink", "joinChatByInviteLink", "getChat", "getSupergroup"]);
    expect(events.at(-1)).toMatchObject({ type: "chat.upsert", chat: { isMember: true, canSendMessages: true } });
  });

  it("does not retry a committed join when the follow-up metadata read fails", async () => {
    const { transport, request } = harness(async request => {
      if (request["@type"] === "joinChat") return { "@type": "chatJoinResultSuccess", chat_id: -10072 };
      throw new Error("NETWORK_ERROR");
    });
    expect(await transport.joinChat({ chatId: "-10072" })).toEqual({ kind: "joined", chatId: "-10072" });
    expect(request.mock.calls.filter(([r]) => r["@type"] === "joinChat")).toHaveLength(1);
  });

  it("blocks paid invites before any join request", async () => {
    const { transport, request } = harness(async () => ({ ...invite, subscription_info: { pricing: { star_count: 100 } } }));
    await expect(transport.joinChat({ inviteLink: "https://t.me/+paid" })).rejects.toThrow("付费订阅");
    expect(request).toHaveBeenCalledOnce();
  });

  it("ignores invite preview completion after an account change", async () => {
    let finish!: (response: TdObject) => void;
    const { transport, internal, events } = harness(() => new Promise(resolve => { finish = resolve; }));
    const resolve = transport.resolveTelegramLink("https://t.me/+private");
    internal.sessionGeneration += 1;
    finish({ ...invite, chat_id: -10072 });
    expect(await resolve).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("never sends a join after switching accounts during invitation validation", async () => {
    let finish!: (response: TdObject) => void;
    const { transport, internal, request } = harness(() => new Promise(resolve => { finish = resolve; }));
    const join = transport.joinChat({ inviteLink: "https://t.me/+private" });
    internal.sessionGeneration += 1;
    finish(invite);
    await expect(join).rejects.toThrow("账号已切换");
    expect(request).toHaveBeenCalledOnce();
  });

  it("maps channels and treats guard checks and declined results explicitly", () => {
    expect(mapChatInvitePreview({ ...invite, type: { "@type": "inviteLinkChatTypeChannel" } }, "https://t.me/+a").kind).toBe("channel");
    expect(() => mapChatJoinResult({ "@type": "chatJoinResultGuardBotApprovalRequired" })).toThrow("机器人网页验证");
    expect(() => mapChatJoinResult({ "@type": "chatJoinResultDeclined" })).toThrow("拒绝");
    expect(() => mapChatJoinResult({ "@type": "ok" })).toThrow("未确认");
  });
});
