import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** The last `maxBytes` of a file as text, never the whole file. A cut that lands
 *  mid-line drops that partial first line. Empty on any error. */
export function readTail(path: string, maxBytes = 64 * 1024): string {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    const text = buf.subarray(0, got).toString("utf8");
    if (start === 0) return text;
    const nl = text.indexOf("\n");
    return nl === -1 ? "" : text.slice(nl + 1);
  } catch { return ""; } finally { if (fd >= 0) try { closeSync(fd); } catch { /* ignore */ } }
}
