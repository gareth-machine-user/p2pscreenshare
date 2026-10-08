// This peer's copy of the owner's decisions (auth.ts): the latest signed document, the peer ids it
// bans, and, on the owner, the queue that applies new decisions and the copy kept across reloads.
import { emptyAuth, isBanned, type AuthDoc } from './auth'
import { open, seal, type Envelope } from './envelope'
import { peerIdOf, type PeerIdentity } from './identity'

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface AuthStateOptions {
  identity: PeerIdentity
  ownerId: string
  joinCode: string
  /** Where the owner keeps its decisions. Must not throw. */
  storage: KeyValueStore
  /** A newer document was accepted (`doc` and `env` are already updated). */
  onAccept: (env: Envelope) => void
}

export class AuthState {
  /** The owner's latest signed decisions (publish policy, grants, revocations, bans). */
  doc: AuthDoc = emptyAuth()
  /** `doc`'s envelope, to hand on. */
  env: Envelope | null = null
  /** Peer ids of banned keys, so a kicked peer is refused even before its record is known. */
  private bannedIds = new Set<string>()
  /** Owner decisions, applied one at a time so each builds on the one before. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private opts: AuthStateOptions) {}

  private get isOwner(): boolean {
    return this.opts.identity.id === this.opts.ownerId
  }

  private get storeKey(): string {
    return `p2pss:auth:${this.opts.joinCode}`
  }

  /** The owner keeps its decisions across reloads: picks up the saved ones. */
  async restore(): Promise<void> {
    if (!this.isOwner) return
    const saved = this.opts.storage.getItem(this.storeKey)
    try {
      if (saved) await this.accept(JSON.parse(saved) as Envelope)
    } catch {
      // corrupt entry: start without it
    }
  }

  /** Whether a peer is banned, by id or by its public key (if known). */
  isBanned(id: string, pubKey: string | undefined): boolean {
    return this.bannedIds.has(id) || isBanned(this.doc, pubKey)
  }

  /** Owner only: applies a change to the decisions and signs it. */
  update(change: (doc: AuthDoc) => AuthDoc): Promise<void> {
    if (!this.isOwner) return Promise.reject(new Error('only the owner decides'))
    // Queued: two decisions made at once must not both start from the same document (the later
    // one would undo the earlier).
    const run = this.queue.then(async () => {
      const doc = change(this.doc)
      if (doc === this.doc) return
      const env = await seal(this.opts.identity, doc)
      await this.accept(env)
    })
    // A failed change must not stall the ones after it.
    this.queue = run.catch(() => {})
    return run
  }

  /** Takes a document if it is the owner's and newer than the current one. */
  async accept(env: Envelope): Promise<void> {
    const opened = await open<AuthDoc>(env, 'auth')
    // Only the key pinned in the join code decides.
    if (!opened || opened.author !== this.opts.ownerId) return
    const bannedIds = new Set(await Promise.all(opened.body.banned.map((k) => peerIdOf(k))))
    // Checked and applied after the last await: of two documents in flight, the newer one wins
    // whichever finishes first.
    if (opened.body.version <= this.doc.version) return
    this.doc = opened.body
    this.env = env
    this.bannedIds = bannedIds
    if (this.isOwner) this.opts.storage.setItem(this.storeKey, JSON.stringify(env))
    this.opts.onAccept(env)
  }
}
