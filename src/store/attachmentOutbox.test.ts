import { describe, expect, it } from "vitest";
import type { OutgoingAttachment } from "../telegram/types";
import {
  AttachmentOutboxStore,
  describeOutgoingAttachments,
} from "./attachmentOutbox";

describe("attachment outbox", () => {
  it("isolates account-owned batches and removes only the logged-out account", async () => {
    const store = new AttachmentOutboxStore();
    const attachments: OutgoingAttachment[] = [{ file: new File(["unsent"], "draft.txt"), kind: "document" }];
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    for (const [accountId, id] of [["a", a], ["b", b]]) {
      await store.put({ accountId, id, persistent: true, createdAt: new Date().toISOString(), attachments,
        metadata: await describeOutgoingAttachments(id, attachments) });
    }
    expect(await store.get(a, "b")).toBeUndefined();
    await store.removeAccount("a");
    expect(await store.get(a, "a")).toBeUndefined();
    expect(await store.get(b, "b")).toBeDefined();
    await store.removeAccount("b");
  });
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
