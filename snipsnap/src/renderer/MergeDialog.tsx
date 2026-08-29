import type { MergeSession } from '../application';
import { describeConflict, type ConflictBrief, type ConflictChoice } from '../merge';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { ScrollArea } from '../components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { cn } from '../lib/utils';

const scopeVariant: Record<ConflictBrief['scope'], 'primary' | 'added' | 'edited' | 'retimed'> = {
  video: 'primary',
  audio: 'added',
  caption: 'edited',
  timeline: 'retimed',
  project: 'retimed',
};

function Side({ side, tone }: { side: ConflictBrief['original']; tone: 'base' | 'ours' | 'theirs' }) {
  return <div className={cn('flex flex-col gap-1 rounded-md border bg-background/60 p-2.5', {
    'border-border': tone === 'base',
    'border-primary/40': tone === 'ours',
    'border-added/40': tone === 'theirs',
  })}>
    <span className={cn('font-mono text-[9px] uppercase tracking-widest', {
      'text-muted-foreground': tone === 'base',
      'text-primary': tone === 'ours',
      'text-added': tone === 'theirs',
    })}>{side.label}</span>
    <strong className="break-words font-mono text-[11px] font-semibold leading-snug">{side.summary}</strong>
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

  return <Dialog open>
    <DialogContent aria-label="Resolve merge conflicts" onEscapeKeyDown={(event) => event.preventDefault()}>
      <DialogHeader>
        <DialogTitle>{session.sourceBranch} → {session.targetBranch}</DialogTitle>
        <DialogDescription>
          {remaining === 0
            ? 'Every conflict is resolved. Completing the merge writes one two-parent commit.'
            : `${remaining} conflict${remaining === 1 ? '' : 's'} left. ${session.targetBranch} is untouched until you complete the merge.`}
        </DialogDescription>
      </DialogHeader>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-6">
          {remaining === 0 && <p className="rounded-md border border-dashed border-added/50 p-6 text-center text-xs text-added">
            All conflicting timestamps and footage decisions have been made.
          </p>}
          {briefs.map((brief) => <article key={brief.id} className="rounded-lg border border-border bg-secondary/40 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={scopeVariant[brief.scope]}>{brief.scope.toUpperCase()}</Badge>
              <strong className="text-[13px]">{brief.title}</strong>
              <span className="ml-auto font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                {brief.category}
              </span>
            </div>
            <p className="my-2.5 text-xs leading-relaxed text-muted-foreground">{brief.explanation}</p>

            <div className="grid grid-cols-3 gap-2">
              <Side side={brief.original} tone="base" />
              <Side side={brief.current} tone="ours" />
              <Side side={brief.incoming} tone="theirs" />
            </div>

            {brief.validationErrors.length > 0 && <ul className="mt-2.5 list-disc pl-4 text-[11px] text-destructive">
              {brief.validationErrors.map((error) => <li key={error}>{error}</li>)}
            </ul>}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => onResolve(brief.id, 'ours')}>Accept current</Button>
              <Button size="sm" disabled={busy} onClick={() => onResolve(brief.id, 'theirs')}>Accept incoming</Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      size="sm"
                      variant={brief.combination.available ? 'default' : 'secondary'}
                      disabled={busy || !brief.combination.available}
                      onClick={() => onResolve(brief.id, 'both')}
                    >Accept both</Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{brief.combination.summary}</TooltipContent>
              </Tooltip>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onResolve(brief.id, 'base')}>
                Revert to original
              </Button>
            </div>
          </article>)}
        </div>
      </ScrollArea>

      <DialogFooter>
        <Button onClick={onAbort} disabled={busy}>Abort merge</Button>
        <Button variant="default" disabled={busy || remaining > 0} onClick={onComplete}>Complete merge</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
