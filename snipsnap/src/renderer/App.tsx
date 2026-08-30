import { useEffect } from 'react';
import { Dashboard } from './Dashboard';
import { Editor } from './Editor';
import { MergeDialog } from './MergeDialog';
import { useAppStore } from './store';

export function App() {
  const store = useAppStore();

  useEffect(() => {
    const stopSourceListening = store.listenForSourceChanges();
    const stopCollaborationListening = store.listenForCollaborationChanges();
    void store.initialize();
    return () => {
      stopSourceListening();
      stopCollaborationListening();
    };
  }, []);

  useEffect(() => {
    if (!store.notice) return undefined;
    const timer = window.setTimeout(() => store.clearNotice(), 6000);
    return () => window.clearTimeout(timer);
  }, [store.notice]);

  const editing = store.route.name === 'editor';
  const status = store.status;

  return <div className="app-shell">
    <nav className="rail" aria-label="Primary">
      <button
        className={`rail-button ${editing ? '' : 'active'}`}
        aria-label="Dashboard"
        title="Projects"
        onClick={() => void store.goToDashboard()}
      >⌂</button>
      <button
        className={`rail-button ${editing ? 'active' : ''}`}
        aria-label="Editor"
        title="Timeline editor"
        disabled={!editing}
      >⧉</button>
    </nav>

    <div className="frame">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span className="brand-name">SnipSnap</span>
        </div>

        {editing && status && <div
          className="project-path"
          title={`${status.resolve?.drpPath || status.resolve?.folder || status.path}\nTimeline: ${status.resolve?.otioPath ?? '—'}`}
        >
          <span className="path-icon" aria-hidden="true">▤</span>
          <span className="path-project">{status.project.name}</span>
          <span className="path-text">{status.resolve?.drpPath || status.resolve?.folder || status.path}</span>
          {status.resolve && <span className="path-timeline">⧉ {status.resolve.timelineName}</span>}
        </div>}

        <div className="top-actions">
          {editing && status
            ? <button
              className="primary"
              onClick={() => void store.exportRevision(store.selectedRevision?.commit.id ?? status.headCommit)}
            >Export OTIO</button>
            : null}
        </div>
      </header>

      {store.busy && <div className="progress" aria-label="Working" />}
      {store.error && <div className="alert error" role="alert">
        <span>{store.error}</span>
        <button aria-label="Dismiss error" onClick={store.clearError}>×</button>
      </div>}
      {store.notice && <div className="alert notice" role="status">
        <span>{store.notice}</span>
        <button aria-label="Dismiss notice" onClick={store.clearNotice}>×</button>
      </div>}

      {editing ? <Editor /> : <Dashboard />}
    </div>

    {store.mergeSession && <MergeDialog
      session={store.mergeSession}
      busy={store.busy}
      onResolve={(conflictId, choice) => void store.resolve(conflictId, choice)}
      onComplete={() => void store.completeMerge()}
      onAbort={() => void store.abortMerge()}
    />}
  </div>;
}
