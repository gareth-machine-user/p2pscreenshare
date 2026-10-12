// The carrier's pure parts (mesh/carrierLink.ts): SDP seeding and checks, the send cap, the send buffer's
// wake-ups and feature detection. The carrier itself needs a browser: e2e/ covers it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CARRIER_MAX_KBPS,
  CARRIER_MIN_CAP_KBPS,
  CARRIER_UNKNOWN_RTT_KBPS,
  CarrierBuffer,
  carrierCapKbps,
  carrierUnsupported,
  seedStartBitrate,
} from '../src/mesh/carrierLink'
import { BACKGROUND_BUFFER_MAX, LINK_BUFFER_HIGH, LINK_BUFFER_LOW } from '../src/net/link'

describe('seedStartBitrate', () => {
  const sdp = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98', 'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96', 'a=rtpmap:98 VP8/90000', 'a=fmtp:98 foo=1', ''].join('\r\n')

  it('adds the start bitrate to every VP8 format, in its fmtp line or a new one', () => {
    const out = seedStartBitrate(sdp, 2500).split('\r\n')
    expect(out).toContain('a=fmtp:96 x-google-start-bitrate=2500')
    expect(out).toContain('a=fmtp:98 foo=1;x-google-start-bitrate=2500')
    expect(out).toContain('a=fmtp:97 apt=96')
    expect(out.indexOf('a=fmtp:96 x-google-start-bitrate=2500')).toBe(out.indexOf('a=rtpmap:96 VP8/90000') + 1)
    // Idempotent, and a no-op without VP8.
    expect(seedStartBitrate(seedStartBitrate(sdp, 2500), 2500)).toBe(seedStartBitrate(sdp, 2500))
    expect(seedStartBitrate('v=0\r\na=rtpmap:111 opus/48000/2', 2500)).toBe('v=0\r\na=rtpmap:111 opus/48000/2')
  })
})

describe('carrierCapKbps', () => {
  it('lets a short path carry the most, a long one what keeps its packets in flight bounded', () => {
    expect(carrierCapKbps(1)).toBe(CARRIER_MAX_KBPS)
    expect(carrierCapKbps(0)).toBe(CARRIER_MAX_KBPS)
    expect(carrierCapKbps(300)).toBe(20_000)
    expect(carrierCapKbps(150)).toBe(40_000)
    expect(carrierCapKbps(5000)).toBe(CARRIER_MIN_CAP_KBPS)
  })

  it('holds to the long-path cap until the round trip is known', () => {
    expect(carrierCapKbps(null)).toBe(CARRIER_UNKNOWN_RTT_KBPS)
    expect(carrierCapKbps(NaN)).toBe(CARRIER_UNKNOWN_RTT_KBPS)
  })
})

describe('carrierUnsupported', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('names what is missing, or null', () => {
    expect(carrierUnsupported()).toBe('WebRTC')
    vi.stubGlobal('RTCPeerConnection', function () {})
    vi.stubGlobal('Worker', function () {})
    vi.stubGlobal('RTCRtpSender', Object.assign(function () {}, { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }] }) }))
    expect(carrierUnsupported()).toBe('WebRTC encoded transforms')
    vi.stubGlobal('RTCRtpScriptTransform', function () {})
    vi.stubGlobal('HTMLCanvasElement', Object.assign(function () {}, { prototype: { captureStream() {} } }))
    expect(carrierUnsupported()).toBe('the VP8 codec')
    vi.stubGlobal('RTCRtpSender', Object.assign(function () {}, { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }) }))
    expect(carrierUnsupported()).toBeNull()
  })
})

describe('CarrierBuffer', () => {
  /** A buffer at `kbps` holding `amount` bytes. */
  function holding(kbps: number, amount: number): CarrierBuffer {
    const b = new CarrierBuffer()
    b.rateKbps = kbps
    b.handed = amount
    return b
  }

  it('scales its marks with the rate, never below the link defaults', () => {
    expect(holding(1000, 0).high).toBe(LINK_BUFFER_HIGH)
    expect(holding(1000, 0).low).toBe(LINK_BUFFER_LOW)
    // 40 Mbps: 120 ms is 600 KB, its low mark well above BACKGROUND_BUFFER_MAX.
    expect(holding(40_000, 0).high).toBe(600_000)
    expect(holding(40_000, 0).low).toBe(150_000)
  })

  it('wakes the uplink once as the buffer falls through the low mark', () => {
    const b = holding(1000, 60_000)
    expect(b.pack(10_000)).toBe(false)
    expect(b.pack(40_000)).toBe(true)
    expect(b.pack(5_000)).toBe(false)
  })

  it('also wakes it through BACKGROUND_BUFFER_MAX when the low mark is above that (replays wait for it)', () => {
    const b = holding(40_000, 400_000)
    expect(b.pack(260_000)).toBe(true) // through 150 KB
    expect(b.pack(70_000)).toBe(false) // 70 KB
    expect(b.pack(10_000)).toBe(true) // through 64 KiB
    expect(b.amount).toBeLessThanOrEqual(BACKGROUND_BUFFER_MAX)
    expect(b.pack(50_000)).toBe(false)
  })

  it('wakes it when a higher rate raises the high mark over what it holds', () => {
    // 10 Mbps: high 150 KB; the uplink stopped at 160 KB, past it.
    const b = holding(10_000, 160_000)
    expect(b.setRate(9000)).toBe(false) // lower: nothing more fits
    expect(b.setRate(20_000)).toBe(true) // high 300 KB: room again
    expect(b.setRate(20_000)).toBe(false) // unchanged: no repeat
    // Higher, but still under what it holds: the drain wakes it.
    expect(holding(1000, 200_000).setRate(2000)).toBe(false)
  })
})
