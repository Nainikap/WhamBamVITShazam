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

const presetFilter: Record<NonNullable<PreviewSegment['preset']>, string> = {
  none: 'none',
  warm: 'sepia(0.2) saturate(1.12) hue-rotate(-7deg)',
  cool: 'saturate(0.92) hue-rotate(12deg)',
  mono: 'grayscale(1)',
};

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
  /** Linked players stop together at this timeline frame. */
  playbackLimit?: number;
}

export function CommitPlayer({
  plan, onRelink, variant = 'full', label,
  onPlayheadChange, playhead: external, onPlayingChange, playing: externalPlaying,
  playbackLimit,
}: CommitPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const holdCanvasRef = useRef<HTMLCanvasElement>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [holdingFrame, setHoldingFrame] = useState(false);
  const playheadRef = useRef(0);
  const displayedCommit = useRef(plan.commitId);
  const active = plan.segments[activeIndex];
  const canPlayMedia = active?.kind === 'clip' && active.available && Boolean(active.mediaUrl);
  const playbackEnd = Math.min(plan.totalFrames, playbackLimit ?? plan.totalFrames);

  useEffect(() => {
    setPlayhead(0);
    playheadRef.current = 0;
    setPlaying(false);
    setActiveIndex(0);
  }, [plan.commitId]);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const holdCurrentFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = holdCanvasRef.current;
    if (!video || !canvas || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    setHoldingFrame(true);
  }, []);

  // Track what this player last announced so an echo of our own value is ignored.
  const emitted = useRef<number | null>(null);
  const announce = useCallback((frame: number) => {
    emitted.current = frame;
    onPlayheadChange?.(frame);
  }, [onPlayheadChange]);

  const finishPlayback = useCallback((frame = playbackEnd) => {
    const end = Math.min(Math.max(frame, 0), plan.totalFrames);
    videoRef.current?.pause();
    setPlaying(false);
    setPlayhead(end);
    announce(end);
    onPlayingChange?.(false);
  }, [announce, onPlayingChange, plan.totalFrames, playbackEnd]);

  /** Move this player to a timeline frame, including the underlying media. */
  const applyFrame = useCallback((frame: number, index: number) => {
    const bounded = Math.min(Math.max(frame, 0), plan.totalFrames);
    setPlayhead(bounded);
    if (index !== activeIndex) {
      setActiveIndex(index);
      return;
    }
    const segment = plan.segments[index];
    const video = videoRef.current;
    if (!video || !segment || !segment.available) return;
    const segmentOffset = Math.min(
      Math.max(0, bounded - segment.timelineStart),
      Math.max(0, segment.duration - 0.25),
    );
    video.currentTime = (segment.sourceStart + segmentOffset) / plan.fps;
  }, [activeIndex, plan]);

  // An external playhead (a linked player, or the timeline being scrubbed) seeks
  // the media as well as the marker, and never echoes back as a new seek.
  useEffect(() => {
    if (external === undefined) return;
    if (emitted.current !== null && Math.abs(external - emitted.current) < 0.5) return;
    const bounded = Math.min(Math.max(external, 0), plan.totalFrames);
    if (Math.abs(bounded - playhead) < 0.5) return;
    const located = segmentAt(plan, bounded);
    emitted.current = external;
    applyFrame(bounded, located ? located.index : activeIndex);
  }, [external, applyFrame, plan]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const commitChanged = displayedCommit.current !== plan.commitId;
    displayedCommit.current = plan.commitId;
    const nextFrame = commitChanged ? active?.timelineStart ?? 0 : playheadRef.current;
    video.pause();
    if (!active?.mediaUrl || !active.available) {
      setHoldingFrame(false);
      video.removeAttribute('src');
      video.load();
      return;
    }
    const nextTime = (active.sourceStart + Math.max(0, nextFrame - active.timelineStart)) / plan.fps;
    const sourceChanged = video.getAttribute('src') !== active.mediaUrl;
    if (sourceChanged || commitChanged) holdCurrentFrame();
    video.volume = Math.min(1, Math.max(0, 10 ** (active.gainDb / 20)));
    if (sourceChanged) {
      video.src = active.mediaUrl;
      video.load();
      return;
    }
    if (Math.abs(video.currentTime - nextTime) < 0.01) {
      setHoldingFrame(false);
    } else {
      video.currentTime = nextTime;
    }
  }, [active?.id, active?.mediaUrl, active?.available, active?.gainDb, holdCurrentFrame, plan.commitId, plan.fps]);

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
        const end = Math.min(active.timelineStart + active.duration, playbackEnd);
        if (next < end) {
          announce(next);
          return next;
        }
        if (end >= playbackEnd) {
          window.setTimeout(() => finishPlayback(playbackEnd), 0);
          return playbackEnd;
        }
        const nextIndex = activeIndex + 1;
        if (nextIndex >= plan.segments.length) {
          window.setTimeout(() => finishPlayback(plan.totalFrames), 0);
          return plan.totalFrames;
        }
        setActiveIndex(nextIndex);
        return plan.segments[nextIndex]?.timelineStart ?? end;
      });
    }, 100);
    return () => window.clearInterval(interval);
  }, [active, activeIndex, announce, canPlayMedia, finishPlayback, plan.fps, plan.segments, plan.totalFrames, playbackEnd, playing]);

  const activeOffset = active ? Math.max(0, playhead - active.timelineStart) : 0;
  const displayLabel = useMemo(() => {
    if (!active) return 'No video track in this commit';
    if (active.kind === 'gap') return 'Timeline gap';
    // A title has no file behind it, which is not the same as one going missing.
    if (active.isGenerator) return `${active.name} · title`;
    return active.available ? active.name : `${active.name} · media offline`;
  }, [active]);
  const captions = useMemo(() => plan.tracks
    .filter(({ kind }) => kind === 'caption')
    .flatMap(({ segments }) => segments)
    .filter((segment) => segment.enabled !== false
      && segment.timelineStart <= playhead
      && playhead < segment.timelineStart + segment.duration), [plan.tracks, playhead]);

  function seek(frame: number): void {
    const clamped = Math.min(Math.max(frame, 0), Math.max(0, plan.totalFrames - 1));
    const located = segmentAt(plan, clamped);
    if (!located) return;
    announce(clamped);
    applyFrame(clamped, located.index);
  }

  function advance(): void {
    const nextIndex = activeIndex + 1;
    const nextStart = plan.segments[nextIndex]?.timelineStart ?? plan.totalFrames;
    if (nextIndex >= plan.segments.length || nextStart >= playbackEnd) {
      finishPlayback(playbackEnd);
      return;
    }
    setActiveIndex(nextIndex);
    setPlayhead(nextStart);
    announce(nextStart);
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
    className={cn(
      'viewer flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-black/60',
      // The full player owns its stage cell; the compact pair sizes itself.
      variant === 'full' ? 'flex-1' : 'shrink-0',
    )}
    aria-label={label ?? 'Commit video preview'}
    data-variant={variant}
  >
    <div
      aria-label="Preview video surface"
      tabIndex={0}
      onClick={(event) => event.currentTarget.focus()}
      onKeyDown={(event) => {
        if (event.code !== 'Space' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        togglePlayback();
      }}
      className={cn(
        'relative cursor-pointer overflow-hidden bg-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-edited',
        // The full surface flexes into whatever the stage grants while
        // object-contain letterboxes any aspect ratio; the compact pair keeps
        // a fixed box so the side-by-side comparison stays level.
        variant === 'full' ? 'min-h-0 flex-1' : 'h-[26vh] shrink-0',
      )}
    >
      <video
        ref={videoRef}
        playsInline
        className="h-full w-full object-contain"
        style={{ filter: presetFilter[active?.preset ?? 'none'] }}
        onLoadedMetadata={() => {
          const video = videoRef.current;
          if (!video || !active) return;
          video.currentTime = (active.sourceStart + Math.max(0, playhead - active.timelineStart)) / plan.fps;
          if (playing) void video.play().catch(() => setPlaying(false));
        }}
        onSeeked={() => {
          setHoldingFrame(false);
          if (playing) void videoRef.current?.play().catch(() => setPlaying(false));
        }}
        onTimeUpdate={() => {
          const video = videoRef.current;
          if (!video || !active) return;
          const elapsed = Math.max(0, video.currentTime * plan.fps - active.sourceStart);
          const next = active.timelineStart + elapsed;
          if (next >= playbackEnd - 0.25) finishPlayback(playbackEnd);
          else if (elapsed >= active.duration - 0.25) advance();
          else {
            setPlayhead(next);
            announce(next);
          }
        }}
        onEnded={advance}
      />
      <canvas
        ref={holdCanvasRef}
        aria-hidden="true"
        className={cn('pointer-events-none absolute inset-0 h-full w-full object-contain', !holdingFrame && 'hidden')}
      />
      {!canPlayMedia && <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 p-6 text-center">
        <strong className="text-sm">{displayLabel}</strong>
        {!active?.available && !active?.isGenerator && active?.assetFingerprint && onRelink && <Button variant="secondary" size="sm" onClick={() => {
          if (active.assetFingerprint) onRelink(active.assetFingerprint);
        }}>Locate media</Button>}
      </div>}
      {captions.length > 0 && <div className="pointer-events-none absolute inset-x-8 bottom-5 flex flex-col items-center gap-1 text-center">
        {captions.map((caption) => <span key={caption.id} className="max-w-full rounded bg-black/75 px-3 py-1 text-sm font-medium text-white shadow">
          {caption.text ?? caption.name}
        </span>)}
      </div>}
    </div>

    <div className="vg-player-controls flex shrink-0 items-center gap-3 border-t border-border px-3 py-2">
      <Button
        size="icon"
        variant="default"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={togglePlayback}
        disabled={plan.segments.length === 0}
        className="h-7 w-7"
      >{playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</Button>
      <span className="vg-player-current w-[4.5rem] shrink-0 font-mono text-[10px] text-muted-foreground">{framesToTimecode(playhead, plan.fps)}</span>
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
      <span className="vg-player-total w-[4.5rem] shrink-0 text-right font-mono text-[10px] text-muted-foreground">{framesToTimecode(plan.totalFrames, plan.fps)}</span>
      {variant === 'full' && <Badge variant="outline" className="vg-player-media shrink-0">
        {plan.missingAssets.length ? `${plan.missingAssets.length} offline` : 'All media linked'}
      </Badge>}
    </div>
  </section>;
}
