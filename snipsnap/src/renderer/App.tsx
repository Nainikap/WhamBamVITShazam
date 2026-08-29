import { useEffect, useState, type FormEvent } from 'react';
import type { SemanticHunk } from '../diff';
import { CommitPlayer } from './CommitPlayer';
import { useAppStore } from './store';

function HunkCard({ hunk, action, label }: { hunk: SemanticHunk; action?(): void; label?: string }) {
  return <article className="hunk-card">
    <div><span className={`operation ${hunk.operation}`}>{hunk.operation}</span><strong>{hunk.message}</strong></div>
    <small>{hunk.entityType} · {hunk.fieldGroup}{hunk.affectedFrameRange ? ` · ${hunk.affectedFrameRange.start}–${hunk.affectedFrameRange.start + hunk.affectedFrameRange.duration}f` : ''}</small>
    {action && label && <button className="small-button" onClick={action}>{label}</button>}
  </article>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function App() {
  const store = useAppStore();
  const [commitMessage, setCommitMessage] = useState('');
  const [branchName, setBranchName] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [tagName, setTagName] = useState('');

  useEffect(() => {
    const stopListening = store.listenForSourceChanges();
    void store.initialize();
    return stopListening;
  }, []);

  const status = store.status;
  const revision = store.selectedRevision;
  const otherBranches = status?.branches.filter(({ name }) => name !== status.branch) ?? [];

  const submitCommit = (event: FormEvent) => {
    event.preventDefault();
    if (!commitMessage.trim()) return;
    void store.commit(commitMessage).then(() => setCommitMessage(''));
  };
  const submitBranch = (event: FormEvent) => {
    event.preventDefault();
    if (!branchName.trim()) return;
    void store.createBranchFromSelected(branchName).then(() => setBranchName(''));
  };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark">S</div>
      <div><h1>SnipSnap</h1><p>Version control for Resolve timelines</p></div>
      <div className="top-actions">
        <select aria-label="Project" value={store.currentProjectId ?? ''} onChange={(event) => void store.selectProject(event.target.value)}>
          <option value="" disabled>Select project</option>
          {store.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <button onClick={() => void store.importOtio()}>Import Resolve OTIO</button>
        <button className="primary" onClick={() => void store.createDemo()}>New demo</button>
      </div>
    </header>

    {store.error && <div className="alert error" role="alert"><span>{store.error}</span><button aria-label="Dismiss error" onClick={store.clearError}>×</button></div>}
    {store.notice && <div className="alert notice" role="status">{store.notice}</div>}
    {store.busy && <div className="progress" aria-label="Working" />}

    {!status || !revision ? <main className="empty-state">
      <div className="empty-icon">⌁</div><h2>See every cut. Keep every version.</h2>
      <p>Import a Resolve OTIO timeline. SnipSnap tracks, commits, branches, and previews it without editing the video.</p>
      <div className="empty-actions"><button className="primary" onClick={() => void store.importOtio()}>Import Resolve OTIO</button><button onClick={() => void store.createDemo()}>Create demo repository</button></div>
    </main> : <main className="workspace">
      <section className="main-column">
        <div className="project-heading">
          <div><span className="eyebrow">RESOLVE PROJECT</span><h2>{status.project.name}</h2></div>
          <div className="head-chip"><span>branch</span>{status.branch}<code>{status.headCommit.slice(0, 8)}</code></div>
        </div>

        <section className={`panel source-panel source-${status.source.state}`}>
          <div className="source-summary">
            <div className="source-icon">↻</div>
            <div><span className="eyebrow">RESOLVE SYNC</span><h3>{status.source.connected ? status.source.fileName : 'No OTIO source connected'}</h3><p>{status.source.connected ? status.source.filePath : 'Connect the OTIO file that Resolve overwrites when you export the active timeline.'}</p></div>
            <div className="source-actions">
              <span className={`status-pill ${status.source.state}`}>{status.source.state.replace('-', ' ')}</span>
              {status.source.connected
                ? <button onClick={() => void store.scanSource()}>Check now</button>
                : <button className="primary" onClick={() => void store.connectSource()}>Connect OTIO</button>}
            </div>
          </div>
          {status.source.pending && <div className="pending-sync">
            <div className="pending-heading"><div><strong>{status.source.pending.changeCount} Resolve change{status.source.pending.changeCount === 1 ? '' : 's'} detected</strong><small>Reviewing does not alter HEAD, INDEX, or WORKING.</small></div><span>{status.source.pending.unsupportedCount ? `${status.source.pending.unsupportedCount} unsupported` : 'Supported cut-only update'}</span></div>
            <div className="pending-changes">{status.source.pending.changes.map((hunk) => <HunkCard key={hunk.id} hunk={hunk} />)}</div>
            <div className="pending-actions"><button onClick={() => void store.dismissSource()}>Ignore this export</button><button className="primary" onClick={() => void store.applySource()}>Apply to WORKING</button></div>
          </div>}
        </section>

        <section className="panel preview-panel">
          <div className="panel-title revision-title">
            <div><span className="eyebrow">SELECTED COMMIT</span><h3>{revision.commit.message}</h3><small>{revision.commit.id} · {formatDate(revision.commit.authoredAt)}</small></div>
            <div className="revision-actions"><button onClick={() => void store.exportSelected()}>Export OTIO</button><button onClick={() => {
              const dirty = status.staged.length > 0 || status.unstaged.length > 0;
              const discard = dirty && window.confirm('Replace staged and working changes with this commit?');
              if (!dirty || discard) void store.restoreSelected(discard);
            }} disabled={revision.commit.id === status.headCommit}>Restore to WORKING</button></div>
          </div>
          <CommitPlayer plan={revision.preview} onRelink={(fingerprint) => void store.relinkMedia(fingerprint)} />
          {revision.pointedToBy.length > 0 && <div className="ref-row">Branches here: {revision.pointedToBy.map((name) => <span key={name}>{name}</span>)}</div>}
        </section>

        <section className="panel selected-diff">
          <div className="panel-title"><div><span className="eyebrow">COMMIT DIFF</span><h3>{revision.comparedParent ? `Compared with ${revision.comparedParent.slice(0, 8)}` : 'Initial timeline snapshot'}</h3></div><span className="count">{revision.diff.length}</span></div>
          {revision.commit.parents.length > 1 && <div className="parent-selector"><span>Compare against parent</span>{revision.commit.parents.map((parent, index) => <button className={revision.comparedParent === parent ? 'active' : ''} key={parent} onClick={() => void store.loadRevision(revision.commit.id, index)}>{index + 1}: {parent.slice(0, 8)}</button>)}</div>}
          <div className="hunk-list">{revision.diff.length ? revision.diff.map((hunk) => <HunkCard key={hunk.id} hunk={hunk} />) : <p className="muted">This is the root commit; it has no parent diff.</p>}</div>
        </section>

        <section className="changes-grid">
          <div className="panel">
            <div className="panel-title"><div><span className="eyebrow">WORKING</span><h3>Unstaged Resolve changes</h3></div><span className="count">{status.unstaged.length}</span></div>
            <div className="hunk-list">{status.unstaged.length === 0 ? <p className="muted">WORKING matches the semantic index.</p> : status.unstaged.map((hunk) => <HunkCard key={hunk.id} hunk={hunk} label="Stage" action={() => void store.stage(hunk.id)} />)}</div>
          </div>
          <div className="panel">
            <div className="panel-title"><div><span className="eyebrow">INDEX</span><h3>Staged for commit</h3></div><span className="count staged">{status.staged.length}</span></div>
            <div className="hunk-list">{status.staged.length === 0 ? <p className="muted">Stage complete editorial decisions from the working timeline.</p> : status.staged.map((hunk) => <HunkCard key={hunk.id} hunk={hunk} label="Unstage" action={() => void store.unstage(hunk.id)} />)}</div>
            <form className="commit-form" onSubmit={submitCommit}><input aria-label="Commit message" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Describe this Resolve cut" /><button className="primary" disabled={!status.staged.length}>Commit</button></form>
          </div>
        </section>

        <section className="panel compare-panel">
          <div className="panel-title"><div><span className="eyebrow">COMPARE & MERGE</span><h3>{status.branch} against another cut</h3></div></div>
          <div className="inline-actions"><select aria-label="Compare branch" value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)}><option value="">Choose branch</option>{otherBranches.map(({ name }) => <option key={name}>{name}</option>)}</select><button disabled={!selectedBranch} onClick={() => void store.compare(selectedBranch)}>Compare</button><button className="primary" disabled={!selectedBranch} onClick={() => void store.merge(selectedBranch)}>Merge into {status.branch}</button></div>
          {store.comparison.map((hunk) => <div className="compare-row" key={hunk.id}><span>Δ</span><div><strong>{hunk.message}</strong><small>{hunk.fieldGroup} · {hunk.affectedFrameRange ? `${hunk.affectedFrameRange.start}–${hunk.affectedFrameRange.start + hunk.affectedFrameRange.duration}f` : 'project-wide'}</small></div></div>)}
        </section>
      </section>

      <aside className="sidebar">
        <section className="panel history-panel">
          <div className="panel-title"><div><span className="eyebrow">HISTORY</span><h3>Committed cuts</h3></div><span>{status.history.length}</span></div>
          <div className="history-list">{status.history.map((commit) => <button aria-label={`View commit ${commit.message}`} className={`commit-row ${revision.commit.id === commit.id ? 'selected' : ''}`} key={commit.id} onClick={() => void store.loadRevision(commit.id)}><div className="graph-dot">{commit.id === status.headCommit ? '●' : '○'}</div><div><strong>{commit.message}</strong><small>{commit.id.slice(0, 8)} · {commit.parents.length} parent{commit.parents.length === 1 ? '' : 's'}</small></div></button>)}</div>
        </section>

        <section className="panel">
          <span className="eyebrow">CONTINUE FROM HERE</span>
          <p className="panel-copy">Create and switch to a branch starting at <code>{revision.commit.id.slice(0, 8)}</code>.</p>
          <form className="stack-form" onSubmit={submitBranch}><input aria-label="Branch from selected commit" value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="alternate-cut" /><button className="primary">Create branch here</button></form>
        </section>

        <section className="panel">
          <div className="panel-title"><div><span className="eyebrow">BRANCHES</span><h3>Project cuts</h3></div><span>{status.branches.length}</span></div>
          <div className="branch-list">{status.branches.map((branch) => <button aria-label={`Switch to branch ${branch.name}`} className={branch.name === status.branch ? 'active' : ''} key={branch.name} onClick={() => {
            if (branch.name === status.branch) return;
            const dirty = status.staged.length > 0 || status.unstaged.length > 0;
            const discard = dirty && window.confirm('Discard staged and working changes before switching branches?');
            if (!dirty || discard) void store.checkout(branch.name, discard);
          }}><span>⑂</span>{branch.name}<code>{branch.commitId.slice(0, 6)}</code></button>)}</div>
        </section>

        <section className="panel">
          <span className="eyebrow">MARK & EXPORT</span>
          <div className="stack-form"><input aria-label="Tag name" value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder="approved-v1" /><button disabled={!tagName} onClick={() => void store.tag(tagName).then(() => setTagName(''))}>Tag selected commit</button><button onClick={() => void store.exportSelected()}>Export selected OTIO</button></div>
        </section>
      </aside>
    </main>}

    {store.mergeSession && <div className="modal-backdrop"><section className="modal" role="dialog" aria-label="Merge conflicts"><span className="eyebrow">MERGE PAUSED</span><h2>Resolve timeline conflicts</h2><p>The target branch is unchanged until every conflict is resolved and the provisional timeline validates.</p>{store.mergeSession.result.conflicts.map((conflict) => <article className="conflict-card" key={conflict.id}><span className="operation delete">{conflict.type}</span><strong>{conflict.message}</strong>{conflict.validationErrors?.map((error) => <small key={error}>{error}</small>)}<div className="conflict-actions"><button onClick={() => void store.resolve(conflict.id, 'base')}>Base</button><button onClick={() => void store.resolve(conflict.id, 'ours')}>Ours</button><button onClick={() => void store.resolve(conflict.id, 'theirs')}>Theirs</button></div></article>)}<div className="modal-actions"><button onClick={() => void store.abortMerge()}>Abort safely</button><button className="primary" disabled={store.mergeSession.result.conflicts.length > 0} onClick={() => void store.completeMerge()}>Complete merge</button></div></section></div>}
  </div>;
}
