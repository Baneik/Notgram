import { describe, expect, it, vi } from "vitest";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";

const parameter = "SetGroupOperate=-1001234567890";
const webLink = `https://t.me/notgram_bot?start=${parameter}`;

const setup = (autostart: boolean, interruptAt?: string) => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as {
    request: (request: TdObject) => Promise<TdObject>;
    sessionGeneration: number;
    rawChats: Map<string, TdObject>;
    rawUsers: Map<string, TdObject>;
  };
  const request = vi.fn(async (query: TdObject): Promise<TdObject> => {
    if (query["@type"] === interruptAt) internal.sessionGeneration += 1;
    switch (query["@type"]) {
      case "getInternalLinkType":
        // Match the bundled TDLib parser: '=' is not a base64url character.
        return String(query.link).endsWith("?start")
          ? { "@type": "internalLinkTypeBotStart", bot_username: "notgram_bot", start_parameter: "", autostart }
          : { "@type": "internalLinkTypePublicChat", chat_username: "notgram_bot", open_profile: false };
      case "searchPublicChat":
        return { "@type": "chat", id: 72, title: "Notgram Bot", type: { "@type": "chatTypePrivate", user_id: 901 }, positions: [] };
      case "getUser":
        return { "@type": "user", id: 901, first_name: "Notgram Bot", type: { "@type": "userTypeBot" } };
      default:
        return { "@type": "ok" };
    }
  });
  internal.request = request;
  return { transport, internal, request };
};

describe("legacy bot start links", () => {
  it.each([
    [webLink, false],
    [webLink, true],
    [`https://t.me/notgram_bot?start=${encodeURIComponent(parameter)}`, true],
    [`tg://resolve?domain=notgram_bot&start=${encodeURIComponent(parameter)}`, false],
  ])("preserves the payload and TDLib autostart policy for %s (%s)", async (url, autostart) => {
    const { transport, request } = setup(autostart);
    const target = await transport.resolveTelegramLink(url);
    expect(target).toEqual({ kind: "botStart", chatId: "72", botUserId: "901", parameter, autostart });
    expect(request.mock.calls.map(([query]) => query["@type"]))
      .toEqual(["getInternalLinkType", "getInternalLinkType", "searchPublicChat", "getUser"]);
    expect(request.mock.calls[1][0]).toEqual({ "@type": "getInternalLinkType", link: "https://t.me/notgram_bot?start" });
    if (!target || !("kind" in target) || target.kind !== "botStart") throw new Error("Expected bot start");
    await transport.sendBotStartMessage(target.chatId, target.botUserId, target.parameter);
    expect(request).toHaveBeenLastCalledWith({ "@type": "sendBotStartMessage", bot_user_id: 901, chat_id: 72, parameter });
  });

  it("rejects a private user who is not a bot", async () => {
    const { transport, internal } = setup(true);
    internal.rawUsers.set("901", { "@type": "user", id: 901, type: { "@type": "userTypeRegular" } });
    await expect(transport.resolveTelegramLink(webLink)).resolves.toMatchObject({ kind: "unsupported" });
  });

  it.each([undefined, { "@type": "internalLinkTypePublicChat" }, {
    "@type": "internalLinkTypeBotStart", bot_username: "another_bot", autostart: true,
  }])("does not guess start policy when TDLib cannot confirm it (%j)", async (startType) => {
    const { transport, internal, request } = setup(true);
    internal.request = async (query) => {
      if (String(query.link).endsWith("?start")) {
        if (!startType) throw new Error("Unavailable");
        return startType;
      }
      return request(query);
    };
    await expect(transport.resolveTelegramLink(webLink)).resolves.toMatchObject({ kind: "unsupported" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["getInternalLinkType", "searchPublicChat", "getUser"])("ignores a stale %s response after switching accounts", async (stage) => {
    const { transport, internal } = setup(true, stage);
    await expect(transport.resolveTelegramLink(webLink)).resolves.toBeUndefined();
    expect(internal.rawChats.size).toBe(0);
    expect(internal.rawUsers.size).toBe(0);
  });

  it("ignores a stale start-policy response after switching accounts", async () => {
    const { transport, internal, request } = setup(true);
    internal.request = async (query) => {
      const response = await request(query);
      if (String(query.link).endsWith("?start")) internal.sessionGeneration += 1;
      return response;
    };
    await expect(transport.resolveTelegramLink(webLink)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
