import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKGROUND_BUFFER_MAX, LINK_BUFFER_HIGH, LINK_BUFFER_LOW, type LinkState, type MediaLink } from '../src/net/link'
import { STALL_MS, Uplink } from '../src/net/uplink'
import { tuning } from '../src/tuning'

/** Every message any stub link sent, in order: [link name, first payload byte]. */
let log: [string, number][] = []

class StubLink implements MediaLink {
  isOpen = true
  state: LinkState = 'open'
  bufferedAmount = 0
  sendOk = true
  constructor(readonly name: string) {}
  send(data: Uint8Array): boolean {
    if (!this.sendOk) return false
    log.push([this.name, data[0]])
    return true
  }
  block(): void {
    this.bufferedAmount = LINK_BUFFER_HIGH + 1
  }
  unblock(): void {
    this.bufferedAmount = 0
  }
}

/** A message of `size` bytes whose first byte is `tag`. */
function msg(tag: number, size = 10): Uint8Array {
  const b = new Uint8Array(size)
  b[0] = tag
  return b
}

const sentBy = (name: string) => log.filter(([n]) => n === name).map(([, t]) => t)

beforeEach(() => {
  log = []
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Uplink queueing', () => {
  it('sends immediately when uncapped and the link has room', () => {
    const u = new Uplink()
    const a = new StubLink('a')
    u.send(a, msg(1), 0)
    expect(sentBy('a')).toEqual([1])
    expect(u.stats.sentItems).toBe(1)
    expect(u.stats.queuedBytes).toBe(0)
  })

  it('queues GOP-cache replays behind live fragments', () => {
    const u = new Uplink()
    const a = new StubLink('a')
    a.block()
    u.send(a, msg(1), 0, undefined, true)
    u.send(a, msg(2), 0, undefined, true)
    u.send(a, msg(3), 0)
    u.send(a, msg(4), 2)
    u.send(a, msg(5), 0, undefined, true)
    expect(u.queued(a)).toBe(5)
    a.unblock()
    u.kick()
    expect(sentBy('a')).toEqual([3, 4, 1, 2, 5])
  })

  it('expires higher temporal layers first under a backlog', () => {
    const u = new Uplink()
    const a = new StubLink('a')
    a.block()
    for (let layer = 0; layer < 4; layer++) u.send(a, msg(layer), layer)
    const [t0, t1, t2, t3] = tuning.maxAgeByLayer
    expect(t3).toBeLessThanOrEqual(t1)
    expect(t2).toBeLessThan(t1)
    expect(t1).toBeLessThan(t0)

    vi.advanceTimersByTime(Math.max(t2, t3) + 1)
    u.kick()
    expect(u.stats.droppedByLayer).toEqual([0, 0, 1, 1])
    vi.advanceTimersByTime(t1 - Math.max(t2, t3))
    u.kick()
    expect(u.stats.droppedByLayer).toEqual([0, 1, 1, 1])
    a.unblock()
    u.kick()
    expect(sentBy('a')).toEqual([0])
    expect(u.stats.droppedItems).toBe(3)
    expect(u.stats.queuedBytes).toBe(0)
  })

  it('expires layers by deadline under an upload cap too', () => {
    // 8 kbps = 1 byte/ms: a backlog of 100-byte messages builds up fast.
    const u = new Uplink(8)
    const a = new StubLink('a')
    for (let i = 0; i < 40; i++) u.send(a, msg(i, 100), i % 2 === 0 ? 0 : 2)
    vi.advanceTimersByTime(tuning.maxAgeByLayer[2] + 50)
    expect(u.stats.droppedByLayer[2]).toBeGreaterThan(0)
    expect(u.stats.droppedByLayer[0]).toBe(0)
  })

  it('keeps keyframe fragments for their own (longer) deadline', () => {
    const u = new Uplink()
    const a = new StubLink('a')
    a.block()
    u.send(a, msg(7), 0, tuning.keyMaxAgeMs)
    u.send(a, msg(8), 0)
    expect(tuning.keyMaxAgeMs).toBeGreaterThan(tuning.maxAgeByLayer[0])
    vi.advanceTimersByTime(tuning.maxAgeByLayer[0] + 1)
    u.kick()
    expect(u.queued(a)).toBe(1)
    vi.advanceTimersByTime(tuning.keyMaxAgeMs - tuning.maxAgeByLayer[0])
    u.kick()
    expect(u.queued(a)).toBe(0)
    expect(u.stats.droppedByLayer[0]).toBe(2)
  })

  it('drops the rest of a frame once one of its fragments expires', () => {
    const u = new Uplink()
    const a = new StubLink('a')
    a.block()
    u.send(a, msg(1), 2, undefined, false, 'f')
    vi.advanceTimersByTime(tuning.maxAgeByLayer[2] + 1)
    // Still fresh, but its frame is already broken on this link.
    u.send(a, msg(2), 2, undefined, false, 'f')
    expect(u.queued(a)).toBe(0)
    u.send(a, msg(3), 2, undefined, false, 'f')
    expect(u.stats.droppedByLayer[2]).toBe(3)
    // Other frames are unaffected.
    a.unblock()
    u.send(a, msg(4), 2, undefined, false, 'g')
    expect(sentBy('a')).toEqual([4])
  })
})

describe('Uplink scheduling', () => {
  it('serves links round robin', () => {
    const u = new Uplink()
    const links = ['a', 'b', 'c'].map((n) => new StubLink(n))
    for (const l of links) l.block()
    for (let i = 0; i < 3; i++) for (const l of links) u.send(l, msg(i), 0)
    for (const l of links) l.unblock()
    u.kick()
    expect(log.map(([n, t]) => `${n}${t}`)).toEqual(['a0', 'b0', 'c0', 'a1', 'b1', 'c1', 'a2', 'b2', 'c2'])
  })

  it('shares a capped uplink fairly across drains', () => {
    // 80 kbps = 10 bytes/ms; each drain affords about one 100-byte message.
    const u = new Uplink(80)
    const links = ['a', 'b', 'c'].map((n) => new StubLink(n))
    for (let i = 0; i < 30; i++) for (const l of links) u.send(l, msg(i, 100), 0)
    vi.advanceTimersByTime(300)
    const counts = links.map((l) => sentBy(l.name).length)
    expect(Math.min(...counts)).toBeGreaterThan(5)
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  })

  it('serves background links only when no media can be sent', () => {
    const u = new Uplink()
    const media = new StubLink('m')
    const bg = new StubLink('bg')
    u.setBackground(bg)
    media.block()
    bg.block()
    u.send(bg, msg(1), 0)
    u.send(bg, msg(2), 0)
    u.send(media, msg(3), 0)
    u.send(media, msg(4), 0)
    media.unblock()
    bg.unblock()
    u.kick()
    expect(log.map(([n, t]) => `${n}${t}`)).toEqual(['m3', 'm4', 'bg1', 'bg2'])

    // Media blocked on its send buffer doesn't hold back background traffic.
    log = []
    media.block()
    u.send(media, msg(5), 0)
    u.send(bg, msg(6), 0)
    expect(log.map(([n, t]) => `${n}${t}`)).toEqual(['bg6'])
    // Background sends don't count towards media queueing delay.
    expect(u.stats.queueDelayN).toBe(2)
  })

  it('background data and replays wait while the send buffer holds more than BACKGROUND_BUFFER_MAX', () => {
    const u = new Uplink()
    const bg = new StubLink('bg')
    u.setBackground(bg)
    bg.bufferedAmount = BACKGROUND_BUFFER_MAX + 1
    u.send(bg, msg(1), 0)
    expect(sentBy('bg')).toEqual([])
    bg.bufferedAmount = BACKGROUND_BUFFER_MAX
    u.kick()
    expect(sentBy('bg')).toEqual([1])
    const m = new StubLink('m')
    m.bufferedAmount = BACKGROUND_BUFFER_MAX + 1
    u.send(m, msg(2), 0, undefined, true)
    expect(sentBy('m')).toEqual([])
  })

  it('forgets closed links and releases their queued bytes', () => {
    const u = new Uplink()
    const a = new StubLink('a')
    const b = new StubLink('b')
    a.block()
    b.block()
    u.send(a, msg(1, 50), 0)
    u.send(a, msg(2, 50), 0)
    u.send(b, msg(3, 30), 0)
    expect(u.stats.queuedBytes).toBe(130)

    // A link that is merely not open yet keeps its queue.
    b.isOpen = false
    b.state = 'connecting'
    a.isOpen = false
    a.state = 'closed'
    u.kick()
    expect(u.queued(a)).toBe(0)
    expect(u.queued(b)).toBe(1)
    expect(u.stats.queuedBytes).toBe(30)

    b.state = 'failed'
    u.kick()
    expect(u.queued(b)).toBe(0)
    expect(u.stats.queuedBytes).toBe(0)
    expect(log).toEqual([])
  })

  it('counts refused sends as failures', () => {
    const u = new Uplink()
    const a = new StubLink('a')
    a.sendOk = false
    u.send(a, msg(1, 20), 0)
    expect(u.stats.sendFailed).toBe(1)
    expect(u.stats.droppedItems).toBe(1)
    expect(u.stats.queuedBytes).toBe(0)
  })

  it('records a buffer stall when a full link has items waiting', () => {
    const u = new Uplink()
    const a = new StubLink('a')
    a.block()
    u.send(a, msg(1), 0)
    u.kick()
    expect(u.stats.bufferStalls).toBeGreaterThanOrEqual(1)
  })
})

describe('Uplink stall detection', () => {
  /** A link whose send buffer grows with what it is given, and drains only when told. */
  class BufferLink extends StubLink {
    send(data: Uint8Array): boolean {
      this.bufferedAmount += data.byteLength
      return super.send(data)
    }
  }

  it('calls a link stalled when its buffer holds data and drains nothing for STALL_MS', () => {
    const u = new Uplink()
    const a = new BufferLink('a')
    a.bufferedAmount = LINK_BUFFER_LOW + 1000
    expect(u.stalledMs(a)).toBe(0)
    vi.advanceTimersByTime(STALL_MS - 10)
    expect(u.isStalled(a)).toBe(false)
    vi.advanceTimersByTime(20)
    expect(u.isStalled(a)).toBe(true)
    expect(u.perLink.get(a)).toMatchObject({ lastStallAt: performance.now() })
    // One byte drained: it moves again.
    a.bufferedAmount--
    expect(u.isStalled(a)).toBe(false)
    expect(u.stalledMs(a)).toBe(0)
    // Stalls again later.
    vi.advanceTimersByTime(STALL_MS + 10)
    expect(u.isStalled(a)).toBe(true)
    expect(u.perLink.get(a)).toMatchObject({ lastStallAt: performance.now() })
  })

  it('does not count what was just sent into the buffer as draining', () => {
    const u = new Uplink()
    const a = new BufferLink('a')
    a.bufferedAmount = LINK_BUFFER_LOW + 1000
    u.stalledMs(a)
    vi.advanceTimersByTime(STALL_MS / 2)
    // New fragments go in (the buffer has room below the high mark); none leave.
    for (let i = 0; i < 3; i++) u.send(a, msg(i, 1000), 0)
    expect(sentBy('a')).toHaveLength(3)
    vi.advanceTimersByTime(STALL_MS / 2 + 10)
    expect(u.isStalled(a)).toBe(true)
  })

  it('moves what waits for a stalled link to another, in queueing order, live before replays', () => {
    const u = new Uplink()
    const a = new StubLink('a')
    const b = new StubLink('b')
    a.block()
    b.block()
    u.send(a, msg(1), 0)
    u.send(a, msg(2), 0, undefined, true)
    vi.advanceTimersByTime(5)
    u.send(b, msg(3), 0)
    vi.advanceTimersByTime(5)
    u.send(a, msg(4), 1)
    u.moveQueued(a, b)
    expect(u.queued(a)).toBe(0)
    expect(u.queued(b)).toBe(4)
    b.unblock()
    u.kick()
    expect(sentBy('b')).toEqual([1, 3, 4, 2])
    expect(sentBy('a')).toEqual([])
  })

  it('never calls a nearly empty or closed link stalled', () => {
    const u = new Uplink()
    const a = new BufferLink('a')
    a.bufferedAmount = LINK_BUFFER_LOW
    u.stalledMs(a)
    vi.advanceTimersByTime(10 * STALL_MS)
    expect(u.isStalled(a)).toBe(false)
    a.bufferedAmount = LINK_BUFFER_HIGH
    u.stalledMs(a)
    a.isOpen = false
    vi.advanceTimersByTime(10 * STALL_MS)
    expect(u.isStalled(a)).toBe(false)
  })
})

describe('Uplink cap', () => {
  it('lets a message larger than the burst through on token debt, then waits it off', () => {
    // 80 kbps = 10 bytes/ms; 1000-byte messages exceed the 40 ms (400 byte) burst.
    const u = new Uplink(80)
    const a = new StubLink('a')
    u.send(a, msg(1, 1000), 0)
    u.send(a, msg(2, 1000), 0)
    expect(log).toEqual([]) // the bucket starts empty
    vi.advanceTimersByTime(4)
    expect(sentBy('a')).toEqual([1])
    // 1000 bytes of debt minus the 40 refilled: about 96 ms more before the next message.
    vi.advanceTimersByTime(90)
    expect(sentBy('a')).toEqual([1])
    vi.advanceTimersByTime(16)
    expect(sentBy('a')).toEqual([1, 2])
  })

  it('holds long-run throughput to the cap', () => {
    const u = new Uplink(80) // 10 bytes/ms
    const a = new StubLink('a')
    for (let i = 0; i < 40; i++) u.send(a, msg(i, 500), 0)
    vi.advanceTimersByTime(1000)
    // 10 000 bytes of budget, plus at most one message of debt.
    expect(u.stats.sentBytes).toBeGreaterThanOrEqual(9500)
    expect(u.stats.sentBytes).toBeLessThanOrEqual(10_500)
  })

  it('reports queueing delay of sent media', () => {
    const u = new Uplink()
    const a = new StubLink('a')
    a.block()
    u.send(a, msg(1), 0)
    u.send(a, msg(2), 0)
    vi.advanceTimersByTime(200)
    a.unblock()
    u.kick()
    expect(u.stats.queueDelayN).toBe(2)
    expect(u.stats.queueDelaySum).toBe(400)
  })

})

describe('Uplink capacity counters', () => {
  it('counts every byte handed to a link, background and replays included', () => {
    const u = new Uplink()
    const a = new StubLink('a')
    const bg = new StubLink('bg')
    u.setBackground(bg)
    u.send(a, msg(1, 100), 0)
    u.send(a, msg(2, 50), 0, undefined, true)
    u.send(bg, msg(3, 30), 0)
    expect(u.perLink.get(a)).toMatchObject({ handedBytes: 150, sentBytes: 100 })
    expect(u.perLink.get(bg)?.handedBytes).toBe(30)
  })

  it("keeps a busy clock: how long a link's queue held something", () => {
    const u = new Uplink()
    const a = new StubLink('a')
    u.send(a, msg(1), 0)
    // Sent at once: never busy.
    vi.advanceTimersByTime(100)
    expect(u.busyMs(a)).toBe(0)
    a.block()
    u.send(a, msg(2), 0)
    vi.advanceTimersByTime(300)
    expect(u.busyMs(a)).toBe(300)
    expect(u.headAgeMs(a)).toBe(300)
    a.unblock()
    u.kick()
    vi.advanceTimersByTime(500)
    expect(u.busyMs(a)).toBe(300)
    expect(u.headAgeMs(a)).toBe(0)
  })

  it('discards what waits for a probe link, keeping its counters', () => {
    const u = new Uplink()
    const bg = new StubLink('bg')
    u.setBackground(bg)
    u.send(bg, msg(1, 20), 0)
    bg.block()
    u.send(bg, msg(2, 20), 0)
    u.send(bg, msg(3, 20), 0)
    vi.advanceTimersByTime(100)
    u.discard(bg)
    expect(u.queued(bg)).toBe(0)
    expect(u.stats.queuedBytes).toBe(0)
    expect(u.stats.droppedBackground).toBe(2)
    expect(u.perLink.get(bg)?.handedBytes).toBe(20)
    expect(u.busyMs(bg)).toBe(100)
  })
})
