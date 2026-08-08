import type { TelegramTransport } from "../telegram/transport";
import type {
  DeviceSession,
  PrivacyRule,
  PrivacySettingKey,
} from "../telegram/types";
import type { TelegramState } from "./telegramStore.types";

type StoreSetter = (
  patch: Partial<TelegramState> | ((state: TelegramState) => Partial<TelegramState>),
) => void;

export interface SessionController {
  getActiveSessions: () => Promise<DeviceSession[]>;
  terminateSession: (sessionId: string) => Promise<boolean>;
  terminateAllOtherSessions: () => Promise<boolean>;
  getPrivacySettingRules: (setting: PrivacySettingKey) => Promise<PrivacyRule[]>;
  setPrivacySettingRules: (setting: PrivacySettingKey, rules: PrivacyRule[]) => Promise<boolean>;
}

export interface SessionControllerOptions {
  transport: TelegramTransport;
  set: StoreSetter;
  onError: (error: unknown, fallback: string) => string;
}

/** Keeps account security/session commands out of the root Telegram Store. */
export const createSessionController = ({
  transport,
  set,
  onError,
}: SessionControllerOptions): SessionController => ({
  getActiveSessions: async () => {
    try {
      return await transport.getActiveSessions();
    } catch (error) {
      set({ operationError: onError(error, "无法读取设备会话") });
      return [];
    }
  },

  terminateSession: async (sessionId) => {
    try {
      await transport.terminateSession(sessionId);
      set({ operationError: undefined });
      return true;
    } catch (error) {
      set({ operationError: onError(error, "无法终止设备会话") });
      return false;
    }
  },

  terminateAllOtherSessions: async () => {
    try {
      await transport.terminateAllOtherSessions();
      set({ operationError: undefined });
      return true;
    } catch (error) {
      set({ operationError: onError(error, "无法终止其他设备") });
      return false;
    }
  },

  getPrivacySettingRules: async (setting) => {
    try {
      return await transport.getPrivacySettingRules(setting);
    } catch (error) {
      set({ operationError: onError(error, "无法读取隐私设置") });
      return [];
    }
  },

  setPrivacySettingRules: async (setting, rules) => {
    try {
      await transport.setPrivacySettingRules(setting, rules);
      set({ operationError: undefined });
      return true;
    } catch (error) {
      set({ operationError: onError(error, "无法保存隐私设置") });
      return false;
    }
  },
});
