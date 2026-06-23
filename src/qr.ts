// ============================================================
// Minimal QR Code generator (byte mode, ECC level M, versions 1–10).
//
// The plugin runs on Workers with no Node/native deps, and the legacy app
// shelled out to a `generate-qrcode` command — neither is available here, so we
// encode the matrix ourselves and render it as a crisp, print-friendly SVG.
//
// Scope is deliberately small: byte mode + level M covers a signed check-in URL
// (well under the ~270-byte v10 budget) with enough error correction to survive
// being printed on a badge. Implements the full ISO/IEC 18004 pipeline:
// Reed–Solomon ECC, block interleaving, function patterns, all eight data masks
// with penalty scoring, and format/version information.
// ============================================================

// ── GF(256) arithmetic (primitive polynomial 0x11d) ───────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gmul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function polyMul(a: number[], b: number[]): number[] {
  const r = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) r[i + j] ^= gmul(a[i], b[j]);
  }
  return r;
}

/** Reed–Solomon generator polynomial of the given degree. */
function rsGenPoly(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) g = polyMul(g, [1, EXP[i]]);
  return g;
}

/** Computes `ecLen` error-correction codewords for a data block. */
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenPoly(ecLen);
  const res = new Array<number>(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    for (let j = 0; j < ecLen - 1; j++) res[j] = res[j + 1] ^ gmul(gen[j + 1], factor);
    res[ecLen - 1] = gmul(gen[ecLen], factor);
  }
  return res;
}

// ── Per-version characteristics for ECC level M ───────────────────────────────
interface VersionSpec {
  /** EC codewords per block. */
  ec: number;
  /** Block groups: [blockCount, dataCodewordsPerBlock]. */
  groups: Array<[number, number]>;
  /** Alignment pattern centre coordinates. */
  align: number[];
  /** Trailing remainder bits after interleaving. */
  remainder: number;
}

const VERSIONS: Record<number, VersionSpec> = {
  1: { ec: 10, groups: [[1, 16]], align: [], remainder: 0 },
  2: { ec: 16, groups: [[1, 28]], align: [6, 18], remainder: 7 },
  3: { ec: 26, groups: [[1, 44]], align: [6, 22], remainder: 7 },
  4: { ec: 18, groups: [[2, 32]], align: [6, 26], remainder: 7 },
  5: { ec: 24, groups: [[2, 43]], align: [6, 30], remainder: 7 },
  6: { ec: 16, groups: [[4, 27]], align: [6, 34], remainder: 7 },
  7: { ec: 18, groups: [[4, 31]], align: [6, 22, 38], remainder: 0 },
  8: { ec: 22, groups: [[2, 38], [2, 39]], align: [6, 24, 42], remainder: 0 },
  9: { ec: 22, groups: [[3, 36], [2, 37]], align: [6, 26, 46], remainder: 0 },
  10: { ec: 26, groups: [[4, 43], [1, 44]], align: [6, 28, 50], remainder: 0 },
};

function totalDataCodewords(spec: VersionSpec): number {
  return spec.groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

// ── Bit buffer ────────────────────────────────────────────────────────────────
class BitBuffer {
  readonly bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/** Encodes the byte-mode data codewords (with padding) for a version. */
function encodeData(bytes: number[], version: number, spec: VersionSpec): number[] {
  const capacity = totalDataCodewords(spec) * 8;
  const countBits = version < 10 ? 8 : 16;
  const buffer = new BitBuffer();
  buffer.put(0b0100, 4); // byte mode
  buffer.put(bytes.length, countBits);
  for (const b of bytes) buffer.put(b, 8);

  // Terminator (up to 4 zero bits) then pad to a byte boundary.
  const remaining = capacity - buffer.bits.length;
  buffer.put(0, Math.min(4, Math.max(0, remaining)));
  while (buffer.bits.length % 8 !== 0) buffer.bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < buffer.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | buffer.bits[i + j];
    codewords.push(byte);
  }
  // Pad bytes alternate 0xEC / 0x11.
  const pads = [0xec, 0x11];
  for (let i = 0; codewords.length < totalDataCodewords(spec); i++) codewords.push(pads[i % 2]);
  return codewords;
}

/** Splits data into blocks, appends RS ECC, and interleaves to the final stream. */
function buildCodewordStream(data: number[], spec: VersionSpec): number[] {
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const [count, size] of spec.groups) {
    for (let b = 0; b < count; b++) {
      const block = data.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, spec.ec));
    }
  }

  const result: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

// ── Matrix assembly ───────────────────────────────────────────────────────────
type Module = 0 | 1;

class Matrix {
  readonly size: number;
  readonly modules: (Module | null)[][];
  readonly reserved: boolean[][];

  constructor(version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<Module | null>(this.size).fill(null));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(row: number, col: number, value: Module, reserved = true): void {
    this.modules[row][col] = value;
    if (reserved) this.reserved[row][col] = true;
  }
}

function placeFinder(m: Matrix, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= m.size || cc < 0 || cc >= m.size) continue;
      const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const isDark = inRing && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      m.set(rr, cc, isDark ? 1 : 0);
    }
  }
}

function placeAlignment(m: Matrix, centres: number[]): void {
  for (const r of centres) {
    for (const c of centres) {
      // Skip the three positions that collide with finder patterns.
      if ((r === 6 && c === 6) || (r === 6 && c === m.size - 7) || (r === m.size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isDark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          m.set(r + dr, c + dc, isDark ? 1 : 0);
        }
      }
    }
  }
}

function placeFunctionPatterns(m: Matrix, version: number, spec: VersionSpec): void {
  placeFinder(m, 0, 0);
  placeFinder(m, 0, m.size - 7);
  placeFinder(m, m.size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < m.size - 8; i++) {
    const bit: Module = i % 2 === 0 ? 1 : 0;
    if (m.modules[6][i] === null) m.set(6, i, bit);
    if (m.modules[i][6] === null) m.set(i, 6, bit);
  }

  placeAlignment(m, spec.align);

  // Dark module.
  m.set(m.size - 8, 8, 1);

  // Reserve format-info areas (filled later).
  for (let i = 0; i < 9; i++) {
    if (!m.reserved[8][i]) m.set(8, i, 0);
    if (!m.reserved[i][8]) m.set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (!m.reserved[8][m.size - 1 - i]) m.set(8, m.size - 1 - i, 0);
    if (!m.reserved[m.size - 1 - i][8]) m.set(m.size - 1 - i, 8, 0);
  }

  // Reserve version-info areas (v >= 7).
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        m.set(i, m.size - 11 + j, 0);
        m.set(m.size - 11 + j, i, 0);
      }
    }
  }
}

/** Walks the zig-zag data path and writes the codeword bit stream. */
function placeData(m: Matrix, stream: number[]): { row: number; col: number }[] {
  const dataCells: { row: number; col: number }[] = [];
  let bitIndex = 0;
  let upward = true;
  for (let col = m.size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the vertical timing column
    for (let i = 0; i < m.size; i++) {
      const row = upward ? m.size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (m.modules[row][cc] !== null) continue;
        const byte = stream[bitIndex >> 3] ?? 0;
        const bit = (byte >> (7 - (bitIndex & 7))) & 1;
        m.modules[row][cc] = bit as Module;
        dataCells.push({ row, col: cc });
        bitIndex++;
      }
    }
    upward = !upward;
  }
  return dataCells;
}

function maskBit(pattern: number, row: number, col: number): boolean {
  switch (pattern) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function applyMask(m: Matrix, dataCells: { row: number; col: number }[], pattern: number): void {
  for (const { row, col } of dataCells) {
    if (maskBit(pattern, row, col)) {
      m.modules[row][col] = (m.modules[row][col] === 1 ? 0 : 1) as Module;
    }
  }
}

function penalty(m: Matrix): number {
  const n = m.size;
  const at = (r: number, c: number): Module => (m.modules[r][c] ?? 0) as Module;
  let score = 0;

  // Rule 1: runs of 5+ same-colour modules in rows and columns.
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      for (const [dr, dc] of [[0, 1], [1, 0]] as const) {
        if (c + dc * 4 >= n || r + dr * 4 >= n) continue;
        const first = at(r, c);
        let run = 1;
        while (r + dr * run < n && c + dc * run < n && at(r + dr * run, c + dc * run) === first) run++;
        if (run >= 5) score += 3 + (run - 5);
      }
    }
  }

  // Rule 2: 2x2 blocks of the same colour.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns.
  const pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const matches = (cells: Module[]): boolean => {
    for (let i = 0; i + pattern.length <= cells.length; i++) {
      if (pattern.every((p, j) => cells[i + j] === p)) return true;
    }
    return false;
  };
  for (let r = 0; r < n; r++) {
    const rowCells: Module[] = [];
    const colCells: Module[] = [];
    for (let c = 0; c < n; c++) {
      rowCells.push(at(r, c));
      colCells.push(at(c, r));
    }
    if (matches(rowCells)) score += 40;
    if (matches(colCells)) score += 40;
  }

  // Rule 4: overall dark/light balance.
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += at(r, c);
  const percent = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

// ── Format & version information ──────────────────────────────────────────────
function bch15(format: number): number {
  let d = format << 10;
  for (let i = 14; i >= 10; i--) {
    if ((d >> i) & 1) d ^= 0x537 << (i - 10);
  }
  return ((format << 10) | d) ^ 0x5412;
}

function placeFormat(m: Matrix, mask: number): void {
  // ECC level M = 0b00.
  const bits = bch15((0b00 << 3) | mask);
  const get = (i: number): Module => ((bits >> i) & 1) as Module;
  const n = m.size;
  for (let i = 0; i <= 5; i++) m.set(8, i, get(i), false);
  m.set(8, 7, get(6), false);
  m.set(8, 8, get(7), false);
  m.set(7, 8, get(8), false);
  for (let i = 9; i <= 14; i++) m.set(14 - i, 8, get(i), false);
  for (let i = 0; i <= 7; i++) m.set(n - 1 - i, 8, get(i), false);
  for (let i = 8; i <= 14; i++) m.set(8, n - 15 + i, get(i), false);
}

function bch18(version: number): number {
  let d = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((d >> i) & 1) d ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | d;
}

function placeVersion(m: Matrix, version: number): void {
  if (version < 7) return;
  const bits = bch18(version);
  const n = m.size;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >> i) & 1) as Module;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m.set(r, n - 11 + c, bit, false);
    m.set(n - 11 + c, r, bit, false);
  }
}

// ── Public entry point ────────────────────────────────────────────────────────
function chooseVersion(byteLen: number): { version: number; spec: VersionSpec } {
  for (let version = 1; version <= 10; version++) {
    const spec = VERSIONS[version];
    const countBits = version < 10 ? 8 : 16;
    const needed = 4 + countBits + byteLen * 8;
    if (needed <= totalDataCodewords(spec) * 8) return { version, spec };
  }
  throw new Error('QR payload too large (max ~216 bytes at ECC level M)');
}

/** Builds the boolean module matrix for `text` (true = dark). */
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  const { version, spec } = chooseVersion(bytes.length);
  const data = encodeData(bytes, version, spec);
  const stream = buildCodewordStream(data, spec);

  const base = new Matrix(version);
  placeFunctionPatterns(base, version, spec);
  const dataCells = placeData(base, stream);

  let best: { matrix: Matrix; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = new Matrix(version);
    for (let r = 0; r < base.size; r++) {
      for (let c = 0; c < base.size; c++) {
        candidate.modules[r][c] = base.modules[r][c];
        candidate.reserved[r][c] = base.reserved[r][c];
      }
    }
    applyMask(candidate, dataCells, mask);
    placeFormat(candidate, mask);
    placeVersion(candidate, version);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { matrix: candidate, score };
  }

  const matrix = best!.matrix;
  return matrix.modules.map((row) => row.map((cell) => cell === 1));
}

/**
 * Renders `text` as a square SVG QR code. `size` is the pixel side length;
 * `margin` is the quiet-zone width in modules (4 is the spec minimum).
 */
export function qrSvg(text: string, { size = 220, margin = 4 }: { size?: number; margin?: number } = {}): string {
  const matrix = qrMatrix(text);
  const count = matrix.length + margin * 2;
  const rects: string[] = [];
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (matrix[r][c]) rects.push(`<rect x="${c + margin}" y="${r + margin}" width="1" height="1"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${count} ${count}" shape-rendering="crispEdges">` +
    `<rect width="${count}" height="${count}" fill="#fff"/>` +
    `<g fill="#000">${rects.join('')}</g></svg>`;
}
