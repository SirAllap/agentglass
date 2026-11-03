// What a headless OpenCode worker's Crew card says.
//
// The board's facts come from Claude Code's hooks (lantern.ts, `sessionFacts`),
// and a headless worker fires none: the card read "0 tools, ~$0.00" with no
// model while the turn was spending money. The worker does leave its turn in
// `worker-runs/<name>/out` — one JSON frame per line, the same stream
// opencodeusage.ts prices — so the numbers are already on this machine and only
// had to be mapped. Nothing here is a guess: a fact with no frame behind it is
// left out rather than drawn as zero.
import { readFileSync } from "node:fs";
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
  const f: RunFacts = { tools: 0, errors: 0, cost: 0, ended: opts.exitCode !== undefined && opts.exitCode !== null };
  let frameModel: string | undefined;
  for (const line of out.split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    if (!raw.startsWith("{")) {
      f.activity = collapse(raw);
      continue;
    }
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
    if (!frame || typeof frame !== "object") continue;
    const part = (frame.part && typeof frame.part === "object" ? frame.part : {}) as Record<string, unknown>;
    frameModel ??= modelOf(part.modelID) ?? modelOf(frame.modelID)
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
      continue;
    }
    if (kind === "error") {
      const err = frame.error;
      const data = (err && typeof err === "object" ? (err as { data?: { message?: unknown }; message?: unknown }).data : undefined);
      const msg = typeof data?.message === "string" ? data.message
        : typeof (err as { message?: unknown } | undefined)?.message === "string" ? String((err as { message?: unknown }).message)
          : typeof err === "string" ? err : "";
      f.errors++;
      f.activity = collapse(msg || "the engine reported an error");
      continue;
    }
    if (kind === "text" || part.type === "text") {
      const text = typeof part.text === "string" ? part.text : typeof frame.text === "string" ? frame.text : "";
      if (text.trim()) f.activity = collapse(text);
      continue;
    }
    if (kind === "step_finish" || kind === "step-finish") {
      const cost = Number(part.cost ?? frame.cost);
      if (Number.isFinite(cost) && cost > 0) f.cost += cost;
    }
  }
  const model = frameModel ?? modelOf(opts.model);
  if (model) f.model = model;
  return f;
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
  let out: string;
  try { out = readFileSync(join(dir, "out"), "utf8"); } catch { return null; }
  if (!out.trim()) return null;
  let exitCode: number | null = null;
  try {
    const rc = readFileSync(join(dir, "rc"), "utf8").trim();
    exitCode = /^\d+$/.test(rc) ? Number(rc) : null;
  } catch { /* still running: the wrapper moves `rc` in when the tab has drained */ }
  return crewFactsOfRun(out, { model: opts.model, exitCode });
}
