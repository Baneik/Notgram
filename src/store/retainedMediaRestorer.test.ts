import { expect, it, vi } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import { RetainedMediaRestorer } from "./retainedMediaRestorer";
import type { Message, MessageFileState } from "../telegram/types";

it("bounds concurrent lookups, deduplicates shared media, and retries failures on reconnect", async () => {
  const messages: Message[] = Array.from({ length: 8 }, (_, id) => ({ ...mockSnapshot.messages[0], id: String(id),
    isLocallyDeleted: true, content: { kind: "media", mediaType: "photo", fileName: "photo.jpg", sizeLabel: "4 KB",
      remoteId: `remote-${id % 6}`, thumbnailRemoteId: `remote-${id % 6}` } }));
  const pending = new Map<string, (file: MessageFileState | undefined) => void>();
  const resolveFile = vi.fn((remoteId: string) => new Promise<MessageFileState | undefined>(resolve => pending.set(remoteId, resolve)));
  const applyFile = vi.fn();
  const restorer = new RetainedMediaRestorer({ canRestore: () => true, messages: () => messages, resolveFile, applyFile });
  const first = restorer.restore();
  expect(restorer.restore()).toBe(first);
  expect(resolveFile).toHaveBeenCalledTimes(4);
  for (const finish of [...pending.values()]) finish(undefined);
  await Promise.resolve();
  expect(resolveFile).toHaveBeenCalledTimes(6);
  pending.get("remote-4")!(undefined);
  pending.get("remote-5")!(undefined);
  await first;
  expect(applyFile).not.toHaveBeenCalled();
  resolveFile.mockImplementation(async () => undefined);
  await restorer.restore();
  expect(resolveFile).toHaveBeenCalledTimes(12);
});
