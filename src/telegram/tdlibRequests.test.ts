import { describe, expect, it } from "vitest";
import {
  activeProxyProfile,
  chatListObject,
  effectiveProxy,
  forumTopicObject,
  mapAuthorizationState,
  numericId,
  nextProxyProfile,
} from "./tdlibRequests";

describe("TDLib request builders", () => {
  it("validates numeric identifiers and typed chat lists", () => {
    expect(numericId("42")).toBe(42);
    expect(() => numericId("chat-42")).toThrow("无效的 Telegram 标识符");
    expect(chatListObject("folder:7")).toEqual({
      "@type": "chatListFolder",
      chat_folder_id: 7,
    });
    expect(() => chatListObject("folder:bad")).toThrow("无效的聊天列表");
    expect(forumTopicObject("12")).toEqual({
      "@type": "messageTopicForum",
      forum_topic_id: 12,
    });
    expect(forumTopicObject()).toBeNull();
  });

  it("maps authorization details without exposing raw TDLib objects", () => {
    expect(mapAuthorizationState({
      "@type": "authorizationStateWaitCode",
      code_info: {
        phone_number: "+86138****0000",
        type: { "@type": "authenticationCodeTypeSms", length: 6 },
      },
    })).toEqual({
      kind: "waitCode",
      phoneNumber: "+86138****0000",
      codeLength: 6,
    });
  });

  it("resolves direct, system, and custom proxy modes", () => {
    const endpoint = {
      type: "socks5" as const,
      server: "127.0.0.1",
      port: 1080,
      username: "",
      password: "",
      secret: "",
      httpOnly: false,
    };
    const profiles = [
      { id: "primary", name: "主代理", endpoint },
      { id: "backup", name: "备用代理", endpoint: { ...endpoint, port: 1081 } },
    ];
    const settings = {
      mode: "custom" as const,
      profiles,
      activeProfileId: "primary",
      autoSwitch: true,
    };
    expect(effectiveProxy({ ...settings, mode: "direct" })).toBeUndefined();
    expect(effectiveProxy({ ...settings, mode: "system", system: endpoint })).toEqual(endpoint);
    expect(effectiveProxy(settings)).toEqual(endpoint);
    expect(activeProxyProfile({ ...settings, activeProfileId: "missing" })).toEqual(profiles[0]);
    expect(nextProxyProfile(settings, "primary")).toEqual(profiles[1]);
    expect(nextProxyProfile(settings, "backup")).toEqual(profiles[0]);
  });
});
