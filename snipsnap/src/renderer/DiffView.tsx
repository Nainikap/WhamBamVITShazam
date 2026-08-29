import { useMemo, useState } from 'react';
import type { TimelineComparison } from '../application';
import type { CommitInfo } from '../git';
import type { TimelineDiffSegment, TimelineDiffTrack } from '../preview';
import { CommitPlayer } from './CommitPlayer';
import { framesToTimecode, relativeTime, shortId } from './format';

/** Retiming earns the timestamp colour; other edits get their own, quieter one. */
type Tone = 'added' | 'removed' | 'retimed' | 'edited' | 'unchanged';

function toneOf(segment: TimelineDiffSegment): Tone {
  if (segment.change === 'modified') return segment.timingChanged ? 'retimed' : 'edited';
  return segment.change;
}

const toneLabel: Record<Tone, string> = {
  added: 'added',
  removed: 'removed',
  retimed: 'retimed',
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
};

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
  return <label className="revision-picker">
    <span>{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
      {options.map((commit) => <option key={commit.id} value={commit.id}>
        {shortId(commit.id)} · {commit.message}
      </option>)}
    </select>
  </label>;
}

function tally(segments: TimelineDiffSegment[]): Record<Tone, number> {
  const counts: Record<Tone, number> = { added: 0, removed: 0, retimed: 0, edited: 0, unchanged: 0 };
  for (const segment of segments) counts[toneOf(segment)] += 1;
  return counts;
}

function Lane({ track, laneFrames, fps }: { track: TimelineDiffTrack; laneFrames: number; fps: number }) {
  const total = Math.max(1, laneFrames);
  const counts = tally(track.segments);
  return <div className={`diff-lane-row diff-lane-${track.change}`}>
    <div className="lane-head">
      <strong>{track.name}</strong>
      <small>{track.kind.toUpperCase()}</small>
    </div>
    <div className="lane">
      {track.segments.map((segment) => <span
        key={segment.id}
        className={`chip diff-chip diff-${toneOf(segment)}`}
        style={{
          left: `${(segment.laneStart / total) * 100}%`,
          width: `${(segment.laneDuration / total) * 100}%`,
        }}
        title={`${segment.name} — ${toneLabel[toneOf(segment)]} · ${timing(segment, fps)}`}
      >
        <span className="chip-label">{segment.name}</span>
      </span>)}
    </div>
    <div className="lane-tally">
      {counts.added > 0 && <em className="diff-added">+{counts.added}</em>}
      {counts.retimed > 0 && <em className="diff-retimed">↔{counts.retimed}</em>}
      {counts.edited > 0 && <em className="diff-edited">~{counts.edited}</em>}
      {counts.removed > 0 && <em className="diff-removed">−{counts.removed}</em>}
      {track.change === 'unchanged' && <em className="diff-none">no change</em>}
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

  return <section className="diff-view" aria-label="Commit comparison">
    <header className="diff-header">
      <div className="diff-pickers">
        <RevisionPicker label="Base" value={comparison.base.commit.id} options={history} onChange={onSelectBase} />
        <span className="diff-arrow">→</span>
        <RevisionPicker label="Compare" value={comparison.head.commit.id} options={history} onChange={onSelectHead} />
      </div>
      <div className="diff-legend">
        <span><i className="swatch diff-added" />added footage</span>
        <span><i className="swatch diff-retimed" />changed timestamp</span>
        <span><i className="swatch diff-removed" />removed footage</span>
        <span><i className="swatch diff-edited" />other edit</span>
      </div>
      <button onClick={onClose} aria-label="Close comparison">Close diff</button>
    </header>

    <div className="diff-split">
      {[comparison.base, comparison.head].map((side, index) => <div className="diff-side" key={side.commit.id + index}>
        <div className="diff-side-head">
          <span className="eyebrow">{index === 0 ? 'BASE' : 'COMPARED'}</span>
          <strong>{side.commit.message}</strong>
          <small><code>{shortId(side.commit.id)}</code> · {relativeTime(side.commit.authoredAt)}</small>
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

    <div className="diff-lanes">
      <div className="diff-lanes-head">
        <h3>Timeline differences</h3>
        <span className="diff-counts">
          <em className="diff-added">{totals.added} added</em>
          <em className="diff-retimed">{totals.retimed} retimed</em>
          <em className="diff-edited">{totals.edited} edited</em>
          <em className="diff-removed">{totals.removed} removed</em>
        </span>
      </div>
      {identical
        ? <p className="muted">These two commits hold an identical timeline on every video and audio track.</p>
        : diff.tracks.map((track) => <Lane key={track.id} track={track} laneFrames={diff.laneFrames} fps={diff.fps} />)}
    </div>

    {!identical && <div className="diff-details">
      <h3>What changed</h3>
      <ul>
        {changed.map(({ track, segment }) => <li key={`${track.id}-${segment.id}`} className={`diff-detail diff-${toneOf(segment)}`}>
          <span className={`badge diff-${toneOf(segment)}`}>{toneLabel[toneOf(segment)]}</span>
          <div>
            <strong>{track.name} · {segment.name}</strong>
            <small>{timing(segment, diff.fps)}</small>
            {segment.changedFields.length > 0 && <small className="fields">
              {segment.changedFields.map((field) => fieldLabel[field] ?? field).join(', ')}
            </small>}
          </div>
        </li>)}
      </ul>
    </div>}
  </section>;
}
