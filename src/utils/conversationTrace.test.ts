import { describe, expect, it, vi } from "vitest";
import {
  createConversationTrace, conversationTraceKind as kind, conversationTraceLimits as limits,
  recordConversationMessage, registerConversationTrace, writeConversationScrollTop,
} from "./conversationTrace";
import type { Message } from "../telegram/types";
import type { PerformanceDetails } from "./performanceMonitor";

const harness = () => {
  let time = 0;
  const emit = vi.fn();
  const trace = createConversationTrace({ now: () => time, emit });
  return { trace, emit, advance: (ms: number) => { time += ms; } };
};
const records = (emit: ReturnType<typeof vi.fn>) => emit.mock.calls.map(call => call[1] as PerformanceDetails);

describe("conversation diagnostic recorder", () => {
  it("keeps bounded pre-trigger history and protects deletion evidence during callback storms", () => {
    const { trace, emit } = harness();
    for (let index = 0; index < 300; index++) trace.record(kind.write, { actualTop: index });
    expect(emit).not.toHaveBeenCalled();
    trace.record(kind.messageRemove, { messageToken: 1 });
    trace.trigger(1);
    for (let index = 0; index < 300; index++) trace.record(kind.measure, { measuredSize: index });
    trace.flush();
    expect(records(emit)[0]).toMatchObject({ traceKind: kind.start, triggerKind: 1 });
    expect(records(emit).some(record => record.traceKind === kind.messageRemove)).toBe(true);
    expect(emit.mock.calls.length).toBeLessThanOrEqual(limits.history + 2);
    trace.dispose();
    expect(records(emit).at(-1)?.droppedCount).toBeGreaterThan(0);
  });

  it("ends within a fixed time, rejects retriggers during cooldown, and retains a later self-delete", () => {
    const { trace, emit, advance } = harness();
    expect(trace.trigger(2)).toBe(true);
    trace.flush();
    advance(limits.durationMs);
    trace.flush();
    expect(trace.active).toBe(false);
    expect(records(emit).at(-1)).toMatchObject({ finishKind: 1 });
    expect(trace.trigger(2)).toBe(false);
    trace.record(kind.messageRemove, { messageToken: 9 });
    trace.record(kind.ghostEnd, { messageToken: 9 });
    trace.flush();
    expect(records(emit).at(-1)).toMatchObject({ traceKind: kind.ghostEnd, messageToken: 9 });
    advance(limits.cooldownMs);
    expect(trace.trigger(1)).toBe(true);
    trace.dispose();
    const count = emit.mock.calls.length;
    trace.record(kind.write); trace.flush(); trace.trigger(2);
    expect(emit).toHaveBeenCalledTimes(count);
  });

  it("reserves a terminal record when the burst reaches its output budget", () => {
    const { trace, emit } = harness();
    trace.trigger(2); trace.flush();
    for (let index = 0; index < limits.records * 2; index++) trace.detail("ui_conversation_row", { rowHeight: index });
    trace.flush();
    expect(emit).toHaveBeenCalledTimes(limits.records);
    expect(records(emit).at(-1)).toMatchObject({ traceKind: kind.end, finishKind: 2 });
    expect(trace.active).toBe(false);
  });

  it("keeps identities stable without exporting raw chat/message IDs or content", () => {
    const { trace, emit } = harness();
    const list = {} as HTMLElement;
    const unregister = registerConversationTrace(list, "private-chat", trace);
    const message: Message = {
      id: "private-message", chatId: "private-chat", senderId: "private-sender", outgoing: false,
      sentAt: "2026-09-11T00:00:00Z", delivery: "read", content: { kind: "text", text: "PRIVATE TEXT" },
      replyTo: { kind: "message", messageId: "private-reply" },
    };
    recordConversationMessage(message.chatId, message.id, kind.messageRemove, message, { remote: true });
    recordConversationMessage(message.chatId, message.id, kind.ghostEnd, message);
    recordConversationMessage("another-chat", "invisible-message", kind.messageRemove, message);
    trace.flush();
    const deletion = records(emit).find(record => record.traceKind === kind.messageRemove)!;
    const ghost = records(emit).find(record => record.traceKind === kind.ghostEnd)!;
    expect(deletion.messageToken).toBe(ghost.messageToken);
    expect(deletion.revisionToken).toBe(ghost.revisionToken);
    expect(deletion.replyToken).not.toBe(deletion.messageToken);
    expect(JSON.stringify(emit.mock.calls)).not.toMatch(/private|PRIVATE|invisible/);
    unregister();
    const count = emit.mock.calls.length;
    recordConversationMessage(message.chatId, message.id, kind.messageRemove, message);
    expect(emit).toHaveBeenCalledTimes(count);
  });

  it("records the requested and clamped offsets without adding or changing a write", () => {
    const { trace, emit } = harness();
    let position = 20, assignments = 0;
    const list = {
      get scrollTop() { return position; },
      set scrollTop(value: number) { assignments++; position = Math.max(0, Math.min(100, value)); },
    } as HTMLElement;
    const unregister = registerConversationTrace(list, "chat", trace);
    writeConversationScrollTop(list, 200, 1);
    expect(position).toBe(100);
    expect(assignments).toBe(1);
    trace.trigger(2); trace.flush();
    expect(records(emit).find(record => record.traceKind === kind.write)).toMatchObject({ beforeTop: 20, requestedTop: 200, actualTop: 100 });
    unregister();
    expect(assignments).toBe(1);
  });

  it("does not reuse a token when the bounded identity table fills", () => {
    const { trace } = harness();
    const first = trace.token("first");
    for (let index = 1; index < limits.identities; index++) trace.token(String(index));
    expect(trace.token("overflow")).toBe(0);
    expect(trace.token("first")).toBe(first);
  });

});
