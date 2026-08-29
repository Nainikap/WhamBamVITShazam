import { useEffect, useMemo, useRef, useState } from 'react';
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
}

export function CommitPlayer({ plan, onRelink, variant = 'full', label, onPlayheadChange, playhead: external }: CommitPlayerProps) {
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

  useEffect(() => {
    onPlayheadChange?.(playhead);
  }, [playhead]);

  useEffect(() => {
    if (external === undefined || Math.abs(external - playhead) < 0.5) return;
    const located = segmentAt(plan, external);
    setPlayhead(external);
    if (located && located.index !== activeIndex) setActiveIndex(located.index);
  }, [external]);

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

  useEffect(() => {
    if (!playing || canPlayMedia || !active) return undefined;
    const interval = window.setInterval(() => {
      setPlayhead((current) => {
        const next = current + plan.fps / 10;
        const end = active.timelineStart + active.duration;
        if (next < end) return next;
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
    setPlayhead(clamped);
    if (located.index !== activeIndex) {
      setActiveIndex(located.index);
      return;
    }
    if (located.segment.available && videoRef.current) {
      videoRef.current.currentTime = (located.segment.sourceStart + clamped - located.segment.timelineStart) / plan.fps;
    }
  }

  function advance(): void {
    const nextIndex = activeIndex + 1;
    if (nextIndex >= plan.segments.length) {
      setPlaying(false);
      setPlayhead(plan.totalFrames);
      return;
    }
    setActiveIndex(nextIndex);
    setPlayhead(plan.segments[nextIndex]?.timelineStart ?? plan.totalFrames);
  }

  function togglePlayback(): void {
    if (!active && plan.segments[0]) {
      setActiveIndex(0);
      setPlayhead(0);
      return;
    }
    const nextPlaying = !playing;
    setPlaying(nextPlaying);
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
          else setPlayhead(next);
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
