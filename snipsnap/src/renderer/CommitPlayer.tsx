import { useEffect, useMemo, useRef, useState } from 'react';
import type { PreviewPlan, PreviewSegment } from '../preview';

function timecode(frame: number, fps: number): string {
  const roundedFps = Math.max(1, Math.round(fps));
  const totalSeconds = Math.floor(frame / fps);
  const frames = Math.floor(frame % roundedFps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, minutes, seconds].map((value) => value.toString().padStart(2, '0')).join(':')
    + `:${frames.toString().padStart(2, '0')}`;
}

function segmentAt(plan: PreviewPlan, frame: number): { segment: PreviewSegment; index: number } | null {
  const index = plan.segments.findIndex((segment) => frame >= segment.timelineStart
    && frame < segment.timelineStart + segment.duration);
  const fallback = plan.segments.at(-1);
  if (index >= 0) return { segment: plan.segments[index] as PreviewSegment, index };
  return fallback ? { segment: fallback, index: plan.segments.length - 1 } : null;
}

export function CommitPlayer({ plan, onRelink }: { plan: PreviewPlan; onRelink(fingerprint: string): void }) {
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

  return <section className="viewer" aria-label="Commit video preview">
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
      {(!canPlayMedia || !playing) && <div className="viewer-overlay">
        <span className="viewer-kicker">COMMIT {plan.commitId.slice(0, 8)}</span>
        <strong>{displayLabel}</strong>
        {!active?.available && active?.assetFingerprint && <button onClick={() => {
          if (active.assetFingerprint) onRelink(active.assetFingerprint);
        }}>Locate media</button>}
      </div>}
    </div>
    <div className="transport">
      <button className="play-button" onClick={togglePlayback} disabled={plan.segments.length === 0}>{playing ? 'Pause' : 'Play'}</button>
      <span>{timecode(playhead, plan.fps)}</span>
      <input
        aria-label="Preview playhead"
        type="range"
        min="0"
        max={Math.max(1, plan.totalFrames - 1)}
        step="1"
        value={Math.min(playhead, Math.max(1, plan.totalFrames - 1))}
        onChange={(event) => seek(Number(event.target.value))}
      />
      <span>{timecode(plan.totalFrames, plan.fps)}</span>
    </div>
    <div className="segment-strip" aria-label="Preview segments">
      {plan.segments.map((segment, index) => <button
        key={segment.id}
        className={`${segment.kind} ${index === activeIndex ? 'active' : ''} ${segment.available ? '' : 'offline'}`}
        style={{ flexGrow: segment.duration }}
        onClick={() => seek(segment.timelineStart)}
        title={`${segment.name} · ${segment.duration} frames`}
      ><span>{segment.name}</span></button>)}
    </div>
    <div className="viewer-meta">
      <span>{plan.videoTrackName ?? 'No video track'}</span>
      <span>{plan.fps.toFixed(3).replace(/\.000$/u, '')} fps</span>
      <span>{plan.missingAssets.length ? `${plan.missingAssets.length} media file${plan.missingAssets.length === 1 ? '' : 's'} offline` : 'All media linked'}</span>
    </div>
  </section>;
}
