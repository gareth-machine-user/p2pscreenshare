import { describe, expect, it } from 'vitest'
import { hostIdentity, hostKeyFromCode } from '../src/net/lobby'
import { packetize, type EncodedFrame } from '../src/media/packetizer'
import { decodeFragment, withReplayFlag } from '../src/proto/framing'
import { signFrame, verifyFragment } from '../src/proto/signing'
import { RelayNode } from '../src/relay/relayNode'
import type { Uplink } from '../src/net/uplink'

const host = await hostIdentity('seed-a')
const hostKey = (await hostKeyFromCode(host.joinCode))!
const impostor = await hostIdentity('seed-b')

function frame(over: Partial<EncodedFrame> = {}): EncodedFrame {
  return {
    epoch: 1,
    seq: 7,
    gopId: 7,
    refSeq: 0xffffffff,
    key: true,
    layer: 0,
    audio: false,
    captureTime: 1000,
    data: crypto.getRandomValues(new Uint8Array(40_000)),
    ...over,
  }
}

async function signed(f = frame(), key = host.signingKey): Promise<Uint8Array[][]> {
  const stripes = packetize(f, 2, 1)
  await signFrame(key, stripes, f.audio)
  return stripes
}

describe('fragment signatures', () => {
  it('verifies every signed fragment, including GOP-cache replays', async () => {
    const all = (await signed()).flat()
    expect(all.length).toBeGreaterThan(3)
    for (const raw of all) {
      expect(await verifyFragment(hostKey, raw)).toBe(true)
      expect(await verifyFragment(hostKey, withReplayFlag(raw))).toBe(true)
    }
  })

  it('shares one signature across the per-stripe copies of an audio frame', async () => {
    const stripes = await signed(frame({ audio: true, key: false, data: new Uint8Array(120) }))
    for (const [raw] of stripes) expect(await verifyFragment(hostKey, raw)).toBe(true)
  })

  it('rejects unsigned, impostor-signed, and tampered fragments', async () => {
    const raw = (await signed())[0][0]
    expect(await verifyFragment(hostKey, packetize(frame(), 2, 1)[0][0])).toBe(false)
    expect(await verifyFragment(hostKey, (await signed(frame(), impostor.signingKey))[0][0])).toBe(false)
    for (const offset of [4, 16, 26, 40, raw.length - 70, raw.length - 1]) {
      const bad = raw.slice()
      bad[offset] ^= 1
      expect(await verifyFragment(hostKey, bad), `byte ${offset}`).toBe(false)
    }
  })

  it('rejects a video piece moved to another stripe', async () => {
    const moved = (await signed())[0][0].slice()
    moved[27] = 1 // stripe isn't signed, but video piece i must travel on stripe i
    expect(decodeFragment(moved)).toBeNull()
  })
})

describe('relay verification', () => {
  const uplink = { send: () => {} } as unknown as Uplink
  const settle = () => new Promise((r) => setTimeout(r, 20))

  function relay(): { node: RelayNode; got: number[] } {
    const node = new RelayNode(uplink, () => undefined)
    const got: number[] = []
    node.onFragment = (f) => got.push(f.header.frameSeq)
    return { node, got }
  }

  it('drops everything without a verifier (fails closed)', async () => {
    const { node, got } = relay()
    node.receive((await signed())[0][0], 'p')
    await settle()
    expect(got).toEqual([])
  })

  it('a forged fragment neither plays nor shadows the genuine one', async () => {
    const { node, got } = relay()
    node.verifier = (raw) => verifyFragment(hostKey, raw)
    const genuine = (await signed())[0][0]
    const forged = genuine.slice()
    forged[40] ^= 0xff
    node.receive(forged, 'evil')
    await settle()
    expect(got).toEqual([])
    expect(node.rejected).toBe(1)
    node.receive(genuine, 'p')
    await settle()
    expect(got).toEqual([7])
  })

  it('drops signed fragments replayed from outside the de-dup window', async () => {
    const { node, got } = relay()
    node.verifier = (raw) => verifyFragment(hostKey, raw)
    const old = (await signed(frame({ seq: 1, captureTime: 1000 })))[0][0]
    node.receive((await signed(frame({ seq: 2, captureTime: 20_000 })))[0][0], 'p')
    await settle()
    node.receive(old, 'evil')
    await settle()
    expect(got).toEqual([2])
  })
})
