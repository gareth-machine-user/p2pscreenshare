// Mixes system/tab audio and the microphone into one track with WebAudio, so a stream carries a
// single Opus track. The two mute buttons are gain nodes: muting never restarts anything.

export class AudioMixer {
  readonly track: MediaStreamTrack
  readonly hasSystem: boolean
  readonly hasMic: boolean
  private ctx: AudioContext
  private systemGain: GainNode | null = null
  private micGain: GainNode | null = null
  systemMuted = false
  micMuted = false

  constructor(system: MediaStreamTrack | null, mic: MediaStreamTrack | null) {
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    const dest = this.ctx.createMediaStreamDestination()
    const wire = (track: MediaStreamTrack) => {
      const gain = this.ctx.createGain()
      this.ctx.createMediaStreamSource(new MediaStream([track])).connect(gain).connect(dest)
      return gain
    }
    if (system) this.systemGain = wire(system)
    if (mic) this.micGain = wire(mic)
    this.hasSystem = !!system
    this.hasMic = !!mic
    void this.ctx.resume()
    this.track = dest.stream.getAudioTracks()[0]
  }

  setSystemMuted(muted: boolean): void {
    this.systemMuted = muted
    if (this.systemGain) this.systemGain.gain.value = muted ? 0 : 1
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted
    if (this.micGain) this.micGain.gain.value = muted ? 0 : 1
  }

  close(): void {
    this.track.stop()
    void this.ctx.close()
  }
}

export async function captureMic(): Promise<MediaStreamTrack | null> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    return s.getAudioTracks()[0] ?? null
  } catch (e) {
    console.warn('microphone unavailable', e)
    return null
  }
}
