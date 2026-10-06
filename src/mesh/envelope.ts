// Signed envelopes for everything peers claim about themselves (gossip records, chat, mesh
// signaling, channel announcements) and everything the owner decides (grants, policy). The author's
// public key travels with the envelope, so any peer can verify and forward it; the author's peer id
// is derived from that key. Large bodies are gzipped (CompressionStream) before signing.
import { fromBase64Url, toBase64Url } from '../net/lobby'
import { peerIdOf, signBytes, verifyBytes, type PeerIdentity } from './identity'

export interface Envelope {
  /** Author's public key (base64url). */
  k: string
  /** Body: JSON, or base64url gzip of the JSON when `z` is set. */
  b: string
  z?: 1
  /** Ed25519 signature over `DOMAIN + b`. */
  s: string
}

/** Every body names its type, so an envelope of one kind can't be replayed as another. */
export interface Typed {
  type: string
}

const DOMAIN = 'p2pscreenshare:env:v1\n'
/** Bodies above this many bytes are compressed. */
export const COMPRESS_OVER = 1024
/**
 * Most bytes a gzipped body may inflate to (a member's record, chat, the owner's decisions and
 * topology reports are all far smaller), so a tiny "gzip bomb" can't exhaust memory.
 */
export const MAX_INFLATED_BYTES = 4 * 1024 * 1024

export async function seal<T extends Typed>(id: PeerIdentity, body: T, compressOver = COMPRESS_OVER): Promise<Envelope> {
  const json = JSON.stringify(body)
  const z = json.length > compressOver
  const b = z ? toBase64Url(await gzip(json)) : json
  return { k: id.pubKey, b, ...(z ? { z: 1 as const } : {}), s: await signBytes(id.privateKey, DOMAIN + b) }
}

export interface Opened<T> {
  /** The author's peer id. */
  author: string
  body: T
}

/** Verifies and decodes an envelope; null if the signature, encoding or type is wrong. */
export async function open<T extends Typed>(env: unknown, type: T['type']): Promise<Opened<T> | null> {
  if (!isEnvelope(env)) return null
  if (!(await verifyBytes(env.k, env.s, DOMAIN + env.b))) return null
  try {
    const json = env.z ? await gunzip(fromBase64Url(env.b)) : env.b
    const body = JSON.parse(json) as T
    if (!body || body.type !== type) return null
    return { author: await peerIdOf(env.k), body }
  } catch {
    return null
  }
}

function isEnvelope(x: unknown): x is Envelope {
  const e = x as Envelope
  return !!e && typeof e.k === 'string' && typeof e.b === 'string' && typeof e.s === 'string'
}

/** Approximate wire size, for stats. */
export function envelopeBytes(env: Envelope): number {
  return env.k.length + env.b.length + env.s.length + 24
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Inflates gzip to text; rejects once the output would exceed `maxBytes`. */
export async function gunzip(bytes: Uint8Array, maxBytes = MAX_INFLATED_BYTES): Promise<string> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      void reader.cancel().catch(() => {})
      throw new Error(`gzip body inflates past ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(out)
}
