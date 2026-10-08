// Who may publish: the owner's decisions (mesh/auth.ts, gossiped by the mesh), a member's request
// to publish and the owner's pending requests. The owner answers, sets the policy, revokes and
// kicks; the session acts on what changes (session/peerSession.ts onAuthChange).
import { ban, grant, isBanned, mayPublish as mayPublishDoc, revoke, setPolicy, type PublishPolicy } from '../mesh/auth'
import type { Mesh } from '../mesh/mesh'
import type { PeerMsg } from '../proto/messages'

/** A member's request to publish, as the requester sees it. */
export type RequestState = 'idle' | 'waiting' | 'owner-away' | 'denied' | 'granted'

export interface PublishRequest {
  id: string
  at: number
}

export interface PublishRightsContext {
  readonly selfId: string
  readonly ownerId: string
  readonly mesh: Mesh
  onChange(): void
  /** The owner granted this peer's request. */
  onGranted(): void
}

type RightsMsg = Extract<PeerMsg, { t: 'publish-req' | 'publish-cancel' | 'publish-deny' }>

export class PublishRights {
  /** This member's request to publish. */
  requestState: RequestState = 'idle'
  /** Owner: pending publish requests. */
  readonly requests = new Map<string, PublishRequest>()

  constructor(private ctx: PublishRightsContext) {}

  get isOwner(): boolean {
    return this.ctx.selfId === this.ctx.ownerId
  }

  get policy(): PublishPolicy {
    return this.ctx.mesh.auth.policy
  }

  /** Whether a peer may publish: the owner, a granted key, or anyone under an open policy. */
  mayPublish(id: string): boolean {
    return mayPublishDoc(this.ctx.mesh.auth, this.ctx.mesh.pubKeyOf(id), id === this.ctx.ownerId)
  }

  get canShare(): boolean {
    return this.mayPublish(this.ctx.selfId)
  }

  /** The owner banned this peer. */
  get banned(): boolean {
    return isBanned(this.ctx.mesh.auth, this.ctx.mesh.pubKeyOf(this.ctx.selfId))
  }

  /** Asks the owner for the right to publish (or notes that it's already there). */
  requestPublish(): void {
    if (this.canShare) {
      this.requestState = 'granted'
      this.ctx.onGranted()
    } else if (!this.ctx.mesh.linkFor(this.ctx.ownerId)) {
      this.requestState = 'owner-away'
    } else {
      this.requestState = 'waiting'
      this.sendTo(this.ctx.ownerId, { t: 'publish-req' })
    }
    this.ctx.onChange()
  }

  cancelRequest(): void {
    // Withdrawn at the owner too, or it could still allow a request nobody is waiting on.
    if (this.requestState === 'waiting') this.sendTo(this.ctx.ownerId, { t: 'publish-cancel' })
    this.requestState = 'idle'
    this.ctx.onChange()
  }

  /** Owner: answers a request (or all of them). */
  async respond(id: string, answer: 'allow' | 'allow-all' | 'deny' | 'deny-all'): Promise<void> {
    if (!this.isOwner) return
    const mesh = this.ctx.mesh
    const pending = answer.endsWith('-all') ? [...this.requests.keys()] : [id]
    for (const p of pending) this.requests.delete(p)
    if (answer === 'allow' || answer === 'allow-all') {
      await mesh.updateAuth((doc) => {
        let d = answer === 'allow-all' ? setPolicy(doc, 'open') : doc
        for (const p of pending) {
          const key = mesh.pubKeyOf(p)
          if (key) d = grant(d, key)
        }
        return d
      })
    } else {
      if (answer === 'deny-all') await mesh.updateAuth((doc) => setPolicy(doc, 'closed'))
      for (const p of pending) this.sendTo(p, { t: 'publish-deny' })
    }
    this.ctx.onChange()
  }

  /** Owner: stops a member's stream and takes away its right to publish. */
  async revokePublisher(id: string): Promise<void> {
    const key = this.ctx.mesh.pubKeyOf(id)
    if (!this.isOwner || !key || id === this.ctx.ownerId) return
    await this.ctx.mesh.updateAuth((doc) => revoke(doc, key))
  }

  async setPolicy(policy: PublishPolicy): Promise<void> {
    if (!this.isOwner) return
    // 'deny-all' and 'allow-all' set the policy in the same auth update that answers the pending
    // requests: one version, one gossip round.
    if (policy === 'closed') await this.respond('', 'deny-all')
    else if (policy === 'open') await this.respond('', 'allow-all')
    else await this.ctx.mesh.updateAuth((doc) => setPolicy(doc, policy))
  }

  /** Owner: removes a member (members close their links, doors refuse it). */
  async kick(id: string): Promise<void> {
    const key = this.ctx.mesh.pubKeyOf(id)
    if (!this.isOwner || !key || id === this.ctx.ownerId) return
    await this.ctx.mesh.updateAuth((doc) => ban(doc, key))
  }

  /** The owner's decisions changed: a waiting request may have been granted. */
  onAuthChange(): void {
    if (this.requestState === 'waiting' && this.canShare) {
      this.requestState = 'granted'
      this.ctx.onGranted()
    }
  }

  onMemberLeave(id: string): void {
    this.requests.delete(id)
    if (id === this.ctx.ownerId && this.requestState === 'waiting') this.requestState = 'owner-away'
  }

  onLinkOpen(id: string): void {
    if (id === this.ctx.ownerId && this.requestState === 'owner-away') this.requestPublish()
  }

  handle(msg: RightsMsg, from: string): void {
    switch (msg.t) {
      case 'publish-req':
        if (!this.isOwner || this.mayPublish(from)) return
        if (this.policy === 'closed') this.sendTo(from, { t: 'publish-deny' })
        else if (this.policy === 'open') void this.respond(from, 'allow')
        else this.requests.set(from, { id: from, at: Date.now() })
        this.ctx.onChange()
        return
      case 'publish-cancel':
        if (this.isOwner && this.requests.delete(from)) this.ctx.onChange()
        return
      case 'publish-deny':
        if (from === this.ctx.ownerId && this.requestState === 'waiting') this.requestState = 'denied'
        this.ctx.onChange()
        return
    }
  }

  private sendTo(to: string, msg: PeerMsg): void {
    this.ctx.mesh.sendApp(to, msg)
  }
}
