/*
 * THE LANTERN'S WATCH — the field re-read on a clock, and a loud word when
 * something on it needs a person.
 *
 * The Lantern's chat answers when asked, and the rail lights the moment
 * somebody is stopped on you; neither says anything to a person who is not
 * looking. "Have it look every fifteen minutes, go over everything again, and
 * if it finds something unattended or that we have forgotten, send us a
 * notification that is hard to miss." So: every N minutes the same board the
 * view reads is read here, and what it finds goes out through the alert
 * channel everything else in this app uses — the app's bell and the phone
 * when one is attached, the desktop's notifications otherwise, critical, so it
 * stays on screen until dismissed.
 *
 * On the server rather than in the chat's prompt, and that was the choice to
 * make: a watch inside a Claude session dies with its tab and spends a turn
 * every tick to reread a list; this one is on whenever the app is, reads the
 * facts directly, and costs nothing. The chat is told the watch exists so it
 * does not try to be one.
 *
 * What it flags is FACTS, in three kinds, and nothing it has to guess at:
 *   still waiting  — an agent stopped on a person: a permission, a held gate,
 *                    a turn waiting for its next prompt. The instant alert
 *                    already fired when it happened; this is the "still" —
 *                    fifteen minutes later it is still sitting there.
 *   forgotten      — an agent that said what it was working on, never said it
 *                    was done, and has been quiet for a long while: finished
 *                    and nobody looked, or stuck and nobody noticed.
 *   gone           — a named agent (a script's worker) whose window vanished
 *                    since the last look, without ever saying done.
 *
 * One notification per tick, never one per finding: the interval is the
 * throttle, and a person away from the machine gets one loud line every N
 * minutes while something needs them — which is what was asked for — rather
 * than a pile.
 */
import * as AgentBoard from "./agentboard.ts";
import { boardNow } from "./lantern.ts";
import { reconcile as namedAlive, type NamedAgent } from "./agentops.ts";
import { lanternWatch, lanternWatchMinutes } from "./config.ts";
import { pushLantern } from "./alerts.ts";

export interface Finding {
  kind: "waiting" | "forgotten" | "gone";
  name: string;
  line: string;
  pane?: string;
  /** Sort key: the oldest wait first, then the longest silence. */
  since: number;
}

/** How long a said-but-not-done agent may be quiet before it is "forgotten".
 *  An hour: shorter than that is a long tool call or a lunch, and the point
 *  of this kind is work that has sat since before you last looked. */
export const FORGOTTEN_AFTER_MS = 60 * 60_000;

const ago = (t: number, now: number) => {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m}m` : m < 60 * 24 ? `${Math.round(m / 60)}h` : `${Math.round(m / (60 * 24))}d`;
};
const waitWord = (w: NonNullable<AgentBoard.BoardRow["needsYou"]>) =>
  w.kind === "permission" ? "needs your permission" : w.kind === "gate" ? "is held at the gate" : "is waiting for your next prompt";

/**
 * What one look at the field says needs a person. Pure: the board, the named
 * agents alive now and at the previous look, and the clock.
 */
export function findings(p: {
  rows: AgentBoard.BoardRow[];
  namedNow: NamedAgent[];
  namedBefore: NamedAgent[] | null;
  now?: number;
}): Finding[] {
  const now = p.now ?? Date.now();
  const out: Finding[] = [];
  for (const r of p.rows) {
    if (r.needsYou) {
      /* A turn that ended is not urgent: the agent finished and is waiting
         for whatever you say next, which is most sessions most of the time.
         It becomes a finding the way forgotten work does — after an hour of
         nobody coming back to it. A permission or a gate is urgent at once. */
      if (r.needsYou.kind === "input" && now - r.needsYou.since < FORGOTTEN_AFTER_MS) continue;
      out.push({
        kind: "waiting", name: r.name, pane: r.paneId, since: r.needsYou.since,
        line: `${r.name} ${waitWord(r.needsYou)} — ${ago(r.needsYou.since, now)}${r.needsYou.why ? `: ${r.needsYou.why}` : ""}`.slice(0, 200),
      });
      continue;
    }
    /* "Said what it was on, never said done, quiet for an hour." A row the
       hooks made without a status post has no `doing`, and an idle pane that
       never claimed a task is not forgotten work — it is a shell. */
    if (r.state === "idle" && r.doing && r.saidAt && now - r.saidAt >= FORGOTTEN_AFTER_MS) {
      out.push({
        kind: "forgotten", name: r.name, pane: r.paneId, since: r.saidAt,
        line: `${r.name} said it was on "${r.doing}" and has been quiet for ${ago(r.saidAt, now)} — done, or stuck?`.slice(0, 200),
      });
    }
  }
  if (p.namedBefore) {
    const alive = new Set(p.namedNow.map((a) => a.name));
    for (const a of p.namedBefore) {
      if (!alive.has(a.name)) {
        out.push({ kind: "gone", name: a.name, since: a.startedAt, line: `${a.name}'s window is gone (started ${ago(a.startedAt, now)} ago in ${a.cwd.split("/").pop()})` });
      }
    }
  }
  const rank = { waiting: 0, gone: 1, forgotten: 2 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.since - b.since);
}

/** The one notification a tick sends: a title that counts, a body that names. */
export function notice(f: Finding[]): { title: string; body: string; pane?: string } | null {
  if (!f.length) return null;
  const n = (k: Finding["kind"]) => f.filter((x) => x.kind === k).length;
  const parts = [
    n("waiting") ? `${n("waiting")} need${n("waiting") === 1 ? "s" : ""} you` : "",
    n("gone") ? `${n("gone")} gone` : "",
    n("forgotten") ? `${n("forgotten")} look${n("forgotten") === 1 ? "s" : ""} forgotten` : "",
  ].filter(Boolean);
  const shown = f.slice(0, 4).map((x) => `• ${x.line}`);
  if (f.length > 4) shown.push(`… and ${f.length - 4} more on the Lantern`);
  return { title: `🔦 Lantern: ${parts.join(" · ")}`, body: shown.join("\n"), pane: f.find((x) => x.pane)?.pane };
}

/* ── the clock ────────────────────────────────────────────────────────── */

let timer: ReturnType<typeof setTimeout> | null = null;
let namedBefore: NamedAgent[] | null = null;
let last: { at: number; findings: Finding[] } | null = null;
let ticking = false;

/** What the last look found, for the view's one line under its header. */
export function lastLook(): { at: number; flagged: number; every: number; on: boolean } | null {
  return last ? { at: last.at, flagged: last.findings.length, every: lanternWatchMinutes(), on: lanternWatch() } : { at: 0, flagged: 0, every: lanternWatchMinutes(), on: lanternWatch() };
}

export async function tick(now = Date.now()): Promise<Finding[]> {
  if (ticking) return last?.findings ?? [];
  ticking = true;
  try {
    const [rows, namedNow] = await Promise.all([
      boardNow().catch(() => [] as AgentBoard.BoardRow[]),
      namedAlive(now).catch(() => [] as NamedAgent[]),
    ]);
    const f = findings({ rows, namedNow, namedBefore, now });
    namedBefore = namedNow;
    last = { at: now, findings: f };
    const n = notice(f);
    if (n) pushLantern(n.title, n.body, n.pane);
    return f;
  } finally {
    ticking = false;
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!lanternWatch()) return;
  timer = setTimeout(() => { void tick().finally(schedule); }, lanternWatchMinutes() * 60_000);
  /* A timer must never be what keeps the server alive on shutdown. */
  (timer as { unref?: () => void }).unref?.();
}

/** Start the clock, or restart it after Settings changed the interval — the
 *  first look is one interval away, not now: the instant alerts already cover
 *  "now", and a notification the second the app opens is noise. */
export function startLanternWatch(): void { schedule(); }
export function restartLanternWatch(): void { schedule(); }
export function stopLanternWatch(): void { if (timer) clearTimeout(timer); timer = null; }

/** For tests: forget the previous look. */
export function __resetLanternWatch(): void { namedBefore = null; last = null; stopLanternWatch(); }
