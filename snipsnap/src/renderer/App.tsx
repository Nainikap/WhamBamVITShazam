import { ArrowLeft, FolderGit2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Dashboard } from './Dashboard';
import { Editor } from './Editor';
import { MergeDialog } from './MergeDialog';
import { Intro } from './prism/Intro';
import { GlassFilters, GlassSurface } from './prism/LiquidGlass';
import { PrismStage, type Stage } from './prism/PrismStage';
import './prism/prism.css';
import { useAppStore } from './store';

/** How long the wordmark takes to clear the frame once the camera starts moving. */
const INTRO_EXIT = 720;

export function App() {
  const store = useAppStore();
  const [entered, setEntered] = useState(false);
  const [introMounted, setIntroMounted] = useState(true);
  const libraryRef = useRef<HTMLDivElement>(null);

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
  const stage: Stage = !entered ? 'intro' : editing ? 'project' : 'library';

  // The library stays mounted so the camera move is the only transition, but a
  // screen the camera has left must not answer the keyboard.
  useEffect(() => {
    const node = libraryRef.current;
    if (!node) return;
    if (stage === 'library') node.removeAttribute('inert');
    else node.setAttribute('inert', '');
  }, [stage]);

  const enter = () => {
    setEntered(true);
    window.setTimeout(() => setIntroMounted(false), INTRO_EXIT);
  };

  const status = store.status;

  return <TooltipProvider delayDuration={300}>
    <GlassFilters />
    <div className="vg-shell" data-stage={stage}>
      <PrismStage stage={stage} />

      {introMounted && <Intro leaving={entered} onContinue={enter} />}

      <div className="vg-library" ref={libraryRef}><Dashboard /></div>

      <div className="vg-project">
        <GlassSurface />
        <div className="vg-glass-body vg-project-body">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Dashboard"
                  onClick={() => void store.goToDashboard()}
                ><ArrowLeft /></Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Back to projects</TooltipContent>
            </Tooltip>
            <span className="vg-mark">VideoGit</span>

            {status && <>
              <Separator orientation="vertical" className="h-5" />
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-xs font-medium">{status.project.name}</span>
              </div>
              <Button
                size="sm"
                className="shrink-0"
                onClick={() => void store.exportRevision(store.selectedRevision?.commit.id ?? status.headCommit)}
              >Export OTIO</Button>
            </>}
          </header>

          {editing && <Editor />}
        </div>
      </div>

      {store.busy && <div className="vg-busy" aria-label="Working" />}

      {(store.error || store.notice) && <Alert
        role={store.error ? 'alert' : 'status'}
        variant={store.error ? 'destructive' : 'default'}
        className={cn(
          'alert vg-toast flex items-start justify-between gap-3 py-2',
          store.error ? 'error' : 'notice',
        )}
      >
        <AlertDescription className="text-xs">{store.error ?? store.notice}</AlertDescription>
        <Button
          variant="ghost"
          size="icon"
          aria-label={store.error ? 'Dismiss error' : 'Dismiss notice'}
          onClick={store.error ? store.clearError : store.clearNotice}
          className="h-5 w-5 shrink-0"
        ><X className="h-3.5 w-3.5" /></Button>
      </Alert>}

      {store.mergeSession && <MergeDialog
        session={store.mergeSession}
        busy={store.busy}
        onResolve={(conflictId, choice) => void store.resolve(conflictId, choice)}
        onComplete={() => void store.completeMerge()}
        onAbort={() => void store.abortMerge()}
      />}
    </div>
  </TooltipProvider>;
}
