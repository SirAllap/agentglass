/*
 * A SMALL PICTURE FOR A SMALL BOX.
 *
 * What went wrong: a row's 17 px icon was an `<img>` pointed at the file
 * itself. A folder of 22 screenshots of about 0.6 MB each, the widest 4774 by
 * 1072, made the window fetch every file whole and decode about 5 megapixels
 * (20 MB of bitmap) per row to paint 17 px of it. The file route answers
 * `no-store`, and a virtual list unmounts a row that scrolls out, so every
 * scroll back fetched and decoded the same files again. The compositor here
 * runs on the CPU, so that work lands on the frames the list is scrolling in.
 *
 * So the file is read once, decoded off the main thread, drawn down to the
 * size the box needs and kept as a few kilobytes under a key that changes when
 * the file does. There is no image library on the server and none is added:
 * the window already has a decoder.
 *
 * Ceilings, chosen:
 *  - the first look at a file still downloads and decodes it whole, once, two
 *    files at a time; a server-side thumbnail is the next thing after this;
 *  - the cache lives in this window's memory and is gone on reload;
 *  - a file over THUMB_SOURCE_MAX_BYTES gets its file icon, not a picture.
 */

/** Pixel edges a thumbnail is made at. Few sizes, so a row and a tile of the same file share work less often than they repeat it. */
export const THUMB_EDGES = [32, 64, 128, 256, 512] as const;
/** Past this a file is not downloaded to draw an icon. */
export const THUMB_SOURCE_MAX_BYTES = 32 * 1024 * 1024;
/** Under this the file is already as light as its thumbnail would be. */
export const THUMB_DIRECT_MAX_BYTES = 24 * 1024;
/** How many thumbnails this window keeps. At 64 px a PNG thumbnail is a few KB, so this is single megabytes. */
export const THUMB_CACHE_MAX = 600;
/** Files read and decoded at once. Two keeps a folder of large pictures from taking every connection and every decoder thread from the preview. */
export const THUMB_PARALLEL = 2;

/** The edge to make for a box of `size` CSS px on a screen of `dpr`: the first step that covers it, at most 2x. */
export function thumbEdge(size: number, dpr: number): number {
  const want = Math.ceil(Math.max(1, size) * Math.min(2, Math.max(1, dpr || 1)));
  return THUMB_EDGES.find((e) => e >= want) ?? THUMB_EDGES[THUMB_EDGES.length - 1]!;
}

/** Changes when the file does: the same path with new bytes is a new picture. */
export function thumbKey(path: string, mtime: number, bytes: number | null, edge: number): string {
  return `${edge}|${mtime}|${bytes ?? -1}|${path}`;
}

export type ThumbPlan = "shrink" | "direct" | "icon";

/** How a file's picture is drawn. SVG is a drawing the browser scales itself and the bitmap decoder refuses; a tiny file is used as it is. */
export function thumbPlan(name: string, bytes: number | null): ThumbPlan {
  if (bytes !== null && bytes > THUMB_SOURCE_MAX_BYTES) return "icon";
  if (/\.svg$/i.test(name)) return "direct";
  if (bytes !== null && bytes <= THUMB_DIRECT_MAX_BYTES) return "direct";
  return "shrink";
}

/** The size to draw a `w` by `h` picture at so its SHORT side is `edge`: the box crops to a square, so the long side must not be the one that fits. Never larger than the picture. */
export function coverSize(w: number, h: number, edge: number): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: edge, h: edge };
  const k = Math.min(1, edge / Math.min(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** The size to draw a picture at so its LONG side is at most `edge`, for a picture shown whole. */
export function containSize(w: number, h: number, edge: number): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: edge, h: edge };
  const k = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Least recently used out first; `drop` is told what left so a blob URL can be released. */
export function makeThumbCache(max: number, drop: (url: string) => void) {
  const held = new Map<string, string>();
  return {
    get(key: string): string | undefined {
      const url = held.get(key);
      if (url !== undefined) { held.delete(key); held.set(key, url); }
      return url;
    },
    set(key: string, url: string): void {
      const was = held.get(key);
      if (was !== undefined && was !== url) drop(was);
      held.delete(key);
      held.set(key, url);
      while (held.size > max) {
        const oldest = held.keys().next().value!;
        drop(held.get(oldest)!);
        held.delete(oldest);
      }
    },
    get size() { return held.size; },
  };
}

/**
 * At most `limit` jobs at once, the newest asked first: the rows on screen now
 * were asked for last, and the ones scrolled past are the ones to make wait.
 * A job whose signal aborted before its turn never starts.
 */
export function makeGate(limit: number) {
  const waiting: (() => void)[] = [];
  let busy = 0;
  const next = () => { while (busy < limit && waiting.length) waiting.pop()!(); };
  return function gate<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((ok, no) => {
      const gone = () => new Error("left before its turn");
      if (signal?.aborted) { no(gone()); return; }
      const run = () => {
        signal?.removeEventListener("abort", leave);
        busy++;
        work().then(ok, no).finally(() => { busy--; next(); });
      };
      // Only a job still in the line leaves it. One that has started is finished: its result is what the next asker reads.
      const leave = () => { const at = waiting.indexOf(run); if (at >= 0) { waiting.splice(at, 1); no(gone()); } };
      signal?.addEventListener("abort", leave, { once: true });
      waiting.push(run);
      next();
    });
  };
}

/** Bytes of a picture, decoded off the main thread and drawn down to `size(w, h)`. Null when this window cannot do it or the bytes are not a picture it reads. */
export async function shrinkPicture(blob: Blob, size: (w: number, h: number) => { w: number; h: number }, type = "image/png", quality?: number): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(blob); } catch { return null; }
  try {
    const to = size(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(to.w, to.h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(bitmap, 0, 0, to.w, to.h);
    return await canvas.convertToBlob({ type, quality });
  } catch { return null; } finally { bitmap.close(); }
}

const cache = makeThumbCache(THUMB_CACHE_MAX, (url) => { try { URL.revokeObjectURL(url); } catch { /* nothing to release */ } });
const gate = makeGate(THUMB_PARALLEL);
const making = new Map<string, Promise<string | null>>();

/** A thumbnail this window already made, with no wait: what lets a row that scrolls back paint in its first frame. */
export function thumbNow(key: string): string | undefined {
  return cache.get(key);
}

/**
 * The thumbnail for a file, made once per key however many rows ask. Null
 * means "draw it the old way": the caller falls back to the file itself.
 * The work is not cancelled when one asker leaves, because the row that
 * scrolls back is the next asker; only a job still waiting its turn is dropped.
 */
export function thumbUrl(key: string, src: string, edge: number, signal?: AbortSignal): Promise<string | null> {
  const have = cache.get(key);
  if (have !== undefined) return Promise.resolve(have);
  const going = making.get(key);
  if (going) return going;
  const job = gate(async () => {
    const res = await fetch(src);
    if (!res.ok) return null;
    const small = await shrinkPicture(await res.blob(), (w, h) => coverSize(w, h, edge));
    if (!small) return null;
    const url = URL.createObjectURL(small);
    cache.set(key, url);
    return url;
  }, signal).catch(() => null).finally(() => { making.delete(key); });
  making.set(key, job);
  return job;
}
