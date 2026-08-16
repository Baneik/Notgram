import { useEffect, useRef } from "react";
import { audioPlaybackController } from "../media/audioPlayback";
import { usePreferencesStore } from "../store/preferencesStore";

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
  const reduceMotion = usePreferencesStore((state) => state.effectiveReduceMotion);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const values = new Uint8Array(bars);
    const seed = seedFor(playbackId);
    let frame = 0;
    let animationFrame = 0;
    let cssWidth = Math.max(1, canvas.clientWidth);
    let cssHeight = Math.max(1, canvas.clientHeight);
    let ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    let fillStyle = getComputedStyle(canvas).color;
    const animate = playing && !reduceMotion;

    const resizeCanvas = (width: number, height: number) => {
      cssWidth = Math.max(1, width);
      cssHeight = Math.max(1, height);
      ratio = Math.min(2, globalThis.devicePixelRatio || 1);
      const pixelWidth = Math.max(1, Math.round(cssWidth * ratio));
      const pixelHeight = Math.max(1, Math.round(cssHeight * ratio));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    };

    const draw = () => {
      const nextRatio = Math.min(2, globalThis.devicePixelRatio || 1);
      if (nextRatio !== ratio) resizeCanvas(cssWidth, cssHeight);
      const width = canvas.width;
      const height = canvas.height;
      const hasLiveSpectrum = animate && audioPlaybackController.readSpectrum(values);
      context.clearRect(0, 0, width, height);
      context.fillStyle = fillStyle;
      const gap = Math.max(1.2 * ratio, width / bars * 0.32);
      const barWidth = Math.max(1.4 * ratio, (width - gap * (bars - 1)) / bars);
      for (let index = 0; index < bars; index += 1) {
        const fallback = 0.18 + (((seed >>> (index % 24)) + index * 37) % 73) / 100;
        const live = values[index] / 255;
        const pulse = animate ? 0.08 * Math.sin(frame * 0.11 + index * 0.8) : 0;
        const amplitude = Math.max(0.12, Math.min(1, hasLiveSpectrum ? live : fallback + pulse));
        const barHeight = Math.max(2 * ratio, amplitude * height * 0.88);
        const x = index * (barWidth + gap);
        context.globalAlpha = hasLiveSpectrum ? 0.92 : animate ? 0.78 : 0.5;
        context.fillRect(x, (height - barHeight) / 2, barWidth, barHeight);
      }
      context.globalAlpha = 1;
      frame += 1;
      if (animate) animationFrame = requestAnimationFrame(draw);
    };

    resizeCanvas(cssWidth, cssHeight);
    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return;
      resizeCanvas(entry.contentRect.width, entry.contentRect.height);
      if (!animate) draw();
    });
    resizeObserver.observe(canvas);
    const themeObserver = new MutationObserver(() => {
      fillStyle = getComputedStyle(canvas).color;
      if (!animate) draw();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    draw();
    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, [bars, playbackId, playing, reduceMotion]);

  return (
    <canvas
      ref={canvasRef}
      className={`audio-spectrum ${className}`.trim()}
      data-motion-active={playing && !reduceMotion ? "true" : "false"}
      role="img"
      aria-label="音频频谱"
    />
  );
}
