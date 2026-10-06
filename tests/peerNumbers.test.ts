import { describe, expect, it } from 'vitest'
import { assignNumbers, peerLabel, shortName } from '../src/ui/peerNumbers'

describe('peer numbers', () => {
  it('numbers peers in join order', () => {
    const n = assignNumbers(new Map(), [
      { id: 'c', joinedAt: 30 },
      { id: 'a', joinedAt: 10 },
      { id: 'b', joinedAt: 20 },
      { id: 'z' }, // join time unknown: last
    ])
    expect([...n.entries()].sort((x, y) => x[1] - y[1])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['z', 4],
    ])
  })

  it('keeps numbers stable as peers come and go', () => {
    const first = assignNumbers(new Map(), [
      { id: 'a', joinedAt: 1 },
      { id: 'b', joinedAt: 2 },
    ])
    // a leaves, d joins (even with an earlier join time than b): b keeps #2, d gets #3.
    const second = assignNumbers(first, [
      { id: 'b', joinedAt: 2 },
      { id: 'd', joinedAt: 0 },
    ])
    expect(second.get('b')).toBe(2)
    expect(second.get('d')).toBe(3)
    expect(second.has('a')).toBe(false)
  })

  it('labels: P for the publisher, #n otherwise, bare numbers for tree nodes', () => {
    const n = new Map([['x', 7]])
    expect(peerLabel('pub', 'pub', n)).toBe('P')
    expect(peerLabel('x', 'pub', n)).toBe('#7')
    expect(peerLabel('x', 'pub', n, true)).toBe('7')
    expect(peerLabel('y', 'pub', n)).toBe('?')
  })

  it('truncates long names', () => {
    expect(shortName('alice')).toBe('alice')
    expect(shortName('a very long display name', 10)).toBe('a very lo…')
    expect([...shortName('😀'.repeat(20), 5)]).toHaveLength(5)
  })
})
