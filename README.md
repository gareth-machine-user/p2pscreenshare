# p2pscreenshare

Browser-only screen sharing over WebRTC. A lobby is a full mesh of up to about 50 peers, and each
stream reaches its viewers through bandwidth-aware **striped relay trees** that its publisher plans,
so viewers seed each other instead of all pulling from the publisher. WebTorrent trackers are used
only to find the lobby; no media server is involved.

- **Full-mesh lobbies.** Every peer runs the same session and holds one WebRTC connection to every
  other peer, carrying a reliable `ctl` channel (gossip, chat, tree commands, stats) and an
  unreliable `media` channel (fragments). A tree edge is just "forward channel X stripe s on this
  pair's media channel", so joining a tree or switching parents never needs new ICE or DTLS setup.
- **Encode once, forward bytes.** The publisher encodes with WebCodecs (VP9 with temporal SVC
  `L1T3` when available). Relays forward encoded fragments without decoding them, so every viewer
  gets identical frames and relaying costs almost no CPU.
- **Striped multi-tree + erasure coding (SplitStream-style).** Each frame is split into `k` data
  and `m` parity pieces, and stripe *i* carries piece *i*. A viewer needs any `k` of the `k+m`
  stripes to decode. Each peer relays in at most one "home" stripe and is a leaf in all the
  others. With `k=1, m=0` this is a plain single relay tree.
- **Each publisher plans its own trees.** Peers measure their upload, split it into relay slots
  per channel and gossip the offer; the publisher's planner (`src/topology/planner.ts`) places
  stronger peers nearer the root, prefers closer parents (RTT), and switches parents
  make-before-break. The planner fails together with the stream it plans, so there is no leader.
- **Cut-through forwarding and low latency.** Relays forward each fragment as soon as it arrives.
  A jitter buffer that tracks reference dependencies plays out at the 95th percentile of frame
  arrival times. Measured glass-to-glass latency in local e2e tests is about **70 ms**.
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
              tracker (door peers' offer pools)
                 │
   ┌──────────── full mesh: one RTCPeerConnection per pair ────────────┐
   │  owner (gatekeeper)   publisher A (plans A's trees)   B   C   D …  │
   └────────────────────────────────────────────────────────────────────┘
   A ── stripe 0 ─▶ B ─▶ {C, D …}        B relays stripe 0 only
     ── stripe 1 ─▶ C ─▶ {B, D …}        C is a leaf here
     ── stripe 2 ─▶ D ─▶ {B, C …}        any k of k+m stripes decode
```

1. **Bootstrap** (`src/net/bootstrap.ts`). The owner plus the two oldest present members are
   *door peers*: each keeps a pool of pre-gathered offers announced to the lobby's info-hash. The
   tracker hands each offer to a distinct joining peer, which answers through the tracker.
2. **Meshing in** (`src/mesh/mesh.ts`). Over the door link the joiner receives every member's
   record and recent chat, then connects to everyone else. Signaling for a pair travels over the
   `ctl` channel of a peer both are linked to, the lower id offers, and connections open in
   batches of 8.
3. **Gossip** (`src/mesh/records.ts`). Each peer owns one signed record (name, upload estimate,
   relay slots offered per channel, subscriptions, open and failed links, RTTs, announced
   channels) and sends it to its neighbours every 2 s and on change, gzipped when large. Every
   2 s it swaps a digest with one random neighbour and pulls whatever is newer. A peer is gone when
   nothing fresh has been heard about it, from anyone, for 6 s. Pairs whose link fails are listed
   as unreachable, never become tree edges, and are retried after 60 s with backoff.
4. **Channels and subscriptions** (`src/session/peerSession.ts`). A channel is one encoding of one
   stream, with a random 32-bit id drawn each time it starts. The publisher announces it in its
   record; viewers send `subscribe` directly to the publisher, and relay only in channels they
   watch.
5. **Capacity** (`src/session/capacity.ts`). At join a peer sends a paced 1.5 s probe to 3 random
   neighbours at background priority, and adds what its uplink sent meanwhile. While relaying,
   drops above 3% cap the estimate at 90% of the achieved rate. 75% of the estimate is split into
   relay slots per watched channel (a publisher first reserves its own roots) and gossiped.
6. **Planning** (`src/session/publisher.ts`, `src/topology/planner.ts`). The publisher replans
   every 2 s and 50 ms after inputs change. `plan()` is pure and deterministic: home stripes are
   balanced by offered slots, each tree is built top-down keeping valid existing parents
   (hysteresis: a move needs a parent a level shallower or 40 ms closer), newcomers stay leaves
   for 4 s, and edges are only made between linked pairs. Encoders overshoot their target, so
   the publisher announces the stripe bitrate it actually sends. It never overloads its own
   uplink for a stripe that parity covers: it is the source of every stripe.
7. **Several streams.** Anyone the owner allows may share. Each stream is a full-resolution
   channel plus a 320×180, 5 fps preview channel (~120 kbps, a single tree). While two or more
   streams are live, every viewer watches all previews in a tile rail and one full stream on the
   stage; switching tiles shows the preview until the first full-resolution frame. The main
   player's quality can be Auto (full, falling back to the preview if frames stop arriving), Full
   or Preview. Presenters mix system audio and the microphone into one Opus track (WebAudio gain
   nodes, so muting restarts nothing), and every stream starts muted for viewers.
8. **Applying changes.** The publisher tells the new parent `add-child` and the child `set-parent`
   over their mesh links. Once the child reports `stripe-ok` from the new parent, the old parent
   gets `remove-child`.

### Security

The owner's URL never leaves its device: **Create lobby** draws a private seed, keeps it in
`localStorage`, and shows the lobby link `#/lobby/<secret>.<owner public key>`. From the seed the
owner derives (HKDF, `src/net/lobby.ts`) the 128-bit lobby secret and its Ed25519 key. Links keep the
code in the fragment, so it is never sent to a server. From the join code everyone derives:

- **Tracker info_hash.** Trackers and anyone scanning them see only a one-way derivative of the code.
- **SDP sealing key.** Door offers and answers sent through trackers are AES-GCM sealed, bound to
  their offer id and direction. A peer without the code can't read an offer or answer one.

**Identity** (`src/mesh/identity.ts`). Every peer has an Ed25519 key, persisted per lobby, and its
peer id is a hash of the public key; the owner's key is the one pinned in the join code. Inside
the seal each side signs its SDP, and mesh signaling relayed by other peers is signed too, so a
relaying peer can't swap the DTLS fingerprints: every mesh link is authenticated to a peer id, and
DTLS encrypts every hop. Gossip records, chat messages and channel announcements are signed
envelopes (`src/mesh/envelope.ts`) that any peer can verify and forward.

**Publishing rights** (`src/mesh/auth.ts`). The owner signs one gossiped document holding the
lobby's publish policy (`ask`, `open` = *Allow all*, `closed` = *Deny all*), grants bound to
grantees' public keys, revocations and bans. Only the key pinned in the join code can change it,
everyone (including later joiners) holds the latest version, and it keeps working while the owner
is away. A member who may not publish asks the owner, who answers with **Allow**, **Allow all**,
**Deny** or **Deny all**; stopping a stream from its tile revokes the grant.

**Tamper-proofing.** Every media fragment is signed by its channel's publisher
(`src/proto/signing.ts`), and the signature covers the channel id. Relays look up the publisher's
key from the channel announcement and check that the publisher may publish (the owner, a granted
key, or anyone under an open policy, unless revoked)
before forwarding or playing a fragment, and fail closed. Forged fragments are dropped without
marking their id as seen, so they can't shadow the genuine fragment, and signed fragments older
than the 5 s de-dup window are dropped as replays. Tree commands for a channel are only accepted
from its publisher.

A malicious relay can still drop or delay what it forwards. Parity stripes (`m ≥ 1`) and
re-attachment cover that.

### Wire format

Each media message is one fragment: a 40-byte header (version, flags with key/audio/replay bits
and the temporal layer, epoch, frame seq, GOP id, reference seq, capture time, k, m, piece,
stripe, frame length, fragment index and count, and the u32 channel id) followed by up to about
16 KB of payload and the publisher's 64-byte Ed25519 signature (`WIRE_VERSION` 3). See
`src/proto/framing.ts`. Audio (Opus) is tiny, so it is sent unsplit on every stripe of the full
channel.

## Failure handling and recovery

The publisher reacts to its own mesh links at once and to what subscribers report; the
membership layer handles everything else.

| Event | Detection | Response | Time |
|---|---|---|---|
| A relay's link drops | The publisher's link to it closes or misses pings for 1.5 s | Replan at once; its parents get `remove-child`; its subtree is marked "disrupted upstream" for 6 s | ms |
| A stripe goes silent | A child hears nothing on it for 2 s and sends `reattach` | Batched for 400 ms and handled shallowest-first; the reported parent is pinged (1.2 s) and avoided | ~2.5 s |
| Resume | The new parent replays its cached GOP over an existing mesh link | | ~1 RTT |
| A pair can't connect | Mesh ICE fails; both list each other as unreachable | Never a tree edge; retried with backoff | — |
| A peer leaves | Its goodbye record, or 6 s without anything fresh | Removed from every channel it watched | ≤ 6 s |

Measured in the e2e tests on one machine:
- **With parity (`m ≥ 1`):** a relay leaving is invisible (minimum 19–24 fps during failover).
- **Without parity:** orphans resume after about **1–2.5 s**, including orphans two levels below the
  failed relay (it was about 4 s when tree links were set up on demand).
- **Pruning:** a departed child is removed from its parent's forwarding set at once.

Mechanisms that keep one failure from spreading:
- **No collateral blame.** When a relay dies, its descendants all go silent together and all complain. Handling complaints shallowest-first, and marking each complainer's subtree as "disrupted upstream" for 6 s, means only the topmost complaint counts against a parent. Healthy relays below it keep their children and their rank.
- **No forwarding into the void.** When a peer leaves, the publisher tells each of its parents `remove-child`.
- **Liveness.** The mesh pings every idle link; pongs are answered from a message handler, so background-tab timer throttling doesn't cause false positives.
- **Planned moves are glitch-free.** The old parent keeps feeding until the child reports `stripe-ok` from the new one (make-before-break).
- **No startup backlog.** A new child's live fragments are queued ahead of its GOP replay, so its jitter buffer isn't inflated.

Not handled yet:
- A relay that is alive but consistently *late*: children's jitter buffers grow, but nobody moves them.
- More than `m` relays failing within one detection window: viewers fed by all of them stall until reattach.

## Simulation

`npm run sim -- --peers 200 --seconds 300` runs one publisher's planner under churn with a mix of
residential uplinks: 25% at 0.5 Mbps, 35% at 2 Mbps, 25% at 8 Mbps and 15% at 30 Mbps. Viewers
stay a mean of 240 s, and the stream is 2.5 Mbps. Peers offer slots from a noisy upload estimate,
re-measured every 10 s, and the publisher sees offers and joins `--gossip` ms late (default 500).
When a peer leaves, its subtree loses that stripe for `--repair` ms (default 2500, matching the
mesh e2e measurement above). A viewer stalls while more than `m` of its stripes are missing. (The
tables below were measured before the mesh, with 3500 ms repairs.)

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
| `k`, `m` | Share dialog (Advanced) | 4, 1 | See above |
| Quality preset | Share dialog | Auto (2.5 Mbps) | Lower bitrate → more relay slots per peer → shallower, more robust trees |
| `HEADROOM` | `session/capacity.ts` | 0.75 | Share of measured upload a peer offers. Lower is safer against bad estimates and leaves room for keyframe bursts. |
| `MAX_FANOUT` | `session/capacity.ts` | 16 | Children per relay. Higher uses strong peers fully but enlarges each failure's blast radius. |
| `minUptimeMsForRelay` | `ChannelPublisher.plannerConfig` | 4000 | Newcomers stay leaves this long. Raising it filters out viewers who join briefly and leave, at the cost of slower ramp-up. |
| `switchGain`, `rttSwitchMs` | `ChannelPublisher.plannerConfig` | 1, 40 | How many levels shallower (or ms closer) a parent must be before a peer is moved. Higher means less churn. |
| `STRIPE_SILENCE_MS` | `session/subscription.ts` | 2000 | Failure detection time, which dominates `m=0` recovery. Lower recovers faster but risks false alarms on jittery links. |
| `REATTACH_BATCH_MS`, `LIVENESS_TIMEOUT_MS` | `session/publisher.ts` | 400, 1200 | Collateral-blame window, and the dead-parent confirmation timeout |
| `SUSPECT_MS`, `GONE_MS` | `mesh/mesh.ts` | 1500, 6000 | When a silent link is taken out of the trees, and when a silent peer is declared gone |
| `keyframeIntervalMs` | `PublishedStream.start` | 2000 | Shorter means faster joins and smaller GOP caches, but more bits spent on keyframes |
| Layer deadlines | `uplink.ts` `MAX_AGE_MS_BY_LAYER` | T0 900, T1 350, T2 180 ms | How long an overloaded relay queues each temporal layer before dropping it |
| Playout quantile / safety | `PlayoutClock` | 0.95 / 40 ms | Latency vs late-frame drops |

## Tests

```sh
npm test                    # unit: framing, FEC, reassembly, jitter buffer, planner, gossip, capacity
npm run check               # svelte-check + tsc
npm run e2e                 # Playwright: local tracker + dev server + several browser contexts
```

The e2e suite covers:
- the lobby UI: persisted settings, the player overlay, and the Topology panel
- the mesh: six peers mesh up, one leaves, a blocked pair is gossiped, chat reaches everyone; the
  lobby carries on without its owner; the mesh link stays up under streaming load
- star streaming
- a striped tree with mixed upload caps: weak peers stay leaves, the publisher feeds only the
  stripe roots, and killing the busiest relay causes no frame-rate stall
- a single tree: orphans recover within a few seconds, and a late joiner renders in under about 1 s
- a depth-3 tree, killing the top relay: everyone resumes, the healthy mid-level relays aren't
  blamed by their own children, and a departed leaf is pruned from its parent at once

`up=<kbps>` shapes a page's real uplink (publisher included), so e2e scenarios must be feasible:
the publisher only plans its own budget, but an overcommitted plan genuinely queues.

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
- **Lobby size.** The full mesh is designed for about 50 peers (each holds a connection to every
  other one).
- **NAT pairs without TURN.** Some pairs never connect; planners avoid them, and the Peers panel
  shows "limited connectivity", but a peer that can't reach most of the lobby only gets the
  stripes it can reach. Pass TURN servers with `ice=`.
- **Small audiences.** With fewer capable relays than stripes, the publisher carries uncovered
  stripes itself (reported as "overcommitted"), unless parity already covers them.
- **Encoding and playback.** There's a single encoding, so viewers with weak downlinks are helped
  only by relays dropping temporal layers; simulcast would be the next step. Capture relies on
  `MediaStreamTrackProcessor` (Chromium); other browsers fall back to sampling a `<video>` element.
  Audio playback scheduling is basic.
- **Tracker reliability.** Public trackers are flaky. Self-host one with `npm run tracker` (it's
  `bittorrent-tracker`) behind TLS for real use.
