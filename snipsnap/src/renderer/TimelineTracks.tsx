import { Minus, Plus } from 'lucide-react';
import { useMemo, useState, type MouseEvent, type WheelEvent } from 'react';
import type { PreviewPlan, PreviewSegment, PreviewTrack } from '../preview';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { framesToTimecode } from './format';

const kindLabel: Record<PreviewTrack['kind'], string> = { video: 'VIDEO', audio: 'AUDIO', caption: 'TEXT' };

const chipTone: Record<PreviewSegment['kind'], string> = {
  clip: 'bg-gradient-to-b from-[#3a3a3a] to-[#242424]',
  gap: 'bg-[repeating-linear-gradient(45deg,#1a1a1a_0_6px,#141414_6px_12px)] border-dashed',
  caption: 'bg-gradient-to-b from-[#4a4a4a] to-[#2e2e2e]',
  transition: 'bg-[repeating-linear-gradient(45deg,#5a5a5a_0_4px,#3a3a3a_4px_8px)] border-[#8a8a8a]',
};

function tickStep(totalFrames: number, fps: number): number {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].map((seconds) => seconds * fps);
  return candidates.find((step) => totalFrames / step <= 12) ?? Math.max(1, totalFrames);
}

/** A simple, honest waveform: bar heights follow the clip's stored gain. */
function AudioBars({ segment }: { segment: PreviewSegment }) {
  const bars = Math.max(6, Math.min(64, Math.round(segment.duration / 8)));
  const level = Math.min(1, Math.max(0.12, 10 ** (segment.gainDb / 20)));
  return <span className="flex h-3/5 shrink-0 items-center gap-px" aria-hidden="true">
    {Array.from({ length: bars }, (_unused, index) => {
      const shape = 0.45 + 0.55 * Math.abs(Math.sin((index + 1) * 1.7));
      return <i key={index} className="w-0.5 rounded-sm bg-white/50" style={{ height: `${Math.round(level * shape * 100)}%` }} />;
    })}
  </span>;
}

export interface TimelineTracksProps {
  plan: PreviewPlan;
  playhead: number;
  onSeek(frame: number): void;
  selectedSegmentId?: string | null;
  onSelectSegment?(segment: PreviewSegment, track: PreviewTrack): void;
}

export function TimelineTracks({ plan, playhead, onSeek, selectedSegmentId, onSelectSegment }: TimelineTracksProps) {
  const [zoom, setZoom] = useState(1);
  const total = Math.max(1, plan.totalFrames);
  const step = useMemo(() => tickStep(total, plan.fps), [total, plan.fps]);
  const ticks = useMemo(
    () => Array.from({ length: Math.floor(total / step) + 1 }, (_unused, index) => index * step),
    [total, step],
  );

  function seekFromEvent(event: MouseEvent<HTMLElement>): void {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    onSeek(Math.round(((event.clientX - bounds.left) / bounds.width) * total));
  }

  function scrubFromWheel(event: WheelEvent<HTMLDivElement>): void {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    event.preventDefault();
    const next = playhead + Math.round(delta * (plan.fps / 80));
    onSeek(Math.min(total - 1, Math.max(0, next)));
  }

  return <section aria-label="Timeline tracks" className="shrink-0 overflow-hidden rounded-lg border border-border bg-card">
    <header className="flex items-center gap-3 border-b border-border px-3 py-2">
      <span className="text-xs font-semibold">Sequence</span>
      <span className="timeline-counter font-mono text-[10px] text-muted-foreground">
        {framesToTimecode(playhead, plan.fps)} / {framesToTimecode(total, plan.fps)}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <Button size="icon" variant="ghost" aria-label="Zoom out" className="h-6 w-6" onClick={() => setZoom((value) => Math.max(1, value - 0.5))}>
          <Minus className="h-3 w-3" />
        </Button>
        <input
          aria-label="Timeline zoom"
          type="range" min="1" max="6" step="0.5" value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
          className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        />
        <Button size="icon" variant="ghost" aria-label="Zoom in" className="h-6 w-6" onClick={() => setZoom((value) => Math.min(6, value + 0.5))}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </header>

    <div className="overflow-x-auto" onWheel={scrubFromWheel}>
      <div className="relative grid min-w-full grid-cols-[7rem_minmax(0,1fr)]" style={{ width: `${zoom * 100}%` }}>
        <div className="sticky left-0 z-10 border-b border-r border-border bg-card" />
        <div className="relative h-6 cursor-pointer border-b border-border bg-card" onClick={seekFromEvent} role="presentation">
          {ticks.map((frame) => <span
            key={frame}
            className="absolute top-1.5 border-l border-border pl-1 font-mono text-[9px] text-muted-foreground"
            style={{ left: `${(frame / total) * 100}%` }}
          >{framesToTimecode(frame, plan.fps).slice(3)}</span>)}
        </div>

        {plan.tracks.map((track) => [
          <div
            key={`${track.id}-head`}
            className="sticky left-0 z-10 flex flex-col justify-center border-b border-r border-border bg-card px-2.5"
          >
            <strong className="line-clamp-2 text-[11px] leading-tight">{track.name}</strong>
            <small className="font-mono text-[8px] tracking-widest text-muted-foreground">{kindLabel[track.kind]}</small>
          </div>,
          <div
            key={`${track.id}-lane`}
            className={cn('lane relative cursor-pointer border-b border-border bg-black/30', track.kind === 'caption' ? 'h-9' : 'h-14')}
            onClick={seekFromEvent}
            role="presentation"
          >
            {track.segments.map((segment) => <button
              key={segment.id}
              className={cn(
                'absolute inset-y-1.5 flex min-w-[3px] items-center gap-1.5 overflow-hidden rounded border border-white/10 px-1.5 text-left',
                chipTone[segment.kind],
                selectedSegmentId === segment.id && 'ring-1 ring-primary',
                // A generator is dimmed for missing footage otherwise, which it never has.
                segment.kind === 'clip' && !segment.available && !segment.isGenerator && 'opacity-55 grayscale',
              )}
              style={{
                left: `${(segment.timelineStart / total) * 100}%`,
                width: `${(segment.duration / total) * 100}%`,
              }}
              title={`${segment.name} · ${framesToTimecode(segment.timelineStart, plan.fps)} → ${framesToTimecode(segment.timelineStart + segment.duration, plan.fps)} · ${segment.duration} frames`}
              onClick={(event) => {
                event.stopPropagation();
                // Seek to the frame under the pointer, not to the start of the clip.
                const bounds = event.currentTarget.getBoundingClientRect();
                const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : 0;
                onSeek(Math.round(segment.timelineStart + ratio * segment.duration));
                onSelectSegment?.(segment, track);
              }}
            >
              {track.kind === 'audio' && segment.kind === 'clip' && <AudioBars segment={segment} />}
              <span className="truncate text-[10px]">{segment.name}</span>
            </button>)}
          </div>,
        ])}

        <div className="pointer-events-none absolute inset-y-0 left-[7rem] right-0">
          <div
            className="playhead absolute inset-y-0 w-px bg-primary shadow-[0_0_7px_hsl(var(--primary))]"
            style={{ left: `${(Math.min(playhead, total) / total) * 100}%` }}
          />
        </div>
      </div>
    </div>
  </section>;
}
