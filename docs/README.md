# VideoGit documentation

The documents in this directory have different roles:

1. [`VideoGit_Engineering_Plan.md`](./VideoGit_Engineering_Plan.md) is the authoritative V1 implementation plan.
2. [`VideoGit_System_Architecture_V1_V2.md`](./VideoGit_System_Architecture_V1_V2.md) is the V1-to-V2 architecture roadmap. It must not expand V1 beyond the Engineering Plan.
3. [`VideoGit_CrossNLE_Universal_Hub_Brainstorm.md`](./VideoGit_CrossNLE_Universal_Hub_Brainstorm.md) is product research for a future cross-NLE release, not the current build plan.
4. [`V1_IMPLEMENTATION_STATUS.md`](./V1_IMPLEMENTATION_STATUS.md) maps the V1/V1.5 contract to the current code and test evidence. It also records validation that still requires DaVinci Resolve and real footage.

If the documents conflict, follow the Engineering Plan.

## Core architecture invariant

Git stores canonical timeline JSON snapshots and provides commits, parents, branches, tags, refs, and merge-base discovery. VideoGit computes semantic diffs, semantic staging, and three-way timeline merges in TypeScript. Git must never text-merge timeline JSON.

For local V1, the process boundary is:

```text
React renderer -> typed preload IPC -> Electron main -> application services
```

Node and Electron APIs are available only in the main process. A local Fastify HTTP adapter is optional and is introduced only when a DaVinci companion script or an external client requires it.

SnipSnap does not edit video. Resolve writes the timeline; SnipSnap detects its OTIO export,
versions the canonical timeline, and previews immutable commits from locally linked media.

The current build also contains an explicitly bounded V2 LAN-demo slice: one SnipSnap desktop can
host a project and another can join, pull, and push native Git history while missing footage is
transferred outside Git in encrypted, resumable, hash-verified chunks. See
[`V1_IMPLEMENTATION_STATUS.md`](./V1_IMPLEMENTATION_STATUS.md) for implemented behavior and limits.
