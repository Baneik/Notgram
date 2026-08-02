import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramTransport } from "./createTransport";

const accountStateKey = "notgram:accounts:v1";

describe("Telegram transport factory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("starts authorization for an active account slot that is not registered yet", async () => {
    vi.stubEnv("VITE_TELEGRAM_TRANSPORT", "mock");
    const values = new Map<string, string>([
      [
        accountStateKey,
        JSON.stringify({
          activeAccountId: "account-unfinished",
          accounts: [{
            id: "default",
            userId: "self",
            displayName: "林然",
            avatar: { label: "林", color: "#d16f45" },
          }],
        }),
      ],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });

    const transport = createTelegramTransport();
    const snapshot = await transport.connect(() => undefined);

    expect(transport.kind).toBe("mock");
    expect(snapshot.authorization).toEqual({ kind: "waitPhoneNumber" });
  });

  it("accepts a deterministic mock connection state from the browser query", async () => {
    vi.stubEnv("VITE_TELEGRAM_TRANSPORT", "mock");
    vi.stubGlobal("window", {
      location: { search: "?connection=waitingForNetwork" },
    });

    const transport = createTelegramTransport();
    let status: string | undefined;
    await transport.connect((event) => {
      if (event.type === "connection.changed") status = event.status;
    });

    expect(status).toBe("waitingForNetwork");
  });
});
