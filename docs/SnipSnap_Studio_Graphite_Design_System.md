# SnipSnap Studio Graphite design system

Studio Graphite is SnipSnap's desktop visual language. It was developed from a
Stitch design exploration and adapted to the existing Electron application. The
generated screens are reference material only: the production React components,
information architecture, actions, and backend contracts remain the source of
truth.

## Product guardrails

- SnipSnap previews and versions Resolve timelines; it does not edit video.
- A visual refresh must not add, remove, rename, or reinterpret product features.
- The semantic diff cards remain human-readable timeline changes, not text or code
  diffs.
- Commit history, immutable preview, sync state, timeline lanes, branches, merge,
  staging, compare, and commit graph keep their current hierarchy.
- Technical metadata such as hashes, paths, timecodes, frame ranges, and field names
  uses a monospaced face.

## Foundation

The interface uses an edge-to-edge desktop shell and tonal depth instead of large
shadows or decorative gradients.

| Role | Value |
| --- | --- |
| Canvas | `#0a0a0a` |
| Application | `#0e0e0e` |
| Surface | `#131313` |
| Raised surface | `#1a1a1a` |
| Overlay/control | `#242424` |
| Divider | `#252525` |
| Strong divider | `#333333` |
| Primary text | `#f4f4f5` |
| Secondary text | `#a1a1aa` |
| Primary action | `#3b82f6` |

Semantic colors are reserved for versioning meaning:

- green `#4ade80`: additions and healthy sync;
- amber `#fbbf24`: modifications, trims, and pending work;
- red `#f87171`: removals and invalid states;
- purple `#a78bfa`: reorders, branches, and merge-related distinctions.

## Typography and geometry

- UI text: Geist when available, followed by native system sans-serif faces.
- Technical text: JetBrains Mono when available, followed by Cascadia Code and
  native monospace faces.
- Spacing follows a 4 px base rhythm, primarily using 4, 8, 12, 16, and 24 px.
- Controls and content groups use an 8 px default radius; compact tags use 4 px.
- Borders are one pixel. Shadows are reserved for modal overlays.
- Focused controls receive a visible blue ring; hover states move one tonal level.

## Component translation

- The rail and top bar use the lowest raised surface and thin separators.
- Project cards use flat graphite surfaces with poster imagery carrying the visual
  emphasis.
- Selected commits and branches use a low-saturation blue surface, not a glow.
- Preview, semantic changes, timeline, and comparison panels share the same border
  and radius language.
- Timeline clips keep content-specific blue, green, purple, and amber treatments so
  lane structure remains legible.
- Scrollbars are narrow and quiet until hovered, supporting high-density desktop
  workflows.
