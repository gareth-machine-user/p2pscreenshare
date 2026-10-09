# p2pscreenshare

Browser-only screen sharing over WebRTC. A lobby is a full mesh of up to about 50 peers, and each
stream reaches its viewers through bandwidth-aware **striped relay trees** that its publisher plans,
so viewers seed each other instead of all pulling from the publisher. WebTorrent trackers are used
only to find the lobby; no media server is involved.

- **Full-mesh lobbies.** Every peer runs the same session and holds one WebRTC connection to every
  other peer, carrying a reliable `ctl` channel (gossip, chat, tree commands, stats) and an
  unreliable `media` channel (fragments). A tree edge is just "forward channel X stripe s on this
  pair's media channel", so joining a tree or switching parents never needs new ICE or DTLS setup.
- **Encode once, forward bytes.** The publisher encodes with WebCodecs: VP9 with temporal SVC
  `L1T3` when available, or, at High quality and above, a hardware H.264 High-profile encoder with
  temporal layers if the machine has one (software VP9 in real-time mode stops turning extra bits
  into quality well before near-lossless). Relays forward encoded fragments without decoding them, so every viewer
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
  A jitter buffer that tracks reference dependencies plays out at a high percentile of frame
  arrival times, per viewer, so a laggy viewer buffers more without delaying anyone else. It keeps
  the buffer a delay spike needed for a minute and shrinks it gently, so a connection that
  hiccups every half minute doesn't stall on each hiccup. The default profile favours complete frames over delay (see
  [Quality versus latency](#quality-versus-latency)); the low-latency profile measured about
  **70 ms** glass-to-glass in local e2e tests.
- **Gapless audio.** 192 kbps Opus tuned for music, in 40 ms frames erasure coded across the full
  channel's stripes like the video (any k of the k+m stripes play it). A small jitter buffer
  reorders frames and decodes them in sequence, and an AudioWorklet plays them as one continuous stream, correcting
  drift by playing up to 1% fast or slow and fading across real gaps, so there are no clicks.
  Catch-up replays and headroom probes are paced so live audio never waits behind them.
- **Graceful degradation.** Uplink queues drop temporal enhancement layers (T2, then T1) first, so
  an overloaded relay lowers the frame rate instead of stalling. A relay cache of the frames since
  the last keyframe (the GOP) lets new or re-attached children start decoding immediately.

## Quick start

```sh
npm install
npm run dev                 # http://localhost:5173
```

Open the app, enter your name and click **Create a lobby**. Copy the link (from **Invite** in the
top bar, or the card on the empty stage) and send it to others, then click **Share screen**. Public WebTorrent trackers are used by default; for local
development run your own:

```sh
npm run tracker             # ws://localhost:8000
# then open  http://localhost:5173/?tracker=ws://localhost:8000
```

## Using a lobby

- **Home.** One screen to start: your name, **Create a lobby**, or paste a link to join. Scroll down
  (or click **How it works**) for a short explanation of the relay trees.
- **Owner.** Whoever clicks **Create a lobby** owns it. The owner's private seed stays in that
  browser's `localStorage`, so reloading the lobby there keeps you its owner; the link you share
  only carries the join code. The lobby keeps working while the owner is away (an "Owner away"
  badge shows), except that new requests to share wait for the owner. While nobody is sharing, the
  stage shows the lobby link with **Copy link** and a share button.
- **Sharing.** The owner can always share. Everyone else clicks **Ask to share**; the owner gets a
  toast with **Allow** and **Not now**, plus **Let anyone share from now on**, and the requester
  sees "Waiting for the owner…" (or "Owner is away"). The lobby settings (the sliders button in the
  top bar, owner only) set who can share: ask each time, anyone, or only the owner. The share dialog picks the source
  (screen, window, tab or camera), system audio and microphone, and under **Advanced** the stripe
  layout and a test pattern. Video quality shows as one line ("1080p30 · Standard · 5 Mbps") with a
  **Change** link. All of it is remembered.
- **Video quality.** Resolution (Native, 2160p, 1440p, 1080p, 720p, 540p), frame rate (30 or 60)
  and a quality level, each level a density of bits per pixel, so it means the same picture
  quality at any size: at 1080p30 Low is 2.5 Mbps, Standard 5, High 9, Very high 15 and
  Near-lossless 25; bigger and smoother frames scale a little less than linearly (pixels^0.75,
  frame rate^0.7: 1080p60 High is 14.5 Mbps, 2160p60 Near-lossless about 115). **Custom bitrate**
  sets any rate from 0.5 to 150 Mbps instead. **Lower automatically if viewers can't keep up** lets
  the stream go below the chosen rate (never above it) when the audience can't carry it.
- **Phones.** Mobile browsers can't capture the screen, so a phone shares its camera: the button
  reads **Share camera** and the dialog offers the front or back camera (plus the mic). While live,
  the presenter bar flips cameras in place (same stream, a keyframe, no new share), and the screen
  is kept awake, since a phone that locks stops its camera. The browser still suspends the camera
  if you leave the page, so keep the lobby in front while sharing. Camera access needs HTTPS (or
  localhost).
- **Presenting.** You see a preview of what you share while the lobby tab is focused; it hides
  when you switch away (so sharing the whole screen doesn't film the preview); the stage is outlined
  in red while you're live. A presenter bar under it shows **Live · N watching**, mutes the mic or
  the stream audio, switches the source, changes the quality (a button showing the live choice
  opens the same picker; changes apply at once, with a brief blur while the encoder restarts at a
  new resolution or frame rate) and has **Stop sharing**, and shows what you are uploading right
  now ("Uploading 4.2 Mbps", with a meter against what your upload carries; amber with the reason
  on hover while the bitrate is held below the chosen quality, e.g. "limited by your upload:
  ~8.0 Mbps"). With **Lower automatically** the stream drops its bitrate if the audience can't
  upload enough to carry it; either way one amber line above the bar says what the audience can
  carry and why the bitrate is held back.
- **Watching.** A chip on the stage says who is presenting. With two or more streams live, a
  **Live now** strip under the stage shows live previews; click one to put it on the stage. Hover
  the player for mute (every stream starts muted), quality (Auto, Full or Preview), buffering (Low
  latency, Auto, or Extra smooth, which adds 1.5 s for flaky connections), a readout of the
  resolution, frame rate and delay, fullscreen, and **Details** with **Stats** (including what you receive and upload right
  now, and a per-peer list: every member's measured upload capacity, marked "est.", and for peers you're
  connected to the live sending / receiving rates and RTT), **Peers** (who is connected; see
  [Per-link stats](#per-link-stats)) and **Topology** (the stream's relay trees, fetched from its
  presenter; every node carries a number, P for the publisher and #1, #2, … in join order, that
  matches the table below it, which also shows each peer's live send rate).
- **People.** The side panel's **People** tab lists everyone, with Owner and Live badges, who has
  asked to share, and each connection in a word (Good, OK, Slow, Connecting…, Can't connect;
  the round trip on hover).
- **Moderation.** The owner can stop anyone's stream from its tile menu (which revokes their right
  to share), and remove members from their menu in **People** (or the Details › Peers panel).
- **Names.** Guests may join and watch anonymously, but pick a name before sharing, asking to
  share, or sending their first chat message (the chat box offers **Pick a name** up front). It is
  remembered; change it from the name field on the home page (it applies the next time a lobby loads).
- **Chat.** The side panel's **Chat** tab: signed, rate limited, collapsible; a joiner receives the
  last 50 messages.

Useful URL parameters (put them in the page query or the hash query):

| Param | Meaning |
|---|---|
| `tracker=ws://a,wss://b` | Tracker URLs to use instead of the public defaults |
| `ice=none` / `ice=stun:…,turn:…` | ICE servers (`none` for LAN or tests; add TURN for hostile NATs) |
| `name=…` | Display name for this page only |
| `priority=latency` | Low-latency tuning instead of the default quality profile (see [Quality versus latency](#quality-versus-latency)) |
| `up=800` | Debug upload cap in kbps (token-bucket shaper) to emulate a weak peer; applies to presenters too |
| `share=1` | Share right away (asking the owner first if needed) with the overrides below; used by the e2e tests |
| `k`, `m`, `bitrate`, `fps`, `quality=auto` | With `share=1`: data and parity stripes, video kbps, frame rate, lower automatically |
| `source=test&res=640x360&audio=1&mic=1` | With `share=1`: animated test pattern (prints the clock), a test tone, the microphone |
| `source=camera&facing=environment` | With `share=1`: share a camera (`user`, the default, is the front one) |
| `block=name1,name2` | Debug: refuse mesh links with these members, as if ICE failed |
| `lanes=2` | Connections per peer pair, 1–4 (default 2; `1` = a single connection). See [Lanes](#lanes-experimental) |

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
   batches of 8. A member linked to only one peer for 20 s takes other doors' offers again, so a
   door that drops its signaling can't keep it from the rest of the lobby.
3. **Gossip** (`src/mesh/records.ts`). Each peer owns one signed record (name, upload estimate,
   relay slots offered per channel, subscriptions, open and failed links, RTTs, announced
   channels) and sends it to its neighbours every 2 s and on change, gzipped when large. Every
   2 s it swaps a digest with one random neighbour and pulls whatever is newer. A peer is gone when
   nothing fresh has been heard about it, from anyone, for 6 s; anything its open link receives
   counts (media, and SCTP acks seen in getStats), not only control messages, which can wait
   seconds behind a retransmission on the ordered `ctl` channel. Pairs whose link fails are listed
   as unreachable, never become tree edges, and are retried after 60 s with backoff.
4. **Channels and subscriptions** (`src/session/peerSession.ts`). A channel is one encoding of one
   stream, with a random 32-bit id drawn each time it starts. The publisher announces it in its
   record; viewers send `subscribe` directly to the publisher, and relay only in channels they
   watch.
5. **Capacity** (`src/session/capacity.ts`). One measured quantity: what each connection
   *delivered* (bytes handed to its channels, less what its send buffers grew by) per 2 s window,
   and whether it was *backlogged* (its uplink queue never emptied and live media queued ≥ 150 ms or
   was dropped: it carried all it could). The
   uplink's capacity is the most delivered over the last 10 s in windows where most connections
   were backlogged at once; a connection's own is the most it delivered while it alone was
   backlogged (see [Rate control](#rate-control)). 75% of the uplink's capacity is split into relay
   slots per watched channel (a publisher first reserves its own roots), weighted towards channels
   whose publisher reports a deficit, and gossiped with it.
6. **Planning** (`src/session/channelPublisher.ts`, `src/topology/planner.ts`). The publisher replans
   every 2 s and 50 ms after inputs change. `plan()` is pure and deterministic: home stripes are
   balanced by offered slots (each relay has one; while some stripe has no relay, relays take it
   on as an extra home, up to *m* each, so a small audience still relays every stripe and one bad
   relay costs at most what parity covers), each tree is built top-down keeping valid existing parents
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

### Lanes (experimental)

One WebRTC connection is one SCTP association with one Reno-like congestion window (Chrome's
dcSCTP: 5 MB receive window, bursts of 4 packets of 1191 bytes), which on real WAN paths tops out
around 10–25 Mbps whatever the uplink. A presenter feeding one viewer at 16 Mbps with 4+2 stripes
needs about 25 Mbps on that one connection. So each mesh pair opens **media lanes**
(`src/mesh/lane.ts`, `src/mesh/lanes.ts`): extra RTCPeerConnections that carry only an unordered
`media` channel (same packet lifetime as the mesh link's) and a `bin` channel for headroom probes.

- **Setting.** `lanes=N` (page or hash query), 1–4 connections per pair, **default 2** (the mesh
  link plus one lane). `lanes=1` is exactly the single-connection behaviour. A pair uses the
  smaller of the two peers' settings, so one side with `lanes=1` turns lanes off for its pairs.
- **Signaling** goes over the pair's authenticated `ctl` channel (`lane-offer`, `lane-answer`,
  `lane-close`), never the tracker; the lower peer id offers. Lanes open 1 s after the mesh link
  opens (never during the tracker rendezvous), and not at all if the link's selected candidate
  pair is relayed by TURN (checked with `getStats`). They close with the mesh link, so on leave,
  kick and ban too.
- **Sending.** The trees a peer sends to a pair are ranked (by channel, then stripe), and the
  *i*-th goes over slot *i* mod *K* of the pair, slot 0 being the mesh link: a pair carrying
  stripes 0 and 2 uses two connections. A lane that isn't open (yet, or while it reconnects) falls
  back to the mesh link, so the mapping only changes when a lane is given up for good or the pair's
  trees change. Each lane has its own uplink queue;
  the receiver de-duplicates by fragment id, so the split is invisible downstream. Audio is coded
  across the stripes like the video, so it spreads over the lanes the same way.
- **Capacity.** Each lane is its own connection with its own delivered rate; a peer's capacity is
  the sum over its lanes, and headroom probes push every lane at once, so in a two-peer lobby
  they measure the lanes together rather than one connection's ceiling (see
  [Rate control](#rate-control)).
- **Connection budget.** Chromium allows 500 RTCPeerConnections per page, and closed ones may
  count until the page reloads. With the default of 2, a 50-peer lobby uses 98 per page. A failed
  lane is retried after 5 s, then 30 s, and a pair that has had 3 lane failures gets no more
  lanes; a page creates at most 200 lanes in its lifetime.

**Comparing.** Open the same lobby with `lanes=1`, the default, and `lanes=4` on both presenter
and viewer (e.g. `…/#/lobby/<code>?lanes=4`; reload the page after changing it), share at 1080p
**Very high** (15 Mbps) or **Near-lossless** (25 Mbps), and compare: the **Peers** panel shows
"N lanes" next to each open link (or "TURN" when lanes were skipped), the live send rate to each
peer and what its connections carry (expand it for each lane's delivered rate, capacity, RTT and
queueing); the presenter's **Stats** show **Upload capacity**, **Bitrate** (what limits it),
**Your uplink** (send rate, dropped T0/T1/T2 fragments) and **Queueing delay**; the viewer's Stats
show incomplete and late frames. With one connection at its ceiling, it stays backlogged and the
bitrate settles at 85% of what it carries; with lanes the same stream should hold the chosen quality.

### Security

The owner's URL never leaves its device: **Create a lobby** draws a private seed, keeps it in
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
lobby's publish policy (`ask`, `open` = *Anyone*, `closed` = *Only me*), grants bound to
grantees' public keys, revocations and bans. Only the key pinned in the join code can change it,
everyone (including later joiners) holds the latest version, and it keeps working while the owner
is away. A member who may not publish asks the owner, who answers `allow`, `deny` or `allow-all`
(**Allow**, **Not now**, **Let anyone share from now on**; the protocol also has `deny-all`, which
the UI does as the *Only me* policy); stopping a stream from its tile revokes the grant.

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
`src/proto/framing.ts`. Audio (Opus, 40 ms frames) is erasure coded like the video: piece *i* of
each frame on stripe *i*, so it costs `(k+m)/k` times its bitrate plus 104 bytes of header and
signature per piece, and plays from any `k` stripes. (It used to be copied whole onto every stripe,
`k+m` times its bitrate, because coded audio broke up while viewers joined. The cause was stalls of
a whole connection, which carries several stripes: upload probes and media bursts deep enough to
stall Chromium's SCTP association. With send buffers capped at 64 KB those are gone, and coded
audio plays without gaps. Frames copied whole, with k=1 and m=0 on any stripe, are still accepted
from older publishers.) At k=4, m=2 a stripe carries about 69 kbps of the 192 kbps audio, against
213 kbps for a whole copy.

## Failure handling and recovery

The publisher reacts to its own mesh links at once and to what subscribers report; the
membership layer handles everything else.

| Event | Detection | Response | Time |
|---|---|---|---|
| A relay's link drops | The publisher's link to it closes or misses pings for 1.5 s | Replan at once; its subtree is marked "disrupted upstream" for 6 s. A closed link: its parents get `remove-child`. Missed pings on an open link: it keeps its own feed (often only the ordered control channel is stalled on a retransmission while media flows) but relays for no one until it answers | ms |
| A stripe goes silent | A child hears nothing on it for 1.5 s (1 s in the latency profile) and sends `reattach` | Batched for 400 ms and handled shallowest-first; the child avoids the parent, which is blamed (ranked lower, and pinged within 1.2 s) only if the evidence points at it | ~2 s |
| Resume | The new parent replays its cached GOP over an existing mesh link | | ~1 RTT |
| A pair can't connect | Mesh ICE fails; both list each other as unreachable | Never a tree edge; retried with backoff | — |
| A peer leaves | Its goodbye record, or 6 s without anything fresh | Removed from every channel it watched | ≤ 6 s |
| A relay is consistently late | Every viewer measures how far behind the first piece of each frame each stripe arrives; the publisher attributes the excess to the parent | Lateness counts as a parent-choice penalty; a parent late by more than 150 ms for 10 s loses its children there for 30 s | 10 s |
| Several publishers compete for relays | Channel announcements carry the latest plan's `deficit` | Every 10 s each peer moves 10% of its budget weight from channels without a deficit to those with one | a few rounds |
| The audience can't upload enough | Offered slots below 90% of the N × S needed for 10 s | The presenter sees "Audience upload is limited: about X Mbps will play smoothly"; with Auto quality the encoder drops to that bitrate (in place, no new capture) | ~10 s |
| Upload capacity changes | Backlogged windows (any time), or a headroom probe every 30 s (5 s while limited) while nothing is backlogged | Capacity follows (max over 10 s; at once when queueing passes 1 s) | 2–30 s |

Measured in the e2e tests on one machine:
- **With parity (`m ≥ 1`):** a relay leaving is invisible (minimum 31–34 fps during failover).
- **Without parity:** orphans resume after about **1–2.5 s**, including orphans two levels below the
  failed relay (it was about 4 s when tree links were set up on demand).
- **Pruning:** a departed child is removed from its parent's forwarding set at once.

Mechanisms that keep one failure from spreading:
- **No collateral blame.** When a relay dies, its descendants all go silent together and all complain. Handling complaints shallowest-first, and marking each complainer's subtree as "disrupted upstream" for 6 s, means only the topmost complaint counts against a parent. Healthy relays below it keep their children and their rank.
- **No forwarding into the void.** When a peer leaves, the publisher tells each of its parents `remove-child`.
- **Liveness.** The mesh pings every idle link; pongs are answered from a message handler, so background-tab timer throttling doesn't cause false positives. Media and wire bytes received on a link count too, so a stalled `ctl` channel alone never drops a neighbour.
- **Planned moves are glitch-free.** The old parent keeps feeding until the child reports `stripe-ok` from the new one (make-before-break).
- **No startup backlog.** A new child's live fragments are queued ahead of its GOP replay, so its jitter buffer isn't inflated.

One viewer with a bad connection mostly hurts only itself:
- **Replay before keyframes.** A viewer that loses its decode chain first asks its stripe parents to replay the cached GOP; only if that fails does it send `need-key` to the publisher.
- **Keyframe gate.** Keyframes are expensive for everyone (in constant-bitrate mode each one briefly blurs the picture), so the publisher gates requests per viewer (`KeyframeGate` in `topology/policy.ts`): a lone requester gets one at once, then one after 4 s, 8 s, then every 10 s while it keeps asking. Two or more viewers asking within 1 s mean a real upstream loss and are served at once.
- **Corroborated blame.** A child that reports a silent parent is always moved, but the complaint lowers the parent's rank only when the evidence points at the parent: the child's other stripes still arrive, or another child of that parent complained too, and the parent's own feed isn't stale. A child complaining about several parents at once has a bad downlink.

Not handled yet:
- More than `m` relays failing within one detection window: viewers fed by all of them stall until
  reattach. Pull repair (fetching missing pieces from relays outside one's own subtree) is designed
  but deferred until measurements show it's needed.

## Simulation

`npm run sim -- --peers 200 --seconds 300` runs one publisher's planner under churn with a mix of
residential uplinks: 25% at 0.5 Mbps, 35% at 2 Mbps, 25% at 8 Mbps and 15% at 30 Mbps. Viewers
stay a mean of 240 s, and the stream is 2.5 Mbps with audio (`--audio 0` drops it; the tables
below predate erasure-coded audio and were made with a whole copy of the audio on every stripe).
The simulator uses the app's own planner, planner config, stripe bitrate formula and late-parent
policy (`topology/policy.ts`), and `tests/sim.test.ts` runs a small scenario on every `npm test` to catch regressions. Peers offer slots from a noisy upload estimate,
re-measured every 10 s, and the publisher sees offers and joins `--gossip` ms late (default 500).
When a peer leaves, its subtree loses that stripe for `--repair` ms (default 2225: the app's
stripe-silence timeout, the health-check interval, the reattach batch and relinking). A viewer stalls while more than `m` of its stripes are missing.

```
k  m | p50 ms | p95 ms | max depth | stall % | stalls/hr | degraded % | parent changes/min
-----+--------+--------+-----------+---------+-----------+------------+-------------------
1  0 |    350 |    419 |         5 |   2.736 |     43.18 |       0.00 |                375
2  0 |    316 |    362 |         4 |   2.847 |     44.70 |       0.00 |                650
4  0 |    342 |    416 |         4 |   6.885 |    104.90 |       0.00 |               1108
4  1 |    337 |    391 |         5 |   0.355 |     10.79 |       0.05 |               1804
4  2 |    340 |    388 |         5 |   0.006 |      0.18 |       2.35 |               2347
8  2 |    348 |    401 |         4 |   0.221 |      4.76 |      53.76 |               2848
```

"Degraded" means some viewer's k-th best stripe passes through a parent whose children need more
than its true upload. 8+2 degrades heavily because, when these tables were made, every one of its
10 stripes carried a whole copy of the audio (then about 440 kbps a stripe; with today's 192 kbps
audio erasure coded, about 390), and most of the upload that could carry them sits with a few
strong peers that the 16-child fanout cap holds back (see below; with `--fanout 48` it is 0). Other options:
`--lifetime`, `--repair`, `--gossip`, `--fanout`, `--audio`, `--only 4:1,8:2`, and the sweeps below.

Three scenarios exercise the hardening:

```
$ npm run sim -- --sweep late --peers 100      # relays that forward 250 ms late, 4+1 stripes
late share | handled | p50 ms | p95 ms | stall %
        0% |     yes |    334 |    394 |   0.262
       10% |      no |    348 |    591 |   0.262
       10% |     yes |    340 |    576 |   0.288
       25% |      no |    494 |    650 |   0.262
       25% |     yes |    402 |    605 |   0.288

$ npm run sim -- --sweep competing --peers 60  # two publishers, everyone watches both
rebalancing | overcommitted A | overcommitted B | degraded % A | degraded % B
         no |             0.0 |           108.0 |         0.00 |        93.33
        yes |             7.4 |            39.8 |         0.00 |         0.00
```

### A lossy viewer

`npm run sim -- --sweep lossy --peers 100` adds viewers with a bad downlink (a model, see
`LossyOptions` in `sim/simulator.ts`): every 6 s on average all their stripes go silent for 1–3 s,
every 10 s a 0.1–0.4 s burst of loss hits every stripe, and each stripe also stalls on its own for
1.5–3 s every 30 s. Losing every stripe breaks the decode chain; the viewer then sends `need-key`
every 500 ms until a keyframe reaches it (400 ms after it is encoded). Lossy viewers never leave
and don't relay. It compares the **old** publisher policy (every complaint about a connected but
silent parent counts against it; any keyframe request at least 300 ms after the last one forces a
keyframe) with the **new** one (corroborated blame and `KeyframeGate`, the app's own code), and
optionally models parent GOP replay: after a break, the viewer recovers from its parents' cached
GOP with probability p and asks for no keyframe. Forced keyframes count requested ones only
(scheduled ones come every 10 s regardless). Relay failures are the planner's per-relay failure
scores (rank = slots / (1 + failures), decaying ×0.95 per replan), sampled every second over the
relays other than the lossy viewers. Changes, latency and stalls are for the other viewers.

```
lossy | policy | replay | forced keys/min | relay failures mean / max | others: changes/min | p50 ms | p95 ms | stall % | lossy frozen %
------+--------+--------+-----------------+---------------------------+---------------------+--------+--------+---------+---------------
    0 |      - |      - |               - |                         - |               736.8 |    334 |    394 |   0.262 |              -
    1 |    old |     no |            14.8 |              0.115 / 1.39 |               756.2 |    329 |    393 |   0.290 |           43.3
    1 |    new |     no |             2.0 |              0.008 / 0.95 |               735.6 |    329 |    402 |   0.282 |           77.2
    1 |    new |  p=0.7 |             2.0 |              0.006 / 0.95 |               742.4 |    331 |    382 |   0.275 |           35.0
    3 |    old |     no |            33.4 |              0.317 / 2.94 |               766.8 |    331 |    382 |   0.320 |           42.9
    3 |    new |     no |            13.0 |              0.025 / 2.21 |               799.0 |    333 |    403 |   0.309 |           61.0
    3 |    new |  p=0.7 |             5.6 |              0.032 / 2.04 |               793.2 |    333 |    384 |   0.306 |           33.1
```

One lossy viewer forced a keyframe on everyone 15 times a minute under the old policy and 2 under
the new one. Three lossy viewers sometimes ask together, which the gate serves as a real upstream
loss: 13 a minute against 33, and 6 with replay. Healthy relays' failure scores drop more than
tenfold: what remains is blame for single-stripe stalls, which do look like the parent's fault.
The price is paid by the lossy viewer alone: waiting for gated keyframes leaves it frozen far
longer (77% of the time against 43%), which parent replay wins back (35%). In this model the
other viewers' latency, stalls and parent changes barely move either way: one lossy viewer's
complaints touch only its own few parents, and planned moves are glitch-free.

## Tuning

### How much does parity buy?

`npm run sim -- --sweep parity --seconds 600` gives stall time as a % of viewing time, with stall
events per viewer-hour in parentheses:

```
k  m | overhead |         life 60s |        life 240s |        life 900s | degraded % (240s)
-----+----------+------------------+------------------+------------------+------------------
1  0 |       0% |    7.468 (118.0) |     2.574 (39.8) |      0.482 (7.7) |              0.00
2  0 |       0% |   11.897 (179.8) |     3.327 (51.6) |     1.380 (21.6) |              0.00
2  1 |      50% |     1.721 (46.0) |      0.174 (3.7) |      0.020 (1.0) |              0.06
2  2 |     100% |     0.378 (10.0) |      0.012 (0.3) |      0.000 (0.0) |             10.95
4  0 |       0% |   24.457 (349.8) |    7.009 (106.1) |     1.790 (27.5) |              0.11
4  1 |      25% |    4.731 (124.9) |     0.545 (15.0) |      0.014 (1.4) |              1.04
4  2 |      50% |     0.936 (31.5) |      0.017 (0.8) |      0.000 (0.0) |              7.47
4  3 |      75% |      0.262 (7.3) |      0.000 (0.0) |      0.000 (0.0) |             17.76
8  0 |       0% |   44.167 (554.8) |   14.243 (208.0) |     3.449 (53.6) |             41.87
8  2 |      25% |     3.116 (97.0) |      0.130 (4.4) |      0.000 (0.0) |             68.58
8  4 |      50% |      0.311 (7.4) |      0.002 (0.0) |      0.000 (0.0) |             90.29
```

Takeaways:

- **Striping without parity makes things worse.** A viewer depends on `k` parents instead of one,
  and losing any of them stalls it. At 240 s lifetimes, stall time is 2.6% for k=1, 3.3% for k=2,
  7.0% for k=4 and 14.2% for k=8.
- **The first parity stripe is the big win.** It turns a single failure from a stall into nothing.
  k=4/m=1 (25% overhead) stalls about 5× less than a single tree, and k=2/m=1 about 15× less.
- **Each further parity stripe still helps, by less.** A stall now needs `m+1` overlapping failures
  within one repair window: at 240 s lifetimes, k=4 goes 0.545% → 0.017% → 0.000% as m goes 1 → 3.
- **For the same overhead, more stripes are more resilient.** At 50% overhead, stall time is
  0.174% for 2+1, 0.017% for 4+2 and 0.002% for 8+4. The costs are more parents per viewer
  (`k+m`), more planner churn (parent changes per minute rise roughly with `k+m`), and more relays
  needed before every stripe has one.
- **Churn sets the baseline; repair time scales it.** With 60 s lifetimes, even 4+2 stalls 0.9% of
  the time. Halving repair time (`--repair 1112`) cuts stall time 1.9× with m=0 (stalls get shorter)
  and 3.5× with m=1 (overlapping failures must land in a shorter window): 0.545% → 0.157% for 4+1.
- **Parity isn't free.** Every viewer downloads `(k+m)/k` × the bitrate, and relays upload the same
  overhead. When the audience's total upload is tight, more parity means more overloaded relays.
  That shows up as "degraded": dropped enhancement frames, lower fps.

**About the "degraded" column.** Its high values for 8+m come mostly from the 16-child
`maxFanout` cap. Strong peers hit the cap long before their upload limit, so their spare capacity
goes unused, and (with the audio copied onto every stripe, as when these tables were made) more
stripes cost more. With `--fanout 48` the column is 0 for all of these. Bigger subtrees have a cost, though: each departure affects more
viewers (4+2 and 8+2 stall more).

```
                fanout 16                     fanout 48
k  m | stall % | degraded % | p50 ms    stall % | degraded % | p50 ms
4  2 |   0.006 |       2.35 |    340      0.558 |       0.00 |    330
4  3 |   0.000 |       7.91 |    334      0.004 |       0.00 |    345
8  2 |   0.221 |      53.76 |    348      0.531 |       0.00 |    334
8  4 |   0.004 |      85.60 |    350      0.007 |       0.00 |    344
```

### Recommendations

| Situation | Setting | Why |
|---|---|---|
| Small audience (fewer than about 6 capable relays) | `k=2, m=1` | Only 3 stripes need relays; one failure is invisible |
| General use (the default) | `k=4, m=2` | 50% overhead; stalls become rare (≈1 per viewer-hour at 240 s lifetimes) and one bad relay is invisible even mid-repair. Small lobbies stay cheap: relays take on the stripes nobody else relays |
| Tight upload all round | `k=4, m=1` | 25% overhead, about 6× fewer stalls than a single tree, ~320 ms latency |
| Upload-starved audience | `k=1, m=0` or `k=4, m=1` with a lower bitrate | Parity overhead competes with capacity you don't have |
| Large audience with strong uplinks | `k=8, m=2..4` with a higher `maxFanout` | Most resilient per byte of overhead; needs many relays |

### Quality versus latency

`src/tuning.ts` holds every knob that trades delay for smooth, complete frames. The default
**quality** profile suits screen sharing; `?priority=latency` picks the low-latency one.

| Knob | Quality (default) | Latency | Why |
|---|---|---|---|
| Uplink deadlines T0 / T1 / T2+ | 2500 / 1500 / 800 ms | 900 / 350 / 180 ms | Bursts drain from the queue instead of costing frames |
| Keyframe / replay deadline | 4 s | 2 / 2.5 s | Keyframes and GOP replays survive overload |
| Jitter buffer | 99th percentile + 120 ms, ≥ 150 ms | 95th percentile + 40 ms, ≥ 30 ms | Far fewer late or skipped frames on jittery paths |
| Jitter buffer memory | a spike's buffer is kept 60 s, then shrinks ≤ 8 ms/s; for the first 30 s of playback none is kept and it shrinks ≤ 250 ms/s | 5 s, then ≤ 250 ms/s | Periodic hiccups don't stall each time; shrinking slower than audio's 1% catch-up keeps sound gapless. A join's own burst isn't a hiccup: held, a 3 s one took 6 minutes to go |
| Media channel retransmits | up to 3 s | up to 1 s | Lost packets are re-sent instead of lost |
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
- **Rate control.** <a id="rate-control"></a>One measured quantity, the rate each connection
  delivered, replaces inferring "full" from proxies (`session/capacity.ts`, pure):
  - *Windows.* Every 2 s, per connection (a mesh link or a lane): delivered = bytes handed to its
    channels (media and `bin`) minus the growth of their `bufferedAmount`, per second. The window
    is *backlogged* if the connection's uplink queue held something for ≥ 90% of it (data waits
    in the app only while the 64 KiB send buffer is full) and live media queued 150 ms on average
    or was dropped (`CONGESTED_QUEUE_MS`: a queue that is merely never empty is a busy link, not a
    full one, and measuring it as capacity spiralled the bitrate down to the floor), *stalled* if the connection stalled in
    it (`STALL_MS`, below), and the whole window is ignored if the page *froze* (the main thread
    lagged ≥ 400 ms: what queued then is this computer's doing).
  - *Uplink capacity* (what a peer gossips as `capacityKbps`): the most delivered in total over
    the last 10 s in windows where most active connections were backlogged at once, with no
    stall. Between such windows it holds; any window raises it to at least what was delivered; a
    backlogged window queueing over 1 s sets it at once (no max filter). Until one comes it is
    unknown, and the bitrate stays at the chosen quality.
  - *Connection capacity*: the same max filter over windows in which the connection was
    backlogged while most were not (it alone was the bottleneck: a slow receiver, one SCTP
    congestion window); such a connection is a *limit*. When most are backlogged together, each
    one's share only says how the uplink was split, so it only raises the estimate. A peer's
    capacity is the sum over its connections.
  - *Headroom discovery*, the only probing (`session/headroom.ts`): once 1 s after the first link
    opens (10 s for a peer not presenting: it only sizes relay offers, and probing during its join
    saturated its uplink just as its stream arrived), then every 30 s (5 s while a capacity
    estimate holds the bitrate below the chosen quality and the encoder uses at least 70% of it)
    while no media connection is backlogged, the uplink's background slot
    pushes bytes onto every open connection's `bin` channel for 1.5 s (64 KB buffered at most per
    channel, refilled from buffer-low events, so it measures in a hidden tab too; a starved probe
    is discarded), after all live media. Those windows count as backlogged. Nobody replies: the
    receiver drops the bytes.
  - *Bitrate* (`session/congestion.ts`, pure): the wire budget per direct child is the smaller of
    the uplink's capacity divided by the direct children ((child, stripe) edges / stripes) and the
    median capacity of the peers fed directly (only those that are a limit; one fed some stripes
    counts its capacity × stripes / those stripes; of two, the larger), so one slow viewer
    doesn't throttle the rest: its own link sheds enhancement layers and its Auto quality can
    fall back to the preview. The target is 85% of the video bitrate that budget carries (the
    stripe overhead of `stripeKbpsFor`), never above the chosen quality or what the audience's
    relay slots carry. Down at once (at most every 4 s), up by at most 25% per 10 s, changes
    under 5% ignored. On loopback the probe measures 100–300 Mbps and a 16 or 20 Mbps stream
    keeps its chosen bitrate; under the `up=` debug cap (the token bucket backs up every queue at once)
    it settles at 85% of what the cap carries per child.
  - *Stalls.* A connection whose send buffer stopped draining for 750 ms (`STALL_MS` in
    `net/uplink.ts`) is an SCTP association stuck in loss recovery by retransmission timeout
    (≥ ~400 ms, doubling), typically after a burst overflowed the connection's 64 KB UDP socket
    buffer in Chromium; the whole association delivers nothing meanwhile. Its stripes, and what
    already waits for it, move to another of the pair's connections until it drains again
    (`RelayNode.linkFor`), and its windows say nothing about capacity (the Peers panel and Stats
    mark it *stalled*). Media channels buffer at most 64 KiB (`LINK_BUFFER_HIGH`) so bursts stay
    small enough not to cause such stalls (`e2e/diag-sctp.spec.ts` measures it).
  - Path RTTs (below) are shown, never used for decisions. Changes apply in place, with no new
    capture. Topology shows each directly fed viewer's link from the presenter (drops, queueing,
    what it carries), so a slow peer is easy to spot.
- **Per-link stats.** <a id="per-link-stats"></a>Every 2 s each peer calls `getStats()` on every
  connection (mesh links and lanes) and keeps, per connection, the selected candidate pair's RTT
  (the average of the STUN round trips since the last poll), its 2-minute minimum as the
  baseline, wire send and receive rates, and whether the pair is relayed by TURN
  (`net/linkStats.ts`, pure; Chrome names the pair from `transport.selectedCandidatePairId`,
  Firefox flags it `selected`). An RTT that hasn't refreshed for 8 s is stale. Measured in
  Chromium 150 (`e2e/linkstats.spec.ts`): the pair's RTT refreshes every ~2.6 s (faster just after
  connecting), there is **no `sctp-transport` report** (so no SCTP congestion window) and no
  `availableOutgoingBitrate` on a data-only connection; both are parsed and shown if a browser
  adds them. The **Peers** panel shows, per peer, live **Sending** and **Receiving** rates (on the
  wire, all connections), **RTT now / base** (with "+N ms" when the path queues), what your connections to it
  **Carry** ("limit" when they were its bottleneck), and its gossiped **Est. upload** as a
  secondary column (its measured capacity, not current use); expanding a peer lists each
  connection: send/receive rate, RTT now / baseline, live-media queueing and drops/s, delivered
  rate and capacity, stalled, relayed, and the congestion window where available.
  `window.__p2p.linkStatsFor(peerId)` and `window.__p2p.peerCapacity(peerId)` expose the same
  for e2e.
- **Why it's clamped.** The presenter bar (while below the chosen quality) and Stats say what
  sets the bitrate in plain words: "limited by your upload: ~X Mbps", "limited by viewers'
  connections: median ~Y Mbps", "limited by audience relay capacity" or "at chosen quality", and
  how many connections stalled. A lower quality level or fewer parity stripes then usually looks
  sharper than a starved stream.

Every place a frame can go missing is counted and shown in **Stats** (and per viewer in
**Topology**): frames dropped by the encoder, uplink fragments dropped by temporal layer and
queueing delay, and frames a viewer received incomplete, late, undecodable or skipped.

### Knobs

| Knob | Where | Default | Effect |
|---|---|---|---|
| `k`, `m` | Share dialog (Advanced) | 4, 1 | See above |
| Video quality | Share dialog, presenter bar | 1080p30 Standard (5 Mbps), lowers automatically | Lower bitrate → more relay slots per peer → shallower, more robust trees |
| `HEADROOM` | `session/capacity.ts` | 0.75 | Share of measured upload a peer offers. Lower is safer against bad estimates and leaves room for keyframe bursts. |
| `MAX_FANOUT` | `session/capacity.ts` | 16 | Children per relay. Higher uses strong peers fully but enlarges each failure's blast radius. |
| `MIN_UPTIME_MS_FOR_RELAY` | `topology/policy.ts` | 4000 | Newcomers stay leaves this long. Raising it filters out viewers who join briefly and leave, at the cost of slower ramp-up. |
| `SWITCH_GAIN`, `RTT_SWITCH_MS` | `topology/policy.ts` | 1, 40 | How many levels shallower (or ms closer) a parent must be before a peer is moved. Higher means less churn. |
| `stripeSilenceMs` | `tuning.ts` | 1500 (quality), 1000 (latency) | Failure detection time, which dominates `m=0` recovery. Lower recovers faster but risks false alarms on jittery links. |
| `REATTACH_BATCH_MS` | `topology/policy.ts` | 400 | Collateral-blame window: reattach requests collected this long are handled shallowest-first |
| `LATE_PARENT_MS`, `LATE_PARENT_FOR_MS`, `LATE_PARENT_AVOID_MS` | `topology/policy.ts` | 150, 10000, 30000 | How late, for how long, a parent may be before its children avoid it, and for how long |
| `LIVENESS_TIMEOUT_MS` | `session/channelPublisher.ts` | 1200 | The dead-parent confirmation timeout |
| `SUSPECT_MS`, `GONE_MS` | `mesh/mesh.ts` | 1500, 6000 | When a silent link is taken out of the trees, and when a silent peer is declared gone |
| `keyframeIntervalMs` | `tuning.ts` | 10000 (quality), 2000 (latency) | Shorter means faster joins and smaller GOP caches, but more bits spent on keyframes |
| `maxAgeByLayer`, `keyMaxAgeMs`, `replayMaxAgeMs`, `playout*`, `mediaMaxPacketLifeTimeMs` | `tuning.ts` | see the table above | Uplink layer deadlines, jitter buffer and retransmits: latency vs complete, smooth frames |
| `CAPACITY_WINDOW_MS`, `FAST_DROP_QUEUE_MS`, `BACKLOGGED_SHARE`, `FROZEN_LAG_MS` | `session/capacity.ts` | 10 s, 1 s, 90%, 400 ms | Capacity memory, when a backlog sets it at once, what counts as backlogged, and when a window is the page's fault |
| `TARGET_SHARE`, `DOWN_GAP_MS`, `UP_GAP_MS`, `UP_STEP`, `DEADBAND` | `session/congestion.ts` | 0.85, 4 s, 10 s, 1.25, 5% | Share of the measured budget used, and how fast the bitrate follows it |
| `HEADROOM_EVERY_MS`, `PROBE_DURATION_MS` | `session/peerSession.ts`, `session/headroom.ts` | 30 s, 1.5 s | How often (while nothing is backlogged) and how long the headroom probe pushes background bytes |

## Tests

```sh
npm test                    # unit tests (vitest), see below
npm run check               # svelte-check + tsc (app, vite config, and tests/sim/tools/e2e)
npm run e2e                 # Playwright: local tracker + dev server + several browser contexts
```

The unit tests (`tests/`) cover:
- media and wire format: framing, FEC, reassembly, the jitter buffer, the uplink queue, message
  validation
- trees and sessions: the planner, capacity and budget splits, relaying, subscriptions, stage
  selection, channel ownership, the headroom probe
- the mesh and security: gossip and failure detection, lobby codes, publish rights, fragment
  signing
- per-link stats: parsing Chrome and Firefox `getStats()` shapes, RTT baseline and staleness,
  path inflation (display); stall detection and rerouting
- rate control: delivered rate from counters and `bufferedAmount`, the max filter (exclusions,
  fast drop), uplink capacity from windows where most connections are backlogged, the bitrate
  function and its pacing, and a link simulation driving estimator and controller end to end
  (a fixed-capacity link, a shared uplink, one or all viewers slow, stalls, a frozen page, capacity
  rising and falling, the audience cap)
- the UI's pure logic: routes and URL parameters, stored settings, share options and stage
  messages, live rate formatting

The e2e suite covers:
- hardening: auto quality lowers the bitrate for an audience that can't carry the stream; a kicked
  member stays out after a reload; one slow viewer doesn't throttle the stream (its link is
  measured as its own limit), but capping the presenter's upload settles the bitrate under the cap
- link stats: a real connection's `getStats()` (fields, RTT refresh cadence), the per-link stats,
  the presenter's live upload figure, the Peers panel's live rates and lanes, the viewer's live
  receive rate
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

Opt-in diagnostics (skipped unless `E2E_DIAG=1`): `e2e/diag-congestion.spec.ts` streams from a
presenter to one viewer on this machine with no upload cap, at a quality preset (`DIAG_PRESET`:
`ultra`, `hi`, `4k`, `auto`) and a test pattern that keeps the encoder at its full bitrate
(`pattern=busy`, or `bursty` for a mostly still screen), and prints a per-second timeline of what
rate control sees and does (bitrate and what limits it, uplink and peer capacity, per-lane
delivered rate, backlog and stalls, queueing, drops, send buffers, `packetsDiscardedOnSend`, path
RTTs, headroom probes, main-thread lag on both pages); `DIAG_STALL=lane,ms,every` emulates SCTP
association stalls, `DIAG_BLOCK=ms,every` a busy main thread and `DIAG_UP=kbps` caps the
presenter's upload. `tools/diag-tabs.ts` runs the same with the presenter's (or viewer's) tab really in the
background (raw CDP under a display, e.g. `xvfb-run`: Playwright keeps every page visible).
`e2e/diag-sctp.spec.ts` measures whether a deep send buffer stalls a bare SCTP association.

`up=<kbps>` shapes a page's real uplink (publisher included), so e2e scenarios must be feasible:
the publisher only plans its own budget, but an overcommitted plan genuinely queues. On a slow
machine, relax the performance thresholds with `E2E_MIN_FPS` (default 15), `E2E_MIN_FAILOVER_FPS`
(10) and `E2E_MAX_LATENCY_MS` (1500).

Where Playwright's bundled browser doesn't run, set `CHROMIUM_PATH` to a system Chromium (or
Chrome) binary and the e2e suite launches that instead.

**NixOS / ARM64 VMs.** Playwright's bundled browser needs FHS libraries, so point
`CHROMIUM_PATH` at a system Chromium. Some ARM64 VMs (Apple Virtualization) advertise SME but trap SME instructions. That
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
  element.  Testing so far is mostly headless Chromium.
- **Tracker reliability.** Public trackers are flaky. Self-host one with `npm run tracker` (it's
  `bittorrent-tracker`) behind TLS for real use.
