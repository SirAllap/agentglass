/**
 * Mozilla's `.jsonlz4`, read.
 *
 * Firefox — and Zen, which is a fork of it — writes its session state as JSON
 * squashed with LZ4 and given an eight-byte magic of its own: `mozLz40\0`, then
 * the uncompressed length, then a raw LZ4 *block* (not a frame, which is why
 * every general-purpose lz4 library refuses it without coaxing).
 *
 * Written out here rather than pulled in, for two reasons. It is forty lines —
 * the block format is a token, some literals and a back-reference, and that is
 * the whole specification. And this runs in the one-shot sidecar that reads
 * somebody's browser profile, where the argument for adding a dependency has to
 * clear a higher bar than "it exists".
 *
 * Reading only. Nothing here writes a profile, and nothing should.
 */

/** `mozLz40\0` — the magic Firefox puts in front of an LZ4 block. */
export const MOZ_MAGIC = new Uint8Array([0x6d, 0x6f, 0x7a, 0x4c, 0x7a, 0x34, 0x30, 0x00]);

/**
 * One LZ4 block, expanded.
 *
 * The format, in full: a byte whose high nibble is how many literal bytes
 * follow and whose low nibble is how long the match after them is. Either
 * nibble at 15 means "and more", carried in following bytes until one is not
 * 255. After the literals comes a two-byte little-endian OFFSET backwards into
 * what has been produced so far, and the match is copied from there — byte by
 * byte, because the ranges are allowed to overlap and that overlap is how LZ4
 * expresses a run.
 *
 * `expected` is what the header claims; a block that produces a different
 * length is a corrupt file rather than one worth guessing at.
 */
export function lz4Block(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let o = 0;
  let i = 0;
  const more = (n: number): number => {
    let add = n;
    if (n === 15) {
      let b = 255;
      while (b === 255) {
        if (i >= src.length) throw new Error("lz4: the block ends in the middle of a length");
        b = src[i++]!;
        add += b;
      }
    }
    return add;
  };
  while (i < src.length) {
    const token = src[i++]!;
    const lit = more(token >> 4);
    if (i + lit > src.length) throw new Error("lz4: more literals than block");
    if (o + lit > out.length) throw new Error("lz4: more output than the header said");
    out.set(src.subarray(i, i + lit), o);
    i += lit; o += lit;
    // The last sequence of a block is literals with no match after them.
    if (i >= src.length) break;
    if (i + 2 > src.length) throw new Error("lz4: the block ends in the middle of an offset");
    const offset = src[i]! | (src[i + 1]! << 8);
    i += 2;
    if (offset === 0 || offset > o) throw new Error("lz4: a match points outside what has been decoded");
    const len = more(token & 0x0f) + 4;
    if (o + len > out.length) throw new Error("lz4: more output than the header said");
    let from = o - offset;
    for (let k = 0; k < len; k++) out[o++] = out[from++]!;
  }
  if (o !== expected) throw new Error(`lz4: expected ${expected} bytes and produced ${o}`);
  return out;
}

/** The most this will decode. The header's four bytes can claim 4 GiB, and the
 *  buffer used to be allocated on their word before a single byte of the block
 *  was looked at — a twelve-byte file was a request for as much memory as the
 *  process could get. The largest thing anyone stores this way is a session
 *  store of a few megabytes; 64 MiB is an order of magnitude of headroom. */
export const MAX_DECODED = 64 * 1024 * 1024;

/** The whole file: magic, length, block. Throws with a sentence rather than
 *  returning null — the caller is a one-shot that reports what went wrong. */
export function mozLz4(file: Uint8Array): Uint8Array {
  if (file.length < 12) throw new Error("not a mozLz4 file: it is too short to have a header");
  for (let i = 0; i < MOZ_MAGIC.length; i++) {
    if (file[i] !== MOZ_MAGIC[i]) throw new Error("not a mozLz4 file: the magic does not match");
  }
  // Added, not OR-ed: `|` works in int32, so a top byte of 0x80 or more made
  // the whole size negative — 0xffffffff read as -1, and a negative length is
  // a different error from the honest "too big" it is.
  const size = (file[8]! | (file[9]! << 8) | (file[10]! << 16)) + file[11]! * 0x1000000;
  if (size > MAX_DECODED) {
    throw new Error(`mozLz4: the header claims ${size} bytes, more than the ${MAX_DECODED} this will decode`);
  }
  return lz4Block(file.subarray(12), size);
}

/** …and as JSON, which is the only thing anybody stores this way. */
export function mozLz4Json<T = unknown>(file: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(mozLz4(file))) as T;
}
