// localStorage access that never throws: storage can be unavailable (private windows, blocked
// site data), and the app must keep working without it.

/** The stored value, or null when it is missing or storage is unavailable. */
export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Stores `value`; a no-op when storage is unavailable (the value then lasts for this page only). */
export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable
  }
}
