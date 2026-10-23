// One inotify instance for a whole tree.
//
// `fs.watch` was measured first and does not scale to a home directory: Bun
// opens about ten file descriptors per watched directory and took 6.9 s and
// 153 MB to arm 20,000 of them, so the 120,000 folders of a real home are out
// of reach, and its `recursive` option on Linux missed a file created in a
// folder made after it was armed. One inotify instance watches every folder
// through libc instead: 120,910 watches armed in 1.2 s, 23 descriptors in all.
//
// Linux only. Anywhere else `openWatcher` returns null and the index goes
// without events (it then rebuilds when it is asked and is old, see homeindex).
//
// The descriptor is blocking and read through a stream, so the read waits in
// the thread pool, not on the server's loop. A non-blocking one answered
// EAGAIN to the stream and delivered nothing.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, createReadStream } from "node:fs";

/** Names only: a folder gained or lost an entry, or moved. Content changes are not events here. */
const MASK = 0x100 /* create */ | 0x200 /* delete */ | 0x40 /* moved from */ | 0x80 /* moved to */ | 0x400 /* self deleted */ | 0x800 /* self moved */;
export const IN_ISDIR = 0x40000000;
export const IN_Q_OVERFLOW = 0x4000;
export const IN_IGNORED = 0x8000;
export const IN_CREATE = 0x100, IN_DELETE = 0x200, IN_MOVED_FROM = 0x40, IN_MOVED_TO = 0x80, IN_DELETE_SELF = 0x400, IN_MOVE_SELF = 0x800;

export interface WatchEvent { wd: number; mask: number; name: string }
export interface Watcher {
  /** The watch number for a folder, or -1 when the kernel refused (the limit on watches, usually). */
  add(path: string): number;
  close(): void;
}

/** Split the bytes of `struct inotify_event` records into events. A record cut by a chunk boundary is carried to the next read. */
export function parseEvents(buf: Buffer, carry: Buffer | null): { events: WatchEvent[]; rest: Buffer | null } {
  const all = carry ? Buffer.concat([carry, buf]) : buf;
  const events: WatchEvent[] = [];
  let at = 0;
  while (at + 16 <= all.length) {
    const len = all.readUInt32LE(at + 12);
    if (at + 16 + len > all.length) break;
    const raw = all.subarray(at + 16, at + 16 + len);
    const nul = raw.indexOf(0);
    events.push({ wd: all.readInt32LE(at), mask: all.readUInt32LE(at + 4), name: raw.subarray(0, nul < 0 ? raw.length : nul).toString("utf8") });
    at += 16 + len;
  }
  return { events, rest: at < all.length ? Buffer.from(all.subarray(at)) : null };
}

export function openWatcher(onEvents: (events: WatchEvent[]) => void): Watcher | null {
  if (process.platform !== "linux") return null;
  try {
    const { symbols: c } = dlopen("libc.so.6", {
      inotify_init1: { args: [FFIType.i32], returns: FFIType.i32 },
      inotify_add_watch: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    const fd = c.inotify_init1(0);
    if (fd < 0) return null;
    let carry: Buffer | null = null;
    const stream = createReadStream("", { fd, autoClose: false, highWaterMark: 64 * 1024 } as never);
    stream.on("data", (chunk: string | Buffer) => {
      const r = parseEvents(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), carry);
      carry = r.rest;
      if (r.events.length) onEvents(r.events);
    });
    stream.on("error", () => { /* a closed descriptor ends the stream; nothing to report */ });
    return {
      add: (path) => c.inotify_add_watch(fd, ptr(Buffer.from(path + "\0")), MASK),
      close: () => { stream.destroy(); try { closeSync(fd); } catch { /* already gone */ } },
    };
  } catch { return null; }
}
