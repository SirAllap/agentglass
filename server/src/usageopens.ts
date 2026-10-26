// What the person opens, counted on this machine and nowhere else.
//
// The window notes each time a view, a Settings page, a panel or a modal is
// opened and sends the counts in batches (web/src/lib/usageOpens.ts). This keeps
// one small JSON file beside the rest of the app's state and answers GET
// /usage/opens from it. Nothing is sent anywhere, there is no setting for it,
// and deleting the file starts the count again.
//
// Ids are the window's own short names (`view:git`, `settings:about`,
// `panel:stats`), never a path, a title or anything the person typed: the shape
// is checked here as well, so a caller cannot put text of its own in the file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UsageOpens } from "../../shared/types.ts";


const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
/** More distinct ids than the app has doors, so a full table is a bug rather than a use. */
const MAX_IDS = 500;
/** One window's batch is a few seconds of clicking; a bigger count is not one. */
const MAX_PER_BATCH = 1000;

type Table = { since: string; rows: Record<string, { count: number; last: string }> };

function file(): string {
  const dir = process.env.AGENTGLASS_STATE_DIR
    || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
  return join(dir, "usage-opens.json");
}

const day = (d: Date) => d.toISOString().slice(0, 10);

let table: Table | null = null;

function load(now: Date): Table {
  if (table) return table;
  table = { since: day(now), rows: {} };
  const p = file();
  if (!existsSync(p)) return table;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { since?: unknown; rows?: unknown };
    if (typeof raw.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.since)) table.since = raw.since;
    if (raw.rows && typeof raw.rows === "object") {
      for (const [id, v] of Object.entries(raw.rows as Record<string, { count?: unknown; last?: unknown }>)) {
        if (!ID_RE.test(id) || !v || typeof v.count !== "number" || !Number.isFinite(v.count) || typeof v.last !== "string") continue;
        table.rows[id] = { count: Math.max(0, Math.floor(v.count)), last: v.last.slice(0, 10) };
      }
    }
  } catch { /* a corrupt file means the count starts again, not a dead server */ }
  return table;
}

function save(t: Table): void {
  const p = file();
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
    renameSync(tmp, p);
  } catch { /* the count is a convenience: a full disk must not fail the request */ }
}

/** Add a batch of `{id: times}`. Anything that is not an id the window mints is refused whole. */
export function recordOpens(batch: unknown, now = new Date()): { ok: true; recorded: number } | { ok: false; error: string } {
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) return { ok: false, error: "opens is an object of id: times" };
  const entries = Object.entries(batch as Record<string, unknown>);
  for (const [id, n] of entries) {
    if (!ID_RE.test(id)) return { ok: false, error: `not an id: ${id.slice(0, 24)}` };
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_PER_BATCH) return { ok: false, error: `${id}: a count from 1 to ${MAX_PER_BATCH}` };
  }
  const t = load(now);
  const fresh = entries.filter(([id]) => !t.rows[id]).length;
  if (Object.keys(t.rows).length + fresh > MAX_IDS) return { ok: false, error: "too many distinct ids" };
  const today = day(now);
  let recorded = 0;
  for (const [id, n] of entries as [string, number][]) {
    const row = t.rows[id] ?? (t.rows[id] = { count: 0, last: today });
    row.count += n;
    row.last = today;
    recorded += n;
  }
  if (entries.length) save(t);
  return { ok: true, recorded };
}

/** Most opened first, ties by the most recent. */
export function readOpens(now = new Date()): UsageOpens {
  const t = load(now);
  const opens = Object.entries(t.rows).map(([id, v]) => ({ id, count: v.count, last: v.last }))
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last) || a.id.localeCompare(b.id));
  return { since: t.since, opens };
}

/** For tests: forget the in-memory table so the next call reads the file again. */
export function __resetOpens(): void { table = null; }
