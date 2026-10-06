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

Open the app, enter your name and click **Create lobby**. Copy the lobby link and send it to
others, then click **Share screen**. Your name and sharing choices are remembered in
`localStorage`, and so is each lobby's owner seed, so reloading a lobby you created keeps you its
owner. Public WebTorrent trackers are used by default.

For local development, run your own tracker:

```sh
npm run tracker             # ws://localhost:8000
# then open  http://localhost:5173/?tracker=ws://localhost:8000
```

Useful URL parameters (put them in the page query or the hash query):

| Param | Where | Meaning |
|---|---|---|
| `tracker=ws://a,wss://b` | any | Tracker URLs to use instead of the public defaults |
| `ice=none` / `ice=stun:…,turn:…` | any | ICE servers (`none` for LAN or tests) |
| `name=…` | any | Display name for this page only |
| `share=1` | owner | Start sharing right away, applying the overrides below (used by the e2e tests) |
| `k`, `m`, `bitrate`, `up` | owner | With `share=1`: data and parity stripes, video kbps, upload budget in kbps |
| `source=test&res=640x360&audio=1` | owner | With `share=1`: animated test pattern (prints the clock) and a test tone |
| `up=800` | viewer | Debug upload cap in kbps (token-bucket shaper), to emulate a weak peer |

`#/host?stream=<seed>` (the old owner link) still works: it stores the seed and redirects to the
lobby page.

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
5. **Failure handling.** See [Failure handling and recovery](#failure-handling-and-recovery).

### Security

The host page's `stream` param is a private **seed**. From it the host derives (HKDF,
`src/net/lobby.ts`) a 128-bit lobby secret and an Ed25519 signing key. The viewer link carries the
**join code** `#/watch/<secret>.<host public key>`. Both URLs keep these in the fragment, so they are
never sent to a server. Share the viewer link, never the host page's URL. From the join code,
everyone derives:

- **Tracker info_hash.** Trackers and anyone scanning them see only a one-way derivative of the code.
- **SDP sealing key.** Offers and answers sent through trackers are AES-GCM sealed, bound to their
  offer id and direction, with the sender's peer id inside. A peer without the code can't read an
  offer (addresses, fingerprints), and its answers are dropped before the host touches them. The
  SDPs carry the DTLS fingerprints, so a tracker can't sit in the middle of a control connection.

Tree links are signaled over those authenticated control connections, so every hop is a DTLS
channel to a peer holding the code; media is not encrypted again at the application layer. Anyone
with the link can watch (the code is reusable and can't be revoked).

**Tamper-proofing.** The stream is signed with the host key pinned in the join code, so viewers
(who all hold the code) can't impersonate the host or alter what they relay:

- The host signs its offers; viewers only connect to the pinned host, so the control plane (codec
  config, topology commands) is authentic.
- The host signs every media fragment (`src/proto/signing.ts`). Relays verify each fragment before
  forwarding or playing it, and fail closed. Forged fragments are dropped without marking their id
  as seen, so they can't shadow the genuine fragment. Signed fragments older than the 5 s de-dup
  window are dropped as replays.
- Cost: ~26 µs to sign and ~90 µs to verify a fragment (Node, Ed25519), about 0.1 ms per hop, and
  ~15 kbps (video) plus ~26 kbps (audio) of signatures per stripe.

A malicious relay can still drop or delay what it forwards. Parity stripes (`m ≥ 1`) and
re-attachment cover that.

### Wire format

Each data-channel message is one fragment: a 36-byte header (version, flags with key/audio/replay
bits and the temporal layer, epoch, frame seq, GOP id, reference seq, capture time, k, m, piece,
stripe, frame length, fragment index and count) followed by up to about 16 KB of payload and the host's
64-byte Ed25519 signature (`WIRE_VERSION` 2). See `src/proto/framing.ts`. Audio (Opus) is tiny, so it is sent unsplit on every stripe.

## Failure handling and recovery

When a relay disappears, every viewer below it in that stripe's tree stops receiving that stripe.

| Step | Mechanism | Time |
|---|---|---|
| Detect | A child whose stripe has been silent for 2 s (checked every 250 ms) sends `reattach`. The host re-encodes the last frame while the screen is idle, so a live stripe is never silent that long. | ~2 s |
| Batch | The host collects reattach requests for 400 ms and handles them shallowest-first (see below). | 0.4 s |
| Confirm | The host pings the reported parent over its control channel. No pong within 1.2 s means it's gone, and its slots are freed immediately. | ≤1.2 s |
| Replan | `plan()` runs at once. The dead parent is excluded for that child, and relays that are themselves starved on that stripe are never chosen as a new parent. | ms |
| Resume | The new parent replays its cached GOP, so the child decodes right away instead of waiting for the next keyframe. | ~1 RTT + link setup |

Measured in the e2e tests on one machine:
- **With parity (`m ≥ 1`):** none of this is visible. The viewer keeps decoding from the other `k` stripes (minimum 28–30 fps during failover).
- **Without parity:** the subtree resumes after about **3.5–4 s**. That includes orphans two levels below the failed relay.
- **Pruning:** a departed child is removed from its parent's forwarding set after about **2 s**.

Mechanisms that keep one failure from spreading:
- **No collateral blame.** When a relay dies, its descendants all go silent together and all complain. Handling complaints shallowest-first, and marking each complainer's subtree as "disrupted upstream" for 6 s, means only the topmost complaint counts against a parent. Healthy relays below it keep their children and their rank.
- **No forwarding into the void.** When a peer leaves, the host tells each of its parents `remove-child`. Otherwise they'd keep pushing stripes into a link that looks open until WebRTC's ICE timeout (tens of seconds).
- **Liveness.** The host pings any peer it hasn't heard from for 1 s and drops it after 1.5 s of silence. Pongs are answered from a message handler, so background-tab timer throttling doesn't cause false positives.
- **Planned moves are glitch-free.** The old parent keeps feeding until the child reports `stripe-ok` from the new one (make-before-break).

Not handled yet:
- A relay that is alive but consistently *late*: children's jitter buffers grow, but nobody moves them.
- More than `m` relays failing within one detection window: viewers fed by all of them stall until reattach.
- The host itself failing.

## Simulation

`npm run sim -- --peers 200 --seconds 300` runs the planner under churn with a mix of residential
uplinks: 25% at 0.5 Mbps, 35% at 2 Mbps, 25% at 8 Mbps and 15% at 30 Mbps. Viewers stay a mean of
240 s, and the stream is 2.5 Mbps. When a peer leaves, its subtree loses that stripe for `--repair`
ms (default 3500, matching the e2e measurement above). A viewer stalls while more than `m` of its
stripes are missing.

```
k  m | p50 ms | p95 ms | max depth | stall % | stalls/hr | degraded % | parent changes/min
-----+--------+--------+-----------+---------+-----------+------------+-------------------
1  0 |    321 |    406 |         4 |   2.293 |     23.84 |       0.00 |                139
2  0 |    344 |    391 |         3 |   4.334 |     44.57 |       0.00 |                293
4  0 |    359 |    431 |         4 |   8.552 |     85.92 |       0.00 |                590
4  1 |    347 |    402 |         4 |   0.794 |     12.10 |       0.00 |                779
4  2 |    330 |    386 |         4 |   0.071 |      0.91 |       0.02 |               1284
8  2 |    364 |    427 |         4 |   0.263 |      4.13 |       0.96 |               2142
```

"Degraded" means some viewer's k-th best stripe passes through a parent whose children need more
than its true upload. Other options: `--lifetime`, `--repair`, `--fanout`, `--only 4:1,8:2`, and
`--sweep parity`.

## Tuning

### How much does parity buy?

`npm run sim -- --sweep parity --seconds 600` gives stall time as a % of viewing time, with stall
events per viewer-hour in parentheses:

```
k  m | overhead |         life 60s |        life 240s |        life 900s | degraded % (240s)
-----+----------+------------------+------------------+------------------+------------------
1  0 |       0% |   10.129 (102.4) |     3.014 (31.3) |      0.904 (9.3) |              0.00
2  0 |       0% |   16.663 (164.7) |     5.940 (58.9) |     1.453 (14.8) |              0.00
2  1 |      50% |     3.501 (63.3) |      0.226 (5.0) |      0.016 (0.6) |              0.00
2  2 |     100% |     0.633 (15.9) |      0.011 (0.5) |      0.000 (0.0) |              0.05
4  0 |       0% |   34.638 (298.5) |   10.569 (104.6) |     2.572 (26.0) |              0.00
4  1 |      25% |    8.001 (144.1) |      0.997 (19.1) |      0.083 (1.9) |              0.00
4  2 |      50% |     2.138 (54.5) |      0.067 (1.7) |      0.000 (0.0) |              0.22
4  3 |      75% |     0.548 (12.0) |      0.001 (0.1) |      0.000 (0.0) |             11.22
8  0 |       0% |   58.245 (391.3) |   19.983 (186.7) |     4.743 (48.1) |              0.85
8  2 |      25% |    7.226 (171.8) |      0.268 (7.7) |      0.004 (0.1) |              1.51
8  4 |      50% |     0.687 (19.5) |      0.006 (0.1) |      0.000 (0.0) |             61.74
```

Takeaways:

- **Striping without parity makes things worse.** A viewer depends on `k` parents instead of one,
  and losing any of them stalls it. At 240 s lifetimes, stall time is 3.0% for k=1, 5.9% for k=2,
  10.6% for k=4 and 20% for k=8.
- **The first parity stripe is the big win.** It turns a single failure from a stall into nothing.
  k=4/m=1 (25% overhead) stalls about 3× less than a single tree. k=2/m=1 stalls about 13× less.
- **Each further parity stripe cuts stalls by roughly 10–15×** at moderate churn. That's because a
  stall now needs `m+1` overlapping failures within one repair window. At 240 s lifetimes, k=4
  goes 0.997% → 0.067% → 0.001% as m goes 1 → 3.
- **For the same overhead, more stripes are more resilient.** At 50% overhead, stall time is
  0.226% for 2+1, 0.067% for 4+2 and 0.006% for 8+4. Bigger `k` tolerates more simultaneous
  losses. The costs are more connections per viewer (`k+m` parents), more planner and link churn
  (parent changes per minute rise roughly with `k+m`), and more relays needed before every stripe
  has one.
- **Churn sets the baseline; repair time scales it.** With 60 s lifetimes, even 4+2 stalls 2% of
  the time. Halving repair time (`--repair 1750`) cuts stall time 2× with m=0 (stalls get shorter)
  and about 3.6× with m≥1 (overlapping failures must land in a shorter window). For 4+1 that's
  0.997% → 0.277%. Useful, but an extra parity stripe is worth about 15×.
- **Parity isn't free.** Every viewer downloads `(k+m)/k` × the bitrate, and relays upload the same
  overhead. When the audience's total upload is tight, more parity means more overloaded relays.
  That shows up as "degraded": dropped enhancement frames, lower fps.

**About the "degraded" column.** Its high values for 4+3 and 8+4 come mostly from the 16-child
`maxFanout` cap. With small stripes, strong peers hit the cap long before their upload limit, so
their spare capacity goes unused. With `--fanout 48` the column is 0 for all of these. Bigger
subtrees have a cost, though: each departure now affects more viewers. For example, 4+2 stall time
goes from 0.071% to 0.184%.

```
                fanout 16                     fanout 48
k  m | stall % | degraded % | p50 ms    stall % | degraded % | p50 ms
4  2 |   0.071 |       0.02 |    330      0.184 |       0.00 |    321
4  3 |   0.000 |      19.56 |    343      0.049 |       0.00 |    317
8  2 |   0.263 |       0.96 |    364      0.349 |       0.00 |    319
8  4 |   0.012 |      44.16 |    358      0.038 |       0.00 |    317
```

### Recommendations

| Situation | Setting | Why |
|---|---|---|
| Small audience (fewer than about 6 capable relays) | `k=2, m=1` | Only 3 stripes need relays; one failure is invisible |
| General use | `k=4, m=1` | 25% overhead, about 3× fewer stalls than a single tree, ~350 ms latency |
| High churn, or viewers with spare upload | `k=4, m=2` | Stalls become rare (≈1–2 per viewer-hour at 240 s lifetimes) |
| Upload-starved audience | `k=1, m=0` or `k=4, m=1` with a lower bitrate | Parity overhead competes with capacity you don't have |
| Large audience with strong uplinks | `k=8, m=2..4` with a higher `maxFanout` | Most resilient per byte of overhead; needs many relays |

### Knobs

| Knob | Where | Default | Effect |
|---|---|---|---|
| `k`, `m` | host URL / home page | 4, 1 | See above |
| `bitrate` | host URL | 2500 kbps | Lower bitrate → more relay slots per peer → shallower, more robust trees |
| `headroom` | `HostSession.plannerConfig` | 0.75 | Share of measured upload the planner will use. Lower is safer against bad estimates and leaves room for keyframe bursts. |
| `maxFanout` | `plannerConfig` | 16 | Children per relay. Higher uses strong peers fully but enlarges each failure's blast radius. |
| `minUptimeMsForRelay` | `plannerConfig` | 4000 | Newcomers stay leaves this long. Raising it filters out viewers who join briefly and leave, at the cost of slower ramp-up. |
| `switchGain` | `plannerConfig` | 1 | How many levels shallower a parent must be before a peer is moved. Higher means less churn but deeper trees. |
| `STRIPE_SILENCE_MS` | `viewerSession.ts` | 2000 | Failure detection time, which dominates `m=0` recovery. Lower recovers faster but risks false alarms on jittery links. |
| `REATTACH_BATCH_MS`, `LIVENESS_TIMEOUT_MS` | `hostSession.ts` | 400, 1200 | Collateral-blame window, and the dead-parent confirmation timeout |
| `HEARTBEAT_IDLE_MS`, `HEARTBEAT_TIMEOUT_MS` | `hostSession.ts` | 1000, 1500 | How fast departed leaves are noticed and pruned |
| `keyframeIntervalMs` | `HostSession.start` | 2000 | Shorter means faster joins and smaller GOP caches, but more bits spent on keyframes |
| Layer deadlines | `uplink.ts` `MAX_AGE_MS_BY_LAYER` | T0 900, T1 350, T2 180 ms | How long an overloaded relay queues each temporal layer before dropping it |
| Playout quantile / safety | `PlayoutClock` | 0.95 / 40 ms | Latency vs late-frame drops |

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
- a depth-3 tree, killing the top relay: everyone resumes, the healthy mid-level relays aren't
  blamed by their own children, and a departed leaf is pruned from its parent within about 2 s

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

- **Trust.** Anyone with the viewer link can watch, and the join code can't be revoked per viewer.
  Relays can't forge or alter the stream (see [Security](#security)), but they can still drop it.
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
