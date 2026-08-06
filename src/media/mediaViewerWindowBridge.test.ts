import { describe, expect, it } from "vitest";
import {
  createMediaViewerWindowId,
  mediaViewerWindowRoute,
} from "./mediaViewerWindowBridge";

describe("media viewer window routing", () => {
  it("creates identifiers accepted by the native window label validator", () => {
    const id = createMediaViewerWindowId();
    expect(id).toMatch(/^[a-zA-Z0-9]+$/);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("routes descriptors to the standalone media viewer entry", () => {
    expect(mediaViewerWindowRoute("viewer123")).toBe("/?mediaViewerWindow=viewer123");
  });
});
