import { Clapperboard, FolderGit2, Home, X } from 'lucide-react';
import { useEffect } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Dashboard } from './Dashboard';
import { Editor } from './Editor';
import { MergeDialog } from './MergeDialog';
import { useAppStore } from './store';

function RailButton({ label, active, disabled, onClick, children }: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick?(): void;
  children: React.ReactNode;
}) {
  return <Tooltip>
    <TooltipTrigger asChild>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn('text-muted-foreground', active && 'bg-primary/15 text-primary')}
      >{children}</Button>
    </TooltipTrigger>
    <TooltipContent side="right">{label}</TooltipContent>
  </Tooltip>;
}

export function App() {
  const store = useAppStore();

  useEffect(() => {
    const stopListening = store.listenForSourceChanges();
    void store.initialize();
    return stopListening;
  }, []);

  useEffect(() => {
    if (!store.notice) return undefined;
    const timer = window.setTimeout(() => store.clearNotice(), 6000);
    return () => window.clearTimeout(timer);
  }, [store.notice]);

  const editing = store.route.name === 'editor';
  const status = store.status;
  // A database project has no project file, so its folder is the location.
  const projectPath = status?.resolve?.drpPath || status?.resolve?.folder || status?.path;

  return <TooltipProvider delayDuration={300}>
    <div className="flex h-screen overflow-hidden bg-background">
      <nav aria-label="Primary" className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border py-3">
        <RailButton label="Dashboard" active={!editing} onClick={() => void store.goToDashboard()}>
          <Home />
        </RailButton>
        <RailButton label="Editor" active={editing} disabled={!editing}>
          <Clapperboard />
        </RailButton>
      </nav>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <span className="grid h-6 w-6 place-items-center rounded bg-primary text-[13px] font-black text-primary-foreground">S</span>
          <span className="text-sm font-semibold tracking-tight">SnipSnap</span>

          {editing && status && <>
            <Separator orientation="vertical" className="h-5" />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 text-xs font-medium">{status.project.name}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="path-text min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                    {projectPath}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="font-mono">
                  {projectPath}
                  {status.resolve?.otioPath ? <><br />{status.resolve.otioPath}</> : null}
                </TooltipContent>
              </Tooltip>
            </div>
            <Button
              size="sm"
              onClick={() => void store.exportRevision(store.selectedRevision?.commit.id ?? status.headCommit)}
            >Export OTIO</Button>
          </>}
        </header>

        {store.busy && <div className="absolute left-0 top-12 z-40 h-0.5 w-1/3 animate-pulse bg-primary" aria-label="Working" />}

        {(store.error || store.notice) && <Alert
          role={store.error ? 'alert' : 'status'}
          variant={store.error ? 'destructive' : 'default'}
          className={cn(
            'alert mx-4 mt-3 flex w-auto items-start justify-between gap-3 py-2',
            store.error ? 'error' : 'notice border-added/40 bg-added-soft text-added',
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

        {editing ? <Editor /> : <Dashboard />}
      </div>

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
