// Base64 for binary data: standard (with padding) and base64url (no padding, URL and JSON safe).

/** Bytes as standard base64. */
export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

/** Decodes standard base64 (or base64url, once translated). Throws on malformed input. */
export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** Bytes as base64url, without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decodes base64url (padding optional). Throws on malformed input. */
export function fromBase64Url(b64: string): Uint8Array<ArrayBuffer> {
  return fromBase64(b64.replace(/-/g, '+').replace(/_/g, '/'))
}
