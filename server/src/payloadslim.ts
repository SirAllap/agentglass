/**
 * The two repeats that filled the events table.
 *
 * Measured on a copy of a real database (events payload ~208 MB): trimming long
 * tool answers would save 2 MB, because those were already cut to 4,000 chars.
 * The space was small things stored twice:
 *  - a tool's input, once on the PreToolUse row and again, identical, on the
 *    PostToolUse row: ~32 MB;
 *  - a reply's `usage`, whose `iterations` list holds one entry that repeats the
 *    usage block it sits in: up to ~27 MB.
 *
 * The Post row keeps the full input. Every reader of the big fields (the diff
 * list's old_string/new_string/content/edits, the session timeline, the files a
 * PR touched, the shared tree) reads the Post. The Pre row keeps what the readers
 * of a Pre ask for (command, file_path, skill, workdir, the feed label and the
 * Lantern line) and loses the rest once its Post has landed, marked
 * `tool_input_slim: true` so nobody mistakes the short copy for the call.
 */

/** Read off a Pre row, in full: collisions (command, file_path, filePath,
 *  workdir), insights (command), the open-tool list (file_path), top skills
 *  (skill), the feed label (command, file_path, path, query, pattern), Lantern's
 *  last tool (description, pattern, query, title, url, subagent_type). */
const KEEP_FULL = new Set([
  "command", "file_path", "filePath", "path", "notebook_path", "workdir", "skill", "url",
  "pattern", "query", "description", "task_id", "subagent_type", "title", "run_in_background",
]);
/** Any other string is kept up to here: Lantern shows a Task `prompt` cut to 120. */
const SHORT = 200;

/** The Pre's copy of an input whose full form lives on the Post, or null when
 *  there is nothing worth dropping (so the row is left alone). */
export function slimToolInput(ti: unknown): Record<string, unknown> | null {
  if (!ti || typeof ti !== "object" || Array.isArray(ti)) return null;
  const out: Record<string, unknown> = {};
  let dropped = false;
  for (const [k, v] of Object.entries(ti as Record<string, unknown>)) {
    if (KEEP_FULL.has(k) && (v === null || typeof v !== "object")) { out[k] = v; continue; }
    if (typeof v === "string") {
      if (v.length > SHORT) { out[k] = v.slice(0, SHORT); dropped = true; } else out[k] = v;
    } else if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else dropped = true;
  }
  return dropped ? out : null;
}

/** Same value, key order aside? Inputs are small JSON; this is exact for them. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same((a as any)[k], (b as any)[k]));
}
export const sameInput = same;

/**
 * Drop `usage.iterations` when it is one entry repeating the usage it sits in.
 *
 * Nothing reads `iterations`: spend is read from the top-level counts (and, for
 * the row's columns, already summed at ingest). A list of several iterations
 * carries numbers the total does not, and stays. Returns whether it changed.
 */
export function dropRepeatedIterations(payload: Record<string, unknown> | null | undefined): boolean {
  const u = payload?.usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") return false;
  const it = u.iterations;
  if (!Array.isArray(it) || it.length !== 1) return false;
  const one = it[0];
  if (!one || typeof one !== "object" || Array.isArray(one)) return false;
  for (const [k, v] of Object.entries(one as Record<string, unknown>)) {
    if (k === "type") continue;
    if (!same(v, u[k])) return false;
  }
  delete u.iterations;
  return true;
}

/**
 * The third weight: a tool's answer, stored whole when nobody reads it whole.
 *
 * A hook's PostToolUse carries `tool_response` as the tool returned it, up to
 * the 64 KB-per-string ingest bound: a Read's file, a Bash's stdout, a Write's
 * file again as `content`, and for every Edit and Write `originalFile`, the
 * whole file as it was before. The transcript scanner already cuts its answers
 * to 4,000 chars; hook rows did not.
 *
 * Every reader of a stored answer reads a short field or its head: filePath
 * (the change list, the shared tree), structuredPatch (diff lines, short each),
 * backgroundTaskId (Lantern), content's first 4,000 chars (the run list), and the
 * `/stream` frame caps every payload string at the same 4,000. Nothing reads
 * originalFile. The web never reads tool_response. So the stored answer is cut
 * to what is read: originalFile goes, every other string keeps its first
 * RESPONSE_CAP chars with the same `…[+N chars]` tail the wire cut writes.
 * `tool_input` is not touched: the diffs are rebuilt from it.
 */
export const RESPONSE_CAP = 4000;
const capStr = (v: string): string => (v.length > RESPONSE_CAP ? `${v.slice(0, RESPONSE_CAP)}…[+${v.length - RESPONSE_CAP} chars]` : v);
function capDeep(v: unknown, depth: number): { v: unknown; changed: boolean } {
  if (typeof v === "string") { const c = capStr(v); return { v: c, changed: c !== v }; }
  if (depth > 8 || !v || typeof v !== "object") return { v, changed: false };
  let changed = false;
  if (Array.isArray(v)) {
    const out = v.map((el) => { const r = capDeep(el, depth + 1); if (r.changed) changed = true; return r.v; });
    return changed ? { v: out, changed } : { v, changed: false };
  }
  const out: Record<string, unknown> = {};
  for (const [k, el] of Object.entries(v as Record<string, unknown>)) {
    const r = capDeep(el, depth + 1);
    if (r.changed) changed = true;
    out[k] = r.v;
  }
  return changed ? { v: out, changed } : { v, changed: false };
}

/** The payload with its `tool_response` cut to what is read, or null when
 *  there is nothing to cut (so the row is left alone). Never mutates. */
export function slimToolResponse(payload: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const tr = payload?.tool_response;
  if (!tr || typeof tr !== "object") {
    if (typeof tr === "string" && tr.length > RESPONSE_CAP) return { ...payload, tool_response: capStr(tr) };
    return null;
  }
  let base = tr as Record<string, unknown>;
  let dropped = false;
  if (!Array.isArray(tr) && "originalFile" in base) {
    const { originalFile: _gone, ...rest } = base;
    base = rest; dropped = true;
  }
  const r = capDeep(base, 0);
  if (!dropped && !r.changed) return null;
  return { ...payload, tool_response: r.v };
}

/**
 * The fourth and fifth cut, at insert only (older rows are left alone).
 *
 * Measured read-only on a copy of a real database (168k events, 8 days, 523 MB):
 *  - a Bash answer's `content` is 50.7 MB of the 66.8 MB of stored answers. Its
 *    one reader, the session run list, shows the head of it; a run's output is
 *    judged by its first lines. Cut from 4,000 to BASH_CONTENT_CAP chars (head
 *    kept, the same `…[+N chars]` tail): about 26 MB.
 *  - a Stop row's `usage` is 15 MB. Ingest reads it into the token columns
 *    before the insert; nothing reads it back from the stored payload.
 * Together about 35-40 MB. Retention stays 8 days.
 */
export const BASH_CONTENT_CAP = 1000;
export function slimForInsert(payload: Record<string, unknown> | null | undefined, hookEventType: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  let out: Record<string, unknown> | null = null;
  if (hookEventType === "Stop" && "usage" in payload) {
    const { usage: _gone, ...rest } = payload;
    out = rest;
  }
  const tr = (out ?? payload).tool_response as Record<string, unknown> | undefined;
  if ((out ?? payload).tool_name === "Bash" && tr && typeof tr === "object" && !Array.isArray(tr)
    && typeof tr.content === "string" && tr.content.length > BASH_CONTENT_CAP) {
    const c = tr.content;
    out = { ...(out ?? payload), tool_response: { ...tr, content: `${c.slice(0, BASH_CONTENT_CAP)}…[+${c.length - BASH_CONTENT_CAP} chars]` } };
  }
  return out;
}

/**
 * The cut for events past the hot window (COLD_AFTER_MS), measured on a copy of a
 * real database (771,679 events, 641 MB of payload, 6.4 days). Every number is
 * what the cut takes from the rows older than one day.
 *
 * What a reader of an old row asks for, by field (grep of server/src and web/src):
 *  - tool_input.command: the feed label (web/src/lib/labels.ts, shown cut by the
 *    row), insights' loops (last 30 min) and collisions (last 30 min). Nobody
 *    needs a second kilobyte of a day-old command. Cut to COLD_COMMAND_CAP on both
 *    the Pre and the Post, which hold the same text: about 83 MB.
 *  - tool_response.content of a Bash answer: the run list shows its head; already
 *    cut to BASH_CONTENT_CAP at insert, rows from before that are cut here: ~36 MB.
 *  - `usage`: ingest reads it into the token columns before the insert; nothing
 *    reads it back from the stored payload (slimForInsert drops it on a Stop
 *    already). Dropped on any row: ~48 MB.
 *  - any other long string in the input of a tool that is not a diff tool (a Task
 *    prompt, a message): Lantern reads 120 chars of it. Cut to SHORT: ~9 MB.
 * Kept: every Write/Edit/MultiEdit/NotebookEdit input and answer (the change list
 * rebuilds diffs from them), `last_assistant_message` and `prompt` (the session
 * conversation and the PR summary read them), and every short field.
 */
export const COLD_AFTER_MS = 86_400_000;
export const COLD_COMMAND_CAP = 500;
const DIFF_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const CUT_MARK = /…\[\+\d+ chars\]$/;
/** Cut s to n chars plus a marker; a string that already ends with the marker is returned as is, so a second pass never rewrites the count. */
const cutTail = (s: string, n: number): string => CUT_MARK.test(s) ? s : `${s.slice(0, n)}…[+${s.length - n} chars]`;

/** The payload of an old event with what nothing reads cut away, or null when
 *  there is nothing to cut (so the row is left alone). Never mutates. */
export function slimColdEvent(payload: Record<string, unknown> | null | undefined, hookEventType: string, toolName: string | null): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  let out: Record<string, unknown> | null = null;
  if ("usage" in payload) { const { usage: _gone, ...rest } = payload; out = rest; }
  const cur = () => out ?? payload;
  const ti = cur().tool_input;
  if ((hookEventType === "PreToolUse" || hookEventType === "PostToolUse") && ti && typeof ti === "object" && !Array.isArray(ti)
    && !(hookEventType === "PostToolUse" && toolName && DIFF_TOOLS.has(toolName))) {
    const slim = slimToolInput(ti) ?? (ti as Record<string, unknown>);
    const cmd = slim.command;
    const next = typeof cmd === "string" && cmd.length > COLD_COMMAND_CAP && !CUT_MARK.test(cmd) ? { ...slim, command: cutTail(cmd, COLD_COMMAND_CAP) } : slim;
    if (next !== ti) out = { ...cur(), tool_input: next };
  }
  const tr = cur().tool_response as Record<string, unknown> | undefined;
  if (toolName === "Bash" && tr && typeof tr === "object" && !Array.isArray(tr)
    && typeof tr.content === "string" && tr.content.length > BASH_CONTENT_CAP && !CUT_MARK.test(tr.content)) {
    out = { ...cur(), tool_response: { ...tr, content: cutTail(tr.content, BASH_CONTENT_CAP) } };
  }
  return out;
}
