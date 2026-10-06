// Short, stable labels for peers in the Topology panel, so the tree and the table cross-reference
// by something other than colour: the publisher is "P", everyone else #1, #2, … in join order.
// Pure, for unit tests.

/**
 * Numbers for `peers`, keeping every number already given in `prev` (a peer keeps its number while
 * others come and go); newcomers get the next free numbers, in join order (unknown join times last,
 * ties by id).
 */
export function assignNumbers(prev: ReadonlyMap<string, number>, peers: { id: string; joinedAt?: number }[]): Map<string, number> {
  const out = new Map<string, number>()
  let next = 1
  for (const n of prev.values()) next = Math.max(next, n + 1)
  for (const p of peers) {
    const n = prev.get(p.id)
    if (n !== undefined) out.set(p.id, n)
  }
  const fresh = peers
    .filter((p) => !out.has(p.id))
    .sort((a, b) => (a.joinedAt ?? Infinity) - (b.joinedAt ?? Infinity) || (a.id < b.id ? -1 : 1))
  for (const p of fresh) out.set(p.id, next++)
  return out
}

/** "P" for the publisher, "#n" otherwise ("?" if unnumbered). `bare` drops the "#" (tree nodes). */
export function peerLabel(id: string, publisher: string, numbers: ReadonlyMap<string, number>, bare = false): string {
  if (id === publisher) return 'P'
  const n = numbers.get(id)
  if (n === undefined) return '?'
  return bare ? String(n) : `#${n}`
}

/** A name cut to `max` characters with an ellipsis. */
export function shortName(name: string, max = 14): string {
  const chars = [...name]
  return chars.length <= max ? name : `${chars.slice(0, max - 1).join('')}…`
}
