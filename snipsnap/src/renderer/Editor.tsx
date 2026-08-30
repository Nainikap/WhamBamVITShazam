import { Copy, Download, GitBranch, GitMerge, Network, SplitSquareHorizontal, Square, Upload } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { CollaborationStatus } from '../application';
import type { SemanticHunk } from '../diff';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { CommitGraph } from './CommitGraph';
import { CommitPlayer } from './CommitPlayer';
import { DiffView } from './DiffView';
import { TimelineTracks } from './TimelineTracks';
import { absoluteTime, authorName, framesToTimecode, relativeTime, shortId } from './format';
import { useAppStore } from './store';

const operationVariant = {
  add: 'added',
  delete: 'removed',
  modify: 'retimed',
  reorder: 'edited',
} as const;

const operationRowTone = {
  add: 'border-added/55 border-l-2 bg-card',
  delete: 'border-removed/55 border-l-2 bg-card',
  modify: 'border-retimed/55 border-l-2 bg-card',
  reorder: 'border-edited/55 border-l-2 bg-card',
} as const;

function HunkRow({ hunk, actionLabel, onAction, onView, selected, fps }: {
  hunk: SemanticHunk;
  actionLabel?: string;
  onAction?(): void;
  onView?(): void;
  selected?: boolean;
  fps: number;
}) {
  const range = hunk.affectedFrameRange;
  return <div className={cn(
    'flex w-full min-w-0 max-w-full items-stretch gap-1.5 overflow-hidden rounded-md border p-1.5',
    operationRowTone[hunk.operation],
    selected && 'ring-1 ring-edited',
  )}>
    <button
      type="button"
      aria-label={`View change ${hunk.message}`}
      aria-pressed={selected}
      className="flex min-w-0 flex-1 flex-col gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent/70"
      onClick={onView}
    >
      <Badge variant={operationVariant[hunk.operation]} className="w-fit shrink-0">{hunk.operation}</Badge>
      <span className="min-w-0 break-words text-[11px] font-medium leading-snug">{hunk.message}</span>
      <span className="min-w-0 break-words font-mono text-[9px] leading-snug text-muted-foreground">
        {hunk.entityType} · {hunk.fieldGroup}
        {range ? ` · ${framesToTimecode(range.start, fps)} → ${framesToTimecode(range.start + range.duration, fps)}` : ''}
      </span>
    </button>
    {actionLabel && onAction && <Button className="h-7 shrink-0 self-start px-2" size="sm" variant="outline" onClick={onAction}>{actionLabel}</Button>}
  </div>;
}

function PanelHeading({ title, count, action }: { title: string; count?: number; action?: React.ReactNode }) {
  return <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-1.5">
    <div className="flex min-w-0 items-baseline gap-2">
      <h2 className="text-xs font-semibold tracking-wide">{title}</h2>
      {count !== undefined && <span className="font-mono text-[11px] text-muted-foreground">{count}</span>}
    </div>
    {action}
  </div>;
}

export function Editor() {
  const store = useAppStore();
  const status = store.status;
  const revision = store.selectedRevision;
  const [commitMessage, setCommitMessage] = useState('');
  const [branchName, setBranchName] = useState('');
  const [mergeSource, setMergeSource] = useState('');
  const [playhead, setPlayhead] = useState(0);
  const [selectedDiffHunkId, setSelectedDiffHunkId] = useState<string | null>(null);
  const [expandedCommitId, setExpandedCommitId] = useState<string | null>(null);

  useEffect(() => {
    setPlayhead(0);
    setSelectedDiffHunkId(null);
  }, [revision?.commit.id, revision?.comparedParent]);

  const otherBranches = useMemo(
    () => (status?.branches ?? []).filter(({ name }) => name !== status?.branch),
    [status?.branches, status?.branch],
  );

  if (!status || !revision) {
    return <main className="grid flex-1 place-items-center text-sm text-muted-foreground">Opening project…</main>;
  }

  const fps = revision.preview.fps;
  const dirty = status.staged.length > 0 || status.unstaged.length > 0 || Boolean(status.source.pending);
  const canCommit = status.staged.length > 0;
  const canDiff = status.history.length > 1;
  const diffOpen = store.diffOpen && Boolean(store.comparison);
  const collaboration: CollaborationStatus = store.collaboration.projectId === status.project.id
    ? store.collaboration
    : { mode: 'none', connected: false };
  const transferPercent = collaboration.progress?.totalBytes
    ? Math.round((collaboration.progress.completedBytes / collaboration.progress.totalBytes) * 100)
    : 0;
  const resolveSyncActive = status.source.mode === 'resolve'
    && ['starting', 'waiting-for-resolve', 'watching'].includes(status.source.state);
  const sourceEditor = status.source.mode === 'kdenlive' ? 'Kdenlive' : 'Resolve';

  function guardedCheckout(branch: string): void {
    if (!status || branch === status.branch) return;
    const discard = dirty
      && window.confirm(`Switching to ${branch} discards the staged and working changes on ${status.branch}. Continue?`);
    if (!dirty || discard) void store.checkout(branch, discard);
  }

  function openDiff(): void {
    if (!status || !revision) return;
    const parent = revision.comparedParent ?? revision.commit.parents[0];
    setSelectedDiffHunkId(null);
    setExpandedCommitId(revision.commit.id);
    void store.openDiff(parent ?? revision.commit.id, parent ? revision.commit.id : status.headCommit);
  }

  function openRevisionDiff(hunkId: string | null): void {
    if (!revision) return;
    const parent = revision.comparedParent ?? revision.commit.parents[0];
    if (!parent) return;
    setSelectedDiffHunkId(hunkId);
    setExpandedCommitId(revision.commit.id);
    void store.openDiff(parent, revision.commit.id);
  }

  function openWorkspaceDiff(scope: 'staged' | 'unstaged', hunkId: string): void {
    setSelectedDiffHunkId(hunkId);
    setExpandedCommitId(null);
    void store.openWorkspaceDiff(scope);
  }

  const submitCommit = (event: FormEvent) => {
    event.preventDefault();
    if (!commitMessage.trim() || !canCommit) return;
    void store.commit(commitMessage).then(() => setCommitMessage(''));
  };

  const submitBranch = (event: FormEvent) => {
    event.preventDefault();
    if (!branchName.trim()) return;
    void store.createBranchFromSelected(branchName).then(() => setBranchName(''));
  };

  return <main className="vg-studio vg-editor-grid">
    <aside aria-label="Source control" className="vg-studio-left vg-source-control">
      <section aria-label="Selected commit" className="vg-side-section">
        <div className="flex flex-col gap-2 p-3">
          <h2 className="line-clamp-2 break-words text-sm font-semibold tracking-tight" title={revision.commit.message}>{revision.commit.message}</h2>
          <p className="font-mono text-[10px] text-muted-foreground">
            {shortId(revision.commit.id)} · by <span title={revision.commit.author}>{authorName(revision.commit.author)}</span>
            {' · '}{absoluteTime(revision.commit.authoredAt)}
          </p>
          {revision.commit.parents.length > 1 && <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">Parent</span>
            {revision.commit.parents.map((parent, index) => <Button
              key={parent}
              size="sm"
              variant={revision.comparedParent === parent ? 'default' : 'outline'}
              onClick={() => void store.loadRevision(revision.commit.id, index)}
            >{index + 1}</Button>)}
          </div>}
          <div className="grid grid-cols-2 gap-2">
            {diffOpen
              ? <Button
                size="sm"
                variant="secondary"
                className="min-w-0"
                onClick={() => {
                  setSelectedDiffHunkId(null);
                  store.closeDiff();
                }}
              ><SplitSquareHorizontal />Close diff</Button>
              : <Tooltip>
                <TooltipTrigger asChild>
                  <span className="min-w-0">
                    <Button size="sm" variant="secondary" className="w-full" disabled={!canDiff} onClick={openDiff}>
                      <SplitSquareHorizontal />See diff
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {canDiff
                    ? 'Play both commits side by side and highlight added, removed, and retimed footage'
                    : 'Two commits are needed before anything can be compared'}
                </TooltipContent>
              </Tooltip>}
            <Button
              size="sm"
              variant="secondary"
              className="min-w-0"
              disabled={revision.commit.id === status.headCommit}
              onClick={() => {
                const discard = dirty && window.confirm('Replace the staged and working timeline with this commit?');
                if (!dirty || discard) void store.restoreSelected(discard);
              }}
            >Restore to working</Button>
          </div>
        </div>
      </section>

      <section aria-label="Working changes" className="vg-side-section">
        <PanelHeading
          title="Changes"
          count={status.unstaged.length + status.staged.length}
          action={<div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={status.unstaged.length === 0}
              onClick={() => void store.stage(status.unstaged.map(({ id }) => id))}
            >Stage all</Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={status.staged.length === 0}
              onClick={() => void store.unstage(status.staged.map(({ id }) => id))}
            >Unstage all</Button>
          </div>}
        />
        <div className="vg-diff-colors flex flex-col gap-3 p-3">
          {status.unstaged.length + status.staged.length === 0
            ? <p className="text-xs text-muted-foreground">
              The latest saved {sourceEditor} timeline matches this commit.
            </p>
            : <>
              {status.staged.length > 0 && <div className="flex flex-col gap-1.5">
                <span className="font-mono text-[9px] tracking-widest text-muted-foreground">Staged</span>
                {status.staged.map((hunk) => <HunkRow
                  key={hunk.id} hunk={hunk} fps={fps} actionLabel="Unstage"
                  onAction={() => void store.unstage([hunk.id])}
                  onView={() => openWorkspaceDiff('staged', hunk.id)}
                  selected={diffOpen && store.comparison?.kind === 'workspace'
                    && store.comparison.scope === 'staged' && selectedDiffHunkId === hunk.id}
                />)}
              </div>}
              {status.unstaged.length > 0 && <div className="flex flex-col gap-1.5">
                <span className="font-mono text-[9px] tracking-widest text-muted-foreground">Unstaged</span>
                {status.unstaged.map((hunk) => <HunkRow
                  key={hunk.id} hunk={hunk} fps={fps} actionLabel="Stage"
                  onAction={() => void store.stage([hunk.id])}
                  onView={() => openWorkspaceDiff('unstaged', hunk.id)}
                  selected={diffOpen && store.comparison?.kind === 'workspace'
                    && store.comparison.scope === 'unstaged' && selectedDiffHunkId === hunk.id}
                />)}
              </div>}
            </>}
        </div>
        <form className="flex shrink-0 gap-2 border-t border-border p-3" onSubmit={submitCommit}>
          <Input
            aria-label="Commit message"
            value={commitMessage}
            placeholder="Describe this cut"
            onChange={(event) => setCommitMessage(event.target.value)}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button variant="default" disabled={!canCommit || !commitMessage.trim()}>Commit</Button>
              </span>
            </TooltipTrigger>
            {!canCommit && <TooltipContent>Stage a change first — this version matches {shortId(status.headCommit)}</TooltipContent>}
          </Tooltip>
        </form>
      </section>

      <section aria-label="Commit history" className="vg-side-section">
        <PanelHeading title="Commit graph" count={status.history.length} />
        <div className="p-2">
          <CommitGraph
            history={status.history}
            headCommit={status.headCommit}
            selectedCommit={revision.commit.id}
            branches={status.branches}
            expandedCommitId={expandedCommitId}
            changes={revision.diff}
            diffOpen={store.diffOpen}
            selectedHunkId={selectedDiffHunkId}
            onSelect={(commit) => {
              const selected = commit.id === revision.commit.id;
              if (selected && expandedCommitId === commit.id) {
                setExpandedCommitId(null);
                return;
              }
              setExpandedCommitId(commit.id);
              setSelectedDiffHunkId(null);
              if (!selected || store.diffOpen) void store.loadRevision(commit.id);
            }}
            onShowAll={() => openRevisionDiff(null)}
            onShowHunk={(hunkId) => openRevisionDiff(hunkId)}
          />
        </div>
      </section>
    </aside>

    <section aria-label="Preview stage" className="vg-studio-stage vg-editor-workspace">
      {diffOpen && store.comparison
        ? <DiffView
          comparison={store.comparison}
          history={status.history}
          selectedHunkId={selectedDiffHunkId}
          onSelectBase={(id) => {
            const comparison = store.comparison;
            if (comparison?.kind !== 'commits') return;
            setSelectedDiffHunkId(null);
            void store.openDiff(id, comparison.head.commit.id);
          }}
          onSelectHead={(id) => {
            const comparison = store.comparison;
            if (comparison?.kind !== 'commits') return;
            setSelectedDiffHunkId(null);
            void store.openDiff(comparison.base.commit.id, id);
          }}
          onClose={() => {
            setSelectedDiffHunkId(null);
            store.closeDiff();
          }}
        />
        : <CommitPlayer
          plan={revision.preview}
          onRelink={(fingerprint) => void store.relinkMedia(fingerprint)}
          playhead={playhead}
          onPlayheadChange={setPlayhead}
        />}
    </section>

    <aside aria-label="Inspector" className="vg-studio-side vg-inspector">
      <section aria-label="Resolve source" className="vg-side-section">
        <PanelHeading
          title="Source"
          action={<Badge variant={status.source.state === 'watching' ? 'added' : 'retimed'}>
            {status.source.state.replace(/-/gu, ' ').replace(/^./u, (first) => first.toUpperCase())}
          </Badge>}
        />
        <div className="flex flex-col gap-2 p-3">
          <span className="break-words text-xs font-medium [overflow-wrap:anywhere]">{status.source.mode === 'resolve'
            ? `${status.source.resolveProjectName ?? 'DaVinci Resolve'} · ${status.source.resolveTimelineName ?? 'active timeline'}`
            : status.source.mode === 'kdenlive'
              ? `Kdenlive · ${status.source.fileName ?? 'OTIO timeline'}`
              : status.source.connected ? status.source.fileName : 'Connect SnipSnap to DaVinci Resolve'}</span>
          <span className="break-words font-mono text-[10px] text-muted-foreground [overflow-wrap:anywhere]">
            {status.source.error ?? (status.source.mode === 'resolve'
              ? status.source.lastSavedAt
                ? `Last save received ${absoluteTime(status.source.lastSavedAt)}`
                : 'Open Resolve, select the timeline, and save the project'
              : status.source.mode === 'kdenlive' && status.source.lastSavedAt
                ? `Last Ctrl+S received ${absoluteTime(status.source.lastSavedAt)} · OTIO regenerated automatically`
                : status.source.filePath ?? 'Each editor save arrives as the new working timeline')}
          </span>
          <div className="flex flex-wrap gap-2">
            {!status.source.connected && <Button size="sm" onClick={() => void store.connectKdenliveSource()}>
              Connect Kdenlive
            </Button>}
            {(status.source.mode === 'file' || status.source.mode === 'kdenlive')
              && <Button variant="secondary" size="sm" onClick={() => void store.scanSource()}>Check file</Button>}
            {status.resolve && (resolveSyncActive
              ? <Button variant="secondary" size="sm" onClick={() => void store.stopResolveSync()}>Stop sync</Button>
              : <Button size="sm" variant="default" onClick={() => void store.startResolveSync()}>
                {status.source.mode === 'resolve' ? 'Restart sync' : 'Start save sync'}
              </Button>)}
          </div>
          {status.source.pending && <div className="flex flex-col gap-2 rounded-lg border border-retimed/40 bg-retimed-soft px-3 py-2.5">
            <span className="text-xs">
              <strong>{status.source.pending.changeCount} change{status.source.pending.changeCount === 1 ? '' : 's'} detected in {sourceEditor}</strong>
              {status.source.pending.unsupportedCount > 0 && ` · ${status.source.pending.unsupportedCount} unsupported`}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void store.dismissSource()}>Ignore</Button>
              <Button size="sm" variant="default" onClick={() => void store.applySource()}>Apply to working timeline</Button>
            </div>
          </div>}
        </div>
      </section>

      <section aria-label="Collaboration" className="vg-side-section">
        <PanelHeading
          title="Collaborate"
          action={<Badge variant={collaboration.connected ? 'added' : 'outline'}>
            {collaboration.mode === 'hosting' ? 'Hosting' : collaboration.mode === 'peer' ? 'Connected' : 'Local'}
          </Badge>}
        />
        <div className="flex flex-col gap-3 p-3">
          {collaboration.mode === 'none' && <>
            <p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              Share every commit, branch, tag, diff, and missing media with another SnipSnap computer on this network.
            </p>
            <Button className="w-full" onClick={() => void store.startHosting()}><Network />Host this project</Button>
          </>}

          {collaboration.mode === 'hosting' && <>
            <span className="truncate font-mono text-[10px] text-muted-foreground">Listening at {collaboration.address}</span>
            <label className="grid gap-1.5">
              <span className="font-mono text-[9px] tracking-widest text-muted-foreground">Pairing code</span>
              <textarea
                readOnly
                rows={4}
                value={collaboration.inviteCode ?? ''}
                aria-label="Pairing code"
                className="resize-none break-all rounded-md border border-input bg-background px-2.5 py-2 font-mono text-[10px] outline-none"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" onClick={() => void navigator.clipboard.writeText(collaboration.inviteCode ?? '')}>
                <Copy />Copy code
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void store.stopHosting()}><Square />Stop</Button>
            </div>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Keep SnipSnap open while your collaborator joins, pulls, or pushes.
            </p>
          </>}

          {collaboration.mode === 'peer' && <>
            <div className="flex min-w-0 flex-col">
              <strong className="truncate text-xs">{collaboration.peerName ?? 'LAN host'}</strong>
              <span className="truncate font-mono text-[10px] text-muted-foreground">{collaboration.address}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="w-full"
                      disabled={dirty}
                      onClick={() => void store.pullProject()}
                    ><Download />Pull</Button>
                  </span>
                </TooltipTrigger>
                {dirty && <TooltipContent>Commit or discard local changes before pulling</TooltipContent>}
              </Tooltip>
              <Button size="sm" onClick={() => void store.pushProject()}><Upload />Push commits</Button>
            </div>
            {collaboration.lastSyncedAt && <span className="text-[10px] text-muted-foreground">
              Last synced {relativeTime(collaboration.lastSyncedAt)}
            </span>}
          </>}

          {collaboration.progress && collaboration.progress.stage !== 'complete' && <div className="grid gap-1.5 rounded-md border border-primary/30 bg-primary/10 p-2">
            <div className="flex items-center justify-between gap-2 font-mono text-[9px]">
              <span className="truncate">{collaboration.progress.fileName ?? collaboration.progress.stage}</span>
              <strong>{transferPercent}%</strong>
            </div>
            <progress
              value={collaboration.progress.completedBytes}
              max={Math.max(1, collaboration.progress.totalBytes)}
              className="h-1.5 w-full accent-primary"
            />
            <span className="font-mono text-[9px] text-muted-foreground">
              {collaboration.progress.completedFiles}/{collaboration.progress.totalFiles} files verified
            </span>
          </div>}
        </div>
      </section>

      <section aria-label="Branches" className="vg-side-section">
        <PanelHeading title="Branch" count={status.branches.length} />
        <div className="flex flex-col gap-3 p-3">
          <div className="flex items-center justify-between gap-2">
            <Badge variant="info" className="min-w-0 max-w-[60%] truncate"><GitBranch className="h-3 w-3 shrink-0" />{status.branch}</Badge>
            <code className="font-mono text-[10px] text-muted-foreground">{shortId(status.headCommit)}</code>
          </div>
          <Select value={status.branch} onValueChange={guardedCheckout}>
            <SelectTrigger aria-label="Switch branch">
              <span className="flex items-center gap-2"><GitBranch className="h-3.5 w-3.5 text-primary" /><SelectValue /></span>
            </SelectTrigger>
            <SelectContent>
              {status.branches.map(({ name, commitId }) => <SelectItem key={name} value={name}>
                {name} · {shortId(commitId)}
              </SelectItem>)}
            </SelectContent>
          </Select>
          <form className="flex gap-2" onSubmit={submitBranch}>
            <Input
              aria-label="Branch from selected commit"
              value={branchName}
              placeholder="New branch name"
              onChange={(event) => setBranchName(event.target.value)}
            />
            <Button disabled={!branchName.trim()}>Create</Button>
          </form>
        </div>
      </section>

      <section aria-label="Merge" className="vg-side-section">
        <PanelHeading title="Merge" />
        <div className="flex flex-col gap-2 p-3">
          <Select value={mergeSource} onValueChange={setMergeSource}>
            <SelectTrigger aria-label="Merge source branch">
              <SelectValue placeholder="Choose a branch…" />
            </SelectTrigger>
            <SelectContent>
              {otherBranches.map(({ name }) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant="secondary"
                  className="w-full min-w-0 overflow-hidden"
                  disabled={!mergeSource || dirty}
                  onClick={() => void store.merge(mergeSource)}
                ><GitMerge className="shrink-0" /><span className="truncate">Merge into {status.branch}</span></Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {dirty
                ? 'Commit or discard the working changes before merging'
                : 'Replays both branches over their common commit; conflicting cuts stop for your decision'}
            </TooltipContent>
          </Tooltip>
        </div>
      </section>

      <section aria-label="Timeline details" className="vg-side-section">
        <PanelHeading title="Timeline" />
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 p-3 text-xs">
          {[
            ['Duration', framesToTimecode(revision.preview.totalFrames, fps)],
            ['Format', `${revision.preview.width}×${revision.preview.height}`],
            ['Frame rate', `${fps.toFixed(3).replace(/\.?0+$/u, '')} fps`],
            ['Tracks', revision.preview.tracks.map((track) => track.name.split(' - ')[0] ?? track.name).join(' · ') || '—'],
            ['Media', revision.preview.missingAssets.length
              ? `${revision.preview.missingAssets.length} offline`
              : 'All linked'],
          ].map(([label, value]) => <div key={label} className="flex min-w-0 flex-col">
            <dt className="text-[9px] tracking-widest text-muted-foreground">{label}</dt>
            <dd
              className={cn('truncate font-mono text-[11px]', label === 'Media' && revision.preview.missingAssets.length && 'text-removed')}
              title={value}
            >
              {value}
            </dd>
          </div>)}
        </dl>
      </section>
    </aside>

    {!diffOpen && <div className="vg-studio-rail">
      <TimelineTracks plan={revision.preview} playhead={playhead} onSeek={setPlayhead} />
    </div>}
  </main>;
}
