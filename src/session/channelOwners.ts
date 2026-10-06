// Which publisher a channel id belongs to. Pure (no browser APIs), so it can be unit tested.
//
// Channel ids are bound to the publisher this peer first saw claim them, for the session's
// lifetime. Any granted publisher can put any id in its record (and startedAt is self-reported),
// so a later claim by someone else must never take a channel over: this peer would verify the real
// publisher's fragments against the copier's key.

export interface ChannelClaim<A> {
  ann: A
  publisher: string
}

export interface ChannelClaimsInput<A extends { id: number }> {
  selfId: string
  /** The room owner: the only claim trusted when an id is contested on first sight. */
  ownerId: string
  /** Whether a peer may publish right now (revoked publishers' claims are ignored). */
  mayPublish: (id: string) => boolean
  /** This peer's own channels. */
  own: A[]
  /** Every member's record (this peer's own record is skipped). */
  members: Iterable<{ id: string; channels: A[] }>
}

export class ChannelOwners {
  private owners = new Map<number, string>()

  /** The publisher a channel id is bound to, if any. */
  ownerOf(id: number): string | undefined {
    return this.owners.get(id >>> 0)
  }

  /** Resolves the live channels (by id) from the claims in members' records, binding new ids. */
  resolve<A extends { id: number }>(input: ChannelClaimsInput<A>): Map<number, ChannelClaim<A>> {
    const { selfId, ownerId, mayPublish } = input
    const next = new Map<number, ChannelClaim<A>>()
    // This peer's own channels always win, and stay bound to it after they end.
    const selfMayPublish = mayPublish(selfId)
    for (const ann of input.own) {
      const id = ann.id >>> 0
      this.owners.set(id, selfId)
      if (selfMayPublish) next.set(id, { ann, publisher: selfId })
    }
    const claims = new Map<number, ChannelClaim<A>[]>()
    for (const rec of input.members) {
      if (rec.id === selfId || !mayPublish(rec.id)) continue
      for (const ann of rec.channels) {
        const id = ann.id >>> 0
        const list = claims.get(id)
        if (list) list.push({ ann, publisher: rec.id })
        else claims.set(id, [{ ann, publisher: rec.id }])
      }
    }
    for (const [id, list] of claims) {
      const owner = this.owners.get(id)
      let pick: ChannelClaim<A> | undefined
      if (owner !== undefined) pick = list.find((c) => c.publisher === owner)
      else if (list.every((c) => c.publisher === list[0].publisher)) pick = list[0]
      // Contested on first sight (e.g. by a late joiner): nothing tells the copy apart, so only
      // the room owner's claim is trusted; otherwise the id stays unwatched until one claim is left.
      else pick = list.find((c) => c.publisher === ownerId)
      if (!pick) continue
      this.owners.set(id, pick.publisher)
      next.set(id, pick)
    }
    return next
  }
}
