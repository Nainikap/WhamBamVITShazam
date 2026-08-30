# Kdenlive integration

SnipSnap's first Kdenlive integration uses Kdenlive's supported OpenTimelineIO import/export
boundary. Canonical `timeline.json` remains the only timeline representation stored in Git;
`.otio` is an editor handoff and `.kdenlive`/MLT is not parsed or versioned by this slice.

## Workflow

1. Export the active Kdenlive timeline with **File > OpenTimelineIO Export**.
2. Import that `.otio` from the SnipSnap dashboard, or choose **Track Kdenlive folder** to discover
   every `.otio` file up to four folders below the selected root. Folder roots persist; **Refresh**
   discovers later exports, and every valid imported OTIO remains watched across app restarts.
3. Export later Kdenlive edits to the same file. SnipSnap watches it and presents the semantic
   difference as a pending editor update.
4. Apply, stage, and commit selected semantic changes normally.
5. Select a commit and choose **Prepare for Kdenlive**. SnipSnap resolves the revision to an immutable
   commit ID, writes `<commit>.otio` and `<commit>.report.json` atomically below the project's local
   `kdenlive-handoffs` directory, copies/reveals the OTIO path, and launches Kdenlive without a shell.
6. In Kdenlive choose **File > OpenTimelineIO Import**, then paste or select the prepared path.

Kdenlive may remove SnipSnap UUID metadata when it exports again. The source-sync layer reconciles
sequences, tracks, assets, clips, gaps, transitions, and captions against the current canonical
workspace so ordinary rewrites remain modifications of stable entities.

Kdenlive can also export an audio media reference whose auxiliary `available_range` has rate `0`
while its editorial `source_range` has the valid sequence rate. SnipSnap accepts that OpenTimelineIO
shape, interprets the media availability at the clip source rate, and records a best-effort fidelity
warning. Editorial source ranges and the canonical timeline remain strictly positive-rate.

## Fidelity contract

| Timeline feature | Contract |
|---|---|
| Video/audio tracks, clips, gaps, source in/out, media references | Portable |
| Timeline and clip markers | Portable data; per-instance versus shared marker semantics are best-effort |
| Transitions | Best-effort; Kdenlive does not document full transition fidelity through OTIO |
| Audio gain, enabled state, colour labels | Best-effort metadata; verify after import |
| Captions/subtitles | Not portable because OTIO has no native cross-editor caption schema |
| Arbitrary effects, generators, SnipSnap preview looks | Not portable; recreate or bake |
| Resolve Color/Fusion/plugin state | Not portable or editable in Kdenlive |
| Foreign editor metadata | Preserved where valid JSON permits, but without shared editing semantics |

Every handoff returns the same report over typed IPC and persists it as JSON beside the OTIO file.
No unsupported feature is silently advertised as portable.

## Platform behavior

- Linux searches `/usr/bin/kdenlive` and `/usr/local/bin/kdenlive`.
- Windows searches standard Program Files and local-app Kdenlive locations, then `PATH`.
- macOS searches the standard Kdenlive application bundle, then `PATH`.
- `SNIPSNAP_KDENLIVE_BINARY` overrides discovery on every platform.

Kdenlive's CLI only accepts a native Kdenlive document as its positional `file`; it has no CLI switch
for OpenTimelineIO Import. Passing `.otio` there adds the JSON as a bin clip instead of importing its
timeline. SnipSnap therefore launches Kdenlive with no file argument and directs the editor through
the supported File menu action. If Kdenlive is unavailable, SnipSnap reports the launch error and
leaves the already-written immutable handoff and fidelity report intact.

## Deliberate limits

Kdenlive does not continuously export OTIO when its native project is saved. The editor must export
to the connected `.otio` path when a revision should enter SnipSnap. Native `.kdenlive`/MLT parsing,
background editor automation, baked render artifacts, and proprietary effect translation require
separate designs and are not implied by this integration.
