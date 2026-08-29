import { Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PreviewPlan, PreviewSegment } from '../preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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

  return <section
    className={cn('viewer flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-black/60')}
    aria-label={label ?? 'Commit video preview'}
  >
    <div
      className={cn(
        'relative shrink-0 overflow-hidden bg-black',
        // A fixed box with object-contain letterboxes any aspect ratio without
        // the stage growing past the transport underneath it.
        variant === 'full' ? 'h-[44vh]' : 'h-[26vh]',
      )}
    >
      <video
        ref={videoRef}
        playsInline
        className="h-full w-full object-contain"
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
      <div className="pointer-events-none absolute left-2.5 top-2.5 flex items-center gap-2 rounded bg-black/70 px-2 py-1 font-mono text-[10px]">
        <span className="text-primary">{plan.commitId.slice(0, 8)}</span>
        <span className="max-w-[22rem] truncate text-foreground/80">{displayLabel}</span>
      </div>
      <div className="pointer-events-none absolute right-2.5 top-2.5 rounded bg-black/70 px-2 py-1 font-mono text-[10px] text-foreground/80">
        {framesToTimecode(playhead, plan.fps)}
      </div>
      {!canPlayMedia && <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 p-6 text-center">
        <strong className="text-sm">{displayLabel}</strong>
        {!active?.available && active?.assetFingerprint && onRelink && <Button variant="secondary" size="sm" onClick={() => {
          if (active.assetFingerprint) onRelink(active.assetFingerprint);
        }}>Locate media</Button>}
      </div>}
    </div>

    <div className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-2">
      <Button
        size="icon"
        variant="default"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={togglePlayback}
        disabled={plan.segments.length === 0}
        className="h-7 w-7"
      >{playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</Button>
      <span className="w-[4.5rem] shrink-0 font-mono text-[10px] text-muted-foreground">{framesToTimecode(playhead, plan.fps)}</span>
      <input
        aria-label="Preview playhead"
        type="range"
        min="0"
        max={Math.max(1, plan.totalFrames - 1)}
        step="1"
        value={Math.min(playhead, Math.max(1, plan.totalFrames - 1))}
        onChange={(event) => seek(Number(event.target.value))}
        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
      />
      <span className="w-[4.5rem] shrink-0 text-right font-mono text-[10px] text-muted-foreground">{framesToTimecode(plan.totalFrames, plan.fps)}</span>
      {variant === 'full' && <Badge variant="outline" className="shrink-0">
        {plan.missingAssets.length ? `${plan.missingAssets.length} offline` : 'All media linked'}
      </Badge>}
    </div>
  </section>;
}
