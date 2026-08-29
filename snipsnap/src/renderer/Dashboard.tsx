import { ArrowRight, FilePlus2, FolderOpen, Image, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ProjectOverview } from '../application';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { durationLabel, frameRateLabel, relativeTime, shortId } from './format';
import { useAppStore } from './store';

const stateLabel: Record<ProjectOverview['state'], string> = {
  clean: 'Committed',
  staged: 'Staged',
  uncommitted: 'Uncommitted',
  'resolve-pending': 'Resolve update',
};

const stateVariant: Record<ProjectOverview['state'], 'default' | 'info' | 'retimed' | 'added'> = {
  clean: 'default',
  staged: 'info',
  uncommitted: 'retimed',
  'resolve-pending': 'added',
};

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

  return <div className={cn('relative grid aspect-video place-items-center overflow-hidden bg-black/40', className)}>
    {poster
      ? <video ref={videoRef} src={poster.mediaUrl} muted playsInline preload="metadata" className="h-full w-full object-cover" />
      : <Image className="h-7 w-7 text-muted-foreground/40" aria-hidden="true" />}
  </div>;
}

function Facts({ project }: { project: ProjectOverview }) {
  const facts = [
    project.linked ? `⑂ ${project.branch}` : null,
    ...(project.openable ? [project.resolve.timelineName] : project.knownTimelines),
    project.durationFrames > 0 ? durationLabel(project.durationFrames, project.fps) : null,
    project.width > 0 ? `${project.width}×${project.height}` : null,
    project.fps > 0 ? frameRateLabel(project.fps) : null,
    project.linked ? `${project.trackCounts.video}V · ${project.trackCounts.audio}A` : null,
  ].filter((fact): fact is string => Boolean(fact));

  return <div className="flex flex-wrap items-center gap-1.5">
    {facts.map((fact) => <Badge key={fact} variant="outline">{fact}</Badge>)}
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

  const openOrExport = (project: ProjectOverview) => (project.openable
    ? store.openProject(project.id)
    : store.exportFromResolve());

  if (store.overviews.length === 0) {
    return <main className="grid flex-1 place-content-center justify-items-center gap-4 px-8 text-center">
      <h2 className="text-2xl font-semibold tracking-tight">No Resolve projects found yet</h2>
      <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
        SnipSnap reads DaVinci Resolve&rsquo;s project library, and any <code>.drp</code> with an
        <code> .otio</code> beside it. Point it at a project file, or export a timeline from Resolve
        with File &rsaquo; Export &rsaquo; Timeline.
      </p>
      <div className="flex gap-2">
        <Button variant="default" onClick={() => void store.addResolveProjectFile()}>
          <FilePlus2 />Choose a .drp file
        </Button>
        <Button variant="secondary" onClick={() => void store.addResolveFolder()}><FolderOpen />Choose a folder</Button>
        <Button variant="ghost" onClick={() => void store.exportFromResolve()}>Export from Resolve</Button>
      </div>
    </main>;
  }

  return <main className="flex-1 overflow-auto px-8 py-6">
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Video projects</h1>
        <p className="mt-1 text-xs text-muted-foreground">Most recently worked on first.</p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Filter projects"
          placeholder="Filter projects…"
          className="w-56"
          value={store.filter}
          onChange={(event) => store.setFilter(event.target.value)}
        />
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
            <Button variant="secondary" size="icon" aria-label="Add folder" onClick={() => void store.addResolveFolder()}>
              <FolderOpen />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Watch a folder of exports</TooltipContent>
        </Tooltip>
        <Button variant="default" onClick={() => void store.refreshLibrary()}><RefreshCw />Refresh</Button>
      </div>
    </header>

    {!latest && <p className="text-sm text-muted-foreground">No project matches “{store.filter}”.</p>}

    {latest && <Card className="mb-8 overflow-hidden p-0 transition-colors hover:border-primary/40">
      <button
        aria-label={latest.openable ? `Open ${latest.name}` : `Export ${latest.name} from Resolve`}
        onClick={() => void openOrExport(latest)}
        className="grid w-full grid-cols-[minmax(0,20rem)_minmax(0,1fr)] text-left"
      >
        <Poster project={latest} />
        <div className="flex min-w-0 flex-col gap-3 p-6">
          <div className="flex items-center gap-3">
            <h2 className="truncate text-xl font-semibold tracking-tight">{latest.name}</h2>
            <StatePill project={latest} />
          </div>
          <Facts project={latest} />
          {latest.linked && <p className="flex items-baseline gap-2 text-sm text-muted-foreground">
            <code className="font-mono text-[11px] text-foreground/70">{shortId(latest.headCommit)}</code>
            <span className="truncate">{latest.headMessage}</span>
          </p>}
          <p className="truncate font-mono text-[10px] text-muted-foreground" title={latest.resolve.drpPath || latest.path}>
            {latest.resolve.drpPath || latest.path}
          </p>
          <div className="mt-auto flex items-center gap-4 text-xs text-muted-foreground">
            <span>{relativeTime(latest.updatedAt)}</span>
            {latest.linked && <span>{latest.commitCount} commit{latest.commitCount === 1 ? '' : 's'}</span>}
            {latest.linked && latest.branchCount > 1 && <span>{latest.branchCount} branches</span>}
            {latest.changeCount > 0 && <span className="text-retimed">{latest.changeCount} pending</span>}
            <span className="ml-auto flex items-center gap-1 font-medium text-primary">
              {latest.openable ? 'Open project' : 'Export its timeline'}<ArrowRight className="h-3.5 w-3.5" />
            </span>
          </div>
        </div>
      </button>
    </Card>}

    {earlier.length > 0 && <section aria-label="Earlier projects">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">Worked on earlier</h2>
        <Badge variant="outline">{earlier.length}</Badge>
      </div>
      <Table className="table-fixed">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[7rem]" />
            <TableHead className="w-[38%]">Project</TableHead>
            <TableHead>Timeline</TableHead>
            <TableHead className="w-[11rem] text-right">Last worked on</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {earlier.map((project) => <TableRow
            key={project.id}
            role="button"
            tabIndex={0}
            aria-label={project.openable ? `Open ${project.name}` : `Export ${project.name} from Resolve`}
            onClick={() => void openOrExport(project)}
            onKeyDown={(event) => { if (event.key === 'Enter') void openOrExport(project); }}
            className="cursor-pointer"
          >
            <TableCell className="p-0"><Poster project={project} className="w-28 rounded-l" /></TableCell>
            <TableCell className="overflow-hidden">
              <div className="flex items-center gap-2">
                <strong className="truncate text-sm">{project.name}</strong>
                <StatePill project={project} />
              </div>
              <span
                className="mt-1 block truncate font-mono text-[10px] text-muted-foreground"
                title={project.resolve.drpPath || project.path}
              >{project.resolve.drpPath || project.path}</span>
            </TableCell>
            <TableCell className="overflow-hidden"><Facts project={project} /></TableCell>
            <TableCell className="text-right align-middle">
              <span className="block text-xs text-muted-foreground">{relativeTime(project.updatedAt)}</span>
              {project.linked && <span className="block font-mono text-[10px] text-muted-foreground">
                {shortId(project.headCommit)} · {project.commitCount} commit{project.commitCount === 1 ? '' : 's'}
              </span>}
            </TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </section>}
  </main>;
}
