// Systematic erasure coding over GF(256): k data pieces + m parity pieces; any k of the k+m pieces
// reconstruct the frame. m=1 uses plain XOR parity; m>1 uses a Cauchy matrix (every square
// submatrix of [I; C] is invertible, so the code is MDS).

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
// MUL[a * 256 + b] = a * b in GF(256)
const MUL = new Uint8Array(256 * 256)

;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
  for (let a = 1; a < 256; a++) {
    for (let b = 1; b < 256; b++) MUL[a * 256 + b] = EXP[LOG[a] + LOG[b]]
  }
})()

function gfMul(a: number, b: number): number {
  return MUL[a * 256 + b]
}

function gfInv(a: number): number {
  if (a === 0) throw new Error('gfInv(0)')
  return EXP[255 - LOG[a]]
}

/** Coefficient row for piece index `r` (length k). */
function codingRow(r: number, k: number, m: number): Uint8Array {
  const row = new Uint8Array(k)
  if (r < k) {
    row[r] = 1
  } else if (m === 1) {
    row.fill(1)
  } else {
    const xj = r // x_j = k + j, distinct from every y_i = i < k
    for (let i = 0; i < k; i++) row[i] = gfInv(xj ^ i)
  }
  return row
}

/** dst ^= coef * src */
function mulAddInto(dst: Uint8Array, src: Uint8Array, coef: number): void {
  if (coef === 0) return
  const n = dst.length
  if (coef === 1) {
    for (let i = 0; i < n; i++) dst[i] ^= src[i]
    return
  }
  const base = coef * 256
  for (let i = 0; i < n; i++) dst[i] ^= MUL[base + src[i]]
}

export function pieceLength(frameLen: number, k: number): number {
  return Math.max(1, Math.ceil(frameLen / k))
}

/** Splits `frame` into k data pieces (zero padded) and computes m parity pieces. */
export function encodePieces(frame: Uint8Array, k: number, m: number): Uint8Array[] {
  const P = pieceLength(frame.byteLength, k)
  const pieces: Uint8Array[] = []
  for (let i = 0; i < k; i++) {
    const piece = new Uint8Array(P)
    piece.set(frame.subarray(i * P, Math.min((i + 1) * P, frame.byteLength)))
    pieces.push(piece)
  }
  for (let j = 0; j < m; j++) {
    const row = codingRow(k + j, k, m)
    const parity = new Uint8Array(P)
    for (let i = 0; i < k; i++) mulAddInto(parity, pieces[i], row[i])
    pieces.push(parity)
  }
  return pieces
}

/** Inverts a k×k matrix over GF(256) (Gauss-Jordan). Returns null if singular. */
function invert(matrix: Uint8Array[], k: number): Uint8Array[] | null {
  const a = matrix.map((r) => r.slice())
  const inv = Array.from({ length: k }, (_, i) => {
    const r = new Uint8Array(k)
    r[i] = 1
    return r
  })
  for (let col = 0; col < k; col++) {
    let pivot = col
    while (pivot < k && a[pivot][col] === 0) pivot++
    if (pivot === k) return null
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    ;[inv[col], inv[pivot]] = [inv[pivot], inv[col]]
    const s = gfInv(a[col][col])
    for (let c = 0; c < k; c++) {
      a[col][c] = gfMul(a[col][c], s)
      inv[col][c] = gfMul(inv[col][c], s)
    }
    for (let r = 0; r < k; r++) {
      if (r === col || a[r][col] === 0) continue
      const f = a[r][col]
      for (let c = 0; c < k; c++) {
        a[r][c] ^= gfMul(f, a[col][c])
        inv[r][c] ^= gfMul(f, inv[col][c])
      }
    }
  }
  return inv
}

/**
 * Reconstructs the frame from any k available pieces. `pieces[i]` is piece i or undefined.
 * Returns null when fewer than k pieces are available.
 */
export function decodePieces(
  pieces: (Uint8Array | undefined)[],
  k: number,
  m: number,
  frameLen: number,
): Uint8Array | null {
  const P = pieceLength(frameLen, k)
  const out = new Uint8Array(k * P)

  let haveAllData = true
  for (let i = 0; i < k; i++) {
    if (!pieces[i]) {
      haveAllData = false
      break
    }
  }
  if (haveAllData) {
    for (let i = 0; i < k; i++) out.set(pieces[i]!, i * P)
    return out.subarray(0, frameLen)
  }

  const avail: number[] = []
  for (let r = 0; r < k + m && avail.length < k; r++) if (pieces[r]) avail.push(r)
  if (avail.length < k) return null

  const inv = invert(
    avail.map((r) => codingRow(r, k, m)),
    k,
  )
  if (!inv) return null
  for (let i = 0; i < k; i++) {
    const dst = out.subarray(i * P, (i + 1) * P)
    if (pieces[i]) {
      dst.set(pieces[i]!)
      continue
    }
    for (let c = 0; c < k; c++) mulAddInto(dst, pieces[avail[c]]!, inv[i][c])
  }
  return out.subarray(0, frameLen)
}
