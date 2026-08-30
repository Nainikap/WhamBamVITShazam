import { useMemo } from 'react';
import type { SemanticHunk } from '../diff';
import type { CommitInfo } from '../git';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { layoutGraph, type GraphEdge } from './commit-graph-layout';
import { relativeTime } from './format';

const ROW = 56;
const COLUMN = 12;
const LEFT = 11;
/* Greys only: lanes are told apart by lightness, badges by their labels. */
const LANE_COLORS = ['#e8e8e8', '#adadad', '#7d7d7d', '#d0d0d0', '#5f5f5f'];

function laneX(lane: number): number {
  return LEFT + lane * COLUMN;
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length] ?? '#e8e8e8';
}

function commitDiffVariant(hunk: SemanticHunk): 'added' | 'removed' | 'retimed' | 'edited' {
  if (hunk.operation === 'add') return 'added';
  if (hunk.operation === 'delete') return 'removed';
  if (hunk.operation === 'reorder') return 'edited';
  return ['sourceRange', 'range', 'durationFrames', 'split'].includes(hunk.fieldGroup) ? 'retimed' : 'edited';
}

function commitDiffSelectionTone(hunk: SemanticHunk): string {
  return {
    added: 'bg-added-soft text-added',
    removed: 'bg-removed-soft text-removed',
    retimed: 'bg-retimed-soft text-retimed',
    edited: 'bg-edited-soft text-edited',
  }[commitDiffVariant(hunk)];
}

/** One row's slice of the lane artwork: arrivals, the dot, departures, pass-throughs. */
function RowGutter({ row, lane, head, merge, selected, edges, width }: {
  row: number;
  lane: number;
  head: boolean;
  merge: boolean;
  selected: boolean;
  edges: GraphEdge[];
  width: number;
}) {
  const mid = ROW / 2;
  const dotX = laneX(lane);
  const paths: Array<{ id: string; d: string; lane: number }> = [];
  for (const edge of edges) {
    const x = laneX(edge.lane);
    if (edge.from.row < row && edge.to.row > row) {
      paths.push({ id: `${edge.id}-through`, d: `M ${x} 0 L ${x} ${ROW}`, lane: edge.lane });
    }
    if (edge.to.row === row) {
      paths.push({
        id: `${edge.id}-in`,
        d: x === dotX
          ? `M ${x} 0 L ${dotX} ${mid}`
          : `M ${x} 0 C ${x} ${mid * 0.62}, ${dotX} ${mid * 0.38}, ${dotX} ${mid}`,
        lane: edge.lane,
      });
    }
    if (edge.from.row === row) {
      paths.push({
        id: `${edge.id}-out`,
        d: x === dotX
          ? `M ${dotX} ${mid} L ${x} ${ROW}`
          : `M ${dotX} ${mid} C ${dotX} ${mid + (ROW - mid) * 0.62}, ${x} ${mid + (ROW - mid) * 0.38}, ${x} ${ROW}`,
        lane: edge.lane,
      });
    }
  }
  return <svg aria-hidden="true" className="vg-graph-gutter" width={width} height={ROW} viewBox={`0 0 ${width} ${ROW}`}>
    {paths.map(({ id, d, lane: edgeLane }) => <path
      key={id}
      d={d}
      fill="none"
      stroke={laneColor(edgeLane)}
      strokeWidth="1.5"
      opacity="0.55"
    />)}
    {selected && <circle cx={dotX} cy={mid} r="8" fill="none" stroke={laneColor(lane)} strokeWidth="1.5" opacity="0.55" />}
    <circle cx={dotX} cy={mid} r={merge ? 5 : 4} fill={head ? laneColor(lane) : '#111113'} stroke={laneColor(lane)} strokeWidth="2" />
    {merge && <circle cx={dotX} cy={mid} r="1.5" fill={head ? '#111113' : laneColor(lane)} />}
  </svg>;
}

/** The lanes that must keep running underneath a row's expanded details. */
function ExpansionGutter({ row, edges, width }: { row: number; edges: GraphEdge[]; width: number }) {
  const lanes = new Set<number>();
  for (const edge of edges) {
    if (edge.from.row <= row && edge.to.row > row) lanes.add(edge.lane);
  }
  return <svg
    aria-hidden="true"
    className="vg-graph-gutter h-full"
    width={width}
    viewBox={`0 0 ${width} 10`}
    preserveAspectRatio="none"
  >
    {[...lanes].map((lane) => <path
      key={lane}
      d={`M ${laneX(lane)} 0 L ${laneX(lane)} 10`}
      fill="none"
      stroke={laneColor(lane)}
      strokeWidth="1.5"
      opacity="0.55"
      vectorEffect="non-scaling-stroke"
    />)}
  </svg>;
}

export interface CommitGraphProps {
  history: CommitInfo[];
  headCommit: string;
  selectedCommit: string;
  branches: Array<{ name: string; commitId: string }>;
  /** The commit whose changes are unfolded under its row, if any. */
  expandedCommitId: string | null;
  /** The selected revision's semantic changes, shown when its row is expanded. */
  changes: SemanticHunk[];
  diffOpen: boolean;
  selectedHunkId: string | null;
  onSelect(commit: CommitInfo): void;
  onShowAll(): void;
  onShowHunk(hunkId: string): void;
}

/**
 * The commit history as one VS Code-style graph: lanes and dots in a left
 * gutter, one row per commit, and a commit's semantic changes unfolding
 * inline under its node.
 */
export function CommitGraph({
  history, headCommit, selectedCommit, branches, expandedCommitId,
  changes, diffOpen, selectedHunkId, onSelect, onShowAll, onShowHunk,
}: CommitGraphProps) {
  const { placed, edges, lanes } = useMemo(() => layoutGraph(history), [history]);
  const gutterWidth = LEFT + Math.max(0, lanes - 1) * COLUMN + 11;
  const branchTips = useMemo(() => {
    const tips = new Map<string, string[]>();
    for (const { name, commitId } of branches) {
      tips.set(commitId, [...(tips.get(commitId) ?? []), name]);
    }
    return tips;
  }, [branches]);

  return <div className="vg-graph" role="list" aria-label="Commit graph">
    {placed.map((entry) => {
      const { commit, row, lane } = entry;
      const selected = commit.id === selectedCommit;
      const head = commit.id === headCommit;
      const merge = commit.parents.length > 1;
      const author = commit.author.replace(/\s*<[^>]*>/u, '');
      const expanded = selected && expandedCommitId === commit.id;
      return <div key={commit.id} role="listitem" className="min-w-0">
        <button
          type="button"
          aria-label={`View commit ${commit.message}`}
          aria-current={selected ? 'true' : undefined}
          aria-expanded={expanded}
          onClick={() => onSelect(commit)}
          title={`${commit.message} · ${commit.id.slice(0, 8)} · ${author} · ${relativeTime(commit.authoredAt)}`}
          className={cn(
            'vg-graph-row flex w-full min-w-0 items-stretch overflow-hidden rounded-md border text-left transition-colors',
            selected ? 'border-edited/45 bg-edited-soft/70' : 'border-transparent hover:border-border hover:bg-accent/70',
          )}
        >
          <RowGutter row={row} lane={lane} head={head} merge={merge} selected={selected} edges={edges} width={gutterWidth} />
          <span className="flex min-w-0 flex-1 flex-col justify-center gap-1 py-1.5 pr-2.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <strong className="min-w-0 flex-1 truncate text-[11px] font-medium">{commit.message}</strong>
              {(branchTips.get(commit.id) ?? []).map((name) => <Badge key={name} variant="info" className="max-w-[7rem] shrink-0 truncate">{name}</Badge>)}
              {head && <Badge variant="outline" className="shrink-0">Head</Badge>}
              {merge && <Badge variant="edited" className="shrink-0">merge</Badge>}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
              <code className="shrink-0 font-mono text-[9px] text-muted-foreground">{commit.id.slice(0, 8)}</code>
              <span className="min-w-0 flex-1 truncate text-[9px] text-muted-foreground">{author} · {relativeTime(commit.authoredAt)}</span>
            </span>
          </span>
        </button>

        {expanded && commit.parents.length > 0 && <div className="flex min-w-0 items-stretch">
          <span className="shrink-0" style={{ width: gutterWidth }}>
            <ExpansionGutter row={row} edges={edges} width={gutterWidth} />
          </span>
          <section
            aria-label={`Changes in commit ${commit.message}`}
            className="vg-diff-colors flex min-w-0 flex-1 flex-col gap-1 border-l border-border py-1 pl-2 pr-1"
          >
            <button
              type="button"
              aria-label={`View all changes in commit ${commit.message}`}
              aria-pressed={diffOpen && selectedHunkId === null}
              onClick={onShowAll}
              className={cn(
                'flex min-w-0 items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[10px] transition-colors hover:bg-accent',
                diffOpen && selectedHunkId === null && 'bg-edited-soft text-edited',
              )}
            >
              <span className="font-medium">All changes</span>
              <span className="font-mono text-[10px] text-muted-foreground">{changes.length}</span>
            </button>
            {changes.map((hunk) => <button
              key={hunk.id}
              type="button"
              aria-label={`View diff ${hunk.message}`}
              aria-pressed={diffOpen && selectedHunkId === hunk.id}
              onClick={() => onShowHunk(hunk.id)}
              className={cn(
                'flex min-w-0 items-start gap-2 overflow-hidden rounded px-2 py-1.5 text-left transition-colors hover:bg-accent',
                diffOpen && selectedHunkId === hunk.id && commitDiffSelectionTone(hunk),
              )}
            >
              <Badge variant={commitDiffVariant(hunk)} className="mt-0.5 shrink-0 px-1.5 py-0 text-[8px]">
                {hunk.operation}
              </Badge>
              <span className="min-w-0">
                <span className="line-clamp-2 break-words text-[10px] font-medium leading-snug">{hunk.message}</span>
                <span className="mt-0.5 block truncate font-mono text-[8px] text-muted-foreground">
                  {hunk.entityType} · {hunk.fieldGroup}
                </span>
              </span>
            </button>)}
          </section>
        </div>}
      </div>;
    })}
  </div>;
}
