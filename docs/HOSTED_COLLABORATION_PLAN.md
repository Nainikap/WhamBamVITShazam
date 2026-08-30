# Hosted collaboration plan

Status: product and architecture proposal only. This does not expand the V1 contract or authorize
implementation. The authoritative V1 source remains `VideoGit_Engineering_Plan.md`.

## Decision

Build a durable hosted remote, not a WebRTC replacement for the current LAN peer.

The hosted product should have three independent data planes:

1. native Git history and refs for canonical timeline snapshots;
2. object storage for originals, proxies, thumbnails, and waveforms;
3. PostgreSQL metadata for users, organizations, access, reviews, asset policy, and audit events.

WebRTC can later accelerate an active session or carry presence/screen-share traffic. It must not be
the source of truth. WebRTC still needs signaling, and most real deployments need TURN relay when a
direct connection cannot be established. It also requires both peers to be online and provides no
durable repository, permissions, discovery, or disaster recovery. The official WebRTC documentation
describes both the separate signaling requirement and the common need for TURN:
[peer connections](https://webrtc.org/getting-started/peer-connections) and
[TURN servers](https://webrtc.org/getting-started/turn-server).

## Why a website is needed

Yes, a hosted VideoGit product needs a website, but it should not try to become a browser NLE.

The desktop app remains responsible for NLE interchange, local media relinking, playback against
originals, semantic staging, and offline work. The website provides the parts that must be available
when no editor has the desktop app open:

- sign-in, device authorization, invitations, organizations, and billing;
- repository creation, discovery, public pages, and settings;
- commit history, branch comparison, semantic diffs, and generated proxy preview;
- change requests, frame/entity-anchored comments, approvals, and merge status;
- roles, branch rules, asset visibility/licensing, audit history, and abuse reporting.

A desktop-only cloud product could sync private teams, but it would make public repositories,
review links, invitations, account recovery, and administration needlessly difficult. The website is
therefore a control/review surface, not an editing surface.

## Proposed system

```text
Electron app ── HTTPS/OIDC ─┐
                            ├─ API/control service ── PostgreSQL
Web review app ─ HTTPS ─────┤           │
                            │           ├─ event stream / job queue ── workers
Electron Git remote ────────┴─ Git smart HTTP service ── bare repositories

Electron media transfer ── short-lived signed URLs ── object storage ── CDN
                                                     ├─ originals
                                                     ├─ review proxies/HLS
                                                     └─ thumbnails/waveforms

Optional later: WebSocket presence and WebRTC data/media channels with TURN fallback
```

### Git plane

- Keep complete canonical `timeline.json` snapshots in native Git commits exactly as today.
- Expose authenticated smart HTTP with Git protocol v2; it is designed for stateless HTTP and
  explicit ref discovery ([Git protocol v2](https://git-scm.com/docs/gitprotocol-v2)).
- Enforce ref validation, repository authorization, quotas, and expected-old ref compare-and-swap
  on every push. The branch ref moves last.
- Never let a generic host text-merge `timeline.json`. A SnipSnap merge service must run the existing
  conservative semantic merge, validate the result, create the two-parent commit, and update the ref
  with CAS.
- Evaluate Forgejo as the initial Git transport/account substrate rather than rebuilding clone,
  fetch, push, organizations, tokens, and branch protection. Its current documentation exposes those
  repository primitives ([Forgejo documentation](https://forgejo.org/docs/latest/)). Treat it as an
  internal control plane: disable/bypass its ordinary text merge for timeline changes and keep the
  VideoGit web experience and semantic merge service separate.

### Media plane

- Originals never enter Git. Use the existing stable media identity plus a tenant-scoped SHA-256
  object key and a repository asset manifest.
- Upload missing objects before publishing the Git ref. If the final ref CAS fails, retain the
  object temporarily and garbage-collect unreferenced uploads later; never publish a commit that
  promises unavailable hosted media.
- The API creates short-lived multipart upload sessions; the desktop transfers directly to object
  storage and completes with a full checksum. S3-style multipart upload permits independent retry of
  failed parts and server-side checksum validation
  ([multipart uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)).
- Use short-lived presigned download/upload URLs so clients never receive cloud storage credentials
  ([presigned uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html)).
- Deduplicate inside one organization, not globally across unrelated tenants, to avoid revealing
  whether another customer owns a particular confidential file.
- Generate browser-safe HLS/MP4 proxies, thumbnails, and waveforms asynchronously. Originals remain
  downloadable only when repository policy permits. Proxy/render workers are a future V2 service,
  not a change to the current Electron V1.

### Metadata and events

PostgreSQL stores repository metadata, memberships, review threads, approvals, asset policies,
upload sessions, quotas, and audit events. It does not store the canonical timeline snapshot.

Use application authorization on every request and row-level security as defense in depth. PostgreSQL
RLS becomes default-deny when enabled without a matching policy and can independently constrain
read/write rows ([PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)).

Use WebSocket or server-sent events for branch updates, review comments, upload progress, and
presence. These are notifications; clients always refetch durable state after reconnecting.

## Repository visibility and media policy

Public repositories are useful for tutorials, sample edits, reusable templates, open films, and
portfolio review. They are not a prerequisite for the first hosted private-team release.

Repository visibility and footage visibility must be separate controls:

| Repository policy | Timeline/history | Review proxy | Original footage |
|---|---|---|---|
| Private | members only | members allowed by role | editors/owners by policy |
| Public, metadata only | public | private or absent | private |
| Public with review media | public | public, explicitly licensed | private by default |
| Fully public assets | public | public | public only after explicit rights confirmation |

Making a repository public must not silently publish originals. Default public behavior should expose
canonical history, semantic diffs, comments chosen as public, and approved thumbnails; proxy/original
publication requires a separate owner action and recorded license/rights choice. This matters more for
video than source code because footage may contain client material, music rights, faces, locations,
or unreleased products.

Do not launch public uploads until there are quotas, rate limits, takedown/abuse handling, malware
scanning for downloaded attachments, and a retention/deletion policy.

## Small RBAC model for video teams

RBAC is needed for private repositories and for writes to public repositories. Public read access
does not imply public write access.

Do not copy every GitHub enterprise role initially. GitHub currently separates Read, Triage, Write,
Maintain, and Admin ([repository roles](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization));
VideoGit needs a reviewer role more than a code-oriented triage role.

Recommended launch roles:

| Role | Capabilities |
|---|---|
| Viewer | Read private history and approved review media; download originals only if asset policy allows |
| Reviewer | Viewer plus comment, approve, and request changes; cannot push or merge |
| Editor | Create/push branches, upload media, open change requests, and resolve conflicts on owned branches |
| Owner | Editor plus membership, visibility, asset policy, branch rules, retention, billing, export, and deletion |

Anonymous users are read-only on public material. Add a distinct Maintainer role later only when
teams need merge/branch administration without dangerous repository deletion or billing access.
Teams inherit one repository role; explicit user grants should be exceptional and auditable.

## Change requests instead of raw pull requests

A hosted review should be video-native while retaining Git ancestry:

- pin base and head commit IDs, never moving branch names, for every displayed comparison;
- show semantic hunks, frame ranges, clip/track identities, and a generated review proxy;
- anchor comments to stable entity UUID plus frame range, with commit ID as the stale-comment guard;
- invalidate approvals when the head changes materially;
- require all blocking discussions and conflicts to be resolved before merge;
- run the same deterministic conservative merge on the server and create a real two-parent commit;
- protect the default branch from force push/delete and optionally require review. GitHub's branch
  rules demonstrate why required reviews and restricted pushes are separate controls
  ([protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).

Do not attempt Google-Docs-style concurrent timeline mutation in the first hosted release. Branches,
semantic diffs, and explicit merges match the current product model and remain usable offline.

## Authentication and security baseline

- Web: OIDC/OAuth with passkeys or a managed identity provider; secure HTTP-only sessions.
- Desktop: browser-based device authorization; short-lived access token plus rotated refresh token in
  the OS credential vault, never plaintext app state.
- Service-to-service identities for Git, workers, and object storage; no shared cloud credentials.
- TLS everywhere, encryption at rest, tenant-scoped authorization, audit events, signed URL expiry,
  push/upload size limits, and secret rotation.
- Validate canonical JSON, OTIO, ref names, commit reachability, object checksums, and manifest paths
  at the hosted boundary. Treat repositories and media as untrusted input.
- Back up PostgreSQL and bare repositories; enable object versioning/retention appropriate to plan;
  regularly prove restore into a clean environment.

## Delivery phases

### Phase 0 — contract and threat model

- Specify remote repository IDs, media manifests, upload/finalize ordering, review objects, and API
  idempotency keys.
- Write compatibility fixtures proving Windows/Linux clients produce identical commits and hashes.
- Prototype Git smart HTTP plus expected-old ref rejection and a multipart media round trip.
- Decide managed identity/PostgreSQL/object storage providers and document data residency/deletion.

Exit: two clean clients can clone the same canonical history, verify media, and reject a stale push.

### Phase 1 — private hosted remote

- Accounts, private personal repositories, Viewer/Editor/Owner roles, desktop device login.
- Git clone/fetch/push, resumable original/proxy upload/download, quotas, and audit log.
- Minimal website for sign-in, repository creation, invitations, storage state, and settings.
- No public repositories, browser rendering, WebRTC, organizations, or server merge yet.

Exit: an editor can work offline, reconnect, push a branch and media, and another editor can clone it
without either machine being simultaneously online.

### Phase 2 — review website

- Organizations/teams and Reviewer role.
- Commit graph, semantic comparisons, proxy playback, anchored comments, approvals, notifications.
- Change requests and server-side semantic two-parent merge with branch CAS.
- Default-branch protection and required-review rules.

Exit: a reviewer with no desktop app can review a pinned cut and an authorized editor can complete a
validated merge without text-merging timeline JSON.

### Phase 3 — controlled public repositories

- Public repository pages and discovery.
- Independent timeline/proxy/original visibility, rights declaration, takedown path, abuse controls,
  CDN, bandwidth limits, and cost controls.
- Optional forking with media manifests that do not automatically copy or expose private originals.

Exit: anonymous users can inspect a public timeline safely while private assets and tenant data remain
inaccessible under direct API/object-store tests.

### Phase 4 — optional live acceleration

- WebSocket presence and edit-session awareness.
- WebRTC screen share or peer-assisted transfer when both editors are online, with authenticated
  signaling and TURN fallback.
- Hosted object storage remains the durable fallback and source for every repository clone.

Exit: disabling WebRTC changes latency/cost, not correctness, availability, or recoverability.

## Explicit non-goals for the first hosted release

- browser timeline editing;
- globally deduplicated customer originals;
- automatic publication of media when a repository becomes public;
- real-time multi-writer timeline CRDTs;
- arbitrary user-supplied render jobs or plugins;
- replacing canonical Git snapshots with PostgreSQL records;
- relying on an online peer, WebRTC channel, or TURN relay for repository durability.

## Recommendation

Ship Phase 1 as a private hosted remote with a small account/settings website. Build Phase 2 before
public repositories because review is the core video-specific value and forces the semantic merge,
proxy, and permissions model to become correct. Add public repositories only after footage visibility
is independently enforceable. Treat WebRTC as a later optimization, never as the architecture.
