import { useEffect, useRef } from 'react';
import { useLevel } from '../store';

interface Props {
  width?: number;
  height?: number;
  bars?: number;
  /** When false the bars rest as a quiet baseline. */
  active: boolean;
  className?: string;
}

/** Canvas waveform driven by mic / TTS level events. Reads the level store imperatively (no re-renders). */
export function AudioVisualizer({ width = 120, height = 28, bars = 24, active, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const history = new Array<number>(bars).fill(0);
    let raf = 0;
    let last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last > 55) {
        last = t;
        history.shift();
        history.push(active ? useLevel.getState().level : 0);
      }
      const color = getComputedStyle(canvas).color;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      const gap = 2;
      const bw = (width - gap * (bars - 1)) / bars;
      for (let i = 0; i < bars; i++) {
        const v = Math.min(1, history[i] ** 0.7);
        const h = Math.max(2.5, v * height);
        const x = i * (bw + gap);
        ctx.globalAlpha = active ? 0.45 + 0.55 * (i / bars) : 0.35;
        ctx.beginPath();
        ctx.roundRect(x, (height - h) / 2, bw, h, bw / 2);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active, bars, height, width]);

  return <canvas ref={ref} style={{ width, height }} className={className} />;
}
