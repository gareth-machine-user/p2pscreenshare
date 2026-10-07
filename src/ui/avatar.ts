// A member's avatar: their initial on a color picked from their id, so it stays the same for
// everyone and across renames.

const COLORS: [bg: string, fg: string][] = [
  ['#2b4a7a', '#dce9ff'],
  ['#4d3a78', '#ebe3ff'],
  ['#2f5b4c', '#ddf6ec'],
  ['#6b4a26', '#fce8d2'],
  ['#6a2f45', '#ffe0ea'],
  ['#2d5763', '#d9f3f8'],
  ['#555a26', '#f1f3d4'],
  ['#3a4558', '#e3e9f2'],
]

export function avatarColors(id: string): { bg: string; fg: string } {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const [bg, fg] = COLORS[h % COLORS.length]
  return { bg, fg }
}

/** The first letter (or digit) of a name, else "?". */
export function initial(name: string): string {
  return name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?'
}
