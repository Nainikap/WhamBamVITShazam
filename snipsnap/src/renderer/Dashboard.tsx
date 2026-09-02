import { ArrowRight, FilePlus2, Film, FolderOpen, FolderSearch, Image, Network, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ProjectOverview } from '../application';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { durationLabel, frameRateLabel, relativeTime } from './format';
import { GlassSurface } from './prism/LiquidGlass';
import { useAppStore } from './store';

const stateLabel: Record<ProjectOverview['state'], string> = {
  clean: 'Committed',
  staged: 'Staged',
  uncommitted: 'Uncommitted',
  'resolve-pending': 'Editor update',
};

const stateVariant: Record<ProjectOverview['state'], 'default' | 'info' | 'retimed' | 'added'> = {
  clean: 'default',
  staged: 'info',
  uncommitted: 'retimed',
  'resolve-pending': 'added',
};

function JoinDialog({ open, busy, onOpenChange, onJoin }: {
  open: boolean;
  busy: boolean;
  onOpenChange(open: boolean): void;
  onJoin(inviteCode: string): void;
}) {
  const [inviteCode, setInviteCode] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (inviteCode.trim()) onJoin(inviteCode);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <form className="grid gap-5" onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>Join a shared project</DialogTitle>
          <DialogDescription>
            Paste the WebRTC pairing code from the project host. SnipSnap receives Git history and missing footage directly, then stores both locally.
          </DialogDescription>
        </DialogHeader>
        <label className="grid gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Pairing code</span>
          <textarea
            autoFocus
            aria-label="Pairing code"
            rows={5}
            spellCheck={false}
            placeholder="Paste pairing code"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            className="min-h-28 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !inviteCode.trim()}>
            <Network />{busy ? 'Joining…' : 'Join over WebRTC'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

/** One badge says where a project stands; nothing else needs to repeat it. */
function StatePill({ project }: { project: ProjectOverview }) {
  if (!project.openable) {
    return <Badge variant="retimed" className="state-pill state-blocked">Needs timeline export</Badge>;
  }
  if (!project.linked) return <Badge variant="edited" className="state-pill state-new">New from Resolve</Badge>;
  return <Badge variant={stateVariant[project.state]} className={`state-pill state-${project.state}`}>
    {stateLabel[project.state]}
  </Badge>;
}

/** A frame of the project's own footage, or an honest placeholder. */
function Poster({ project, className }: { project: ProjectOverview; className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const poster = project.poster;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !poster) return;
    const seek = () => { video.currentTime = poster.fps > 0 ? poster.sourceStart / poster.fps : 0; };
    video.addEventListener('loadedmetadata', seek, { once: true });
    return () => video.removeEventListener('loadedmetadata', seek);
  }, [poster?.mediaUrl, poster?.sourceStart]);

  return <span className={cn('vg-poster', className)}>
    {poster
      ? <video ref={videoRef} src={poster.mediaUrl} muted playsInline preload="metadata" />
      : <Image aria-hidden="true" />}
  </span>;
}

function Facts({ project }: { project: ProjectOverview }) {
  const facts = [
    project.kind === 'remote' ? 'Shared project' : null,
    project.kind === 'kdenlive' ? 'Kdenlive project' : null,
    project.linked ? `⑂ ${project.branch}` : null,
    ...(project.openable ? [project.resolve?.timelineName ?? project.knownTimelines[0]] : project.knownTimelines),
    project.durationFrames > 0 ? durationLabel(project.durationFrames, project.fps) : null,
    project.width > 0 ? `${project.width}×${project.height}` : null,
    project.fps > 0 ? frameRateLabel(project.fps) : null,
    project.linked ? `${project.trackCounts.video}V · ${project.trackCounts.audio}A` : null,
  ].filter((fact): fact is string => Boolean(fact));

  return <span className="vg-item-facts">
    {facts.map((fact) => <Badge key={fact} variant="outline">{fact}</Badge>)}
  </span>;
}

/**
 * The library, as a stack of glass panes floating on the prism strip. Every project
 * is the same shape, so the eye reads down the list rather than across two layouts.
 */
export function Dashboard() {
  const store = useAppStore();
  const [joinOpen, setJoinOpen] = useState(false);

  useEffect(() => {
    if (store.route.name === 'editor') setJoinOpen(false);
  }, [store.route.name]);

  const filter = store.filter.trim().toLowerCase();
  const matching = filter
    ? store.overviews.filter((project) => project.name.toLowerCase().includes(filter)
      || project.branch.toLowerCase().includes(filter))
    : store.overviews;

  const openOrExport = (project: ProjectOverview) => (project.openable
    ? store.openProject(project.id)
    : store.exportFromResolve());

  if (store.overviews.length === 0) {
    return <main className="vg-library-main vg-library-empty">
      <div className="vg-glass vg-empty">
        <GlassSurface />
        <div className="vg-glass-body">
          <h2>No video projects found yet</h2>
          <p>
            Connect a DaVinci Resolve project or a native <code>.kdenlive</code> project.
            Saving in either editor updates SnipSnap automatically.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="default" onClick={() => setJoinOpen(true)}><Network />Join shared project</Button>
            <Button variant="default" onClick={() => void store.importKdenlive()}><Film />Connect Kdenlive</Button>
            <Button variant="secondary" onClick={() => void store.addKdenliveFolder()}>
              <FolderSearch />Track Kdenlive folder
            </Button>
            <Button variant="default" onClick={() => void store.addResolveProjectFile()}>
              <FilePlus2 />Choose a .drp file
            </Button>
            <Button variant="secondary" onClick={() => void store.addResolveFolder()}>
              <FolderOpen />Track Resolve folder
            </Button>
            <Button variant="ghost" onClick={() => void store.exportFromResolve()}>Export from Resolve</Button>
          </div>
        </div>
      </div>
      <JoinDialog open={joinOpen} busy={store.busy} onOpenChange={setJoinOpen} onJoin={(code) => void store.joinProject(code)} />
    </main>;
  }

  return <main className="vg-library-main">
    <header className="vg-library-head">
      <div>
        <h1 className="vg-library-title">Video projects</h1>
        <p className="vg-library-sub">Most recently worked on first.</p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Filter projects"
          placeholder="Filter projects…"
          className="w-56"
          value={store.filter}
          onChange={(event) => store.setFilter(event.target.value)}
        />
        <Button variant="secondary" onClick={() => setJoinOpen(true)}><Network />Join</Button>
        <Button variant="secondary" onClick={() => void store.importKdenlive()}><Film />Kdenlive project</Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="secondary" size="icon" aria-label="Track Kdenlive folder" onClick={() => void store.addKdenliveFolder()}>
              <FolderSearch />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Discover and watch native Kdenlive saves</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="secondary" size="icon" aria-label="Add .drp" onClick={() => void store.addResolveProjectFile()}>
              <FilePlus2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add a .drp project file</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="secondary" size="icon" aria-label="Track Resolve folder" onClick={() => void store.addResolveFolder()}>
              <FolderOpen />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Discover Resolve .drp and OTIO exports</TooltipContent>
        </Tooltip>
        <Button variant="default" onClick={() => void store.refreshLibrary()}><RefreshCw />Refresh</Button>
      </div>
    </header>

    {matching.length === 0 && <p className="vg-library-sub">No project matches “{store.filter}”.</p>}

    <div className="vg-list">
      {matching.map((project, index) => <div className="vg-glass vg-item" key={project.id}>
        <GlassSurface />
        <button
          aria-label={project.openable ? `Open ${project.name}` : `Export ${project.name} from Resolve`}
          className="vg-glass-body vg-item-body"
          onClick={() => void openOrExport(project)}
          type="button"
        >
          <span className="vg-item-index">{String(index + 1).padStart(2, '0')}</span>
          <Poster project={project} />
          <span className="vg-item-copy">
            <span className="vg-item-line">
              <span className="vg-item-name">{project.name}</span>
              <StatePill project={project} />
            </span>
            <Facts project={project} />
            {project.linked && project.headMessage && <span className="vg-item-commit">
              <span className="truncate">{project.headMessage}</span>
            </span>}
            <span className="vg-item-path" title={project.sourcePath || project.path}>
              {project.sourcePath || project.path}
            </span>
            <span className="vg-item-meta">
              <span>{relativeTime(project.updatedAt)}</span>
              {project.linked && <span>{project.commitCount} commit{project.commitCount === 1 ? '' : 's'}</span>}
              {project.linked && project.branchCount > 1 && <span>{project.branchCount} branches</span>}
              {project.changeCount > 0 && <span className="text-retimed">{project.changeCount} pending</span>}
            </span>
          </span>
          <span className="vg-item-go">
            {project.openable ? 'Open' : 'Export'}<ArrowRight aria-hidden="true" />
          </span>
        </button>
      </div>)}
    </div>

    <JoinDialog open={joinOpen} busy={store.busy} onOpenChange={setJoinOpen} onJoin={(code) => void store.joinProject(code)} />
  </main>;
}
