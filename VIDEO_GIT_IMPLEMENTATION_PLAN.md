# VideoGit: DaVinci Resolve Electron App Implementation Plan

## Product definition

VideoGit is a local-first Electron companion app for DaVinci Resolve. Resolve remains responsible for editing; VideoGit versions the exported editorial decisions.

VideoGit is Git-inspired but does not invoke or require Git. It implements a small timeline-specific version-control engine in TypeScript using filesystem storage. The MVP supports immutable snapshots, commits, parent relationships, branches, HEAD, semantic diffs, checkout, and history. It does not implement Git pack files, remotes, rebasing, tags, or Git-compatible object formats.

```text
DaVinci Resolve
      ⇅ OTIO + SRT
VideoGit Electron App
      ├── semantic diff
      ├── staging
      ├── commits and history
      ├── branches
      ├── merge and conflicts
      └── checkout and export
```

## 1. MVP scope

### Must-have features

| Feature | Behaviour |
|---|---|
| Create repository | Initialize from a Resolve `.otio` export |
| Manual import | Import a new Resolve `.otio` export with a file picker or drag and drop |
| Semantic diff | Show trims, moves, additions, deletions, and track changes |
| Commits and history | Store complete timeline snapshots with message, author, timestamp, parents, and per-commit change summary |
| Commit diffs | Show every commit's semantic changes relative to its parent |
| Basic branching | Create and switch between alternate cuts |
| Checkout | Export any branch or commit as OTIO for Resolve |
| Repository validation | Reject malformed or incompatible exports safely |

### Stretch goals

- Semantic-operation staging
- Watched inbox
- Three-way merge and conflict resolution
- SRT captions
- Timeline visualization
- Branch comparison

### Not included in the hack MVP

- Resolve grades
- Fusion compositions
- Resolve FX
- Fairlight effects
- Multicam
- Compound timelines
- Cloud sync
- User authentication
- Website
- FFmpeg rendering
- Resolve plugin or scripting
- Production installers and code signing

## 2. Technology stack

```text
Electron Forge + Vite
React
TypeScript
Zustand
Zod
Vitest
Playwright
Node crypto
Node filesystem APIs
```

Avoid SQLite initially. Timeline repositories are small enough to use content-addressed JSON files. A storage interface will allow SQLite or cloud storage later.

## 3. Modular architecture

Use a workspace or monorepo:

```text
videogit/
  apps/
    desktop/
      src/
        main/
        preload/
        renderer/

  packages/
    domain/
    otio-adapter/
    srt-adapter/
    diff-engine/
    merge-engine/
    repository/
    application/
    test-fixtures/
```

### Dependency direction

```text
Electron UI
    ↓
Application services
    ↓
Domain + diff/merge engines
    ↓
Interfaces
    ↑
Filesystem repository / OTIO adapters
```

The domain and engines must never import Electron, React, or Node filesystem APIs. This allows them to run later in:

- A website
- A CLI
- A Resolve sync helper
- A cloud merge server
- Automated tests

## 4. Module responsibilities

### `domain`

Contains canonical types and validation rules:

```ts
interface Timeline {
  id: string;
  name: string;
  frameRate: FrameRate;
  tracks: Track[];
  captions: Caption[];
  metadata: Record<string, unknown>;
}

interface Clip {
  id: string;
  assetId: string;
  trackId: string;

  timelineStart: number;
  sourceStart: number;
  duration: number;

  enabled: boolean;
  name: string;
  metadata: Record<string, unknown>;
}

interface FrameRate {
  numerator: number;
  denominator: number;
}
```

Use integer frame boundaries internally. Never compare floating-point seconds.

### `otio-adapter`

Responsible only for OTIO conversion:

```ts
interface TimelineAdapter {
  import(raw: string): ImportResult;
  export(timeline: Timeline): string;
}
```

Responsibilities:

- Validate OTIO JSON
- Convert tracks, clips, gaps, and ranges
- Normalize file URLs
- Calculate absolute timeline positions
- Preserve unknown metadata
- Serialize canonical timelines back to OTIO
- Generate VideoGit entity IDs where possible

It must not contain diff, commit, or UI logic.

### Supported OTIO subset

The MVP supports cut-only timelines containing video and audio tracks, clips, gaps, and source ranges. Transitions, retiming, nested or compound timelines, multicam, generators, effects, Fusion compositions, and grades are unsupported in the MVP. The adapter must report unsupported content clearly and must never silently discard it.

### `srt-adapter`

Responsibilities:

- Parse SRT timestamps and text
- Convert timestamps to frame boundaries
- Serialize captions back to SRT
- Match caption identities across exports

### `diff-engine`

Pure functions:

```ts
function diffTimeline(
  before: Timeline,
  after: Timeline
): Change[];

function applyChanges(
  timeline: Timeline,
  changes: Change[]
): Timeline;
```

Change representation:

```ts
type Change =
  | AddClipChange
  | DeleteClipChange
  | MoveClipChange
  | TrimClipChange
  | ChangeClipTrackChange
  | SetClipEnabledChange
  | EditCaptionChange;

interface TrimClipChange {
  id: string;
  kind: "trim-clip";
  clipId: string;
  before: {
    timelineStart: number;
    sourceStart: number;
    duration: number;
  };
  after: {
    timelineStart: number;
    sourceStart: number;
    duration: number;
  };
}
```

A semantic operation may update several related fields. Staging and applying a trim, move, or track change must treat the whole operation atomically rather than allowing an invalid partial field update.

Human-readable descriptions are generated separately:

```text
Clip "Interview" trimmed by 18 frames
Caption 8 text corrected
B-roll moved from V1 to V2
```

### `merge-engine`

Three-way merge:

```ts
function mergeTimeline(
  base: Timeline,
  ours: Timeline,
  theirs: Timeline
): MergeResult;
```

Field rule:

```ts
if (ours === theirs) return ours;
if (ours === base) return theirs;
if (theirs === base) return ours;
return conflict(base, ours, theirs);
```

Additional structural conflicts:

- Same field changed differently
- Delete versus modify
- Two incompatible additions
- Track overlap after merge
- Missing asset reference
- Frame-rate mismatch
- Invalid caption boundaries

### `repository`

Define an abstraction:

```ts
interface RepositoryStore {
  readHead(): Promise<Commit>;
  readCommit(id: string): Promise<Commit>;
  writeCommit(commit: Commit): Promise<void>;

  readBranch(name: string): Promise<string>;
  updateBranch(name: string, commitId: string): Promise<void>;

  readIndex(): Promise<Snapshot>;
  writeIndex(snapshot: Snapshot): Promise<void>;
}
```

Initial implementation:

```text
FileSystemRepositoryStore
```

Future implementations:

```text
SqliteRepositoryStore
CloudRepositoryStore
GitCompatibleRepositoryStore
```

### `application`

Contains user-facing use cases:

```text
CreateRepository
ImportWorkingTimeline
StageChanges
UnstageChanges
CreateCommit
CreateBranch
CheckoutBranch
CheckoutCommit
MergeBranch
ResolveConflict
ExportForResolve
```

Electron calls these services. React must not manipulate repository files directly.

## 5. Repository format

```text
documentary.videogit/
  manifest.json
  HEAD
  index.json

  refs/
    heads/
      main
      shorter-opening
      caption-fix

  objects/
    ab/
      cdef1234...
    19/
      4821abcd...

  working/
    timeline.otio
    captions.srt

  inbox/
    timeline.otio
    captions.srt

  exports/
    main__abc123.otio
    main__abc123.srt

  identity-map.json
```

Objects are addressed by SHA-256 hashes.

### Snapshot

```ts
interface Snapshot {
  timeline: Timeline;
  sourceEnvelope?: {
    rawOtio: string;
    importedAt: string;
    sourceApplication: "davinci-resolve";
  };
}
```

### Commit

```ts
interface Commit {
  id: string;
  snapshotHash: string;
  parents: string[];
  author: string;
  message: string;
  timestamp: string;
}
```

Normal commits have one parent. Merge commits have two.

### Commit diffs

Each commit points to a complete canonical timeline snapshot. To display what changed in a commit, compare its snapshot with its first parent's snapshot:

```ts
function getCommitChanges(
  parent: Snapshot,
  commit: Snapshot
): Change[] {
  return diffTimeline(parent.timeline, commit.timeline);
}
```

```text
Commit changes = diff(parent snapshot, commit snapshot)
```

The initial commit has no parent, so all of its tracks, clips, and captions are shown as additions. For a future merge commit, the initial UI shows changes relative to the first parent. Detailed changes are derived from snapshots rather than stored as the source of truth; a small summary may be cached on the commit for history-list performance.

Use atomic writes:

1. Write to a temporary file inside the repository.
2. Flush and close it.
3. Rename it to its final object path.
4. Update the branch reference last.

This prevents an interrupted commit from corrupting the repository.

## 6. HEAD, index, and working state

Maintain Git-like states:

```text
HEAD
Last committed snapshot

INDEX
Snapshot containing staged changes

WORKING
Latest Resolve export
```

Calculations:

```text
Unstaged changes = diff(INDEX, WORKING)
Staged changes   = diff(HEAD, INDEX)
All changes      = diff(HEAD, WORKING)
```

When staging a semantic operation:

```ts
index = applyChanges(index, [selectedOperation]);
```

When committing:

1. Store `INDEX` as a snapshot.
2. Create a commit pointing to that snapshot.
3. Move the current branch to the commit.
4. Set `HEAD` and `INDEX` to the committed snapshot.
5. Leave `WORKING` unchanged.

This preserves unstaged edits after a partial commit.

## 7. Clip identity

Resolve may discard or regenerate OTIO metadata. Give canonical clips a VideoGit UUID, but include a fallback matcher.

Matching priority:

1. Preserved `metadata.videogit.entityId`
2. Media asset ID and exact source range
3. Same asset with a changed source range
4. Track and neighboring clips
5. Approximate timeline position
6. Report ambiguous identity to the user

Asset identity:

```text
normalized filename
media duration
source timecode when available
file size when locally available
```

Do not use an absolute path as identity.

## 8. Electron boundaries

### Main process

Handles:

- File dialogs
- Repository reads and writes
- Inbox watching
- Atomic writes
- Export creation
- OS integration

### Preload

Expose narrow typed functions:

```ts
interface VideoGitAPI {
  createRepository(): Promise<RepositorySummary>;
  openRepository(): Promise<RepositorySummary>;
  importTimeline(): Promise<WorkingChanges>;
  stageChanges(ids: string[]): Promise<WorkingChanges>;
  commit(message: string): Promise<Commit>;
  createBranch(name: string): Promise<void>;
  checkout(ref: string): Promise<CheckoutResult>;
  merge(branch: string): Promise<MergeResult>;
}
```

### Renderer

Handles:

- React UI
- Timeline visualization
- Change selection
- Commit history
- Branch navigation
- Conflict resolution

Security settings:

```ts
nodeIntegration: false
contextIsolation: true
sandbox: true
```

Load only packaged local application content.

## 9. User interface

### Onboarding

```text
Create VideoGit Repository
Open Repository

Resolve export instructions
```

### Repository overview

```text
Documentary
Branch: main

4 working changes
2 staged changes

[Review changes] [Commit] [Export for Resolve]
```

### Changes

Group changes by entity:

```text
Interview.mov

[x] Trim: source start 120 → 138, duration 240 → 222
[ ] Move: track V1 → V2
```

### History

```text
● 8ab219  Tighten opening
● 18fc22  Fix caption timing
● 12a291  Initial rough cut
```

### Timeline visualization

Use simple colored blocks rather than video playback:

```text
V2           [B-roll 02]
V1  [Intro]  [Interview]  [Outro]
A1  [Music────────────────────────]
```

Highlight:

- Green: added
- Red: removed
- Yellow: modified
- Blue outline: moved

### Merge conflicts

```text
Interview.mov — Source Start

Base:    120
Ours:    138
Theirs:  144

[Use ours] [Use theirs] [Enter value]
```

## 10. Implementation milestones

### Milestone 0: Resolve interoperability spike

Before building the UI:

1. Create a tiny Resolve timeline.
2. Export it as OTIO.
3. Parse it in TypeScript.
4. Serialize it without changes.
5. Import the generated OTIO back into Resolve.
6. Confirm clips, gaps, tracks, and timing match.

This is the highest-risk technical test.

### Milestone 1: Electron shell

- Electron Forge and Vite setup
- React renderer
- Secure preload bridge
- Open and create repository dialogs
- Basic navigation

### Milestone 2: Canonical timeline and OTIO adapter

- Zod schemas
- OTIO parser
- Gap and track handling
- Media references
- Serializer
- Golden Resolve fixtures

### Milestone 3: Repository and commits

- Object hashing
- Snapshot storage
- Commit creation
- HEAD and refs
- Commit history
- Atomic writes

### Milestone 4: Semantic diff

- Entity matching
- Semantic trim, move, and track-change operations
- Add, delete, and move operations
- Human-readable change descriptions

### Milestone 5: Branches and checkout

- Create and switch branch
- Export selected commit
- Resolve-friendly filenames

### Post-MVP milestone: Semantic-operation staging

- HEAD, index, and working states
- Stage and unstage complete semantic operations
- Preserve unstaged operations after a commit

### Post-MVP milestone: Merge and conflict resolution

- Merge-base discovery
- Three-way field merge
- Structural validation
- Conflict UI
- Two-parent merge commits

### Post-MVP milestone: SRT captions

- Import and export
- Caption matching
- Text and timing diffs
- Caption conflicts
- OTIO and SRT checkout bundle

### Milestone 8: Demo polish

- Sample repository
- Timeline graphic
- Empty and error states
- Resolve workflow instructions
- Repository-size indicator
- Deterministic demo script

## 11. Testing strategy

### Unit tests

```text
parse OTIO → canonical timeline
canonical timeline → OTIO
diff(before, after)
apply(before, diff) equals after
three-way merge rules
caption timestamp conversion
deterministic hashing
```

### Golden fixtures

Export these from Resolve:

```text
single clip
multiple tracks
gap between clips
trimmed clip
moved clip
deleted clip
linked audio
marker
caption SRT
```

Keep fixtures small and media-independent.

### Merge invariants

```ts
merge(base, ours, base) === ours
merge(base, base, theirs) === theirs
merge(base, ours, ours) === ours
```

Disjoint field changes must merge without conflict.

### Manual Resolve acceptance tests

- Export from Resolve
- Import the new export manually
- Commit changes
- Inspect the commit's semantic diff
- Check out an older version
- Import checkout into Resolve
- Verify exact clip boundaries
- Confirm unsupported OTIO content is rejected clearly
- Confirm no media was copied

## 12. Extension points

The architecture should later support:

```text
OTIO adapter             Current Resolve workflow
DRT attachment adapter   Native opaque rollback snapshots
FCP7 XML adapter         Premiere and other NLE interoperability
Kdenlive adapter         Open-source editor support
Cloud remote             Push and pull commits and branches
Web application          GitHub-style shared repository UI
Resolve Studio bridge    Automated timeline export and import
FFmpeg renderer          Sandboxed proof renders
```

These extensions must depend on the canonical domain and repository interfaces. They must not require rewriting the diff or merge engine.

## Definition of done

The hack MVP is complete when it can:

1. Export an OTIO timeline from Resolve.
2. Create a VideoGit repository.
3. Modify the timeline in Resolve and export again.
4. Show accurate semantic changes.
5. Commit the complete modified timeline.
6. Show each commit's semantic changes relative to its parent.
7. Display commit history.
8. Create an alternate branch.
9. Export any commit as OTIO.
10. Import that checkout successfully into Resolve.
11. Reject unsupported OTIO content without silently discarding it.
12. Demonstrate that no footage entered the repository.
