import { describe, expect, it } from "vitest";
import type { OutgoingAttachment } from "../telegram/types";
import {
  AttachmentOutboxStore,
  describeOutgoingAttachments,
} from "./attachmentOutbox";

describe("attachment outbox", () => {
  it("restores native attachment metadata and verifies the persisted fingerprint", async () => {
    const id = `test-${crypto.randomUUID()}`;
    const store = new AttachmentOutboxStore();
    const attachment: OutgoingAttachment = {
      file: new File(["audio bytes"], "episode.m4a", {
        type: "audio/mp4",
        lastModified: 1_775_000_000_000,
      }),
      kind: "audio",
      duration: 42,
      title: "Episode",
      performer: "Notgram",
    };
    const metadata = await describeOutgoingAttachments(id, [attachment]);

    await store.put({
      id,
      createdAt: new Date().toISOString(),
      attachments: [attachment],
      metadata,
    });
    const restored = await store.get(id);

    expect(metadata[0].fingerprint).toHaveLength(64);
    expect(restored?.metadata).toEqual(metadata);
    expect(restored?.attachments).toMatchObject([{
      kind: "audio",
      duration: 42,
      title: "Episode",
      performer: "Notgram",
      file: { name: "episode.m4a", size: 11, type: "audio/mp4" },
    }]);

    await store.remove(id);
    await expect(store.get(id)).resolves.toBeUndefined();
  });
});
