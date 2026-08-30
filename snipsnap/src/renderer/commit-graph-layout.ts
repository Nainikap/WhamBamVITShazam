import type { CommitInfo } from '../git';

export interface PlacedCommit {
  commit: CommitInfo;
  row: number;
  lane: number;
}

export interface GraphEdge {
  id: string;
  from: PlacedCommit;
  to: PlacedCommit;
  lane: number;
}

/** Assign each commit a lane the way `git log --graph` does, newest first. */
export function layoutGraph(history: CommitInfo[]): {
  placed: PlacedCommit[];
  edges: GraphEdge[];
  lanes: number;
} {
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

    const [first, ...otherParents] = commit.parents;
    lanes[lane] = first ?? null;
    for (const parent of otherParents) {
      if (!lanes.includes(parent)) claim(parent);
    }
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

  return {
    placed,
    edges,
    lanes: Math.max(1, ...placed.map(({ lane }) => lane + 1)),
  };
}
