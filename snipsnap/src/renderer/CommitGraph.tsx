import { useMemo } from 'react';
import type { CommitInfo } from '../git';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/utils';
import { relativeTime, shortId } from './format';

const ROW = 56;
const COLUMN = 14;
const LEFT = 14;
const LANE_COLORS = ['#5b8cff', '#3ddc84', '#f0c05a', '#c78bff', '#ff8f6b', '#5fd7d0'];

interface PlacedCommit {
  commit: CommitInfo;
  row: number;
  lane: number;
}

interface GraphEdge {
  id: string;
  from: PlacedCommit;
  to: PlacedCommit;
  lane: number;
}

/** Assign each commit a lane the way `git log --graph` does, newest first. */
export function layoutGraph(history: CommitInfo[]): { placed: PlacedCommit[]; edges: GraphEdge[]; lanes: number } {
  const lanes: Array<string | null> = [];
  const placed: PlacedCommit[] = [];
  const byId = new Map<string, PlacedCommit>();

  const claim = (commitId: string): number => {
    const existing = lanes.indexOf(commitId);
    if (existing >= 0) return existing;
    const free = lanes.indexOf(null);
    if (free >= 0) {
      lanes[free] = commitId;
      return free;
    }
    lanes.push(commitId);
    return lanes.length - 1;
  };

  history.forEach((commit, row) => {
    const lane = claim(commit.id);
    const entry = { commit, row, lane };
    placed.push(entry);
    byId.set(commit.id, entry);
    const [first, ...rest] = commit.parents;
    lanes[lane] = first ?? null;
    for (const parent of rest) {
      if (!lanes.includes(parent)) claim(parent);
    }
    // Two lanes tracking the same parent collapse into the leftmost one.
    lanes.forEach((value, index) => {
      if (value !== null && lanes.indexOf(value) !== index) lanes[index] = null;
    });
  });

  const edges: GraphEdge[] = [];
  for (const entry of placed) {
    entry.commit.parents.forEach((parentId, index) => {
      const parent = byId.get(parentId);
      if (!parent) return;
      edges.push({
        id: `${entry.commit.id}-${parentId}`,
        from: entry,
        to: parent,
        lane: index === 0 ? entry.lane : parent.lane,
      });
    });
  }

  return { placed, edges, lanes: Math.max(1, ...placed.map(({ lane }) => lane + 1)) };
}

export interface CommitGraphProps {
  history: CommitInfo[];
  headCommit: string;
  selectedCommit: string;
  branches: Array<{ name: string; commitId: string }>;
  onSelect(commitId: string): void;
}

/**
 * The one place commits are listed. Branch topology is drawn beside the rows
 * rather than repeated as a second graph elsewhere in the window.
 */
export function CommitGraph({ history, headCommit, selectedCommit, branches, onSelect }: CommitGraphProps) {
  const { placed, edges, lanes } = useMemo(() => layoutGraph(history), [history]);
  const width = LEFT + Math.max(0, lanes - 1) * COLUMN + 14;
  const height = Math.max(ROW, placed.length * ROW);
  const tips = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const branch of branches) map.set(branch.commitId, [...map.get(branch.commitId) ?? [], branch.name]);
    return map;
  }, [branches]);

  return <div className="relative">
    <svg className="pointer-events-none absolute left-0 top-0" width={width} height={height} aria-hidden="true">
      {edges.map((edge) => {
        const x1 = LEFT + edge.from.lane * COLUMN;
        const x2 = LEFT + edge.to.lane * COLUMN;
        const y1 = edge.from.row * ROW + ROW / 2;
        const y2 = edge.to.row * ROW + ROW / 2;
        const path = x1 === x2
          ? `M ${x1} ${y1} L ${x2} ${y2}`
          : `M ${x1} ${y1} C ${x1} ${y1 + ROW * 0.5}, ${x2} ${y2 - ROW * 0.5}, ${x2} ${y2}`;
        return <path key={edge.id} d={path} stroke={LANE_COLORS[edge.lane % LANE_COLORS.length]} fill="none" strokeWidth="1.5" opacity="0.75" />;
      })}
      {placed.map((entry) => {
        const cx = LEFT + entry.lane * COLUMN;
        const cy = entry.row * ROW + ROW / 2;
        const color = LANE_COLORS[entry.lane % LANE_COLORS.length];
        const isMerge = entry.commit.parents.length > 1;
        return <g key={entry.commit.id}>
          <circle cx={cx} cy={cy} r={isMerge ? 5.5 : 4.5} fill={entry.commit.id === headCommit ? color : 'hsl(220 22% 9%)'} stroke={color} strokeWidth="2" />
          {isMerge && <circle cx={cx} cy={cy} r="1.6" fill={color} />}
        </g>;
      })}
    </svg>

    <div className="flex flex-col" style={{ marginLeft: width }}>
      {placed.map((entry) => <button
        key={entry.commit.id}
        aria-label={`View commit ${entry.commit.message}`}
        onClick={() => onSelect(entry.commit.id)}
        style={{ height: ROW }}
        className={cn(
          'flex flex-col justify-center gap-1 rounded-md border border-transparent px-2.5 text-left transition-colors',
          entry.commit.id === selectedCommit ? 'border-primary/40 bg-primary/10' : 'hover:bg-accent',
        )}
      >
        <span className="truncate text-xs font-medium leading-tight">{entry.commit.message}</span>
        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <code className="font-mono">{shortId(entry.commit.id)}</code>
          <span>·</span>
          <span className="truncate">{relativeTime(entry.commit.authoredAt)}</span>
          {(tips.get(entry.commit.id) ?? []).map((name) => (
            <Badge key={name} variant="primary" className="ml-0.5">{name}</Badge>
          ))}
          {entry.commit.parents.length > 1 && <Badge variant="edited">merge</Badge>}
        </span>
      </button>)}
    </div>
  </div>;
}
