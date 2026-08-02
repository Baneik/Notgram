import { invoke } from "@tauri-apps/api/core";
import { tdNumber, type TdObject } from "./tdlibMapper";
import { numericId } from "./tdlibRequests";

type PendingRequest = {
  resolve: (value: TdObject) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof globalThis.setTimeout>;
};

export class TdRequestBroker {
  private pending = new Map<string, PendingRequest>();

  async request(request: TdObject) {
    const requestType = typeof request["@type"] === "string" ? request["@type"] : "unknown";
    const extra = crypto.randomUUID();
    const response = this.waitForResponse(extra, `TDLib ${requestType} 请求超时。`);
    try {
      await invoke("telegram_send", { request: { ...request, "@extra": extra } });
    } catch (error) {
      this.reject(extra, error);
    }
    return response;
  }

  async requestPreparedFile(chatId: string) {
    const extra = crypto.randomUUID();
    const response = this.waitForResponse(extra, "TDLib 文件发送请求超时。");
    try {
      const selected = await invoke<boolean>("telegram_pick_and_send_file", {
        chatId: numericId(chatId),
        extra,
      });
      if (!selected) {
        this.clear(extra);
        return undefined;
      }
    } catch (error) {
      this.reject(extra, error);
    }
    return response;
  }

  settle(update: TdObject) {
    const extra = typeof update["@extra"] === "string" ? update["@extra"] : undefined;
    if (!extra) return false;
    const pending = this.pending.get(extra);
    if (!pending) return false;
    globalThis.clearTimeout(pending.timer);
    this.pending.delete(extra);
    if (update["@type"] === "error") {
      const code = tdNumber(update.code);
      const suffix = code === undefined ? "" : ` (${code})`;
      pending.reject(new Error(`${String(update.message ?? "TDLib 请求失败")}${suffix}`));
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
}
