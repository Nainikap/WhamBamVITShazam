import { z } from 'zod';
import { cloneProject, validateProject, type Project } from '../domain';

const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('trimClip'), clipId: z.string().uuid(), start: z.number().int().nonnegative(), duration: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('setClipGain'), clipId: z.string().uuid(), gainDb: z.number().min(-60).max(12) }).strict(),
  z.object({ type: z.literal('setClipPreset'), clipId: z.string().uuid(), preset: z.enum(['none', 'warm', 'cool', 'mono']) }).strict(),
  z.object({ type: z.literal('updateCaption'), captionId: z.string().uuid(), text: z.string().optional(), start: z.number().int().nonnegative().optional(), duration: z.number().int().positive().optional() }).strict(),
  z.object({ type: z.literal('reorderTrack'), trackId: z.string().uuid(), itemIds: z.array(z.string().uuid()) }).strict(),
  z.object({ type: z.literal('renameProject'), name: z.string().min(1) }).strict(),
]);

export type EditCommand = z.infer<typeof CommandSchema>;

export function reduceCommand(projectInput: Project, commandInput: EditCommand): Project {
  const project = cloneProject(projectInput);
  const command = CommandSchema.parse(commandInput);

  switch (command.type) {
    case 'trimClip': {
      const clip = project.clips.find(({ id }) => id === command.clipId);
      if (!clip) throw new Error(`Unknown clip ${command.clipId}`);
      clip.sourceRange = { start: command.start, duration: command.duration };
      break;
    }
    case 'setClipGain': {
      const clip = project.clips.find(({ id }) => id === command.clipId);
      if (!clip) throw new Error(`Unknown clip ${command.clipId}`);
      clip.gainDb = command.gainDb;
      break;
    }
    case 'setClipPreset': {
      const clip = project.clips.find(({ id }) => id === command.clipId);
      if (!clip) throw new Error(`Unknown clip ${command.clipId}`);
      clip.preset = command.preset;
      break;
    }
    case 'updateCaption': {
      const caption = project.captions.find(({ id }) => id === command.captionId);
      if (!caption) throw new Error(`Unknown caption ${command.captionId}`);
      if (command.text !== undefined) caption.text = command.text;
      caption.range = {
        start: command.start ?? caption.range.start,
        duration: command.duration ?? caption.range.duration,
      };
      break;
    }
    case 'reorderTrack': {
      const track = project.tracks.find(({ id }) => id === command.trackId);
      if (!track) throw new Error(`Unknown track ${command.trackId}`);
      if (command.itemIds.length !== track.itemIds.length
        || command.itemIds.some((id) => !track.itemIds.includes(id))) {
        throw new Error('A reorder must contain every existing track item exactly once');
      }
      track.itemIds = [...command.itemIds];
      break;
    }
    case 'renameProject':
      project.name = command.name;
      break;
  }
  return validateProject(project);
}
