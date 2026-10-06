import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { packetize } from '../src/media/packetizer'
import type { Mesh } from '../src/mesh/mesh'
import type { ChannelAnnouncement } from '../src/mesh/records'
import { decodeFragment, NO_REF, withReplayFlag } from '../src/proto/framing'
import type { PeerMsg, SubscriberMsg } from '../src/proto/messages'
import { treeKey, type RelayNode } from '../src/relay/relayNode'
import { GOP_REPLAY_TIMEOUT_MS, STRIPE_SILENCE_MS, Subscription, type SubscriptionContext } from '../src/session/subscription'

// The ticker falls back to plain setInterval without workers; fake timers must be in place before
// its first use and stay for the whole file (it starts once per module instance).
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
  vi.advanceTimersByTime(10_000) // the key-request throttle measures from time 0
  // The player schedules rendering on animation frames.
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  // Just enough WebCodecs for the player to feed frames to a decoder.
  vi.stubGlobal(
    'VideoDecoder',
    class {
      state = 'unconfigured'
      configure() {
        this.state = 'configured'
      }
      decode() {
        decodes++
      }
      close() {
        this.state = 'closed'
      }
    },
  )
  vi.stubGlobal('EncodedVideoChunk', class {})
})
afterAll(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const CH = 0x1234
const PUB = 'pub'

const ann: ChannelAnnouncement = {
  id: CH,
  kind: 'full',
  k: 2,
  m: 1,
  kbps: 1000,
  stripeKbps: 500,
  stream: null,
  deficit: 0,
  startedAt: 0,
}

let sent: SubscriberMsg[]
/** Messages to stripe parents (anyone but the publisher). */
let toParents: { to: string; m: PeerMsg }[]
let decodes = 0
let open: Set<string>
let connecting: Set<string>
let relay: {
  lastRecv: Map<string, number>
  addChild: ReturnType<typeof vi.fn>
  removeChild: ReturnType<typeof vi.fn>
  dropChannel: ReturnType<typeof vi.fn>
  expectReplay: ReturnType<typeof vi.fn>
  allChildren: () => Set<string>
}

function makeSub(): Subscription {
  const mesh = {
    sendApp: (to: string, m: SubscriberMsg) => {
      if (to === PUB) sent.push(m)
      else toParents.push({ to, m })
      return true
    },
    linkFor: (id: string) => (open.has(id) && id !== PUB ? { rttMs: 10 } : undefined),
    linkStatus: (id: string) => (connecting.has(id) ? 'connecting' : open.has(id) ? 'open' : 'none'),
  }
  const ctx: SubscriptionContext = {
    selfId: 'me',
    mesh: mesh as unknown as Mesh,
    relay: relay as unknown as RelayNode,
    capKbps: null,
    capacityKbps: () => null,
    uplinkSample: () => ({ kbps: 0, dropRate: 0 }),
    uplinkRates: () => null,
    onChange: () => {},
  }
  return new Subscription(CH, PUB, ann, ctx)
}

const ofType = <T extends SubscriberMsg['t']>(t: T) => sent.filter((m): m is Extract<SubscriberMsg, { t: T }> => m.t === t)

/** One fragment of a video frame on `stripe` (as replayed from a GOP cache if `replay`). */
function fragment(seq: number, stripe: number, replay = false) {
  const stripes = packetize(
    { epoch: 1, seq, gopId: 0, refSeq: seq === 0 ? NO_REF : seq - 1, key: seq === 0, layer: 0, audio: false, captureTime: 1000 + seq, data: new Uint8Array(300).fill(seq) },
    ann.k,
    ann.m,
    CH,
  )
  const raw = stripes[stripe][0]
  return decodeFragment(replay ? withReplayFlag(raw) : raw)!
}

beforeEach(() => {
  sent = []
  toParents = []
  decodes = 0
  open = new Set(['p1', 'p2'])
  connecting = new Set()
  relay = { lastRecv: new Map(), addChild: vi.fn(), removeChild: vi.fn(), dropChannel: vi.fn(), expectReplay: vi.fn(), allChildren: () => new Set() }
})

describe('Subscription', () => {
  it('subscribes on start and confirms a new parent on its first fragment', () => {
    const sub = makeSub()
    expect(ofType('subscribe')).toHaveLength(1)
    sub.handle({ t: 'set-parent', ch: CH, stripe: 1, parent: 'p1' })
    expect(sub.parents).toEqual([null, 'p1', null])
    sub.onFragment(fragment(0, 1), 'p2') // not the parent we were told about
    expect(ofType('stripe-ok')).toHaveLength(0)
    sub.onFragment(fragment(1, 1), 'p1')
    sub.onFragment(fragment(2, 1), 'p1')
    expect(ofType('stripe-ok')).toEqual([{ t: 'stripe-ok', ch: CH, stripe: 1, parent: 'p1' }])
    sub.close()
  })

  it('asks for a new parent when a stripe goes silent, with grace and cooldown', () => {
    const sub = makeSub()
    sub.handle({ t: 'set-parent', ch: CH, stripe: 0, parent: 'p1' })
    sub.handle({ t: 'set-parent', ch: CH, stripe: 1, parent: 'p2' })
    const key0 = treeKey(CH, 0)
    const key1 = treeKey(CH, 1)
    // Stripe 1 keeps receiving; stripe 0 never does.
    const feed = vi.fn(() => relay.lastRecv.set(key1, performance.now()))
    const stopFeed = setInterval(feed, 100)
    vi.advanceTimersByTime(2500) // within the parent's grace period
    expect(ofType('reattach')).toHaveLength(0)
    vi.advanceTimersByTime(1000)
    expect(ofType('reattach')).toEqual([{ t: 'reattach', ch: CH, stripe: 0, linkOpen: true }])
    // Cooldown before asking again.
    vi.advanceTimersByTime(3000)
    expect(ofType('reattach')).toHaveLength(1)
    vi.advanceTimersByTime(1500)
    expect(ofType('reattach')).toHaveLength(2)
    expect(ofType('reattach').every((m) => m.stripe === 0)).toBe(true)

    // Stripe 0 comes back, then falls silent again for STRIPE_SILENCE_MS.
    sent = []
    relay.lastRecv.set(key0, performance.now())
    vi.advanceTimersByTime(STRIPE_SILENCE_MS - 100)
    expect(ofType('reattach')).toHaveLength(0)
    vi.advanceTimersByTime(4000)
    expect(ofType('reattach').length).toBeGreaterThanOrEqual(1)
    clearInterval(stopFeed)
    sub.close()
  })

  it('gives a still-connecting parent link more time and reports a missing link', () => {
    const sub = makeSub()
    connecting.add('p3')
    sub.handle({ t: 'set-parent', ch: CH, stripe: 2, parent: 'p3' })
    vi.advanceTimersByTime(5000)
    expect(ofType('reattach')).toHaveLength(0)
    vi.advanceTimersByTime(3500)
    expect(ofType('reattach')).toEqual([{ t: 'reattach', ch: CH, stripe: 2, linkOpen: false }])
    sub.close()
  })

  it('measures how far each stripe lags the first stripe of a frame', () => {
    const sub = makeSub()
    sub.onFragment(fragment(5, 0), 'p1')
    vi.advanceTimersByTime(40)
    sub.onFragment(fragment(5, 2), 'p2')
    vi.advanceTimersByTime(10)
    sub.onFragment(fragment(5, 1), 'p1')
    expect(sub.lateMs).toEqual([0, 50, 40])
    // Smoothed: a later frame with stripe 1 on time pulls its lateness down by a tenth.
    sub.onFragment(fragment(6, 1), 'p1')
    sub.onFragment(fragment(6, 0), 'p1')
    expect(sub.lateMs[1]).toBeCloseTo(45, 6)
    expect(sub.lateMs[0]).toBe(0)
    // Duplicate fragments of a stripe don't count again.
    vi.advanceTimersByTime(100)
    sub.onFragment(fragment(6, 1), 'p1')
    expect(sub.lateMs[1]).toBeCloseTo(45, 6)
    expect(sub.stats.stripes.map((s) => s.lateMs)).toEqual([0, 45, 40])
    sub.close()
  })

  it('throttles keyframe requests', () => {
    const sub = makeSub()
    sub.player.scheduler.reset()
    sub.player.scheduler.reset()
    expect(ofType('need-key')).toHaveLength(1)
    vi.advanceTimersByTime(499)
    sub.player.scheduler.reset()
    expect(ofType('need-key')).toHaveLength(1)
    vi.advanceTimersByTime(1)
    sub.player.scheduler.reset()
    expect(ofType('need-key')).toHaveLength(2)
    sub.close()
  })

  /** A subscription decoding frames 0..2 from parents p1 (stripes 0, 1) and p2 (stripe 2). */
  function decoding(): Subscription {
    const sub = makeSub()
    sub.handle({ t: 'set-parent', ch: CH, stripe: 0, parent: 'p1' })
    sub.handle({ t: 'set-parent', ch: CH, stripe: 1, parent: 'p1' })
    sub.handle({ t: 'set-parent', ch: CH, stripe: 2, parent: 'p2' })
    sub.player.setStreamInfo({ epoch: 1, codec: 'vp8', codedWidth: 16, codedHeight: 16 })
    for (const seq of [0, 1, 2]) for (const stripe of [0, 1]) sub.onFragment(fragment(seq, stripe), 'p1')
    expect(decodes).toBe(3)
    expect(sub.player.scheduler.waitingForKeyframe).toBe(false)
    vi.advanceTimersByTime(3000) // past earlier tests' replay requests
    return sub
  }

  it('on a broken decode chain asks the stripe parents to replay their GOP before the publisher', () => {
    const sub = decoding()
    sub.player.scheduler.requireKeyframe()
    expect(toParents).toEqual([
      { to: 'p1', m: { t: 'need-gop', ch: CH, stripes: [0, 1] } },
      { to: 'p2', m: { t: 'need-gop', ch: CH, stripes: [2] } },
    ])
    expect(relay.expectReplay).toHaveBeenCalledWith(CH, [0, 1, 2])
    expect(ofType('need-key')).toHaveLength(0)
    // Nothing came: the publisher is asked for a keyframe after the timeout, once.
    vi.advanceTimersByTime(GOP_REPLAY_TIMEOUT_MS - 100)
    expect(ofType('need-key')).toHaveLength(0)
    vi.advanceTimersByTime(200)
    expect(ofType('need-key')).toEqual([{ t: 'need-key', ch: CH }])
    // Further breaks soon after don't ask the parents again but do re-arm the fallback.
    sub.player.scheduler.reset()
    expect(toParents).toHaveLength(2)
    vi.advanceTimersByTime(GOP_REPLAY_TIMEOUT_MS + 100)
    expect(ofType('need-key')).toHaveLength(2)
    sub.close()
  })

  it('a replayed GOP repairs the chain, even from frames already decoded, and no keyframe is requested', () => {
    const sub = decoding()
    // Without having asked, replayed repeats of decoded frames are ignored (e.g. a new parent's).
    for (const seq of [0, 1, 2]) for (const stripe of [0, 2]) sub.onFragment(fragment(seq, stripe, true), 'p1')
    expect(decodes).toBe(3)
    sub.player.scheduler.requireKeyframe()
    expect(toParents).toHaveLength(2)
    // The parents' replays (keyframe 0 onwards, plus the lost frame 3) restart decoding from the
    // keyframe, although its fragments were all seen before.
    for (const seq of [0, 1, 2, 3]) for (const stripe of [0, 2]) sub.onFragment(fragment(seq, stripe, true), stripe === 0 ? 'p1' : 'p2')
    expect(sub.player.scheduler.waitingForKeyframe).toBe(false)
    expect(decodes).toBe(3 + 4)
    vi.advanceTimersByTime(GOP_REPLAY_TIMEOUT_MS * 2)
    expect(ofType('need-key')).toHaveLength(0)
    expect(sub.player.stats.late).toBe(0)
    sub.close()
  })

  it('asks the publisher directly when there are no parents to ask', () => {
    const sub = makeSub()
    vi.advanceTimersByTime(3000)
    sub.player.scheduler.reset()
    expect(toParents).toEqual([])
    expect(ofType('need-key')).toHaveLength(1)
    sub.close()
  })

  it('sends stats periodically and stops everything on close', () => {
    const sub = makeSub()
    sub.handle({ t: 'set-parent', ch: CH, stripe: 0, parent: 'p1' })
    vi.advanceTimersByTime(2100)
    expect(ofType('stats').length).toBeGreaterThanOrEqual(1)
    sub.close()
    expect(ofType('unsubscribe')).toEqual([{ t: 'unsubscribe', ch: CH }])
    expect(relay.dropChannel).toHaveBeenCalledWith(CH)
    sent = []
    vi.advanceTimersByTime(30_000)
    expect(sent).toEqual([])
    sub.subscribe()
    sub.close()
    expect(sent).toEqual([])
    expect(relay.dropChannel).toHaveBeenCalledTimes(1)
  })
})
