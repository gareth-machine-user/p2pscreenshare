// Lobby secrets. The join code is the stream id in the viewer link (`#/watch/<code>`); it lives in
// the URL fragment, so it never reaches a server. Everything else is derived from it:
//  - the tracker info_hash, so trackers only ever see a one-way derivative of the code;
//  - an AES-GCM key sealing the SDP offers/answers relayed by trackers. Without the code, a peer
//    scanning a tracker can't read an offer (peer addresses), produce an answer the host accepts,
//    or swap the DTLS fingerprints to sit in the middle. Since the SDPs authenticate the DTLS
//    fingerprints, the control connections (and the tree links signaled over them) are only ever
//    with peers that hold the code, and DTLS encrypts every hop.

const enc = new TextEncoder()
const dec = new TextDecoder()
const IV_BYTES = 12

export interface LobbyKeys {
  /** 20-byte "binary string", as the WebTorrent tracker protocol expects. */
  infoHash: string
  sdp: CryptoKey
}

export interface SignalBody {
  /** The sender's peer id (authenticated, unlike the tracker's peer_id field). */
  peerId: string
  sdp: string
}

/** A fresh 128-bit join code, base64url (22 chars). */
export function newJoinCode(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
}

export async function lobbyKeys(code: string): Promise<LobbyKeys> {
  const ikm = await crypto.subtle.importKey('raw', enc.encode(code), 'HKDF', false, ['deriveBits', 'deriveKey'])
  const params = (info: string): HkdfParams => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: enc.encode('p2pscreenshare:v2'),
    info: enc.encode(info),
  })
  const hash = new Uint8Array(await crypto.subtle.deriveBits(params('rendezvous'), ikm, 160))
  const sdp = await crypto.subtle.deriveKey(params('sdp'), ikm, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  return { infoHash: String.fromCharCode(...hash), sdp }
}

/** Seals an offer or answer for the tracker. Bound to its direction and offer id. */
export async function sealSignal(keys: LobbyKeys, kind: 'offer' | 'answer', offerId: string, body: SignalBody): Promise<string> {
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

/** Opens a sealed offer or answer; null if it wasn't sealed with this lobby's code. */
export async function openSignal(
  keys: LobbyKeys,
  kind: 'offer' | 'answer',
  offerId: string,
  sealed: string,
): Promise<SignalBody | null> {
  try {
    const raw = fromBase64Url(sealed)
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, IV_BYTES), additionalData: enc.encode(`${kind}:${offerId}`) },
      keys.sdp,
      raw.subarray(IV_BYTES),
    )
    const body = JSON.parse(dec.decode(pt)) as Partial<SignalBody>
    if (typeof body.peerId !== 'string' || typeof body.sdp !== 'string') return null
    return { peerId: body.peerId, sdp: body.sdp }
  } catch {
    return null
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
