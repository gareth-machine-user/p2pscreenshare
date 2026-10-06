// The owner's decisions about the lobby: who may publish, and who is out. The owner key pinned in
// the join code is the root of trust; this document is signed by it and gossiped to everyone,
// including later joiners, so it keeps working while the owner is away. Pure, for unit tests.
import type { Typed } from './envelope'

export type PublishPolicy = 'open' | 'ask' | 'closed'

export interface Grant {
  /** The grantee's public key: a copied grant is useless without the matching private key. */
  peerKey: string
  caps: ['present']
  issuedAt: number
}

export interface AuthDoc extends Typed {
  type: 'auth'
  /** Strictly increasing (wall-clock based), so the newest decision wins everywhere. */
  version: number
  /** `open`: any member may publish without a grant (Allow all). `closed`: requests are refused (Deny all). */
  policy: PublishPolicy
  grants: Grant[]
  /** Revoked publisher keys: relays drop their channels. */
  revoked: string[]
  /** Kicked keys: members close their mesh links to them. */
  banned: string[]
}

export function emptyAuth(): AuthDoc {
  return { type: 'auth', version: 0, policy: 'ask', grants: [], revoked: [], banned: [] }
}

/** Whether the holder of `peerKey` may publish (the owner always may). */
export function mayPublish(doc: AuthDoc, peerKey: string | undefined, isOwner: boolean): boolean {
  if (isOwner) return true
  if (!peerKey || doc.revoked.includes(peerKey) || doc.banned.includes(peerKey)) return false
  return doc.policy === 'open' || doc.grants.some((g) => g.peerKey === peerKey && g.caps.includes('present'))
}

export function isBanned(doc: AuthDoc, peerKey: string | undefined): boolean {
  return !!peerKey && doc.banned.includes(peerKey)
}

// --- owner-side edits (each returns a new document with a newer version) -----------------------

function next(doc: AuthDoc, patch: Partial<AuthDoc>): AuthDoc {
  return { ...doc, ...patch, version: Math.max(doc.version + 1, Date.now()) }
}

export function grant(doc: AuthDoc, peerKey: string): AuthDoc {
  if (doc.grants.some((g) => g.peerKey === peerKey) && !doc.revoked.includes(peerKey)) return doc
  return next(doc, {
    grants: [...doc.grants.filter((g) => g.peerKey !== peerKey), { peerKey, caps: ['present'], issuedAt: Date.now() }],
    revoked: doc.revoked.filter((k) => k !== peerKey),
  })
}

/** Takes away the right to publish; with an open policy, the key stays revoked until re-granted. */
export function revoke(doc: AuthDoc, peerKey: string): AuthDoc {
  return next(doc, {
    grants: doc.grants.filter((g) => g.peerKey !== peerKey),
    revoked: doc.revoked.includes(peerKey) ? doc.revoked : [...doc.revoked, peerKey],
  })
}

export function setPolicy(doc: AuthDoc, policy: PublishPolicy): AuthDoc {
  return doc.policy === policy ? doc : next(doc, { policy })
}

export function ban(doc: AuthDoc, peerKey: string): AuthDoc {
  if (doc.banned.includes(peerKey)) return doc
  return next(doc, {
    banned: [...doc.banned, peerKey],
    grants: doc.grants.filter((g) => g.peerKey !== peerKey),
  })
}
