import { useMemo, useState, type MouseEvent } from 'react';
import type { PreviewPlan, PreviewSegment, PreviewTrack } from '../preview';
import { framesToTimecode } from './format';

const kindLabel: Record<PreviewTrack['kind'], string> = { video: 'VIDEO', audio: 'AUDIO', caption: 'TEXT' };

function tickStep(totalFrames: number, fps: number): number {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].map((seconds) => seconds * fps);
  return candidates.find((step) => totalFrames / step <= 12) ?? Math.max(1, totalFrames);
}

/** A simple, honest waveform: bar heights follow the clip's stored gain. */
function AudioBars({ segment }: { segment: PreviewSegment }) {
  const bars = Math.max(6, Math.min(64, Math.round(segment.duration / 8)));
  const level = Math.min(1, Math.max(0.12, 10 ** (segment.gainDb / 20)));
  return <span className="audio-bars" aria-hidden="true">
    {Array.from({ length: bars }, (_unused, index) => {
      const shape = 0.45 + 0.55 * Math.abs(Math.sin((index + 1) * 1.7));
      return <i key={index} style={{ height: `${Math.round(level * shape * 100)}%` }} />;
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

  return <section className="timeline" aria-label="Timeline tracks">
    <header className="timeline-bar">
      <span className="timeline-title">Sequence</span>
      <span className="timeline-counter">{framesToTimecode(playhead, plan.fps)} / {framesToTimecode(total, plan.fps)}</span>
      <div className="zoom">
        <button aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(1, value - 0.5))}>−</button>
        <input
          aria-label="Timeline zoom"
          type="range"
          min="1"
          max="6"
          step="0.5"
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
        />
        <button aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(6, value + 0.5))}>+</button>
      </div>
    </header>

    <div className="timeline-scroll">
      <div className="timeline-canvas" style={{ width: `${zoom * 100}%` }}>
        <div className="ruler-head" />
        <div className="ruler" onClick={seekFromEvent} role="presentation">
          {ticks.map((frame) => <span key={frame} style={{ left: `${(frame / total) * 100}%` }}>
            {framesToTimecode(frame, plan.fps).slice(3)}
          </span>)}
        </div>

        {plan.tracks.map((track) => [
          <div className={`lane-head lane-head-${track.kind}`} key={`${track.id}-head`}>
            <strong>{track.name}</strong>
            <small>{kindLabel[track.kind]}</small>
          </div>,
          <div className={`lane lane-${track.kind}`} key={`${track.id}-lane`} onClick={seekFromEvent} role="presentation">
            {track.segments.map((segment) => <button
              key={segment.id}
              className={`chip chip-${segment.kind} ${selectedSegmentId === segment.id ? 'selected' : ''} ${segment.available || segment.kind !== 'clip' ? '' : 'offline'}`}
              style={{
                left: `${(segment.timelineStart / total) * 100}%`,
                width: `${(segment.duration / total) * 100}%`,
              }}
              title={`${segment.name} · ${framesToTimecode(segment.timelineStart, plan.fps)} → ${framesToTimecode(segment.timelineStart + segment.duration, plan.fps)} · ${segment.duration} frames`}
              onClick={(event) => {
                event.stopPropagation();
                onSeek(segment.timelineStart);
                onSelectSegment?.(segment, track);
              }}
            >
              {track.kind === 'audio' && segment.kind === 'clip' && <AudioBars segment={segment} />}
              <span className="chip-label">{segment.name}</span>
            </button>)}
          </div>,
        ])}

        <div className="playhead-overlay" aria-hidden="true">
          <div className="playhead" style={{ left: `${(Math.min(playhead, total) / total) * 100}%` }} />
        </div>
      </div>
    </div>
  </section>;
}
