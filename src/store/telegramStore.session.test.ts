import { describe, expect, it, vi } from "vitest";
import {
  createSessionController,
  type SessionControllerOptions,
} from "./telegramStore.session";
import type { TelegramState } from "./telegramStore.types";

const createHarness = () => {
  let operationError: string | undefined;
  const set = ((patch: Partial<TelegramState>) => {
    operationError = patch.operationError;
  }) as SessionControllerOptions["set"];
  const transport = {
    getActiveSessions: vi.fn(),
    terminateSession: vi.fn(),
    terminateAllOtherSessions: vi.fn(),
    getPrivacySettingRules: vi.fn(),
    setPrivacySettingRules: vi.fn(),
  } as unknown as SessionControllerOptions["transport"];
  const controller = createSessionController({
    transport,
    set,
    onError: (error, fallback) => error instanceof Error ? error.message : fallback,
  });
  return { controller, transport, getError: () => operationError };
};

describe("telegram store session controller", () => {
  it("returns session data and clears an old operation error after termination", async () => {
    const harness = createHarness();
    vi.mocked(harness.transport.getActiveSessions).mockResolvedValue([]);
    vi.mocked(harness.transport.terminateSession).mockResolvedValue(undefined);

    await expect(harness.controller.getActiveSessions()).resolves.toEqual([]);
    await expect(harness.controller.terminateSession("session-1")).resolves.toBe(true);
    expect(harness.getError()).toBeUndefined();
  });

  it("converts privacy transport failures into the store error contract", async () => {
    const harness = createHarness();
    vi.mocked(harness.transport.getPrivacySettingRules).mockRejectedValue(new Error("privacy failed"));

    await expect(harness.controller.getPrivacySettingRules("showStatus")).resolves.toEqual([]);
    expect(harness.getError()).toBe("privacy failed");
  });
});
