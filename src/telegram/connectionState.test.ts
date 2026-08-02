import { describe, expect, it } from "vitest";
import {
  connectionPresentation,
  mapTdConnectionStatus,
} from "./connectionState";
import type { ConnectionStatus } from "./types";

describe("connection state", () => {
  it.each([
    ["connectionStateWaitingForNetwork", "waitingForNetwork"],
    ["connectionStateConnectingToProxy", "connecting"],
    ["connectionStateConnecting", "connecting"],
    ["connectionStateUpdating", "syncing"],
    ["connectionStateReady", "online"],
  ] satisfies Array<[string, ConnectionStatus]>) (
    "maps TDLib %s to %s",
    (type, expected) => {
      expect(mapTdConnectionStatus({ "@type": type })).toBe(expected);
    },
  );

  it("ignores unknown or malformed states", () => {
    expect(mapTdConnectionStatus({ "@type": "connectionStateFuture" })).toBeUndefined();
    expect(mapTdConnectionStatus(null)).toBeUndefined();
  });

  it.each([
    "connecting",
    "syncing",
    "online",
    "waitingForNetwork",
    "proxyError",
    "offline",
  ] satisfies ConnectionStatus[])("provides user-facing metadata for %s", (status) => {
    const presentation = connectionPresentation(status);
    expect(presentation.label).not.toBe("");
    expect(presentation.compactLabel).not.toBe("");
  });
});
