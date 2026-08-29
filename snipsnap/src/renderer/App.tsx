import { useEffect, useState, type FormEvent } from 'react';
import type { SemanticHunk } from '../diff';
import { useAppStore } from './store';

function HunkCard({ hunk, action, label }: { hunk: SemanticHunk; action(): void; label: string }) {
  return <article className="hunk-card">
    <div><span className={`operation ${hunk.operation}`}>{hunk.operation}</span><strong>{hunk.message}</strong></div>
    <small>{hunk.entityType} · {hunk.fieldGroup} · {hunk.entityId.slice(0, 8)}</small>
    <button className="small-button" onClick={action}>{label}</button>
  </article>;
}

export function App() {
  const store = useAppStore();
  const [commitMessage, setCommitMessage] = useState('');
  const [branchName, setBranchName] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [tagName, setTagName] = useState('');

  useEffect(() => { void store.initialize(); }, []);

  const status = store.status;
  const otherBranches = status?.branches.filter(({ name }) => name !== status.branch) ?? [];
  const submitCommit = (event: FormEvent) => {
    event.preventDefault();
    if (!commitMessage.trim()) return;
    void store.commit(commitMessage).then(() => setCommitMessage(''));
  };
  const submitBranch = (event: FormEvent) => {
    event.preventDefault();
    if (!branchName.trim()) return;
    void store.createBranch(branchName).then(() => setBranchName(''));
  };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark">S</div>
      <div><h1>SnipSnap</h1><p>Semantic Git for the cut</p></div>
      <div className="top-actions">
        <select aria-label="Project" value={store.currentProjectId ?? ''} onChange={(event) => void store.selectProject(event.target.value)}>
          <option value="" disabled>Select project</option>
          {store.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <button onClick={() => void store.importOtio()}>Import OTIO</button>
        <button className="primary" onClick={() => void store.createDemo()}>New demo</button>
      </div>
    </header>

    {store.error && <div className="alert error" role="alert"><span>{store.error}</span><button onClick={store.clearError}>×</button></div>}
    {store.notice && <div className="alert notice">{store.notice}</div>}
    {store.busy && <div className="progress" aria-label="Working" />}

    {!status ? <main className="empty-state">
      <div className="empty-icon">⌁</div><h2>Version a timeline, not a media folder.</h2>
      <p>Import a Resolve OTIO file or create a deterministic demo repository.</p>
      <button className="primary" onClick={() => void store.createDemo()}>Create demo repository</button>
    </main> : <main className="workspace">
      <section className="main-column">
        <div className="project-heading">
          <div><span className="eyebrow">WORKING TIMELINE</span><h2>{status.project.name}</h2></div>
          <div className="head-chip"><span>branch</span>{status.branch}<code>{status.headCommit.slice(0, 8)}</code></div>
        </div>

        <section className="panel timeline-panel">
          <div className="panel-title"><div><span className="eyebrow">SEQUENCE</span><h3>{status.project.sequences[0]?.name}</h3></div><span>{status.project.sequences[0]?.fps.numerator}/{status.project.sequences[0]?.fps.denominator} fps</span></div>
          <div className="ruler"><span>00:00</span><span>00:05</span><span>00:10</span><span>00:15</span><span>00:20</span></div>
          {status.project.tracks.map((track) => <div className="track" key={track.id}>
            <div className="track-label"><strong>{track.name}</strong><small>{track.kind}</small></div>
            <div className="track-lane">
              {track.itemIds.map((itemId, index) => {
                const clip = status.project.clips.find(({ id }) => id === itemId);
                const caption = status.project.captions.find(({ id }) => id === itemId);
                const gap = status.project.gaps.find(({ id }) => id === itemId);
                if (gap) return <div key={itemId} className="timeline-gap" style={{ flex: Math.max(gap.durationFrames, 24) }}>gap {gap.durationFrames}f</div>;
                if (caption) return <div key={itemId} className="timeline-caption" style={{ flex: caption.range.duration }}>{caption.text}</div>;
                if (!clip) return null;
                return <div key={itemId} className={`timeline-clip tint-${index % 3}`} style={{ flex: clip.sourceRange.duration }}>
                  <strong>{clip.name}</strong><span>{clip.sourceRange.start}–{clip.sourceRange.start + clip.sourceRange.duration}f</span>
                </div>;
              })}
            </div>
          </div>)}
        </section>

        <section className="changes-grid">
          <div className="panel">
            <div className="panel-title"><h3>Unstaged changes</h3><span className="count">{status.unstaged.length}</span></div>
            <div className="hunk-list">{status.unstaged.length === 0 ? <p className="muted">Working matches the semantic index.</p> : status.unstaged.map((hunk) => <HunkCard key={hunk.id} hunk={hunk} label="Stage" action={() => void store.stage(hunk.id)} />)}</div>
          </div>
          <div className="panel">
            <div className="panel-title"><h3>Staged changes</h3><span className="count staged">{status.staged.length}</span></div>
            <div className="hunk-list">{status.staged.length === 0 ? <p className="muted">Stage a complete semantic decision.</p> : status.staged.map((hunk) => <HunkCard key={hunk.id} hunk={hunk} label="Unstage" action={() => void store.unstage(hunk.id)} />)}</div>
            <form className="commit-form" onSubmit={submitCommit}><input aria-label="Commit message" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Describe the editorial decision" /><button className="primary" disabled={!status.staged.length}>Commit</button></form>
          </div>
        </section>

        <section className="panel compare-panel">
          <div className="panel-title"><div><span className="eyebrow">COMPARE & MERGE</span><h3>{status.branch} against another cut</h3></div></div>
          <div className="inline-actions"><select aria-label="Compare branch" value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)}><option value="">Choose branch</option>{otherBranches.map(({ name }) => <option key={name}>{name}</option>)}</select><button disabled={!selectedBranch} onClick={() => void store.compare(selectedBranch)}>Compare</button><button className="primary" disabled={!selectedBranch} onClick={() => void store.merge(selectedBranch)}>Merge into {status.branch}</button></div>
          {store.comparison.map((hunk) => <div className="compare-row" key={hunk.id}><span>Δ</span><div><strong>{hunk.message}</strong><small>{hunk.fieldGroup} · {hunk.affectedFrameRange ? `${hunk.affectedFrameRange.start}–${hunk.affectedFrameRange.start + hunk.affectedFrameRange.duration}f` : 'project-wide'}</small></div></div>)}
        </section>
      </section>

      <aside className="sidebar">
        <section className="panel">
          <span className="eyebrow">BRANCHES</span>
          <div className="branch-list">{status.branches.map((branch) => <button className={branch.name === status.branch ? 'active' : ''} key={branch.name} onClick={() => {
            if (branch.name === status.branch) return;
            const dirty = status.staged.length > 0 || status.unstaged.length > 0;
            const discard = dirty && window.confirm('Discard staged and working changes before checkout?');
            if (!dirty || discard) void store.checkout(branch.name, discard);
          }}><span>⑂</span>{branch.name}<code>{branch.commitId.slice(0, 6)}</code></button>)}</div>
          <form className="stack-form" onSubmit={submitBranch}><input aria-label="New branch" value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="new-cut" /><button>Create branch</button></form>
        </section>
        <section className="panel">
          <span className="eyebrow">RELEASE</span>
          <div className="stack-form"><input aria-label="Tag name" value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder="v1.0" /><button disabled={!tagName} onClick={() => void store.tag(tagName).then(() => setTagName(''))}>Tag HEAD</button><button className="primary" onClick={() => void store.exportOtio()}>Export HEAD as OTIO</button></div>
        </section>
        <section className="panel history-panel">
          <span className="eyebrow">HISTORY</span>
          {status.history.slice(0, 12).map((commit, index) => <div className="commit-row" key={commit.id}><div className="graph-dot">{index === 0 ? '●' : '○'}</div><div><strong>{commit.message}</strong><small>{commit.id.slice(0, 8)} · {commit.parents.length} parent{commit.parents.length === 1 ? '' : 's'}</small></div></div>)}
        </section>
      </aside>
    </main>}

    {store.mergeSession && <div className="modal-backdrop"><section className="modal" role="dialog" aria-label="Merge conflicts"><span className="eyebrow">MERGE PAUSED</span><h2>Resolve editorial conflicts</h2><p>The target branch is unchanged until every conflict is resolved and the provisional timeline validates.</p>{store.mergeSession.result.conflicts.map((conflict) => <article className="conflict-card" key={conflict.id}><span className="operation delete">{conflict.type}</span><strong>{conflict.message}</strong>{conflict.validationErrors?.map((error) => <small key={error}>{error}</small>)}<div className="conflict-actions"><button onClick={() => void store.resolve(conflict.id, 'base')}>Base</button><button onClick={() => void store.resolve(conflict.id, 'ours')}>Ours</button><button onClick={() => void store.resolve(conflict.id, 'theirs')}>Theirs</button></div></article>)}<div className="modal-actions"><button onClick={() => void store.abortMerge()}>Abort safely</button><button className="primary" disabled={store.mergeSession.result.conflicts.length > 0} onClick={() => void store.completeMerge()}>Complete merge</button></div></section></div>}
  </div>;
}
