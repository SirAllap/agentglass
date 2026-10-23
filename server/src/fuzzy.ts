// Fuzzy matching on bytes, for the home index.
//
// The index keeps every name as UTF-8 in one buffer, so a match is a scan over
// bytes rather than over a million JS strings. The needle is matched as a
// subsequence, tightened to the shortest window that still holds it, and scored
// by what makes a match feel right to a person typing: it starts the name or a
// word in it, its letters sit together, and the name is not much longer than
// what was typed.
//
// Case: an ASCII letter in the needle matches either case in the name. Any
// other byte (an `ñ`, a CJK character) matches exactly. That is the ceiling of
// working on bytes: typing `ñandu` finds `ñandu` and not `Ñandu`.

const A = 97, Z = 122;

/** Is this byte a place a word starts after: a separator, or a dot, dash, underscore, space. */
const isSep = (b: number): boolean => b === 46 || b === 45 || b === 95 || b === 32 || b === 47;

const eq = (h: number, n: number): boolean => h === n || (n >= A && n <= Z && h === n - 32);

/** The needle, as bytes with ASCII letters lowered. */
export function needleBytes(q: string): Uint8Array {
  return new TextEncoder().encode(q.toLowerCase());
}

/**
 * Score `needle` against `hay[start, end)`; -1 when it is not a subsequence.
 * Higher is better. Exact name equals score above every partial match.
 */
export function fuzzyScore(hay: Uint8Array, start: number, end: number, needle: Uint8Array): number {
  const n = needle.length;
  if (n === 0) return 0;
  const len = end - start;
  if (len < n) return -1;
  // Forward: the first place the whole needle fits as a subsequence.
  let hi = start, ni = 0;
  while (hi < end && ni < n) { if (eq(hay[hi]!, needle[ni]!)) ni++; hi++; }
  if (ni < n) return -1;
  // Backward from that end: the tightest window, which is what "consecutive" is measured on.
  let hj = hi - 1, nj = n - 1;
  while (nj >= 0) { if (eq(hay[hj]!, needle[nj]!)) nj--; hj--; }
  const first = hj + 1;
  let score = 0, prev = -2;
  hj = first; nj = 0;
  while (nj < n) {
    if (eq(hay[hj]!, needle[nj]!)) {
      score += 16;
      if (hj === prev + 1) score += 8;                       // together with the one before
      if (hj === start) score += 24;                         // the name starts with it
      else if (isSep(hay[hj - 1]!)) score += 12;            // a word in the name starts with it
      else if (hay[hj - 1]! >= A && hay[hj - 1]! <= Z && hay[hj]! >= 65 && hay[hj]! <= 90) score += 10; // camelCase: a capital after a lowercase
      prev = hj; nj++;
    } else score -= 1;                                       // a gap inside the window
    hj++;
  }
  score -= Math.min(20, first - start);                      // matched late in the name
  score -= (len - n) * 0.5;                                  // a long name for a short query
  if (len === n) score += 100;                               // exactly it
  return score;
}
