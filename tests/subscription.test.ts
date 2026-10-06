import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { packetize } from '../src/media/packetizer'
import type { Mesh } from '../src/mesh/mesh'
import type { ChannelAnnouncement } from '../src/mesh/records'
import { decodeFragment, NO_REF } from '../src/proto/framing'
import type { SubscriberMsg } from '../src/proto/messages'
import { treeKey, type RelayNode } from '../src/relay/relayNode'
import { STRIPE_SILENCE_MS, Subscription, type SubscriptionContext } from '../src/session/subscription'

// The ticker falls back to plain setInterval without workers; fake timers must be in place before
// its first use and stay for the whole file (it starts once per module instance).
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
  vi.advanceTimersByTime(10_000) // the key-request throttle measures from time 0
  // The player schedules rendering on animation frames.
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
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
let open: Set<string>
let connecting: Set<string>
let relay: { lastRecv: Map<string, number>; addChild: ReturnType<typeof vi.fn>; removeChild: ReturnType<typeof vi.fn>; dropChannel: ReturnType<typeof vi.fn>; allChildren: () => Set<string> }

function makeSub(): Subscription {
  const mesh = {
    sendApp: (to: string, m: SubscriberMsg) => {
      expect(to).toBe(PUB)
      sent.push(m)
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

/** One fragment of a video frame on `stripe`. */
function fragment(seq: number, stripe: number) {
  const stripes = packetize(
    { epoch: 1, seq, gopId: 0, refSeq: seq === 0 ? NO_REF : seq - 1, key: seq === 0, layer: 0, audio: false, captureTime: 1000 + seq, data: new Uint8Array(300).fill(seq) },
    ann.k,
    ann.m,
    CH,
  )
  return decodeFragment(stripes[stripe][0])!
}

beforeEach(() => {
  sent = []
  open = new Set(['p1', 'p2'])
  connecting = new Set()
  relay = { lastRecv: new Map(), addChild: vi.fn(), removeChild: vi.fn(), dropChannel: vi.fn(), allChildren: () => new Set() }
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
