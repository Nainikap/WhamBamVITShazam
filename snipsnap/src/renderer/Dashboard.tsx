import { useEffect, useRef } from 'react';
import type { ProjectOverview } from '../application';
import { durationLabel, frameRateLabel, relativeTime, shortId } from './format';
import { useAppStore } from './store';

const stateLabel: Record<ProjectOverview['state'], string> = {
  clean: 'Committed',
  staged: 'Staged',
  uncommitted: 'Uncommitted',
  'resolve-pending': 'Resolve update',
};

/** Show a real frame of the project's own footage, or an honest offline placeholder. */
function Poster({ project }: { project: ProjectOverview }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const poster = project.poster;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !poster) return;
    const seek = () => {
      video.currentTime = poster.fps > 0 ? poster.sourceStart / poster.fps : 0;
    };
    video.addEventListener('loadedmetadata', seek, { once: true });
    return () => video.removeEventListener('loadedmetadata', seek);
  }, [poster?.mediaUrl, poster?.sourceStart]);

  if (!poster) {
    return <div className="poster poster-offline">
      <span className="poster-glyph" aria-hidden="true">▤</span>
      <small>{project.missingMedia > 0 ? `${project.missingMedia} media file${project.missingMedia === 1 ? '' : 's'} offline` : 'No linked footage'}</small>
    </div>;
  }
  return <div className="poster">
    <video ref={videoRef} src={poster.mediaUrl} muted playsInline preload="metadata" />
  </div>;
}

function Meta({ project }: { project: ProjectOverview }) {
  return <div className="project-meta">
    <span className="branch-chip">⑂ {project.branch}</span>
    <span>{durationLabel(project.durationFrames, project.fps)}</span>
    <span>{project.width}×{project.height}</span>
    <span>{frameRateLabel(project.fps)}</span>
    <span>{project.trackCounts.video}V · {project.trackCounts.audio}A</span>
  </div>;
}

export function Dashboard() {
  const store = useAppStore();
  const filter = store.filter.trim().toLowerCase();
  const matching = filter
    ? store.overviews.filter((project) => project.name.toLowerCase().includes(filter)
      || project.branch.toLowerCase().includes(filter))
    : store.overviews;
  const [latest, ...earlier] = matching;

  if (store.overviews.length === 0) {
    return <main className="dashboard empty-state">
      <div className="empty-icon" aria-hidden="true">⌁</div>
      <h2>See every cut. Keep every version.</h2>
      <p>Import the OTIO file DaVinci Resolve exports. SnipSnap commits, branches, compares, and merges the timeline without ever touching your footage.</p>
      <div className="empty-actions">
        <button className="primary" onClick={() => void store.importOtio()}>Import Resolve OTIO</button>
        <button onClick={() => void store.createDemo()}>Create a sample project</button>
      </div>
    </main>;
  }

  return <main className="dashboard">
    <header className="dashboard-head">
      <div>
        <h1>Video projects</h1>
        <p>Every timeline you version here, most recently edited first.</p>
      </div>
      <div className="dashboard-actions">
        <input
          aria-label="Filter projects"
          className="filter"
          placeholder="Filter projects…"
          value={store.filter}
          onChange={(event) => store.setFilter(event.target.value)}
        />
        <button onClick={() => void store.createDemo()}>New project</button>
        <button className="primary" onClick={() => void store.importOtio()}>Import OTIO</button>
      </div>
    </header>

    {!latest && <p className="muted">No project matches “{store.filter}”.</p>}

    {latest && <section className="latest" aria-label="Latest project">
      <span className="eyebrow">CONTINUE WHERE YOU LEFT OFF</span>
      <button
        className="latest-card"
        aria-label={`Open ${latest.name}`}
        onClick={() => void store.openProject(latest.id)}
      >
        <Poster project={latest} />
        <div className="latest-body">
          <div className="latest-title">
            <h2>{latest.name}</h2>
            <span className={`state-pill state-${latest.state}`}>{stateLabel[latest.state]}</span>
          </div>
          <Meta project={latest} />
          <p className="latest-commit">
            <code>{shortId(latest.headCommit)}</code> {latest.headMessage}
          </p>
          <p className="latest-path" title={latest.path}>{latest.path}</p>
          <div className="latest-foot">
            <span>{relativeTime(latest.updatedAt)}</span>
            <span>{latest.commitCount} commit{latest.commitCount === 1 ? '' : 's'}</span>
            <span>{latest.branchCount} branch{latest.branchCount === 1 ? '' : 'es'}</span>
            {latest.changeCount > 0 && <span className="change-count">{latest.changeCount} pending change{latest.changeCount === 1 ? '' : 's'}</span>}
            <span className="open-hint">Open project →</span>
          </div>
        </div>
      </button>
    </section>}

    {earlier.length > 0 && <section className="earlier" aria-label="Earlier projects">
      <div className="section-head">
        <h2>Worked on earlier</h2>
        <span className="count">{earlier.length}</span>
      </div>
      <ul className="project-list">
        {earlier.map((project) => <li key={project.id}>
          <button
            className="project-row"
            aria-label={`Open ${project.name}`}
            onClick={() => void store.openProject(project.id)}
          >
            <Poster project={project} />
            <div className="project-row-body">
              <div className="project-row-title">
                <strong>{project.name}</strong>
                <span className={`state-pill state-${project.state}`}>{stateLabel[project.state]}</span>
              </div>
              <Meta project={project} />
              <small className="project-row-path" title={project.path}>{project.path}</small>
            </div>
            <div className="project-row-side">
              <span>{relativeTime(project.updatedAt)}</span>
              <code>{shortId(project.headCommit)}</code>
              <small>{project.commitCount} commit{project.commitCount === 1 ? '' : 's'}</small>
            </div>
          </button>
        </li>)}
      </ul>
    </section>}
  </main>;
}
