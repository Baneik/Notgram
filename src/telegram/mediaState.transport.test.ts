import { afterEach, expect, it, vi } from "vitest";
import { TauriTelegramTransport } from "./tauriTransport";
import { TdRequestBroker } from "./tdRequestBroker";
import type { TdObject } from "./tdlibMapper";
import type { TelegramEvent } from "./types";

afterEach(() => vi.unstubAllGlobals());

it("projects native transfer intent into both message and file updates", () => {
  const transport = new TauriTelegramTransport();
  const events: TelegramEvent[] = [];
  const internal = transport as unknown as {
    listener: (event: TelegramEvent) => void;
    emitMessage: (raw: TdObject) => void;
    handleUpdateBatch: (updates: TdObject[]) => void;
  };
  internal.listener = event => events.push(event);
  const file = { ...photo(true), notgram_download_requested: false };
  internal.emitMessage(message(file));
  const lastMessage = () => events.filter(event => event.type === "message.upsert").at(-1);
  expect(lastMessage()).toMatchObject({ message: { content: { isDownloading: false } } });
  for (const requested of [true, false]) {
    internal.handleUpdateBatch([{ "@type": "updateFile", file: { ...file, notgram_download_requested: requested } }]);
    expect(lastMessage()).toMatchObject({ message: { content: { isDownloading: requested } } });
    expect(events.filter(event => event.type === "file.updated").at(-1)).toMatchObject({ file: { isDownloading: requested } });
  }
});

it.each([
  "Downloaded file is outside the active TDLib files directory",
  "This message cannot be saved or has expired",
  "Unable to reserve downloaded file: access denied",
])("preserves a concrete native saving failure: %s", async error => {
  const invoke = vi.fn(async () => { throw error; });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  const transport = new TauriTelegramTransport();
  (transport as unknown as { request: () => Promise<TdObject> }).request = async () => photo(false);
  await expect(transport.downloadFile(91, "photo.jpg")).rejects.toThrow(error);
});

const photo = (active: boolean): TdObject => ({
  "@type": "file", id: 91, size: 4096,
  local: { can_be_downloaded: true, is_downloading_active: active, is_downloading_completed: !active, path: active ? "" : "C:/cache/photo.jpg" },
  remote: {},
});
const message = (file: TdObject): TdObject => ({
  "@type": "message", id: 1, chat_id: 7, date: 1_700_000_000,
  sender_id: { "@type": "messageSenderUser", user_id: 11 },
  content: { "@type": "messagePhoto", photo: { sizes: [{ width: 800, height: 600, photo: file }] } },
});

it.each([false, true])("keeps file completion after batched history hydration (known message: %s)", async known => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as {
    requestBroker: TdRequestBroker;
    handleUpdateBatch: (updates: TdObject[]) => void;
    emitMessage: (raw: TdObject) => void;
  };
  let request: TdObject | undefined;
  internal.requestBroker = new TdRequestBroker(async (_command, args) => { request = args?.request as TdObject; });
  const raw = message(photo(true));
  if (known) internal.emitMessage(raw);
  const pending = transport.loadChatHistory("7", 1);
  expect(request?.["@type"]).toBe("getChatHistory");
  internal.handleUpdateBatch([
    { "@type": "messages", "@extra": request?.["@extra"], messages: [raw] },
    { "@type": "updateFile", file: photo(false) },
  ]);
  const page = await pending;
  expect(page.messages?.[0].content).toMatchObject({ isDownloaded: true, isDownloading: false, localPath: "C:/cache/photo.jpg" });
});
