// The control channel the host and viewer sessions talk over. Phase 2 carries it on the mesh:
// every member already has a direct link to the owner, so the owner's star of control
// connections is just the owner's mesh links.
import type { Mesh } from '../mesh/mesh'
import { wallClock } from '../net/clock'

export interface ControlChannel<In, Out> {
  selfId: string
  send(msg: Out, to: string): void
  onMessage: (msg: In, from: string) => void
  onPeerJoin: (peerId: string) => void
  onPeerLeave: (peerId: string) => void
  /** Peers currently connected. */
  peers(): string[]
  /** Binary side channel (upload probe). Resolves once buffered for sending. */
  sendBinary(data: Uint8Array, to: string): Promise<void>
  onBinary: (data: Uint8Array, from: string) => void
  /** Clock sync (also a liveness check): resolves with the remote's wall clock. */
  requestClock(to: string, timeoutMs?: number): Promise<number>
  /** Whether the link to a peer is up and answering pings (the mesh pings every link). */
  isAlive(peerId: string): boolean
  /** Detaches this channel's handlers from the mesh. */
  close(): void
}

export { wallClock }

export function meshControl<In, Out>(mesh: Mesh): ControlChannel<In, Out> {
  let closed = false
  const ch: ControlChannel<In, Out> = {
    selfId: mesh.selfId,
    send: (msg, to) => {
      if (!closed) mesh.sendApp(to, msg)
    },
    onMessage: () => {},
    onPeerJoin: () => {},
    onPeerLeave: () => {},
    peers: () => [...mesh.conns.values()].filter((c) => c.isOpen).map((c) => c.remoteId),
    sendBinary: async (data, to) => {
      const c = mesh.linkFor(to)
      if (!c) throw new Error('not connected')
      await c.sendBin(data)
    },
    onBinary: () => {},
    requestClock: (to, timeoutMs = 3000) => {
      const c = mesh.linkFor(to)
      return c ? c.ping(timeoutMs) : Promise.reject(new Error('not connected'))
    },
    isAlive: (id) => !mesh.isSuspected(id),
    close: () => {
      closed = true
    },
  }
  const prev = { app: mesh.onApp, bin: mesh.onBinary, open: mesh.onLinkOpen, close: mesh.onLinkClose, leave: mesh.onMemberLeave }
  mesh.onApp = (m, from) => {
    prev.app(m, from)
    if (!closed) ch.onMessage(m as In, from)
  }
  mesh.onBinary = (d, from) => {
    prev.bin(d, from)
    if (!closed) ch.onBinary(d, from)
  }
  mesh.onLinkOpen = (id) => {
    prev.open(id)
    if (!closed) ch.onPeerJoin(id)
  }
  mesh.onLinkClose = (id) => {
    prev.close(id)
    if (!closed) ch.onPeerLeave(id)
  }
  mesh.onMemberLeave = (id) => {
    prev.leave(id)
    if (!closed) ch.onPeerLeave(id)
  }
  return ch
}
