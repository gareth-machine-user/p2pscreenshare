// Offloads Reed-Solomon GF(256) erasure coding (packetize) and Ed25519 fragment signing
// (signFrame) from the main thread so high-bitrate 60 fps screen capture and carrier frame
// generation never contend with per-frame FEC and WebCrypto signing.
import { packetize, type EncodedFrame } from './packetizer'
import { signFrame } from '../proto/signing'

interface Scope {
  postMessage(msg: unknown, transfer?: Transferable[]): void
  onmessage: ((ev: MessageEvent) => void) | null
}

const scope = self as unknown as Scope
let signingKey: CryptoKey | null = null
let chain: Promise<void> = Promise.resolve()

scope.onmessage = (ev: MessageEvent) => {
  const d = ev.data as { op: string; key?: CryptoKey; frame?: EncodedFrame; k?: number; m?: number; id?: number }
  if (d.op === 'key') {
    signingKey = d.key ?? null
    return
  }
  if (d.op === 'frame' && d.frame) {
    const { frame, k, m, id } = d as { frame: EncodedFrame; k: number; m: number; id: number }
    chain = chain
      .then(async () => {
        if (!signingKey) return
        const stripes = packetize(frame, k, m, id)
        await signFrame(signingKey, stripes)
        const frags: ArrayBuffer[] = []
        for (const s of stripes) {
          for (const raw of s) {
            frags.push(raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength ? (raw.buffer as ArrayBuffer) : raw.slice().buffer)
          }
        }
        scope.postMessage({ frags }, frags)
      })
      .catch((e) => console.warn('packetizer worker signing failed', e))
  }
}
