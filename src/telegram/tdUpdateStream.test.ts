import { afterEach, describe, expect, it, vi } from "vitest";
import { TdUpdateStream, type NativeUpdateBatch } from "./tdUpdateStream";
import type { TdObject } from "./tdlibMapper";

describe("acknowledged TDLib update stream", () => {
  let stream: TdUpdateStream;
  afterEach(() => stream?.dispose());

  const harness = (updates: TdObject[]) => {
    const packets = Array.from({ length: Math.ceil(updates.length / 64) }, (_, index) => updates.slice(index * 64, (index + 1) * 64));
    const applied: TdObject[] = [];
    const bridge = {
      open: vi.fn(async () => 7), close: vi.fn(async () => undefined),
      listen: vi.fn(async (_wake: () => void) => () => undefined),
      take: vi.fn(async (_id: number, ack: number): Promise<NativeUpdateBatch> => ({
        streamId: 7, sequence: packets[ack] ? ack + 1 : ack, updates: packets[ack] ?? [],
        pendingCount: Math.max(0, updates.length - (ack + 1) * 64), oldestAgeMs: 60_000,
      })),
      yield: vi.fn(async (): Promise<void> => undefined),
    };
    const error = vi.fn();
    const apply = vi.fn((batch: TdObject[], offset: number, budget: number) => {
      expect(budget).toBe(4);
      const count = Math.min(4, batch.length - offset);
      applied.push(...batch.slice(offset, offset + count));
      return count;
    });
    stream = new TdUpdateStream(apply, error, vi.fn(), bridge);
    return { bridge, apply, applied, error };
  };

  it("drains a suspended backlog in order while yielding between slices and acknowledging whole packets", async () => {
    const updates = Array.from({ length: 12_800 }, (_, id) => ({ id, "@type": ["updateNewMessage", "updateMessageContent", "updateDeleteMessages"][id % 3] }));
    const { bridge, applied, error } = harness(updates);
    await stream.start();
    await vi.waitFor(() => expect(bridge.take).toHaveBeenCalledTimes(201));
    expect(applied).toEqual(updates);
    expect(bridge.yield).toHaveBeenCalledTimes(3200);
    expect(bridge.take.mock.calls.map(([, ack]) => ack)).toEqual(Array.from({ length: 201 }, (_, index) => index));
    expect(error).not.toHaveBeenCalled();
  });

  it("retries a failed native read without replaying already applied updates", async () => {
    const { bridge, applied, error } = harness([{ id: 1 }]);
    bridge.take.mockRejectedValueOnce(new Error("temporary IPC failure"));
    await stream.start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.any(Error), false));
    stream.wake();
    await vi.waitFor(() => expect(applied).toEqual([{ id: 1 }]));
    expect(bridge.take.mock.calls.map(([, ack]) => ack)).toEqual([0, 0, 1]);
  });

  it("halts on a partial application fault instead of duplicating its applied prefix", async () => {
    const { apply, error, bridge } = harness(Array.from({ length: 10 }, (_, id) => ({ id })));
    apply.mockImplementationOnce(() => 4).mockImplementationOnce(() => { throw new Error("invalid update"); });
    await stream.start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.any(Error), true));
    stream.wake();
    expect(bridge.take).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("cancels a leased packet when its account/window session is disposed", async () => {
    const { bridge, applied } = harness(Array.from({ length: 10 }, (_, id) => ({ id })));
    let resume!: () => void;
    bridge.yield.mockImplementationOnce(() => new Promise<void>(resolve => { resume = resolve; }));
    await stream.start();
    await vi.waitFor(() => expect(applied).toHaveLength(4));
    stream.dispose();
    resume();
    await Promise.resolve();
    expect(applied).toHaveLength(4);
    expect(bridge.close).toHaveBeenCalledWith(7);
    expect(bridge.take).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, NaN, 65])("halts on invalid application progress %s without acknowledging or replaying a packet", async consumed => {
    const { bridge, apply, error } = harness([{ id: 1 }]);
    apply.mockReturnValueOnce(consumed);
    await stream.start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.any(Error), true));
    stream.wake();
    expect(bridge.take).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("halts before applying a packet from another sequence", async () => {
    const { bridge, apply, error } = harness([{ id: 1 }]);
    bridge.take.mockResolvedValueOnce({ streamId: 7, sequence: 2, updates: [{ id: 1 }], pendingCount: 0, oldestAgeMs: 0 });
    await stream.start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.any(Error), true));
    stream.wake();
    expect(bridge.take).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it("closes an obsolete registration that finishes after disposal", async () => {
    const { bridge } = harness([]);
    let opened!: (id: number) => void;
    bridge.open.mockImplementationOnce(() => new Promise(resolve => { opened = resolve; }));
    const starting = stream.start();
    await vi.waitFor(() => expect(opened).toBeDefined());
    stream.dispose();
    opened(7);
    await starting;
    expect(bridge.close).toHaveBeenCalledWith(7);
    expect(bridge.take).not.toHaveBeenCalled();
  });
});
