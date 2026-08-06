import { describe, expect, it } from "vitest";
import { MockTelegramTransport } from "./mockTransport";

describe("chat invite management", () => {
  it("creates, edits, revokes links and processes join requests in bulk", async () => {
    const transport = new MockTelegramTransport();
    const chat = await transport.createChat({ kind: "supergroup", title: "邀请测试群", memberUserIds: [] });
    const created = await transport.createChatInviteLink({ chatId: chat.id, name: "审核入口", createsJoinRequest: true, memberLimit: 20 });
    expect(created.createsJoinRequest).toBe(true);
    expect(created.memberLimit).toBe(20);
    const edited = await transport.editChatInviteLink({ chatId: chat.id, inviteLink: created.inviteLink, name: "审核入口（更新）", createsJoinRequest: true, memberLimit: 40 });
    expect(edited.name).toContain("更新");
    const links = await transport.getChatInviteLinks({ chatId: chat.id });
    expect(links.links.some((link) => link.inviteLink === created.inviteLink)).toBe(true);
    const requests = await transport.getChatJoinRequests({ chatId: chat.id });
    expect(requests.requests.length).toBe(2);
    await transport.processChatJoinRequests(chat.id, undefined, true);
    expect((await transport.getChatJoinRequests({ chatId: chat.id })).requests).toHaveLength(0);
    const revoked = await transport.revokeChatInviteLink(chat.id, created.inviteLink);
    expect(revoked.isRevoked).toBe(true);
  });
});
