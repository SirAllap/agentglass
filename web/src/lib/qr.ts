// A QR encoder, because the alternative was asking someone to type
// `http://192.168.1.131:4000/?token=Xk3n...` into a phone.
//
// That URL is the entire user experience of remote access: an IP address, a
// port and a 32-character secret, on a soft keyboard, correctly, once per
// device. A QR code turns it into pointing a camera. Everything else in the
// panel is presentation; this is the part that makes the feature usable.
//
// Written rather than installed. It is ~200 lines of well-specified maths with
// no ongoing surface area, against a dependency that would run in the same
// process as the terminal, the git writer and the token this very code encodes.
//
// Scope is deliberately the minimum that covers the job:
//   * byte mode only — a URL is bytes;
//   * error correction level M (~15% recoverable), the usual choice for a code
//     read off a bright screen at 20cm;
//   * versions 1 to 9, i.e. up to 182 bytes, several times any URL we make.
//     Stopping below 10 also means no version-information blocks, which only
//     exist from 7 upward for the *format* and from 10 for the character count.
// It throws rather than truncating: a QR that encodes half a token would be
// worse than none, because it scans.

/** Log/antilog tables for GF(256) with the QR primitive polynomial 0x11d. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** The generator polynomial for `n` error-correction codewords, in descending
 *  order — `gen[0]` is the leading 1, which is what the division below assumes. */
function generator(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!; // x * poly
      next[j + 1] ^= mul(poly[j]!, EXP[i]!); // a^i * poly
    }
    poly = next;
  }
  return poly;
}

/** The remainder of `data` divided by the generator — the EC codewords.
 *  Exported for the test that pins it against the published example vector. */
export function ecCodewords(data: number[], count: number): number[] {
  const gen = generator(count);
  const rem = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    rem.shift();
    rem.push(0);
    if (factor !== 0) for (let i = 0; i < gen.length - 1; i++) rem[i] ^= mul(gen[i + 1]!, factor);
  }
  return rem;
}

/** Block structure per version at EC level M: total codewords, EC per block,
 *  and the data blocks as [count, dataCodewordsEach]. */
const VERSIONS: { ec: number; groups: [number, number][] }[] = [
  { ec: 10, groups: [[1, 16]] }, // 1
  { ec: 16, groups: [[1, 28]] }, // 2
  { ec: 26, groups: [[1, 44]] }, // 3
  { ec: 18, groups: [[2, 32]] }, // 4
  { ec: 24, groups: [[2, 43]] }, // 5
  { ec: 16, groups: [[4, 27]] }, // 6
  { ec: 18, groups: [[4, 31]] }, // 7
  { ec: 22, groups: [[2, 38], [2, 39]] }, // 8
  { ec: 22, groups: [[3, 36], [2, 37]] }, // 9
];

/** Alignment pattern centre coordinates per version (index = version - 1). */
const ALIGN: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
];

const dataCapacity = (v: number): number =>
  VERSIONS[v - 1]!.groups.reduce((n, [count, size]) => n + count * size, 0);

/** The smallest version that holds `bytes` in byte mode at level M. */
function pickVersion(bytes: number): number {
  for (let v = 1; v <= VERSIONS.length; v++) {
    // 4 bits of mode + 8 bits of length (versions 1-9) + the payload.
    if (dataCapacity(v) * 8 >= 4 + 8 + bytes * 8) return v;
  }
  throw new Error(`qr: ${bytes} bytes is more than version 9 holds at level M`);
}

/** Mode indicator, length, payload, terminator and pad bytes. */
function bitstream(data: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(data.length, 8); // character count, 8 bits for versions 1-9
  for (const b of data) push(b, 8);

  const capacityBits = dataCapacity(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  }
  // The specified alternating pad, which is what makes an under-full symbol
  // look like noise rather than a long run the mask penalty would punish.
  for (let i = 0; codewords.length < dataCapacity(version); i++) codewords.push(i % 2 === 0 ? 0xec : 0x11);
  return codewords;
}

/** Interleave data and EC blocks the way the spec orders them on the symbol. */
function interleave(codewords: number[], version: number): number[] {
  const { ec, groups } = VERSIONS[version - 1]!;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const block = codewords.slice(at, at + size);
      at += size;
      dataBlocks.push(block);
      ecBlocks.push(ecCodewords(block, ec));
    }
  }
  const out: number[] = [];
  const widest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < widest; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i]!);
  return out;
}

type Grid = (boolean | null)[][];

/** The version number, BCH(18,6) coded — carried by symbols from version 7 up
 *  so a scanner can size the grid without counting modules. */
export function versionBits(version: number): number {
  let value = version << 12;
  for (let i = 5; i >= 0; i--) if (value & (1 << (i + 12))) value ^= 0x1f25 << i;
  return (version << 12) | value;
}

/** Finder patterns, separators, timing, alignment and the dark module. */
function skeleton(size: number, version: number): Grid {
  const g: Grid = Array.from({ length: size }, () => new Array(size).fill(null));

  const finder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const outside = r === -1 || r === 7 || c === -1 || c === 7; // separator
        g[rr]![cc] = outside ? false : edge || core;
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    g[6]![i] = i % 2 === 0;
    g[i]![6] = i % 2 === 0;
  }

  for (const r of ALIGN[version - 1]!) {
    for (const c of ALIGN[version - 1]!) {
      // Only the three finder corners are skipped. Not "any centre that is
      // already occupied": from version 7 the centres at (6, n) and (n, 6) sit
      // ON the timing line and are still drawn — treating occupancy as the rule
      // silently dropped two alignment patterns per symbol, which no scanner
      // forgives.
      const last = size - 7;
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          g[r + dr]![c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        }
      }
    }
  }

  // From version 7 the symbol carries its own version number twice, BCH(18,6)
  // coded, in two 3x6 blocks beside the top-right and bottom-left finders.
  // Written here rather than with the format information because these bits do
  // not depend on the mask — and writing them in the skeleton is also what
  // reserves the modules, so the data walk steps over them.
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const on = ((bits >> i) & 1) === 1;
      g[Math.floor(i / 3)]![(i % 3) + size - 11] = on;
      g[(i % 3) + size - 11]![Math.floor(i / 3)] = on;
    }
  }

  g[size - 8]![8] = true; // the dark module, always set

  // Reserve the format areas so data placement steps over them.
  for (let i = 0; i < 9; i++) {
    if (g[8]![i] === null) g[8]![i] = false;
    if (g[i]![8] === null) g[i]![8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (g[8]![size - 1 - i] === null) g[8]![size - 1 - i] = false;
    if (g[size - 1 - i]![8] === null) g[size - 1 - i]![8] = false;
  }
  return g;
}

/** Which modules the data walk may write: everything the skeleton left null. */
function placeData(g: Grid, free: boolean[][], bytes: number[]): void {
  const size = g.length;
  let bit = 0;
  const next = (): boolean => {
    const byte = bytes[bit >> 3];
    const value = byte === undefined ? false : ((byte >> (7 - (bit & 7))) & 1) === 1;
    bit++;
    return value;
  };
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--; // the vertical timing column is not a data column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (!free[row]![col]) continue;
        g[row]![col] = next();
      }
    }
    upward = !upward;
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * Format information: EC level M with the chosen mask, BCH(15,5) coded, then
 * XOR-masked so an all-zero format cannot look like blank modules.
 *
 * Returned as the raw 15-bit integer with bit 0 the least significant, because
 * that is the indexing the placement below uses — the two halves of this are
 * easy to get subtly out of step, and one convention throughout is the fix.
 */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M is 00
  let value = data << 10;
  for (let i = 4; i >= 0; i--) if (value & (1 << (i + 10))) value ^= 0x537 << i;
  return ((data << 10) | value) ^ 0x5412;
}

/** Both copies of the format information, in the spec's zig-zag placement. */
function applyFormat(g: Grid, mask: number): void {
  const size = g.length;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const on = ((bits >> i) & 1) === 1;
    // Copy one, down the left edge of the top-left finder — stepping over the
    // timing row at 6, and continuing under the bottom-left finder.
    if (i < 6) g[i]![8] = on;
    else if (i < 8) g[i + 1]![8] = on;
    else g[size - 15 + i]![8] = on;
    // Copy two, along row 8: from the right edge inward, then the tail beside
    // the top-left finder, again stepping over the timing column at 6.
    if (i < 8) g[8]![size - i - 1] = on;
    else if (i < 9) g[8]![15 - i] = on;
    else g[8]![14 - i] = on;
  }
  g[size - 8]![8] = true; // the dark module, never masked
}

/** The four penalty rules, summed. Lower is a code that scans more reliably.
 *  Exported so the test can pin the chooser rather than only its output. */
export function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;

  const runs = (get: (a: number, b: number) => boolean) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  };
  runs((r, c) => m[r]![c]!);
  runs((c, r) => m[r]![c]!);

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r]![c];
      if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) score += 3;
    }
  }

  // 1:1:3:1:1 with four modules of quiet space on either side — the finder
  // pattern's own signature, which must not appear anywhere else.
  const pattern = [true, false, true, true, true, false, true];
  const check = (line: boolean[]) => {
    for (let i = 0; i + 7 <= line.length; i++) {
      if (!pattern.every((p, j) => line[i + j] === p)) continue;
      // Outside the symbol is the quiet zone, which is light — so a finder-like
      // run against the edge scores exactly as one in the middle. Treating the
      // edge as "no match" instead would let a mask that puts a false finder in
      // the corner win, which is the one place a scanner most wants not to see
      // one.
      const at = (n: number) => (n < 0 || n >= line.length ? false : line[n]!);
      const clear = (from: number) => [0, 1, 2, 3].every((k) => !at(from + k));
      if (clear(i - 4)) score += 40;
      if (clear(i + 7)) score += 40;
    }
  };
  for (let i = 0; i < size; i++) {
    check(m[i]!);
    check(m.map((row) => row[i]!));
  }

  const dark = m.flat().filter(Boolean).length;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/**
 * Encode `text` as a QR matrix: `true` is a dark module.
 *
 * The caller adds the quiet zone (four modules of background on every side).
 * Without it, scanners refuse the code — which looks like a broken encoder and
 * is really a missing margin.
 */
export function qrMatrix(text: string, forceMask?: number): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const size = 17 + 4 * version;
  const codewords = interleave(bitstream(bytes, version), version);

  const base = skeleton(size, version);
  const free = base.map((row) => row.map((cell) => cell === null));
  placeData(base, free, codewords);

  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== undefined && mask !== forceMask) continue;
    const g: Grid = base.map((row) => [...row]);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (free[r]![c] && MASKS[mask]!(r, c)) g[r]![c] = !g[r]![c];
      }
    }
    applyFormat(g, mask);
    const m = g.map((row) => row.map((cell) => cell === true));
    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best!;
}

/**
 * The same code as an SVG path string, sized in modules.
 *
 * A path of rectangles rather than one element per module: a version 4 symbol
 * is 1,089 modules, and 1,089 React nodes to draw a static image is a waste of
 * a commit and a frame.
 */
export function qrSvgPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (matrix[r]![c]) parts.push(`M${c} ${r}h1v1h-1z`);
    }
  }
  return parts.join("");
}
