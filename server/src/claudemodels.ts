// The models the Chat panel offers for Claude Code.
//
// The other two agents are asked: Codex keeps a `models_cache.json` it refreshes
// itself, and Antigravity answers `agy models`. Claude Code publishes neither —
// there is no `models` subcommand, no `--list-models`, and nothing on disk — so
// the list has to be written down somewhere.
//
// Written down as *data*, in shared/claude-models.json, rather than as an array
// in a TypeScript file. The difference is who can fix it and how fast: a table
// compiled into the bundle is wrong the day Anthropic ships anything and stays
// wrong until somebody rebuilds and redeploys, while this file can be corrected
// in place and takes effect on the next request.
//
// A model is offered until its shutdown date has passed. That is the whole
// filter — `status` is recorded for the reader but is deliberately not consulted,
// because a superseded model still answers until it is actually retired and
// hiding it early would take away a choice that still works.
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { MODEL_RE } from "./chat.ts";
import type { AgentModel } from "../../shared/types.ts";

/** What one row of the catalogue may say. Everything except `id` is optional so
 *  a hand-edited file that omits a field degrades to a usable entry rather than
 *  disappearing. */
type Row = {
  id?: unknown;
  display_name?: unknown;
  status?: unknown;
  release_date?: unknown;
  scheduled_shutdown_date?: unknown;
};

/**
 * Where the catalogue is read from, most specific first.
 *
 * The override paths exist so the list can be corrected on a machine whose
 * checkout is read-only or packaged — the same reason `hooksDir()` searches
 * rather than assuming one layout.
 */
export function catalogPaths(): string[] {
  const out: string[] = [];
  const env = process.env.AGENTGLASS_CLAUDE_MODELS;
  if (env) out.push(env);
  out.push(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "claude-models.json"));
  // Beside the packaged binary, then the checkout this file lives in.
  out.push(join(dirname(process.execPath), "claude-models.json"));
  out.push(resolve(import.meta.dir, "../../shared/claude-models.json"));
  out.push(resolve(process.cwd(), "shared/claude-models.json"));
  return out;
}

/**
 * A last resort, not the source of truth.
 *
 * Reached only when every path above is missing or unreadable — a packaging
 * mistake, or a file edited into invalid JSON. Offering an empty dropdown would
 * make the panel look broken when the CLI works fine, so this is one id that is
 * certain to exist rather than an attempt at the whole list.
 */
const FALLBACK: AgentModel[] = [{ id: "claude-opus-5", label: "Claude Opus 5" }];

/**
 * Whether this model is still worth offering on `today`.
 *
 * Exported for tests, and the one rule in this file worth stating precisely:
 * the shutdown date is the last day the model is offered, so it disappears the
 * day *after*. Compared as calendar strings rather than as instants — these are
 * dates without a timezone, and turning them into Date objects would shift the
 * boundary by up to a day depending on where the server happens to be.
 *
 * A row with no shutdown date never expires. That is the useful reading: it
 * means "no retirement announced", not "retired at the epoch".
 */
export function isOffered(row: Row, today: string): boolean {
  const end = typeof row.scheduled_shutdown_date === "string" ? row.scheduled_shutdown_date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return true;
  return today <= end;
}

/** Today as `YYYY-MM-DD` in local time — the same calendar the dates are written in. */
export function todayStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * The catalogue, filtered to what is still offered.
 *
 * Exported separately from the file reading so the filtering can be tested
 * against a fixed date instead of against whatever day the suite runs on.
 */
export function parseCatalog(raw: string, today = todayStamp()): AgentModel[] {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return []; }
  const rows = (doc as { models?: unknown })?.models;
  if (!Array.isArray(rows)) return [];
  const out: AgentModel[] = [];
  const seen = new Set<string>();
  for (const r of rows as Row[]) {
    if (!r || typeof r !== "object") continue;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    // The same expression guards the spawn in chat.ts, so an id that would be
    // refused there is not offered here — a dropdown entry that cannot be sent
    // is worse than one that is missing.
    if (!id || seen.has(id) || !MODEL_RE.test(id)) continue;
    if (!isOffered(r, today)) continue;
    seen.add(id);
    out.push({ id, label: typeof r.display_name === "string" && r.display_name ? r.display_name : id });
  }
  return out;
}

/**
 * Read, with the file's own mtime as the cache key.
 *
 * Re-read when the file changes rather than once per process, because the point
 * of moving this out of the code was that somebody can fix it without a
 * restart. Re-read also when the day rolls over, so a model does not linger in
 * the dropdown until the server happens to be bounced.
 */
let cache: { path: string; key: string; day: string; models: AgentModel[] } | null = null;

export function claudeModels(): AgentModel[] {
  const day = todayStamp();
  for (const p of catalogPaths()) {
    let key: string;
    try {
      if (!existsSync(p)) continue;
      const st = statSync(p);
      // Size as well as mtime: two edits inside the same millisecond are rare
      // in life and routine in a test, and an mtime-only key serves the first
      // one twice.
      key = `${st.mtimeMs}:${st.size}`;
    } catch { continue; }
    if (cache && cache.path === p && cache.key === key && cache.day === day) return cache.models;
    try {
      const models = parseCatalog(readFileSync(p, "utf8"), day);
      if (models.length) { cache = { path: p, key, day, models }; return models; }
    } catch { /* unreadable; try the next candidate */ }
  }
  return FALLBACK;
}
