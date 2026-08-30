import { ArrowRight, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { TimelineComparison } from '../application';
import type { CommitInfo } from '../git';
import type { TimelineDiffSegment, TimelineDiffTrack } from '../preview';
import { Badge } from '@/components/ui/badge';
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

const fieldLabel: Record<string, string> = {
  trim: 'in/out point',
  position: 'timeline position',
  footage: 'source footage',
  gain: 'level',
  look: 'look',
  name: 'name',
  text: 'caption text',
  enabled: 'enabled state',
  markers: 'markers',
  effects: 'effects',
  settings: 'editor settings',
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
    <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">{label}</span>
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

function Lane({ track, laneFrames, fps }: { track: TimelineDiffTrack; laneFrames: number; fps: number }) {
  const total = Math.max(1, laneFrames);
  const counts = tally(track.segments);
  return <div className="grid grid-cols-[7rem_minmax(0,1fr)_6.5rem] overflow-hidden rounded-md border border-border">
    <div className="flex flex-col justify-center border-r border-border bg-card px-2.5 py-2">
      <strong className="line-clamp-2 text-[11px] leading-tight">{track.name}</strong>
      <small className="font-mono text-[8px] tracking-widest text-muted-foreground">{track.kind.toUpperCase()}</small>
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
              'bg-[repeating-linear-gradient(135deg,hsl(var(--removed)/0.55)_0_5px,hsl(var(--removed)/0.3)_5px_10px)]': part.change === 'removed',
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
  onSelectBase(id: string): void;
  onSelectHead(id: string): void;
  onClose(): void;
}

export function DiffView({ comparison, history, onSelectBase, onSelectHead, onClose }: DiffViewProps) {
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const { diff } = comparison;
  const changed = useMemo(
    () => diff.tracks.flatMap((track) => track.segments
      .filter((segment) => segment.change !== 'unchanged')
      .map((segment) => ({ track, segment }))),
    [diff],
  );
  const totals = useMemo(() => tally(diff.tracks.flatMap(({ segments }) => segments)), [diff]);
  const identical = changed.length === 0;

  return <section aria-label="Commit comparison" className="flex flex-col gap-3">
    <Card className="flex flex-wrap items-end gap-4 p-3">
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

    <div className="grid grid-cols-2 gap-3">
      {[comparison.base, comparison.head].map((side, index) => <div key={side.commit.id + index} className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
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
        />
      </div>)}
    </div>

    <Card className="p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Timeline differences</h3>
        <span className="flex gap-2.5 font-mono text-[10px]">
          <span className="text-added">+{diff.counts.addedFrames}f added</span>
          <span className="text-removed">−{diff.counts.removedFrames}f cut</span>
          <span className="text-retimed">{totals.trimmed} trimmed</span>
          <span className="text-retimed">{totals.moved} moved</span>
          <span className="text-edited">{totals.edited} edited</span>
        </span>
      </div>
      {identical
        ? <p className="text-xs text-muted-foreground">
          These two commits hold an identical timeline on every video and audio track.
        </p>
        : <div className="flex flex-col gap-1.5">
          {diff.tracks.map((track) => <Lane key={track.id} track={track} laneFrames={diff.laneFrames} fps={diff.fps} />)}
        </div>}
    </Card>

    {!identical && <Card className="p-3">
      <h3 className="mb-3 text-sm font-semibold">What changed</h3>
      <ul className="flex flex-col gap-1.5">
        {changed.map(({ track, segment }) => {
          const tone = toneOf(segment);
          return <li
            key={`${track.id}-${segment.id}`}
            className={cn('flex items-center gap-3 rounded-md border-l-2 bg-secondary/60 px-3 py-2', {
              'border-l-added': tone === 'added',
              'border-l-removed': tone === 'removed',
              'border-l-retimed': tone === 'trimmed' || tone === 'moved',
              'border-l-edited': tone === 'edited',
            })}
          >
            <Badge variant={tone === 'trimmed' || tone === 'moved' ? 'retimed' : tone === 'unchanged' ? 'outline' : tone}>
              {toneLabel[tone]}
            </Badge>
            <div className="flex min-w-0 flex-col gap-0.5">
              <strong className="truncate text-xs">{track.name} · {segment.name}</strong>
              <small className="font-mono text-[10px] text-muted-foreground">{timing(segment, diff.fps)}</small>
              {frameSummary(segment, diff.fps) && <small className="font-mono text-[10px]">{frameSummary(segment, diff.fps)}</small>}
              {segment.changedFields.length > 0 && <small className="text-[10px] text-muted-foreground">
                {segment.changedFields.map((field) => fieldLabel[field] ?? field).join(', ')}
              </small>}
            </div>
          </li>;
        })}
      </ul>
    </Card>}
  </section>;
}
