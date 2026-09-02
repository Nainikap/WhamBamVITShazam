/**
 * Static editor chrome for the prism preview. Mirrors the real Editor layout
 * so the project stage can be judged with every pane present.
 */
export function PreviewEditor() {
  return <main className="vg-editor">
    <aside aria-label="Source control" className="vg-editor-col">
      <section className="vg-editor-panel">
        <div className="vg-editor-heading">
          <h2>Changes</h2>
          <div className="vg-editor-actions">
            <button type="button">Stage all</button>
            <button type="button">Unstage all</button>
          </div>
        </div>
        <p className="vg-editor-empty">The latest saved Resolve timeline matches this commit.</p>
        <form className="vg-editor-commit" onSubmit={(event) => event.preventDefault()}>
          <input aria-label="Commit message" placeholder="Describe this cut" />
          <button type="submit">Commit</button>
        </form>
      </section>
      <section className="vg-editor-panel vg-editor-grow">
        <div className="vg-editor-heading">
          <h2>Commits</h2>
          <span className="vg-editor-count">1</span>
        </div>
        <button className="vg-editor-commit-row" type="button">
          <span className="vg-editor-dot" />
          <span>
            <strong>Import RAVI KISHAN GOAT — First 10 Seconds</strong>
            <small>editor · 2 hours ago</small>
            <code>9a54c88f</code>
          </span>
        </button>
      </section>
    </aside>

    <section className="vg-editor-center" aria-label="Preview">
      <div className="vg-editor-toolbar">
        <div>
          <h2>Import RAVI KISHAN GOAT — First 10 Seconds</h2>
          <p>9a54c88f · Aug 30, 2024, 1:13 AM</p>
        </div>
        <div className="vg-editor-actions">
          <button type="button">See diff</button>
          <button type="button">Replace local project</button>
        </div>
      </div>

      <div className="vg-editor-player">
        <span className="vg-editor-player-file">Ravi_Kishan_Original_L_DeG3spYN4.mp4</span>
        <span className="vg-editor-player-time">00:00:00:18</span>
      </div>

      <div className="vg-editor-sync">
        <span className="vg-editor-badge">Waiting for Resolve</span>
        <span>
          <strong>DaVinci Resolve · active timeline</strong>
          Open Resolve, select the timeline, and save the project
        </span>
        <button type="button">Stop sync</button>
      </div>

      <div className="vg-editor-timeline" aria-label="Timeline">
        <div className="vg-editor-ruler">00:00:00:18 / 00:00:10:00</div>
        <div className="vg-editor-track">
          <span>V1</span>
          <i className="vg-editor-clip">Source Video</i>
        </div>
        <div className="vg-editor-track">
          <span>V2</span>
          <i className="vg-editor-clip">RAVI KISHAN GOAT overlay</i>
        </div>
        <div className="vg-editor-track">
          <span>A1</span>
          <i className="vg-editor-clip vg-editor-audio">Source Audio</i>
        </div>
      </div>
    </section>

    <aside aria-label="Inspector" className="vg-editor-col">
      <section className="vg-editor-panel">
        <div className="vg-editor-heading"><h2>Branch</h2><span className="vg-editor-count">1</span></div>
        <p className="vg-editor-meta">main · 9a54c88f</p>
        <form className="vg-editor-commit" onSubmit={(event) => event.preventDefault()}>
          <input aria-label="Branch from selected commit" placeholder="Branch from 9a54c88f" />
          <button type="submit">Create</button>
        </form>
      </section>
      <section className="vg-editor-panel">
        <div className="vg-editor-heading"><h2>Merge</h2></div>
        <button className="vg-editor-select" type="button">Choose a branch…</button>
        <button type="button">Merge into main</button>
      </section>
      <section className="vg-editor-panel">
        <div className="vg-editor-heading"><h2>Timeline</h2></div>
        <dl className="vg-editor-facts">
          <div><dt>Duration</dt><dd>00:00:10:00</dd></div>
          <div><dt>Frame rate</dt><dd>60 fps</dd></div>
          <div><dt>Format</dt><dd>1920×1080</dd></div>
          <div><dt>Tracks</dt><dd>V1, V2, A1</dd></div>
          <div><dt>Media</dt><dd>All linked</dd></div>
        </dl>
      </section>
    </aside>
  </main>;
}
