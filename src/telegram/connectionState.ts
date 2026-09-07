import { translate } from "../i18n";
import type { ConnectionStatus } from "./types";
import { asTdObject, type TdObject } from "./tdlibMapper";

export interface ConnectionPresentation {
  label: string;
  compactLabel: string;
  tone: "positive" | "progress" | "warning" | "negative" | "neutral";
  busy: boolean;
  operational: boolean;
}

const presentations: Record<ConnectionStatus, ConnectionPresentation> = {
  connecting: {
    get label() { return translate("正在连接 Telegram"); },
    get compactLabel() { return translate("连接中"); },
    tone: "progress",
    busy: true,
    operational: false,
  },
  recovering: {
    get label() { return translate("连接中断，正在自动重试"); },
    get compactLabel() { return translate("正在重连"); },
    tone: "warning",
    busy: true,
    operational: false,
  },
  syncing: {
    get label() { return translate("正在同步消息"); },
    get compactLabel() { return translate("同步中"); },
    tone: "progress",
    busy: true,
    operational: true,
  },
  online: {
    get label() { return translate("已连接"); },
    get compactLabel() { return translate("在线"); },
    tone: "positive",
    busy: false,
    operational: true,
  },
  waitingForNetwork: {
    get label() { return translate("正在等待网络，仍可浏览缓存和编辑草稿"); },
    get compactLabel() { return translate("等待网络"); },
    tone: "warning",
    busy: true,
    operational: false,
  },
  proxyError: {
    get label() { return translate("代理设置暂不可用，请检查连接设置"); },
    get compactLabel() { return translate("代理错误"); },
    tone: "negative",
    busy: false,
    operational: false,
  },
  offline: {
    get label() { return translate("当前离线，仍可浏览缓存和编辑草稿"); },
    get compactLabel() { return translate("离线"); },
    tone: "neutral",
    busy: false,
    operational: false,
  },
};

export const connectionPresentation = (status: ConnectionStatus) =>
  presentations[status];

export const mapTdConnectionStatus = (value: unknown): ConnectionStatus | undefined => {
  const state = asTdObject(value);
  switch (state?.["@type"]) {
    case "connectionStateWaitingForNetwork":
      return "waitingForNetwork";
    case "connectionStateConnectingToProxy":
    case "connectionStateConnecting":
      return "connecting";
    case "connectionStateUpdating":
      return "syncing";
    case "connectionStateReady":
      return "online";
    default:
      return undefined;
  }
};

export const tdConnectionState = (update: TdObject) => asTdObject(update.state);
