import { describe, expect, it } from "vitest";
import { MockTelegramTransport } from "./mockTransport";

describe("device sessions and privacy", () => {
  it("terminates other devices and persists privacy rules", async () => {
    const transport = new MockTelegramTransport();
    expect((await transport.getActiveSessions()).filter((session) => !session.isCurrent)).toHaveLength(1);
    await transport.terminateSession("session-phone");
    expect((await transport.getActiveSessions()).filter((session) => !session.isCurrent)).toHaveLength(0);
    await transport.setPrivacySettingRules("showPhoneNumber", [{ kind: "allowContacts" }]);
    expect(await transport.getPrivacySettingRules("showPhoneNumber")).toEqual([{ kind: "allowContacts" }]);
  });
});
