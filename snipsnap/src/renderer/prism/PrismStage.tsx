import { useEffect, useRef, useState } from 'react';
import { createPrismScene, type PrismScene, type PrismState } from './scene';

export type Stage = 'intro' | 'library' | 'project';

/** Where the camera sits for each screen, and how long it takes to get there. */
const pose: Record<Stage, PrismState> = {
  intro: { travel: 0, zoom: 0, fade: 1 },
  library: { travel: 1, zoom: 0, fade: 0.9 },
  project: { travel: 1, zoom: 1, fade: 0.62 },
};

const flightTime: Record<Stage, number> = { intro: 950, library: 1800, project: 760 };

const easeOut = (t: number) => 1 - (1 - t) ** 3;

function blend(from: PrismState, to: PrismState, k: number): PrismState {
  return {
    travel: from.travel + (to.travel - from.travel) * k,
    zoom: from.zoom + (to.zoom - from.zoom) * k,
    fade: from.fade + (to.fade - from.fade) * k,
  };
}

/**
 * The prism scene as a fixed backdrop. Every screen draws over this one canvas, so
 * moving between them is a camera move rather than a page swap.
 */
export function PrismStage({ stage }: { stage: Stage }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flight = useRef({ from: pose.intro, to: pose.intro, start: 0, duration: 1 });
  const [painted, setPainted] = useState(false);
  const lifecycle = useRef<Promise<void>>(Promise.resolve());

  const sample = (): PrismState => {
    const { from, to, start, duration } = flight.current;
    const elapsed = (performance.now() - start) / duration;
    return blend(from, to, easeOut(Math.min(Math.max(elapsed, 0), 1)));
  };

  useEffect(() => {
    const instant = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    flight.current = {
      from: sample(),
      to: pose[stage],
      start: performance.now(),
      duration: instant ? 1 : flightTime[stage],
    };
  }, [stage]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let scene: PrismScene | null = null;
    let cancelled = false;

    // Strict mode mounts twice, and vgpu refuses a second surface on a live canvas,
    // so each attempt waits for the previous teardown to finish.
    const attempt = lifecycle.current.then(async () => {
      if (cancelled) return;
      try {
        scene = await createPrismScene(canvas, sample);
        if (!cancelled) setPainted(scene !== null);
      } catch {
        if (!cancelled) setPainted(false);
      }
      if (cancelled) {
        scene?.dispose();
        scene = null;
      }
    });
    lifecycle.current = attempt;

    return () => {
      cancelled = true;
      lifecycle.current = attempt.then(() => {
        scene?.dispose();
        scene = null;
      });
    };
  }, []);

  return <div className="vg-stage" data-stage={stage}>
    <canvas ref={canvasRef} className="vg-canvas" data-painted={painted ? 'true' : 'false'} />
    {!painted && <div aria-hidden="true" className="vg-fallback"><span /></div>}
  </div>;
}
