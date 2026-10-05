declare module 'bittorrent-tracker' {
  import type { EventEmitter } from 'node:events'
  export class Server extends EventEmitter {
    constructor(opts: { udp?: boolean; http?: boolean; ws?: boolean; stats?: boolean; trustProxy?: boolean })
    listen(port: number, hostname?: string, cb?: () => void): void
    close(cb?: () => void): void
  }
}
