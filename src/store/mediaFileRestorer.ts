import type { Message, MessageFileState } from "../telegram/types";
import { matchesFileIdentity, messageFiles } from "../telegram/messageFileState";
import { yieldToBackground } from "../utils/yieldToBackground";
import { TdSessionSupersededError } from "../telegram/tdSession";

interface Context {
  canRestore: () => boolean;
  currentMessage: (chatId: string, messageId: string) => Message | undefined;
  sources: (remoteId: string) => Iterable<Message>;
  resolveFile: (remoteId: string) => Promise<MessageFileState | undefined>;
  applyFiles: (files: ReadonlyMap<string, MessageFileState>, isCurrent: () => boolean) => Promise<void>;
  refreshMessage?: (message: Message) => Promise<void>;
  yield?: () => Promise<void>;
}

type Task = { key: string; remoteId?: string; message?: Message; chats: Set<string> };
type Result = { task: Task; file?: MessageFileState };
const messageKey = (message: Message) => `${message.chatId}\u0000${message.id}`;
const BUDGET_MS = 2;

/** Discover changes once, share identity lookups, and reserve every fourth slot for background work. */
export class MediaFileRestorer {
  private generation = 0;
  private running?: Promise<void>;
  private wake?: () => void;
  private activeChatId?: string;
  private visited = new Set<string>();
  private discoveries: Iterator<Message>[] = [];
  private foregroundDiscovery?: Iterator<Message>;
  private tasks = new Map<string, Task>();
  private byChat = new Map<string, Map<string, Task>>();
  private attempted = new Map<string, MessageFileState | undefined>();
  private refreshed = new Set<string>();
  private foregroundSlots = 0;

  constructor(private readonly context: Context) {}

  reset() {
    this.generation++;
    this.running = undefined;
    this.wake?.();
    this.wake = undefined;
    this.activeChatId = undefined;
    this.visited.clear();
    this.discoveries = [];
    this.foregroundDiscovery = undefined;
    this.tasks.clear();
    this.byChat.clear();
    this.attempted.clear();
    this.refreshed.clear();
    this.foregroundSlots = 0;
  }

  enqueue(messages: Iterable<Message>) {
    this.discoveries.push(messages[Symbol.iterator]());
    return this.restore();
  }

  focus(chatId: string | undefined, messages: Iterable<Message>) {
    this.activeChatId = chatId;
    if (chatId && !this.visited.has(chatId)) {
      this.visited.add(chatId);
      // Preserve an unfinished discovery pass when another chat is selected.
      if (this.foregroundDiscovery) this.discoveries.unshift(this.foregroundDiscovery);
      this.foregroundDiscovery = messages[Symbol.iterator]();
    }
    return this.restore();
  }

  retry() {
    for (const [key, result] of this.attempted) if (!result) {
      this.attempted.delete(key);
      this.discoveries.push(this.context.sources(key)[Symbol.iterator]());
    }
    for (const key of this.refreshed) {
      const separator = key.indexOf("\u0000");
      const message = this.context.currentMessage(key.slice(0, separator), key.slice(separator + 1));
      if (message) this.discoveries.push([message][Symbol.iterator]());
    }
    this.refreshed.clear();
  }

  private addTask(key: string, message: Message, remoteId?: string) {
    const task = this.tasks.get(key) ?? { key, remoteId, message: remoteId ? undefined : message, chats: new Set<string>() };
    if (!remoteId) task.message = message;
    task.chats.add(message.chatId);
    this.tasks.set(key, task);
    const chat = this.byChat.get(message.chatId) ?? new Map<string, Task>();
    chat.set(key, task);
    this.byChat.set(message.chatId, chat);
  }

  private discover(message: Message, files: Map<string, MessageFileState>) {
    const current = this.context.currentMessage(message.chatId, message.id);
    if (!current || (!current.isLocallyDeleted && !this.visited.has(current.chatId))) return;
    for (const content of messageFiles(current)) {
      if (content.fileId === undefined && !content.remoteId && !content.localPath &&
        !current.isLocallyDeleted && !current.isPending && !this.refreshed.has(messageKey(current))) {
        this.addTask(`message:${messageKey(current)}`, current);
      }
      for (const [id, remoteId] of [[content.fileId, content.remoteId], [content.thumbnailFileId, content.thumbnailRemoteId]] as const) {
        if (id !== undefined || !remoteId) continue;
        if (this.attempted.has(remoteId)) {
          const file = this.attempted.get(remoteId);
          if (file) files.set(remoteId, file);
          else if (!current.isLocallyDeleted && !current.isPending && !this.refreshed.has(messageKey(current))) {
            this.addTask(`message:${messageKey(current)}`, current);
          }
        } else this.addTask(remoteId, current, remoteId);
      }
    }
  }

  private takeTask() {
    const foreground = this.byChat.get(this.activeChatId ?? "");
    let background: Task | undefined;
    for (const [chatId, tasks] of this.byChat) {
      if (chatId !== this.activeChatId) { background = tasks.values().next().value; break; }
    }
    const task = (this.foregroundSlots < 3 ? foreground?.values().next().value : undefined) ??
      background ?? foreground?.values().next().value;
    if (!task) return;
    this.foregroundSlots = foreground?.has(task.key) && this.foregroundSlots < 3 ? this.foregroundSlots + 1 : 0;
    this.tasks.delete(task.key);
    for (const chatId of task.chats) {
      const chat = this.byChat.get(chatId);
      chat?.delete(task.key);
      if (!chat?.size) this.byChat.delete(chatId);
    }
    return task;
  }

  restore() {
    this.wake?.();
    if (this.running) return this.running;
    if (!this.context.canRestore()) return Promise.resolve();
    const generation = this.generation;
    const sameRuntime = () => generation === this.generation;
    const isCurrent = () => generation === this.generation && this.context.canRestore();
    const yieldWork = this.context.yield ?? yieldToBackground;
    const run = async () => {
      const pending = new Map<string, Promise<void>>();
      const results: Result[] = [];
      const files = new Map<string, MessageFileState>();
      const validations: Array<{ remoteId: string; file?: MessageFileState; sources: Iterator<Message> }> = [];
      // Never scan saved archives in the synchronous conversation-selection path.
      await yieldWork();
      let workMs = 0;
      let workItems = 0;
      while (sameRuntime()) {
        if (!this.context.canRestore()) {
          // Keep in-flight results and partially applied bindings across an
          // offline interval. Reconnection wakes this same bounded operation.
          await new Promise<void>(resolve => { this.wake = resolve; });
          continue;
        }
        const started = performance.now();
        let count = 0;
        while ((this.foregroundDiscovery || this.discoveries.length) && count++ < 64 && performance.now() - started < BUDGET_MS) {
          const iterator = this.foregroundDiscovery ?? this.discoveries[0];
          const next = iterator.next();
          if (!next.done) this.discover(next.value, files);
          else if (iterator === this.foregroundDiscovery) this.foregroundDiscovery = undefined;
          else this.discoveries.shift();
        }
        for (const { task, file } of results.splice(0, 32)) {
          if (!task.remoteId) continue;
          if (file) files.set(task.remoteId, file);
          validations.push({ remoteId: task.remoteId, file, sources: this.context.sources(task.remoteId)[Symbol.iterator]() });
        }
        while (validations.length && count++ < 64 && performance.now() - started < BUDGET_MS) {
          const { remoteId, file, sources } = validations[0];
          const next = sources.next();
          if (next.done) { validations.shift(); continue; }
          const source = this.context.currentMessage(next.value.chatId, next.value.id);
          if (!source) continue;
          const contents = messageFiles(source);
          if (!contents.some(content => content.remoteId === remoteId && content.fileId === undefined ||
            content.thumbnailRemoteId === remoteId && content.thumbnailFileId === undefined)) continue;
          const matches = file && contents.some(content =>
            content.remoteId === remoteId && matchesFileIdentity(content.remoteId, content.remoteUniqueId, file) ||
            content.thumbnailRemoteId === remoteId && matchesFileIdentity(content.thumbnailRemoteId, content.thumbnailRemoteUniqueId, file));
          if (!matches && !source.isLocallyDeleted && !source.isPending && !this.refreshed.has(messageKey(source))) {
            this.addTask(`message:${messageKey(source)}`, source);
          }
        }
        if (files.size) await this.context.applyFiles(files, isCurrent);
        if (!isCurrent()) continue;
        files.clear();
        let dispatched = 0;
        while (pending.size < 4 && this.tasks.size && dispatched++ < 32 && performance.now() - started < BUDGET_MS) {
          const task = this.takeTask()!;
          if (pending.has(task.key)) continue;
          if (task.remoteId && this.attempted.has(task.remoteId)) continue;
          if (task.remoteId && this.context.sources(task.remoteId)[Symbol.iterator]().next().done) continue;
          const source = task.message && this.context.currentMessage(task.message.chatId, task.message.id);
          if (!task.remoteId && (!source || source !== task.message || source.isLocallyDeleted || source.isPending || this.refreshed.has(messageKey(source)))) continue;
          if (source) this.refreshed.add(messageKey(source));
          const operation = Promise.resolve().then(async () => {
            if (task.remoteId) return this.context.resolveFile(task.remoteId);
            await this.context.refreshMessage?.(source!);
            return undefined;
          });
          pending.set(task.key, Promise.resolve(operation).then(file => {
            if (!sameRuntime()) return;
            const state = file || undefined;
            if (task.remoteId) this.attempted.set(task.remoteId, state);
            if (this.attempted.size > 20_000) this.attempted.delete(this.attempted.keys().next().value!);
            results.push({ task, file: state });
          }, error => {
            if (!sameRuntime() || error instanceof TdSessionSupersededError) return;
            if (task.remoteId) this.attempted.set(task.remoteId, undefined);
            if (this.attempted.size > 20_000) this.attempted.delete(this.attempted.keys().next().value!);
            results.push({ task });
          }).finally(() => { pending.delete(task.key); if (sameRuntime()) this.wake?.(); }));
        }
        // Count work across immediately resolved promises; a microtask continuation
        // alone does not give input or painting an execution opportunity.
        workMs += performance.now() - started;
        workItems += count + dispatched;
        if (workMs >= BUDGET_MS || workItems >= 64 || this.foregroundDiscovery || this.discoveries.length || validations.length || results.length || this.tasks.size && pending.size < 4) {
          await yieldWork();
          workMs = 0;
          workItems = 0;
        } else if (pending.size) {
          let wake: () => void;
          await Promise.race([...pending.values(), new Promise<void>(resolve => { this.wake = wake = resolve; })]);
          if (this.wake === wake!) this.wake = undefined;
        } else break;
      }
    };
    const operation = run().finally(() => {
      if (this.running === operation) { this.running = undefined; this.wake = undefined; }
    });
    this.running = operation;
    return operation;
  }
}
