# Kdenlive integration

SnipSnap connects directly to a saved `.kdenlive` project for the cut-only timeline subset and uses
Kdenlive's supported OpenTimelineIO boundary for handoff. Canonical `timeline.json` remains the only
timeline representation stored in Git; native project files, OTIO, and footage stay outside Git.

## Workflow

1. Choose **Connect Kdenlive** and select the native `.kdenlive` project, or choose **Track Kdenlive
   folder** to discover native projects up to four folders below the selected root. Existing
   OTIO-only sources remain supported as a fallback.
2. Edit in Kdenlive and press **Ctrl+S**. SnipSnap watches the native file's parent directory so an
   atomic save/replacement is detected on Linux, Windows, and macOS.
3. Each distinct valid save is parsed, reconciled to stable canonical IDs, applied immediately to
   WORKING, and exported atomically to the same-name sibling `.otio`. HEAD and INDEX do not move.
4. Review the resulting unstaged semantic changes, then stage and commit selected changes normally.
5. Select a commit and choose **Prepare for Kdenlive**. SnipSnap resolves the revision to an immutable
   commit ID, writes `<commit>.otio` and `<commit>.report.json` atomically below the project's local
   `kdenlive-handoffs` directory, copies/reveals the OTIO path, and launches Kdenlive without a shell.
6. In Kdenlive choose **File > OpenTimelineIO Import**, then paste or select the prepared path.

Kdenlive native files do not contain SnipSnap UUID metadata. The source-sync layer reconciles
sequences, tracks, assets, clips, gaps, transitions, and captions against the current canonical
workspace so ordinary rewrites remain modifications of stable entities.

The legacy OTIO fallback can also contain an audio media reference whose auxiliary `available_range` has rate `0`
while its editorial `source_range` has the valid sequence rate. SnipSnap accepts that OpenTimelineIO
shape, interprets the media availability at the clip source rate, and records a best-effort fidelity
warning. Editorial source ranges and the canonical timeline remain strictly positive-rate.

## Fidelity contract

| Timeline feature | Contract |
|---|---|
| Native active sequence, video/audio tracks, clips, gaps, source in/out, media references | Parsed on save and portable |
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

The native adapter implements the same bounded editorial subset promised by the OTIO integration.
Kdenlive/MLT effects, compositions, subtitles, nested sequences, speed effects, and generators are
not claimed as portable. They remain intact in the native file—which SnipSnap never writes—but are
not represented as editable cross-NLE timeline state. The adapter rejects malformed/DTD-bearing XML,
bounds input size/depth/node count, and publishes the sibling OTIO with temp-file-plus-rename.
