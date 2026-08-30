import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { CommitInfo } from '../git';
import { cn } from '@/lib/utils';

const COLUMN = 220;
const ROW = 140;

interface PlacedCommit {
  commit: CommitInfo;
  row: number;
  lane: number;
}

/** Assign each commit a lane the way `git log --graph` does, newest first. */
export function layoutGraph(history: CommitInfo[]): { placed: PlacedCommit[]; lanes: number } {
  const lanes: Array<string | null> = [];
  const placed: PlacedCommit[] = [];

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
    placed.push({ commit, row, lane });
    const [first] = commit.parents;
    lanes[lane] = first ?? null;
    for (const parent of commit.parents.slice(1)) {
      if (!lanes.includes(parent)) claim(parent);
    }
    lanes.forEach((value, index) => {
      if (value !== null && lanes.indexOf(value) !== index) lanes[index] = null;
    });
  });

  return { placed, lanes: Math.max(1, ...placed.map(({ lane }) => lane + 1)) };
}

function CubeNode({ data }: { data: { message: string; selected: boolean; head: boolean } }) {
  return <div className={cn('vg-cube-node', data.selected && 'is-selected', data.head && 'is-head')}>
    <Handle position={Position.Top} type="target" />
    <span className="vg-cube" aria-hidden="true">
      <i /><i /><i /><i /><i /><i />
    </span>
    <strong>{data.message}</strong>
    <Handle position={Position.Bottom} type="source" />
  </div>;
}

const nodeTypes = { cube: CubeNode };

export interface CommitGraphProps {
  history: CommitInfo[];
  headCommit: string;
  selectedCommit: string;
  branches: Array<{ name: string; commitId: string }>;
  onSelect(commitId: string): void;
}

export function CommitGraphModal({
  open,
  onClose,
  history,
  headCommit,
  selectedCommit,
  onSelect,
}: CommitGraphProps & { open: boolean; onClose(): void }) {
  const [clear, setClear] = useState(0);
  useEffect(() => {
    if (!open) {
      setClear(0);
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => setClear(1));
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const { placed } = useMemo(() => layoutGraph(history), [history]);
  const byId = useMemo(() => new Map(placed.map((entry) => [entry.commit.id, entry])), [placed]);

  const nodes = useMemo<Node[]>(() => placed.map((entry) => ({
    id: entry.commit.id,
    type: 'cube',
    position: { x: entry.lane * COLUMN, y: entry.row * ROW },
    data: {
      message: entry.commit.message,
      selected: entry.commit.id === selectedCommit,
      head: entry.commit.id === headCommit,
    },
  })), [placed, selectedCommit, headCommit]);

  const edges = useMemo<Edge[]>(() => {
    const next: Edge[] = [];
    for (const entry of placed) {
      for (const parentId of entry.commit.parents) {
        if (!byId.has(parentId)) continue;
        next.push({
          id: `${entry.commit.id}-${parentId}`,
          source: entry.commit.id,
          target: parentId,
          className: 'vg-ray-edge',
          animated: true,
        });
      }
    }
    return next;
  }, [placed, byId]);

  if (!open) return null;

  return <div className="vg-graph-modal" data-clear={clear ? 'true' : 'false'} role="dialog" aria-label="Commit graph">
    <button className="vg-graph-dismiss" onClick={onClose} type="button">Close</button>
    <div className="vg-graph-flow">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_event, node) => onSelect(node.id)}
      >
        <Background color="#2a2a2a" gap={28} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  </div>;
}

/** Compact opener; the readable graph lives in the progressive-deblur modal. */
export function CommitGraph({ history, headCommit, selectedCommit, branches, onSelect }: CommitGraphProps) {
  const [open, setOpen] = useState(false);
  return <>
    <button className="vg-graph-open" onClick={() => setOpen(true)} type="button">
      Open commit graph
    </button>
    <CommitGraphModal
      open={open}
      onClose={() => setOpen(false)}
      history={history}
      headCommit={headCommit}
      selectedCommit={selectedCommit}
      branches={branches}
      onSelect={onSelect}
    />
  </>;
}
