// Peer identity: an Ed25519 key per lobby, persisted in localStorage so a reload rejoins as the same
// peer (and keeps its publish grant). A peer's id is a hash of its public key, so any claim signed
// by a key is bound to exactly one peer id. The owner's key is the host key derived from the owner
// seed (see net/lobby.ts), whose public half is pinned in the join code.
import { fromBase64Url, hostIdentity, toBase64Url } from '../net/lobby'
import { storageGet, storageSet } from '../util/storage'

export interface PeerIdentity {
  /** 20 characters, base64url of the first 15 bytes of SHA-256(public key). */
  id: string
  /** Raw 32-byte public key, base64url. */
  pubKey: string
  privateKey: CryptoKey
}

const enc = new TextEncoder()

const idCache = new Map<string, Promise<string>>()
const keyCache = new Map<string, Promise<CryptoKey | null>>()

/** The peer id belonging to a public key. */
export function peerIdOf(pubKey: string): Promise<string> {
  let p = idCache.get(pubKey)
  if (!p) {
    p = (async () => {
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64Url(pubKey)))
      return toBase64Url(hash.subarray(0, 15))
    })()
    idCache.set(pubKey, p)
  }
  return p
}

export function importPublicKey(pubKey: string): Promise<CryptoKey | null> {
  let p = keyCache.get(pubKey)
  if (!p) {
    p = (async () => {
      try {
        const raw = fromBase64Url(pubKey)
        if (raw.length !== 32) return null
        return await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, true, ['verify'])
      } catch {
        // bad base64 or not a valid key
        return null
      }
    })()
    keyCache.set(pubKey, p)
  }
  return p
}

export async function signBytes(key: CryptoKey, data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data
  return toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, bytes as Uint8Array<ArrayBuffer>)))
}

export async function verifyBytes(pubKey: string, sig: string, data: string | Uint8Array): Promise<boolean> {
  const key = await importPublicKey(pubKey)
  if (!key) return false
  try {
    const bytes = typeof data === 'string' ? enc.encode(data) : data
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64Url(sig), bytes as Uint8Array<ArrayBuffer>)
  } catch {
    // malformed signature
    return false
  }
}

async function identityFromKey(privateKey: CryptoKey): Promise<PeerIdentity> {
  const { x } = await crypto.subtle.exportKey('jwk', privateKey)
  return { id: await peerIdOf(x!), pubKey: x!, privateKey }
}

export async function generateIdentity(): Promise<{ identity: PeerIdentity; jwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  return { identity: await identityFromKey(pair.privateKey), jwk }
}

/** The owner's identity: the host key derived from the lobby seed. */
export async function ownerIdentity(seed: string): Promise<PeerIdentity> {
  return identityFromKey((await hostIdentity(seed)).signingKey)
}

/** The owner's peer id, from the public key pinned in a join code. */
export async function ownerIdFromCode(joinCode: string): Promise<string | null> {
  const dot = joinCode.lastIndexOf('.')
  if (dot < 0) return null
  const pub = joinCode.slice(dot + 1)
  return (await importPublicKey(pub)) ? peerIdOf(pub) : null
}

/**
 * This tab's identity in a lobby: persisted per lobby. Two tabs of one browser would share the
 * stored key (and so the peer id), so a second tab that can't take the lock uses a fresh key.
 */
export async function loadIdentity(joinCode: string): Promise<PeerIdentity> {
  const storeKey = `p2pss:peer:${joinCode}`
  if (await claimTabLock(storeKey)) {
    const raw = storageGet(storeKey)
    try {
      if (raw) {
        const key = await crypto.subtle.importKey('jwk', JSON.parse(raw) as JsonWebKey, { name: 'Ed25519' }, true, ['sign'])
        return await identityFromKey(key)
      }
    } catch {
      // unreadable stored key: make a new one
    }
    const { identity, jwk } = await generateIdentity()
    // Without storage, this identity lasts for this page only.
    storageSet(storeKey, JSON.stringify(jwk))
    return identity
  }
  return (await generateIdentity()).identity
}

/** Holds a named Web Lock for the page's lifetime; false if another tab holds it. */
function claimTabLock(name: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.locks) return Promise.resolve(true)
  return new Promise((resolve) => {
    navigator.locks
      .request(name, { ifAvailable: true }, (lock) => {
        resolve(lock !== null)
        // Keep the lock until the page goes away.
        return lock ? new Promise<void>(() => {}) : undefined
      })
      .catch(() => resolve(true))
  })
}
