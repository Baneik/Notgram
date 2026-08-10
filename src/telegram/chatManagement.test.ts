import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_ADMIN_RIGHTS,
  DEFAULT_CHAT_PERMISSIONS,
  deriveChatManagementCapabilities,
  mapChatAdminRightsFromTd,
  mapChatPermissionsFromTd,
} from "./chatManagement";
import { MockTelegramTransport } from "./mockTransport";

describe("chat management", () => {
  it("derives a closed capability set for regular members", () => {
    const capabilities = deriveChatManagementCapabilities("supergroup", "member");
    expect(capabilities).toMatchObject({
      canOpenManagement: false,
      canAddMembers: false,
      canPromoteMembers: false,
      canManageInvites: false,
      canViewEventLog: false,
    });
  });

  it("limits an administrator to the rights returned by TDLib", () => {
    const capabilities = deriveChatManagementCapabilities("supergroup", "administrator", {
      ...DEFAULT_CHAT_ADMIN_RIGHTS,
      canPromoteMembers: false,
      canRestrictMembers: false,
      canManageChat: false,
      canInviteUsers: true,
    });
    expect(capabilities).toMatchObject({
      canOpenManagement: true,
      canAddMembers: true,
      canPromoteMembers: false,
      canRestrictMembers: false,
      canManagePermissions: false,
      canManageSlowMode: false,
      canViewEventLog: false,
    });
  });

  it("maps every chat permission and administrator right field", () => {
    expect(mapChatPermissionsFromTd({ can_react_to_messages: true, can_edit_tag: true })).toMatchObject({
      canReactToMessages: true,
      canEditTag: true,
      canSendBasicMessages: false,
    });
    expect(mapChatAdminRightsFromTd({ can_manage_chat: true, can_manage_tags: true, is_anonymous: true })).toMatchObject({
      canManageChat: true,
      canManageTags: true,
      isAnonymous: true,
      canPromoteMembers: false,
    });
  });

  it("manages roles, exception permissions, slow mode, ownership, and audit events", async () => {
    const transport = new MockTelegramTransport();
    const chat = await transport.createChat({
      kind: "supergroup",
      title: "管理测试群",
      memberUserIds: ["u-mia"],
      permissionTemplate: "restricted",
    });

    let management = await transport.getChatManagement(chat.id);
    expect(management.members.map((member) => member.status)).toEqual(["owner", "member"]);
    expect(management.permissions.canSendDocuments).toBe(false);

    await transport.setChatMemberStatus({
      chatId: chat.id,
      userId: "u-mia",
      status: { kind: "administrator", rights: { ...DEFAULT_CHAT_ADMIN_RIGHTS, canPromoteMembers: true } },
    });
    await transport.setChatMemberStatus({
      chatId: chat.id,
      userId: "u-mia",
      status: { kind: "restricted", permissions: { ...DEFAULT_CHAT_PERMISSIONS, canSendBasicMessages: false } },
    });
    await transport.setChatSlowModeDelay(chat.id, 30);
    await transport.setChatPermissions(chat.id, { ...DEFAULT_CHAT_PERMISSIONS, canSendPolls: false });

    management = await transport.getChatManagement(chat.id);
    expect(management.members.find((member) => member.user.id === "u-mia")).toMatchObject({
      status: "restricted",
      permissions: { canSendBasicMessages: false },
    });
    expect(management.slowModeDelay).toBe(30);
    expect(management.permissions.canSendPolls).toBe(false);

    await transport.transferChatOwnership(chat.id, "u-mia", "demo-password");
    management = await transport.getChatManagement(chat.id);
    expect(management.members.find((member) => member.user.id === "u-mia")?.status).toBe("owner");
    const log = await transport.getChatEventLog({ chatId: chat.id });
    expect(log.events.map((event) => event.summary)).toContain("设置慢速模式：30 秒");
    expect(log.events.some((event) => event.summary.startsWith("转移所有者给"))).toBe(true);
  });

  it("adds, bans, and restores members", async () => {
    const transport = new MockTelegramTransport();
    const chat = await transport.createChat({ kind: "supergroup", title: "成员测试群", memberUserIds: [] });
    await transport.addChatMembers(chat.id, ["u-mia"]);
    await transport.setChatMemberStatus({ chatId: chat.id, userId: "u-mia", status: { kind: "banned" } });
    expect((await transport.getChatManagement(chat.id)).members.find((member) => member.user.id === "u-mia")?.status).toBe("banned");
    await transport.setChatMemberStatus({ chatId: chat.id, userId: "u-mia", status: { kind: "member" } });
    expect((await transport.getChatManagement(chat.id)).members.find((member) => member.user.id === "u-mia")?.status).toBe("member");
  });
});
