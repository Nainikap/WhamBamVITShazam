# SnipSnap documentation

The [main README](../README.md) is the starting point for what SnipSnap does, how to install it, how
to connect Resolve or Kdenlive, and how to run the test suite.

## Current product guides

- [Kdenlive integration](KDENLIVE_INTEGRATION.md) explains native `.kdenlive` save tracking,
  automatic sibling OTIO generation, immutable commit handoff, platform discovery, and fidelity
  limits.
- [Resolve integration scripts](../resolve/README.md) explains managed save sync, menu-script
  installation, export locations, and the manual fallback.
- [Hosted collaboration plan](HOSTED_COLLABORATION_PLAN.md) reasons through a future durable remote
  service. It is a plan, not behavior present in the desktop app.
- [WebRTC collaboration](WEBRTC_COLLABORATION.md) documents live multi-editor peer transfer,
  signaling deployment, TURN configuration, and local storage guarantees.
- [Studio Graphite design system](SnipSnap_Studio_Graphite_Design_System.md) records the interface
  language and visual constraints.
- [Contributor handoff](HANDOFF.md) records implementation context for continuing engineering work.

## Engineering documents

The [Engineering Plan](VideoGit_Engineering_Plan.md) remains the authoritative implementation
contract when code and planning documents disagree. Architecture and cross-editor brainstorm files
in this directory provide background or future research; they do not silently expand the behavior
claimed by the main README.

## How the application is structured

```text
React renderer → typed context-isolated preload IPC → Electron main → application services
```

The renderer is sandboxed. Node, Electron, filesystem, cryptography, and child-process access stay
in the main process. SnipSnap stores complete canonical `timeline.json` snapshots in native Git and
computes semantic diff, staging, and merge behavior in TypeScript. Git never text-merges the
timeline.

Resolve and Kdenlive remain the editors. SnipSnap detects their saved timeline state, versions the
portable editing decisions, and previews immutable commits from media linked on the current
computer. Native editor files, local media paths, and footage remain outside Git.

The desktop app also supports live host/join/pull/push between multiple running SnipSnap instances
over authenticated WebRTC data channels. Signaling is deployed separately, and TURN can relay WebRTC
traffic when configured. Project history and media remain local; the desktop opens no LAN listener,
and the signaling service does not provide identities, permissions, durable repositories, review
requests, or cloud media storage.
