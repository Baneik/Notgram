import { describe, expect, it, vi } from "vitest";
import type { TelegramEventListener } from "./transport";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";
import { clearPerformanceRecords, getPerformanceRecords } from "../utils/performanceMonitor";
import { DEFAULT_CHAT_ADMIN_RIGHTS, DEFAULT_CHAT_PERMISSIONS } from "./chatManagement";

type TestableTransport = {
  listener?: TelegramEventListener;
  request: (request: TdObject) => Promise<TdObject>;
  bootstrap: () => Promise<void>;
  cacheFile: (fileId: number, priority?: number) => Promise<void>;
  recoverFile: (fileId: number, priority?: number) => Promise<void>;
  requestPreparedFile: (chatId: string) => Promise<boolean>;
  requestPreparedPastedFiles: (
    chatId: string,
    files: unknown[],
    caption?: string,
  ) => Promise<boolean>;
  requestPreparedProfilePhoto: () => Promise<boolean>;
  emitMessage: (message: TdObject) => void;
  handleUpdate: (update: TdObject) => void;
  handleUpdateBatch: (updates: TdObject[]) => void;
  upsertChat: (chat: TdObject) => void;
  upsertSupergroup: (supergroup: TdObject) => void;
  upsertUser: (user: TdObject) => void;
  finishInitialChatSync: () => void;
};

const rawMessage = (id: number): TdObject => ({
  "@type": "message",
  id,
  chat_id: 7,
  sender_id: { "@type": "messageSenderUser", user_id: 11 },
  date: 1_700_000_000 + id,
  content: {
    "@type": "messageText",
    text: { "@type": "formattedText", text: `message ${id}`, entities: [] },
  },
});

const rawChat = (id: number, date: number): TdObject => ({
  "@type": "chat",
  id,
  title: `chat ${id}`,
  type: { "@type": "chatTypePrivate", user_id: id },
  positions: [{
    list: { "@type": "chatListMain" },
    order: String(date),
    is_pinned: false,
  }],
  last_message: { ...rawMessage(id), chat_id: id, date },
  unread_count: 0,
  unread_mention_count: 0,
  notification_settings: { mute_for: 0 },
});

const rawFolderInfo = (id: number, title: string): TdObject => ({
  "@type": "chatFolderInfo",
  id,
  name: {
    "@type": "chatFolderName",
    text: { "@type": "formattedText", text: title, entities: [] },
    animate_custom_emoji: false,
  },
  icon: { "@type": "chatFolderIcon", name: "Custom" },
  color_id: -1,
  is_shareable: false,
});

const rawFolder = (title: string): TdObject => ({
  "@type": "chatFolder",
  name: rawFolderInfo(12, title).name,
  icon: { "@type": "chatFolderIcon", name: "Work" },
  color_id: 2,
  is_shareable: false,
  pinned_chat_ids: [7],
  included_chat_ids: [8],
  excluded_chat_ids: [9],
  exclude_muted: true,
  exclude_read: false,
  exclude_archived: true,
  include_contacts: true,
  include_non_contacts: false,
  include_bots: false,
  include_groups: true,
  include_channels: false,
});

describe("TauriTelegramTransport startup", () => {
  it("resolves bot commands, inline results, and native send actions", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as { request: (request: TdObject) => Promise<TdObject>; rawChats: Map<string, TdObject> };
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "searchPublicChats") return { "@type": "chats", chat_ids: [72] };
      if (request["@type"] === "getChat") return { "@type": "chat", id: 72, type: { "@type": "chatTypePrivate", user_id: 901 } };
      if (request["@type"] === "getUserFullInfo") return { "@type": "userFullInfo", bot_info: { "@type": "botInfo", commands: [{ "@type": "botCommand", command: " /START@notgram_bot ", description: " 启动 " }] } };
      if (request["@type"] === "getUser") return { "@type": "user", id: 901, first_name: "Notgram", last_name: "Bot", usernames: { active_usernames: ["notgram_bot"] }, status: { "@type": "userStatusOnline" }, type: { "@type": "userTypeBot" } };
      if (request["@type"] === "getInlineQueryResults") return { "@type": "inlineQueryResults", inline_query_id: 1234, results: [{ "@type": "inlineQueryResultArticle", id: "r1", title: "结果", description: "预览", input_message_content: { "@type": "inputMessageText", text: { "@type": "formattedText", text: "结果正文", entities: [] }, link_preview_options: null, clear_draft: false } }], next_offset: "2" };
      if (request["@type"] === "getCallbackQueryAnswer") return { "@type": "callbackQueryAnswer", text: "已翻页", show_alert: false, url: "" };
      return { "@type": "ok" };
    };
    const commands = await transport.getBotCommandSuggestions("72", "", "notgram_bot");
    const page = await transport.getInlineQueryResults("72", "notgram_bot", "hello");
    const callback = await transport.getCallbackQueryAnswer("72", "100", "cGFnZT0y");
    await transport.sendInlineQueryResultMessage("72", commands[0].botUserId, page.queryId, page.results[0].id, undefined, "12");
    await transport.sendBotStartMessage("72", commands[0].botUserId, "demo");
    expect(commands[0]).toMatchObject({ botUserId: "901", command: "start" });
    expect(page).toMatchObject({ queryId: "1234", hasMore: true, results: [{ messageText: "结果正文" }] });
    expect(callback).toEqual({ text: "已翻页", showAlert: false, url: undefined });
    expect(requests.find((request) => request["@type"] === "sendInlineQueryResultMessage")?.topic_id).toEqual({
      "@type": "messageTopicForum",
      forum_topic_id: 12,
    });
    expect(requests.map((request) => request["@type"])).toEqual(["searchPublicChats", "getChat", "getUser", "getUserFullInfo", "searchPublicChats", "getChat", "getInlineQueryResults", "getCallbackQueryAnswer", "sendInlineQueryResultMessage", "sendBotStartMessage"]);
  });

  it("discovers group bots when scoped command metadata is empty", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as {
      request: (request: TdObject) => Promise<TdObject>;
      rawChats: Map<string, TdObject>;
    };
    const requests: TdObject[] = [];
    internal.rawChats.set("72", {
      "@type": "chat",
      id: 72,
      type: { "@type": "chatTypeSupergroup", supergroup_id: 91, is_channel: false },
    });
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getSupergroupFullInfo") {
        return { "@type": "supergroupFullInfo", bot_commands: [] };
      }
      if (request["@type"] === "searchChatMembers") {
        return {
          "@type": "chatMembers",
          members: [
            { member_id: { "@type": "messageSenderUser", user_id: 901 } },
            { member_id: { "@type": "messageSenderUser", user_id: 902 } },
          ],
        };
      }
      if (request["@type"] === "getUserFullInfo") {
        const command = request.user_id === 901 ? "help" : "settings";
        return {
          "@type": "userFullInfo",
          bot_info: {
            "@type": "botInfo",
            commands: [{ "@type": "botCommand", command, description: `${command} description` }],
          },
        };
      }
      if (request["@type"] === "getUser") {
        return {
          "@type": "user",
          id: request.user_id,
          first_name: `Bot ${request.user_id}`,
          usernames: { active_usernames: [`bot_${request.user_id}`] },
          status: { "@type": "userStatusOffline" },
          type: { "@type": "userTypeBot" },
        };
      }
      return { "@type": "ok" };
    };

    await expect(transport.getBotCommandSuggestions("72", "he")).resolves.toEqual([
      {
        botUserId: "901",
        botUsername: "bot_901",
        command: "help",
        description: "help description",
      },
    ]);
    expect(requests).toContainEqual({
      "@type": "searchChatMembers",
      chat_id: 72,
      query: "",
      limit: 200,
      filter: { "@type": "chatMembersFilterBots" },
    });
  });

  it("fills commands for bots omitted from otherwise partial group metadata", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport & { rawChats: Map<string, TdObject> };
    const requests: TdObject[] = [];
    internal.rawChats.set("72", {
      "@type": "chat",
      id: 72,
      type: { "@type": "chatTypeSupergroup", supergroup_id: 91, is_channel: false },
    });
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getSupergroupFullInfo") {
        return {
          "@type": "supergroupFullInfo",
          bot_commands: [
            {
              bot_user_id: 901,
              commands: [{ "@type": "botCommand", command: "help", description: "Help" }],
            },
            { bot_user_id: 902, commands: [] },
          ],
        };
      }
      if (request["@type"] === "searchChatMembers") {
        return {
          "@type": "chatMembers",
          members: [901, 902].map((userId) => ({
            member_id: { "@type": "messageSenderUser", user_id: userId },
          })),
        };
      }
      if (request["@type"] === "getUserFullInfo") {
        return {
          "@type": "userFullInfo",
          bot_info: {
            "@type": "botInfo",
            commands: [{ "@type": "botCommand", command: "settings", description: "Settings" }],
          },
        };
      }
      if (request["@type"] === "getUser") {
        return {
          "@type": "user",
          id: request.user_id,
          first_name: `Bot ${request.user_id}`,
          usernames: { active_usernames: [`bot_${request.user_id}`] },
          type: { "@type": "userTypeBot" },
        };
      }
      return { "@type": "ok" };
    };

    await expect(transport.getBotCommandSuggestions("72", "")).resolves.toMatchObject([
      { botUserId: "901", command: "help" },
      { botUserId: "902", command: "settings" },
    ]);
    expect(requests.filter((request) => request["@type"] === "getUserFullInfo"))
      .toEqual([{ "@type": "getUserFullInfo", user_id: 902 }]);
  });

  it("wraps privacy rules in the TDLib container object", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };

    await transport.setPrivacySettingRules("showStatus", [{ kind: "allowContacts" }]);

    expect(requests).toEqual([{
      "@type": "setUserPrivacySettingRules",
      setting: { "@type": "userPrivacySettingShowStatus" },
      rules: {
        "@type": "userPrivacySettingRules",
        rules: [{ "@type": "userPrivacySettingRuleAllowContacts" }],
      },
    }]);
  });

  it("uses TDLib message link info instead of treating a public post number as a message id", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getInternalLinkType") {
        return { "@type": "internalLinkTypeMessage", url: request.link };
      }
      if (request["@type"] === "getMessageLinkInfo") {
        return {
          "@type": "messageLinkInfo",
          chat_id: -10072,
          message: {
            ...rawMessage(128_974_848),
            chat_id: -10072,
            sender_id: { "@type": "messageSenderChat", chat_id: -10072 },
          },
        };
      }
      if (request["@type"] === "getChat") {
        return {
          "@type": "chat",
          id: -10072,
          title: "Release channel",
          type: { "@type": "chatTypeSupergroup", supergroup_id: 72, is_channel: true },
          positions: [],
        };
      }
      return { "@type": "ok" };
    };

    await expect(transport.resolveTelegramLink("https://t.me/release_channel/123"))
      .resolves.toEqual({ chatId: "-10072", messageId: "128974848" });
    expect(requests.map((request) => request["@type"])).toEqual([
      "getInternalLinkType",
      "getMessageLinkInfo",
      "getChat",
    ]);
  });

  it("rejects Telegram theme routes without searching for a public chat", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };

    await expect(transport.resolveTelegramLink("https://t.me/addtheme/NotgramTheme"))
      .resolves.toEqual({
        kind: "unsupported",
        linkType: "internalLinkTypeTheme",
        reason: "Telegram 主题链接与 Notgram 不兼容",
      });
    expect(requests).toEqual([]);
  });

  it("opens public usernames even when TDLib resolves them to a private chat", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getInternalLinkType") {
        return {
          "@type": "internalLinkTypePublicChat",
          chat_username: "mia_design",
          draft_text: "",
          open_profile: false,
        };
      }
      if (request["@type"] === "searchPublicChat") {
        return {
          "@type": "chat",
          id: 92,
          title: "Mia Chen",
          type: { "@type": "chatTypePrivate", user_id: 12 },
          positions: [],
        };
      }
      return { "@type": "ok" };
    };

    await expect(transport.resolveTelegramLink("https://t.me/mia_design"))
      .resolves.toEqual({ chatId: "92" });
    expect(requests.map((request) => request["@type"])).toEqual([
      "getInternalLinkType",
      "searchPublicChat",
    ]);
  });

  it("loads complete administrator labels independently of the member page", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as {
      request: (request: TdObject) => Promise<TdObject>;
      rawChats: Map<string, TdObject>;
    };
    internal.rawChats.set("72", {
      "@type": "chat",
      id: 72,
      permissions: {},
      type: { "@type": "chatTypeSupergroup", supergroup_id: 91, is_channel: false },
    });
    internal.request = async (request) => {
      if (request["@type"] === "getChatAdministrators") {
        return {
          "@type": "chatAdministrators",
          administrators: [
            { user_id: 901, custom_title: "值班", is_owner: false },
            { user_id: 902, custom_title: "", is_owner: true },
          ],
        };
      }
      if (request["@type"] === "getSupergroup") {
        return {
          "@type": "supergroup",
          id: 91,
          status: {
            "@type": "chatMemberStatusAdministrator",
            can_be_edited: true,
            rights: { can_manage_chat: true, can_invite_users: true, can_restrict_members: true },
          },
          member_count: 200,
        };
      }
      if (request["@type"] === "getSupergroupFullInfo") {
        return {
          "@type": "supergroupFullInfo",
          status: { "@type": "chatMemberStatusMember" },
          member_count: 200,
        };
      }
      if (request["@type"] === "getSupergroupMembers") {
        return { "@type": "chatMembers", members: [] };
      }
      return { "@type": "ok" };
    };

    const management = await transport.getChatManagement("72", 50);
    expect(management.administratorLabels).toEqual({ "901": "值班", "902": "群主" });
  });

  it("maps the complete member, permission, slow mode, and ownership requests", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as { request: (request: TdObject) => Promise<TdObject>; rawChats: Map<string, TdObject> };
    const requests: TdObject[] = [];
    internal.rawChats.set("72", { "@type": "chat", id: 72, type: { "@type": "chatTypeSupergroup", supergroup_id: 91, is_channel: false } });
    internal.request = async (request) => { requests.push(request); return { "@type": "ok" }; };

    await transport.addChatMembers("72", ["11", "12"]);
    await transport.setChatMemberStatus({
      chatId: "72",
      userId: "11",
      status: { kind: "administrator", rights: { ...DEFAULT_CHAT_ADMIN_RIGHTS, canPromoteMembers: true } },
    });
    await transport.setChatMemberTag("72", "11", "值班");
    await transport.setChatMemberStatus({
      chatId: "72",
      userId: "12",
      status: { kind: "restricted", permissions: { ...DEFAULT_CHAT_PERMISSIONS, canSendVideos: false } },
    });
    await transport.setChatPermissions("72", DEFAULT_CHAT_PERMISSIONS);
    await transport.setChatSlowModeDelay("72", 30);
    await transport.transferChatOwnership("72", "11", "password");

    expect(requests.map((request) => request["@type"])).toEqual([
      "addChatMembers", "setChatMemberStatus", "setChatMemberTag", "setChatMemberStatus", "setChatPermissions", "setChatSlowModeDelay", "transferChatOwnership",
    ]);
    expect(requests[1].status).toMatchObject({ "@type": "chatMemberStatusAdministrator", rights: { can_promote_members: true } });
    expect(requests[2]).toMatchObject({ chat_id: 72, user_id: 11, tag: "值班" });
    expect(requests[3].status).toMatchObject({ "@type": "chatMemberStatusRestricted", permissions: { can_send_videos: false } });
    expect(requests[5]).toMatchObject({ chat_id: 72, slow_mode_delay: 30 });
  });

  it("updates and clears member tags independently from member status", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as { request: (request: TdObject) => Promise<TdObject>; rawChats: Map<string, TdObject> };
    const requests: TdObject[] = [];
    internal.rawChats.set("72", { "@type": "chat", id: 72, type: { "@type": "chatTypeSupergroup", supergroup_id: 91, is_channel: false } });
    internal.request = async (request) => { requests.push(request); return { "@type": "ok" }; };

    await transport.setChatMemberTag("72", "11", "");
    expect(requests.at(-1)).toMatchObject({ "@type": "setChatMemberTag", chat_id: 72, user_id: 11, tag: "" });
    await expect(transport.setChatMemberTag("72", "11", "x".repeat(17))).rejects.toThrow("0 至 16");
    await expect(transport.setChatMemberTag("72", "11", "值班🙂")).rejects.toThrow("非表情字符");
    expect(requests).toHaveLength(1);
  });

  it("creates a public supergroup and applies members, history, and permissions", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as {
      request: (request: TdObject) => Promise<TdObject>;
    };
    const requests: TdObject[] = [];
    const createdChat: TdObject = {
      "@type": "chat",
      id: 72,
      title: "Notgram Team",
      type: { "@type": "chatTypeSupergroup", supergroup_id: 91, is_channel: false },
      positions: [{
        list: { "@type": "chatListMain" },
        order: "1700000000",
        is_pinned: false,
      }],
      last_message: null,
      unread_count: 0,
      notification_settings: { mute_for: 0 },
    };
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "createNewSupergroupChat" || request["@type"] === "getChat") {
        return createdChat;
      }
      if (request["@type"] === "getSupergroup") {
        return {
          "@type": "supergroup",
          id: 91,
          is_channel: false,
          status: { "@type": "chatMemberStatusCreator" },
          member_count: 3,
        };
      }
      return { "@type": "ok" };
    };

    const chat = await transport.createChat({
      kind: "supergroup",
      title: "Notgram Team",
      description: "Desktop collaboration",
      memberUserIds: ["11", "12"],
      isPublic: true,
      username: "notgram_team",
      historyAvailable: false,
      permissionTemplate: "restricted",
    });

    expect(chat).toMatchObject({ id: "72", kind: "group", title: "Notgram Team" });
    expect(chat.management).toMatchObject({ status: "owner", canOpenManagement: true, canTransferOwnership: true });
    expect(requests.map((request) => request["@type"])).toEqual([
      "createNewSupergroupChat",
      "addChatMembers",
      "setSupergroupUsername",
      "toggleSupergroupIsAllHistoryAvailable",
      "setChatPermissions",
      "getChat",
      "getSupergroup",
    ]);
    expect(requests[0]).toMatchObject({
      is_forum: false,
      is_channel: false,
      description: "Desktop collaboration",
      location: null,
      for_import: false,
    });
    expect(requests[3]).toMatchObject({ is_all_history_available: false });
    expect(requests[4].permissions).toMatchObject({
      can_send_basic_messages: true,
      can_send_documents: false,
      can_invite_users: false,
    });
  });

  it("hydrates owner capabilities immediately after creating a basic group", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as { request: (request: TdObject) => Promise<TdObject> };
    const requests: TdObject[] = [];
    const createdChat: TdObject = {
      "@type": "chat",
      id: 73,
      title: "Basic QA",
      type: { "@type": "chatTypeBasicGroup", basic_group_id: 53 },
      positions: [],
      last_message: null,
      unread_count: 0,
      notification_settings: { mute_for: 0 },
    };
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "createNewBasicGroupChat") return { "@type": "createdBasicGroupChat", chat_id: 73 };
      if (request["@type"] === "getChat") return createdChat;
      if (request["@type"] === "getBasicGroup") return {
        "@type": "basicGroup",
        id: 53,
        member_count: 2,
        status: { "@type": "chatMemberStatusCreator" },
      };
      return { "@type": "ok" };
    };

    const chat = await transport.createChat({ kind: "basicGroup", title: "Basic QA", memberUserIds: [], permissionTemplate: "open" });
    expect(chat).toMatchObject({ id: "73", title: "Basic QA", management: { status: "owner", canOpenManagement: true } });
    expect(requests.map((request) => request["@type"])).toEqual([
      "createNewBasicGroupChat", "getChat", "setChatPermissions", "getChat", "getBasicGroup",
    ]);
  });

  it("updates current profile fields and refreshes the mapped account", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getMe") {
        return {
          "@type": "user",
          id: 11,
          first_name: "Lin",
          last_name: "Ran",
          phone_number: "+8610000000000",
          usernames: {
            "@type": "usernames",
            active_usernames: ["linran"],
            disabled_usernames: [],
            editable_username: "linran",
          },
          status: { "@type": "userStatusOnline" },
        };
      }
      if (request["@type"] === "getUserFullInfo") {
        return { "@type": "userFullInfo", bio: { text: "Desktop client", entities: [] } };
      }
      if (request["@type"] === "getOption") {
        return { "@type": "optionValueInteger", value: 5 };
      }
      return { "@type": "ok" };
    };

    const profile = await transport.updateCurrentUserProfile({
      firstName: "Lin",
      lastName: "Ran",
      username: "linran",
      bio: "Desktop client",
    });

    expect(requests.slice(0, 3).map((request) => request["@type"]))
      .toEqual(["setName", "setBio", "setUsername"]);
    expect(profile).toMatchObject({
      title: "Lin Ran",
      username: "linran",
      phoneNumber: "+8610000000000",
      dataCenterId: 5,
      dataCenterLocation: "Singapore, SG",
    });
  });

  it("refreshes the current profile after a native avatar selection", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    internal.requestPreparedProfilePhoto = async () => true;
    internal.request = async (request) => {
      if (request["@type"] === "getMe" || request["@type"] === "getUser") {
        return {
          "@type": "user",
          id: 11,
          first_name: "Lin",
          last_name: "Ran",
          status: { "@type": "userStatusOnline" },
        };
      }
      if (request["@type"] === "getUserFullInfo") {
        return { "@type": "userFullInfo", bio: { text: "", entities: [] } };
      }
      if (request["@type"] === "getOption") throw new Error("unknown option");
      return { "@type": "ok" };
    };

    await expect(transport.setCurrentUserAvatar()).resolves.toMatchObject({
      userId: "11",
      dataCenterLocation: "Telegram 自动选择",
    });
  });

  it("attributes slow TDLib batches by update category", () => {
    clearPerformanceRecords();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    internal.handleUpdateBatch([
      { "@type": "updateFile" },
      { "@type": "updateChatTitle" },
      { "@type": "updateMessageContent" },
      ...Array.from({ length: 29 }, () => ({ "@type": "updateUnknown" })),
    ]);

    expect(getPerformanceRecords()).toContainEqual(expect.objectContaining({
      event: "ui_tdlib_update_batch",
      details: expect.objectContaining({
        batchCount: 32,
        fileUpdateCount: 1,
        chatUpdateCount: 1,
        messageUpdateCount: 1,
        otherUpdateCount: 29,
      }),
    }));
  });

  it("uses updateSupergroup metadata to classify forum chats", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.handleUpdate({
      "@type": "updateSupergroup",
      supergroup: {
        "@type": "supergroup",
        id: 91,
        is_forum: true,
      },
    });
    internal.upsertChat({
      "@type": "chat",
      id: 72,
      title: "Forum",
      type: { "@type": "chatTypeSupergroup", supergroup_id: 91, is_channel: false },
      permissions: { can_create_topics: true },
    });
    internal.finishInitialChatSync();

    expect(events.find((event) => event.type === "chats.upserted")).toMatchObject({
      type: "chats.upserted",
      chats: [{ id: "72", isForum: true, canCreateTopics: true }],
    });
  });

  it("publishes live management capability changes from group status updates", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.handleUpdate({
      "@type": "updateSupergroup",
      supergroup: {
        "@type": "supergroup",
        id: 91,
        status: { "@type": "chatMemberStatusCreator", is_anonymous: false, is_member: true },
      },
    });
    internal.upsertChat({
      "@type": "chat",
      id: 72,
      title: "Managed group",
      type: { "@type": "chatTypeSupergroup", supergroup_id: 91, is_channel: false },
    });
    internal.finishInitialChatSync();
    expect(events.find((event) => event.type === "chats.upserted")).toMatchObject({
      chats: [{ management: { status: "owner", canOpenManagement: true } }],
    });

    internal.handleUpdate({
      "@type": "updateSupergroup",
      supergroup: {
        "@type": "supergroup",
        id: 91,
        status: { "@type": "chatMemberStatusMember" },
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "chat.upsert",
      chat: { id: "72", management: { status: "member", canOpenManagement: false } },
    });
  });

  it("loads history context on both sides of an exact message", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "messages",
        messages: [rawMessage(43), rawMessage(42), rawMessage(41)],
      };
    };

    const context = await transport.getMessageContext("7", "42", 31);

    expect(context.map((message) => message.id)).toEqual(["43", "42", "41"]);
    expect(requests).toEqual([{
      "@type": "getChatHistory",
      chat_id: 7,
      from_message_id: 42,
      offset: -15,
      limit: 31,
      only_local: false,
    }]);
  });

  it("uses TDLib opaque offsets and merges message and chat search results", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "searchMessages") {
        return {
          "@type": "foundMessages",
          total_count: 5,
          messages: [{ ...rawMessage(90), chat_id: 7 }],
          next_offset: "opaque-next",
        };
      }
      if (request["@type"] === "searchChatsOnServer") {
        return { "@type": "chats", chat_ids: [8, 7] };
      }
      if (request["@type"] === "searchPublicChats") {
        return { "@type": "chats", chat_ids: [8] };
      }
      if (request["@type"] === "getChat") {
        return rawChat(Number(request.chat_id), 1_700_000_000);
      }
      return { "@type": "ok" };
    };

    const page = await transport.searchGlobal({ query: "layout", filter: "all" });

    expect(page).toMatchObject({ totalCount: 5, nextOffset: "opaque-next" });
    expect(page.messages.map((message) => message.id)).toEqual(["90"]);
    expect(page.chats.map((chat) => chat.id).sort()).toEqual(["7", "8"]);
    expect(requests.find((request) => request["@type"] === "searchMessages")).toMatchObject({
      chat_list: null,
      offset: "",
      limit: 30,
      filter: null,
      chat_type_filter: null,
    });

    requests.length = 0;
    await transport.searchGlobal({
      query: "layout",
      filter: "file",
      offset: "opaque-next",
    });
    expect(requests.some((request) => request["@type"] === "searchChatsOnServer")).toBe(false);
    expect(requests.find((request) => request["@type"] === "searchMessages")).toMatchObject({
      offset: "opaque-next",
      filter: { "@type": "searchMessagesFilterDocument" },
    });
  });

  it("keeps server-backed message search plain and paginated", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "searchMessages") {
        return {
          "@type": "foundMessages",
          total_count: 200,
          messages: [rawMessage(90), rawMessage(81)],
          next_offset: "server-next",
        };
      }
      if (request["@type"] === "searchChatMessages") {
        return {
          "@type": "foundChatMessages",
          total_count: 2,
          messages: [rawMessage(90), rawMessage(81)],
          next_from_message_id: 0,
        };
      }
      if (request["@type"] === "getChat") return rawChat(7, 1_700_000_000);
      return { "@type": "ok" };
    };

    const page = await transport.searchGlobal({
      query: "message 9",
      filter: "message",
    });
    const pageForChat = await transport.searchChatMessages({ chatId: "7", query: "message 9", limit: 30 });

    expect(page.messages.map(({ id }) => id)).toEqual(["90", "81"]);
    expect(page).toMatchObject({ nextOffset: "server-next" });
    expect(page.totalCount).toBeUndefined();
    expect(pageForChat.messages.map(({ id }) => id)).toEqual(["90", "81"]);
    expect(pageForChat.totalCount).toBe(2);
    expect(events).toEqual([]);
    expect(requests.filter((request) => request["@type"] === "searchChatsOnServer"))
      .toMatchObject([{ query: "message 9" }]);
    expect(requests.filter((request) =>
      request["@type"] === "searchMessages" || request["@type"] === "searchChatMessages"
    ).map((request) => request.query)).toEqual(["message 9", "message 9"]);
  });

  it("cancels a TDLib file download without limiting cancellation to pending work", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };

    await transport.cancelFileDownload(77);

    expect(requests).toEqual([{
      "@type": "cancelDownloadFile",
      file_id: 77,
      only_if_pending: false,
    }]);
  });

  it("reopens stalled proxy connections with backoff and reports a persistent failure", async () => {
    vi.useFakeTimers();
    try {
      const transport = new TauriTelegramTransport();
      const internal = transport as unknown as TestableTransport;
      const events: Parameters<TelegramEventListener>[0][] = [];
      const requests: TdObject[] = [];
      internal.listener = (event) => events.push(event);
      internal.request = async (request) => {
        requests.push(request);
        return { "@type": "ok" };
      };

      internal.handleUpdate({
        "@type": "updateConnectionState",
        state: { "@type": "connectionStateWaitingForNetwork" },
      });
      internal.handleUpdate({
        "@type": "updateConnectionState",
        state: { "@type": "connectionStateWaitingForNetwork" },
      });
      internal.handleUpdate({
        "@type": "updateConnectionState",
        state: { "@type": "connectionStateConnectingToProxy" },
      });
      await vi.advanceTimersByTimeAsync(8_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(30_000);
      internal.handleUpdate({
        "@type": "updateConnectionState",
        state: { "@type": "connectionStateReady" },
      });

      expect(requests).toEqual(Array.from({ length: 3 }, () => ({
        "@type": "setNetworkType",
        type: { "@type": "networkTypeOther" },
      })));
      expect(events).toEqual([
        { type: "connection.changed", status: "waitingForNetwork" },
        { type: "connection.changed", status: "connecting" },
        { type: "connection.changed", status: "proxyError" },
        { type: "connection.changed", status: "online" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes the initial chat refresh as one atomic event", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];

    internal.listener = (event) => events.push(event);
    internal.upsertChat(rawChat(7, 1_700_000_007));
    internal.upsertChat(rawChat(8, 1_700_000_008));

    expect(events).toEqual([]);
    internal.finishInitialChatSync();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "chats.upserted",
      chats: [{ id: "7" }, { id: "8" }],
    });
    expect(events[1]).toEqual({
      type: "drafts.replaced",
      drafts: [],
      chatIds: ["7", "8"],
    });

    internal.upsertChat(rawChat(7, 1_700_000_009));
    expect(events[2]).toMatchObject({ type: "chat.upsert", chat: { id: "7" } });
  });

  it("publishes unread mention and reply counts from live chat updates", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];

    internal.listener = (event) => events.push(event);
    internal.upsertChat(rawChat(7, 1_700_000_007));
    internal.finishInitialChatSync();
    events.length = 0;

    internal.handleUpdate({
      "@type": "updateChatUnreadMentionCount",
      chat_id: 7,
      unread_mention_count: 2,
    });

    expect(events).toEqual([expect.objectContaining({
      type: "chat.upsert",
      chat: expect.objectContaining({ id: "7", unreadMentionCount: 2 }),
    })]);
  });

  it("loads chat lists incrementally and records TDLib exhaustion", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    let loadCount = 0;
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "loadChats") {
        loadCount += 1;
        if (loadCount === 2) throw new Error("404: All chats are loaded");
        return { "@type": "ok" };
      }
      if (request["@type"] === "getChats") {
        return {
          "@type": "chats",
          chat_ids: Number(request.limit) === 2 ? [3, 2] : [3, 2, 1],
        };
      }
      return rawChat(Number(request.chat_id), 1_700_000_000 + Number(request.chat_id));
    };

    await expect(transport.loadMoreChats("main", 2)).resolves.toEqual({
      loadedCount: 2,
      hasMore: true,
    });
    await expect(transport.loadMoreChats("main", 2)).resolves.toEqual({
      loadedCount: 1,
      hasMore: false,
    });
    await expect(transport.loadMoreChats("main", 2)).resolves.toEqual({
      loadedCount: 0,
      hasMore: false,
    });

    expect(requests.filter((request) => request["@type"] === "loadChats")).toHaveLength(2);
    expect(requests.filter((request) => request["@type"] === "getChats")
      .map((request) => request.limit)).toEqual([2, 4, 5]);
    expect(requests.filter((request) => request["@type"] === "getChat")
      .map((request) => request.chat_id)).toEqual([3, 2, 1]);
  });

  it("loads only the main chat list during startup", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.listener = () => undefined;
    internal.handleUpdate({
      "@type": "updateChatFolders",
      chat_folders: Array.from({ length: 10 }, (_, id) => ({ id: id + 1 })),
      main_chat_list_position: 0,
    });
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getMe") {
        return { "@type": "user", id: 11, first_name: "Mia", last_name: "Chen" };
      }
      if (request["@type"] === "getChats") {
        return { "@type": "chats", chat_ids: [] };
      }
      return { "@type": "ok" };
    };

    await internal.bootstrap();

    const loads = requests.filter((request) => request["@type"] === "loadChats");
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({
      chat_list: { "@type": "chatListMain" },
      limit: 100,
    });
  });

  it("sends the complete pinned order and refreshes reordered chats", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.finishInitialChatSync();
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getChat") {
        return rawChat(Number(request.chat_id), 1_700_000_000 + Number(request.chat_id));
      }
      return { "@type": "ok" };
    };

    await transport.setPinnedChats("folder:12", ["8", "7"]);

    expect(requests[0]).toEqual({
      "@type": "setPinnedChats",
      chat_list: { "@type": "chatListFolder", chat_folder_id: 12 },
      chat_ids: [8, 7],
    });
    expect(requests.filter((request) => request["@type"] === "getChat")
      .map((request) => request.chat_id))
      .toEqual([8, 7]);
  });

  it("manages pin, mute, and archive state through TDLib and refreshes the chat", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const managedChat = {
      ...rawChat(7, 1_700_000_007),
      notification_settings: {
        use_default_mute_for: true,
        mute_for: 0,
        use_default_show_preview: false,
        show_preview: false,
      },
    };
    internal.finishInitialChatSync();
    internal.upsertChat(managedChat);
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getChat") return managedChat;
      return { "@type": "ok" };
    };

    await transport.setChatPinned("main", "7", true);
    await transport.setChatMuted("7", true);
    await transport.setChatArchived("7", true);

    expect(requests.filter((request) => request["@type"] !== "getChat")).toEqual([
      {
        "@type": "toggleChatIsPinned",
        chat_list: { "@type": "chatListMain" },
        chat_id: 7,
        is_pinned: true,
      },
      {
        "@type": "setChatNotificationSettings",
        chat_id: 7,
        notification_settings: {
          "@type": "chatNotificationSettings",
          use_default_mute_for: false,
          mute_for: 2_147_483_647,
          use_default_show_preview: false,
          show_preview: false,
        },
      },
      {
        "@type": "addChatToList",
        chat_id: 7,
        chat_list: { "@type": "chatListArchive" },
      },
    ]);
    expect(requests.filter((request) => request["@type"] === "getChat")).toHaveLength(3);
  });

  it("leaves chats and marks the latest message as read without redundant refreshes", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const managedChat = {
      ...rawChat(7, 1_700_000_007),
      type: { "@type": "chatTypeBasicGroup", basic_group_id: 17 },
      unread_count: 4,
    };
    internal.finishInitialChatSync();
    internal.upsertChat(managedChat);
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getChat") return managedChat;
      return { "@type": "ok" };
    };

    await transport.leaveChat("7");
    await transport.markChatRead("7");

    expect(requests.filter((request) => request["@type"] !== "getChat")).toEqual([
      { "@type": "leaveChat", chat_id: 7 },
      {
        "@type": "viewMessages",
        chat_id: 7,
        message_ids: [7],
        source: { "@type": "messageSourceChatHistory" },
        force_read: true,
      },
    ]);
    expect(requests.filter((request) => request["@type"] === "getChat")).toHaveLength(1);
  });

  it("creates and renames folders with complete TDLib folder objects", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.finishInitialChatSync();
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "createChatFolder") return rawFolderInfo(13, "客户");
      if (request["@type"] === "getChat") {
        const chat = rawChat(Number(request.chat_id), 1_700_000_000);
        chat.chat_lists = [{ "@type": "chatListFolder", chat_folder_id: 13 }];
        return chat;
      }
      if (request["@type"] === "getChatFolder") return rawFolder("工作");
      if (request["@type"] === "editChatFolder") return rawFolderInfo(12, "项目");
      return { "@type": "ok" };
    };

    await expect(transport.createChatFolder(" 客户 ", ["7", "8", "7"]))
      .resolves.toMatchObject({ id: "folder:13", title: "客户" });
    await expect(transport.renameChatFolder("folder:12", "项目"))
      .resolves.toMatchObject({ id: "folder:12", title: "项目" });

    expect(requests[0]).toEqual({
      "@type": "createChatFolder",
      folder: {
        "@type": "chatFolder",
        name: {
          "@type": "chatFolderName",
          text: { "@type": "formattedText", text: "客户", entities: [] },
          animate_custom_emoji: false,
        },
        icon: { "@type": "chatFolderIcon", name: "Custom" },
        color_id: -1,
        is_shareable: false,
        pinned_chat_ids: [],
        included_chat_ids: [7, 8],
        excluded_chat_ids: [],
        exclude_muted: false,
        exclude_read: false,
        exclude_archived: false,
        include_contacts: false,
        include_non_contacts: false,
        include_bots: false,
        include_groups: false,
        include_channels: false,
      },
    });
    expect(requests.filter((request) => request["@type"] === "getChat")
      .map((request) => request.chat_id)).toEqual([7, 8]);
    expect(requests[4]).toMatchObject({
      "@type": "editChatFolder",
      chat_folder_id: 12,
      folder: {
        icon: { "@type": "chatFolderIcon", name: "Work" },
        color_id: 2,
        exclude_muted: true,
        include_groups: true,
        name: { text: { text: "项目" } },
      },
    });
    await expect(transport.renameChatFolder("folder:12", "超过十二个字符的文件夹名称"))
      .rejects.toThrow("1 至 12 个字符");
  });

  it("preserves folder rules while removing a chat and safely refreshes folder deletion", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const inFolder = rawChat(7, 1_700_000_007);
    inFolder.chat_lists = [{ "@type": "chatListFolder", chat_folder_id: 12 }];
    internal.handleUpdate({
      "@type": "updateChatFolders",
      chat_folders: [rawFolderInfo(12, "工作")],
      main_chat_list_position: 0,
    });
    internal.upsertChat(inFolder);
    internal.finishInitialChatSync();
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getChatFolder") return rawFolder("工作");
      if (request["@type"] === "editChatFolder") return rawFolderInfo(12, "工作");
      if (request["@type"] === "getChat") return rawChat(7, 1_700_000_007);
      return { "@type": "ok" };
    };

    await transport.setChatFolderMembership("folder:12", "7", false);
    expect(requests[1]).toEqual({
      "@type": "editChatFolder",
      chat_folder_id: 12,
      folder: {
        ...rawFolder("工作"),
        pinned_chat_ids: [],
        included_chat_ids: [8],
        excluded_chat_ids: [9, 7],
      },
    });

    requests.length = 0;
    internal.upsertChat(inFolder);
    await transport.deleteChatFolder("folder:12");
    expect(requests[0]).toEqual({
      "@type": "deleteChatFolder",
      chat_folder_id: 12,
      leave_chat_ids: [],
    });
    expect(requests[1]).toEqual({ "@type": "getChat", chat_id: 7 });
  });

  it("does not refetch a known chat when its list page is discovered", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    const stale = rawChat(7, 1_700_000_007);
    const requests: TdObject[] = [];
    internal.listener = (event) => events.push(event);
    internal.upsertChat(stale);
    internal.finishInitialChatSync();
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getChats") return { "@type": "chats", chat_ids: [7] };
      return { "@type": "ok" };
    };

    await transport.loadMoreChats("main", 1);

    expect(events.at(-1)).toMatchObject({
      type: "chats.upserted",
      chats: [{ id: "7", pinned: false }],
    });
    expect(requests.filter((request) => request["@type"] === "getChat")).toEqual([]);
  });

  it("keeps a pinned position across transient empty position updates", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    const chat = rawChat(7, 1_700_000_007);
    chat.positions = [{
      list: { "@type": "chatListMain" },
      order: "1700000007",
      is_pinned: true,
    }];
    internal.listener = (event) => events.push(event);
    internal.upsertChat(chat);
    internal.finishInitialChatSync();

    internal.handleUpdate({
      "@type": "updateChatDraftMessage",
      chat_id: 7,
      draft_message: null,
      positions: [],
    });
    expect(events.at(-2)).toMatchObject({
      type: "chat.upsert",
      chat: { id: "7", pinned: true },
    });

    internal.handleUpdate({
      "@type": "updateChatPosition",
      chat_id: 7,
      position: {
        list: { "@type": "chatListMain" },
        order: "1700000007",
        is_pinned: false,
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "chat.upsert",
      chat: { id: "7", pinned: false },
    });
  });

  it("keeps pinned positions omitted by a partial chat update", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    const chat = rawChat(7, 1_700_000_007);
    chat.positions = [
      {
        list: { "@type": "chatListMain" },
        order: "200",
        is_pinned: true,
      },
      {
        list: { "@type": "chatListFolder", chat_folder_id: 12 },
        order: "100",
        is_pinned: true,
      },
    ];
    internal.listener = (event) => events.push(event);
    internal.upsertChat(chat);
    internal.finishInitialChatSync();

    internal.handleUpdate({
      "@type": "updateChatLastMessage",
      chat_id: 7,
      last_message: rawMessage(12),
      positions: [{
        list: { "@type": "chatListFolder", chat_folder_id: 12 },
        order: "100",
        is_pinned: true,
      }],
    });

    expect(events.at(-1)).toMatchObject({
      type: "chat.upsert",
      chat: {
        pinnedFolderIds: ["folder:12", "main"],
        listOrderByFolder: { main: "200", "folder:12": "100" },
      },
    });
  });
});

describe("TauriTelegramTransport message operations", () => {
  it("marks only newly routed messages for entrance animation", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);

    internal.handleUpdate({
      "@type": "updateNewMessage",
      message: rawMessage(21),
    });
    internal.emitMessage(rawMessage(20));

    expect(events).toMatchObject([
      { type: "message.upsert", message: { id: "21" }, animateEntrance: true },
      { type: "message.upsert", message: { id: "20" }, animateEntrance: false },
    ]);
  });

  it("replaces a temporary outgoing id with one atomic event", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.emitMessage({
      ...rawMessage(-21),
      is_outgoing: true,
      sending_state: { "@type": "messageSendingStatePending" },
    });
    events.length = 0;

    internal.handleUpdate({
      "@type": "updateMessageSendSucceeded",
      old_message_id: -21,
      message: { ...rawMessage(210), is_outgoing: true, sending_state: null },
    });

    expect(events).toEqual([{
      type: "message.replace",
      oldMessageId: "-21",
      message: expect.objectContaining({ id: "210", delivery: "sent", outgoing: true }),
    }]);
  });

  it("updates one pending bot draft in place and removes it before the final message", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.upsertChat(rawChat(7, 1_700_000_000));

    internal.handleUpdate({
      "@type": "updatePendingMessage",
      chat_id: 7,
      forum_topic_id: 0,
      draft_id: 81,
      content: {
        "@type": "messageText",
        text: { "@type": "formattedText", text: "First", entities: [] },
      },
    });
    internal.handleUpdate({
      "@type": "updatePendingMessage",
      chat_id: 7,
      forum_topic_id: 0,
      draft_id: 81,
      content: {
        "@type": "messageText",
        text: { "@type": "formattedText", text: "First complete", entities: [] },
      },
    });
    internal.handleUpdate({
      "@type": "updateNewMessage",
      message: rawMessage(82),
    });

    expect(events).toMatchObject([
      {
        type: "message.upsert",
        animateEntrance: true,
        message: { id: "pending:7:0:81", isPending: true, content: { text: "First" } },
      },
      {
        type: "message.upsert",
        animateEntrance: false,
        message: { id: "pending:7:0:81", isPending: true, content: { text: "First complete" } },
      },
      { type: "message.remove", chatId: "7", messageId: "pending:7:0:81", immediate: true },
      { type: "message.upsert", animateEntrance: true, message: { id: "82" } },
    ]);
  });

  it("applies late poll updates to every known message with the same poll", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.emitMessage({
      ...rawMessage(30),
      content: {
        "@type": "messagePoll",
        poll: {
          id: 501,
          question: { text: "Pick", entities: [] },
          options: [{
            id: "one",
            text: { text: "One", entities: [] },
            voter_count: 0,
            vote_percentage: 0,
          }],
          total_voter_count: 0,
          type: { "@type": "pollTypeRegular" },
        },
      },
    });
    events.length = 0;

    internal.handleUpdate({
      "@type": "updatePoll",
      poll: {
        id: 501,
        question: { text: "Pick", entities: [] },
        options: [{
          id: "one",
          text: { text: "One", entities: [] },
          voter_count: 1,
          vote_percentage: 100,
          is_chosen: true,
        }],
        total_voter_count: 1,
        can_see_results: true,
        type: { "@type": "pollTypeRegular" },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.upsert",
      message: {
        id: "30",
        content: {
          kind: "poll",
          totalVoterCount: 1,
          options: [{ chosen: true, votePercentage: 100 }],
        },
      },
    });
  });

  it("restores outgoing read state from the chat snapshot", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.upsertChat({
      ...rawChat(7, 1_700_000_007),
      last_read_outbox_message_id: "6917529027641081856",
    });

    internal.emitMessage({
      ...rawMessage(1),
      id: "6917529027641081855",
      is_outgoing: true,
    });
    internal.emitMessage({
      ...rawMessage(2),
      id: "6917529027641081857",
      is_outgoing: true,
    });
    internal.emitMessage({
      ...rawMessage(3),
      id: "6917529027641081854",
      is_outgoing: true,
      sending_state: { "@type": "messageSendingStatePending" },
    });

    expect(events.filter((event) => event.type === "message.upsert").map((event) =>
      event.type === "message.upsert" ? event.message.delivery : undefined,
    )).toEqual(["read", "sent", "sending"]);
  });

  it("keeps a live outbox read marker for history loaded afterward", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.upsertChat(rawChat(7, 1_700_000_007));
    internal.emitMessage({
      ...rawMessage(1),
      id: "6917529027641081856",
      is_outgoing: true,
    });
    events.length = 0;

    internal.handleUpdate({
      "@type": "updateChatReadOutbox",
      chat_id: 7,
      last_read_outbox_message_id: "6917529027641081856",
    });
    internal.emitMessage({
      ...rawMessage(2),
      id: "6917529027641081855",
      is_outgoing: true,
    });

    expect(events.filter((event) => event.type === "message.upsert").map((event) =>
      event.type === "message.upsert" ? event.message.delivery : undefined,
    )).toEqual(["read", "read"]);
  });

  it("hydrates missing reply content without duplicating requests", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    const requests: TdObject[] = [];
    const reply = {
      ...rawMessage(12),
      reply_to: {
        "@type": "messageReplyToMessage",
        chat_id: 7,
        message_id: 11,
        quote: null,
        origin: null,
        origin_send_date: 0,
        content: null,
      },
    };

    internal.listener = (event) => events.push(event);
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getRepliedMessage") return rawMessage(11);
      if (request["@type"] === "getUser") {
        return {
          "@type": "user",
          id: 11,
          first_name: "Remote",
          last_name: "Author",
        };
      }
      throw new Error(`Unexpected request: ${String(request["@type"])}`);
    };

    internal.emitMessage(reply);
    internal.emitMessage(reply);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(requests).toEqual([
      {
        "@type": "getRepliedMessage",
        chat_id: 7,
        message_id: 12,
      },
      {
        "@type": "getUser",
        user_id: 11,
      },
    ]);
    expect(events.filter((event) => event.type === "message.upsert").at(-1)).toMatchObject({
      type: "message.upsert",
      message: {
        id: "12",
        replyTo: {
          kind: "message",
          messageId: "11",
          senderId: "11",
          content: { kind: "text", text: "message 11" },
        },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "user.upsert",
      user: expect.objectContaining({ id: "11", displayName: "Remote Author" }),
    }));
  });

  it("hydrates partial rich messages without duplicating requests", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "richMessage",
        is_full: true,
        is_rtl: false,
        blocks: [{
          "@type": "pageBlockParagraph",
          text: { "@type": "richTextPlain", text: "complete" },
        }],
      };
    };
    const partial = {
      ...rawMessage(14),
      content: {
        "@type": "messageRichMessage",
        message: {
          "@type": "richMessage",
          is_full: false,
          is_rtl: false,
          blocks: [{
            "@type": "pageBlockThinking",
            text: { "@type": "richTextPlain", text: "thinking" },
          }],
        },
      },
    };

    internal.emitMessage(partial);
    internal.emitMessage(partial);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(requests).toEqual([{
      "@type": "getFullRichMessage",
      chat_id: 7,
      message_id: 14,
    }]);
    expect(events.at(-1)).toMatchObject({
      type: "message.upsert",
      message: {
        content: { kind: "rich", isFull: true, text: "complete" },
      },
    });
  });

  it("keeps polling partial rich messages and emits every incremental snapshot", async () => {
    vi.useFakeTimers();
    try {
      const transport = new TauriTelegramTransport();
      const internal = transport as unknown as TestableTransport;
      const events: Parameters<TelegramEventListener>[0][] = [];
      const requests: TdObject[] = [];
      internal.listener = (event) => events.push(event);
      internal.request = async (request) => {
        requests.push(request);
        const complete = requests.length > 1;
        return {
          "@type": "richMessage",
          is_full: complete,
          is_rtl: false,
          blocks: [{
            "@type": "pageBlockParagraph",
            text: { "@type": "richTextPlain", text: complete ? "complete" : "incremental" },
          }],
        };
      };
      internal.emitMessage({
        ...rawMessage(15),
        content: {
          "@type": "messageRichMessage",
          message: {
            "@type": "richMessage",
            is_full: false,
            is_rtl: false,
            blocks: [],
          },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(requests).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: "message.upsert",
        message: { content: { kind: "rich", isFull: false, text: "incremental" } },
      });

      await vi.advanceTimersByTimeAsync(420);
      expect(requests).toHaveLength(2);
      expect(events.at(-1)).toMatchObject({
        type: "message.upsert",
        message: { content: { kind: "rich", isFull: true, text: "complete" } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a replied message already loaded in the same history page", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];

    internal.listener = (event) => events.push(event);
    internal.request = async () => {
      throw new Error("reply lookup should not be needed");
    };
    internal.emitMessage(rawMessage(11));
    internal.emitMessage({
      ...rawMessage(12),
      reply_to: {
        "@type": "messageReplyToMessage",
        chat_id: 7,
        message_id: 11,
        quote: null,
        origin: null,
        origin_send_date: 0,
        content: null,
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(events.at(-1)).toMatchObject({
      type: "message.upsert",
      message: {
        id: "12",
        replyTo: { content: { kind: "text", text: "message 11" } },
      },
    });
  });

  it("queries current message permissions through TDLib", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "messageProperties",
        can_be_replied: true,
        can_be_edited: true,
        can_be_deleted_only_for_self: false,
        can_be_deleted_for_all_users: true,
        can_be_forwarded: true,
      };
    };

    await expect(transport.getMessageProperties("7", "12")).resolves.toEqual({
      canReply: true,
      canEdit: true,
      canDeleteOnlyForSelf: false,
      canDeleteForAllUsers: true,
      canForward: true,
    });
    expect(requests).toEqual([{
      "@type": "getMessageProperties",
      chat_id: 7,
      message_id: 12,
    }]);
  });

  it("loads an exact notification target through TDLib", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return rawMessage(12);
    };

    await expect(transport.getMessage("7", "12")).resolves.toMatchObject({
      id: "12",
      chatId: "7",
      content: { kind: "text", text: "message 12" },
    });
    expect(requests).toEqual([{
      "@type": "getMessage",
      chat_id: 7,
      message_id: 12,
    }]);
  });

  it("adds and removes emoji reactions through typed TDLib requests", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };

    await transport.setMessageReaction({
      chatId: "7",
      messageId: "12",
      emoji: "👍",
      chosen: true,
    });
    await transport.setMessageReaction({
      chatId: "7",
      messageId: "12",
      emoji: "👍",
      chosen: false,
    });

    expect(requests).toEqual([
      {
        "@type": "addMessageReaction",
        chat_id: 7,
        message_id: 12,
        reaction_type: { "@type": "reactionTypeEmoji", emoji: "👍" },
        is_big: false,
        update_recent_reactions: true,
      },
      {
        "@type": "removeMessageReaction",
        chat_id: 7,
        message_id: 12,
        reaction_type: { "@type": "reactionTypeEmoji", emoji: "👍" },
      },
    ]);
  });

  it("submits poll positions and refreshes the message from TDLib", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getMessage") {
        return {
          ...rawMessage(12),
          content: {
            "@type": "messagePoll",
            poll: {
              id: 91,
              question: { text: "Choose", entities: [] },
              options: [{
                id: "a",
                text: { text: "A", entities: [] },
                voter_count: 1,
                vote_percentage: 100,
                is_chosen: true,
              }],
              total_voter_count: 1,
              type: { "@type": "pollTypeRegular" },
              allows_revoting: true,
            },
          },
        };
      }
      return { "@type": "ok" };
    };

    await transport.setPollAnswer({ chatId: "7", messageId: "12", optionPositions: [1, 0, 1] });

    expect(requests).toEqual([
      { "@type": "setPollAnswer", chat_id: 7, message_id: 12, option_ids: [0, 1] },
      { "@type": "getMessage", chat_id: 7, message_id: 12 },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "message.upsert",
      message: { id: "12", content: { kind: "poll", pollId: "91" } },
    });
  });

  it("pins, unpins, and configures auto-delete through typed TDLib requests", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.emitMessage(rawMessage(12));
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getChatPinnedMessage") return { ...rawMessage(12), is_pinned: true };
      return { "@type": "ok" };
    };

    await transport.pinMessage({
      chatId: "7",
      messageId: "12",
      disableNotification: true,
      onlyForSelf: false,
    });
    await transport.unpinMessage("7", "12");
    await transport.setChatMessageAutoDeleteTime({
      chatId: "7",
      messageAutoDeleteTime: 604800,
    });
    const eventCountBeforePinnedFetch = events.length;
    await expect(transport.getPinnedMessages("7")).resolves.toHaveLength(1);
    expect(events).toHaveLength(eventCountBeforePinnedFetch);

    expect(requests).toEqual([
      {
        "@type": "pinChatMessage",
        chat_id: 7,
        message_id: 12,
        disable_notification: true,
        only_for_self: false,
      },
      { "@type": "unpinChatMessage", chat_id: 7, message_id: 12 },
      {
        "@type": "setChatMessageAutoDeleteTime",
        chat_id: 7,
        message_auto_delete_time: 604800,
      },
      { "@type": "getChat", chat_id: 7 },
      {
        "@type": "searchChatMessages",
        chat_id: 7,
        topic_id: null,
        query: "",
        sender_id: null,
        from_message_id: 0,
        offset: 0,
        limit: 100,
        filter: { "@type": "searchMessagesFilterPinned" },
      },
      { "@type": "getChatPinnedMessage", chat_id: 7 },
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "message.upsert",
        message: expect.objectContaining({ id: "12", isPinned: true }),
      }),
      expect.objectContaining({
        type: "message.upsert",
        message: expect.objectContaining({ id: "12", isPinned: false }),
      }),
    ]));
  });

  it("paginates pinned-message search without emitting detached timeline messages", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] !== "searchChatMessages") return { "@type": "ok" };
      return request.from_message_id === 0
        ? {
            "@type": "foundChatMessages",
            messages: [{ ...rawMessage(12), is_pinned: true }],
            next_from_message_id: 10,
          }
        : {
            "@type": "foundChatMessages",
            messages: [{ ...rawMessage(10), is_pinned: true }],
            next_from_message_id: 0,
          };
    };

    await expect(transport.getPinnedMessages("7")).resolves.toMatchObject([
      { id: "12", isPinned: true },
      { id: "10", isPinned: true },
    ]);
    expect(requests.map((request) => request.from_message_id)).toEqual([0, 10]);
    expect(events).toEqual([]);
  });

  it("preserves 64-bit sticker set identifiers and maps animated sticker assets", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const stickerSetId = "5368324170671202286";
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "stickerSet",
        id: stickerSetId,
        title: "Animated set",
        name: "animated_set",
        size: 1,
        covers: [],
        stickers: [{
          id: "5368324170671202287",
          emoji: "🙂",
          width: 512,
          height: 512,
          format: { "@type": "stickerFormatTgs" },
          minithumbnail: { data: "cHJldmlldw==" },
          sticker: { id: 71, local: { path: "", is_downloading_completed: false } },
        }],
      };
    };

    await expect(transport.getStickerSet(stickerSetId)).resolves.toMatchObject({
      id: stickerSetId,
      stickers: [{
        id: "sticker:5368324170671202287",
        fileId: 71,
        mimeType: "application/x-tgsticker",
        previewDataUrl: "data:image/jpeg;base64,cHJldmlldw==",
      }],
    });
    expect(requests).toEqual([{
      "@type": "getStickerSet",
      set_id: stickerSetId,
    }]);
  });

  it("loads server chat and message search results into the live maps", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    const requests: TdObject[] = [];
    internal.listener = (event) => events.push(event);
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "searchChatsOnServer") {
        return { "@type": "chats", chat_ids: [9] };
      }
      if (request["@type"] === "getChat") return rawChat(9, 1_700_000_009);
      if (request["@type"] === "searchChatMessages") {
        return { "@type": "foundChatMessages", messages: [rawMessage(15)] };
      }
      return { "@type": "ok" };
    };
    internal.finishInitialChatSync();

    await transport.searchChats("project");
    await expect(transport.searchChatMessages({ chatId: "7", query: "needle", limit: 100, topicId: "12" })).resolves.toMatchObject({
      messages: [{ id: "15" }],
    });
    await transport.markForumTopicRead("7", "12", "15");

    expect(events).toContainEqual(expect.objectContaining({
      type: "chat.upsert",
      chat: expect.objectContaining({ id: "9" }),
    }));
    expect(requests.find((request) => request["@type"] === "searchChatMessages")?.topic_id).toEqual({
      "@type": "messageTopicForum",
      forum_topic_id: 12,
    });
    expect(requests.find((request) => request["@type"] === "viewMessages")).toMatchObject({
      chat_id: 7,
      message_ids: [15],
      force_read: true,
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "message.upsert",
      message: expect.objectContaining({ id: "15", chatId: "7" }),
    }));
  });

  it("paginates shared media with category-specific server filters", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "foundChatMessages",
        total_count: 7,
        messages: [rawMessage(15), rawMessage(14)],
        next_from_message_id: 14,
      };
    };

    await expect(transport.searchSharedMedia({
      chatId: "7",
      category: "file",
      query: "design",
      fromMessageId: "20",
      limit: 2,
    })).resolves.toMatchObject({
      totalCount: 7,
      nextFromMessageId: "14",
      hasMore: true,
      messages: [{ id: "15" }, { id: "14" }],
    });
    expect(requests).toEqual([{
      "@type": "searchChatMessages",
      chat_id: 7,
      topic_id: null,
      query: "design",
      sender_id: null,
      from_message_id: 20,
      offset: 0,
      limit: 2,
      filter: { "@type": "searchMessagesFilterDocument" },
    }]);
  });

  it("returns deduplicated global search pages and preserves the TDLib cursor", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "searchMessages") {
        return request.offset
          ? { "@type": "foundMessages", total_count: -1, messages: [], next_offset: "" }
          : {
              "@type": "foundMessages",
              total_count: 2,
              messages: [rawMessage(15), rawMessage(15)],
              next_offset: "page-2",
            };
      }
      if (request["@type"] === "searchChatsOnServer") {
        return { "@type": "chats", chat_ids: [9] };
      }
      if (request["@type"] === "searchPublicChats") {
        return { "@type": "chats", chat_ids: [10] };
      }
      if (request["@type"] === "getChat") {
        return rawChat(Number(request.chat_id), 1_700_000_100);
      }
      return { "@type": "ok" };
    };
    internal.finishInitialChatSync();

    const first = await transport.searchGlobal({ query: "project", filter: "all", limit: 500 });
    const second = await transport.searchGlobal({
      query: "project",
      filter: "file",
      offset: first.nextOffset,
    });

    expect(first).toMatchObject({
      totalCount: 2,
      nextOffset: "page-2",
      messages: [{ id: "15", chatId: "7" }],
    });
    expect(first.chats.map(({ id }) => id)).toEqual(["7", "9", "10"]);
    expect(second).toEqual({ chats: [], messages: [], totalCount: undefined, nextOffset: undefined });
    const searchRequests = requests.filter((request) => request["@type"] === "searchMessages");
    expect(searchRequests).toEqual([
      {
        "@type": "searchMessages",
        chat_list: null,
        query: "project",
        offset: "",
        limit: 100,
        filter: null,
        chat_type_filter: null,
        min_date: 0,
        max_date: 0,
      },
      expect.objectContaining({
        "@type": "searchMessages",
        offset: "page-2",
        filter: { "@type": "searchMessagesFilterDocument" },
      }),
    ]);
    expect(requests.filter((request) => request["@type"] === "searchPublicChats"))
      .toHaveLength(1);
  });

  it("sends a partial text quote with the current TDLib reply object", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };

    await transport.sendMessage({
      chatId: "7",
      text: "reply",
      replyToMessageId: "12",
      replyQuote: { text: "selected text", position: 4 },
    });

    expect(requests).toEqual([{
      "@type": "sendMessage",
      chat_id: 7,
      topic_id: null,
      reply_to: {
        "@type": "inputMessageReplyToMessage",
        message_id: 12,
        quote: {
          "@type": "inputTextQuote",
          text: { "@type": "formattedText", text: "selected text", entities: [] },
          position: 4,
        },
        checklist_task_id: 0,
        poll_option_id: "",
      },
      options: null,
      reply_markup: null,
      input_message_content: {
        "@type": "inputMessageText",
        text: { "@type": "formattedText", text: "reply", entities: [] },
        link_preview_options: null,
        clear_draft: true,
      },
    }]);
  });

  it("keeps supported formatting inside a partial quote", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };

    await transport.sendMessage({
      chatId: "7",
      text: "reply",
      replyToMessageId: "12",
      replyQuote: {
        text: "selected text",
        position: 4,
        entities: [{ offset: 0, length: 8, kind: "bold" }],
      },
    });

    expect((requests[0].reply_to as TdObject).quote).toEqual({
      "@type": "inputTextQuote",
      text: {
        "@type": "formattedText",
        text: "selected text",
        entities: [{
          offset: 0,
          length: 8,
          type: { "@type": "textEntityTypeBold" },
        }],
      },
      position: 4,
    });
  });

  it("keeps custom emoji and date-time metadata required by TDLib quotes", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };

    await transport.sendMessage({
      chatId: "7",
      text: "reply",
      replyToMessageId: "12",
      replyQuote: {
        text: "😀 2026",
        position: 1,
        entities: [
          { offset: 0, length: 2, kind: "customEmoji", customEmojiId: "99" },
          {
            offset: 3,
            length: 4,
            kind: "dateTime",
            dateTime: {
              unixTime: 1_800_000_000,
              mode: "absolute",
              timePrecision: "short",
              datePrecision: "long",
              showDayOfWeek: true,
            },
          },
        ],
      },
    });

    expect((requests[0].reply_to as TdObject).quote).toEqual({
      "@type": "inputTextQuote",
      text: {
        "@type": "formattedText",
        text: "😀 2026",
        entities: [
          {
            offset: 0,
            length: 2,
            type: { "@type": "textEntityTypeCustomEmoji", custom_emoji_id: "99" },
          },
          {
            offset: 3,
            length: 4,
            type: {
              "@type": "textEntityTypeDateTime",
              unix_time: 1_800_000_000,
              formatting_type: {
                "@type": "dateTimeFormattingTypeAbsolute",
                time_precision: { "@type": "dateTimePartPrecisionShort" },
                date_precision: { "@type": "dateTimePartPrecisionLong" },
                show_day_of_week: true,
              },
            },
          },
        ],
      },
      position: 1,
    });
  });

  it("preserves a newer draft while flushing a restored outbox message", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };

    await transport.sendMessage({ chatId: "7", text: "queued", clearDraft: false });

    expect(requests[0]).toMatchObject({
      "@type": "sendMessage",
      input_message_content: { clear_draft: false },
    });
  });

  it("parses Markdown before sending and uses the parsed TDLib entities", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "parseMarkdown") {
        return {
          "@type": "formattedText",
          text: "bold",
          entities: [{
            offset: 0,
            length: 4,
            type: { "@type": "textEntityTypeBold" },
          }],
        };
      }
      return { "@type": "ok" };
    };

    await transport.sendMessage({ chatId: "7", text: "**bold**" });

    expect(requests[0]).toEqual({
      "@type": "parseMarkdown",
      text: { "@type": "formattedText", text: "**bold**", entities: [] },
    });
    expect(requests[1]).toMatchObject({
      "@type": "sendMessage",
      input_message_content: {
        text: {
          "@type": "formattedText",
          text: "bold",
          entities: [{
            offset: 0,
            length: 4,
            type: { "@type": "textEntityTypeBold" },
          }],
        },
      },
    });
  });

  it("writes, clears, and publishes chat drafts through the current TDLib schema", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };
    internal.listener = (event) => events.push(event);

    await transport.setChatDraft({
      chatId: "7",
      text: "unfinished",
      replyToMessageId: "12",
      replyQuote: { text: "draft quote", position: 7 },
    });
    await transport.setChatDraft({ chatId: "7", text: "" });

    expect(requests).toEqual([
      {
        "@type": "setChatDraftMessage",
        chat_id: 7,
        topic_id: null,
        draft_message: {
          "@type": "draftMessage",
          reply_to: {
            "@type": "inputMessageReplyToMessage",
            message_id: 12,
            quote: {
              "@type": "inputTextQuote",
              text: { "@type": "formattedText", text: "draft quote", entities: [] },
              position: 7,
            },
            checklist_task_id: 0,
            poll_option_id: "",
          },
          date: expect.any(Number),
          content: {
            "@type": "draftMessageContentText",
            text: { "@type": "formattedText", text: "unfinished", entities: [] },
            link_preview_options: null,
          },
          effect_id: 0,
          suggested_post_info: null,
        },
      },
      {
        "@type": "setChatDraftMessage",
        chat_id: 7,
        topic_id: null,
        draft_message: null,
      },
    ]);

    internal.handleUpdate({
      "@type": "updateChatDraftMessage",
      chat_id: 7,
      draft_message: {
        "@type": "draftMessage",
        reply_to: null,
        date: 1_700_000_000,
        content: {
          "@type": "draftMessageContentText",
          text: { "@type": "formattedText", text: "remote draft", entities: [] },
        },
      },
      positions: [],
    });
    internal.handleUpdate({
      "@type": "updateChatDraftMessage",
      chat_id: 7,
      draft_message: null,
      positions: [],
    });

    expect(events).toContainEqual({
      type: "chat.draftChanged",
      chatId: "7",
      draft: expect.objectContaining({ text: "remote draft" }),
    });
    expect(events.at(-1)).toEqual({
      type: "chat.draftChanged",
      chatId: "7",
      draft: undefined,
    });
  });

  it("sends and receives typing actions through TDLib", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };
    internal.listener = (event) => events.push(event);

    await transport.setChatTyping("7", true, "12");
    await transport.setChatTyping("7", false);
    internal.handleUpdate({
      "@type": "updateChatAction",
      chat_id: 7,
      sender_id: { "@type": "messageSenderUser", user_id: 11 },
      action: { "@type": "chatActionTyping" },
    });
    internal.handleUpdate({
      "@type": "updateChatAction",
      chat_id: 7,
      sender_id: { "@type": "messageSenderUser", user_id: 11 },
      action: { "@type": "chatActionCancel" },
    });

    expect(requests).toEqual([
      {
        "@type": "sendChatAction",
        chat_id: 7,
        topic_id: { "@type": "messageTopicForum", forum_topic_id: 12 },
        business_connection_id: "",
        action: { "@type": "chatActionTyping" },
      },
      {
        "@type": "sendChatAction",
        chat_id: 7,
        topic_id: null,
        business_connection_id: "",
        action: { "@type": "chatActionCancel" },
      },
    ]);
    expect(events).toContainEqual({
      type: "chat.typingChanged",
      chatId: "7",
      senderId: "11",
      typing: true,
    });
    expect(events.at(-1)).toEqual({
      type: "chat.typingChanged",
      chatId: "7",
      senderId: "11",
      typing: false,
    });
  });

  it("edits and deletes messages through TDLib", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return request["@type"] === "editMessageText" ? rawMessage(12) : { "@type": "ok" };
    };

    await transport.editMessage({ chatId: "7", messageId: "12", text: "edited" });
    await transport.deleteMessage({ chatId: "7", messageId: "12", revoke: true });

    expect(requests).toEqual([
      {
        "@type": "editMessageText",
        chat_id: 7,
        message_id: 12,
        reply_markup: null,
        input_message_content: {
          "@type": "inputMessageText",
          text: { "@type": "formattedText", text: "edited", entities: [] },
          link_preview_options: null,
          clear_draft: false,
        },
      },
      {
        "@type": "deleteMessages",
        chat_id: 7,
        message_ids: [12],
        revoke: true,
      },
    ]);
  });

  it("forwards a sorted message batch and reports partial TDLib failures", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "messages",
        messages: [
          { ...rawMessage(20), chat_id: 9, is_outgoing: true },
          null,
          { ...rawMessage(22), chat_id: 9, is_outgoing: true },
        ],
      };
    };

    await expect(transport.forwardMessages({
      fromChatId: "7",
      toChatId: "9",
      messageIds: ["14", "12", "13", "12"],
    })).resolves.toEqual({ forwardedCount: 2, failedMessageIds: ["13"] });

    expect(requests).toEqual([{
      "@type": "forwardMessages",
      chat_id: 9,
      topic_id: null,
      from_chat_id: 7,
      message_ids: [12, 13, 14],
      options: null,
      send_copy: false,
      remove_caption: false,
    }]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "message.upsert", message: { id: "20", chatId: "9" } });
    expect(events[1]).toMatchObject({ type: "message.upsert", message: { id: "22", chatId: "9" } });
  });

  it("rejects forward batches over TDLib's 100-message limit", async () => {
    const transport = new TauriTelegramTransport();
    await expect(transport.forwardMessages({
      fromChatId: "7",
      toChatId: "9",
      messageIds: Array.from({ length: 101 }, (_, index) => String(index + 1)),
    })).rejects.toThrow("单次最多转发 100 条消息");
  });

  it("sends selected files through the path-free native command", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requestedChatIds: string[] = [];
    internal.requestPreparedFile = async (chatId) => {
      requestedChatIds.push(chatId);
      return true;
    };

    await expect(transport.sendFile({ chatId: "7" })).resolves.toBe(true);
    expect(requestedChatIds).toEqual(["7"]);
  });

  it("groups pasted Telegram photos separately from pasted documents", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const groups: { chatId: string; names: string[]; caption?: string }[] = [];
    internal.requestPreparedPastedFiles = async (chatId, files, caption) => {
      groups.push({
        chatId,
        names: (files as { name: string }[]).map((file) => file.name),
        caption,
      });
      return true;
    };

    await expect(transport.sendFiles({
      chatId: "7",
      attachments: [
        { file: new File(["photo"], "first.png", { type: "image/png" }), kind: "photo" },
        { file: new File(["document"], "notes.txt", { type: "text/plain" }), kind: "document" },
        { file: new File(["photo"], "second.jpg", { type: "image/jpeg" }), kind: "photo" },
      ],
      caption: "一次说明",
    })).resolves.toBe(true);
    expect(groups).toEqual([
      { chatId: "7", names: ["first.png", "second.jpg"], caption: "一次说明" },
      { chatId: "7", names: ["notes.txt"], caption: undefined },
    ]);
  });

  it("preserves native media metadata and groups photos with videos", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const groups: unknown[][] = [];
    internal.requestPreparedPastedFiles = async (_chatId, files) => {
      groups.push(files);
      return true;
    };

    await expect(transport.sendFiles({
      chatId: "7",
      attachments: [
        {
          file: new File(["photo"], "photo.jpg", { type: "image/jpeg" }),
          kind: "photo",
          width: 800,
          height: 600,
          hasSpoiler: true,
          showCaptionAboveMedia: true,
        },
        {
          file: new File(["video"], "clip.mp4", { type: "video/mp4" }),
          kind: "video",
          width: 1280,
          height: 720,
          duration: 42,
          thumbnail: new File(["cover"], "cover.jpg", { type: "image/jpeg" }),
          hasSpoiler: true,
          showCaptionAboveMedia: true,
        },
        {
          file: new File(["audio"], "song.flac", { type: "audio/flac" }),
          kind: "audio",
          duration: 180,
          title: "song",
        },
      ],
    })).resolves.toBe(true);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject([
      { kind: "photo", width: 800, height: 600, hasSpoiler: true },
      {
        kind: "video",
        width: 1280,
        height: 720,
        duration: 42,
        thumbnail: { name: "cover.jpg", mimeType: "image/jpeg" },
      },
    ]);
    expect(groups[1]).toMatchObject([{ kind: "audio", duration: 180, title: "song" }]);
  });

  it("does not send when the native picker is cancelled and can cancel an active upload", async () => {
    const cancelledPicker = new TauriTelegramTransport();
    const transport = new TauriTelegramTransport();
    const requests: TdObject[] = [];
    (cancelledPicker as unknown as TestableTransport).requestPreparedFile = async () => false;
    (transport as unknown as TestableTransport).request = async (request) => {
      requests.push(request);
      return { "@type": "ok" };
    };

    await expect(cancelledPicker.sendFile({ chatId: "7" })).resolves.toBe(false);
    await transport.cancelFileUpload("7", "-91");

    expect(requests).toEqual([{
      "@type": "deleteMessages",
      chat_id: 7,
      message_ids: [-91],
      revoke: true,
    }]);
  });

  it("merges separate edit and interaction updates into the known message", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const messages: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => messages.push(event);
    internal.emitMessage(rawMessage(12));
    messages.length = 0;

    internal.handleUpdate({
      "@type": "updateMessageEdited",
      chat_id: 7,
      message_id: 12,
      edit_date: 1_700_000_500,
      reply_markup: null,
    });
    internal.handleUpdate({
      "@type": "updateMessageInteractionInfo",
      chat_id: 7,
      message_id: 12,
      interaction_info: {
        view_count: 9,
        forward_count: 2,
        reply_info: null,
        reactions: {
          reactions: [{
            type: { "@type": "reactionTypeEmoji", emoji: "🔥" },
            total_count: 3,
            is_chosen: true,
            recent_sender_ids: [],
          }],
        },
      },
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: "message.upsert",
      message: { id: "12", editedAt: "2023-11-14T22:21:40.000Z" },
    });
    expect(messages[1]).toMatchObject({
      type: "message.upsert",
      message: {
        id: "12",
        editedAt: "2023-11-14T22:21:40.000Z",
        interaction: {
          viewCount: 9,
          forwardCount: 2,
          reactions: [{
            type: { kind: "emoji", emoji: "🔥" },
            totalCount: 3,
            chosen: true,
          }],
        },
      },
    });
  });

  it("does not resurrect a deleted message from a late edit update", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.emitMessage(rawMessage(13));
    events.length = 0;

    internal.handleUpdate({
      "@type": "updateDeleteMessages",
      chat_id: 7,
      message_ids: [13],
      is_permanent: true,
      from_cache: false,
    });
    internal.handleUpdate({
      "@type": "updateMessageEdited",
      chat_id: 7,
      message_id: 13,
      edit_date: 1_700_000_500,
      reply_markup: null,
    });

    expect(events).toEqual([{
      type: "message.remove",
      chatId: "7",
      messageId: "13",
    }]);
  });

  it("keeps messages that TDLib removes only from its local cache", () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const events: Parameters<TelegramEventListener>[0][] = [];
    internal.listener = (event) => events.push(event);
    internal.emitMessage(rawMessage(13));
    events.length = 0;

    internal.handleUpdate({
      "@type": "updateDeleteMessages",
      chat_id: 7,
      message_ids: [13],
      is_permanent: false,
      from_cache: true,
    });
    internal.handleUpdate({
      "@type": "updateMessageEdited",
      chat_id: 7,
      message_id: 13,
      edit_date: 1_700_000_500,
      reply_markup: null,
    });

    expect(events).toEqual([expect.objectContaining({
      type: "message.upsert",
      message: expect.objectContaining({
        id: "13",
        editedAt: "2023-11-14T22:21:40.000Z",
      }),
    })]);
  });
});

describe("TauriTelegramTransport history", () => {
  it("keeps loading small TDLib pages until 30 unique messages are available", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const emittedIds: string[] = [];
    const cursors: number[] = [];

    internal.listener = (event) => {
      if (event.type === "message.upsert") emittedIds.push(event.message.id);
      if (event.type === "messages.upserted") {
        emittedIds.push(...event.messages.map((message) => message.id));
      }
    };
    internal.request = async (request) => {
      const cursor = Number(request.from_message_id);
      cursors.push(cursor);
      const newest = cursor === 0 ? 100 : cursor;
      return {
        "@type": "messages",
        total_count: -1,
        messages: [rawMessage(newest), rawMessage(newest - 1)],
      };
    };

    const page = await transport.loadChatHistory("7", 30);

    expect(page).toEqual({
      loadedCount: 30,
      hasMore: true,
      messageIds: expect.any(Array),
    });
    expect(page.messageIds).toHaveLength(30);
    expect(new Set(emittedIds)).toHaveLength(30);
    expect(cursors).toHaveLength(29);
    expect(cursors.slice(0, 3)).toEqual([0, 99, 98]);
  });

  it("keeps stalled non-empty history available for a later retry", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    let requestCount = 0;

    internal.listener = () => undefined;
    internal.request = async (request) => {
      requestCount += 1;
      const cursor = Number(request.from_message_id);
      return {
        "@type": "messages",
        total_count: -1,
        messages: cursor === 0
          ? [rawMessage(10), rawMessage(9)]
          : [rawMessage(cursor)],
      };
    };

    const firstPage = await transport.loadChatHistory("7", 30);

    expect(firstPage).toEqual({
      loadedCount: 2,
      hasMore: true,
      messageIds: ["10", "9"],
    });
    const secondPage = await transport.loadChatHistory("7", 30);
    expect(secondPage).toEqual({
      loadedCount: 0,
      hasMore: true,
      messageIds: ["9"],
    });
    expect(requestCount).toBe(7);
  });

  it("continues after repeated boundary-only pages when TDLib makes progress", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const cursors: number[] = [];
    let boundaryRequests = 0;

    internal.listener = () => undefined;
    internal.request = async (request) => {
      const cursor = Number(request.from_message_id);
      cursors.push(cursor);
      if (cursor === 0) {
        return { "@type": "messages", total_count: -1, messages: [rawMessage(10)] };
      }
      boundaryRequests += 1;
      return {
        "@type": "messages",
        total_count: -1,
        messages: boundaryRequests < 3
          ? [rawMessage(10)]
          : [rawMessage(10), rawMessage(9), rawMessage(8)],
      };
    };

    const page = await transport.loadChatHistory("7", 3);

    expect(cursors).toEqual([0, 10, 10, 10]);
    expect(page).toEqual({
      loadedCount: 3,
      hasMore: true,
      messageIds: ["10", "9", "8"],
    });
  });

  it("marks history complete only after TDLib returns an empty page", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    let requestCount = 0;

    internal.listener = () => undefined;
    internal.request = async () => {
      requestCount += 1;
      return {
        "@type": "messages",
        total_count: -1,
        messages: requestCount === 1 ? [rawMessage(10)] : [],
      };
    };

    await expect(transport.loadChatHistory("7", 30)).resolves.toEqual({
      loadedCount: 1,
      hasMore: false,
      messageIds: ["10"],
    });
    await expect(transport.loadChatHistory("7", 30)).resolves.toEqual({
      loadedCount: 0,
      hasMore: false,
      messageIds: [],
    });
    expect(requestCount).toBe(2);
  });

  it("starts from the latest history window even when live messages are already known", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const cursors: number[] = [];

    internal.listener = () => undefined;
    internal.emitMessage(rawMessage(100));
    internal.emitMessage(rawMessage(99));
    internal.request = async (request) => {
      const cursor = Number(request.from_message_id);
      cursors.push(cursor);
      return {
        "@type": "messages",
        total_count: -1,
        messages: cursor === 0
          ? [rawMessage(100), rawMessage(99)]
          : [rawMessage(99), rawMessage(98)],
      };
    };

    const page = await transport.loadChatHistory("7", 1);

    expect(cursors).toEqual([0, 99]);
    expect(page.loadedCount).toBe(1);
    expect(page.hasMore).toBe(true);
    expect(page.messageIds).toEqual(["100", "99", "98"]);
  });
});

describe("TauriTelegramTransport media", () => {
  it("cancels an idle stream without interrupting an explicit file download", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "file",
        id: request.file_id,
        local: {
          can_be_downloaded: true,
          is_downloading_active: true,
          is_downloading_completed: false,
        },
        remote: {},
      };
    };

    await transport.suspendFileStream(70);
    const download = transport.downloadFile(71, "video.mp4").catch((error: unknown) => error);
    await Promise.resolve();
    await transport.suspendFileStream(71);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      "@type": "cancelDownloadFile",
      file_id: 70,
      only_if_pending: false,
    });
    expect(requests[1]).toMatchObject({
      "@type": "downloadFile",
      file_id: 71,
      limit: 0,
    });
    await transport.cancelFileDownload(71);
    await expect(download).resolves.toMatchObject({ message: "文件下载已取消" });
  });

  it("caches photo media only after a visible-file request", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];

    internal.listener = () => undefined;
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "file",
        id: 91,
        size: 4096,
        local: {
          can_be_downloaded: true,
          is_downloading_active: true,
          is_downloading_completed: false,
        },
        remote: {},
      };
    };

    internal.emitMessage({
      "@type": "message",
      id: 12,
      chat_id: 7,
      sender_id: { "@type": "messageSenderUser", user_id: 11 },
      date: 1_700_000_000,
      content: {
        "@type": "messagePhoto",
        caption: { "@type": "formattedText", text: "preview", entities: [] },
        photo: {
          sizes: [{
            width: 1280,
            height: 720,
            photo: {
              "@type": "file",
              id: 91,
              size: 4096,
              local: {
                can_be_downloaded: true,
                is_downloading_active: false,
                is_downloading_completed: false,
              },
              remote: {},
            },
          }],
        },
      },
    });
    await Promise.resolve();

    expect(requests).toHaveLength(0);
    void internal.cacheFile(91, 18);
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      "@type": "downloadFile",
      file_id: 91,
      priority: 18,
      synchronous: false,
    });
  });
});

describe("TauriTelegramTransport avatars", () => {
  it("invalidates a stale local file before downloading it again", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.listener = () => undefined;
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "deleteFile") return { "@type": "ok" };
      return {
        "@type": "file",
        id: request.file_id,
        local: {
          can_be_downloaded: true,
          is_downloading_active: false,
          is_downloading_completed: true,
          path: "C:\\cache\\restored.jpg",
        },
        remote: {},
      };
    };

    await internal.recoverFile(44, 32);

    expect(requests).toEqual([
      { "@type": "deleteFile", file_id: 44 },
      expect.objectContaining({
        "@type": "downloadFile",
        file_id: 44,
        priority: 32,
      }),
    ]);
  });

  it("downloads and publishes a user's small profile photo on demand", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    const imagePaths: Array<string | undefined> = [];

    internal.listener = (event) => {
      if (event.type === "user.upsert") imagePaths.push(event.user.avatar.imagePath);
    };
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "file",
        id: 44,
        local: {
          can_be_downloaded: true,
          is_downloading_active: false,
          is_downloading_completed: true,
          path: "C:\\avatars\\mia.jpg",
        },
        remote: {},
      };
    };

    internal.upsertUser({
      "@type": "user",
      id: 11,
      first_name: "Mia",
      last_name: "Chen",
      profile_photo: {
        small: {
          "@type": "file",
          id: 44,
          local: {
            can_be_downloaded: true,
            is_downloading_active: false,
            is_downloading_completed: false,
          },
          remote: {},
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(requests).toHaveLength(0);
    expect(imagePaths).toEqual([undefined]);
    await internal.cacheFile(44, 16);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      "@type": "downloadFile",
      file_id: 44,
      priority: 16,
    });
    expect(imagePaths).toEqual([undefined, "C:\\avatars\\mia.jpg"]);
  });

  it("limits background cache downloads to three active files", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.listener = () => undefined;
    internal.request = async (request) => {
      requests.push(request);
      return {
        "@type": "file",
        id: request.file_id,
        local: {
          can_be_downloaded: true,
          is_downloading_active: true,
          is_downloading_completed: false,
        },
        remote: {},
      };
    };

    for (let fileId = 1; fileId <= 6; fileId += 1) {
      void internal.cacheFile(fileId);
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(3);

    internal.handleUpdate({
      "@type": "updateFile",
      file: {
        "@type": "file",
        id: 1,
        local: {
          can_be_downloaded: true,
          is_downloading_active: false,
          is_downloading_completed: true,
          path: "C:\\cache\\1.jpg",
        },
        remote: {},
      },
    });
    await Promise.resolve();
    expect(requests).toHaveLength(4);
  });

  it("releases a stopped preview download so it can be retried", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as TestableTransport;
    const requests: TdObject[] = [];
    internal.listener = () => undefined;
    internal.request = async (request) => {
      requests.push(request);
      const completed = requests.length > 1;
      return {
        "@type": "file",
        id: request.file_id,
        local: {
          can_be_downloaded: true,
          is_downloading_active: !completed,
          is_downloading_completed: completed,
          path: completed ? "C:\\cache\\44.webp" : "",
        },
        remote: {},
      };
    };

    const firstDownload = internal.cacheFile(44);
    const firstResult = expect(firstDownload).rejects.toThrow("stopped");
    await Promise.resolve();
    await Promise.resolve();
    internal.handleUpdate({
      "@type": "updateFile",
      file: {
        "@type": "file",
        id: 44,
        local: {
          can_be_downloaded: true,
          is_downloading_active: false,
          is_downloading_completed: false,
        },
        remote: {},
      },
    });
    await firstResult;

    await expect(internal.cacheFile(44)).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
  });
});
