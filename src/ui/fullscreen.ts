// The Fullscreen API, with Safari's prefixed one. An iPhone has neither for anything but a <video>
// (webkitEnterFullscreen, which would take the stage's controls and stats away): there the stage
// falls back to filling the window with CSS (Stage.svelte).

type FsDocument = Pick<Document, 'fullscreenElement' | 'exitFullscreen'> & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => void
}
type FsElement = Partial<Pick<HTMLElement, 'requestFullscreen'>> & {
  webkitRequestFullscreen?: () => void
}

/** Events fired when an element enters or leaves fullscreen. */
export const FULLSCREEN_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'] as const

/** The element in (real) fullscreen, if any. */
export function fullscreenElement(doc: FsDocument = document): Element | null {
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

/**
 * Puts `el` in real fullscreen. Resolves false when the browser can't or refuses (no API, or the
 * request was rejected): the caller falls back to filling the window.
 */
export async function enterFullscreen(el: FsElement): Promise<boolean> {
  try {
    if (el.requestFullscreen) {
      await el.requestFullscreen({ navigationUI: 'hide' })
      return true
    }
    if (el.webkitRequestFullscreen) {
      // Older Safari (iPadOS before 16.4) returns nothing, and fails silently.
      el.webkitRequestFullscreen()
      return true
    }
  } catch {
    // Not allowed (no user gesture, an iframe without allowfullscreen): fall back.
  }
  return false
}

export function exitFullscreen(doc: FsDocument = document): void {
  if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => {})
  else if (doc.webkitFullscreenElement) doc.webkitExitFullscreen?.()
}

/**
 * Turns a phone sideways for landscape video while in fullscreen (Android; elsewhere the lock is
 * refused, harmlessly). Returns the undo.
 */
export function lockLandscape(width: number, height: number): () => void {
  const o = typeof screen === 'undefined' ? undefined : (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })
  if (!o?.lock || width <= height) return () => {}
  o.lock('landscape').catch(() => {})
  return () => {
    try {
      o.unlock()
    } catch {
      // Not locked.
    }
  }
}
