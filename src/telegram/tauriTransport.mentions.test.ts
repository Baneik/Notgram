import { describe, expect, it, vi } from "vitest";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";
import type { CachedTelegramSnapshot, Message, MessageTextEntity } from "./types";

const entities: MessageTextEntity[] = [{ kind: "mentionName", offset: 0, length: 4, userId: "11" }];
const input = { chatId: "-1007", text: "@Mia hello", entities };
const source: Message = {
  id: "1048576", chatId: "-1007", senderId: "11", outgoing: false,
  sentAt: "2026-01-01T00:00:00Z", delivery: "read", content: { kind: "text", text: "hello" },
};
const error400 = (message = "User not found") => Object.assign(new Error(`${message} (400)`), { code: 400 });
type Internal = {
  request: (request: TdObject) => Promise<TdObject>;
  accountStorage: { loadCachedSnapshot: () => Promise<CachedTelegramSnapshot | undefined> };
  rawMessages: Map<string, Map<string, TdObject>>;
  rawUsers: Map<string, TdObject>;
  resetSessionState: () => void;
  requestPreparedPastedFiles: (...args: unknown[]) => Promise<boolean>;
  currentUserId?: string;
  mentionService: { prepare: (...args: unknown[]) => Promise<void> };
};

function fixture(initial: "missing" | "inaccessible" | "ready" = "missing") {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internal;
  let ready = initial === "ready";
  const request = vi.fn(async (request: TdObject): Promise<TdObject> => {
    switch (request["@type"]) {
      case "getUser":
        if (!ready && initial === "missing") throw error400();
        return { "@type": "user", id: 11, first_name: "Mia", have_access: ready };
      case "getMessage":
        ready = true;
        return { "@type": "message", id: 1048576, chat_id: -1007,
          sender_id: { "@type": "messageSenderUser", user_id: 11 } };
      default:
        // Model the native precondition, which ordinary transport mocks omit.
        if (!ready && ["sendMessage", "setChatDraftMessage", "editMessageText", "editMessageCaption"].includes(String(request["@type"])) &&
          !(request["@type"] === "setChatDraftMessage" && request.draft_message === null)) {
          throw error400();
        }
        return { "@type": "ok" };
    }
  });
  internal.request = request;
  internal.accountStorage.loadCachedSnapshot = vi.fn(async () => ({ messages: [source], users: [] }) as unknown as CachedTelegramSnapshot);
  return { transport, internal, request, setReady: () => { ready = true; } };
}

describe("native mention preparation", () => {
  it.each(["missing", "inaccessible"] as const)("recovers a cached author whose TDLib user is %s before sending", async (initial) => {
    const { transport, request } = fixture(initial);
    await expect(transport.sendMessage(input)).resolves.toBeUndefined();
    expect(request.mock.calls.map(([request]) => request["@type"])).toEqual(["getUser", "getMessage", "getUser", "sendMessage"]);
    expect(request).toHaveBeenCalledWith({ "@type": "getMessage", chat_id: -1007, message_id: 1048576 });
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ input_message_content: { text: {
      text: input.text, entities: [{ offset: 0, length: 4, type: { "@type": "textEntityTypeMentionName", user_id: 11 } }],
    } } });
  });

  it("prepares restored drafts and caption edits through the same native path", async () => {
    for (const action of ["draft", "edit"] as const) {
      const { transport, request } = fixture();
      if (action === "draft") await transport.setChatDraft(input);
      else await transport.editMessage({ ...input, messageId: "2097152", contentType: "caption" });
      expect(request.mock.calls.map(([request]) => request["@type"])).toEqual([
        "getUser", "getMessage", "getUser", action === "draft" ? "setChatDraftMessage" : "editMessageCaption",
      ]);
    }
  });

  it("does not read the snapshot or load messages for an already accessible user", async () => {
    const { transport, internal, request } = fixture("ready");
    await transport.sendMessage(input);
    expect(request.mock.calls.map(([request]) => request["@type"])).toEqual(["getUser", "sendMessage"]);
    expect(internal.accountStorage.loadCachedSnapshot).not.toHaveBeenCalled();
  });

  it("uses loaded message sources without reading or publishing the snapshot", async () => {
    const { transport, internal, request } = fixture("inaccessible");
    internal.rawMessages.set(source.chatId, new Map([[source.id, {
      "@type": "message", chat_id: -1007, id: 1048576, sender_id: { "@type": "messageSenderUser", user_id: 11 },
    }]]));
    await transport.sendMessage(input);
    expect(internal.accountStorage.loadCachedSnapshot).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([request]) => request["@type"])).toEqual(["getUser", "getMessage", "getUser", "sendMessage"]);
    expect(internal.rawMessages.get(source.chatId)?.size).toBe(1);
  });

  it("prepares attachment captions before the native upload bridge", async () => {
    const { transport, internal, request } = fixture();
    internal.requestPreparedPastedFiles = vi.fn(async (_chat, _files, caption, captionEntities) => {
      expect(request.mock.calls.map(([request]) => request["@type"])).toEqual(["getUser", "getMessage", "getUser"]);
      expect(caption).toBe(input.text);
      expect(captionEntities).toEqual(entities);
      return true;
    });
    await expect(transport.sendFiles({ chatId: input.chatId, caption: input.text, captionEntities: entities,
      attachments: [{ kind: "document", file: new File(["test"], "test.txt", { type: "text/plain" }) }],
    })).resolves.toBe(true);
    expect(internal.requestPreparedPastedFiles).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous draft and message lookups without losing either operation", async () => {
    const { transport, request } = fixture();
    await Promise.all([transport.sendMessage(input), transport.setChatDraft(input)]);
    expect(request.mock.calls.filter(([value]) => value["@type"] === "getMessage")).toHaveLength(1);
    expect(request.mock.calls.filter(([value]) => value["@type"] === "sendMessage")).toHaveLength(1);
    expect(request.mock.calls.filter(([value]) => value["@type"] === "setChatDraftMessage")).toHaveLength(1);
  });

  it.each([false, true])("a cleared draft wins over a late lookup (failure=%s)", async (fails) => {
    const { transport, request } = fixture();
    let finish!: (value: TdObject) => void;
    let reject!: (error: Error) => void;
    request.mockImplementationOnce(() => new Promise<TdObject>((resolve, fail) => { finish = resolve; reject = fail; }));
    const saving = transport.setChatDraft(input);
    await transport.setChatDraft({ chatId: input.chatId, text: "" });
    if (fails) reject(new Error("Connection lost"));
    else finish({ "@type": "user", id: 11, have_access: true });
    await expect(saving).resolves.toBeUndefined();
    const drafts = request.mock.calls.filter(([value]) => value["@type"] === "setChatDraftMessage");
    expect(drafts).toHaveLength(1);
    expect(drafts[0][0].draft_message).toBeNull();
  });

  it.each([false, true])("cancels across account changes, including failed lookups (failure=%s)", async (fails) => {
    const { transport, internal, request } = fixture();
    let finish!: (value: TdObject) => void;
    let reject!: (error: Error) => void;
    request.mockImplementationOnce(() => new Promise<TdObject>((resolve, fail) => { finish = resolve; reject = fail; }));
    const sending = transport.sendMessage(input);
    internal.resetSessionState();
    if (fails) reject(error400());
    else finish({ "@type": "user", id: 11, have_access: true });
    await expect(sending).rejects.toThrow("发送已取消");
    expect(request).toHaveBeenCalledTimes(1);
    expect(internal.accountStorage.loadCachedSnapshot).not.toHaveBeenCalled();
  });

  it("does not drop an unresolved mention or change its user ID", async () => {
    const { transport, internal, request } = fixture();
    internal.accountStorage.loadCachedSnapshot = vi.fn(async () => undefined);
    await expect(transport.sendMessage(input)).rejects.toThrow("User not found (400)");
    expect(request).toHaveBeenCalledTimes(1);
    expect(input.entities).toEqual(entities);
  });

  it("keeps transient lookup failures retryable without searching or sending", async () => {
    const { transport, internal, request } = fixture();
    request.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(transport.sendMessage(input)).rejects.toThrow("Connection lost");
    expect(internal.accountStorage.loadCachedSnapshot).not.toHaveBeenCalled();
    await expect(transport.sendMessage(input)).resolves.toBeUndefined();
  });

  it.each([11, 22])("resolves a public username only if it still belongs to the original user (%s)", async (resolvedId) => {
    const { transport, internal, request, setReady } = fixture();
    internal.accountStorage.loadCachedSnapshot = vi.fn(async () => ({ messages: [], users: [{ id: "11", username: "mia_user" }] }) as unknown as CachedTelegramSnapshot);
    const nativeRequest = request.getMockImplementation()!;
    request.mockImplementation(async (value) => {
      if (value["@type"] === "searchPublicChat") {
        if (resolvedId === 11) setReady();
        return { "@type": "chat", id: resolvedId, type: { "@type": "chatTypePrivate", user_id: resolvedId } };
      }
      return nativeRequest(value);
    });
    if (resolvedId === 11) await expect(transport.sendMessage(input)).resolves.toBeUndefined();
    else await expect(transport.sendMessage(input)).rejects.toThrow("User not found");
    expect(request).toHaveBeenCalledWith({ "@type": "searchPublicChat", username: "mia_user" });
    const sent = request.mock.calls.filter(([value]) => value["@type"] === "sendMessage");
    expect(sent).toHaveLength(resolvedId === 11 ? 1 : 0);
  });

  it("ignores snapshots from a different account", async () => {
    const { transport, internal, request } = fixture();
    internal.currentUserId = "123";
    internal.accountStorage.loadCachedSnapshot = vi.fn(async () => ({ currentUserId: "456", messages: [source], users: [] }) as unknown as CachedTelegramSnapshot);
    await expect(transport.sendMessage(input)).rejects.toThrow("User not found");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("skips deleted sources and bounds unavailable message recovery", async () => {
    const { transport, internal, request } = fixture();
    internal.accountStorage.loadCachedSnapshot = vi.fn(async () => ({ users: [], messages: [
      ...Array.from({ length: 6 }, (_, index) => ({ ...source, id: String(1048576 * (index + 1)) })),
      { ...source, id: "99999999", isLocallyDeleted: true },
    ] }) as unknown as CachedTelegramSnapshot);
    const nativeRequest = request.getMockImplementation()!;
    request.mockImplementation(async (value) => {
      if (value["@type"] === "getMessage") throw Object.assign(new Error("Message not found (404)"), { code: 404 });
      return nativeRequest(value);
    });
    await expect(transport.sendMessage(input)).rejects.toThrow("User not found");
    const loaded = request.mock.calls.filter(([value]) => value["@type"] === "getMessage");
    expect(loaded).toHaveLength(3);
    expect(loaded.map(([value]) => value.message_id)).toEqual([6291456, 5242880, 4194304]);
  });

  it("does not introduce user lookups for plain text, usernames or invalid entities", async () => {
    const { transport, request } = fixture("ready");
    await transport.sendMessage({ ...input, entities: [{ kind: "mention", offset: 0, length: 4 },
      { kind: "mentionName", offset: 0, length: 4, userId: "invalid" },
      { ...entities[0], offset: 999 },
    ] });
    expect(request.mock.calls.map(([request]) => request["@type"])).toEqual(["sendMessage"]);
  });

  it("checks account ownership again before committing a prepared draft", async () => {
    const { transport, internal, request } = fixture("ready");
    internal.mentionService.prepare = async () => {
      queueMicrotask(() => internal.resetSessionState());
    };
    await expect(transport.setChatDraft(input)).rejects.toThrow("发送已取消");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps draft ordering independent for different forum topics", async () => {
    const { transport, request } = fixture();
    await Promise.all([transport.setChatDraft({ ...input, topicId: "18" }), transport.setChatDraft({ ...input, topicId: "19" })]);
    const drafts = request.mock.calls.filter(([value]) => value["@type"] === "setChatDraftMessage");
    expect(drafts.map(([value]) => value.topic_id)).toEqual([
      { "@type": "messageTopicForum", forum_topic_id: 18 }, { "@type": "messageTopicForum", forum_topic_id: 19 },
    ]);
  });

  it("recovers from a stale source using the next known author message", async () => {
    const { transport, internal, request } = fixture();
    internal.accountStorage.loadCachedSnapshot = vi.fn(async () => ({ users: [], messages: [source, { ...source, id: "2097152" }] }) as unknown as CachedTelegramSnapshot);
    const nativeRequest = request.getMockImplementation()!;
    request.mockImplementation(async (value) => {
      if (value["@type"] === "getMessage" && value.message_id === 2097152) throw Object.assign(new Error("Message not found (404)"), { code: 404 });
      return nativeRequest(value);
    });
    await expect(transport.sendMessage(input)).resolves.toBeUndefined();
    expect(request.mock.calls.filter(([value]) => value["@type"] === "getMessage").map(([value]) => value.message_id)).toEqual([2097152, 1048576]);
  });

  it("prepares retained media captions without changing their mention entities", async () => {
    const { transport, request } = fixture();
    await transport.sendMediaCopy({ chatId: input.chatId, content: {
      kind: "file", fileId: 91, fileName: "test.txt", sizeLabel: "4 B", caption: input.text, captionEntities: entities,
    } });
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ "@type": "sendMessage", input_message_content: { caption: {
      text: input.text, entities: [{ type: { "@type": "textEntityTypeMentionName", user_id: 11 } }],
    } } });
  });
});
