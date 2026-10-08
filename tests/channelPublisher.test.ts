// ChannelPublisher's planning and failure-handling policy, driven through handle() with a fake
// session: a stub mesh (members, links, offers, RTTs), a stub relay, and a log of the commands it
// sends. Time is faked (timers, Date, performance) and the ticker restarts on it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mesh } from '../src/mesh/mesh'
import type { MemberRecord } from '../src/mesh/records'
import { gunzip } from '../src/mesh/envelope'
import { fromBase64Url } from '../src/net/lobby'
import { resetTicker } from '../src/net/ticker'
import type { PublisherMsg, StripeStat, SubscriberMsg, SubscriberStats, TopologyReport } from '../src/proto/messages'
import type { RelayNode } from '../src/relay/relayNode'
import { ChannelPublisher, type PublisherContext } from '../src/session/channelPublisher'
import { LATE_PARENT_AVOID_MS, MIN_UPTIME_MS_FOR_RELAY, REATTACH_BATCH_MS } from '../src/topology/policy'

const HOST = 'host'
const CH = 7

/** The parts of the mesh ChannelPublisher uses. */
class FakeMesh {
  readonly selfId = HOST
  members = new Map<string, Pick<MemberRecord, 'offers' | 'rtt' | 'unreachable' | 'links'>>()
  /** Peers with an open direct link to the publisher. */
  direct = new Set<string>()
  /** Pairs (a|b, sorted) whose mesh link is down. */
  unlinked = new Set<string>()
  suspected = new Set<string>()
  /** Peers that don't answer a liveness ping. */
  silent = new Set<string>()
  pings: string[] = []
  sent: { to: string; msg: PublisherMsg }[] = []
  record = { unreachable: [] as string[] }

  member(id: string) {
    return this.members.get(id)
  }
  linked(a: string, b: string): boolean {
    if (a === HOST) return this.direct.has(b)
    if (b === HOST) return this.direct.has(a)
    return !this.unlinked.has([a, b].sort().join('|'))
  }
  linkFor(id: string) {
    if (!this.direct.has(id)) return undefined
    return {
      ping: (ms: number) => {
        this.pings.push(id)
        return this.silent.has(id) ? new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)) : Promise.resolve(1)
      },
    }
  }
  isSuspected(id: string): boolean {
    return this.suspected.has(id)
  }
  sendApp(to: string, msg: unknown): boolean {
    this.sent.push({ to, msg: msg as PublisherMsg })
    return true
  }
  /** Adds a member with an open link to the publisher. */
  add(id: string, slots = 0): void {
    this.members.set(id, { offers: { [CH]: slots }, rtt: {}, unreachable: [], links: [] })
    this.direct.add(id)
  }
  setSlots(id: string, slots: number): void {
    this.members.get(id)!.offers[CH] = slots
  }
}

/** The relay's channel-level calls, logged. */
class FakeRelay {
  log: string[] = []
  children = new Map<number, Set<string>>()
  addChild(ch: number, stripe: number, child: string): void {
    this.log.push(`add ${ch}/${stripe} ${child}`)
    if (!this.children.has(stripe)) this.children.set(stripe, new Set())
    this.children.get(stripe)!.add(child)
  }
  removeChild(ch: number, stripe: number, child: string): void {
    this.log.push(`remove ${ch}/${stripe} ${child}`)
    this.children.get(stripe)?.delete(child)
  }
  removePeer(id: string, ch: number): void {
    this.log.push(`removePeer ${ch} ${id}`)
    for (const set of this.children.values()) set.delete(id)
  }
  dropChannel(ch: number): void {
    this.log.push(`drop ${ch}`)
  }
  inject(): void {}
}

interface Harness {
  mesh: FakeMesh
  relay: FakeRelay
  cp: ChannelPublisher
  keyframes: number
  changes: number
  announces: number
  /** The publisher's root slots (changeable). */
  rootSlots: number
}

let h: Harness

/** A channel of k + m stripes with `rootSlots` publisher slots. */
function setup(k: number, m: number, rootSlots: number, kbps = 2000): Harness {
  h?.cp.stop()
  const mesh = new FakeMesh()
  const relay = new FakeRelay()
  const out = { mesh, relay, keyframes: 0, changes: 0, announces: 0, rootSlots } as Harness
  const ctx: PublisherContext = {
    selfId: HOST,
    mesh: mesh as unknown as Mesh,
    relay: relay as unknown as RelayNode,
    signingKey: null as unknown as CryptoKey,
    rootSlots: () => out.rootSlots,
    announce: () => void out.announces++,
    publisherStats: () => ({ encoder: null, uplink: null }),
    linkRate: () => null,
    onChange: () => void out.changes++,
  }
  out.cp = new ChannelPublisher(CH, 'full', k, m, kbps, false, ctx, () => void out.keyframes++)
  h = out
  return out
}

const send = (from: string, msg: SubscriberMsg) => h.cp.handle(msg, from)

/** Moves fake time forward, letting promise callbacks (pings, gzip) run in between. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** Members join (with `slots` relay slots each) and subscribe, one ms apart. */
async function join(ids: string[], slots = 0): Promise<void> {
  for (const id of ids) {
    h.mesh.add(id, slots)
    send(id, { t: 'subscribe', ch: CH })
    await advance(1)
  }
}

/** Subscribes, then waits until everyone may relay and the plan settled. */
async function settledTree(ids: string[], slots: Record<string, number>): Promise<void> {
  for (const id of ids) await join([id], slots[id] ?? 0)
  await advance(MIN_UPTIME_MS_FOR_RELAY + 2 * 2000 + 100)
}

const parentOf = (id: string, stripe: number) => h.cp.topology.parents[id]?.[stripe] ?? null
const childrenOf = (id: string, stripe: number) =>
  Object.entries(h.cp.topology.parents)
    .filter(([, ps]) => ps[stripe] === id)
    .map(([c]) => c)
    .sort()
const sentTo = (id: string, t?: PublisherMsg['t']) => h.mesh.sent.filter((s) => s.to === id && (!t || s.msg.t === t)).map((s) => s.msg)
const failures = (id: string) => h.cp.subscribers.get(id)!.failures
const avoids = (id: string) => [...h.cp.subscribers.get(id)!.avoid.keys()]

function stripe(parent: string | null, lastRecvAgoMs: number | null, lateMs = 0): StripeStat {
  return { parent, lastRecvAgoMs, rttMs: 20, lateMs }
}

function stats(stripes: StripeStat[]): SubscriberStats {
  return {
    capKbps: null,
    capacityKbps: null,
    uplinkKbps: 0,
    uplinkDropRate: 0,
    stripes,
    children: 0,
    latencyMs: null,
    bufferMs: 0,
    fps: 30,
    decodedFrames: 0,
    droppedFrames: 0,
    waitingForKeyframe: false,
  }
}

/** A subscriber reports its stripes as its current parents give them: fresh, except `stale`. */
function report(id: string, opts: { stale?: number[]; lateMs?: Record<number, number> } = {}): void {
  const n = h.cp.stripes
  const st = [...Array(n).keys()].map((s) => stripe(parentOf(id, s), opts.stale?.includes(s) ? 5000 : 100, opts.lateMs?.[s] ?? 0))
  send(id, { t: 'stats', ch: CH, stats: stats(st) })
}

beforeEach(() => {
  h = undefined as unknown as Harness
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'], now: Date.UTC(2026, 0, 1) })
  resetTicker()
})

afterEach(() => {
  h?.cp.stop()
  resetTicker()
  vi.useRealTimers()
})

/** Whether `parent` currently feeds `child` on `stripe`, from the commands sent so far. */
function hasEdge(parent: string, child: string, s: number): boolean {
  if (parent === HOST) return !!h.relay.children.get(s)?.has(child)
  let on = false
  for (const m of sentTo(parent)) {
    if ((m.t === 'add-child' || m.t === 'remove-child') && m.ch === CH && m.stripe === s && m.child === child) on = m.t === 'add-child'
  }
  return on
}

/** The parent named in the last set-parent a peer got for a stripe. */
function toldParent(id: string, s: number): string | null | undefined {
  const msgs = sentTo(id, 'set-parent').filter((m) => m.t === 'set-parent' && m.stripe === s)
  const last = msgs[msgs.length - 1]
  return last?.t === 'set-parent' ? last.parent : undefined
}

/** Lets promise callbacks (gzip) run without moving fake time, until `cond` holds or for a while. */
async function flush(cond = () => false): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setImmediate(r))
}

/** Long enough for a reattach batch to be handled (the ticker runs every 50 ms). */
const BATCH = REATTACH_BATCH_MS + 100

const RELAYS = { p1: 6, p2: 6, p3: 6 }
const TREE = ['p1', 'p2', 'p3', 'c1', 'c2', 'c3']

/** k=2, m=1 with one root slot per stripe: p1, p2, p3 relay stripes 0, 1, 2; c1..c3 are leaves. */
async function striped(): Promise<void> {
  setup(2, 1, 3)
  await settledTree(TREE, RELAYS)
  // Make-before-break leftovers from the warm-up (everyone starts as a leaf) time out.
  await advance(4500)
  expect(h.cp.topology.homes).toMatchObject({ p1: [0], p2: [1], p3: [2] })
  for (const c of ['c1', 'c2', 'c3']) expect(h.cp.topology.parents[c]).toEqual(['p1', 'p2', 'p3'])
}

describe('ChannelPublisher: planning and commands', () => {
  it('subscribe → plan: set-parent, add-child and position reach the right peers', async () => {
    await striped()
    for (const id of TREE) {
      for (let s = 0; s < 3; s++) {
        const parent = parentOf(id, s)!
        expect(toldParent(id, s)).toBe(parent)
        expect(hasEdge(parent, id, s)).toBe(true)
      }
      const pos = sentTo(id, 'position').at(-1)
      expect(pos).toEqual({ t: 'position', ch: CH, homes: h.cp.topology.homes[id], depth: h.cp.lastPlan!.depth[id] })
    }
    // No stale edges: each relay feeds exactly its children in the plan.
    for (const p of [HOST, ...TREE]) {
      for (let s = 0; s < 3; s++) {
        const fed = TREE.filter((c) => hasEdge(p, c, s)).sort()
        expect(fed, `${p} stripe ${s}`).toEqual(childrenOf(p, s))
      }
    }
    // Position is only resent when it changes.
    const before = h.mesh.sent.length
    await advance(4000)
    expect(h.mesh.sent.slice(before).filter((s) => s.msg.t === 'position')).toEqual([])
  })

  it('a re-subscribe resends the current parents', async () => {
    await striped()
    const n = sentTo('c1', 'set-parent').length
    send('c1', { t: 'subscribe', ch: CH })
    expect(sentTo('c1', 'set-parent').length).toBe(n + 3)
    for (let s = 0; s < 3; s++) expect(toldParent('c1', s)).toBe(parentOf('c1', s))
  })

  it('unsubscribe removes the peer from the trees and the relay', async () => {
    await striped()
    send('c1', { t: 'unsubscribe', ch: CH })
    expect(h.cp.subscribers.has('c1')).toBe(false)
    expect(h.relay.log).toContain(`removePeer ${CH} c1`)
    for (let s = 0; s < 3; s++) expect(hasEdge(['p1', 'p2', 'p3'][s], 'c1', s)).toBe(false)
    await advance(100)
    expect(h.cp.topology.parents.c1).toBeUndefined()
  })

  it('a peer whose pings go unanswered on an open link stays fed, but relays for no one until it answers', async () => {
    await striped()
    // Its control channel stalls (an ordered stream waiting on a retransmission) while media flows.
    h.mesh.suspected.add('p1')
    await advance(300)
    expect(h.cp.subscribers.get('p1')!.active).toBe(true)
    expect(parentOf('p1', 0)).toBe(HOST)
    expect(hasEdge(HOST, 'p1', 0)).toBe(true)
    for (const s of [1, 2]) expect(hasEdge(parentOf('p1', s)!, 'p1', s)).toBe(true)
    for (const c of ['c1', 'c2', 'c3']) {
      expect(parentOf(c, 0)).not.toBe('p1')
      expect(toldParent(c, 0)).toBe(parentOf(c, 0))
    }
    // It answers again: it may relay again.
    h.mesh.suspected.delete('p1')
    await advance(MIN_UPTIME_MS_FOR_RELAY + 2 * 2000 + 100)
    expect(h.cp.topology.homes.p1?.length).toBeGreaterThan(0)
  })

  it('a peer whose link closes is taken out of the plan', async () => {
    await striped()
    h.mesh.direct.delete('c1')
    await advance(300)
    expect(h.cp.subscribers.get('c1')!.active).toBe(false)
    for (let s = 0; s < 3; s++) expect(hasEdge(['p1', 'p2', 'p3'][s], 'c1', s)).toBe(false)
  })

  it('a departing relay: its edges to the root go, its children are replanned', async () => {
    await striped()
    h.cp.removeSubscriber('p1')
    expect(hasEdge(HOST, 'p1', 0)).toBe(false)
    await advance(100)
    for (const c of ['c1', 'c2', 'c3', 'p2', 'p3']) {
      const parent = parentOf(c, 0)
      expect(parent).not.toBe('p1')
      expect(toldParent(c, 0)).toBe(parent)
    }
    // Nothing is sent to the departed peer any more, not even remove-child for its old children.
    const after = h.mesh.sent.length
    await advance(5000)
    expect(h.mesh.sent.slice(after).filter((s) => s.to === 'p1')).toEqual([])
  })

  it('unsubscribing forgets the keyframe backoff', async () => {
    setup(1, 0, 4)
    await join(['a'])
    send('a', { t: 'need-key', ch: CH })
    expect(h.keyframes).toBe(1)
    await advance(500)
    send('a', { t: 'need-key', ch: CH })
    expect(h.keyframes).toBe(1)
    send('a', { t: 'unsubscribe', ch: CH })
    send('a', { t: 'subscribe', ch: CH })
    send('a', { t: 'need-key', ch: CH })
    expect(h.keyframes).toBe(2)
  })

  it('a departed child’s complaint no longer corroborates its siblings', async () => {
    await striped()
    send('c1', { t: 'reattach', ch: CH, stripe: 0, linkOpen: true })
    await advance(BATCH)
    expect(failures('p1')).toBe(0) // one child without stats: not enough
    h.cp.removeSubscriber('c1')
    send('c2', { t: 'reattach', ch: CH, stripe: 0, linkOpen: true })
    await advance(BATCH)
    expect(failures('p1')).toBe(0)
  })

  it('a late joiner stays a leaf until trusted, without being linked to peers it cannot reach', async () => {
    await striped()
    h.mesh.unlinked.add(['c4', 'p1'].sort().join('|'))
    await join(['c4'], 6)
    await advance(200)
    expect(h.cp.topology.homes.c4).toEqual([])
    expect(parentOf('c4', 0)).not.toBe('p1')
    expect(parentOf('c4', 1)).toBe('p2')
    expect(parentOf('c4', 2)).toBe('p3')
  })
})

/** One stripe, one root slot: host → a → b → c → d. */
async function chain(): Promise<void> {
  setup(1, 0, 1)
  await settledTree(['a', 'b', 'c', 'd'], { a: 1, b: 1, c: 1, d: 1 })
  await advance(4500)
  expect(h.cp.topology.parents).toMatchObject({ a: [HOST], b: ['a'], c: ['b'], d: ['c'] })
}


/** Advances in small steps until `cond` holds (at most `limitMs`). */
async function until(cond: () => boolean, limitMs = 5000): Promise<void> {
  for (let t = 0; !cond(); t += 50) {
    if (t > limitMs) throw new Error('condition not reached')
    await advance(50)
  }
}

describe('ChannelPublisher: make-before-break', () => {
  /** A root slot frees up: the planner moves c from b (depth 3) to the root. */
  async function promoteC(): Promise<void> {
    await chain()
    h.rootSlots = 2
    await until(() => parentOf('c', 0) === HOST)
    expect(toldParent('c', 0)).toBe(HOST)
    expect(hasEdge(HOST, 'c', 0)).toBe(true)
  }

  it('keeps the old edge until the child reports the new parent delivering', async () => {
    await promoteC()
    expect(hasEdge('b', 'c', 0)).toBe(true)
    // An ok for some other parent (e.g. the old one, still delivering) doesn't end the overlap.
    send('c', { t: 'stripe-ok', ch: CH, stripe: 0, parent: 'b' })
    expect(hasEdge('b', 'c', 0)).toBe(true)
    send('c', { t: 'stripe-ok', ch: CH, stripe: 0, parent: HOST })
    expect(hasEdge('b', 'c', 0)).toBe(false)
    expect(hasEdge(HOST, 'c', 0)).toBe(true)
  })

  it('drops the old edge after the removal timeout without an ok', async () => {
    await promoteC()
    await advance(3800)
    expect(hasEdge('b', 'c', 0)).toBe(true)
    await advance(300)
    expect(hasEdge('b', 'c', 0)).toBe(false)
  })

  it('switching back before the new parent delivered keeps the old edge', async () => {
    await promoteC()
    h.rootSlots = 1
    await until(() => parentOf('c', 0) === 'b')
    expect(toldParent('c', 0)).toBe('b')
    expect(hasEdge('b', 'c', 0)).toBe(true)
    // The root (which may have started delivering) is phased out in turn.
    expect(hasEdge(HOST, 'c', 0)).toBe(true)
    await advance(4100)
    expect(hasEdge(HOST, 'c', 0)).toBe(false)
    expect(hasEdge('b', 'c', 0)).toBe(true)
  })

  it('a second switch before the first delivered keeps the parent that still feeds', async () => {
    await promoteC()
    // Before the root delivers anything, the plan changes again: c moves on to a.
    h.mesh.setSlots('a', 2)
    h.rootSlots = 1
    await until(() => parentOf('c', 0) === 'a', 3000)
    expect(hasEdge('a', 'c', 0)).toBe(true)
    // b, which was still feeding c, keeps feeding until a delivers.
    expect(hasEdge('b', 'c', 0)).toBe(true)
    send('c', { t: 'stripe-ok', ch: CH, stripe: 0, parent: 'a' })
    expect(hasEdge('b', 'c', 0)).toBe(false)
    expect(hasEdge(HOST, 'c', 0)).toBe(false)
    expect(hasEdge('a', 'c', 0)).toBe(true)
  })
})

describe('ChannelPublisher: reattach batching', () => {
  it('handles a failed relay’s subtree shallowest-first: only the top complaint accuses', async () => {
    await chain()
    // Everyone below a goes silent; the deepest happen to notice first.
    for (const id of ['d', 'c', 'b']) send(id, { t: 'reattach', ch: CH, stripe: 0, linkOpen: true })
    await advance(BATCH)
    expect(avoids('b')).toEqual(['a'])
    expect(avoids('c')).toEqual([])
    expect(avoids('d')).toEqual([])
    expect(failures('b')).toBe(0)
    expect(failures('c')).toBe(0)
    // b's healthy children stayed with it.
    expect(parentOf('c', 0)).toBe('b')
    expect(parentOf('d', 0)).toBe('c')
  })

  it('collateral complaints within the disruption window are ignored; later ones count', async () => {
    await chain()
    send('b', { t: 'reattach', ch: CH, stripe: 0, linkOpen: true })
    await advance(BATCH)
    expect(avoids('b')).toEqual(['a'])
    // d's feed hasn't resumed yet: it complains about c, which is starved by the same failure.
    await advance(2000)
    expect(parentOf('d', 0)).toBe('c')
    send('d', { t: 'reattach', ch: CH, stripe: 0, linkOpen: true })
    await advance(BATCH)
    expect(avoids('d')).toEqual([])
    // Once the window is over, the same complaint is about c itself.
    await advance(6000)
    expect(parentOf('d', 0)).toBe('c')
    send('d', { t: 'reattach', ch: CH, stripe: 0, linkOpen: true })
    await advance(BATCH)
    expect(avoids('d')).toEqual(['c'])
    expect(parentOf('d', 0)).not.toBe('c')
  })

  it('a departing relay’s subtree is not blamed for going silent', async () => {
    await chain()
    h.cp.removeSubscriber('b')
    await advance(100)
    // c was moved to a already; d stays with c (starved for now, not at fault).
    expect(parentOf('c', 0)).toBe('a')
    expect(parentOf('d', 0)).toBe('c')
    // Complaints sent before c and d heard about it arrive: they are about b, not a or c.
    for (const id of ['d', 'c']) send(id, { t: 'reattach', ch: CH, stripe: 0, linkOpen: true })
    await advance(BATCH)
    expect(avoids('c')).toEqual([])
    expect(avoids('d')).toEqual([])
    expect(failures('a')).toBe(0)
    expect(failures('c')).toBe(0)
    expect(parentOf('c', 0)).toBe('a')
  })
})

describe('ChannelPublisher: blame', () => {
  const reattach = (id: string, s = 0) => send(id, { t: 'reattach', ch: CH, stripe: s, linkOpen: true })

  it('a lone child whose other stripes are silent too does not count against its parent', async () => {
    await striped()
    report('p1')
    report('c1', { stale: [0, 1, 2] })
    reattach('c1')
    await advance(BATCH)
    expect(failures('p1')).toBe(0)
    expect(avoids('c1')).toContain('p1') // it moves anyway
    expect(parentOf('c1', 0)).not.toBe('p1')
    // ...and its excused complaint doesn't corroborate a sibling's.
    await advance(1000)
    reattach('c2')
    await advance(BATCH)
    expect(failures('p1')).toBe(0)
  })

  it('a child whose other stripes still arrive does', async () => {
    await striped()
    report('p1')
    report('c1', { stale: [0] })
    reattach('c1')
    await advance(BATCH)
    expect(failures('p1')).toBeGreaterThan(0.9)
    expect(h.mesh.pings).toEqual(['p1'])
  })

  it('a child complaining about several parents at once has a bad downlink', async () => {
    await striped()
    report('c1', { stale: [0, 1] })
    reattach('c1', 0)
    reattach('c1', 1)
    await advance(BATCH)
    expect(failures('p1')).toBe(0)
    expect(failures('p2')).toBe(0)
  })

  it('siblings corroborate each other, in one batch or a few seconds apart', async () => {
    await striped()
    reattach('c1')
    reattach('c2')
    await advance(BATCH)
    expect(failures('p1')).toBeGreaterThan(1.5)

    await striped()
    reattach('c1')
    await advance(BATCH)
    expect(failures('p1')).toBe(0)
    await advance(3000)
    reattach('c2')
    await advance(BATCH)
    expect(failures('p1')).toBeGreaterThan(0.9)
  })

  it('a parent whose own feed is stale is never blamed', async () => {
    await striped()
    report('p1', { stale: [0] })
    report('c1', { stale: [0] })
    report('c2', { stale: [0] })
    reattach('c1')
    reattach('c2')
    await advance(BATCH)
    expect(failures('p1')).toBe(0)
  })

  it('a blamed parent that does not answer a ping is taken out of the plan', async () => {
    await striped()
    h.mesh.silent.add('p1')
    report('c1', { stale: [0] })
    reattach('c1')
    await advance(BATCH)
    expect(h.cp.subscribers.get('p1')!.active).toBe(true)
    await advance(1300)
    expect(h.cp.subscribers.get('p1')!.active).toBe(false)
    for (const c of ['c2', 'c3']) expect(parentOf(c, 0)).not.toBe('p1')
    // It rejoins once the hold is over and its link still works.
    await advance(3000)
    expect(h.cp.subscribers.get('p1')!.active).toBe(true)
  })

  it('a link that never came up is avoided but not blamed', async () => {
    await striped()
    report('c1', { stale: [0] })
    send('c1', { t: 'reattach', ch: CH, stripe: 0, linkOpen: false })
    await advance(BATCH)
    expect(failures('p1')).toBe(0)
    expect(avoids('c1')).toEqual(['p1'])
    expect(h.mesh.pings).toEqual([])
  })
})

describe('ChannelPublisher: keyframe requests', () => {
  it('a lone requester is bounded', async () => {
    setup(1, 0, 4)
    await join(['a'])
    for (let t = 0; t < 20_000; t += 500) {
      send('a', { t: 'need-key', ch: CH })
      await advance(500)
    }
    expect(h.keyframes).toBe(3) // at 0, 4 s, 12 s
  })

  it('a crowd is served at once, despite backoff', async () => {
    setup(1, 0, 4)
    await join(['a', 'b'])
    const ask = async (id: string, at: number) => {
      await advance(at - (performance.now() - t0))
      send(id, { t: 'need-key', ch: CH })
      return h.keyframes
    }
    const t0 = performance.now()
    expect(await ask('a', 0)).toBe(1) // first requests are served
    expect(await ask('b', 1000)).toBe(2)
    expect(await ask('a', 4500)).toBe(3) // a's 4 s hold is over
    expect(await ask('b', 5500)).toBe(4)
    // Both are held for 8 s now. Alone, a is refused...
    expect(await ask('a', 10_000)).toBe(4)
    // ...but b asking too within a second means a real upstream loss.
    expect(await ask('b', 10_200)).toBe(5)
  })

  it('ignores requests from non-subscribers', async () => {
    setup(1, 0, 4)
    send('x', { t: 'need-key', ch: CH })
    expect(h.keyframes).toBe(0)
  })
})

describe('ChannelPublisher: late parents', () => {
  it('children leave a parent that stays late', async () => {
    await striped()
    const tick = () => {
      report('p1')
      for (const c of ['c1', 'c2', 'c3']) report(c, { lateMs: parentOf(c, 0) === 'p1' ? { 0: 400 } : {} })
    }
    for (let t = 0; t < 8000; t += 1000) {
      tick()
      await advance(1000)
    }
    expect(h.cp.lateness.get('p1:0')).toBe(400)
    expect(parentOf('c1', 0)).toBe('p1')
    for (let t = 0; t < 6000; t += 1000) {
      tick()
      await advance(1000)
    }
    for (const c of ['c1', 'c2', 'c3']) {
      expect(avoids(c)).toContain('p1')
      expect(parentOf(c, 0)).not.toBe('p1')
    }
    // The avoidance expires.
    await advance(LATE_PARENT_AVOID_MS + 2500)
    expect(avoids('c1')).not.toContain('p1')
  })

  it('a parent that is late only because its own feed is late keeps its children', async () => {
    await striped()
    for (let t = 0; t < 14_000; t += 1000) {
      report('p1', { lateMs: { 0: 400 } })
      for (const c of ['c1', 'c2', 'c3']) report(c, { lateMs: { 0: 420 } })
      await advance(1000)
    }
    for (const c of ['c1', 'c2', 'c3']) expect(parentOf(c, 0)).toBe('p1')
  })
})

describe('ChannelPublisher: feasibility', () => {
  it('flags an audience that cannot carry the channel, and clears it when supply recovers', async () => {
    setup(2, 1, 3, 2000)
    await join(['a', 'b', 'c', 'd'])
    // Demand 4 × 3 stripes = 12 slots; supply is the 3 root slots.
    await advance(8000)
    expect(h.cp.limited).toBeNull()
    await advance(4500)
    expect(h.cp.limited).toEqual({ feasibleKbps: 450, ratio: 0.25 })
    for (const id of ['a', 'b', 'c', 'd']) h.mesh.setSlots(id, 3)
    await advance(2100)
    expect(h.cp.limited).toBeNull()
  })

  it('a short dip is not flagged', async () => {
    setup(2, 1, 3, 2000)
    await join(['a', 'b', 'c', 'd'], 3)
    await advance(3000)
    for (const id of ['a', 'b']) h.mesh.setSlots(id, 0)
    await advance(6000)
    for (const id of ['a', 'b']) h.mesh.setSlots(id, 3)
    await advance(6000)
    expect(h.cp.limited).toBeNull()
  })
})

describe('ChannelPublisher: topology reports', () => {
  /** The reports sent to `id`, once there are `n` (or after a while, if `n` is omitted). */
  async function topo(id: string, n?: number): Promise<TopologyReport[]> {
    await flush(() => n !== undefined && sentTo(id, 'topo').length >= n)
    const out: TopologyReport[] = []
    for (const m of sentTo(id, 'topo')) if (m.t === 'topo') out.push(JSON.parse(await gunzip(fromBase64Url(m.z))))
    return out
  }

  it('answers topo-req at once, then every 3 s until turned off', async () => {
    await striped()
    send('c1', { t: 'topo-req', ch: CH, on: true })
    const [first] = await topo('c1', 1)
    expect(first).toMatchObject({ channel: CH, publisher: HOST, k: 2, m: 1, rootSlots: 3, unattached: 0, topology: h.cp.topology })
    expect(first.peers.map((p) => p.id).sort()).toEqual([...TREE].sort())
    // The periodic report (exactly when it falls within these 3 s depends on the ticker's phase).
    await advance(3000)
    expect((await topo('c1', 2)).length).toBeGreaterThanOrEqual(2)
    expect(await topo('c2')).toEqual([])
    send('c1', { t: 'topo-req', ch: CH, on: false })
    const n = (await topo('c1')).length // reports already being compressed still go out
    await advance(6000)
    expect((await topo('c1')).length).toBe(n)
  })

  it('reports stripes left unattached because nothing could link to the peer', async () => {
    await striped()
    // c4 can reach neither the relays nor the publisher's tree slots.
    for (const p of ['p1', 'p2', 'p3', 'c1', 'c2', 'c3']) h.mesh.unlinked.add(['c4', p].sort().join('|'))
    h.mesh.record.unreachable.push('c4')
    await join(['c4'])
    await advance(2100)
    expect(h.cp.lastPlan!.unattached).toBe(3)
    expect(h.cp.report().unattached).toBe(3)
  })
})

