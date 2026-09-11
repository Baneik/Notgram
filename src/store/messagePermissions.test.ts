import { describe, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { createTelegramStore } from "./telegramStore";
import type { ConnectionStatus, MessagePermissions } from "../telegram/types";

const permissions: MessagePermissions = { canReply: true, canEdit: true, canForward: true, canDeleteOnlyForSelf: false, canDeleteForAllUsers: true };

describe("message permission request ownership", () => {
  it.each(["offline", "recovering", "connecting", "waitingForNetwork", "proxyError"] satisfies ConnectionStatus[])(
    "does not query without a connection (%s), and can retry after recovery", async connectionStatus => {
      const transport = new MockTelegramTransport();
      const store = createTelegramStore(transport);
      await store.getState().initialize();
      const lookup = vi.spyOn(transport, "getMessageProperties").mockResolvedValue(permissions);
      store.setState({ connectionStatus });
      expect(await store.getState().loadMessageProperties("chat-product", "p-4", true)).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
      store.setState({ connectionStatus: "online" });
      expect(await store.getState().loadMessageProperties("chat-product", "p-4", true)).toEqual(permissions);
      transport.disconnect();
    },
  );

  it.each(["abort", "account"] as const)("ignores late results and errors after %s", async reason => {
    for (const fail of [false, true]) {
      const transport = new MockTelegramTransport();
      const store = createTelegramStore(transport);
      await store.getState().initialize();
      let resolve!: (value: MessagePermissions) => void;
      let reject!: (error: Error) => void;
      vi.spyOn(transport, "getMessageProperties").mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
      const controller = new AbortController();
      const pending = store.getState().loadMessageProperties("chat-product", "p-4", true, controller.signal);
      if (reason === "abort") controller.abort();
      else store.setState({ activeAccountId: "another-account" });
      store.setState({ operationError: "new operation" });
      if (fail) reject(new Error("late permission error"));
      else resolve(permissions);
      expect(await pending).toBeUndefined();
      expect(store.getState().messages.get("chat-product")!.find(message => message.id === "p-4")!.permissions).toBeUndefined();
      expect(store.getState().operationError).toBe("new operation");
      transport.disconnect();
    }
  });
});
