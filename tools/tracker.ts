// Local WebTorrent (WebSocket) tracker for development and e2e tests.
// Usage: npm run tracker [-- --port 8000]   then open the app with ?tracker=ws://localhost:8000
import { Server } from 'bittorrent-tracker'

const portArg = process.argv.indexOf('--port')
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : Number(process.env.TRACKER_PORT ?? 8000)

const server = new Server({ udp: false, http: false, ws: true, stats: false, trustProxy: false })
server.on('error', (err: Error) => console.error('tracker error:', err.message))
server.on('warning', (err: Error) => console.warn('tracker warning:', err.message))
server.on('listening', () => console.log(`WebTorrent tracker listening on ws://localhost:${port}`))
server.listen(port, '0.0.0.0')
