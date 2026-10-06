// Host signatures on media fragments (Ed25519 over framing's signedRegion).
import { signatureOf, signedRegion } from './framing'

/** Signs every fragment of one packetized frame in place. */
export async function signFrame(key: CryptoKey, stripes: Uint8Array[][]): Promise<void> {
  await Promise.all(stripes.flat().map(async (raw) => signatureOf(raw).set(await sign(key, raw))))
}

export async function verifyFragment(key: CryptoKey, raw: Uint8Array): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signatureOf(raw).slice(), signedRegion(raw))
  } catch {
    return false
  }
}

async function sign(key: CryptoKey, raw: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, signedRegion(raw)))
}
