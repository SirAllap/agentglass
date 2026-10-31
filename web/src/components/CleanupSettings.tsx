import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { api } from "../lib/api.ts";
import { ICON } from "../lib/iconSize.ts";
import { SettingsCard } from "./SettingsKit.tsx";
import { INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";
import { SettingRow, Switch } from "./SettingRow.tsx";
import { Button } from "./workspace/Chrome.tsx";
import { BoxIcon, BranchIcon, CrossIcon, DoneIcon, FileIcon, FolderIcon, ImageFileIcon, MergeIcon, RefreshIcon, SearchIcon, SparkleIcon, StashIcon, TerminalIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { BellIcon, LayersIcon, ShieldIcon } from "./settingsNavIcons.tsx";
import {
  BRIEFS_HELP, CLEANUP_KIND_ROWS, DEFAULT_DAYS, MODE_BADGE, NO_EVIDENCE_ROOT, NO_OTHER_FOLDERS, OTHER_FOLDERS_HELP, addPattern, addRoot, briefsOf, checkBriefsDir, withBriefsDir, bulkLine, dropRoot, rootsOf, cleanupModes, daysOf, daysState, filterProjects, includeOf, isCustom, modeOf, nowLine, projectName, readPick,
  repoSlug, retryPlan, runPlan, saveLine, showList, showSearch, stillThere, tickState, toggleRoot, toggleShown, valuesOf, withKind, writePick, writePlan,
  type CleanupKind, type CleanupMode, type KindRow, type ModeCard, type ProjectValues, type RootResult, type RootWrite,
} from "../lib/cleanupSettings.ts";
import type { HeaderChip } from "../lib/settingsNav.ts";
import "./cleanupSettings.css";

type Draw = (p: { size?: number }) => ReactElement;
const MODE_ICON: Record<ModeCard["icon"], Draw> = { x: CrossIcon, bell: BellIcon, merge: MergeIcon, sparkles: SparkleIcon };
export const KIND_ICON: Record<KindRow["icon"], Draw> = { package: BoxIcon, folder: FolderIcon, branch: BranchIcon, archive: StashIcon, image: ImageFileIcon, file: FileIcon, term: TerminalIcon };

/** The days field and its switch, side by side in the row's control column (the mockup's row); a short number box, not a squeezed text field. */
function DaysField({ days, dis, onText, onCommit }: { days: { on: boolean; shown: string }; dis: boolean; onText(v: string): void; onCommit(): void }): ReactElement {
  return (
    <span className="agx-cl-age">
      <input className={`${INPUT} agx-cl-input`} style={INPUT_STYLE} inputMode="numeric" aria-label="Days" value={days.shown} disabled={!days.on || dis} onClick={(e) => e.stopPropagation()}
        onChange={(e) => onText(e.target.value)} onBlur={onCommit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }} />
      <span className="agx-cl-days">days</span>
      <Switch on={days.on} />
    </span>
  );
}

/** How a row went after an Apply: saved, waiting for the person's click, or refused (with the plan to run again). */
type Status = { phase: "saved" | "waits" } | { phase: "error"; reason: string; retry: RootWrite };

/**
 * "After a PR is merged": what happens to the local leftovers of a merged PR,
 * per project. One project is the page alone. Two or more put a project list
 * beside it: clicking a row edits just that project, and every control saves
 * as soon as it is touched through the settings door (`cleanup.mode`,
 * `cleanup.autoCleanDays`, `cleanup.include`), the same writes an agent's
 * `agentglass-ui settings` goes through. Ticking rows is separate from
 * clicking: while any are ticked the page is a draft that one Apply writes to
 * all of them (writePlan, runPlan, retryPlan). The decisions are in
 * lib/cleanupSettings.ts.
 */
export function CleanupSettings({ onChip }: { onChip?: (c: HeaderChip | null) => void }) {
  const [projects, setProjects] = useState<string[] | null>(null);
  const [slugs, setSlugs] = useState<Record<string, string>>({});
  const [held, setHeld] = useState<Record<string, ProjectValues | undefined>>({});
  const [pick, setPick] = useState("");
  const [ticked, setTicked] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Record<string, Status | undefined>>({});
  const [results, setResults] = useState<RootResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<CleanupMode>("ask");
  const [days, setDays] = useState(daysState(0));
  const [include, setInclude] = useState<CleanupKind[]>(() => includeOf(null));
  const [roots, setRoots] = useState<string[]>([]);
  const [rootText, setRootText] = useState("");
  const [rootWhy, setRootWhy] = useState("");
  const [briefs, setBriefs] = useState("");
  const [briefsText, setBriefsText] = useState("");
  const [briefsWhy, setBriefsWhy] = useState("");
  const [patterns, setPatterns] = useState<string[]>([]);
  const [patternText, setPatternText] = useState("");
  const [patternWhy, setPatternWhy] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [waits, setWaits] = useState(false);
  const alive = useRef(true);
  const head = useRef<HTMLInputElement>(null);
  useEffect(() => () => { alive.current = false; }, []);

  /** What each of these projects holds now, for the badges on the list. */
  const readHeld = useCallback((list: readonly string[]) => Promise.all(list.map((p) =>
    Promise.all([api.settingAt("cleanup.mode", p), api.settingAt("cleanup.autoCleanDays", p), api.settingAt("cleanup.include", p)])
      .then(([m, d, i]) => [p, valuesOf(m.value, d.value, i.value)] as const).catch(() => [p, undefined] as const),
  )).then((all) => { if (alive.current) setHeld((cur) => ({ ...cur, ...Object.fromEntries(all) })); }), []);

  useEffect(() => {
    void api.projects().then((r) => {
      if (!alive.current) return;
      const ws = r.workspaces ?? (r.workspace ? [r.workspace] : []);
      setProjects(ws);
      setPick(readPick(ws));
      if (showList(ws.length)) void readHeld(ws);
      // The list names a project owner/repo like the PR view does; a folder with no GitHub remote keeps its folder name.
      void Promise.all(ws.map((p) => api.gitRemotes(p).then((g) => [p, repoSlug(g.remotes)] as const).catch(() => [p, null] as const))).then((all) => {
        if (alive.current) setSlugs(Object.fromEntries(all.filter((e): e is [string, string] => e[1] !== null)));
      });
    }).catch(() => { if (alive.current) setProjects([]); });
  }, [readHeld]);

  const pool = projects ?? [];
  const list = showList(pool.length);
  const now = stillThere(ticked, pool);
  const drafting = now.length > 0;
  // The page shows the clicked project and writes as it is touched; with ticks it is a draft that Apply writes.
  const root = pick;

  useEffect(() => {
    if (!root || drafting) return;
    let live = true;
    void Promise.all([api.settingAt("cleanup.mode", root), api.settingAt("cleanup.autoCleanDays", root), api.settingAt("cleanup.include", root), api.settingAt("cleanup.evidenceRoots", root), api.settingAt("cleanup.config", root), api.settingAt("cleanup.otherFolders", root)])
      .then(([m, d, i, e, cfg, o]) => {
        if (!live) return;
        setMode(modeOf(m.value)); setDays(daysState(d.value)); setInclude(includeOf(i.value)); setRoots(rootsOf(e.value)); setRootText(""); setRootWhy("");
        setBriefs(briefsOf(cfg.value)); setBriefsText(briefsOf(cfg.value)); setBriefsWhy(""); setPatterns(rootsOf(o.value)); setPatternText(""); setPatternWhy(""); setProblem(null); setWaits(false);
      }).catch(() => { if (live) setProblem("Could not read this project's settings."); });
    return () => { live = false; };
  }, [root, drafting]);

  const flash = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flash.current) clearTimeout(flash.current); onChip?.(null); }, [onChip]);
  const saved = useCallback(() => {
    onChip?.({ tone: "ok", text: "Saved" });
    if (flash.current) clearTimeout(flash.current);
    flash.current = setTimeout(() => onChip?.(null), 2500);
  }, [onChip]);
  const write = useCallback(async (id: string, value: unknown) => {
    const line = saveLine(await api.settingAtSet(id, value, root).catch(() => null));
    if (!alive.current) return line.phase !== "error";
    setProblem(line.phase === "error" ? line.text : null);
    setWaits(line.phase === "waits");
    if (line.phase === "saved") { saved(); if (list) void readHeld([root]); }
    return line.phase !== "error";
  }, [root, saved, list, readHeld]);

  const pickMode = async (m: CleanupMode) => {
    const was = mode; setMode(m);
    if (drafting) return;
    if (!(await write("cleanup.mode", m))) setMode(was);
  };
  const flipDays = async (on: boolean) => {
    const was = days;
    const n = daysOf(days.shown) ?? DEFAULT_DAYS;
    setDays({ on, shown: String(n) });
    if (drafting) return;
    if (!(await write("cleanup.autoCleanDays", on ? n : 0))) setDays(was);
  };
  const commitDays = async () => {
    const n = daysOf(days.shown);
    if (!days.on) return;
    if (n === null) { setProblem("Days: a whole number from 1 to 365."); return; }
    setProblem(null);
    if (!drafting) await write("cleanup.autoCleanDays", n);
  };
  const tick = async (k: CleanupKind, on: boolean) => {
    const was = include, next = withKind(include, k, on);
    setInclude(next);
    if (drafting) return;
    if (!(await write("cleanup.include", next))) setInclude(was);
  };

  /** The evidence folders are one project's own paths, so they are saved as they are changed and never part of a bulk draft. */
  const saveRoots = async (next: string[]) => {
    const was = roots;
    setRoots(next);
    if (!(await write("cleanup.evidenceRoots", next))) setRoots(was);
  };
  const addFolder = async () => {
    const r = addRoot(roots, rootText);
    if (!r.ok) { setRootWhy(r.why); return; }
    setRootWhy(""); setRootText("");
    await saveRoots(r.list);
  };

  /** The briefs folder lives inside the project's `cleanup.config` object, which the door replaces whole: read it fresh, change one field, write it back. */
  const saveBriefs = async () => {
    const r = checkBriefsDir(briefsText);
    if (!r.ok) { setBriefsWhy(r.why); return; }
    setBriefsWhy("");
    const cur = await api.settingAt("cleanup.config", root).catch(() => null);
    if (!cur?.ok) { setBriefsWhy("Could not read this project's cleanup settings."); return; }
    if (await write("cleanup.config", withBriefsDir(cur.value, r.dir))) { setBriefs(r.dir); setBriefsText(r.dir); }
  };
  const savePatterns = async (next: string[]) => {
    const was = patterns;
    setPatterns(next);
    if (!(await write("cleanup.otherFolders", next))) setPatterns(was);
  };
  const addOtherFolder = async () => {
    const r = addPattern(patterns, patternText);
    if (!r.ok) { setPatternWhy(r.why); return; }
    setPatternWhy(""); setPatternText("");
    await savePatterns(r.list);
  };

  /** The first tick starts the draft from what the page shows; clearing the last tick hands the page back to the clicked project. */
  const setTicks = (next: string[]) => {
    setResults(null);
    setTicked(next);
  };
  const click = (r: string) => { setPick(r); writePick(r); };

  /** Runs a plan; the refused rows keep the plan that failed, so Retry runs exactly it. */
  const run = async (plan: RootWrite[]): Promise<RootResult[]> => {
    const waiting = new Set<string>();
    const res = await runPlan(plan, async (r, id, v) => {
      const out = await api.settingAtSet(id, v, r).catch(() => null);
      if (out?.ok && out.applied === false) waiting.add(r);
      return out;
    });
    if (!alive.current) return res;
    setStatus((cur) => ({
      ...cur,
      ...Object.fromEntries(res.map((r): [string, Status] => [r.root, r.ok ? { phase: waiting.has(r.root) ? "waits" : "saved" } : { phase: "error", reason: r.reason ?? "The server refused the change.", retry: plan.find((p) => p.root === r.root)! }])),
    }));
    // A row's own Retry reaches the bar's count too, so the bar never says "1 failed" about a row that has since gone in.
    setResults((cur) => (cur ? cur.map((c) => res.find((r) => r.root === c.root) ?? c) : cur));
    if (res.some((r) => r.ok && !waiting.has(r.root))) saved();
    void readHeld(plan.map((p) => p.root));
    return res;
  };
  const draftDays = days.on ? daysOf(days.shown) : 0;
  const apply = async () => {
    if (draftDays === null || !now.length) return;
    setBusy(true);
    const res = await run(writePlan(now, { mode, days: draftDays, include }));
    if (!alive.current) return;
    setBusy(false);
    setResults(res);
  };
  const failedPlans = now.flatMap((r) => { const s = status[r]; return s?.phase === "error" ? [s.retry] : []; });
  const retryRow = (r: string) => { const s = status[r]; if (s?.phase === "error") void run([s.retry]); };
  const retryAll = async () => {
    setBusy(true);
    await run(failedPlans);
    if (alive.current) setBusy(false);
  };
  const line = results ? bulkLine(results) : null;

  const modes = cleanupModes();
  const nameOf = (p: string): string => slugs[p] ?? projectName(p);
  const rows = filterProjects(pool, q, nameOf);
  const state = tickState(now, rows);
  useEffect(() => { if (head.current) head.current.indeterminate = state === "some"; }, [state, list]);
  const none = projects !== null && !projects.length;
  const dis = !root;
  const nowText = waits ? "Waiting for your approval before this applies." : nowLine(mode);
  const forWho = drafting ? `Draft for ${now.length} project${now.length === 1 ? "" : "s"}` : nameOf(root);

  const page = (
    <>
      <SettingsCard wide title="After a PR is merged" icon={<SparkleIcon size={ICON.md} />} desc="What happens to its local leftovers: Docker, worktree, branch, notes and tab. Only on this computer."
        status={list && root ? <span className="agx-cl-for" data-draft={drafting ? "" : undefined} title={drafting ? undefined : root}>{forWho}</span> : undefined}>
        {none ? <p className="agx-cl-empty">No project is open yet. Open one and its choice shows here.</p> : (
          <div className="agx-cl-body">
            <div className="agx-cl-modes" role="radiogroup" aria-label="After a PR is merged">
              {modes.map((m) => {
                const Ic = MODE_ICON[m.icon];
                return (
                  <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} data-on={mode === m.id ? "" : undefined} disabled={dis}
                    className="agx-cl-mode" onClick={() => void pickMode(m.id)}>
                    <span className="agx-cl-top">
                      <span className="agx-cl-tile"><Ic size={ICON.sm} /></span>
                      <b>{m.title}</b>
                      {m.isDefault && <span className="agx-cl-def">Default</span>}
                      <span className="agx-cl-rad" aria-hidden />
                    </span>
                    <span className="agx-cl-p">{m.text}</span>
                  </button>
                );
              })}
            </div>
            <div className="agx-cl-now" aria-live="polite"><em>NOW</em><span>{nowText}</span></div>
            {problem && <div role="alert" className="agx-cl-problem"><WarningIcon size={ICON.sm} />{problem}</div>}
            <SettingRow
              agentExempt label="Also clean up merged PRs older than"
              hint="Old merged PRs are cleaned on their own, with the same safety blocks. Off by default."
              onClick={dis ? undefined : () => void flipDays(!days.on)} role="switch" ariaChecked={days.on}
              control={<DaysField days={days} dis={dis} onText={(shown) => setDays({ on: days.on, shown })} onCommit={() => void commitDays()} />} />
          </div>
        )}
      </SettingsCard>
      <SettingsCard wide title="What to include" icon={<LayersIcon size={ICON.md} />} desc="Untick a kind and it is never touched, in any mode.">
        <div className="agx-cl-body">
          <div className="agx-cl-incl">
            {CLEANUP_KIND_ROWS.map((k) => {
              const Ic = KIND_ICON[k.icon];
              return (
                <label key={k.id} className="agx-cl-irow" data-cl-kind={k.id}>
                  <span className="agx-cl-tile"><Ic size={ICON.md} /></span>
                  <span className="agx-cl-tx"><b>{k.name}</b><span>{k.text}</span></span>
                  <input type="checkbox" checked={include.includes(k.id)} disabled={dis} aria-label={`Include ${k.name}`} onChange={(e) => void tick(k.id, e.target.checked)} />
                </label>
              );
            })}
          </div>
          {!drafting && include.includes("evidence") && (
            <div className="agx-cl-ev" data-cl-kind="evidence" aria-label="Evidence folders">
              <b>Evidence folders</b>
              <span className="agx-cl-mute">A folder inside one of these whose name starts with the card id (or the branch) is removed with the PR. The folders themselves are never removed.</span>
              {roots.length === 0 && <span className="agx-cl-mute" data-empty="">{NO_EVIDENCE_ROOT}</span>}
              {roots.map((p) => (
                <span key={p} className="agx-cl-evrow"><code title={p}>{p}</code>
                  <Button size="compact" disabled={dis} onClick={() => void saveRoots(dropRoot(roots, p))} aria-label={`Remove ${p}`}><CrossIcon size={ICON.sm} />Remove</Button>
                </span>
              ))}
              <span className="agx-cl-evadd">
                <input className={`${INPUT} agx-cl-evin`} style={INPUT_STYLE} value={rootText} disabled={dis} placeholder="~/Documents/projects/orbit" aria-label="Add an evidence folder"
                  onChange={(e) => { setRootText(e.target.value); setRootWhy(""); }} onKeyDown={(e) => { if (e.key === "Enter") void addFolder(); }} />
                <Button size="compact" tone="primary" disabled={dis || !rootText.trim()} onClick={() => void addFolder()}>Add folder</Button>
              </span>
              {rootWhy && <span role="alert" className="agx-cl-problem"><WarningIcon size={ICON.sm} />{rootWhy}</span>}
            </div>
          )}
          {!drafting && include.includes("notes") && (
            <div className="agx-cl-ev" data-cl-kind="briefs" aria-label="Briefs folder">
              <b>Briefs folder</b>
              <span className="agx-cl-mute">{BRIEFS_HELP}</span>
              <span className="agx-cl-evadd">
                <input className={`${INPUT} agx-cl-evin`} style={INPUT_STYLE} value={briefsText} disabled={dis} placeholder="~/orbit-notes/briefs" aria-label="Briefs folder"
                  onChange={(e) => { setBriefsText(e.target.value); setBriefsWhy(""); }} onKeyDown={(e) => { if (e.key === "Enter") void saveBriefs(); }} />
                <Button size="compact" tone="primary" disabled={dis || briefsText.trim() === briefs} onClick={() => void saveBriefs()}>{briefsText.trim() ? "Save folder" : "Turn off"}</Button>
              </span>
              {briefsWhy && <span role="alert" className="agx-cl-problem"><WarningIcon size={ICON.sm} />{briefsWhy}</span>}
            </div>
          )}
          {!drafting && include.includes("worktree") && (
            <div className="agx-cl-ev" data-cl-kind="other-folders" aria-label="Other folders">
              <b>Other folders</b>
              <span className="agx-cl-mute">{OTHER_FOLDERS_HELP}</span>
              {patterns.length === 0 && <span className="agx-cl-mute" data-empty="">{NO_OTHER_FOLDERS}</span>}
              {patterns.map((p) => (
                <span key={p} className="agx-cl-evrow"><code title={p}>{p}</code>
                  <Button size="compact" disabled={dis} onClick={() => void savePatterns(patterns.filter((x) => x !== p))} aria-label={`Remove ${p}`}><CrossIcon size={ICON.sm} />Remove</Button>
                </span>
              ))}
              <span className="agx-cl-evadd">
                <input className={`${INPUT} agx-cl-evin`} style={INPUT_STYLE} value={patternText} disabled={dis} placeholder="~/code/orbit-pol-master-{number}*" aria-label="Add an other-folder pattern"
                  onChange={(e) => { setPatternText(e.target.value); setPatternWhy(""); }} onKeyDown={(e) => { if (e.key === "Enter") void addOtherFolder(); }} />
                <Button size="compact" tone="primary" disabled={dis || !patternText.trim()} onClick={() => void addOtherFolder()}>Add pattern</Button>
              </span>
              {patternWhy && <span role="alert" className="agx-cl-problem"><WarningIcon size={ICON.sm} />{patternWhy}</span>}
            </div>
          )}
          <div className="agx-cl-safety">
            <ShieldIcon size={ICON.md} />
            <div><b>Safety blocks always apply.</b> In every mode, a PR is left alone when its worktree has uncommitted changes, when its branch has commits that are not in the merged PR, when an open PR is stacked on it, or when a live session is working in it. The block is shown on the PR, with the reason.</div>
          </div>
        </div>
      </SettingsCard>
    </>
  );
  if (!list) return page;

  return (
    <div className="agx-cl-md">
      <aside className="agx-cl-list" aria-label="Projects">
        <div className="agx-cl-lhead">
          <input ref={head} type="checkbox" checked={state === "all"} aria-label="Tick all projects shown" disabled={!rows.length}
            onChange={() => setTicks(toggleShown(now, rows))} />
          <b>Projects</b><span className="agx-cl-mute">{pool.length}</span>
        </div>
        {showSearch(pool.length) && (
          <span className="agx-cl-psrch">
            <SearchIcon size={ICON.sm} />
            <input type="search" className={`${INPUT} agx-cl-sin`} style={INPUT_STYLE} placeholder="Find a project" aria-label="Find a project" value={q} onChange={(e) => setQ(e.target.value)} />
          </span>
        )}
        <div className="agx-cl-rows">
          {rows.map((r) => {
            const v = held[r], s = status[r], on = now.includes(r), name = nameOf(r);
            return (
              <div key={r} className="agx-cl-lrow" data-active={r === root ? "" : undefined} data-on={on ? "" : undefined} data-bad={s?.phase === "error" ? "" : undefined} data-cl-row={r}>
                <input type="checkbox" checked={on} aria-label={`Tick ${name}`} onChange={() => setTicks(toggleRoot(now, r))} />
                <button type="button" className="agx-cl-lname" aria-current={r === root ? "true" : undefined} title={r} onClick={() => click(r)}>
                  <span className="agx-cl-pn">{name}</span>
                  {v && isCustom(v) && <span className="agx-cl-dot" title="Custom: the days or the kinds to include differ from the defaults" aria-label="custom" />}
                  {v && <span className="agx-cl-badge" data-mode={v.mode}>{MODE_BADGE[v.mode]}</span>}
                </button>
                {s?.phase === "saved" && <span className="agx-cl-ok" role="status" title="Saved"><DoneIcon size={ICON.sm} /></span>}
                {s?.phase === "waits" && <span className="agx-cl-wait" role="status" title="Waiting for your approval">…</span>}
                {s?.phase === "error" && (
                  <span className="agx-cl-fail" role="status" title={s.reason}>
                    <WarningIcon size={ICON.sm} />Not saved
                    <Button size="compact" tone="danger" disabled={busy} onClick={() => retryRow(r)}>Retry</Button>
                  </span>
                )}
              </div>
            );
          })}
          {!rows.length && <div className="agx-cl-pnone">No project matches "{q}"</div>}
        </div>
      </aside>
      <div className="agx-cl-detail">
        {drafting && (
          <div className="agx-cl-bulk" role="region" aria-label="Set the ticked projects together">
            <b>{now.length} ticked</b>
            <span className="agx-cl-mute">Apply the values below to {now.length}</span>
            <span className="agx-cl-bacts">
              {line && (
                <span className="agx-cl-bres" role="status">
                  <span data-tone="ok">{line.text}</span>
                  {line.failed > 0 && <><span data-tone="bad">{line.failed} failed</span><Button tone="primary" disabled={busy || !failedPlans.length} onClick={() => void retryAll()}><RefreshIcon size={ICON.sm} />Retry {line.failed}</Button></>}
                </span>
              )}
              <Button onClick={() => setTicks([])}>Clear ticks</Button>
              <Button tone="primary" disabled={busy || draftDays === null} onClick={() => void apply()}>Apply to {now.length}</Button>
            </span>
          </div>
        )}
        {page}
      </div>
    </div>
  );
}
