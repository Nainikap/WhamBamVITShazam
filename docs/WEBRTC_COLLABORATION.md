# WebRTC project collaboration

SnipSnap transfers committed project history and missing media directly between running editor
computers over encrypted WebRTC data channels. Files are still stored in each editor's local Git
repository and local content-addressed media store. The signaling service only introduces peers by
relaying room membership and WebRTC session descriptions; it never receives a Git bundle or media
chunk.

```text
host Electron main ─┐                         ┌─ editor A Electron main
                    ├─ WSS signaling only ────┤
                    │                         └─ editor B Electron main
                    │
                    ├════ encrypted WebRTC data channel ═══ editor A
                    └════ encrypted WebRTC data channel ═══ editor B

Git snapshots + media stay local                  Git snapshots + media stay local
```

One pairing code can be used by multiple editors while the host is online. Each editor gets an
independent peer connection and can choose **Pull latest** to fetch the host's newest committed
branches, tags, and missing media. Safe branches fast-forward, new branches are added, and divergent
history is retained under a peer-qualified branch. Existing dirty-workspace and stale-push guards
still apply.

WebRTC encrypts data channels with DTLS. SnipSnap additionally encrypts and authenticates every RPC
body with a random 256-bit project secret from the pairing code. Large Git bundles and media chunks
are split into bounded 16 KiB data-channel frames with backpressure, then validated by the existing
Git and SHA-256 media checks before local publication.

## Signaling deployment

Deploy the standalone signaling image behind a TLS reverse proxy before using **Share via WebRTC**:

```bash
docker build -f snipsnap/webrtc-signaling.Dockerfile -t snipsnap-signaling snipsnap
docker run --rm -p 8080:8080 snipsnap-signaling
```

Expose port 8080 as `wss://signal.example.com/signal`, then start every desktop app with:

```bash
SNIPSNAP_SIGNALING_URL=wss://signal.example.com/signal npm start
```

The container exposes `GET /healthz` for deployment health checks. Production signaling must use
WSS; TLS can terminate at the platform load balancer or reverse proxy. The desktop app deliberately
does not open a LAN signaling listener. If `SNIPSNAP_SIGNALING_URL` is absent, sharing fails with an
actionable configuration error rather than silently falling back to LAN transport.

Signaling alone does not guarantee that every NAT/firewall pair can establish a direct connection.
Configure a STUN/TURN service on the signaling deployment when internet reliability is required:

```bash
SNIPSNAP_ICE_SERVERS_JSON='[
  {"urls":"stun:stun.example.com:3478"},
  {"urls":["turn:turn.example.com:3478?transport=udp","turns:turn.example.com:5349?transport=tcp"],"username":"editor","credential":"replace-me"}
]'
```

The signaling server validates that configuration and gives it to authenticated room members. TURN
relays WebRTC packets only when a direct ICE path fails; it is not project storage. Rotate TURN
credentials and never commit them. The WebRTC project host must remain online for joins, pulls, and
pushes. This peer workflow is not a durable cloud backup, account system, or permission service.

See the official WebRTC documentation for the separate
[signaling/ICE flow](https://webrtc.org/getting-started/peer-connections) and
[TURN deployment role](https://webrtc.org/getting-started/turn-server).

## Replacing the local project

When the working project differs from the commit selected in history, **Replace the local project
with the selected commit** is available. After confirmation, SnipSnap resolves that immutable commit,
discards staged and working timeline changes, and copies the selected canonical snapshot into the
local working project. The current branch and Git history remain intact, and media files are not
deleted or downloaded again. This action intentionally does not modify a native `.drp` or
`.kdenlive` file; editor-native project mutation remains outside SnipSnap's safe interchange boundary.
