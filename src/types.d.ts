// Chromium-only (main thread) insertable streams API used for frame capture.
declare class MediaStreamTrackProcessor<T = VideoFrame> {
  constructor(init: { track: MediaStreamTrack; maxBufferSize?: number })
  readonly readable: ReadableStream<T>
}

interface Window {
  /** Debug/e2e hook: the active session. */
  __p2p?: unknown
  /** Debug/e2e hook: the lobby mesh. */
  __mesh?: unknown
}
