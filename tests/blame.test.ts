import { describe, expect, it } from 'vitest'
import { blameInput, childStripeEvidence, ComplaintLog, shouldBlameParent, type Complaint, type StatsSnapshot } from '../src/topology/policy'

const FRESH = 750

describe('shouldBlameParent', () => {
  const cases: [boolean, boolean, boolean, boolean][] = [
    // childOtherStripesFresh, siblingComplainedRecently, parentFeedStale -> blame
    [false, false, false, false],
    [true, false, false, true],
    [false, true, false, true],
    [true, true, false, true],
    [false, false, true, false],
    [true, false, true, false],
    [false, true, true, false],
    [true, true, true, false],
  ]
  it.each(cases)('fresh=%s sibling=%s parentStale=%s -> %s', (childOtherStripesFresh, siblingComplainedRecently, parentFeedStale, blame) => {
    expect(shouldBlameParent({ childOtherStripesFresh, siblingComplainedRecently, parentFeedStale })).toBe(blame)
  })
})

/** Stats received at `at`, with per-stripe ms since the last fragment. */
const stats = (at: number, ...ago: (number | null)[]): StatsSnapshot => ({ at, stripes: ago.map((a, i) => ({ parent: `p${i}`, lastRecvAgoMs: a })) })
const complaint = (child: string, parent: string, stripe: number, at: number, excused = false): Complaint => ({ child, parent, stripe, at, excused })

describe('blameInput', () => {
  const now = 10_000
  const c = { child: 'c', parent: 'p', stripe: 1, now }

  it('blames a parent whose stripe alone went silent while the others arrive', () => {
    const input = blameInput(c, stats(now - 500, 20, 1800, 40), stats(now - 300, 10, 15, 30), [], FRESH)
    expect(input).toEqual({ childOtherStripesFresh: true, siblingComplainedRecently: false, parentFeedStale: false })
    expect(shouldBlameParent(input)).toBe(true)
  })

  it("doesn't blame when the child's other stripes are silent too (its own downlink)", () => {
    const input = blameInput(c, stats(now - 500, 1600, 1800, 1700), stats(now - 300, 10, 15, 30), [], FRESH)
    expect(input.childOtherStripesFresh).toBe(false)
    expect(childStripeEvidence(c, stats(now - 500, 1600, 1800, 1700), [], FRESH)).toBe('stale')
    expect(shouldBlameParent(input)).toBe(false)
  })

  it("doesn't blame when the parent's own feed of the stripe is silent (upstream)", () => {
    const input = blameInput(c, stats(now - 500, 20, 1800, 40), stats(now - 300, 10, 2000, 30), [], FRESH)
    expect(input.parentFeedStale).toBe(true)
    expect(shouldBlameParent(input)).toBe(false)
  })

  it("doesn't blame without stats, or with stats from before the stripe went silent", () => {
    expect(shouldBlameParent(blameInput(c, null, null, [], FRESH))).toBe(false)
    // Stats older than the problem: every stripe still arriving, so they can't tell.
    expect(childStripeEvidence(c, stats(now - 1500, 20, 30, 40), [], FRESH)).toBe('unknown')
    // Stats too old to say anything.
    expect(childStripeEvidence(c, stats(now - 6000, 20, 1800, 40), [], FRESH)).toBe('unknown')
    // Old parent stats don't excuse it either way.
    expect(blameInput(c, null, stats(now - 6000, 10, 2000, 30), [], FRESH).parentFeedStale).toBe(false)
  })

  it('falls back to sibling corroboration on a single-stripe channel', () => {
    const single = { child: 'c', parent: 'p', stripe: 0, now }
    expect(childStripeEvidence(single, stats(now - 200, 1800), [], FRESH)).toBe('unknown')
    expect(shouldBlameParent(blameInput(single, stats(now - 200, 1800), null, [], FRESH))).toBe(false)
    const sib = [complaint('d', 'p', 0, now - 4000)]
    expect(shouldBlameParent(blameInput(single, stats(now - 200, 1800), null, sib, FRESH))).toBe(true)
  })

  it('counts recent, unexcused complaints from other children of the same parent (any stripe)', () => {
    const sibling = (list: Complaint[]) => blameInput(c, null, null, list, FRESH).siblingComplainedRecently
    expect(sibling([complaint('d', 'p', 2, now - 9000)])).toBe(true)
    expect(sibling([complaint('d', 'p', 2, now - 11_000)])).toBe(false)
    expect(sibling([complaint('d', 'p', 2, now - 1000, true)])).toBe(false)
    expect(sibling([complaint('d', 'q', 2, now - 1000)])).toBe(false)
    expect(sibling([complaint('c', 'p', 2, now - 1000)])).toBe(false)
  })

  it('treats a child complaining about two parents at once as its own downlink', () => {
    // Even stats claiming the other stripes arrive (they predate the failure) don't count.
    expect(childStripeEvidence(c, stats(now - 500, 20, 1800, 40), [complaint('c', 'q', 0, now)], FRESH)).toBe('stale')
    // The same parent on two stripes is still the parent's fault.
    expect(childStripeEvidence(c, stats(now - 500, 1800, 1800, 40), [complaint('c', 'p', 0, now)], FRESH)).toBe('stale')
    expect(childStripeEvidence(c, stats(now - 500, 20, 1800, 40), [complaint('c', 'p', 0, now)], FRESH)).toBe('fresh')
  })

  it('ignores stripes the child has no parent for', () => {
    const s: StatsSnapshot = {
      at: now - 200,
      stripes: [
        { parent: null, lastRecvAgoMs: null },
        { parent: 'p', lastRecvAgoMs: 1800 },
        { parent: 'x', lastRecvAgoMs: 10 },
      ],
    }
    expect(childStripeEvidence(c, s, [], FRESH)).toBe('fresh')
  })
})

describe('ComplaintLog', () => {
  it('keeps recent complaints and forgets departed peers', () => {
    const log = new ComplaintLog()
    log.add(complaint('c', 'p', 0, 0))
    log.add(complaint('d', 'p', 1, 5000))
    log.add(complaint('e', 'q', 1, 5000))
    expect(log.recent(12_000).map((x) => x.child)).toEqual(['d', 'e'])
    log.forget('p')
    expect(log.recent(12_000).map((x) => x.child)).toEqual(['e'])
  })
})
