import { useEffect, useRef } from "react";
import { audioPlaybackController } from "../media/audioPlayback";

interface AudioSpectrumProps {
  playbackId: string;
  playing: boolean;
  bars?: number;
  className?: string;
}

const seedFor = (value: string) => [...value].reduce(
  (seed, character) => (seed * 33 + character.charCodeAt(0)) >>> 0,
  5381,
);

export function AudioSpectrum({
  playbackId,
  playing,
  bars = 34,
  className = "",
}: AudioSpectrumProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const values = new Uint8Array(bars);
    const seed = seedFor(playbackId);
    let frame = 0;
    let animationFrame = 0;

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(bounds.width * ratio));
      const height = Math.max(1, Math.round(bounds.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const hasLiveSpectrum = playing && audioPlaybackController.readSpectrum(values);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(canvas).color;
      const gap = Math.max(1.2 * ratio, width / bars * 0.32);
      const barWidth = Math.max(1.4 * ratio, (width - gap * (bars - 1)) / bars);
      for (let index = 0; index < bars; index += 1) {
        const fallback = 0.18 + (((seed >>> (index % 24)) + index * 37) % 73) / 100;
        const live = values[index] / 255;
        const pulse = playing ? 0.08 * Math.sin(frame * 0.11 + index * 0.8) : 0;
        const amplitude = Math.max(0.12, Math.min(1, hasLiveSpectrum ? live : fallback + pulse));
        const barHeight = Math.max(2 * ratio, amplitude * height * 0.88);
        const x = index * (barWidth + gap);
        context.globalAlpha = hasLiveSpectrum ? 0.92 : playing ? 0.78 : 0.5;
        context.fillRect(x, (height - barHeight) / 2, barWidth, barHeight);
      }
      context.globalAlpha = 1;
      frame += 1;
      if (playing) animationFrame = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animationFrame);
  }, [bars, playbackId, playing]);

  return (
    <canvas
      ref={canvasRef}
      className={`audio-spectrum ${className}`.trim()}
      role="img"
      aria-label="音频频谱"
    />
  );
}
