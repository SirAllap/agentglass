import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { subscribePluginFrame } from "../../lib/pluginBus.ts";
import { openSettings } from "../../lib/openSettings.ts";
import type { PublicPlugin } from "../../../../shared/types.ts";
import type { PrNote } from "../../lib/pluginTypes.ts";
import { Menu, MenuItem, RepoCtx } from "../PrPanel.tsx";
import { PluginMark } from "./PluginMark.tsx";
import type { LocalNotes, LocalRun } from "./LocalReview.tsx";
import { ICON } from "../../lib/iconSize.ts";

/**
 * What a plugin can do to the pull request you are reading, in its header.
 *
 * ONE BUTTON PER PLUGIN, and it says where that plugin's work has got to.
 *
 * The first version of this was a plain button that started something and
 * spun for twenty seconds. It was pressed, the panel said nothing, and the
 * only way to find out whether anything was happening was to leave the pull
 * request for the plugin's own panel and read a list of runs there — for a
 * review of the pull request already on screen. So the button is not a
 * trigger with a spinner: it is the state of this plugin's work on THIS pull
 * request, and pressing it does the thing that state calls for.
 *
 *   never run      "Local review"            starts one
 *   queued         "Queued"                  nothing; the caret cancels
 *   running        "Reviewing · 1:12"        nothing; the caret cancels
 *   finished       "Local review  2 HIGH"    shows the findings
 *   failed         "Local review failed"     starts another
 *
 * The state is read from the runs the plugin has already published on this
 * pull request, not from what was pressed here: a review started from the
 * plugin's own panel, or by a label on GitHub, has to light this button too,
 * and a window that was not open when it started has nothing to remember.
 *
 * Everything else the plugin declared hangs off the caret, with the app's own
 * "Settings…" under it — four buttons from one plugin would be a header
 * nobody can read.
 */

/** Runs older than this stop speaking for the button: a review from last week
 *  is history, not the state of this pull request. The Local lane still has
 *  it, and so does the plugin's list. */
const STALE_MS = 24 * 60 * 60_000;

let cache: { at: number; plugins: PublicPlugin[] } | null = null;

export function PluginPrActions({ number, local, onShowLocal }: {
  number: number;
  /** What plugins have written here — the runs are what the button reads. */
  local: LocalNotes;
  /** Take the person to the findings: the Conversation, filtered to Local. */
  onShowLocal: () => void;
}) {
  const repo = useContext(RepoCtx);
  const [plugins, setPlugins] = useState<PublicPlugin[]>(cache?.plugins ?? []);
  /** The press whose answer has not arrived — a NEW run appearing, or a
   *  refusal. Only ever a moment: the plugin posts a `queued` run as its
   *  first act. The time matters as much as the plugin: pressing Review again
   *  on a pull request that already has a finished run has to show that the
   *  press landed, and the old run is not the answer to it. */
  const [pending, setPending] = useState<{ plugin: string; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => api.plugins().then((r) => {
      cache = { at: Date.now(), plugins: r.plugins };
      if (live) setPlugins(r.plugins);
    }).catch(() => {});
    if (!cache || Date.now() - cache.at > 30_000) void load();
    // A plugin switched on or off, or reinstalled, changes what is on the row.
    const off = subscribePluginFrame((f) => { if (f.kind === "panels" && !f.panel) void load(); });
    return () => { live = false; off(); };
  }, []);

  useEffect(() => { setPending(null); setError(null); }, [repo, number]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const byPlugin = useMemo(() => {
    const now = Date.now();
    const m = new Map<string, { run?: LocalRun; notes: PrNote[] }>();
    for (const r of local.runs) {
      if (now - (r.finishedAt ?? r.startedAt) > STALE_MS) continue;
      const cur = m.get(r.plugin) ?? { notes: [] };
      // The latest run wins: a plugin reviewing the new commits on top of
      // yesterday's review is what the header is about.
      if (!cur.run || r.startedAt > cur.run.startedAt) cur.run = r;
      m.set(r.plugin, cur);
    }
    for (const n of local.notes) {
      if (n.status !== "open") continue;
      const cur = m.get(n.plugin);
      // Notes of the run on the row, so a fresh review's counts do not include
      // the findings of the one before it.
      if (cur?.run && (!n.runId || n.runId === cur.run.id)) cur.notes.push(n);
    }
    return m;
  }, [local.runs, local.notes]);

  /*
   * A pressed button stops being pending the moment the plugin says anything
   * about this pull request: the frame the server pushes when a run lands IS
   * the answer, and it arrives whether the run is new or the plugin moved the
   * one that was already there.
   *
   * The run's own `startedAt` cannot be the test on its own. A plugin that
   * publishes a queued run keeps its start time through running and done — so
   * a review of a pull request reviewed an hour ago answers with a run older
   * than the press, and the button sat on "Queued" until the timeout.
   */
  useEffect(() => {
    if (!pending) return;
    const off = subscribePluginFrame((f) => {
      if (f.kind === "pr" && f.repo === repo && f.number === number) setPending(null);
    });
    const run = byPlugin.get(pending.plugin)?.run;
    if (run && run.startedAt >= pending.at) setPending(null);
    return off;
  }, [byPlugin, pending, repo, number]);

  if (!repo) return null;
  const rows = plugins
    .filter((p) => p.enabled && p.running && (p.contributes?.prActions?.length ?? 0) > 0)
    .map((p) => ({ p, actions: p.contributes!.prActions! }));
  if (rows.length === 0) return null;

  const press = async (p: PublicPlugin, id: string) => {
    setPending({ plugin: p.name, at: Date.now() });
    setError(null);
    if (timer.current) clearTimeout(timer.current);
    // A plugin that says nothing at all is a plugin that did not take it. The
    // button goes back to what it was rather than spinning forever.
    timer.current = setTimeout(() => setPending(null), 20_000);
    const r = await api.pluginPrAction(p.name, id, repo, number).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { setPending(null); setError(r.error ?? "the plugin did not take that"); }
  };

  return (
    <>
      {rows.map(({ p, actions }) => (
        <PluginAction key={p.name} p={p} actions={actions}
          run={byPlugin.get(p.name)?.run} notes={byPlugin.get(p.name)?.notes ?? []}
          pending={pending?.plugin === p.name ? pending.at : 0} error={pending === null ? error : null}
          onPress={(id) => { void press(p, id); }} onShowLocal={onShowLocal} />
      ))}
    </>
  );
}

const SEV_TONE: Partial<Record<PrNote["severity"], string>> = {
  critical: "var(--error)", high: "var(--error)", medium: "var(--warning)",
};

function PluginAction({ p, actions, run, notes, pending, error, onPress, onShowLocal }: {
  p: PublicPlugin;
  actions: { id: string; label: string }[];
  run?: LocalRun;
  notes: PrNote[];
  /** When this plugin's button was pressed, and nothing has come back yet. */
  pending: number;
  error: string | null;
  onPress: (id: string) => void;
  onShowLocal: () => void;
}) {
  // A run from before the press does not answer it.
  const state = pending && (!run || run.startedAt < pending) ? "queued" : run?.state;
  const busy = state === "queued" || state === "running";
  // Ticking, because a review is minutes long and a frozen "1:12" reads as a
  // stuck one. Only while it runs: nothing else here changes by the second.
  const [, tick] = useState(0);
  useEffect(() => {
    if (state !== "running") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  const tint = p.color ?? "var(--primary)";
  const bad = state === "failed" || !!error;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) if (SEV_TONE[n.severity]) m.set(n.severity, (m.get(n.severity) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => (a[0] === "medium" ? 1 : 0) - (b[0] === "medium" ? 1 : 0));
  }, [notes]);
  const first = actions[0]!;
  const label =
    state === "queued" ? "Queued"
      : state === "running" ? `Reviewing · ${elapsed(run?.startedAt ?? Date.now())}`
        : state === "failed" ? `${first.label} failed`
          : first.label;
  // What a press means, which is the state's business and not the caret's.
  const press = () => {
    if (busy) return;
    if (state === "done" && notes.length) { onShowLocal(); return; }
    onPress(first.id);
  };

  return (
    <div className="shrink-0 flex items-stretch rounded" style={{
      border: `1px solid color-mix(in srgb, ${bad ? "var(--error)" : tint} 50%, transparent)`,
      background: `color-mix(in srgb, ${bad ? "var(--error)" : tint} ${busy || state === "done" ? 14 : 8}%, transparent)`,
    }}>
      <button type="button" onClick={press} disabled={busy}
        title={error ?? runTitle(p.name, run, notes.length)}
        aria-busy={busy || undefined}
        className="inline-flex items-center gap-1.5 whitespace-nowrap leading-none text-[10px] pl-1.5 pr-2 h-[24px] disabled:cursor-default hover:brightness-125"
        style={{ color: `color-mix(in srgb, ${bad ? "var(--error)" : tint} 80%, var(--text))`, background: "transparent", border: 0 }}>
        {state === "running"
          ? <Pulse color={tint} />
          : <PluginMark name={p.name} icon={p.icon} color={p.color} size={ICON.sm} stamp={p.contentHash} />}
        {label}
        {state === "done" && counts.map(([sev, n]) => (
          <span key={sev} className="rounded-sm px-1 py-px text-[9px] uppercase tracking-wide tabular-nums"
            style={{ color: SEV_TONE[sev as PrNote["severity"]], background: `color-mix(in srgb, ${SEV_TONE[sev as PrNote["severity"]]} 16%, transparent)` }}>
            {n} {sev === "medium" ? "med" : sev}
          </span>
        ))}
        {state === "done" && counts.length === 0 && (
          <span className="text-[9px] uppercase tracking-wide" style={{ color: "var(--success-ink)" }}>clean</span>
        )}
      </button>
      <Menu align="right" title={`More from ${p.name}`} label={<CaretIcon />} bare>
        {(close) => (
          <>
            {/* All of them, the one on the button included: which action the
                button runs depends on what the last run did, and a menu that
                hid "review it again" while a finished review was on the button
                would be a menu that moves. */}
            {actions.map((a) => (
              <MenuItem key={a.id} onClick={() => { close(); onPress(a.id); }}>{a.label}</MenuItem>
            ))}
            {run && <MenuItem onClick={() => { close(); onShowLocal(); }}>Show what it wrote</MenuItem>}
            <MenuItem onClick={() => { close(); openSettings(`plugin:${p.name}`); }}>Settings…</MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}

/** Not a Spinner: this one is the plugin's colour and the same size as the
 *  mark it replaces, so the button does not change width when a run starts. */
function Pulse({ color }: { color: string }) {
  return (
    <span aria-hidden className="rounded-full shrink-0 animate-spin"
      style={{ width: ICON.sm, height: ICON.sm, border: `2px solid ${color}`, borderTopColor: "transparent" }} />
  );
}

function CaretIcon() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function elapsed(from: number): string {
  const s = Math.max(0, Math.round((Date.now() - from) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function runTitle(plugin: string, run: LocalRun | undefined, open: number): string {
  if (!run) return `${plugin} has not looked at this pull request`;
  if (run.state === "failed") return run.summary || `${plugin} stopped: press to try again`;
  if (run.state === "done") return open ? `${open} open ${open === 1 ? "finding" : "findings"} from ${plugin} — press to read them` : `${plugin} found nothing`;
  return run.title;
}
