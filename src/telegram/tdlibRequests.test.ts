import { describe, expect, it } from "vitest";
import {
  chatListObject,
  effectiveProxy,
  mapAuthorizationState,
  numericId,
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
    expect(effectiveProxy({ mode: "direct", custom: endpoint })).toBeUndefined();
    expect(effectiveProxy({ mode: "system", custom: endpoint, system: endpoint })).toEqual(endpoint);
    expect(effectiveProxy({ mode: "custom", custom: endpoint })).toEqual(endpoint);
  });
});
