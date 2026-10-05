# p2pscreenshare

Browser-only screen sharing over WebRTC, where viewers relay the stream to each other through
bandwidth-aware **striped relay trees**. WebTorrent trackers are used only to introduce viewers
to the host; no media server is involved.

- **Encode once, forward bytes.** The host encodes with WebCodecs (VP9 with temporal SVC `L1T3`
  when available). Relays forward encoded fragments over RTCDataChannels without decoding them,
  so every viewer gets identical frames and relaying costs almost no CPU.
- **Striped multi-tree + erasure coding (SplitStream-style).** Each frame is split into `k` data
  and `m` parity pieces, and stripe *i* carries piece *i*. A viewer needs any `k` of the `k+m`
  stripes to decode. Each peer relays in at most one "home" stripe and is a leaf in all the
  others. With `k=1, m=0` this is a plain single relay tree.
- **Host-run control plane.** Viewers measure their upload (a paced probe) and report stats. The
  host's planner (`src/topology/planner.ts`) ranks peers, balances relay capacity across stripes,
  and places stronger peers nearer the root. It also handles all signaling for tree links, and
  switches parents make-before-break.
- **Cut-through forwarding and low latency.** Relays forward each fragment as soon as it arrives.
  A jitter buffer that tracks reference dependencies plays out at the 95th percentile of frame
  arrival times. Measured glass-to-glass latency in local e2e tests is about **50 ms**, and the
  simulator predicts about **350 ms p50 at depth 4** over realistic links. Both are well under the
  5 s budget.
- **Graceful degradation.** Uplink queues drop temporal enhancement layers (T2, then T1) first, so
  an overloaded relay lowers the frame rate instead of stalling. A relay cache of the frames since
  the last keyframe (the GOP) lets new or re-attached children start decoding immediately.

## Quick start

```sh
npm install
npm run dev                 # http://localhost:5173
```

Open the app, click **Start sharing**, and send the viewer link. Public WebTorrent trackers are
used by default.

For local development, run your own tracker:

```sh
npm run tracker             # ws://localhost:8000
# then open  http://localhost:5173/?tracker=ws://localhost:8000
```

Useful URL parameters (put them in the page query or the hash query):

| Param | Where | Meaning |
|---|---|---|
| `tracker=ws://a,wss://b` | both | Tracker URLs to use instead of the public defaults |
| `ice=none` / `ice=stun:…,turn:…` | both | ICE servers (`none` for LAN or tests) |
| `k`, `m`, `bitrate`, `up` | host | Data and parity stripes, video kbps, host upload budget in kbps |
| `source=test&res=640x360` | host | Animated test pattern (prints the host clock) instead of screen capture |
| `up=800` | viewer | Debug upload cap in kbps (token-bucket shaper), to emulate a weak peer |

## How it works

```
             tracker (signaling only)
            ╱                      ╲
   host ── control conns (star) ── viewers        stats, topology commands, signaling relay
     │
     ├─ stripe 0 tree ─▶ A ─▶ {B, C, D …}           A relays stripe 0 only
     ├─ stripe 1 tree ─▶ E ─▶ {A, C, F …}           A is a leaf here
     └─ stripe 2 tree ─▶ G ─▶ {A, B, E …}           any k of k+m stripes decode
```

1. **Bootstrap** (`src/net/tracker.ts`, `src/net/bootstrap.ts`). The host keeps a pool of
   pre-gathered offers and announces them to the stream's info-hash. The tracker hands each offer
   to a distinct joining viewer, which answers through the tracker. Once connected, a viewer leaves
   the swarm. Trackers can't address offers to a specific peer, so this keeps the swarm limited to
   the host plus viewers that are still joining, and every offer reaches someone who needs one.
2. **Measurement.** Each viewer streams a probe to the host for about 1.5 s, paced by its debug
   cap if one is set. It then reports stats every 2 s: uplink throughput and drop rate, per-stripe
   freshness and RTT, latency, buffer, and fps. Relays that drop packets have their estimated
   capacity lowered.
3. **Planning.** `plan()` is pure and deterministic. A peer gets
   `floor(capacity·headroom / stripeKbps)` child slots. Home stripes are balanced by total capacity.
   Each tree is built top-down, keeping valid existing parents first (hysteresis) and then placing
   the rest. New peers stay leaves for 4 s. Pairs whose links failed are avoided.
4. **Applying changes.** The host tells the new parent `add-child` and the child `set-parent`. Once
   the child reports `stripe-ok` from the new parent, the old parent gets `remove-child`.
5. **Failure handling.** A child whose stripe goes silent for 2 s asks to be re-attached and is
   moved to another parent. With `m ≥ 1` it keeps decoding in the meantime. Peers that stop sending
   stats for 10 s are dropped.

### Security

The viewer link's stream id is the lobby's **join code**: 128 random bits, carried in the URL
fragment (`#/watch/<code>`), so it is never sent to a server. Everything is derived from it with
HKDF (`src/net/lobby.ts`):

- **Tracker info_hash.** Trackers and anyone scanning them see only a one-way derivative of the code.
- **SDP sealing key.** Offers and answers sent through trackers are AES-GCM sealed, bound to their
  offer id and direction, with the sender's peer id inside. A peer without the code can't read an
  offer (addresses, fingerprints), and its answers are dropped before the host touches them. The
  SDPs carry the DTLS fingerprints, so a tracker can't sit in the middle of a control connection.

Tree links are signaled over those authenticated control connections, so every hop is a DTLS
channel to a peer holding the code; media is not encrypted again at the application layer. Anyone
with the link can watch (the code is reusable and can't be revoked), and admitted viewers are
trusted to relay faithfully.

### Wire format

Each data-channel message is one fragment: a 36-byte header (version, flags with key/audio/replay
bits and the temporal layer, epoch, frame seq, GOP id, reference seq, capture time, k, m, piece,
stripe, frame length, fragment index and count) followed by up to about 16 KB of payload. See
`src/proto/framing.ts`. Audio (Opus) is tiny, so it is sent unsplit on every stripe.

## Simulation

`npm run sim -- --peers 200 --seconds 300` runs the planner under churn (mean lifetime 240 s) with
a mix of residential uplinks:

```
k  m | p50 ms | p95 ms | max depth | stall % | degraded % | parent changes/min
-----+--------+--------+-----------+---------+------------+-------------------
1  0 |    321 |    406 |         4 |   0.654 |       0.00 |                139
2  0 |    344 |    391 |         3 |   1.266 |       0.00 |                293
4  0 |    359 |    431 |         4 |   2.491 |       0.00 |                590
4  1 |    347 |    402 |         4 |   0.123 |       0.00 |                779
4  2 |    330 |    386 |         4 |   0.019 |       0.02 |               1284
8  2 |    364 |    427 |         4 |   0.057 |       0.96 |               2142
```

Without parity, striping increases stalls: there are more parents whose departure can interrupt
you. Adding parity reverses this, and `k=4, m=1` cuts stall time by about 5× compared with a single
tree, at a cost of 25% extra bandwidth.

## Tests

```sh
npm test                    # unit: framing, FEC, reassembly, jitter buffer, planner invariants
npm run check               # svelte-check + tsc
npm run e2e                 # Playwright: local tracker + dev server + several browser contexts
```

The e2e suite covers:
- star streaming
- a striped tree with mixed upload caps: weak peers stay leaves, the host feeds only the stripe
  roots, and killing the busiest relay causes no frame-rate drop
- a single tree: orphans recover within a few seconds, and a late joiner renders in under about 2 s

**NixOS / ARM64 VMs.** Playwright's bundled browser needs FHS libraries, so point it at a system
Chromium. Some ARM64 VMs (Apple Virtualization) advertise SME but trap SME instructions. That
crashes Chromium (SIGILL) when it creates a VideoFrame. Build the shim in `tools/nosme` and pass it
to the browser:

```sh
gcc -shared -fPIC -O2 -o tools/nosme/nosme.so tools/nosme/nosme.c -ldl
CHROMIUM_PATH=$(nix build --no-link --print-out-paths nixpkgs#chromium)/bin/chromium \
CHROMIUM_LD_PRELOAD=$PWD/tools/nosme/nosme.so npm run e2e
```

## Limitations / next steps

- **Trust.** Viewers trust the first peer that offers on the stream's info-hash, and relayed data
  is not authenticated. Signing GOP manifests with an ed25519 host key is the planned fix.
- **Host connection limit.** The host keeps a direct control connection to every viewer, which
  limits audiences to roughly 200 peers. Routing control messages through the trees would lift
  this.
- **Small audiences.** With fewer capable relays than stripes, the host carries the uncovered
  stripes itself (reported as "overcommitted").
- **Encoding and playback.** There's a single encoding, so viewers with weak downlinks are helped
  only by relays dropping temporal layers; simulcast would be the next step. Capture relies on
  `MediaStreamTrackProcessor` (Chromium); other browsers fall back to sampling a `<video>` element.
  Audio playback scheduling is basic.
- **Tracker reliability.** Public trackers are flaky. Self-host one with `npm run tracker` (it's
  `bittorrent-tracker`) behind TLS for real use.
