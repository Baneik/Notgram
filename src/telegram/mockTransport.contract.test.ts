import { describe, expect, it } from "vitest";
import { MockTelegramTransport } from "./mockTransport";
import type { Message, OutgoingAttachmentKind } from "./types";

describe("Mock transport fixture contracts", () => {
  describe("bot commands and inline queries", () => {
    it("provides command hints, paginates inline results, and sends the chosen result", async () => {
      const transport = new MockTelegramTransport();
      const internal = transport as unknown as { snapshot: { messages: Array<{ content: { kind: string; text?: string } }> } };
      const commands = await transport.getBotCommandSuggestions("chat-product", "st");
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ command: "start", botUserId: "bot:notgram_bot" });
      const first = await transport.getInlineQueryResults("chat-product", "notgram_bot", "release");
      expect(first.results).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      await transport.sendInlineQueryResultMessage("chat-product", "bot:notgram_bot", first.queryId, first.results[0].id);
      await transport.sendBotStartMessage("chat-product", "bot:notgram_bot", "campaign");
      expect(internal.snapshot.messages.some((message) => message.content.kind === "text" && message.content.text?.includes("@notgram_bot"))).toBe(true);
      expect(internal.snapshot.messages.some((message) => message.content.kind === "text" && message.content.text === "/start campaign")).toBe(true);
    });

    it("keeps bot deep-link parameters and autostarts known bot chats", async () => {
      const transport = new MockTelegramTransport();
      const first = await transport.resolveTelegramLink(
        "https://t.me/notgram_bot?start=verify_A1b2-token",
      );
      expect(first).toMatchObject({
        kind: "botStart",
        botUserId: "u-notgram-bot",
        parameter: "verify_A1b2-token",
        autostart: false,
      });
      if (!first || !("kind" in first) || first.kind !== "botStart") return;

      await transport.sendBotStartMessage(first.chatId, first.botUserId, first.parameter);
      await expect(transport.resolveTelegramLink(
        "tg://resolve?domain=notgram_bot&start=verify_A1b2-token",
      )).resolves.toMatchObject({
        kind: "botStart",
        chatId: first.chatId,
        parameter: "verify_A1b2-token",
        autostart: true,
      });
    });
  });

  describe("channel album sends", () => {
    it.each<[OutgoingAttachmentKind, number]>([["photo", 0], ["video", 0], ["document", 2], ["audio", 2]])(
      "keeps the shared %s caption and entities on the compatible item", async (kind, captionIndex) => {
        const transport = new MockTelegramTransport();
        const sent: Message[] = [];
        await transport.connect(event => { if (event.type === "message.upsert") sent.push(event.message); });
        const accepted: number[] = [];
        await transport.sendFiles({
          chatId: "chat-release",
          attachments: [0, 1, 2].map(index => ({ kind, file: new File(["media"], `media-${index}`, { type: "application/octet-stream" }) })),
          caption: "description", captionEntities: [{ kind: "bold", offset: 0, length: 11 }],
          onGroupAccepted: async group => { accepted.push(group.length); },
        });
        expect(sent).toHaveLength(3);
        expect(new Set(sent.map(message => message.mediaAlbumId)).size).toBe(1);
        expect(sent[0].mediaAlbumId).toBeTruthy();
        expect(sent.map(message => "caption" in message.content ? message.content.caption : undefined))
          .toEqual([0, 1, 2].map(index => index === captionIndex ? "description" : undefined));
        expect(sent[captionIndex].content).toMatchObject({ captionEntities: [{ kind: "bold", offset: 0, length: 11 }] });
        expect(accepted).toEqual([3]);
        transport.disconnect();
      },
    );

    it("splits oversized document batches and sends the description only once", async () => {
      const transport = new MockTelegramTransport();
      const sent: Message[] = [];
      await transport.connect(event => { if (event.type === "message.upsert") sent.push(event.message); });
      await transport.sendFiles({ chatId: "chat-release", caption: "one description",
        attachments: Array.from({ length: 12 }, (_, index) => ({ kind: "document" as const, file: new File(["file"], `${index}.png`) })),
      });
      expect(sent[9].content).toMatchObject({ caption: "one description" });
      expect(sent.filter(message => "caption" in message.content && message.content.caption)).toHaveLength(1);
      expect(sent[0].mediaAlbumId).not.toBe(sent[10].mediaAlbumId);
      transport.disconnect();
    });
  });

  describe("global search transport", () => {
    it("paginates mock message results in reverse chronological order without overlap", async () => {
      const transport = new MockTelegramTransport();
      const first = await transport.searchGlobal({
        query: "产品讨论历史消息",
        filter: "message",
        limit: 10,
      });
      const second = await transport.searchGlobal({
        query: "产品讨论历史消息",
        filter: "message",
        offset: first.nextOffset,
        limit: 10,
      });

      expect(first.totalCount).toBe(36);
      expect(first.nextOffset).toBe("10");
      expect(first.messages.map(({ id }) => id)).toEqual(
        Array.from({ length: 10 }, (_, index) => `p-old-${36 - index}`),
      );
      expect(second.nextOffset).toBe("20");
      expect([...new Set([
        ...first.messages.map(({ id }) => id),
        ...second.messages.map(({ id }) => id),
      ])]).toHaveLength(20);
      expect(first.chats.map(({ id }) => id)).toContain("chat-product");
    });

    it("applies media and link filters independently", async () => {
      const transport = new MockTelegramTransport();

      await expect(transport.searchGlobal({
        query: "界面预览",
        filter: "media",
      })).resolves.toMatchObject({ messages: [{ id: "p-5" }] });
      await expect(transport.searchGlobal({
        query: "link",
        filter: "link",
      })).resolves.toMatchObject({ messages: [{ id: "p-rich-entities" }] });
    });

    it("treats search syntax as plain text", async () => {
      const transport = new MockTelegramTransport();

      const page = await transport.searchGlobal({
        query: "产品讨论历史消息 36",
        filter: "message",
      });

      expect(page.messages.map(({ id }) => id)).toEqual(["p-old-36"]);
      expect(page.totalCount).toBe(1);
      await expect(transport.searchGlobal({ query: "literal:[", filter: "all" }))
        .resolves.toMatchObject({ messages: [], totalCount: 0 });
    });
  });

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

  describe("moderation", () => {
    it("blocks/unblocks senders and validates report reasons", async () => {
      const transport = new MockTelegramTransport();
      await transport.setMessageSenderBlocked("u-mia", "user", true);
      expect((await transport.getBlockedSenders()).map((sender) => sender.id)).toContain("u-mia");
      const options = await transport.getChatReportOptions("chat-product", ["p-1"]);
      expect(options.kind).toBe("options");
      if (options.kind !== "options") throw new Error("Expected choices");
      expect(options.options.some((option) => option.title === "Spam or scam")).toBe(true);
      expect(await transport.reportChat({ chatId: "chat-product", messageIds: ["p-1"], optionId: btoa("spam") })).toMatchObject({ kind: "options" });
      expect(await transport.reportChat({ chatId: "chat-product", messageIds: ["p-1"], optionId: btoa("other") })).toEqual({ kind: "text", optionId: btoa("comment:other"), isOptional: false });
      await transport.setMessageSenderBlocked("u-mia", "user", false);
      expect(await transport.getBlockedSenders()).toHaveLength(0);
    });
  });

  describe("device sessions and privacy", () => {
    it("terminates other devices and persists privacy rules", async () => {
      const transport = new MockTelegramTransport();
      expect((await transport.getActiveSessions()).filter((session) => !session.isCurrent)).toHaveLength(1);
      await transport.terminateSession("session-phone");
      expect((await transport.getActiveSessions()).filter((session) => !session.isCurrent)).toHaveLength(0);
      await transport.setPrivacySettingRules("showPhoneNumber", [{ kind: "allowContacts" }]);
      expect(await transport.getPrivacySettingRules("showPhoneNumber")).toEqual([{ kind: "allowContacts" }]);
    });
  });
});
