import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { SemanticHunk } from '../diff';
import { CommitGraph } from './CommitGraph';
import { CommitPlayer } from './CommitPlayer';
import { DiffView } from './DiffView';
import { TimelineTracks } from './TimelineTracks';
import { absoluteTime, framesToTimecode, relativeTime, shortId } from './format';
import { useAppStore } from './store';

function HunkRow({ hunk, actionLabel, onAction, fps }: {
  hunk: SemanticHunk;
  actionLabel?: string;
  onAction?(): void;
  fps: number;
}) {
  const range = hunk.affectedFrameRange;
  return <article className="hunk-row">
    <span className={`operation ${hunk.operation}`}>{hunk.operation}</span>
    <div>
      <strong>{hunk.message}</strong>
      <small>
        {hunk.entityType} · {hunk.fieldGroup}
        {range ? ` · ${framesToTimecode(range.start, fps)} → ${framesToTimecode(range.start + range.duration, fps)}` : ''}
      </small>
    </div>
    {actionLabel && onAction && <button className="small-button" onClick={onAction}>{actionLabel}</button>}
  </article>;
}

export function Editor() {
  const store = useAppStore();
  const status = store.status;
  const revision = store.selectedRevision;
  const [commitMessage, setCommitMessage] = useState('');
  const [branchName, setBranchName] = useState('');
  const [mergeSource, setMergeSource] = useState('');
  const [playhead, setPlayhead] = useState(0);

  useEffect(() => {
    setPlayhead(0);
  }, [revision?.commit.id]);

  const otherBranches = useMemo(
    () => (status?.branches ?? []).filter(({ name }) => name !== status?.branch),
    [status?.branches, status?.branch],
  );

  if (!status || !revision) {
    return <main className="editor editor-loading"><p className="muted">Opening project…</p></main>;
  }

  const fps = revision.preview.fps;
  const dirty = status.staged.length > 0 || status.unstaged.length > 0 || Boolean(status.source.pending);
  const canCommit = status.staged.length > 0;
  const canDiff = status.history.length > 1;
  const resolveSyncActive = status.source.mode === 'resolve'
    && ['starting', 'waiting-for-resolve', 'watching'].includes(status.source.state);

  function guardedCheckout(branch: string): void {
    if (!status || branch === status.branch) return;
    const discard = dirty
      && window.confirm(`Switching to ${branch} discards the staged and working changes on ${status.branch}. Continue?`);
    if (!dirty || discard) void store.checkout(branch, discard);
  }

  function openDiff(): void {
    if (!status || !revision) return;
    const parent = revision.commit.parents[0];
    const base = parent ?? revision.commit.id;
    const head = parent ? revision.commit.id : status.headCommit;
    void store.openDiff(base, head);
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

  return <main className="editor">
    <aside className="history-panel" aria-label="Commit history">
      <div className="panel-head">
        <h2>Commit history</h2>
        <span className="count">{status.history.length}</span>
      </div>
      <div className="history-list">
        {status.history.map((commit) => <button
          key={commit.id}
          aria-label={`View commit ${commit.message}`}
          className={`commit-row ${commit.id === revision.commit.id ? 'selected' : ''}`}
          onClick={() => void store.loadRevision(commit.id)}
        >
          <span className={`dot ${commit.id === status.headCommit ? 'head' : ''} ${commit.parents.length > 1 ? 'merge' : ''}`} />
          <span className="commit-body">
            <strong>{commit.message}</strong>
            <small>{commit.author.replace(/\s*<[^>]*>/u, '')} · {relativeTime(commit.authoredAt)}</small>
            <span className="commit-refs">
              <code>{shortId(commit.id)}</code>
              {status.branches.filter(({ commitId }) => commitId === commit.id)
                .map(({ name }) => <em key={name}>{name}</em>)}
              {commit.parents.length > 1 && <em className="merge-tag">merge</em>}
            </span>
          </span>
        </button>)}
      </div>
    </aside>

    <section className="stage-column">
      {store.diffOpen && store.comparison
        ? <DiffView
          comparison={store.comparison}
          history={status.history}
          onSelectBase={(id) => void store.openDiff(id, store.comparison?.head.commit.id ?? id)}
          onSelectHead={(id) => void store.openDiff(store.comparison?.base.commit.id ?? id, id)}
          onClose={store.closeDiff}
        />
        : <>
          <div className="stage-head">
            <div>
              <span className="eyebrow">VIEWING</span>
              <h2>{revision.commit.message}</h2>
              <small><code>{shortId(revision.commit.id)}</code> · {absoluteTime(revision.commit.authoredAt)}</small>
            </div>
            <div className="stage-actions">
              {revision.commit.parents.length > 1 && <div className="parent-selector">
                <span>Compare parent</span>
                {revision.commit.parents.map((parent, index) => <button
                  key={parent}
                  className={revision.comparedParent === parent ? 'active' : ''}
                  onClick={() => void store.loadRevision(revision.commit.id, index)}
                >{index + 1}</button>)}
              </div>}
              <button
                disabled={revision.commit.id === status.headCommit}
                onClick={() => {
                  const discard = dirty && window.confirm('Replace the staged and working timeline with this commit?');
                  if (!dirty || discard) void store.restoreSelected(discard);
                }}
              >Restore to working</button>
            </div>
          </div>

          <CommitPlayer
            plan={revision.preview}
            onRelink={(fingerprint) => void store.relinkMedia(fingerprint)}
            playhead={playhead}
            onPlayheadChange={setPlayhead}
          />

          <section className={`source-strip source-${status.source.state}`}>
            <span className={`status-pill ${status.source.state}`}>{status.source.state.replace('-', ' ')}</span>
            <div className="source-body">
              <strong>{status.source.mode === 'resolve'
                ? `${status.source.resolveProjectName ?? 'DaVinci Resolve'} · ${status.source.resolveTimelineName ?? 'active timeline'}`
                : status.source.connected ? status.source.fileName : 'Connect SnipSnap to DaVinci Resolve'}</strong>
              <small title={status.source.filePath}>
                {status.source.error ?? (status.source.mode === 'resolve'
                  ? status.source.lastSavedAt
                    ? `Last saved timeline received ${absoluteTime(status.source.lastSavedAt)}. Latest save is WORKING.`
                    : 'Open Resolve, select the timeline, and save the project.'
                  : status.source.filePath
                    ?? 'Save sync exports internally once per Resolve save; no repeated OTIO filenames.')}
              </small>
            </div>
            <div className="source-buttons">
              {status.source.mode === 'file' && <button onClick={() => void store.scanSource()}>Check file</button>}
              {resolveSyncActive
                ? <button onClick={() => void store.stopResolveSync()}>Stop sync</button>
                : <button className="primary" onClick={() => void store.startResolveSync()}>
                  {status.source.mode === 'resolve' ? 'Restart sync' : 'Start save sync'}
                </button>}
              {status.source.mode !== 'file' && <button onClick={() => void store.connectSource()}>Use OTIO file</button>}
            </div>
          </section>

          {status.source.pending && <section className="pending-sync">
            <div className="pending-head">
              <strong>{status.source.pending.changeCount} change{status.source.pending.changeCount === 1 ? '' : 's'} detected in Resolve</strong>
              <span>{status.source.pending.unsupportedCount
                ? `${status.source.pending.unsupportedCount} unsupported`
                : 'Supported cut-only update'}</span>
            </div>
            <div className="pending-actions">
              <button onClick={() => void store.dismissSource()}>Ignore</button>
              <button className="primary" onClick={() => void store.applySource()}>Apply to working timeline</button>
            </div>
          </section>}

          <section className="head-working-summary">
            <div className="pending-head">
              <strong>HEAD → WORKING</strong>
              <span>{status.workingChanges.length} semantic change{status.workingChanges.length === 1 ? '' : 's'}</span>
            </div>
            <small>Every hunk below is cumulative from the last SnipSnap commit. A newer Resolve save replaces WORKING instead of creating hidden history.</small>
            <div className="head-working-hunks">
              {status.workingChanges.length === 0
                ? <p className="muted">The latest saved Resolve timeline matches HEAD.</p>
                : status.workingChanges.map((hunk) => <HunkRow key={hunk.id} hunk={hunk} fps={fps} />)}
            </div>
          </section>

          <TimelineTracks plan={revision.preview} playhead={playhead} onSeek={setPlayhead} />
        </>}
    </section>

    <aside className="inspector" aria-label="Inspector">
      <section className="inspector-block">
        <div className="panel-head">
          <h3>Branch</h3>
          <span className="count">{status.branches.length}</span>
        </div>
        <div className="branch-current">
          <span className="branch-chip large">⑂ {status.branch}</span>
          <code>{shortId(status.headCommit)}</code>
        </div>
        <label className="field">
          <span>Switch branch</span>
          <select
            aria-label="Switch branch"
            value={status.branch}
            onChange={(event) => guardedCheckout(event.target.value)}
          >
            {status.branches.map(({ name, commitId }) => <option key={name} value={name}>
              {name} · {shortId(commitId)}
            </option>)}
          </select>
        </label>
        <form className="field" onSubmit={submitBranch}>
          <span>New branch from {shortId(revision.commit.id)}</span>
          <div className="field-row">
            <input
              aria-label="Branch from selected commit"
              value={branchName}
              placeholder="alternate-cut"
              onChange={(event) => setBranchName(event.target.value)}
            />
            <button disabled={!branchName.trim()}>Create</button>
          </div>
        </form>
      </section>

      <section className="inspector-block">
        <div className="panel-head"><h3>Merge</h3></div>
        <p className="hint">Merging replays both branches over their common commit. Conflicting cuts stop the merge for your decision.</p>
        <div className="field-column">
          <select
            aria-label="Merge source branch"
            value={mergeSource}
            onChange={(event) => setMergeSource(event.target.value)}
          >
            <option value="">Choose a branch…</option>
            {otherBranches.map(({ name }) => <option key={name} value={name}>{name}</option>)}
          </select>
          <button
            disabled={!mergeSource || dirty}
            title={dirty ? 'Commit or discard the working changes before merging' : undefined}
            onClick={() => void store.merge(mergeSource)}
          >Merge into {status.branch}</button>
        </div>
      </section>

      <section className="inspector-block">
        <div className="panel-head">
          <h3>Staging</h3>
          <span className="count">{status.unstaged.length + status.staged.length}</span>
        </div>

        <div className="stage-group">
          <div className="stage-group-head">
            <span className="eyebrow">WORKING</span>
            <button
              className="small-button"
              disabled={status.unstaged.length === 0}
              onClick={() => void store.stage(status.unstaged.map(({ id }) => id))}
            >Stage all</button>
          </div>
          {status.unstaged.length === 0
            ? <p className="muted">The working timeline matches what is staged.</p>
            : status.unstaged.map((hunk) => <HunkRow
              key={hunk.id}
              hunk={hunk}
              fps={fps}
              actionLabel="Stage"
              onAction={() => void store.stage([hunk.id])}
            />)}
        </div>

        <div className="stage-group">
          <div className="stage-group-head">
            <span className="eyebrow">STAGED</span>
            <button
              className="small-button"
              disabled={status.staged.length === 0}
              onClick={() => void store.unstage(status.staged.map(({ id }) => id))}
            >Unstage all</button>
          </div>
          {status.staged.length === 0
            ? <p className="muted">Nothing staged yet.</p>
            : status.staged.map((hunk) => <HunkRow
              key={hunk.id}
              hunk={hunk}
              fps={fps}
              actionLabel="Unstage"
              onAction={() => void store.unstage([hunk.id])}
            />)}
        </div>

        <form className="commit-form" onSubmit={submitCommit}>
          <input
            aria-label="Commit message"
            value={commitMessage}
            placeholder="Describe this cut"
            onChange={(event) => setCommitMessage(event.target.value)}
          />
          <button className="primary" disabled={!canCommit || !commitMessage.trim()}>Commit</button>
        </form>
        {!canCommit && <small className="hint">
          Nothing is staged, so this version is identical to <code>{shortId(status.headCommit)}</code> — there is nothing to commit.
        </small>}
      </section>

      <section className="inspector-block">
        <div className="panel-head"><h3>Compare</h3></div>
        <button
          className="wide"
          disabled={!canDiff}
          onClick={openDiff}
          title={canDiff ? undefined : 'Two commits are needed before anything can be compared'}
        >See diff</button>
        <small className="hint">Opens both commits side by side and highlights added, changed, and removed footage on every video and audio lane.</small>
      </section>

      <section className="inspector-block graph-block">
        <div className="panel-head">
          <h3>Commit graph</h3>
          <span className="count">{status.history.length}</span>
        </div>
        <CommitGraph
          history={status.history}
          headCommit={status.headCommit}
          selectedCommit={revision.commit.id}
          branches={status.branches}
          onSelect={(commitId) => void store.loadRevision(commitId)}
        />
      </section>
    </aside>
  </main>;
}
