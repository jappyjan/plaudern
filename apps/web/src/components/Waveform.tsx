import { useEffect, useRef } from 'react';

const BAR_COUNT = 64;
const BAR_GAP_PX = 2;
const MIN_LEVEL = 0.02; // idle bars stay visible as a thin center line

/**
 * Scrolling live level meter for the recorder: samples the AnalyserNode's
 * time-domain data each frame, folds it to an RMS level and draws it as
 * vertically-centered bars moving right-to-left.
 */
export function Waveform({ analyser }: { analyser: AnalyserNode }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const samples = new Uint8Array(analyser.fftSize);
    const levels = new Array<number>(BAR_COUNT).fill(0);
    let frame = 0;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 300;
    const cssHeight = canvas.clientHeight || 64;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    ctx.scale(dpr, dpr);

    // Matches HeroUI's `danger` red, echoing the record button.
    const barColor = 'hsl(339 90% 51%)';

    const draw = () => {
      analyser.getByteTimeDomainData(samples);
      let sumSquares = 0;
      for (let i = 0; i < samples.length; i++) {
        const centered = (samples[i] - 128) / 128;
        sumSquares += centered * centered;
      }
      // sqrt of the RMS exaggerates quiet input so speech reads clearly.
      const level = Math.min(1, Math.sqrt(Math.sqrt(sumSquares / samples.length)));
      levels.push(Math.max(level, MIN_LEVEL));
      levels.shift();

      ctx.clearRect(0, 0, cssWidth, cssHeight);
      ctx.fillStyle = barColor;
      const barWidth = cssWidth / BAR_COUNT - BAR_GAP_PX;
      for (let i = 0; i < BAR_COUNT; i++) {
        const x = i * (cssWidth / BAR_COUNT);
        const barHeight = Math.max(2, levels[i] * cssHeight);
        const y = (cssHeight - barHeight) / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, Math.max(1, barWidth), barHeight, barWidth / 2);
        ctx.fill();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(frame);
  }, [analyser]);

  return <canvas ref={canvasRef} className="h-16 w-full" aria-hidden="true" />;
}
