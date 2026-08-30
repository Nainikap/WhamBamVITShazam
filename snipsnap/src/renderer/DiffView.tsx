import { ArrowRight, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { TimelineComparison } from '../application';
import type { SemanticHunk } from '../diff';
import type { CommitInfo } from '../git';
import type { TimelineChangeField, TimelineDiffSegment, TimelineDiffTrack } from '../preview';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { CommitPlayer } from './CommitPlayer';
import { framesToTimecode, relativeTime, shortId } from './format';

/**
 * Footage that only one commit holds is green or red at the exact frames that
 * differ. Only a whole item that moved without gaining or losing frames gets
 * the timestamp colour, and edits that change no timing get their own.
 */
type Tone = 'added' | 'removed' | 'trimmed' | 'moved' | 'edited' | 'unchanged';

function toneOf(segment: TimelineDiffSegment): Tone {
  if (segment.change === 'added' || segment.change === 'removed') return segment.change;
  if (segment.addedFrames > 0 || segment.removedFrames > 0) return 'trimmed';
  if (segment.changedFields.includes('position')) return 'moved';
  return segment.change === 'modified' ? 'edited' : 'unchanged';
}

const toneLabel: Record<Tone, string> = {
  added: 'added',
  removed: 'removed',
  trimmed: 'trimmed',
  moved: 'moved',
  edited: 'edited',
  unchanged: 'unchanged',
};

function frameSummary(segment: TimelineDiffSegment, fps: number): string | null {
  const parts: string[] = [];
  const seconds = (frames: number) => `${(frames / (fps || 1)).toFixed(2).replace(/\.?0+$/u, '')}s`;
  if (segment.addedFrames > 0) parts.push(`+${segment.addedFrames} frames (${seconds(segment.addedFrames)}) of new footage`);
  if (segment.removedFrames > 0) parts.push(`−${segment.removedFrames} frames (${seconds(segment.removedFrames)}) cut`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function timing(segment: TimelineDiffSegment, fps: number): string {
  const range = (state: { timelineStart: number; duration: number } | undefined) => (state
    ? `${framesToTimecode(state.timelineStart, fps)} → ${framesToTimecode(state.timelineStart + state.duration, fps)}`
    : '—');
  if (segment.change === 'added') return `new at ${range(segment.after)}`;
  if (segment.change === 'removed') return `was at ${range(segment.before)}`;
  if (segment.change === 'modified') return `${range(segment.before)}  ⇒  ${range(segment.after)}`;
  return range(segment.after);
}

function RevisionPicker({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: CommitInfo[];
  onChange(id: string): void;
}) {
  return <div className="flex min-w-0 flex-1 flex-col gap-1">
    <span className="font-mono text-[9px] tracking-widest text-muted-foreground">{label}</span>
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map((commit) => <SelectItem key={commit.id} value={commit.id}>
          {shortId(commit.id)} · {commit.message}
        </SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}

function tally(segments: TimelineDiffSegment[]): Record<Tone, number> {
  const counts: Record<Tone, number> = { added: 0, removed: 0, trimmed: 0, moved: 0, edited: 0, unchanged: 0 };
  for (const segment of segments) counts[toneOf(segment)] += 1;
  return counts;
}

/** Start just before the first frame that actually differs, not at the clip's unchanged head. */
function previewFocusFrame(segment: TimelineDiffSegment, fps: number): number {
  const changedPart = segment.parts.find(({ change }) => change !== 'kept');
  const changeStart = changedPart?.laneStart
    ?? segment.after?.timelineStart
    ?? segment.before?.timelineStart
    ?? segment.laneStart;
  return Math.max(0, changeStart - Math.max(1, Math.round(fps)));
}

function hunkEntityIds(hunk: SemanticHunk): Set<string> {
  const ids = new Set([hunk.entityId]);
  const visit = (part: SemanticHunk) => {
    ids.add(part.entityId);
    part.parts?.forEach(visit);
  };
  hunk.parts?.forEach(visit);
  return ids;
}

const semanticFieldMap: Record<string, TimelineChangeField> = {
  sourceRange: 'trim',
  range: 'trim',
  durationFrames: 'trim',
  split: 'trim',
  itemIds: 'position',
  trackIds: 'position',
  trackId: 'position',
  assetId: 'footage',
  fingerprint: 'footage',
  gainDb: 'gain',
  preset: 'look',
  name: 'name',
  text: 'text',
  enabled: 'enabled',
  markers: 'markers',
  effects: 'effects',
  extras: 'settings',
};

function hunkFields(hunk: SemanticHunk): Set<TimelineChangeField> {
  const fields = new Set<TimelineChangeField>();
  const visit = (part: SemanticHunk) => {
    part.fieldGroup.split('+').forEach((field) => {
      const mapped = semanticFieldMap[field];
      if (mapped) fields.add(mapped);
    });
    part.parts?.forEach(visit);
  };
  visit(hunk);
  return fields;
}

/** Remove unrelated clip fields when one atomic semantic hunk is focused. */
function segmentForHunk(segment: TimelineDiffSegment, hunk: SemanticHunk): TimelineDiffSegment {
  if (hunk.operation === 'add' || hunk.operation === 'delete' || hunk.fieldGroup === 'structure') return segment;
  const fields = hunkFields(hunk);
  const changedFields = segment.changedFields.filter((field) => fields.has(field));
  const retainsFrameDelta = changedFields.includes('trim');
  return {
    ...segment,
    changedFields,
    timingChanged: changedFields.includes('trim') || changedFields.includes('position'),
    addedFrames: retainsFrameDelta ? segment.addedFrames : 0,
    removedFrames: retainsFrameDelta ? segment.removedFrames : 0,
    parts: retainsFrameDelta ? segment.parts : [{
      change: 'kept',
      laneStart: segment.laneStart,
      laneDuration: segment.laneDuration,
      contentStart: segment.after?.sourceStart ?? segment.before?.sourceStart ?? 0,
    }],
  };
}

function Lane({ track, laneFrames, fps }: { track: TimelineDiffTrack; laneFrames: number; fps: number }) {
  const total = Math.max(1, laneFrames);
  const counts = tally(track.segments);
  return <div className="grid grid-cols-[7rem_minmax(0,1fr)_6.5rem] overflow-hidden rounded-md border border-border">
    <div className="flex flex-col justify-center border-r border-border bg-card px-2.5 py-2">
      <strong className="line-clamp-2 text-[11px] leading-tight">{track.name}</strong>
      <small className="font-mono text-[8px] tracking-widest text-muted-foreground">
        {track.kind.charAt(0).toUpperCase() + track.kind.slice(1)}
      </small>
    </div>
    <div className="relative h-11 bg-black/30">
      {track.segments.map((segment) => {
        const tone = toneOf(segment);
        return <span
          key={segment.id}
          className={cn('absolute inset-y-1.5 flex items-center overflow-hidden rounded border', {
            'border-added': tone === 'added',
            'border-removed': tone === 'removed',
            'border-retimed': tone === 'trimmed' || tone === 'moved',
            'border-edited': tone === 'edited',
            'border-white/10': tone === 'unchanged',
          })}
          style={{
            left: `${(segment.laneStart / total) * 100}%`,
            width: `${(segment.laneDuration / total) * 100}%`,
          }}
          title={`${segment.name} — ${toneLabel[tone]} · ${timing(segment, fps)}${frameSummary(segment, fps) ? ` · ${frameSummary(segment, fps)}` : ''}`}
        >
          {segment.parts.map((part) => <i
            key={`${part.change}-${part.laneStart}`}
            className={cn('diff-part absolute inset-y-0 block', `part-${part.change}`, {
              'bg-removed/45': part.change === 'removed',
              'bg-added/35': part.change === 'added',
              'bg-secondary': part.change === 'kept' && tone !== 'moved' && tone !== 'edited',
              'bg-retimed/30': part.change === 'kept' && tone === 'moved',
              'bg-edited/30': part.change === 'kept' && tone === 'edited',
            })}
            style={{
              left: `${((part.laneStart - segment.laneStart) / Math.max(1, segment.laneDuration)) * 100}%`,
              width: `${(part.laneDuration / Math.max(1, segment.laneDuration)) * 100}%`,
            }}
          />)}
          <span className="relative z-10 truncate px-1.5 text-[10px] drop-shadow">{segment.name}</span>
        </span>;
      })}
    </div>
    <div className="flex items-center justify-end gap-1.5 border-l border-border bg-card px-2 font-mono text-[10px]">
      {counts.added > 0 && <span className="text-added">+{counts.added}</span>}
      {counts.trimmed > 0 && <span className="text-retimed">✂{counts.trimmed}</span>}
      {counts.moved > 0 && <span className="text-retimed">↔{counts.moved}</span>}
      {counts.edited > 0 && <span className="text-edited">~{counts.edited}</span>}
      {counts.removed > 0 && <span className="text-removed">−{counts.removed}</span>}
      {track.change === 'unchanged' && <span className="text-muted-foreground">no change</span>}
    </div>
  </div>;
}

export interface DiffViewProps {
  comparison: TimelineComparison;
  history: CommitInfo[];
  selectedHunkId: string | null;
  onSelectBase(id: string): void;
  onSelectHead(id: string): void;
  onClose(): void;
}

export function DiffView({
  comparison,
  history,
  selectedHunkId,
  onSelectBase,
  onSelectHead,
  onClose,
}: DiffViewProps) {
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const { diff } = comparison;
  const changed = useMemo(
    () => diff.tracks.flatMap((track) => track.segments
      .filter((segment) => segment.change !== 'unchanged')
      .map((segment) => ({ track, segment }))),
    [diff],
  );
  const selectedHunk = comparison.hunks.find(({ id }) => id === selectedHunkId) ?? null;
  const visibleTracks = useMemo(() => {
    if (!selectedHunk) return diff.tracks;
    const entityIds = hunkEntityIds(selectedHunk);
    return diff.tracks.flatMap((track) => {
      const matched = track.segments
        .filter((segment) => entityIds.has(segment.id))
        .map((segment) => segmentForHunk(segment, selectedHunk));
      if (matched.length > 0) return [{ ...track, segments: matched }];
      if (entityIds.has(track.id)) {
        return [{ ...track, segments: track.segments.filter(({ change }) => change !== 'unchanged') }];
      }
      return [];
    });
  }, [diff.tracks, selectedHunk]);
  const visibleSegments = useMemo(() => visibleTracks.flatMap(({ segments }) => segments), [visibleTracks]);
  const totals = useMemo(() => tally(visibleSegments), [visibleSegments]);
  const identicalTimeline = changed.length === 0;
  const sharedPlaybackEnd = Math.min(comparison.base.plan.totalFrames, comparison.head.plan.totalFrames);

  useEffect(() => {
    setPlayhead(0);
    setPlaying(false);
  }, [comparison.base.commit.id, comparison.head.commit.id]);

  useEffect(() => {
    setPlaying(false);
    if (!selectedHunk) {
      const firstDifference = changed
        .map(({ segment }) => previewFocusFrame(segment, diff.fps))
        .sort((left, right) => left - right)[0];
      setPlayhead(firstDifference ?? 0);
      return;
    }
    const ids = hunkEntityIds(selectedHunk);
    const segment = changed.find((entry) => ids.has(entry.segment.id))?.segment;
    if (segment) setPlayhead(previewFocusFrame(segment, diff.fps));
  }, [changed, diff.fps, selectedHunk]);

  return <section aria-label="Commit comparison" className="vg-diff-colors flex flex-col gap-3">
    <Card className="vg-diff-toolbar flex flex-wrap items-end gap-4 p-3">
      <div className="flex min-w-0 flex-[1_1_26rem] items-end gap-2">
        <RevisionPicker label="Base" value={comparison.base.commit.id} options={history} onChange={onSelectBase} />
        <ArrowRight className="mb-2.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <RevisionPicker label="Compare" value={comparison.head.commit.id} options={history} onChange={onSelectHead} />
      </div>
      <div className="ml-auto flex items-center gap-3">
        <div className="flex flex-wrap items-center gap-2.5 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-added" />added</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-removed" />removed</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-retimed" />retimed</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-edited" />other edit</span>
        </div>
        <Button variant="secondary" aria-label="Close comparison" onClick={onClose}><X />Close diff</Button>
      </div>
    </Card>

    <div className="vg-diff-previews grid grid-cols-2 gap-3">
      {[comparison.base, comparison.head].map((side, index) => <div key={side.commit.id + index} className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-[9px] tracking-widest text-muted-foreground">
            {index === 0 ? 'Base' : 'Compared'}
          </span>
          <strong className="truncate text-sm">{side.commit.message}</strong>
          <small className="font-mono text-[10px] text-muted-foreground">
            {shortId(side.commit.id)} · {relativeTime(side.commit.authoredAt)}
          </small>
        </div>
        <CommitPlayer
          plan={side.plan}
          variant="compact"
          label={`${index === 0 ? 'Base' : 'Compared'} commit video preview`}
          playhead={playhead}
          onPlayheadChange={setPlayhead}
          playing={playing}
          onPlayingChange={setPlaying}
          playbackLimit={sharedPlaybackEnd}
        />
      </div>)}
    </div>

    <Card className="p-3">
      <div className="vg-diff-summary mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Timeline differences</h3>
          <p aria-live="polite" className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {selectedHunk ? `Focused change: ${selectedHunk.message}` : `Whole commit: ${comparison.hunks.length} change${comparison.hunks.length === 1 ? '' : 's'} together`}
          </p>
        </div>
        <span className="flex gap-2.5 font-mono text-[10px]">
          <span className="text-added">+{visibleSegments.reduce((sum, segment) => sum + segment.addedFrames, 0)}f added</span>
          <span className="text-removed">−{visibleSegments.reduce((sum, segment) => sum + segment.removedFrames, 0)}f cut</span>
          <span className="text-retimed">{totals.trimmed} trimmed</span>
          <span className="text-retimed">{totals.moved} moved</span>
          <span className="text-edited">{totals.edited} edited</span>
        </span>
      </div>
      {selectedHunk && visibleTracks.length === 0
        ? <p className="text-xs text-muted-foreground">
          This project-level change has no frame range to highlight. The two complete commit previews remain available above.
        </p>
        : identicalTimeline
        ? <p className="text-xs text-muted-foreground">
          These two commits hold an identical timeline on every video and audio track.
        </p>
        : <div className="flex flex-col gap-1.5">
          {visibleTracks.map((track) => <Lane key={track.id} track={track} laneFrames={diff.laneFrames} fps={diff.fps} />)}
        </div>}
    </Card>

  </section>;
}
