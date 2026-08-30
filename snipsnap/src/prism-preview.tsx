import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Intro } from './renderer/prism/Intro';
import { GlassFilters, GlassSurface } from './renderer/prism/LiquidGlass';
import { PreviewEditor } from './renderer/prism/PreviewEditor';
import { PrismStage, type Stage } from './renderer/prism/PrismStage';
import './renderer/prism/prism.css';
import './index.css';

function Preview() {
  const start = new URLSearchParams(window.location.search).get('stage');
  const [stage, setStage] = useState<Stage>(
    start === 'library' || start === 'project' || start === 'intro' ? start : 'intro',
  );

  useEffect(() => {
    (window as Window & { setPrismStage?: (next: Stage) => void }).setPrismStage = setStage;
    return () => { delete (window as Window & { setPrismStage?: (next: Stage) => void }).setPrismStage; };
  }, []);

  return <>
    <GlassFilters />
    <div className="vg-shell" data-stage={stage}>
      <PrismStage stage={stage} />
      {stage === 'intro' && <Intro leaving={false} onContinue={() => setStage('library')} />}
      <div className="vg-library">
        <main className="vg-library-main">
          <header className="vg-library-head">
            <div>
              <h1 className="vg-library-title">Video projects</h1>
              <p className="vg-library-sub">Most recently worked on first.</p>
            </div>
          </header>
          <div className="vg-list">
            {['Cold Open', 'Trailer v4', 'Interview cut'].map((name, index) => (
              <div className="vg-glass vg-item" key={name}>
                <GlassSurface />
                <button className="vg-glass-body vg-item-body" onClick={() => setStage('project')} type="button">
                  <span className="vg-item-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="vg-poster" />
                  <span className="vg-item-copy">
                    <span className="vg-item-line"><span className="vg-item-name">{name}</span></span>
                    <span className="vg-item-path">/Users/editor/Resolve/{name}.drp</span>
                    <span className="vg-item-meta"><span>2 hours ago</span><span>14 commits</span></span>
                  </span>
                  <span className="vg-item-go">Open</span>
                </button>
              </div>
            ))}
          </div>
        </main>
      </div>
      <div className="vg-project">
        <GlassSurface />
        <div className="vg-glass-body vg-project-body">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
            <button onClick={() => setStage('library')} type="button">Back</button>
            <span className="vg-mark">VideoGit</span>
            <span className="path-text min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
              /Users/editor/Resolve/Cold Open.drp
            </span>
            <button type="button">Export OTIO</button>
          </header>
          <PreviewEditor />
        </div>
      </div>
    </div>
    <div style={{ position: 'fixed', right: 12, bottom: 12, zIndex: 99, display: 'flex', gap: 8 }}>
      {(['intro', 'library', 'project'] as Stage[]).map((name) => (
        <button
          data-current={stage === name ? 'true' : 'false'}
          data-stage-jump={name}
          key={name}
          onClick={() => setStage(name)}
          style={{
            padding: '4px 10px',
            color: '#fff',
            background: stage === name ? '#333' : 'transparent',
            border: '1px solid #666',
          }}
          type="button"
        >{name}</button>
      ))}
    </div>
  </>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Preview root is missing');
createRoot(root).render(<Preview />);
