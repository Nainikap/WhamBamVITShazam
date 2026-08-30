import { describe, expect, it } from 'vitest';
import type { CommitInfo } from '../src/git';
import { layoutGraph } from '../src/renderer/commit-graph-layout';

function commit(id: string, parents: string[]): CommitInfo {
  return {
    id,
    parents,
    author: 'SnipSnap User <local@snipsnap.invalid>',
    authoredAt: '2026-08-30T10:00:00.000Z',
    message: `Commit ${id}`,
  };
}

describe('commit graph layout', () => {
  it('keeps a linear history in one lane with one edge per parent', () => {
    const graph = layoutGraph([
      commit('third', ['second']),
      commit('second', ['first']),
      commit('first', []),
    ]);

    expect(graph.lanes).toBe(1);
    expect(graph.placed.map(({ commit: entry, lane }) => [entry.id, lane])).toEqual([
      ['third', 0],
      ['second', 0],
      ['first', 0],
    ]);
    expect(graph.edges.map(({ id }) => id)).toEqual(['third-second', 'second-first']);
  });

  it('shows both sides of a merge before collapsing at their common parent', () => {
    const graph = layoutGraph([
      commit('merge', ['main-change', 'branch-change']),
      commit('main-change', ['base']),
      commit('branch-change', ['base']),
      commit('base', []),
    ]);

    expect(graph.lanes).toBe(2);
    expect(graph.placed.map(({ commit: entry, lane }) => [entry.id, lane])).toEqual([
      ['merge', 0],
      ['main-change', 0],
      ['branch-change', 1],
      ['base', 0],
    ]);
    expect(graph.edges.map(({ id }) => id)).toEqual([
      'merge-main-change',
      'merge-branch-change',
      'main-change-base',
      'branch-change-base',
    ]);
  });
});
