import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Rendezvous } from '../src/net/bootstrap'
import { lobbyKeys, sealJson } from '../src/net/lobby'
import { seal } from '../src/mesh/envelope'
import { generateIdentity, type PeerIdentity } from '../src/mesh/identity'
import type { PeerConn } from '../src/mesh/meshConn'
import { resetTicker } from '../src/net/ticker'

/** A WebSocket stand-in that never connects; tests deliver tracker messages by hand. */
class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  constructor(public url: string) {
    FakeSocket.all.push(this)
  }
  send(): void {}
  close(): void {
    this.readyState = 3
  }
}

/** A connection whose acceptOffer waits until the test resolves it. */
function fakeConn() {
  let resolve: (sdp: string) => void = () => {}
  const accepted = new Promise<string>((r) => (resolve = r))
  const conn = { remoteId: '', offerer: '', close: vi.fn(), acceptOffer: vi.fn(() => accepted), createOffer: vi.fn(async () => 'v=0') }
  return { conn, resolve }
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 1))
  expect(cond()).toBe(true)
}

describe('Rendezvous lifecycle', () => {
  beforeEach(() => {
    FakeSocket.all = []
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetTicker()
  })

  it('opens no tracker sockets when closed while starting', async () => {
    const { identity } = await generateIdentity()
    const r = new Rendezvous({ joinCode: 'code', identity, iceServers: [], trackers: ['wss://t'] })
    const started = r.start()
    r.close()
    await started
    expect(FakeSocket.all).toHaveLength(0)
  })

  it('closes, rather than hands over, a connection whose answer finished after close', async () => {
    const { identity } = await generateIdentity()
    const { identity: other } = await generateIdentity()
    const conns: ReturnType<typeof fakeConn>[] = []
    const r = new Rendezvous({
      joinCode: 'code',
      identity,
      iceServers: [],
      trackers: ['wss://t'],
      connect: () => {
        const c = fakeConn()
        conns.push(c)
        return c.conn as unknown as PeerConn
      },
    })
    r.shouldAnswer = () => true
    const adopted = vi.fn()
    r.onConnection = adopted
    await r.start()

    const keys = await lobbyKeys('code')
    const env = await seal(other, { type: 'door-offer', peerId: other.id, offerId: 'o1', sdp: 'v=0' }, Infinity)
    const sdp = await sealJson(keys, 'offer', 'o1', env)
    FakeSocket.all[0].onmessage!({ data: JSON.stringify({ info_hash: keys.infoHash, peer_id: other.id, offer_id: 'o1', offer: { sdp } }) })
    await until(() => conns.length === 1 && conns[0].conn.acceptOffer.mock.calls.length === 1)

    r.close()
    conns[0].resolve('v=0 answer')
    await until(() => conns[0].conn.close.mock.calls.length > 0)
    expect(adopted).not.toHaveBeenCalled()
  })
})

describe('Rendezvous answering offers', () => {
  beforeEach(() => {
    FakeSocket.all = []
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetTicker()
  })

  async function setup(shouldAnswer: (id: string) => boolean) {
    const { identity } = await generateIdentity()
    const conns: ReturnType<typeof fakeConn>[] = []
    const r = new Rendezvous({
      joinCode: 'code',
      identity,
      iceServers: [],
      trackers: ['wss://t'],
      connect: () => {
        const c = fakeConn()
        c.resolve('v=0 answer')
        conns.push(c)
        return c.conn as unknown as PeerConn
      },
    })
    const asked: string[] = []
    r.shouldAnswer = (id) => {
      asked.push(id)
      return shouldAnswer(id)
    }
    const adopted = vi.fn()
    r.onConnection = adopted
    await r.start()
    const keys = await lobbyKeys('code')
    /** Delivers a door offer from `from` (signed by `signer`, sealed with `code`). */
    const offer = async (from: PeerIdentity, opts: { signer?: PeerIdentity; code?: string; offerId?: string } = {}) => {
      const offerId = opts.offerId ?? 'o-' + Math.random()
      const env = await seal(opts.signer ?? from, { type: 'door-offer', peerId: from.id, offerId, sdp: 'v=0' }, Infinity)
      const sealed = await sealJson(opts.code ? await lobbyKeys(opts.code) : keys, 'offer', offerId, env)
      FakeSocket.all[0].onmessage!({ data: JSON.stringify({ info_hash: keys.infoHash, peer_id: 'tracker-peer-id-xxxx', offer_id: offerId, offer: { sdp: sealed } }) })
    }
    return { r, identity, conns, asked, adopted, offer }
  }

  it('answers a verified offer only when shouldAnswer allows that peer', async () => {
    const { identity: yes } = await generateIdentity()
    const { identity: no } = await generateIdentity()
    const t = await setup((id) => id === yes.id)
    await t.offer(no)
    await until(() => t.asked.includes(no.id))
    await t.offer(yes)
    await until(() => t.adopted.mock.calls.length === 1)
    expect(t.conns).toHaveLength(1)
    expect(t.conns[0].conn.offerer).toBe(yes.id)
    t.r.close()
  })

  it('never asks about its own offers, forged ones, or ones sealed with another code', async () => {
    const { identity: other } = await generateIdentity()
    const { identity: forger } = await generateIdentity()
    const t = await setup(() => true)
    await t.offer(t.identity)
    await t.offer(other, { signer: forger }) // claims other's id, signed by someone else
    await t.offer(other, { code: 'another-code' })
    // A genuine offer afterwards is answered: the ones before it were dropped, not stuck.
    await t.offer(other)
    await until(() => t.adopted.mock.calls.length === 1)
    await new Promise((r) => setTimeout(r, 50)) // let any slower verification finish too
    expect(t.asked).toEqual([other.id])
    t.r.close()
  })
})
