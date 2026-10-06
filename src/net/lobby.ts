// Lobby secrets and host identity.
//
// The host's URL carries a private seed (`#/host?stream=<seed>`). From it the host derives a lobby
// secret and an Ed25519 signing key. The viewer link carries the join code
// `#/watch/<secret>.<host public key>`; both URLs keep these in the fragment, so they never reach
// a server. From the join code, everyone derives:
//  - the tracker info_hash, so trackers only ever see a one-way derivative of the code;
//  - an AES-GCM key sealing the SDP offers/answers relayed by trackers. Without the code, a peer
//    scanning a tracker can't read an offer (peer addresses), produce an answer the host accepts,
//    or swap the DTLS fingerprints to sit in the middle. Since the SDPs authenticate the DTLS
//    fingerprints, the control connections (and the tree links signaled over them) are only ever
//    with peers that hold the code, and DTLS encrypts every hop.
// The pinned public key makes the stream tamper-proof against viewers, who all hold the code: the
// host signs its offers (so only the host can be the host) and every media fragment (so relays
// can't forge or alter what they forward).

const enc = new TextEncoder()
const dec = new TextDecoder()
const IV_BYTES = 12
/** DER prefix turning a 32-byte Ed25519 seed into a PKCS#8 private key. */
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

export interface LobbyKeys {
  /** 20-byte "binary string", as the WebTorrent tracker protocol expects. */
  infoHash: string
  sdp: CryptoKey
}

export interface SignalBody {
  /** The sender's peer id (authenticated, unlike the tracker's peer_id field). */
  peerId: string
  sdp: string
  /** Offers only: the host's signature over the offer (see offerMessage). */
  sig?: string
}

export interface HostIdentity {
  joinCode: string
  signingKey: CryptoKey
}

/** A fresh 128-bit seed for a host URL, base64url (22 chars). */
export function newHostSeed(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
}

/** Derives the lobby's join code and the host's signing key from the host's private seed. */
export async function hostIdentity(seed: string): Promise<HostIdentity> {
  const ikm = await hkdfKey(seed)
  const secret = new Uint8Array(await crypto.subtle.deriveBits(hkdf('join'), ikm, 128))
  const signSeed = new Uint8Array(await crypto.subtle.deriveBits(hkdf('sign'), ikm, 256))
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32)
  pkcs8.set(ED25519_PKCS8_PREFIX)
  pkcs8.set(signSeed, ED25519_PKCS8_PREFIX.length)
  const signingKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
  // WebCrypto can't derive a public key directly, but the private JWK carries it (`x`, base64url).
  const { x } = await crypto.subtle.exportKey('jwk', signingKey)
  return { joinCode: `${toBase64Url(secret)}.${x}`, signingKey }
}

/** The host's public key pinned in a join code, or null if the code doesn't pin one. */
export async function hostKeyFromCode(code: string): Promise<CryptoKey | null> {
  const dot = code.lastIndexOf('.')
  if (dot < 0) return null
  try {
    const raw = fromBase64Url(code.slice(dot + 1))
    if (raw.length !== 32) return null
    return await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, true, ['verify'])
  } catch {
    // bad base64 or not a valid key
    return null
  }
}

export async function lobbyKeys(code: string): Promise<LobbyKeys> {
  const ikm = await hkdfKey(code)
  const hash = new Uint8Array(await crypto.subtle.deriveBits(hkdf('rendezvous'), ikm, 160))
  const sdp = await crypto.subtle.deriveKey(hkdf('sdp'), ikm, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  return { infoHash: String.fromCharCode(...hash), sdp }
}

/** Seals an offer or answer for the tracker. Bound to its direction and offer id. */
export async function sealSignal(keys: LobbyKeys, kind: 'offer' | 'answer', offerId: string, body: SignalBody): Promise<string> {
  return sealJson(keys, kind, offerId, body)
}

/** Opens a sealed offer or answer; null if it wasn't sealed with this lobby's code. */
export async function openSignal(
  keys: LobbyKeys,
  kind: 'offer' | 'answer',
  offerId: string,
  sealed: string,
): Promise<SignalBody | null> {
  const body = (await openJson(keys, kind, offerId, sealed)) as Partial<SignalBody> | null
  if (!body || typeof body.peerId !== 'string' || typeof body.sdp !== 'string') return null
  return { peerId: body.peerId, sdp: body.sdp, ...(typeof body.sig === 'string' ? { sig: body.sig } : {}) }
}

/** Seals any JSON value for the tracker, bound to its direction and offer id (AES-GCM). */
export async function sealJson(keys: LobbyKeys, kind: 'offer' | 'answer', offerId: string, body: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(`${kind}:${offerId}`) },
    keys.sdp,
    enc.encode(JSON.stringify(body)),
  )
  const out = new Uint8Array(IV_BYTES + ct.byteLength)
  out.set(iv)
  out.set(new Uint8Array(ct), IV_BYTES)
  return toBase64Url(out)
}

/** Opens a value sealed with sealJson; null if it wasn't sealed with this lobby's code. */
export async function openJson(keys: LobbyKeys, kind: 'offer' | 'answer', offerId: string, sealed: string): Promise<unknown> {
  try {
    const raw = fromBase64Url(sealed)
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, IV_BYTES), additionalData: enc.encode(`${kind}:${offerId}`) },
      keys.sdp,
      raw.subarray(IV_BYTES),
    )
    return JSON.parse(dec.decode(pt))
  } catch {
    // wrong key (no join code) or tampered
    return null
  }
}

/** Signs an offer as the host (sets `body.sig`). */
export async function signOffer(signingKey: CryptoKey, offerId: string, body: SignalBody): Promise<SignalBody> {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, signingKey, offerMessage(offerId, body))
  return { ...body, sig: toBase64Url(new Uint8Array(sig)) }
}

/** Whether an offer was signed by the pinned host key. */
export async function verifyOffer(hostKey: CryptoKey, offerId: string, body: SignalBody): Promise<boolean> {
  if (!body.sig) return false
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, hostKey, fromBase64Url(body.sig), offerMessage(offerId, body))
  } catch {
    // malformed signature
    return false
  }
}

function offerMessage(offerId: string, body: SignalBody): Uint8Array<ArrayBuffer> {
  return enc.encode(JSON.stringify(['p2pscreenshare:offer:v1', offerId, body.peerId, body.sdp]))
}

function hkdfKey(material: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(material), 'HKDF', false, ['deriveBits', 'deriveKey'])
}

function hkdf(info: string): HkdfParams {
  return { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('p2pscreenshare:v2'), info: enc.encode(info) }
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
