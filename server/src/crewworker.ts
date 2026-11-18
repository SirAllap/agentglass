// What a headless OpenCode worker's Crew card says.
//
// The board's facts come from Claude Code's hooks (lantern.ts, `sessionFacts`),
// and a headless worker fires none: the card read "0 tools, ~$0.00" with no
// model while the turn was spending money. The worker does leave its turn in
// `worker-runs/<name>/out` — one JSON frame per line, the same stream
// opencodeusage.ts prices — so the numbers are already on this machine and only
// had to be mapped. Nothing here is a guess: a fact with no frame behind it is
// left out rather than drawn as zero.
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RunFacts {
  model?: string;
  tools: number;
  errors: number;
  cost: number;
  lastSeen?: number;
  /** The last thing it did, in one line: the text it printed, the tool it ran
   *  (and what on), or the error that stopped it. */
  activity?: string;
  lastTool?: { name: string; what: string; at: number };
  /** The turn wrote its status: nothing is running any more. */
  ended: boolean;
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 120);

/** The tool's own one-line description, before the dict's first arbitrary key. */
function toolWhat(input: unknown): string {
  if (!input || typeof input !== "object") return typeof input === "string" ? collapse(input) : "";
  const i = input as Record<string, unknown>;
  for (const k of ["description", "command", "filePath", "path", "pattern", "query", "url", "prompt"]) {
    const v = i[k];
    if (typeof v === "string" && v.trim()) return collapse(v);
  }
  for (const v of Object.values(i)) if (typeof v === "string" && v.trim()) return collapse(v);
  return "";
}

/** `opencode-go/deepseek-v4.1-flash` is the model, and the chip names it. */
const modelOf = (m: unknown): string | undefined => {
  if (typeof m !== "string" || !m.trim()) return undefined;
  return m.trim().split("/").filter(Boolean).pop();
};

/**
 * The frame stream of one turn, as the facts a card draws.
 *
 * OpenCode 1.18.32 writes `{type, timestamp, sessionID, part}` per line
 * (fixtures/fakeEngines.ts); a tool call is a `tool_use` whose
 * `part.state.status` is already `completed` or `error`, an engine failure is
 * an `error` frame, and `step_finish` carries the step's cost. A line that is
 * not JSON is prose from a signed-out or rate-limited CLI: it is kept as the
 * last activity, never counted as a tool.
 *
 * `exitCode` is the turn's `rc` file: present means the turn is over, which is
 * the one thing the stream alone cannot say.
 */
export function crewFactsOfRun(out: string, opts: { model?: string; exitCode?: number | null } = {}): RunFacts {
  const st = newFold();
  for (const line of out.split("\n")) foldLine(st, line);
  return finishFold(st, opts);
}

/* The stream folded so far. One line at a time, so a turn that grew by a few
   frames is read from where the last read stopped, not from byte 0. */
interface Fold { f: RunFacts; frameModel?: string; any: boolean }
const newFold = (): Fold => ({ f: { tools: 0, errors: 0, cost: 0, ended: false }, any: false });
const cloneFold = (st: Fold): Fold => ({
  f: { ...st.f, ...(st.f.lastTool ? { lastTool: { ...st.f.lastTool } } : {}) },
  frameModel: st.frameModel, any: st.any,
});

function finishFold(st: Fold, opts: { model?: string; exitCode?: number | null }): RunFacts {
  const f: RunFacts = { ...st.f, ...(st.f.lastTool ? { lastTool: { ...st.f.lastTool } } : {}), ended: opts.exitCode !== undefined && opts.exitCode !== null };
  const model = st.frameModel ?? modelOf(opts.model);
  if (model) f.model = model;
  return f;
}

function foldLine(st: Fold, line: string): void {
  const f = st.f;
  const raw = line.trim();
  if (!raw) return;
  st.any = true;
  if (!raw.startsWith("{")) {
    f.activity = collapse(raw);
    return;
  }
  let frame: Record<string, unknown>;
  try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
  if (!frame || typeof frame !== "object") return;
  const part = (frame.part && typeof frame.part === "object" ? frame.part : {}) as Record<string, unknown>;
  st.frameModel ??= modelOf(part.modelID) ?? modelOf(frame.modelID)
    ?? modelOf((part.model as { id?: unknown } | undefined)?.id) ?? modelOf((frame.model as { id?: unknown } | undefined)?.id)
    ?? modelOf(frame.model);

  const at = Number(frame.timestamp ?? part.timestamp);
  if (Number.isFinite(at) && at > 0) f.lastSeen = Math.max(f.lastSeen ?? 0, at);

  const kind = String(frame.type ?? "");
  if (kind === "tool_use" || part.type === "tool") {
    const state = (part.state && typeof part.state === "object" ? part.state : {}) as Record<string, unknown>;
    const name = typeof part.tool === "string" && part.tool ? part.tool : "tool";
    const what = toolWhat(state.input);
    f.tools++;
    if (state.status === "error") f.errors++;
    f.activity = collapse(what ? `${name} · ${what}` : name);
    if (Number.isFinite(at)) f.lastTool = { name, what, at };
    return;
  }
  if (kind === "error") {
    const err = frame.error;
    const data = (err && typeof err === "object" ? (err as { data?: { message?: unknown }; message?: unknown }).data : undefined);
    const msg = typeof data?.message === "string" ? data.message
      : typeof (err as { message?: unknown } | undefined)?.message === "string" ? String((err as { message?: unknown }).message)
        : typeof err === "string" ? err : "";
    f.errors++;
    f.activity = collapse(msg || "the engine reported an error");
    return;
  }
  if (kind === "text" || part.type === "text") {
    const text = typeof part.text === "string" ? part.text : typeof frame.text === "string" ? frame.text : "";
    if (text.trim()) f.activity = collapse(text);
    return;
  }
  if (kind === "step_finish" || kind === "step-finish") {
    const cost = Number(part.cost ?? frame.cost);
    if (Number.isFinite(cost) && cost > 0) f.cost += cost;
  }
}

function stateDir(): string {
  return process.env.AGENTGLASS_STATE_DIR
    || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
}

/** One worker's turn folder, as `agents/headless.ts` lays it out. Read here
 *  rather than imported: the board must not drag the worker's spawn code in. */
export function workerRunDir(name: string): string {
  return join(stateDir(), "worker-runs", name);
}

/**
 * One named worker's facts, from its own turn folder. Null when there is no
 * stream to read — a worker this app has not run since the folder was cleared,
 * or one started by somebody else — so the card keeps whatever it had.
 */
export function crewFactsOfWorker(name: string, opts: { model?: string } = {}): RunFacts | null {
  const dir = workerRunDir(name);
  const st = readRun(join(dir, "out"));
  if (!st || !st.any) return null;
  let exitCode: number | null = null;
  try {
    const rc = readFileSync(join(dir, "rc"), "utf8").trim();
    exitCode = /^\d+$/.test(rc) ? Number(rc) : null;
  } catch { /* still running: the wrapper moves `rc` in when the tab has drained */ }
  return finishFold(st, { model: opts.model, exitCode });
}

/*
 * EACH TURN'S STREAM IS READ ONCE, then only what was appended.
 *
 * The board asks for these on every `GET /agents/board`, which the rail polls
 * every 5 to 20 s, for every open worker and every one that ended in the last
 * half hour. This read the whole `out` each time and parsed every frame: turns
 * run to 20-60 MB, and the stall log had it at 170-330k disk blocks and
 * 600-800 ms per call with nothing else going on. A stream only grows while
 * its turn runs, so the fold is kept with the byte offset it reached: the same
 * size and mtime is no read at all, a bigger file is read from that offset,
 * and anything else (another inode, a shorter file, a rewrite of the same
 * size) starts again from byte 0. The partial last line is folded into a copy,
 * never into what is kept, so a frame cut in half is read whole next time.
 * `out` is deleted and made again each turn, and ext4 gives the inode back, so
 * the same inode and a bigger size can still be a new stream: the first bytes
 * are kept too, and when they differ the read starts again from byte 0.
 */
interface RunCache { ino: number; size: number; mtimeMs: number; offset: number; head: Buffer; fold: Fold; result: Fold }
const RUN_HEAD = 256;
const runCache = new Map<string, RunCache>();
const RUN_CACHE_MAX = 256;
/** Bytes read from `out` files, for the test that pins the read budget. */
export let runBytesRead = 0;
export function __resetRunCache(): void { runCache.clear(); runBytesRead = 0; }

function readRun(path: string): Fold | null {
  let s: { ino: number; size: number; mtimeMs: number };
  try { s = statSync(path); } catch { runCache.delete(path); return null; }
  let c = runCache.get(path);
  if (c && c.ino === s.ino && c.size === s.size && c.mtimeMs === s.mtimeMs) return c.result;
  if (!c || c.ino !== s.ino || s.size < c.offset || (s.size <= c.size && s.mtimeMs !== c.mtimeMs)) c = undefined;
  let buf: Buffer;
  let start = 0;
  try {
    const fd = openSync(path, "r");
    try {
      // Same inode, bigger file: an append only if it still starts as it did.
      // These few bytes are not counted in runBytesRead, which is the stream.
      if (c && c.head.length > 0) {
        const now = Buffer.alloc(c.head.length);
        const n = readSync(fd, now, 0, now.length, 0);
        if (n !== now.length || !now.equals(c.head)) c = undefined;
      }
      if (!c) c = { ino: s.ino, size: 0, mtimeMs: 0, offset: 0, head: Buffer.alloc(0), fold: newFold(), result: newFold() };
      start = c.offset;
      const want = Math.max(0, s.size - c.offset);
      buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) {
        const n = readSync(fd, buf, got, want - got, c.offset + got);
        if (n <= 0) break;
        got += n;
      }
      buf = buf.subarray(0, got);
    } finally { closeSync(fd); }
  } catch { return null; }
  runBytesRead += buf.length;
  if (c.head.length < RUN_HEAD && start <= c.head.length) {
    c.head = Buffer.from(Buffer.concat([c.head.subarray(0, start), buf]).subarray(0, RUN_HEAD));
  }
  const cut = buf.lastIndexOf(0x0a);
  if (cut >= 0) {
    for (const line of buf.subarray(0, cut).toString("utf8").split("\n")) foldLine(c.fold, line);
    c.offset += cut + 1;
  }
  const tail = buf.subarray(cut + 1).toString("utf8");
  const result = tail.trim() ? cloneFold(c.fold) : c.fold;
  if (tail.trim()) foldLine(result, tail);
  c.size = c.offset + (buf.length - cut - 1);
  c.mtimeMs = s.mtimeMs;
  c.result = result;
  runCache.delete(path);
  if (runCache.size >= RUN_CACHE_MAX) runCache.delete(runCache.keys().next().value!);
  runCache.set(path, c);
  return result;
}
