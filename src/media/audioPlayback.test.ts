import { describe, expect, it, vi } from "vitest";
import { AudioPlaybackController, type AudioPlaybackHostControls, type AudioTrackDescriptor } from "./audioPlayback";

const track = (id: string, nextId?: string): AudioTrackDescriptor => ({
  id,
  nextId,
  label: id,
  fileId: 1,
  size: 100,
  onRequestStream: vi.fn(),
});

describe("audio playback controller", () => {
  it("keeps registered tracks available after their message view disappears", () => {
    const controller = new AudioPlaybackController();
    controller.registerTracks([track("first", "second"), track("second")]);
    expect(controller.hasTrack("first")).toBe(true);
    expect(controller.track("first")?.nextId).toBe("second");
  });

  it("routes playback commands through the persistent host", () => {
    const controller = new AudioPlaybackController();
    const host: AudioPlaybackHostControls = {
      play: vi.fn(), toggle: vi.fn(), seek: vi.fn(), setPlaybackRate: vi.fn(),
      previous: vi.fn(), next: vi.fn(), close: vi.fn(),
    };
    controller.attachHost(host);
    const item = track("first");
    controller.play(item);
    controller.activate(item);
    controller.toggle(item);
    controller.seek(12);
    controller.cyclePlaybackRate();
    controller.close();

    expect(host.play).toHaveBeenCalledWith(item);
    expect(host.toggle).toHaveBeenCalledOnce();
    expect(host.seek).toHaveBeenCalledWith(12);
    expect(host.setPlaybackRate).toHaveBeenCalledWith(1.25);
    expect(host.close).toHaveBeenCalledOnce();
  });
});
