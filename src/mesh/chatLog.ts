// The lobby chat: signed messages, the last CHAT_KEEP of them ordered by time, each with its
// envelope so it can be handed on (to joiners, and to peers the sender can't reach directly).
import { open, seal, type Envelope, type Typed } from './envelope'
import type { PeerIdentity } from './identity'

export const CHAT_KEEP = 50
export const CHAT_MAX_LEN = 500
/**
 * Most a chat message's (sender-chosen) time may be ahead of this peer's clock. The log is ordered
 * by it, so a message dated far ahead would never be evicted and would push every newer one out.
 */
const CHAT_MAX_FUTURE_MS = 60_000
const CHAT_RATE = { count: 5, perMs: 5000 }

interface ChatBody extends Typed {
  type: 'chat'
  id: string
  from: string
  name: string
  text: string
  at: number
}

export interface ChatMessage {
  id: string
  from: string
  name: string
  text: string
  at: number
}

/** Sliding-window rate limit. */
class RateWindow {
  private times: number[] = []

  constructor(private rate: { count: number; perMs: number }) {}

  /** Counts an event at `now`; false (and not counted) if the window is already full. */
  take(now: number): boolean {
    this.times = this.times.filter((t) => now - t < this.rate.perMs)
    if (this.times.length >= this.rate.count) return false
    this.times.push(now)
    return true
  }
}

export interface ChatLogOptions {
  identity: PeerIdentity
  /** Messages from these authors are refused. */
  isBanned: (id: string) => boolean
  /** A message was added to the log. */
  onChat: (m: ChatMessage) => void
}

export class ChatLog {
  /** The kept messages, ordered by time. */
  messages: ChatMessage[] = []
  /** `messages` with each one's envelope. */
  private log: { m: ChatMessage; env: Envelope }[] = []
  private sent = new RateWindow(CHAT_RATE)
  private byAuthor = new Map<string, RateWindow>()

  constructor(private opts: ChatLogOptions) {}

  get length(): number {
    return this.log.length
  }

  /**
   * Signs and keeps a message of this peer's; resolves to its envelope, for the caller to send.
   * Null if it is empty or this peer is sending too fast.
   */
  send(text: string, name: string): Promise<Envelope> | null {
    const trimmed = text.trim().slice(0, CHAT_MAX_LEN)
    if (!trimmed || !this.sent.take(performance.now())) return null
    const body: ChatBody = { type: 'chat', id: crypto.randomUUID(), from: this.opts.identity.id, name, text: trimmed, at: Date.now() }
    return seal(this.opts.identity, body).then((env) => {
      this.store(body, env)
      return env
    })
  }

  /**
   * Takes a received message; resolves to its author if it was new and kept (the caller may hand it
   * on), else null. `history`: part of a link's initial snapshot, so not rate limited by arrival time.
   */
  async receive(env: Envelope, history = false): Promise<string | null> {
    const opened = await open<ChatBody>(env, 'chat')
    if (!opened) return null
    const b = opened.body
    if (b.from !== opened.author || typeof b.id !== 'string' || typeof b.name !== 'string' || typeof b.at !== 'number') return null
    if (typeof b.text !== 'string' || b.text.length > CHAT_MAX_LEN) return null
    if (!Number.isFinite(b.at) || b.at > Date.now() + CHAT_MAX_FUTURE_MS) return null
    if (this.opts.isBanned(b.from)) return null
    if (this.messages.some((m) => m.id === b.id)) return null
    if (!history) {
      // Senders are rate limited by everyone, so a flooding member can't drown the chat.
      let limit = this.byAuthor.get(b.from)
      if (!limit) this.byAuthor.set(b.from, (limit = new RateWindow(CHAT_RATE)))
      if (!limit.take(performance.now())) return null
    }
    // One older than the whole log is dropped (and not handed on).
    return this.store(b, env) ? b.from : null
  }

  envelopes(): Envelope[] {
    return this.log.map((e) => e.env)
  }

  /** Adds a message to the log; false if it is older than all CHAT_KEEP kept ones (so not kept). */
  private store(b: ChatBody, env: Envelope): boolean {
    const entry = { m: { id: b.id, from: b.from, name: b.name, text: b.text, at: b.at }, env }
    // Stable sort: among equal times, the newcomer stays last (and so is kept).
    this.log = [...this.log, entry].sort((x, y) => x.m.at - y.m.at).slice(-CHAT_KEEP)
    this.messages = this.log.map((e) => e.m)
    if (!this.log.includes(entry)) return false
    this.opts.onChat(entry.m)
    return true
  }
}
