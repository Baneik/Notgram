import { expect, it, vi } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import { MediaFileRestorer } from "./mediaFileRestorer";
import type { Message, MessageFileState } from "../telegram/types";

it("bounds concurrent lookups, deduplicates shared media, and retries failures on reconnect", async () => {
  const messages: Message[] = Array.from({ length: 8 }, (_, id) => ({ ...mockSnapshot.messages[0], id: String(id),
    isLocallyDeleted: true, content: { kind: "media", mediaType: "photo", fileName: "photo.jpg", sizeLabel: "4 KB",
      remoteId: `remote-${id % 6}`, thumbnailRemoteId: `remote-${id % 6}` } }));
  const pending = new Map<string, (file: MessageFileState | undefined) => void>();
  const resolveFile = vi.fn((remoteId: string) => new Promise<MessageFileState | undefined>(resolve => pending.set(remoteId, resolve)));
  const applyFile = vi.fn();
  const restorer = new MediaFileRestorer({ canRestore: () => true, messages: () => messages, resolveFile, applyFile });
  const first = restorer.restore();
  expect(restorer.restore()).toBe(first);
  expect(resolveFile).toHaveBeenCalledTimes(4);
  for (const finish of [...pending.values()]) finish(undefined);
  await vi.waitFor(() => expect(resolveFile).toHaveBeenCalledTimes(6));
  pending.get("remote-4")!(undefined);
  pending.get("remote-5")!(undefined);
  await first;
  expect(applyFile).not.toHaveBeenCalled();
  resolveFile.mockImplementation(async () => undefined);
  await restorer.restore();
  expect(resolveFile).toHaveBeenCalledTimes(12);
});

it("picks up a newly selected conversation while an earlier batch is still running", async () => {
  let messages: Message[] = [{ ...mockSnapshot.messages[0], content: {
    kind: "file", fileName: "first", sizeLabel: "1 KB", remoteId: "first",
  } }];
  let finish!: (file: MessageFileState | undefined) => void;
  const resolveFile = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue(undefined);
  const restorer = new MediaFileRestorer({ canRestore: () => true, messages: () => messages, resolveFile, applyFile: vi.fn() });
  const pending = restorer.restore();
  messages = [{ ...messages[0], content: { kind: "file", fileName: "second", sizeLabel: "1 KB", remoteId: "second" } }];
  expect(restorer.restore()).toBe(pending);
  finish(undefined);
  await pending;
  expect(resolveFile.mock.calls.map(args => args[0])).toEqual(["first", "second"]);
});

it("discards a late lookup after reset without clearing the new generation's operation", async () => {
  let finishOld!: (file: MessageFileState) => void;
  let finishNew!: (file: MessageFileState) => void;
  const resolveFile = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
  const applyFile = vi.fn();
  const restorer = new MediaFileRestorer({ canRestore: () => true, resolveFile, applyFile,
    messages: () => [{ ...mockSnapshot.messages[0], content: { kind: "file", fileName: "photo", sizeLabel: "1 KB", remoteId: "photo" } }],
  });
  const old = restorer.restore();
  restorer.reset();
  const current = restorer.restore();
  finishOld({ fileId: 1, sizeLabel: "1 KB" });
  await old;
  expect(applyFile).not.toHaveBeenCalled();
  expect(restorer.restore()).toBe(current);
  finishNew({ fileId: 2, sizeLabel: "1 KB" });
  await current;
  expect(applyFile).toHaveBeenCalledExactlyOnceWith("photo", { fileId: 2, sizeLabel: "1 KB" });
});
