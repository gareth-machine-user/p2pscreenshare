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
  arrival times. The default profile favours complete frames over delay (see
  [Quality versus latency](#quality-versus-latency)); the low-latency profile measured about
  **70 ms** glass-to-glass in local e2e tests.
- **Graceful degradation.** Uplink queues drop temporal enhancement layers (T2, then T1) first, so
  an overloaded relay lowers the frame rate instead of stalling. A relay cache of the frames since
  the last keyframe (the GOP) lets new or re-attached children start decoding immediately.

## Quick start

```sh
npm install
npm run dev                 # http://localhost:5173
```

Open the app, enter your name and click **Create lobby**. Copy the lobby link and send it to
others, then click **Share screen**. Public WebTorrent trackers are used by default; for local
development run your own:

```sh
npm run tracker             # ws://localhost:8000
# then open  http://localhost:5173/?tracker=ws://localhost:8000
```

## Using a lobby

- **Owner.** Whoever clicks **Create lobby** owns it. The owner's private seed stays in that
  browser's `localStorage`, so reloading the lobby there keeps you its owner; the link you share
  only carries the join code. The lobby keeps working while the owner is away (an "Owner away"
  badge shows), except that new requests to share wait for the owner.
- **Sharing.** The owner can always share. Everyone else clicks **Ask to share**; the owner gets a
  toast with **Allow**, **Allow all**, **Deny** and **Deny all**, and the requester sees "Waiting
  for the owner…" (or "Owner is away"). The lobby settings (gear in the top bar, owner only) set
  who may share: ask each time, anyone, or only the owner. The share dialog picks the source
  (screen, window or tab), system audio and microphone, a quality preset, and under **Advanced**
  the stripe layout and a test pattern. All of it is remembered.
- **Presenting.** You see a preview of what you share while the lobby tab is focused; it hides
  when you switch away (so sharing the whole screen doesn't film the preview). A presenter bar
  mutes the mic or the stream audio, switches the source, changes the quality and stops. With the **Auto** preset the stream drops its bitrate if the audience
  can't upload enough to carry it ("Audience upload is limited" shows either way).
- **Watching.** With two or more streams live, a tile rail shows live previews; click one to put it
  on the stage. Hover the player for mute (every stream starts muted), quality (Auto, Full or
  Preview), fullscreen, and a gear with **Stats**, **Peers** (who is connected, upload, RTT,
  "limited connectivity") and **Topology** (the stream's relay trees, fetched from its presenter).
- **Moderation.** The owner can stop anyone's stream from its tile menu (which revokes their right
  to share) and kick members from the Peers panel.
- **Names.** Guests may join and watch anonymously, but pick a name (remembered) before sharing,
  asking to share, or sending their first chat message.
- **Names.** Guests may join and watch anonymously, but pick a name before sharing, asking to
  share, or sending their first chat message. It is remembered; change it from the name field on
  the home page (it applies the next time a lobby loads).
- **Chat.** Signed, rate limited, collapsible; a joiner receives the last 50 messages.

Useful URL parameters (put them in the page query or the hash query):

| Param | Meaning |
|---|---|
| `tracker=ws://a,wss://b` | Tracker URLs to use instead of the public defaults |
| `ice=none` / `ice=stun:…,turn:…` | ICE servers (`none` for LAN or tests; add TURN for hostile NATs) |
| `name=…` | Display name for this page only |
| `priority=latency` | Low-latency tuning instead of the default quality profile (see [Quality versus latency](#quality-versus-latency)) |
| `up=800` | Debug upload cap in kbps (token-bucket shaper) to emulate a weak peer; applies to presenters too |
| `share=1` | Share right away (asking the owner first if needed) with the overrides below; used by the e2e tests |
| `k`, `m`, `bitrate`, `quality=auto` | With `share=1`: data and parity stripes, video kbps, Auto quality |
| `source=test&res=640x360&audio=1&mic=1` | With `share=1`: animated test pattern (prints the clock), a test tone, the microphone |
| `block=name1,name2` | Debug: refuse mesh links with these members, as if ICE failed |

`#/host?stream=<seed>` (an owner link from older versions) still works: it stores the seed and
redirects to the lobby page.

## Deploying

The app is static files. `npm run build` writes `dist/` with relative asset paths, so it works
from any subpath. `.github/workflows/deploy.yml` type-checks, tests, builds and publishes to
GitHub Pages on every push to `main`. To use your own trackers in the build, set a repository
variable `VITE_TRACKERS` (comma-separated `wss://` URLs).

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
   drops above 3% cap the estimate at 90% of the achieved rate; it re-probes every 5 minutes when
   lightly loaded. 75% of the estimate is split into relay slots per watched channel (a publisher
   first reserves its own roots), weighted towards channels whose publisher reports a deficit,
   and gossiped.
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
key, or anyone under an open policy, unless revoked) before forwarding or playing a fragment,
and fail closed. Forged fragments are dropped without
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
| A stripe goes silent | A child hears nothing on it for 1 s and sends `reattach` | Batched for 400 ms and handled shallowest-first; the reported parent is pinged (1.2 s) and avoided | ~1.5 s |
| Resume | The new parent replays its cached GOP over an existing mesh link | | ~1 RTT |
| A pair can't connect | Mesh ICE fails; both list each other as unreachable | Never a tree edge; retried with backoff | — |
| A peer leaves | Its goodbye record, or 6 s without anything fresh | Removed from every channel it watched | ≤ 6 s |
| A relay is consistently late | Every viewer measures how far behind the first piece of each frame each stripe arrives; the publisher attributes the excess to the parent | Lateness counts as a parent-choice penalty; a parent late by more than 150 ms for 10 s loses its children there for 30 s | 10 s |
| Several publishers compete for relays | Channel announcements carry the latest plan's `deficit` | Every 10 s each peer moves 10% of its budget weight from channels without a deficit to those with one | a few rounds |
| The audience can't upload enough | Offered slots below 90% of the N × S needed for 10 s | The presenter sees "Audience upload is limited: about X Mbps will play smoothly"; with Auto quality the encoder drops to that bitrate (in place, no new capture) | ~10 s |
| Upload estimates go stale | Every 5 min while relaying lightly, or when a publisher whose channel is overcommitted asks | Re-probe | — |

Measured in the e2e tests on one machine:
- **With parity (`m ≥ 1`):** a relay leaving is invisible (minimum 31–34 fps during failover).
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
- More than `m` relays failing within one detection window: viewers fed by all of them stall until
  reattach. Pull repair (fetching missing pieces from relays outside one's own subtree) is designed
  but deferred until measurements show it's needed.

## Simulation

`npm run sim -- --peers 200 --seconds 300` runs one publisher's planner under churn with a mix of
residential uplinks: 25% at 0.5 Mbps, 35% at 2 Mbps, 25% at 8 Mbps and 15% at 30 Mbps. Viewers
stay a mean of 240 s, and the stream is 2.5 Mbps. Peers offer slots from a noisy upload estimate,
re-measured every 10 s, and the publisher sees offers and joins `--gossip` ms late (default 500).
When a peer leaves, its subtree loses that stripe for `--repair` ms (default 2500, matching the
mesh e2e measurement above). A viewer stalls while more than `m` of its stripes are missing.

```
k  m | p50 ms | p95 ms | max depth | stall % | stalls/hr | degraded % | parent changes/min
-----+--------+--------+-----------+---------+-----------+------------+-------------------
1  0 |    323 |    396 |         5 |   2.167 |     30.62 |       0.00 |                331
2  0 |    307 |    372 |         4 |   2.761 |     39.89 |       0.00 |                515
4  0 |    343 |    401 |         4 |   6.882 |     98.61 |       0.00 |                960
4  1 |    319 |    380 |         4 |   0.499 |     11.16 |       0.00 |               1432
4  2 |    323 |    377 |         4 |   0.084 |      1.40 |       0.05 |               2104
8  2 |    345 |    411 |         4 |   0.377 |      6.16 |       1.52 |               3404
```

"Degraded" means some viewer's k-th best stripe passes through a parent whose children need more
than its true upload. Other options: `--lifetime`, `--repair`, `--gossip`, `--fanout`,
`--only 4:1,8:2`, and the sweeps below.

Two scenarios exercise the hardening:

```
$ npm run sim -- --sweep late --peers 100      # relays that forward 250 ms late, 4+1 stripes
late share | handled | p50 ms | p95 ms | stall %
        0% |     yes |    311 |    354 |   0.235
       10% |      no |    320 |    570 |   0.235
       10% |     yes |    314 |    505 |   0.247
       25% |      no |    482 |    595 |   0.235
       25% |     yes |    343 |    580 |   0.255

$ npm run sim -- --sweep competing --peers 60  # two publishers, everyone watches both
rebalancing | overcommitted A | overcommitted B | degraded % A | degraded % B
         no |             0.0 |            98.0 |         0.00 |        85.00
        yes |             4.6 |            38.5 |         0.00 |         0.00
```

## Tuning

### How much does parity buy?

`npm run sim -- --sweep parity --seconds 600` gives stall time as a % of viewing time, with stall
events per viewer-hour in parentheses:

```
k  m | overhead |         life 60s |        life 240s |        life 900s | degraded % (240s)
-----+----------+------------------+------------------+------------------+------------------
1  0 |       0% |    8.960 (128.5) |     2.311 (32.5) |     0.757 (10.9) |              0.00
2  0 |       0% |   12.275 (171.1) |     2.908 (41.4) |     0.967 (13.9) |              0.00
2  1 |      50% |     2.088 (52.8) |      0.113 (4.9) |      0.006 (0.5) |              0.00
2  2 |     100% |     0.403 (10.8) |      0.001 (0.0) |      0.000 (0.0) |              2.37
4  0 |       0% |   25.872 (327.1) |    7.579 (107.3) |     2.387 (34.3) |              0.00
4  1 |      25% |    5.264 (128.8) |     0.397 (10.3) |      0.039 (1.1) |              0.09
4  2 |      50% |     1.428 (41.8) |      0.045 (0.8) |      0.000 (0.0) |              0.17
4  3 |      75% |      0.278 (6.8) |      0.011 (0.2) |      0.000 (0.0) |              3.12
8  0 |       0% |   45.684 (502.6) |   14.583 (196.8) |     3.707 (52.9) |              5.13
8  2 |      25% |    3.294 (111.1) |      0.204 (3.7) |      0.000 (0.0) |              2.34
8  4 |      50% |      0.339 (8.6) |      0.036 (0.5) |      0.000 (0.0) |             25.01
```

Takeaways:

- **Striping without parity makes things worse.** A viewer depends on `k` parents instead of one,
  and losing any of them stalls it. At 240 s lifetimes, stall time is 2.3% for k=1, 2.9% for k=2,
  7.6% for k=4 and 14.6% for k=8.
- **The first parity stripe is the big win.** It turns a single failure from a stall into nothing.
  k=4/m=1 (25% overhead) stalls about 6× less than a single tree, and k=2/m=1 about 20× less.
- **Each further parity stripe still helps, by less.** A stall now needs `m+1` overlapping failures
  within one repair window: at 240 s lifetimes, k=4 goes 0.397% → 0.045% → 0.011% as m goes 1 → 3.
- **For the same overhead, more stripes are more resilient.** At 50% overhead, stall time is
  0.113% for 2+1, 0.045% for 4+2 and 0.036% for 8+4. The costs are more parents per viewer
  (`k+m`), more planner churn (parent changes per minute rise roughly with `k+m`), and more relays
  needed before every stripe has one.
- **Churn sets the baseline; repair time scales it.** With 60 s lifetimes, even 4+2 stalls 1.4% of
  the time. Halving repair time (`--repair 1250`) cuts stall time 1.9× with m=0 (stalls get shorter)
  and 3× with m=1 (overlapping failures must land in a shorter window): 0.397% → 0.132% for 4+1.
- **Parity isn't free.** Every viewer downloads `(k+m)/k` × the bitrate, and relays upload the same
  overhead. When the audience's total upload is tight, more parity means more overloaded relays.
  That shows up as "degraded": dropped enhancement frames, lower fps.

**About the "degraded" column.** Its high values for 8+4 come mostly from the 16-child
`maxFanout` cap. With small stripes, strong peers hit the cap long before their upload limit, so
their spare capacity goes unused. With `--fanout 48` the column is 0 for all of these. Bigger
subtrees have a cost, though: each departure affects more viewers (4+2 and 4+3 stall more).

```
                fanout 16                     fanout 48
k  m | stall % | degraded % | p50 ms    stall % | degraded % | p50 ms
4  2 |   0.084 |       0.05 |    323      0.103 |       0.00 |    315
4  3 |   0.021 |       0.27 |    321      0.208 |       0.00 |    308
8  2 |   0.377 |       1.52 |    345      0.163 |       0.00 |    302
8  4 |   0.072 |      19.28 |    331      0.021 |       0.00 |    313
```

### Recommendations

| Situation | Setting | Why |
|---|---|---|
| Small audience (fewer than about 6 capable relays) | `k=2, m=1` | Only 3 stripes need relays; one failure is invisible |
| General use | `k=4, m=1` | 25% overhead, about 6× fewer stalls than a single tree, ~320 ms latency |
| High churn, or viewers with spare upload | `k=4, m=2` | Stalls become rare (≈1 per viewer-hour at 240 s lifetimes); Auto quality picks it when relays allow |
| Upload-starved audience | `k=1, m=0` or `k=4, m=1` with a lower bitrate | Parity overhead competes with capacity you don't have |
| Large audience with strong uplinks | `k=8, m=2..4` with a higher `maxFanout` | Most resilient per byte of overhead; needs many relays |

### Quality versus latency

`src/tuning.ts` holds every knob that trades delay for smooth, complete frames. The default
**quality** profile suits screen sharing; `?priority=latency` picks the low-latency one.

| Knob | Quality (default) | Latency | Why |
|---|---|---|---|
| Uplink deadlines T0 / T1 / T2 | 2500 / 1500 / 800 ms | 900 / 350 / 180 ms | Bursts drain from the queue instead of costing frames |
| Keyframe / replay deadline | 4 s | 2 / 2.5 s | Keyframes and GOP replays survive overload |
| Jitter buffer | 99th percentile + 120 ms, ≥ 150 ms | 95th percentile + 40 ms | Far fewer late or skipped frames on jittery paths |
| Media channel retransmits | up to 3 s | up to 1 s | Lost packets are re-sent instead of lost |
| Congestion back-off | queueing > 800 ms | queueing > 250 ms | The bitrate drops only on real congestion |
| Stripe-silence detection | 1.5 s | 1 s | Fewer false reattaches |
| Keyframe interval | 10 s | 2 s | Keyframes are expensive, and with constant bitrate each one briefly blurs the picture to fit the budget; joiners start from the cached GOP and a viewer that loses its decode chain asks for one |

Rate control, in both profiles:
- **Constant-bitrate encoding.** Fast motion costs a little sharpness instead of producing frames
  several times the average size, which would overflow the uplinks the relay trees were planned
  for.
- **Planning for peaks.** The publisher announces the 90th percentile of quarter-second stripe
  rates over the last 10 s, so relay slots cover bursts.
- **Frame-aware dropping.** When one fragment of a frame misses its deadline on a link, the rest of
  that frame's fragments on that link are dropped too, freeing upload for frames that can still
  play.
- **Congestion control.** The publisher lowers its bitrate only when its own uplink is full: more
  than half of the links it feeds are congested at once (dropping live fragments, or queueing them
  for long), and with a single link only if that link carries most of the measured upload. One
  slow viewer congests just its own link, which sheds enhancement frames for that viewer alone
  (and its Auto quality can fall back to the preview); viewers' own losses don't move the bitrate
  either. When full, it cuts by 25% (by half when clearly swamped); after 5 s clean it climbs back
  by 25% every 5 s, never above the chosen quality or what the audience's relay slots can carry.
  Catch-up replays to newly attached viewers don't count as congestion. Changes apply in place,
  with no new capture. Topology shows each directly fed viewer's link from the presenter, so a slow
  peer is easy to spot.
- **Why it's clamped.** While the bitrate is below the chosen quality, the presenter bar (and
  Stats) say why in numbers: for example "your upload is sending about 3.0 Mbps, but 16 Mbps needs
  at least 21 Mbps here (you send 5 stripe copies yourself …)".
  A lower quality preset or fewer parity stripes then usually looks sharper than a starved one.

Every place a frame can go missing is counted and shown in **Stats** (and per viewer in
**Topology**): frames dropped by the encoder, uplink fragments dropped by temporal layer and
queueing delay, and frames a viewer received incomplete, late, undecodable or skipped.

### Knobs

| Knob | Where | Default | Effect |
|---|---|---|---|
| `k`, `m` | Share dialog (Advanced) | 4, 1 | See above |
| Quality preset | Share dialog | Auto (2.5 Mbps, adapts) | Lower bitrate → more relay slots per peer → shallower, more robust trees |
| `HEADROOM` | `session/capacity.ts` | 0.75 | Share of measured upload a peer offers. Lower is safer against bad estimates and leaves room for keyframe bursts. |
| `MAX_FANOUT` | `session/capacity.ts` | 16 | Children per relay. Higher uses strong peers fully but enlarges each failure's blast radius. |
| `minUptimeMsForRelay` | `ChannelPublisher.plannerConfig` | 4000 | Newcomers stay leaves this long. Raising it filters out viewers who join briefly and leave, at the cost of slower ramp-up. |
| `switchGain`, `rttSwitchMs` | `ChannelPublisher.plannerConfig` | 1, 40 | How many levels shallower (or ms closer) a parent must be before a peer is moved. Higher means less churn. |
| `STRIPE_SILENCE_MS` | `tuning.ts` | 1500 (quality) | Failure detection time, which dominates `m=0` recovery. Lower recovers faster but risks false alarms on jittery links. |
| `REATTACH_BATCH_MS`, `LIVENESS_TIMEOUT_MS` | `session/publisher.ts` | 400, 1200 | Collateral-blame window, and the dead-parent confirmation timeout |
| `SUSPECT_MS`, `GONE_MS` | `mesh/mesh.ts` | 1500, 6000 | When a silent link is taken out of the trees, and when a silent peer is declared gone |
| `keyframeIntervalMs` | `tuning.ts` | 10000 (quality) | Shorter means faster joins and smaller GOP caches, but more bits spent on keyframes |
| Layer deadlines, jitter buffer, retransmits | `tuning.ts` | see the table above | Latency vs complete, smooth frames |

## Tests

```sh
npm test                    # unit: framing, FEC, reassembly, jitter buffer, planner, gossip, capacity
npm run check               # svelte-check + tsc
npm run e2e                 # Playwright: local tracker + dev server + several browser contexts
```

The e2e suite covers:
- hardening: auto quality lowers the bitrate for an audience that can't carry the stream; a kicked
  member stays out after a reload
- several publishers: request and approve, tiles, the preview filling in while switching, mixed
  audio and mutes, revocation (relays reject a revoked publisher that keeps sending), deny and
  allow all
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

- **Trust.** Anyone with the lobby link can join and watch, and the join code can't be revoked.
  Relays can't forge or alter the stream (see [Security](#security)), but they can still drop it.
- **Lobby size.** The full mesh is designed for about 50 peers (each holds a connection to every
  other one). Phones holding 49 connections may struggle.
- **Kicks and Sybils.** The join code can't be revoked, so a kicked person can come back with a new
  key (a reload keeps the old key, which stays refused). Anyone with the link can join under many
  keys; the owner can kick them.
- **NAT pairs without TURN.** Some pairs never connect; planners avoid them, and the Peers panel
  shows "limited connectivity", but a peer that can't reach most of the lobby only gets the
  stripes it can reach. Pass TURN servers with `ice=`.
- **Small audiences.** With fewer capable relays than stripes, the publisher carries uncovered
  stripes itself (reported as "overcommitted"), unless parity already covers them.
- **Encoding and playback.** Each stream has a full encoding and a small preview; viewers on weak
  downlinks can switch to the preview, and overloaded relays drop temporal layers. Capture relies
  on `MediaStreamTrackProcessor` (Chromium); other browsers fall back to sampling a `<video>`
  element. Audio playback scheduling is basic. Testing so far is mostly headless Chromium.
- **Tracker reliability.** Public trackers are flaky. Self-host one with `npm run tracker` (it's
  `bittorrent-tracker`) behind TLS for real use.
