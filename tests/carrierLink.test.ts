// The carrier's pure parts (mesh/carrierLink.ts): SDP seeding and feature detection. The carrier
// itself needs a browser: e2e/ covers it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { carrierUnsupported, seedStartBitrate } from '../src/mesh/carrierLink'

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
