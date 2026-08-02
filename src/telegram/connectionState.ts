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
    label: "正在连接 Telegram",
    compactLabel: "连接中",
    tone: "progress",
    busy: true,
    operational: false,
  },
  syncing: {
    label: "正在同步消息",
    compactLabel: "同步中",
    tone: "progress",
    busy: true,
    operational: true,
  },
  online: {
    label: "已连接",
    compactLabel: "在线",
    tone: "positive",
    busy: false,
    operational: true,
  },
  waitingForNetwork: {
    label: "正在等待网络，仍可浏览缓存和编辑草稿",
    compactLabel: "等待网络",
    tone: "warning",
    busy: true,
    operational: false,
  },
  proxyError: {
    label: "代理连接失败，请检查连接设置",
    compactLabel: "代理错误",
    tone: "negative",
    busy: false,
    operational: false,
  },
  offline: {
    label: "当前离线，仍可浏览缓存和编辑草稿",
    compactLabel: "离线",
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
