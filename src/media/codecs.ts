/**
 * Closes a WebCodecs encoder or decoder unless it already is. Best effort: an error closes a codec
 * on its own, a failed configure may have too, and the codec is being discarded either way.
 */
export function closeCodec(codec: { state: CodecState; close(): void } | null | undefined): void {
  try {
    if (codec && codec.state !== 'closed') codec.close()
  } catch {
    // Nothing left to release.
  }
}
