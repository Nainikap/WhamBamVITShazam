import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PreviewPlan, PreviewSegment } from '../preview';
import { framesToTimecode } from './format';

function segmentAt(plan: PreviewPlan, frame: number): { segment: PreviewSegment; index: number } | null {
  const index = plan.segments.findIndex((segment) => frame >= segment.timelineStart
    && frame < segment.timelineStart + segment.duration);
  const fallback = plan.segments.at(-1);
  if (index >= 0) return { segment: plan.segments[index] as PreviewSegment, index };
  return fallback ? { segment: fallback, index: plan.segments.length - 1 } : null;
}

export interface CommitPlayerProps {
  plan: PreviewPlan;
  onRelink?(fingerprint: string): void;
  /** Compact hides the segment strip, for the side-by-side comparison. */
  variant?: 'full' | 'compact';
  label?: string;
  onPlayheadChange?(frame: number): void;
  playhead?: number;
  /** Announced when the viewer starts or stops, so a linked player can follow. */
  onPlayingChange?(playing: boolean): void;
  /** Drives play and pause from a linked player. */
  playing?: boolean;
}

export function CommitPlayer({
  plan, onRelink, variant = 'full', label,
  onPlayheadChange, playhead: external, onPlayingChange, playing: externalPlaying,
}: CommitPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const active = plan.segments[activeIndex];
  const canPlayMedia = active?.kind === 'clip' && active.available && Boolean(active.mediaUrl);

  useEffect(() => {
    setPlayhead(0);
    setPlaying(false);
    setActiveIndex(0);
  }, [plan.commitId]);

  // Track what this player last announced so an echo of our own value is ignored.
  const emitted = useRef<number | null>(null);
  const announce = useCallback((frame: number) => {
    emitted.current = frame;
    onPlayheadChange?.(frame);
  }, [onPlayheadChange]);

  /** Move this player to a timeline frame, including the underlying media. */
  const applyFrame = useCallback((frame: number, index: number) => {
    setPlayhead(frame);
    if (index !== activeIndex) {
      setActiveIndex(index);
      return;
    }
    const segment = plan.segments[index];
    const video = videoRef.current;
    if (!video || !segment || !segment.available) return;
    video.currentTime = (segment.sourceStart + Math.max(0, frame - segment.timelineStart)) / plan.fps;
  }, [activeIndex, plan]);

  // An external playhead (a linked player, or the timeline being scrubbed) seeks
  // the media as well as the marker, and never echoes back as a new seek.
  useEffect(() => {
    if (external === undefined) return;
    if (emitted.current !== null && Math.abs(external - emitted.current) < 0.5) return;
    if (Math.abs(external - playhead) < 0.5) return;
    const located = segmentAt(plan, external);
    emitted.current = external;
    applyFrame(external, located ? located.index : activeIndex);
  }, [external, applyFrame, plan]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    if (!active?.mediaUrl || !active.available) {
      video.removeAttribute('src');
      video.load();
      return;
    }
    video.src = active.mediaUrl;
    video.volume = Math.min(1, Math.max(0, 10 ** (active.gainDb / 20)));
    video.load();
  }, [active?.id, active?.mediaUrl, active?.available, active?.gainDb]);

  // A linked player mirrors play and pause without re-announcing them.
  useEffect(() => {
    if (externalPlaying === undefined || externalPlaying === playing) return;
    setPlaying(externalPlaying);
    const video = videoRef.current;
    if (!video) return;
    if (externalPlaying) void video.play().catch(() => setPlaying(false));
    else video.pause();
  }, [externalPlaying]);

  useEffect(() => {
    if (!playing || canPlayMedia || !active) return undefined;
    const interval = window.setInterval(() => {
      setPlayhead((current) => {
        const next = current + plan.fps / 10;
        const end = active.timelineStart + active.duration;
        if (next < end) {
          announce(next);
          return next;
        }
        const nextIndex = activeIndex + 1;
        if (nextIndex >= plan.segments.length) {
          setPlaying(false);
          return plan.totalFrames;
        }
        setActiveIndex(nextIndex);
        return plan.segments[nextIndex]?.timelineStart ?? end;
      });
    }, 100);
    return () => window.clearInterval(interval);
  }, [active, activeIndex, canPlayMedia, plan.fps, plan.segments, plan.totalFrames, playing]);

  const activeOffset = active ? Math.max(0, playhead - active.timelineStart) : 0;
  const displayLabel = useMemo(() => {
    if (!active) return 'No video track in this commit';
    if (active.kind === 'gap') return 'Timeline gap';
    return active.available ? active.name : `${active.name} · media offline`;
  }, [active]);

  function seek(frame: number): void {
    const clamped = Math.min(Math.max(frame, 0), Math.max(0, plan.totalFrames - 1));
    const located = segmentAt(plan, clamped);
    if (!located) return;
    announce(clamped);
    applyFrame(clamped, located.index);
  }

  function advance(): void {
    const nextIndex = activeIndex + 1;
    if (nextIndex >= plan.segments.length) {
      setPlaying(false);
      setPlayhead(plan.totalFrames);
      announce(plan.totalFrames);
      return;
    }
    const start = plan.segments[nextIndex]?.timelineStart ?? plan.totalFrames;
    setActiveIndex(nextIndex);
    setPlayhead(start);
    announce(start);
  }

  function togglePlayback(): void {
    if (!active && plan.segments[0]) {
      setActiveIndex(0);
      setPlayhead(0);
      return;
    }
    const nextPlaying = !playing;
    setPlaying(nextPlaying);
    onPlayingChange?.(nextPlaying);
    if (nextPlaying && canPlayMedia && videoRef.current) {
      videoRef.current.currentTime = ((active?.sourceStart ?? 0) + activeOffset) / plan.fps;
      void videoRef.current.play().catch(() => setPlaying(false));
    } else if (!nextPlaying) {
      videoRef.current?.pause();
    }
  }

  return <section className={`viewer viewer-${variant}`} aria-label={label ?? 'Commit video preview'}>
    <div className="viewer-stage" style={{ aspectRatio: `${plan.width} / ${plan.height}` }}>
      <video
        ref={videoRef}
        playsInline
        onLoadedMetadata={() => {
          const video = videoRef.current;
          if (!video || !active) return;
          video.currentTime = (active.sourceStart + Math.max(0, playhead - active.timelineStart)) / plan.fps;
          if (playing) void video.play().catch(() => setPlaying(false));
        }}
        onTimeUpdate={() => {
          const video = videoRef.current;
          if (!video || !active) return;
          const elapsed = Math.max(0, video.currentTime * plan.fps - active.sourceStart);
          const next = active.timelineStart + elapsed;
          if (elapsed >= active.duration - 0.25) advance();
          else {
            setPlayhead(next);
            announce(next);
          }
        }}
        onEnded={advance}
      />
      <div className="viewer-timecode">{framesToTimecode(playhead, plan.fps)}</div>
      <div className="viewer-badge">
        <em>{plan.commitId.slice(0, 8)}</em>
        <span>{displayLabel}</span>
      </div>
      {!canPlayMedia && <div className="viewer-overlay">
        <span className="viewer-kicker">COMMIT {plan.commitId.slice(0, 8)}</span>
        <strong>{displayLabel}</strong>
        {!active?.available && active?.assetFingerprint && onRelink && <button onClick={() => {
          if (active.assetFingerprint) onRelink(active.assetFingerprint);
        }}>Locate media</button>}
      </div>}
    </div>
    <div className="transport">
      <button
        className="play-button"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={togglePlayback}
        disabled={plan.segments.length === 0}
      >{playing ? '❚❚' : '►'}</button>
      <span>{framesToTimecode(playhead, plan.fps)}</span>
      <input
        aria-label="Preview playhead"
        type="range"
        min="0"
        max={Math.max(1, plan.totalFrames - 1)}
        step="1"
        value={Math.min(playhead, Math.max(1, plan.totalFrames - 1))}
        onChange={(event) => seek(Number(event.target.value))}
      />
      <span>{framesToTimecode(plan.totalFrames, plan.fps)}</span>
    </div>
    {variant === 'full' && <div className="viewer-meta">
      <span>{plan.videoTrackName ?? 'No video track'}</span>
      <span>{plan.width}×{plan.height}</span>
      <span>{plan.fps.toFixed(3).replace(/\.?0+$/u, '')} fps</span>
      <span>{plan.missingAssets.length
        ? `${plan.missingAssets.length} media file${plan.missingAssets.length === 1 ? '' : 's'} offline`
        : 'All media linked'}</span>
    </div>}
  </section>;
}
