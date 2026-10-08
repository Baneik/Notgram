import { describe, expect, it } from "vitest";
import { isComposerImageSource } from "./composerDrop";

describe("composer image drop sources", () => {
  const origin = "http://tauri.localhost";
  it.each([
    "http://notgram-asset.localhost/authorized/photo.png",
    "notgram-asset://localhost/authorized/photo.png",
    "blob:http://tauri.localhost/test-image",
    "data:image/png;base64,aW1hZ2U=",
    "http://tauri.localhost/assets/photo.png",
  ])("accepts an existing application image source: %s", source => {
    expect(isComposerImageSource(source, origin)).toBe(true);
  });
  it.each([
    "file:///C:/private/photo.png", "http://notgram-asset.localhost.evil.test/photo.png",
    "https://external.test/photo.png", "http://notgram-asset.localhost:8888/photo.png",
    "blob:https://external.test/test-image", "data:text/html;base64,aW1hZ2U=",
    "data:image/svg+xml;base64,aW1hZ2U=", "javascript:alert(1)",
    "http://user@notgram-asset.localhost/photo.png", "notgram-asset://external.test/photo.png",
  ])("rejects files, remote origins and active content: %s", source => {
    expect(isComposerImageSource(source, origin)).toBe(false);
  });
});
