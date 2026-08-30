import { useMemo } from 'react';
import type { CommitInfo } from '../git';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { layoutGraph } from './commit-graph-layout';
import { relativeTime } from './format';

const ROW = 58;
const COLUMN = 14;
const LEFT = 12;
const LANE_COLORS = ['#4ade80', '#60a5fa', '#f59e0b', '#c084fc', '#22d3ee'];

export interface CommitGraphProps {
  history: CommitInfo[];
  headCommit: string;
  selectedCommit: string;
  branches: Array<{ name: string; commitId: string }>;
  onSelect(commitId: string): void;
}

/** A compact Git graph that stays visible alongside the editor. */
export function CommitGraph({ history, headCommit, selectedCommit, branches, onSelect }: CommitGraphProps) {
  const { placed, edges, lanes } = useMemo(() => layoutGraph(history), [history]);
  const graphWidth = LEFT + Math.max(0, lanes - 1) * COLUMN + 12;
  const graphHeight = Math.max(ROW, placed.length * ROW);
  const branchTips = useMemo(() => {
    const tips = new Map<string, string[]>();
    for (const { name, commitId } of branches) {
      tips.set(commitId, [...(tips.get(commitId) ?? []), name]);
    }
    return tips;
  }, [branches]);

  return <div className="vg-history-graph" role="list" aria-label="Commit graph">
    <svg
      className="pointer-events-none absolute left-0 top-0"
      width={graphWidth}
      height={graphHeight}
      aria-hidden="true"
    >
      {edges.map((edge) => {
        const x1 = LEFT + edge.from.lane * COLUMN;
        const x2 = LEFT + edge.to.lane * COLUMN;
        const y1 = edge.from.row * ROW + ROW / 2;
        const y2 = edge.to.row * ROW + ROW / 2;
        const path = x1 === x2
          ? `M ${x1} ${y1} L ${x2} ${y2}`
          : `M ${x1} ${y1} C ${x1} ${y1 + ROW * 0.45}, ${x2} ${y2 - ROW * 0.45}, ${x2} ${y2}`;
        return <path
          key={edge.id}
          d={path}
          stroke={LANE_COLORS[edge.lane % LANE_COLORS.length]}
          fill="none"
          strokeWidth="1.5"
          opacity="0.58"
        />;
      })}
      {placed.map((entry) => {
        const cx = LEFT + entry.lane * COLUMN;
        const cy = entry.row * ROW + ROW / 2;
        const color = LANE_COLORS[entry.lane % LANE_COLORS.length];
        const selected = entry.commit.id === selectedCommit;
        const head = entry.commit.id === headCommit;
        const merge = entry.commit.parents.length > 1;
        return <g key={entry.commit.id}>
          {selected && <circle cx={cx} cy={cy} r="8" fill="none" stroke={color} strokeWidth="1.5" opacity="0.55" />}
          <circle cx={cx} cy={cy} r={merge ? 5 : 4} fill={head ? color : '#111113'} stroke={color} strokeWidth="2" />
          {merge && <circle cx={cx} cy={cy} r="1.5" fill={head ? '#111113' : color} />}
        </g>;
      })}
    </svg>

    <div className="flex flex-col" style={{ marginLeft: graphWidth }}>
      {placed.map(({ commit }) => {
        const selected = commit.id === selectedCommit;
        const head = commit.id === headCommit;
        const author = commit.author.replace(/\s*<[^>]*>/u, '');
        return <div key={commit.id} role="listitem" className="min-w-0" style={{ height: ROW }}>
          <button
            type="button"
            aria-label={`Graph commit ${commit.message}`}
            aria-current={selected ? 'true' : undefined}
            onClick={() => onSelect(commit.id)}
            title={`${commit.message} · ${commit.id.slice(0, 8)} · ${author} · ${relativeTime(commit.authoredAt)}`}
            className={cn(
              'flex h-[52px] w-full min-w-0 flex-col justify-center gap-1 rounded-lg border px-2.5 text-left transition-colors',
              selected
                ? 'border-edited/45 bg-edited-soft/70'
                : 'border-transparent hover:border-border hover:bg-accent/70',
            )}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <strong className="min-w-0 flex-1 truncate text-[11px] font-medium">{commit.message}</strong>
              {head && <Badge variant="outline" className="shrink-0">HEAD</Badge>}
              {commit.parents.length > 1 && <Badge variant="edited" className="shrink-0">merge</Badge>}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
              <code className="shrink-0 font-mono text-[9px] text-muted-foreground">{commit.id.slice(0, 8)}</code>
              <span className="min-w-0 flex-1 truncate text-[9px] text-muted-foreground">{author} · {relativeTime(commit.authoredAt)}</span>
            </span>
            {(branchTips.get(commit.id) ?? []).length > 0 && <span className="flex min-w-0 gap-1 overflow-hidden">
              {(branchTips.get(commit.id) ?? []).map((name) => <Badge key={name} variant="info" className="max-w-full truncate">{name}</Badge>)}
            </span>}
          </button>
        </div>;
      })}
    </div>
  </div>;
}
