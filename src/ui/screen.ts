/** The screen in device pixels: what a "Native" resolution capture of the whole screen gets. */
export function nativeScreenSize(): [number, number] {
  if (typeof screen === 'undefined') return [1920, 1080]
  const dpr = globalThis.devicePixelRatio || 1
  return [Math.round(screen.width * dpr), Math.round(screen.height * dpr)]
}
