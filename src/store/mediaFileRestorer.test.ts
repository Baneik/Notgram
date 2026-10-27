import { expect, it, vi } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import { MediaFileRestorer } from "./mediaFileRestorer";
import { messageFiles, bindMessageFile } from "../telegram/messageFileState";
import { TdSessionSupersededError } from "../telegram/tdSession";
import type { Message, MessageFileState } from "../telegram/types";

const message = (id: string, chatId = "active", archive = false): Message => ({ ...mockSnapshot.messages[0], id, chatId,
  isLocallyDeleted: archive, content: { kind: "file", fileName: id, sizeLabel: "1 KB", remoteId: id },
});
const file = (id: string): MessageFileState => ({ fileId: 100 + Number(id.match(/\d+/)?.[0] ?? 1), remoteId: id, sizeLabel: "1 KB" });
const harness = (initial: Message[]) => {
  const messages = new Map(initial.map(item => [`${item.chatId}:${item.id}`, item]));
  const resolveFile = vi.fn(async (_remoteId: string): Promise<MessageFileState | undefined> => undefined);
  const refreshMessage = vi.fn(async (_message: Message) => undefined);
  const applyFiles = vi.fn(async (files: ReadonlyMap<string, MessageFileState>, isCurrent: () => boolean) => {
    if (!isCurrent()) return;
    for (const [key, current] of messages) {
      let next = current;
      for (const [id, state] of files) next = bindMessageFile(next, id, state);
      messages.set(key, next);
    }
  });
  let online = true;
  const restorer = new MediaFileRestorer({ canRestore: () => online, resolveFile, applyFiles, refreshMessage,
    currentMessage: (chatId, id) => messages.get(`${chatId}:${id}`),
    sources: id => [...messages.values()].filter(item => messageFiles(item).some(content => content.remoteId === id)),
    yield: async () => undefined,
  });
  return { messages, resolveFile, applyFiles, refreshMessage, restorer, setOnline: (value: boolean) => { online = value; } };
};

it("bounds concurrent lookups, shares identities, and retries failures only on reconnect", async () => {
  const items = Array.from({ length: 8 }, (_, id) => ({ ...message(`remote-${id % 6}`, "archive", true), id: String(id) }));
  const { restorer, resolveFile } = harness(items);
  const pending = new Map<string, (file: MessageFileState | undefined) => void>();
  resolveFile.mockImplementation(id => new Promise(resolve => pending.set(id, resolve)));
  const first = restorer.enqueue(items);
  expect(restorer.restore()).toBe(first);
  await vi.waitFor(() => expect(resolveFile).toHaveBeenCalledTimes(4));
  for (const finish of [...pending.values()]) finish(undefined);
  await vi.waitFor(() => expect(resolveFile).toHaveBeenCalledTimes(6));
  pending.get("remote-4")!(undefined);
  pending.get("remote-5")!(undefined);
  await first;
  await restorer.enqueue(items);
  expect(resolveFile).toHaveBeenCalledTimes(6);
  restorer.retry();
  resolveFile.mockResolvedValue(undefined);
  await restorer.enqueue(items);
  expect(resolveFile).toHaveBeenCalledTimes(12);
});

it("promotes a new chat before the old archive queue drains and still advances background work", async () => {
  const background = Array.from({ length: 20 }, (_, id) => message(`archive-${id}`, "archive", true));
  const foreground = Array.from({ length: 8 }, (_, id) => message(`visible-${id}`, "selected"));
  const { restorer, resolveFile } = harness([...background, ...foreground]);
  const pending = new Map<string, (file: MessageFileState | undefined) => void>();
  resolveFile.mockImplementation(id => new Promise(resolve => pending.set(id, resolve)));
  const running = restorer.enqueue(background);
  await vi.waitFor(() => expect(resolveFile).toHaveBeenCalledTimes(4));
  expect(restorer.focus("selected", foreground)).toBe(running);
  for (const finish of [...pending.values()]) finish(undefined);
  await vi.waitFor(() => expect(resolveFile).toHaveBeenCalledTimes(8));
  expect(resolveFile.mock.calls.slice(4, 7).map(args => args[0])).toEqual(["visible-0", "visible-1", "visible-2"]);
  expect(resolveFile.mock.calls[7][0]).toBe("archive-4");
  resolveFile.mockImplementation(async id => file(id));
  for (const finish of [...pending.values()]) finish(undefined);
  await running;
  expect(new Set(resolveFile.mock.calls.map(args => args[0])).size).toBe(28);
});

it("retries failed references in a previously visited chat after reconnect without re-scanning it", async () => {
  const item = message("photo-1");
  const missing = { ...message("missing"), content: { kind: "file" as const, fileName: "missing", sizeLabel: "1 KB" } };
  const { restorer, resolveFile, refreshMessage, messages } = harness([item, missing]);
  await restorer.focus("active", [item, missing]);
  expect(resolveFile).toHaveBeenCalledTimes(1);
  expect(refreshMessage).toHaveBeenCalledTimes(2);
  await restorer.focus("other", []);
  resolveFile.mockImplementation(async id => file(id));
  restorer.retry();
  await restorer.restore();
  expect(resolveFile).toHaveBeenCalledTimes(2);
  expect(refreshMessage).toHaveBeenCalledTimes(3);
  expect(messages.get("active:photo-1")?.content).toMatchObject({ fileId: file(item.id).fileId });
});

it("discards a late result after reset without clearing the new generation's work or refreshing old sources", async () => {
  const item = message("photo-1");
  const { restorer, resolveFile, applyFiles, refreshMessage } = harness([item]);
  let finishOld!: (file: MessageFileState) => void;
  let finishNew!: (file: MessageFileState) => void;
  resolveFile.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
  const old = restorer.focus("active", [item]);
  await vi.waitFor(() => expect(finishOld).toBeTypeOf("function"));
  restorer.reset();
  const current = restorer.focus("active", [item]);
  await vi.waitFor(() => expect(finishNew).toBeTypeOf("function"));
  finishOld(file(item.id));
  await old;
  expect(applyFiles).not.toHaveBeenCalled();
  expect(refreshMessage).not.toHaveBeenCalled();
  expect(restorer.restore()).toBe(current);
  finishNew(file(item.id));
  await current;
  expect(applyFiles).toHaveBeenCalledTimes(1);
});

it("does not refresh messages for a superseded runtime", async () => {
  const item = message("photo-1");
  const { restorer, resolveFile, refreshMessage } = harness([item]);
  resolveFile.mockRejectedValue(new TdSessionSupersededError());
  await restorer.focus("active", [item]);
  expect(refreshMessage).not.toHaveBeenCalled();
});

it("preserves in-flight work across an offline interval without duplicating it on reconnect", async () => {
  const item = message("photo-1");
  const { restorer, resolveFile, messages, applyFiles, setOnline } = harness([item]);
  let finish!: (file: MessageFileState) => void;
  resolveFile.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const running = restorer.focus("active", [item]);
  await vi.waitFor(() => expect(resolveFile).toHaveBeenCalledTimes(1));
  setOnline(false);
  finish(file(item.id));
  await Promise.resolve();
  await Promise.resolve();
  expect(applyFiles).not.toHaveBeenCalled();
  setOnline(true);
  expect(restorer.restore()).toBe(running);
  await running;
  expect(resolveFile).toHaveBeenCalledTimes(1);
  expect(messages.get("active:photo-1")?.content).toMatchObject({ fileId: file(item.id).fileId });
});

it("reuses successful bindings for newly discovered references and never re-scans archives on focus", async () => {
  const item = message("photo-1", "archive", true);
  const { restorer, resolveFile, messages } = harness([item]);
  resolveFile.mockImplementation(async id => file(id));
  await restorer.enqueue([item]);
  const other = { ...message(item.id, "other"), id: "second-reference" };
  messages.set("other:second-reference", other);
  await restorer.focus("other", [other]);
  await restorer.focus("archive", [item]);
  await restorer.focus("other", { [Symbol.iterator]: () => { throw new Error("Repeated selection must not scan"); } });
  expect(resolveFile).toHaveBeenCalledTimes(1);
  expect(messages.get("other:second-reference")?.content).toMatchObject({ fileId: file(item.id).fileId });
});

it("yields during discovery before launching work and retains all necessary identities", async () => {
  const items = Array.from({ length: 300 }, (_, id) => message(`archive-${id}`, "archive", true));
  const { messages, resolveFile } = harness(items);
  resolveFile.mockImplementation(async id => file(id));
  let yields = 0;
  let examined = 0;
  let largestSlice = 0;
  const restorer = new MediaFileRestorer({ canRestore: () => true, resolveFile,
    currentMessage: (chatId, id) => { examined++; return messages.get(`${chatId}:${id}`); },
    sources: id => [messages.get(`archive:${id}`)!], applyFiles: async () => undefined,
    yield: async () => { yields++; largestSlice = Math.max(largestSlice, examined); examined = 0; },
  });
  const running = restorer.enqueue(items);
  expect(resolveFile).not.toHaveBeenCalled();
  await running;
  expect(resolveFile).toHaveBeenCalledTimes(300);
  expect(yields).toBeGreaterThan(4);
  expect(largestSlice).toBeLessThanOrEqual(64);
});
