/*
 * Clean up one pull request's local leftovers: the dry run, then the run.
 * Self-contained: it reads the plan from the server (GET /cleanup/plan) and
 * runs exactly that plan (POST /cleanup/run with its id), so the list you
 * ticked is the list that runs. A person's run goes without an approval card.
 * Every decision (ticks, blocks, labels, outcome, filters) is in lib/cleanupPr.ts.
 *
 * Wide: the summary pane on the left never scrolls, the list on the right does,
 * with a sticky toolbar and group headers. Nothing is clipped without a way to
 * read it: a long name is shortened in the middle (tail kept) with Copy and Show
 * all, a reason always wraps, a title past three lines has Show full title.
 *
 * Engine ceiling: POST /cleanup/run answers once, when the whole run has ended,
 * with a result per item. There is no progress inside a run, so running shows
 * the item count and one indeterminate sweep, never a percentage or a "12 of 30".
 * "Save as patch, then clean" and "Stop after this item" are not built.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { api } from "../lib/api.ts";
import { beginRun, endRun, showCleanupNote } from "../lib/cleanupEvents.ts";
import { ICON } from "../lib/iconSize.ts";
import { humanSize } from "../../../shared/dockerSize.ts";
import { CLEANUP_KIND_ROWS } from "../lib/cleanupSettings.ts";
import {
  BUILD_CACHE_WARNING, PAGE, blockViews, buildCacheLabel, noteOf, canConfirm, confirmLabel, defaultOff, excludeOf, failedFirst, groupOf, headline, groupsOf, groupTick, isBig, isLong, largestFirst, listed, matches, mergeReports,
  name, needsAttention, outcome, plural, rowState, setTicks, shareOf, sizeWord, splitTail, subLine, subOf, ticked, toggleGroup, toggleItem,
  type ItemResult, type Plan, type PlanItem, type Report, type RowFilter, type ViewGroup,
} from "../lib/cleanupPr.ts";
import { CaretIcon, CopyIcon, CrossIcon, DoneIcon, ExpandIcon, FileIcon, InfoIcon, LockIcon, MinusIcon, SearchIcon, SparkleIcon, WarningIcon, CircleIcon, RefreshIcon } from "../lib/glyphIcons.tsx";
import { KIND_ICON } from "./CleanupSettings.tsx";
import { Portal } from "./Portal.tsx";
import "./cleanupSettings.css";
import "./cleanupPr.css";

const ICON_OF = new Map(CLEANUP_KIND_ROWS.map((k) => [k.id as string, KIND_ICON[k.icon]]));
type Phase = "loading" | "plan" | "running" | "finished" | "error";

const sizeParts = (bytes: number): [string, string] => { const [n, u] = sizeWord(bytes).split(" "); return [n!, u ?? ""]; };

export function CleanupDialog({ repo, pr, onClose, onChanged }: {
  repo: string; pr: number; onClose: () => void;
  /** A run ended (fully or not): the caller reads the plan again to refresh its badge. */
  onChanged?: () => void;
}): ReactElement {
  const [phase, setPhase] = useState<Phase>("loading");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [off, setOff] = useState<string[]>([]);
  const [gate, setGate] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [shut, setShut] = useState<string[]>([]);
  const [wide, setWide] = useState<string[]>([]);
  const [pages, setPages] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [rowFilter, setRowFilter] = useState<RowFilter>("all");
  const [fullTitle, setFullTitle] = useState(false);
  const [clipped, setClipped] = useState(false);
  const [retrying, setRetrying] = useState<string[]>([]);
  const [copied, setCopied] = useState("");
  // The shared Docker build cache: not part of any plan, a quiet action of its own with its own confirm.
  const [cache, setCache] = useState<number | null>(null);
  const [cacheAsk, setCacheAsk] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheNote, setCacheNote] = useState("");
  const alive = useRef(true);
  const titleRef = useRef<HTMLElement>(null);
  const titleId = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = (): void => {
    setPhase("loading"); setError("");
    api.cleanupPlan(repo, pr)
      .then((r) => { if (!alive.current) return; if (r.ok && r.plan) { setPlan(r.plan); setOff(defaultOff(r.plan)); setGate(false); setReport(null); setPhase("plan"); } else { setError(r.error ?? "The plan could not be read."); setPhase("error"); } })
      .catch((e) => { if (alive.current) { setError(String((e as Error).message ?? e)); setPhase("error"); } });
  };
  useEffect(load, [repo, pr]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (phase !== "plan") return;
    api.cleanupBuildCache().then((r) => { if (alive.current) setCache(r.ok && r.reclaimableBytes ? r.reclaimableBytes : null); }).catch(() => { if (alive.current) setCache(null); });
  }, [phase === "plan"]); // eslint-disable-line react-hooks/exhaustive-deps
  const pruneCache = async (): Promise<void> => {
    setCacheBusy(true);
    try {
      const r = await api.cleanupBuildCachePrune();
      if (!alive.current) return;
      if (r.ok) { setCache(null); setCacheNote(`Build cache pruned \u00b7 ${sizeWord(r.freedBytes ?? 0)} freed${r.remainingBytes != null ? ` \u00b7 ${sizeWord(r.remainingBytes)} left` : ""}`); } else setCacheNote(r.error ?? "The build cache could not be pruned.");
    } catch (e) { if (alive.current) setCacheNote(String((e as Error).message ?? e)); }
    if (alive.current) { setCacheBusy(false); setCacheAsk(false); }
  };

  const groups = useMemo(() => (plan ? groupsOf(plan) : []), [plan]);
  const t = plan ? ticked(plan, off) : { items: [], count: 0, of: 0, bytes: 0 };
  const blocks = plan ? blockViews(plan) : [];

  /** The one place a plan is run. `exclude` is what the person unticked (or, for a retry, everything but the failed rows). */
  const exec = async (p: Plan, exclude: string[], retried?: string[]): Promise<void> => {
    // One run of a PR at a time: a second click, or the merge's own run, is refused instead of racing a plan that no longer describes the machine.
    if (!beginRun(repo, pr)) { setError("This PR is already being cleaned up. Wait for it to finish."); setPhase("error"); return; }
    setPhase("running");
    let ended: Report | undefined;
    try {
      const r = await api.cleanupRun(repo, pr, p.id, exclude, p.notMerged && gate);
      if (r.items) { ended = r as Report; if (alive.current) { setReport((prev) => (retried && prev ? mergeReports(prev, ended!, retried) : ended!)); setPhase("finished"); } }
      else if (alive.current) { setError(r.error ?? "The cleanup was refused."); setPhase("error"); }
    } catch (e) { if (alive.current) { setError(String((e as Error).message ?? e)); setPhase("error"); } }
    if (alive.current) setRetrying([]);
    if (!alive.current && ended && ended.failed === 0) showCleanupNote(noteOf(p, ended)); // closed with "Run in background": the toast is its only voice
    endRun(repo, pr, ended); // every view of this PR re-reads from the report's own `remaining`
    onChanged?.();
  };
  const run = async (): Promise<void> => {
    if (!plan || !canConfirm(plan, t, gate)) return;
    await exec(plan, excludeOf(plan, off));
  };
  /** Only the failed rows again, against a fresh plan (the first one's id no longer describes the machine). */
  const retry = async (ids: string[]): Promise<void> => {
    if (!plan || ids.length === 0) return;
    setRetrying(ids); setPhase("running");
    try {
      const r = await api.cleanupPlan(repo, pr);
      if (!alive.current) return;
      if (!r.ok || !r.plan) { setError(r.error ?? "The plan could not be read."); setPhase("error"); return; }
      await exec(r.plan, listed(r.plan).filter((i) => !ids.includes(i.id)).map((i) => i.id), ids);
    } catch (e) { if (alive.current) { setError(String((e as Error).message ?? e)); setPhase("error"); } }
  };

  const strong = !!plan?.notMerged;
  const ran = phase === "running" || phase === "finished";
  const out = plan && report ? outcome(plan, report) : null;
  const byId = new Map<string, ItemResult>((report?.items ?? []).map((i) => [i.id, i]));
  const blocked = phase === "plan" && blocks.length > 0;
  const empty = phase === "plan" && !!plan && !blocked && t.of === 0;
  const clean = phase === "finished" && out?.tone === "ok";
  const tone = phase === "finished" ? (out?.tone === "ok" ? "success" : "warning") : phase === "running" ? "primary" : blocked ? "warning" : strong || phase === "error" ? "error" : empty ? "success" : "merged";
  const shape = blocked ? "blocked" : empty ? "empty" : phase === "loading" || phase === "error" ? "narrow" : "wide";

  const titleText = phase === "finished" && out ? out.title
    : phase === "running" && plan ? `Cleaning ${name(plan)}...`
    : blocked && plan ? `Cannot clean up ${name(plan)} yet`
    : empty && plan ? `${name(plan)} is already clean`
    : plan && strong ? "Clean up a PR that was not merged"
    : plan ? headline(plan)
    : phase === "error" ? "Could not clean up" : "Reading the plan...";
  // The header never grows past three lines: past that the title is a clamp with a button, not a loss.
  useLayoutEffect(() => { const el = titleRef.current; if (el && !fullTitle) setClipped(el.scrollHeight > el.clientHeight + 1); }, [titleText, fullTitle, shape]);

  // A finish with nothing failed has no screen of its own: it closes into the toast. A failed one stays, with Retry.
  useEffect(() => {
    if (!clean || !plan || !report) return;
    showCleanupNote(noteOf(plan, report));
    onClose();
  }, [clean]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = t.bytes;
  const filtering = q.trim() !== "" || rowFilter !== "all";
  const keepRow = (i: PlanItem): boolean =>
    matches(i, q) && (rowFilter === "all" || (rowFilter === "ticked" ? !off.includes(i.id) : !!plan && needsAttention(plan, i, total)));
  const copy = (text: string): void => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(text); setTimeout(() => setCopied((c) => (c === text ? "" : c)), 1200); }).catch(() => {});
  };

  /* ---- the left pane ---- */
  const kindLegend = (
    <div className="agx-cln-leg">
      {CLEANUP_KIND_ROWS.map((k) => {
        const g = groups.find((x) => x.group === k.id);
        return (
          <div key={k.id} data-cl-kind={k.id} data-zero={g ? undefined : ""}>
            <b>{k.name}</b>
            <span>{g ? `${g.items.length > 1 ? plural(g.items.length, "item") : "1"}${g.bytes > 0 ? ` · ${humanSize(g.bytes)}` : " · local"}` : "0"}</span>
          </div>
        );
      })}
    </div>
  );
  const keep = (
    <div className="agx-cln-keep"><LockIcon size={ICON.md} /><div><b>Local only</b><span>Nothing on GitHub or any tracker is touched. The PR, the card and every remote branch stay as they are.</span></div></div>
  );
  const giant = plan ? t.items.find((i) => isBig(i.bytes ?? 0, total) && shareOf(i.bytes ?? 0, total) >= 50 && shareOf(i.bytes ?? 0, total) < 100) : undefined;
  const failedRows = report ? report.items.filter((i) => i.status === "failed" && groupOf(i.kind)) : [];
  const failedIds = failedRows.map((i) => i.id);
  const failedLeft = plan ? plan.items.filter((i) => failedIds.includes(i.id)).reduce((n, i) => n + Math.max(0, i.bytes ?? 0), 0) : 0;
  const [bigN, bigU] = sizeParts(phase === "finished" && report ? report.freedBytes : total);

  const summary = (
    <aside className="agx-cln-sum" aria-label="Summary">
      <div>
        <div className="agx-cln-cap">{phase === "finished" ? "Freed" : phase === "running" ? "Freeing" : strong ? "You will delete" : "You will free"}</div>
        <div className="agx-cln-big" data-done={phase === "finished" ? "" : undefined}>{bigN}<small>{bigU}</small></div>
        <div className="agx-cln-subtle">
          {phase === "plan" ? <>{t.count} ticked of {t.of}{q.trim() ? <> · filter &ldquo;{q.trim()}&rdquo;</> : null}</>
            : phase === "running" ? `${plural(retrying.length || t.count, "item")}, in the order listed`
            : report ? `of ${sizeWord(total)} ticked` : ""}
        </div>
      </div>
      {phase === "plan" && (
        <div className="agx-cln-bar" role="img" aria-label="Size by kind">
          {groups.map((g) => ({ g, b: g.items.filter((i) => !off.includes(i.id)).reduce((n, i) => n + Math.max(0, i.bytes ?? 0), 0) })).filter((x) => x.b > 0)
            .map(({ g, b }) => <i key={g.group} data-cl-kind={g.group} title={`${g.name} ${humanSize(b)}`} style={{ flex: Math.max(b, total * 0.015, 1) }} />)}
        </div>
      )}
      {phase === "running" && <div className="agx-cln-ind" role="progressbar" aria-label="Cleaning"><i /></div>}
      {phase === "finished" && report && (
        <>
          <div className="agx-cln-bar"><i style={{ flex: Math.max(1, report.items.filter((i) => i.status === "done" && groupOf(i.kind)).length), background: "var(--success)" }} />{failedIds.length > 0 && <i style={{ flex: failedIds.length, background: "var(--error)" }} />}</div>
          <div className="agx-cln-leg">
            <div style={{ ["--c" as string]: "var(--success)" }}><b>Removed</b><span>{report.items.filter((i) => i.status === "done" && groupOf(i.kind)).length}</span></div>
            {failedIds.length > 0 && <div style={{ ["--c" as string]: "var(--error)" }}><b>Failed</b><span>{failedIds.length}{failedLeft > 0 ? ` · ${sizeWord(failedLeft)} left` : ""}</span></div>}
          </div>
        </>
      )}
      {phase === "plan" && kindLegend}
      {phase === "plan" && q.trim() && (
        <div className="agx-cln-info"><InfoIcon size={ICON.md} /><div><b>The filter limits what All / None change</b><span>Unmatched items keep their tick.</span></div></div>
      )}
      {phase === "plan" && giant && (
        <div className="agx-cln-info" data-tone="warn" role="note"><WarningIcon size={ICON.md} /><div><b>One item is {shareOf(giant.bytes ?? 0, total)} % of this</b><span><span className="agx-cln-mono">{giant.target}</span> is {sizeWord(giant.bytes ?? 0)}. Untick it if you still need it.</span></div></div>
      )}
      {strong && phase === "plan" && (
        <div className="agx-cln-info" data-tone="error" role="alert"><WarningIcon size={ICON.md} /><div><b>This PR was closed without merging</b><span>The local branch may be the only copy of this work. Branches and stashes start unticked.</span></div></div>
      )}
      {phase === "finished" && out && out.patches > 0 && <div className="agx-cln-patch"><FileIcon size={ICON.sm} /><span>{plural(out.patches, "stash")} saved as patch files first.</span></div>}
      {keep}
    </aside>
  );

  /* ---- the list ---- */
  const renderRow = (i: PlanItem, k: string): ReactElement => {
    const r = byId.get(i.id);
    const kept = ran && off.includes(i.id);
    const st = retrying.includes(i.id) ? "running" : kept ? "skipped" : ran ? rowState(r, phase === "running" ? "running" : "finished") : null;
    // A whole run answers once, so no row can be "the current one": while it runs they all wait, and the sweep in the summary is the run.
    const shownSt = st === "running" && !retrying.length ? "waiting" : st;
    const full = wide.includes(i.id);
    const long = isLong(i.target);
    const [head, tail] = splitTail(i.target);
    const bytes = r?.bytes ?? i.bytes ?? 0;
    const big = !ran && isBig(i.bytes ?? 0, total);
    const sub = st === "done" ? `${subOf({ kind: i.kind, detail: "" })} · removed` : st === "skipped" ? `${subOf({ kind: i.kind, detail: "" })} · ${kept ? "kept" : (r?.detail || "already gone")}`
      : shownSt === "running" ? `${subOf({ kind: i.kind, detail: "" })} · trying again` : shownSt === "waiting" ? `${subOf({ kind: i.kind, detail: "" })} · queued` : subOf(i);
    const why = st === "failed" || st === "warn" ? r?.detail : "";
    return (
      <div key={i.id} className="agx-cln-it" data-off={!ran && off.includes(i.id) ? "" : undefined} data-st={shownSt ?? undefined} data-cl-kind={k}>
        <span className="agx-cln-lead">
          {shownSt ? <span className="agx-cln-stt" data-st={shownSt}>{STATE_ICON[shownSt]}</span>
            : <input type="checkbox" className="agx-cln-cb" data-red={strong ? "" : undefined} checked={!off.includes(i.id)} aria-label={i.target} onChange={() => setOff(toggleItem(off, i.id))} />}
        </span>
        <span className="agx-cln-ico agx-cln-ico-sm">{ICON_OF.get(k) && (() => { const Ic = ICON_OF.get(k)!; return <Ic size={ICON.xs} />; })()}</span>
        <div className="agx-cln-nm" data-full={full ? "" : undefined} title={i.target}>
          {long && !full
            ? <span className="agx-cln-me"><span className="agx-cln-a">{head}</span><span className="agx-cln-z">{tail}</span></span>
            : <span className="agx-cln-t">{i.target}</span>}
          {long && (
            <>
              <button type="button" className="agx-cln-ib" title={copied === i.target ? "Copied" : "Copy full name"} aria-label={`Copy ${i.target}`} onClick={() => copy(i.target)}>{copied === i.target ? <DoneIcon size={ICON.xs} /> : <CopyIcon size={ICON.xs} />}</button>
              <button type="button" className="agx-cln-ib" title={full ? "Collapse" : "Show all"} aria-label={full ? "Collapse the name" : "Show the whole name"} aria-expanded={full} onClick={() => setWide(full ? wide.filter((x) => x !== i.id) : [...wide, i.id])}><ExpandIcon size={ICON.xs} shrink={full} /></button>
            </>
          )}
        </div>
        <div className="agx-cln-sz" data-big={big ? "" : undefined}>
          {bytes > 0 ? humanSize(bytes) : "—"}
          {st === "failed" && <button type="button" className="agx-cln-btn sm" onClick={() => void retry([i.id])}><BtnIcon size={ICON.xs} />Retry</button>}
        </div>
        <div className="agx-cln-sub">
          {sub}
          {big && shareOf(i.bytes ?? 0, total) >= 50 && shareOf(i.bytes ?? 0, total) < 100 ? <> · <b>{shareOf(i.bytes ?? 0, total)} % of everything you will free</b></> : null}
        </div>
        {why ? <div className="agx-cln-why" data-bad={st === "failed" ? "" : undefined}><WarningIcon size={ICON.xs} /><span>{why}</span></div> : null}
      </div>
    );
  };

  const renderGroup = (g: ViewGroup): ReactElement => {
    const Ic = ICON_OF.get(g.group);
    const rows = (ran ? g.items : largestFirst(g.items.filter(keepRow)));
    const ordered = ran ? failedFirst(rows, byId) : rows;
    const all = ran ? g.items : largestFirst(g.items);
    const matched = ran ? g.items : all.filter(keepRow);
    const tick = groupTick(off, { items: matched });
    const folded = shut.includes(g.group);
    const upto = PAGE * (1 + (pages[g.group] ?? 0));
    const bytes = matched.reduce((n, i) => n + Math.max(0, i.bytes ?? 0), 0);
    const sizeText = bytes > 0 ? humanSize(bytes) : g.bytes > 0 ? "0 B" : "local only";
    const count = filtering && !ran ? `${matched.length} of ${g.items.length} match` : plural(g.items.length, "item");
    return (
      <div key={g.group} className="agx-cln-grp" data-cl-kind={g.group} data-dim={filtering && !ran && matched.length === 0 ? "" : undefined}>
        <div className="agx-cln-gh">
          {phase === "plan" && <input type="checkbox" className="agx-cln-cb" data-mix={tick === "some" ? "" : undefined} data-red={strong ? "" : undefined} checked={tick !== "none"} aria-label={g.name} disabled={matched.length === 0} onChange={() => setOff(toggleGroup(off, { items: matched }))} />}
          <span className="agx-cln-ico agx-cln-ico-sm">{Ic && <Ic size={ICON.xs} />}</span>
          <b>{g.name}</b>
          <span className="agx-cln-n">{count} · {sizeText}</span>
          {g.group === "stashes" && <span className="agx-cln-sv"><FileIcon size={ICON.xs} />saved as patch files first</span>}
          <span className="agx-cln-sp" />
          {phase === "plan" && matched.length > 0 && (
            <>
              <button type="button" className="agx-cln-lnk" onClick={() => setOff(setTicks(off, matched.map((i) => i.id), true))}>All</button>
              <button type="button" className="agx-cln-lnk" onClick={() => setOff(setTicks(off, matched.map((i) => i.id), false))}>None</button>
            </>
          )}
          <button type="button" className="agx-cln-ib" aria-expanded={!folded} aria-label={`${folded ? "Expand" : "Collapse"} ${g.name}`} onClick={() => setShut(folded ? shut.filter((x) => x !== g.group) : [...shut, g.group])}>
            <span className="agx-cln-car" data-shut={folded ? "" : undefined}><CaretIcon size={ICON.sm} /></span>
          </button>
        </div>
        {!folded && ordered.slice(0, upto).map((i) => renderRow(i, g.group))}
        {!folded && ordered.length > upto && (
          <div className="agx-cln-more">
            <span>Showing {upto} of {ordered.length} &middot; the rest is one click away, so a long list never means a slow window</span>
            <button type="button" className="agx-cln-btn sm" onClick={() => setPages({ ...pages, [g.group]: (pages[g.group] ?? 0) + 1 })}>Show next {Math.min(PAGE, ordered.length - upto)}</button>
          </div>
        )}
      </div>
    );
  };

  const shown = groups.reduce((n, g) => n + g.items.filter(keepRow).length, 0);
  const toolbar = phase === "plan" && (
    <div className="agx-cln-tb">
      <label className="agx-cln-srch"><SearchIcon size={ICON.sm} /><input type="search" value={q} placeholder="Filter by name, path or reason" aria-label="Filter the list" onChange={(e) => setQ(e.target.value)} /></label>
      {(["all", "ticked", "attention"] as const).map((f) => (
        <button key={f} type="button" className="agx-cln-chip" aria-pressed={rowFilter === f} onClick={() => setRowFilter(f)}>{f === "all" ? "All" : f === "ticked" ? "Ticked" : "Needs attention"}</button>
      ))}
      <span className="agx-cln-sp" />
      <span className="agx-cln-subtle" role="status">{filtering ? `${shown} of ${t.of} match` : `${t.count} of ${t.of} ticked`}</span>
      <button type="button" className="agx-cln-btn sm ghost" onClick={() => setShut(shut.length >= groups.length ? [] : groups.map((g) => g.group))}>{shut.length >= groups.length ? "Expand all" : "Collapse all"}</button>
    </div>
  );

  return (
    <Portal>
      <div className="fixed inset-0 agx-scrim" style={{ zIndex: 10004 }} onClick={() => onClose()} />
      <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10005 }}>
        <div className="agx-cln pointer-events-auto" role="dialog" aria-modal="true" aria-labelledby={titleId} data-phase={phase} data-shape={shape}>
          <div className="agx-cln-head" data-warn={strong && phase === "plan" ? "" : undefined}>
            <span className="agx-cln-tile" style={{ ["--c" as string]: `var(--${tone})` }}>
              {phase === "running" ? <RefreshIcon size={ICON.md} className="animate-spin" />
                : phase === "finished" ? (out?.tone === "ok" ? <DoneIcon size={ICON.md} /> : <WarningIcon size={ICON.md} />)
                : blocked ? <LockIcon size={ICON.md} /> : empty ? <DoneIcon size={ICON.md} />
                : strong || phase === "error" ? <WarningIcon size={ICON.md} /> : <SparkleIcon size={ICON.md} />}
            </span>
            <div className="agx-cln-ttl">
              <b id={titleId} ref={titleRef} data-clamp={fullTitle ? undefined : ""}>{titleText}</b>
              {(clipped || fullTitle) && <button type="button" className="agx-cln-more-t" aria-expanded={fullTitle} onClick={() => setFullTitle(!fullTitle)}>{fullTitle ? "Show less" : "Show full title"}</button>}
              <span>
                {phase === "finished" && out ? out.sub
                  : phase === "running" ? "The plan you read is running. Closing this window does not stop it."
                  : plan ? subLine(plan, Date.now()) : `#${pr}`}
              </span>
            </div>
            <button type="button" className="agx-cln-x" aria-label="Close" onClick={onClose}><CrossIcon size={ICON.md} /></button>
          </div>

          {phase === "loading" && (
            <>
              <div className="agx-cln-empty" role="status"><RefreshIcon size={ICON.sm} className="animate-spin" />Looking at what this PR left on your computer</div>
              <div className="agx-cln-skel" aria-hidden="true"><i style={{ width: "62%" }} /><i style={{ width: "88%" }} /><i style={{ width: "47%" }} /></div>
            </>
          )}
          {phase === "error" && <div className="agx-cln-empty" role="alert"><WarningIcon size={ICON.sm} />{error}</div>}

          {plan && blocked && (
            <div className="agx-cln-scroll agx-cln-cards">
              {blocks.map((b) => (
                <div key={b.kind} className="agx-cln-card" data-tone={b.tone} data-block={b.kind} role="alert">
                  <WarningIcon size={ICON.lg} />
                  <div>
                    <b>{b.title}</b>
                    <span>{b.why}</span>
                    {b.todo && <span>{b.todo}</span>}
                    {b.files.length > 0 && <span className="agx-cln-files">{b.files.slice(0, 5).join(" · ")}{b.files.length > 5 ? ` and ${b.files.length - 5} more` : ""}</span>}
                  </div>
                </div>
              ))}
              {keep}
            </div>
          )}

          {plan && empty && (
            <div className="agx-cln-fin">
              <span className="agx-cln-tile big" style={{ ["--c" as string]: "var(--success)" }}><SparkleIcon size={ICON.xl} /></span>
              <b>Nothing left on this machine</b>
              <p>No container, worktree, branch, stash, evidence or tab is left for this PR. If some kinds are switched off in Settings, they are not looked at.</p>
            </div>
          )}

          {plan && !blocked && !empty && !clean && phase !== "loading" && phase !== "error" && (
            <div className="agx-cln-body">
              {summary}
              <section className="agx-cln-list" aria-label="Leftovers">
                {toolbar}
                <div className="agx-cln-scroll">
                  {groups.map(renderGroup)}
                  {phase === "plan" && filtering && shown === 0 && <div className="agx-cln-none">Nothing matches this filter.</div>}
                </div>
              </section>
            </div>
          )}

          <div className="agx-cln-foot">
            {phase === "plan" && strong && !blocked && !empty && (
              <label className="agx-cln-gate">
                <input type="checkbox" className="agx-cln-cb" data-red="" checked={gate} onChange={(e) => setGate(e.target.checked)} />
                I understand the branch of a closed PR is deleted from this machine
              </label>
            )}
            <span className="agx-cln-fl">
              {phase === "plan" && plan && !blocked && !empty ? <><b>{sizeWord(t.bytes)}</b> <span>{"·"} {plural(t.count, "item")}{t.count !== t.of ? ` of ${t.of}` : ""}</span></>
                : phase === "running" ? "Removing..."
                : phase === "finished" && failedIds.length > 0 ? <><b>{failedIds.length} failed</b> <span>{failedLeft > 0 ? `· ${sizeWord(failedLeft)} still on disk` : ""}</span></> : ""}
            </span>
            {phase === "plan" && cacheNote && <span className="agx-cln-subtle" role="status">{cacheNote}</span>}
            {phase === "plan" && cache !== null && !cacheAsk && <button type="button" className="agx-cln-lnk" onClick={() => setCacheAsk(true)}>{buildCacheLabel(cache)}</button>}
            {phase === "plan" && cache !== null && cacheAsk && (
              <span className="agx-cln-bc" role="group" aria-label="Prune the build cache">
                <span className="agx-cln-subtle">{BUILD_CACHE_WARNING}</span>
                <button type="button" className="agx-cln-btn sm" disabled={cacheBusy} onClick={() => setCacheAsk(false)}>Keep it</button>
                <button type="button" className="agx-cln-btn sm" data-danger="" disabled={cacheBusy} aria-busy={cacheBusy} onClick={() => void pruneCache()}>{cacheBusy ? "Pruning..." : `Prune ${sizeWord(cache)}`}</button>
              </span>
            )}
            {phase === "plan" && !blocked && !empty && <button type="button" className="agx-cln-btn" onClick={onClose}>Cancel</button>}
            {phase === "plan" && plan && !blocked && !empty && (
              <button type="button" className="agx-cln-btn primary" data-danger={strong ? "" : undefined} disabled={!canConfirm(plan, t, gate)} onClick={() => void run()}>
                {strong ? <WarningIcon size={ICON.sm} /> : <SparkleIcon size={ICON.sm} />}{confirmLabel(plan, t)}
              </button>
            )}
            {(blocked || empty) && <button type="button" className={`agx-cln-btn${empty ? " primary" : ""}`} onClick={onClose}>Close</button>}
            {blocked && <button type="button" className="agx-cln-btn primary" disabled>Clean up</button>}
            {phase === "running" && <button type="button" className="agx-cln-btn" onClick={onClose}>Run in background</button>}
            {phase === "running" && <button type="button" className="agx-cln-btn" disabled title="The engine cannot stop a run once it has started">Stop after this item</button>}
            {phase === "finished" && failedIds.length > 0 && <button type="button" className="agx-cln-btn" onClick={onClose}>Close</button>}
            {phase === "finished" && failedIds.length > 0 && <button type="button" className="agx-cln-btn primary" onClick={() => void retry(failedIds)}><BtnIcon size={ICON.sm} />{failedIds.length > 1 ? "Retry all" : "Retry"}</button>}
            {phase === "error" && <><button type="button" className="agx-cln-btn" onClick={onClose}>Close</button><button type="button" className="agx-cln-btn primary" onClick={load}><BtnIcon size={ICON.sm} />Retry</button></>}
          </div>
        </div>
      </div>
    </Portal>
  );
}

const STATE_ICON: Record<string, ReactElement> = {
  running: <RefreshIcon size={ICON.sm} className="animate-spin" />,
  waiting: <CircleIcon size={ICON.sm} />,
  done: <DoneIcon size={ICON.sm} />,
  warn: <WarningIcon size={ICON.sm} />,
  failed: <WarningIcon size={ICON.sm} />,
  skipped: <MinusIcon size={ICON.sm} />,
};

/** The glyph inside a footer button (the refresh-icon guard allows a bare one inside a <button> only in Chrome.tsx). */
function BtnIcon({ size, spin }: { size: number; spin?: boolean }): ReactElement {
  return <RefreshIcon size={size} className={spin ? "animate-spin" : undefined} />;
}
