import { describe, expect, it } from 'vitest'
import { ChannelOwners, type ChannelClaimsInput } from '../src/session/channelOwners'

interface Ann {
  id: number
  tag: string
}

const SELF = 'self'
const OWNER = 'owner'

function input(over: Partial<ChannelClaimsInput<Ann>>): ChannelClaimsInput<Ann> {
  return { selfId: SELF, ownerId: OWNER, mayPublish: () => true, own: [], members: [], ...over }
}

const publisherOf = (m: Map<number, { publisher: string }>, id: number) => m.get(id)?.publisher

describe('ChannelOwners', () => {
  it('binds an uncontested channel to its publisher', () => {
    const o = new ChannelOwners()
    const res = o.resolve(input({ members: [{ id: 'alice', channels: [{ id: 1, tag: 'real' }] }] }))
    expect(publisherOf(res, 1)).toBe('alice')
    expect(o.ownerOf(1)).toBe('alice')
  })

  it('a copier cannot hijack a bound channel, even after the publisher leaves', () => {
    const o = new ChannelOwners()
    o.resolve(input({ members: [{ id: 'alice', channels: [{ id: 1, tag: 'real' }] }] }))
    const both = o.resolve(
      input({
        members: [
          { id: 'mallory', channels: [{ id: 1, tag: 'copy' }] },
          { id: 'alice', channels: [{ id: 1, tag: 'real' }] },
        ],
      }),
    )
    expect(both.get(1)).toEqual({ publisher: 'alice', ann: { id: 1, tag: 'real' } })
    const alone = o.resolve(input({ members: [{ id: 'mallory', channels: [{ id: 1, tag: 'copy' }] }] }))
    expect(alone.has(1)).toBe(false)
    expect(o.ownerOf(1)).toBe('alice')
  })

  it("this peer's own channels always win, and stay bound after they end", () => {
    const o = new ChannelOwners()
    const res = o.resolve(input({ own: [{ id: 5, tag: 'mine' }], members: [{ id: 'mallory', channels: [{ id: 5, tag: 'copy' }] }] }))
    expect(res.get(5)).toEqual({ publisher: SELF, ann: { id: 5, tag: 'mine' } })
    const after = o.resolve(input({ members: [{ id: 'mallory', channels: [{ id: 5, tag: 'copy' }] }] }))
    expect(after.has(5)).toBe(false)
    expect(o.ownerOf(5)).toBe(SELF)
  })

  it("skips this peer's own record among the members", () => {
    const o = new ChannelOwners()
    const res = o.resolve(input({ members: [{ id: SELF, channels: [{ id: 2, tag: 'stale' }] }] }))
    expect(res.size).toBe(0)
    expect(o.ownerOf(2)).toBeUndefined()
  })

  it('own channels are not live while this peer may not publish, but stay bound', () => {
    const o = new ChannelOwners()
    const res = o.resolve(
      input({ mayPublish: (id) => id !== SELF, own: [{ id: 3, tag: 'mine' }], members: [{ id: 'mallory', channels: [{ id: 3, tag: 'copy' }] }] }),
    )
    expect(res.size).toBe(0)
    expect(o.ownerOf(3)).toBe(SELF)
  })

  it('contested on first sight: nobody wins unless the room owner claims it', () => {
    const o = new ChannelOwners()
    const contested = [
      { id: 'alice', channels: [{ id: 9, tag: 'a' }] },
      { id: 'mallory', channels: [{ id: 9, tag: 'm' }] },
    ]
    expect(o.resolve(input({ members: contested })).has(9)).toBe(false)
    expect(o.ownerOf(9)).toBeUndefined()
    // Once one claim is left, it binds.
    expect(publisherOf(o.resolve(input({ members: [contested[0]] })), 9)).toBe('alice')
  })

  it('contested on first sight: the room owner is trusted', () => {
    const o = new ChannelOwners()
    const res = o.resolve(
      input({
        members: [
          { id: 'mallory', channels: [{ id: 9, tag: 'm' }] },
          { id: OWNER, channels: [{ id: 9, tag: 'o' }] },
        ],
      }),
    )
    expect(res.get(9)).toEqual({ publisher: OWNER, ann: { id: 9, tag: 'o' } })
    expect(o.ownerOf(9)).toBe(OWNER)
  })

  it('the room owner cannot take over a channel already bound to someone else', () => {
    const o = new ChannelOwners()
    o.resolve(input({ members: [{ id: 'alice', channels: [{ id: 4, tag: 'a' }] }] }))
    const res = o.resolve(
      input({
        members: [
          { id: OWNER, channels: [{ id: 4, tag: 'o' }] },
          { id: 'alice', channels: [{ id: 4, tag: 'a' }] },
        ],
      }),
    )
    expect(publisherOf(res, 4)).toBe('alice')
  })

  it("a revoked publisher's channels go dark and are not handed to a copier", () => {
    const o = new ChannelOwners()
    const revoked = new Set<string>()
    const mayPublish = (id: string) => !revoked.has(id)
    const members = [
      { id: 'alice', channels: [{ id: 6, tag: 'a' }] },
      { id: 'mallory', channels: [] as Ann[] },
    ]
    expect(publisherOf(o.resolve(input({ mayPublish, members })), 6)).toBe('alice')
    revoked.add('alice')
    members[1].channels = [{ id: 6, tag: 'copy' }]
    expect(o.resolve(input({ mayPublish, members })).has(6)).toBe(false)
    // Re-granted: the channel comes back to its original publisher.
    revoked.delete('alice')
    expect(publisherOf(o.resolve(input({ mayPublish, members })), 6)).toBe('alice')
  })

  it("a revoked publisher's claim is ignored on first sight", () => {
    const o = new ChannelOwners()
    const res = o.resolve(
      input({
        mayPublish: (id) => id !== 'eve',
        members: [
          { id: 'eve', channels: [{ id: 8, tag: 'e' }] },
          { id: 'alice', channels: [{ id: 8, tag: 'a' }] },
        ],
      }),
    )
    expect(publisherOf(res, 8)).toBe('alice')
  })

  it('normalises ids to u32', () => {
    const o = new ChannelOwners()
    const res = o.resolve(input({ members: [{ id: 'alice', channels: [{ id: -1, tag: 'a' }] }] }))
    expect(publisherOf(res, 0xffffffff)).toBe('alice')
    expect(o.ownerOf(-1)).toBe('alice')
  })
})
