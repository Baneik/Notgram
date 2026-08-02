import { asTdObject, tdChatListId, tdNumber, type TdObject } from "./tdlibMapper";
import type { AuthorizationState, ProxyEndpoint, ProxySettings } from "./types";

export const numericId = (id: string) => {
  const value = Number(id);
  if (!Number.isSafeInteger(value)) throw new Error(`无效的 Telegram 标识符：${id}`);
  return value;
};

export const formattedTextObject = (text: string): TdObject => ({
  "@type": "formattedText",
  text,
  entities: [],
});

export const inputMessageText = (text: string | TdObject, clearDraft: boolean): TdObject => ({
  "@type": "inputMessageText",
  text: typeof text === "string" ? formattedTextObject(text) : text,
  link_preview_options: null,
  clear_draft: clearDraft,
});

export const listObject = (type: "chatListMain" | "chatListArchive") => ({
  "@type": type,
});

const folderListObject = (folderId: unknown) => ({
  "@type": "chatListFolder",
  chat_folder_id: Number(folderId),
});

export const chatListObject = (chatListId: string): TdObject => {
  if (chatListId === "main") return listObject("chatListMain");
  if (chatListId === "archive") return listObject("chatListArchive");
  const folderId = /^folder:(\d+)$/.exec(chatListId)?.[1];
  if (!folderId) throw new Error(`无效的聊天列表：${chatListId}`);
  return folderListObject(folderId);
};

export const chatFolderNumericId = (folderId: string) => {
  const value = /^folder:(\d+)$/.exec(folderId)?.[1];
  if (!value) throw new Error(`无效的聊天文件夹：${folderId}`);
  return Number(value);
};

export const chatListKey = (value: unknown) => tdChatListId(value);

const proxyTypeValue = (endpoint: ProxyEndpoint): TdObject => {
  if (endpoint.type === "socks5") {
    return {
      "@type": "proxyTypeSocks5",
      username: endpoint.username,
      password: endpoint.password,
    };
  }
  if (endpoint.type === "mtproto") {
    return { "@type": "proxyTypeMtproto", secret: endpoint.secret };
  }
  return {
    "@type": "proxyTypeHttp",
    username: endpoint.username,
    password: endpoint.password,
    http_only: endpoint.httpOnly,
  };
};

export const proxyValue = (endpoint: ProxyEndpoint): TdObject => ({
  "@type": "proxy",
  server: endpoint.server.trim(),
  port: endpoint.port,
  type: proxyTypeValue(endpoint),
});

export const sameProxy = (raw: TdObject, endpoint: ProxyEndpoint) => {
  if (raw.server !== endpoint.server.trim() || tdNumber(raw.port) !== endpoint.port) return false;
  const rawType = asTdObject(raw.type);
  if (endpoint.type === "mtproto") {
    return rawType?.["@type"] === "proxyTypeMtproto" && rawType.secret === endpoint.secret;
  }
  if (endpoint.type === "socks5") {
    return rawType?.["@type"] === "proxyTypeSocks5" &&
      rawType.username === endpoint.username && rawType.password === endpoint.password;
  }
  return rawType?.["@type"] === "proxyTypeHttp" &&
    rawType.username === endpoint.username && rawType.password === endpoint.password &&
    rawType.http_only === endpoint.httpOnly;
};

export const effectiveProxy = (settings: ProxySettings) => {
  if (settings.mode === "direct") return undefined;
  return settings.mode === "system" ? settings.system : settings.custom;
};

export const mapAuthorizationState = (state: TdObject): AuthorizationState => {
  switch (state["@type"]) {
    case "authorizationStateWaitTdlibParameters":
      return { kind: "preparing" };
    case "authorizationStateWaitPhoneNumber":
      return { kind: "waitPhoneNumber" };
    case "authorizationStateWaitCode": {
      const codeInfo = asTdObject(state.code_info);
      const codeType = asTdObject(codeInfo?.type);
      return {
        kind: "waitCode",
        phoneNumber:
          typeof codeInfo?.phone_number === "string" ? codeInfo.phone_number : undefined,
        codeLength: tdNumber(codeType?.length),
      };
    }
    case "authorizationStateWaitPassword":
      return {
        kind: "waitPassword",
        hint: typeof state.password_hint === "string" ? state.password_hint : undefined,
      };
    case "authorizationStateWaitEmailAddress":
      return { kind: "waitEmailAddress" };
    case "authorizationStateWaitEmailCode": {
      const codeInfo = asTdObject(state.code_info);
      return {
        kind: "waitEmailCode",
        emailPattern:
          typeof codeInfo?.email_address_pattern === "string"
            ? codeInfo.email_address_pattern
            : undefined,
        codeLength: tdNumber(codeInfo?.length),
      };
    }
    case "authorizationStateWaitRegistration":
      return { kind: "waitRegistration" };
    case "authorizationStateWaitOtherDeviceConfirmation":
      return { kind: "waitOtherDeviceConfirmation", link: String(state.link ?? "") };
    case "authorizationStateReady":
      return { kind: "ready" };
    case "authorizationStateLoggingOut":
      return { kind: "loggingOut" };
    case "authorizationStateClosing":
      return { kind: "closing" };
    case "authorizationStateClosed":
      return { kind: "closed" };
    default:
      return { kind: "preparing" };
  }
};
