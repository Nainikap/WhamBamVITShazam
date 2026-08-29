import type { MergeSession } from '../application';
import { describeConflict, type ConflictBrief, type ConflictChoice } from '../merge';

const scopeLabel: Record<ConflictBrief['scope'], string> = {
  video: 'VIDEO',
  audio: 'AUDIO',
  caption: 'CAPTION',
  timeline: 'TIMELINE',
  project: 'PROJECT',
};

function Side({ side, tone }: { side: ConflictBrief['original']; tone: string }) {
  return <div className={`conflict-side conflict-${tone}`}>
    <span className="eyebrow">{side.label.toUpperCase()}</span>
    <strong>{side.summary}</strong>
  </div>;
}

export interface MergeDialogProps {
  session: MergeSession;
  onResolve(conflictId: string, choice: ConflictChoice): void;
  onComplete(): void;
  onAbort(): void;
  busy: boolean;
}

export function MergeDialog({ session, onResolve, onComplete, onAbort, busy }: MergeDialogProps) {
  const briefs = session.result.conflicts.map((conflict) => describeConflict(conflict, session.result.alternatives));
  const remaining = briefs.length;

  return <div className="modal-backdrop">
    <section className="modal merge-modal" role="dialog" aria-label="Resolve merge conflicts">
      <header className="merge-head">
        <div>
          <span className="eyebrow">MERGE PAUSED</span>
          <h2>{session.sourceBranch} → {session.targetBranch}</h2>
          <p>
            {remaining === 0
              ? 'Every conflict is resolved. Completing the merge writes one two-parent commit.'
              : `${remaining} conflict${remaining === 1 ? '' : 's'} left. ${session.targetBranch} is untouched until you complete the merge.`}
          </p>
        </div>
        <code>{session.baseCommit.slice(0, 8)} · {session.targetCommit.slice(0, 8)} · {session.sourceCommit.slice(0, 8)}</code>
      </header>

      <div className="conflict-list">
        {remaining === 0 && <p className="resolved-note">All conflicting timestamps and footage decisions have been made.</p>}
        {briefs.map((brief) => <article className={`conflict-card conflict-${brief.category}`} key={brief.id}>
          <div className="conflict-title">
            <span className={`scope scope-${brief.scope}`}>{scopeLabel[brief.scope]}</span>
            <strong>{brief.title}</strong>
            <span className="category">{brief.category}</span>
          </div>
          <p className="conflict-explain">{brief.explanation}</p>

          <div className="conflict-sides">
            <Side side={brief.original} tone="base" />
            <Side side={brief.current} tone="ours" />
            <Side side={brief.incoming} tone="theirs" />
          </div>

          {brief.validationErrors.length > 0 && <ul className="conflict-errors">
            {brief.validationErrors.map((error) => <li key={error}>{error}</li>)}
          </ul>}

          <div className="conflict-actions">
            <button disabled={busy} onClick={() => onResolve(brief.id, 'ours')}>Accept current</button>
            <button disabled={busy} onClick={() => onResolve(brief.id, 'theirs')}>Accept incoming</button>
            <button
              className={brief.combination.available ? 'primary' : ''}
              disabled={busy || !brief.combination.available}
              title={brief.combination.summary}
              onClick={() => onResolve(brief.id, 'both')}
            >Accept both</button>
            <button className="ghost" disabled={busy} onClick={() => onResolve(brief.id, 'base')}>Revert to original</button>
          </div>
          <small className="combination-note">{brief.combination.summary}</small>
        </article>)}
      </div>

      <div className="modal-actions">
        <button onClick={onAbort} disabled={busy}>Abort merge</button>
        <button className="primary" disabled={busy || remaining > 0} onClick={onComplete}>Complete merge</button>
      </div>
    </section>
  </div>;
}
