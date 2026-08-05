import { invoke } from "@tauri-apps/api/core";
import { tdNumber, type TdObject } from "./tdlibMapper";
import { numericId } from "./tdlibRequests";

type PendingRequest = {
  resolve: (value: TdObject) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof globalThis.setTimeout>;
};

type InvokeCommand = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export interface PreparedPastedFile {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export class TdRequestBroker {
  private pending = new Map<string, PendingRequest>();
  private preparedFiles = new Map<string, (error: Error) => void>();

  constructor(private invokeCommand: InvokeCommand = invoke) {}

  async request(request: TdObject) {
    const requestType = typeof request["@type"] === "string" ? request["@type"] : "unknown";
    const extra = crypto.randomUUID();
    const response = this.waitForResponse(extra, `TDLib ${requestType} 请求超时。`);
    try {
      await this.invokeCommand("telegram_send", { request: { ...request, "@extra": extra } });
    } catch (error) {
      this.reject(extra, error);
    }
    return response;
  }

  async requestPreparedFile(chatId: string, onError: (error: Error) => void) {
    const extra = crypto.randomUUID();
    this.preparedFiles.set(extra, onError);
    try {
      const selected = await this.invokeCommand("telegram_pick_and_send_file", {
        chatId: numericId(chatId),
        extra,
      });
      if (!selected) {
        this.preparedFiles.delete(extra);
        return false;
      }
    } catch (error) {
      this.preparedFiles.delete(extra);
      throw error;
    }
    return true;
  }

  async requestPreparedPastedFiles(
    chatId: string,
    files: PreparedPastedFile[],
    onError: (error: Error) => void,
  ) {
    const extra = crypto.randomUUID();
    this.preparedFiles.set(extra, onError);
    try {
      const sent = await this.invokeCommand("telegram_send_pasted_files", {
        chatId: numericId(chatId),
        extra,
        files,
      });
      if (!sent) {
        this.preparedFiles.delete(extra);
        return false;
      }
    } catch (error) {
      this.preparedFiles.delete(extra);
      throw error;
    }
    return true;
  }

  async requestPreparedProfilePhoto() {
    const extra = crypto.randomUUID();
    const response = this.waitForResponse(extra, "更新头像请求超时。");
    try {
      const selected = await this.invokeCommand("telegram_pick_profile_photo", { extra });
      if (!selected) {
        this.clear(extra);
        return false;
      }
    } catch (error) {
      this.reject(extra, error);
    }
    await response;
    return true;
  }

  settle(update: TdObject) {
    const extra = typeof update["@extra"] === "string" ? update["@extra"] : undefined;
    if (!extra) return false;
    const preparedFileError = this.preparedFiles.get(extra);
    if (preparedFileError) {
      this.preparedFiles.delete(extra);
      if (update["@type"] === "error") preparedFileError(this.responseError(update));
      return true;
    }
    const pending = this.pending.get(extra);
    if (!pending) return false;
    globalThis.clearTimeout(pending.timer);
    this.pending.delete(extra);
    if (update["@type"] === "error") {
      pending.reject(this.responseError(update));
    } else {
      pending.resolve(update);
    }
    return true;
  }

  rejectAll(error: Error) {
    for (const [extra, pending] of this.pending) {
      globalThis.clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(extra);
    }
    for (const [extra, report] of this.preparedFiles) {
      report(error);
      this.preparedFiles.delete(extra);
    }
  }

  private waitForResponse(extra: string, timeoutMessage: string) {
    return new Promise<TdObject>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(extra);
        reject(new Error(timeoutMessage));
      }, 30_000);
      this.pending.set(extra, { resolve, reject, timer });
    });
  }

  private clear(extra: string) {
    const pending = this.pending.get(extra);
    if (pending) globalThis.clearTimeout(pending.timer);
    this.pending.delete(extra);
  }

  private reject(extra: string, error: unknown) {
    const pending = this.pending.get(extra);
    if (!pending) return;
    globalThis.clearTimeout(pending.timer);
    this.pending.delete(extra);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private responseError(update: TdObject) {
    const code = tdNumber(update.code);
    const suffix = code === undefined ? "" : ` (${code})`;
    return new Error(`${String(update.message ?? "TDLib 请求失败")}${suffix}`);
  }
}
