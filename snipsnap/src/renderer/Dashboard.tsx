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

function StatePill({ project }: { project: ProjectOverview }) {
  if (!project.openable) return <span className="state-pill state-blocked">Needs timeline export</span>;
  return project.linked
    ? <span className={`state-pill state-${project.state}`}>{stateLabel[project.state]}</span>
    : <span className="state-pill state-new">New from Resolve</span>;
}

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
    {project.linked && <span className="branch-chip">⑂ {project.branch}</span>}
    {project.kind === 'database' && <span className="db-chip">Resolve database</span>}
    {project.openable
      ? <span className="timeline-chip">▤ {project.resolve.timelineName}</span>
      : project.knownTimelines.map((name) => <span className="timeline-chip" key={name}>▤ {name}</span>)}
    {project.durationFrames > 0 && <span>{durationLabel(project.durationFrames, project.fps)}</span>}
    {project.width > 0 && <span>{project.width}×{project.height}</span>}
    {project.fps > 0 && <span>{frameRateLabel(project.fps)}</span>}
    {project.linked && <span>{project.trackCounts.video}V · {project.trackCounts.audio}A</span>}
    {project.resolve.timelineCount > 1 && <span>{project.resolve.timelineCount} timelines</span>}
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
      <h2>No Resolve projects found yet</h2>
      <p>
        SnipSnap reads DaVinci Resolve&rsquo;s own project library, plus any <code>.drp</code> project
        file with an <code>.otio</code> timeline beside it. Nothing turned up here, so pick a
        <code>.drp</code> file or a folder that holds one. To create the timeline export, run
        <code>SnipSnapSync.py</code> from Resolve&rsquo;s Workspace &rsaquo; Scripts menu, or use
        File &rsaquo; Export &rsaquo; Timeline and save it next to the project.
      </p>
      <div className="empty-actions">
        <button className="primary" onClick={() => void store.addResolveProjectFile()}>Choose a .drp file</button>
        <button onClick={() => void store.addResolveFolder()}>Choose a folder</button>
        <button onClick={() => void store.exportFromResolve()}>Export from Resolve</button>
        <button onClick={() => void store.refreshLibrary()}>Look again</button>
      </div>
    </main>;
  }

  return <main className="dashboard">
    <header className="dashboard-head">
      <div>
        <h1>Video projects</h1>
        <p>Timelines DaVinci Resolve has exported, most recently worked on first.</p>
      </div>
      <div className="dashboard-actions">
        <input
          aria-label="Filter projects"
          className="filter"
          placeholder="Filter projects…"
          value={store.filter}
          onChange={(event) => store.setFilter(event.target.value)}
        />
        <button onClick={() => void store.addResolveProjectFile()}>Add .drp</button>
        <button onClick={() => void store.addResolveFolder()}>Add folder</button>
        <button onClick={() => void store.exportFromResolve()}>Export from Resolve</button>
        <button className="primary" onClick={() => void store.refreshLibrary()}>Refresh</button>
      </div>
    </header>

    {!latest && <p className="muted">No project matches “{store.filter}”.</p>}

    {latest && <section className="latest" aria-label="Latest project">
      <span className="eyebrow">CONTINUE WHERE YOU LEFT OFF</span>
      <button
        className="latest-card"
        aria-label={latest.openable ? `Open ${latest.name}` : `Export ${latest.name} from Resolve`}
        onClick={() => void (latest.openable ? store.openProject(latest.id) : store.exportFromResolve())}
      >
        <Poster project={latest} />
        <div className="latest-body">
          <div className="latest-title">
            <h2>{latest.name}</h2>
            <StatePill project={latest} />
          </div>
          <Meta project={latest} />
          <p className="latest-commit">
            {latest.linked
              ? <><code>{shortId(latest.headCommit)}</code> {latest.headMessage}</>
              : latest.openable
                ? <>Open it to import the timeline and start versioning.</>
                : <>Resolve has this project{latest.knownTimelines.length
                  ? ` with ${latest.knownTimelines.length} timeline${latest.knownTimelines.length === 1 ? '' : 's'}`
                  : ''}, but none has been exported as OTIO yet. Export it from Resolve to start versioning.</>}
          </p>
          <p className="latest-path" title={latest.resolve.drpPath || latest.path}>{latest.resolve.drpPath || latest.path}</p>
          {latest.resolve.otioPath && <p className="latest-path" title={latest.resolve.otioPath}>{latest.resolve.otioPath}</p>}
          <div className="latest-foot">
            <span>{relativeTime(latest.updatedAt)}</span>
            {latest.linked && <span>{latest.commitCount} commit{latest.commitCount === 1 ? '' : 's'}</span>}
            {latest.linked && <span>{latest.branchCount} branch{latest.branchCount === 1 ? '' : 'es'}</span>}
            {latest.changeCount > 0 && <span className="change-count">{latest.changeCount} pending change{latest.changeCount === 1 ? '' : 's'}</span>}
            <span className="open-hint">{latest.openable ? 'Open project →' : 'Export its timeline →'}</span>
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
            aria-label={project.openable ? `Open ${project.name}` : `Export ${project.name} from Resolve`}
            onClick={() => void (project.openable ? store.openProject(project.id) : store.exportFromResolve())}
          >
            <Poster project={project} />
            <div className="project-row-body">
              <div className="project-row-title">
                <strong>{project.name}</strong>
                <StatePill project={project} />
              </div>
              <Meta project={project} />
              <small className="project-row-path" title={project.resolve.drpPath || project.path}>{project.resolve.drpPath || project.path}</small>
            </div>
            <div className="project-row-side">
              <span>{relativeTime(project.updatedAt)}</span>
              {project.linked && <code>{shortId(project.headCommit)}</code>}
              <small>{project.linked
                ? `${project.commitCount} commit${project.commitCount === 1 ? '' : 's'}`
                : 'not versioned yet'}</small>
            </div>
          </button>
        </li>)}
      </ul>
    </section>}
  </main>;
}
