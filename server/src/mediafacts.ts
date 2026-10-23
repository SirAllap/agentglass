/*
 * What the Finder's audio and video preview says about a file, and one frame of
 * a video to stand in until it plays.
 *
 * ffprobe and ffmpeg, whichever this machine has; nothing is installed to
 * satisfy a preview. Both run with a deadline and a bounded stdout, and both
 * judge the path with `browseReal`, the folder list's own boundary, so a file
 * the list would not show is not probed either.
 */
import { statSync } from "node:fs";
import { browseReal } from "./browse.ts";
import type { MediaFacts } from "../../shared/types.ts";

export type { MediaFacts };

const PROBE_MS = 4000;
const PROBE_BYTES = 256 * 1024;
const POSTER_MS = 6000;
const POSTER_BYTES = 8 * 1024 * 1024;

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const fraction = (v: unknown): number | undefined => {
  const m = /^(\d+)\/(\d+)$/.exec(String(v ?? ""));
  return m && Number(m[2]) > 0 ? Math.round((Number(m[1]) / Number(m[2])) * 100) / 100 : undefined;
};

/** ffprobe's JSON, reduced to what the info line shows. A cover picture is a
 *  video stream with `attached_pic`, and is not a video. */
export function parseProbe(json: unknown): MediaFacts {
  const j = (json ?? {}) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const streams = Array.isArray(j.streams) ? j.streams : [];
  const real = (s: Record<string, unknown>) => !(s.disposition as { attached_pic?: number } | undefined)?.attached_pic;
  const v = streams.find((s) => s.codec_type === "video" && real(s));
  const a = streams.find((s) => s.codec_type === "audio");
  const tags = Object.fromEntries(Object.entries((j.format?.tags ?? {}) as Record<string, unknown>).map(([k, x]) => [k.toLowerCase(), String(x)]));
  const out: MediaFacts = { ok: !!(v || a) };
  const duration = num(j.format?.duration) ?? num(v?.duration) ?? num(a?.duration);
  if (duration) out.duration = duration;
  if (v) out.video = { codec: String(v.codec_name ?? ""), width: Number(v.width) || 0, height: Number(v.height) || 0, fps: fraction(v.avg_frame_rate) };
  if (a) out.audio = { codec: String(a.codec_name ?? ""), channels: num(a.channels), sampleRate: num(a.sample_rate) };
  const bitRate = num(j.format?.bit_rate);
  if (bitRate) out.bitRate = bitRate;
  for (const k of ["title", "artist", "album", "track"] as const) if (tags[k]) out[k] = tags[k].slice(0, 200);
  if (!out.ok) out.error = "no audio or video stream";
  return out;
}

async function run(argv: string[], ms: number, cap: number): Promise<Uint8Array | null> {
  let p: ReturnType<typeof Bun.spawn>;
  try { p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" }); } catch { return null; }
  const timer = setTimeout(() => p.kill(), ms);
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) { p.kill(); return null; }
      chunks.push(value);
    }
    if ((await p.exited) !== 0) return null;
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
  } finally { clearTimeout(timer); }
}

function realFile(pathIn: unknown, local: boolean): { abs: string } | { error: string } {
  const abs = browseReal(pathIn, local);
  if (!abs) return { error: "outside the places the Finder shows" };
  try { if (!statSync(abs).isFile()) return { error: "not a file" }; } catch { return { error: "no such file" }; }
  return { abs };
}

export async function mediaFacts(pathIn: unknown, local = false): Promise<MediaFacts> {
  const r = realFile(pathIn, local);
  if ("error" in r) return { ok: false, error: r.error };
  const out = await run(["ffprobe", "-v", "error", "-threads", "1", "-show_entries",
    "stream=codec_type,codec_name,width,height,duration,avg_frame_rate,sample_rate,channels:stream_disposition=attached_pic:format=duration,bit_rate:format_tags=title,artist,album,track",
    "-of", "json", r.abs], PROBE_MS, PROBE_BYTES);
  if (!out) return { ok: false, error: "ffprobe could not read this file" };
  try { return parseProbe(JSON.parse(new TextDecoder().decode(out))); } catch { return { ok: false, error: "ffprobe answered with something unreadable" }; }
}

/** One frame, a second in (or the start for a shorter clip), as a small jpeg. */
export async function posterFrame(pathIn: unknown, local = false): Promise<{ ok: true; body: Uint8Array } | { ok: false; error: string }> {
  const r = realFile(pathIn, local);
  if ("error" in r) return { ok: false, error: r.error };
  for (const at of ["1", "0"]) {
    const out = await run(["ffmpeg", "-v", "error", "-threads", "1", "-ss", at, "-i", r.abs, "-frames:v", "1",
      "-vf", "scale='min(640,iw)':-2", "-f", "image2pipe", "-vcodec", "mjpeg", "-"], POSTER_MS, POSTER_BYTES);
    if (out && out.byteLength > 0) return { ok: true, body: out };
  }
  return { ok: false, error: "ffmpeg could not make a frame" };
}
