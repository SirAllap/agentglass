/*
 * `Search this computer`: a Finder that replaces the window for the length of
 * one search.
 *
 * Its head, body and bottom bar are its own — the wizard is behind it and the
 * commit action sits in the same corner in every state. Nothing is written
 * until `Add N projects`, and `←` or `×` return to step 4 with the ticks kept.
 *
 * `ProjectFinder` owns the request and the ticks' neighbours; `FinderScreen`
 * is the markup of all six states, so each can be read without a server.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { SetupScan, SetupScanRow } from "../../../../shared/types.ts";
import { SETUP_SCAN_MS } from "../../../../shared/setupScan.ts";
import { ICON } from "../../lib/iconSize.ts";
import { api } from "../../lib/api.ts";
import { tildify } from "../../lib/projectsPaths.ts";
import { branchLabel } from "../../lib/setupRepos.ts";
import {
  addLabel, failureLine, filterRows, finderPhase, groupRows, relativeAge, selectAll, selectNone, skipLine,
  scopeLine, stoppedLine,
} from "../../lib/setupScan.ts";

export function ProjectFinder({ homedir, ticked, onTicked, onBack, onAdd }: {
  /** Where the search will look, for the states before an answer. */
  homedir: string;
  ticked: string[];
  onTicked: (roots: string[]) => void;
  onBack: () => void;
  /** The one write: the ticked roots, additive. A sentence means it failed. */
  onAdd: (roots: string[]) => Promise<string | null>;
}) {
  const [scan, setScan] = useState<SetupScan | null>(null);
  const [failure, setFailure] = useState("");
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const start = useCallback(async () => {
    setFailure("");
    setAddError("");
    setFilter("");
    try {
      const s = await api.setupScanStart();
      setScan(s);
      if (s.state === "failed") setFailure(s.error || "The server did not say why.");
    } catch (e) {
      setFailure(String(e));
    }
  }, []);

  const stop = useCallback(async () => {
    if (!scan) return;
    try {
      setScan(await api.setupScanStop(scan.id));
    } catch {
      setFailure("The search stopped answering.");
    }
  }, [scan]);

  // One poll at a time, and only while the server says it is still walking.
  useEffect(() => {
    if (!scan || scan.state !== "running") return;
    let live = true;
    const timer = setInterval(() => {
      void api.setupScan(scan.id)
        .then((s) => { if (live) setScan(s); })
        .catch(() => { if (live) setFailure("The search stopped answering."); });
    }, 350);
    return () => { live = false; clearInterval(timer); };
  }, [scan?.id, scan?.state]);

  // Focus the title first, so Tab starts at the head and nothing below is
  // read before the person knows where they are.
  useEffect(() => { rootRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onBack(); return; }
      const field = (e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable='true']");
      if (e.key === "/" && !field && filterRef.current) {
        e.preventDefault();
        filterRef.current.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);

  const add = async () => {
    if (!ticked.length || adding) return;
    setAdding(true);
    setAddError("");
    const why = await onAdd(ticked);
    setAdding(false);
    if (why) setAddError(why);
  };

  return (
    <div className="finder-shell" ref={rootRef} tabIndex={-1} role="region" aria-label="Find projects on this computer">
      <FinderScreen
        homedir={homedir}
        scan={scan}
        failure={failure}
        filter={filter}
        ticked={ticked}
        adding={adding}
        addError={addError}
        filterRef={filterRef}
        onFilter={setFilter}
        onTick={(root) => onTicked(ticked.includes(root) ? ticked.filter((r) => r !== root) : [...ticked, root])}
        onAll={() => onTicked(selectAll(ticked, scan?.repos ?? [], filter))}
        onNone={() => onTicked(selectNone(ticked, scan?.repos ?? [], filter))}
        onStart={() => void start()}
        onStop={() => void stop()}
        onBack={onBack}
        onAdd={() => void add()}
      />
    </div>
  );
}

/** All six states of §2, drawn from what the search answered. */
export function FinderScreen({ homedir, scan, failure, filter, ticked, adding, addError, filterRef, onFilter, onTick, onAll, onNone, onStart, onStop, onBack, onAdd }: {
  homedir: string;
  scan: SetupScan | null;
  /** A start or a poll that failed, when there is no scan to draw. */
  failure: string;
  filter: string;
  ticked: readonly string[];
  adding: boolean;
  addError: string;
  filterRef?: RefObject<HTMLInputElement>;
  onFilter: (v: string) => void;
  onTick: (root: string) => void;
  onAll: () => void;
  onNone: () => void;
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onAdd: () => void;
}) {
  const phase = finderPhase(scan, failure);
  const rows = scan?.repos ?? [];
  const shown = filterRows(rows, filter);
  const groups = groupRows(shown);
  const n = ticked.length;
  const left = scan ? Math.max(0, Math.ceil((SETUP_SCAN_MS - scan.elapsedMs) / 1000)) : 0;
  const progress = scan ? Math.min(100, Math.round((scan.elapsedMs / SETUP_SCAN_MS) * 100)) : 0;
  const results = phase === "done" || (phase === "stopped" && rows.length > 0);

  return (
    <>
      <header className="finder-head">
        <button type="button" className="finder-back" onClick={onBack}>
          <Chevron /> Repositories
        </button>
        <h1 className="finder-title">Find projects on this computer</h1>
        <span className="finder-badge"><Dot /> nothing is kept</span>
        <span className="finder-grow" />
        <button type="button" className="finder-icon" onClick={onBack} aria-label="Close the search">
          <Cross />
        </button>
      </header>

      <div className="finder-body">
        <div className="finder-inner">
          {phase === "empty" && (
            <>
              <p className="setup-lede">Every folder with a `.git` in it, listed once so you can pick several at a time.</p>
              <section className="finder-card">
                <h2 className="finder-h2">Where it will look</h2>
                <p className="finder-copy">{scopeLine(homedir, scan?.roots ?? (homedir ? [homedir] : []))}</p>
                <p className="finder-copy">{skipLine()}</p>
              </section>
            </>
          )}

          {phase === "scanning" && scan && (
            <>
              <section className="finder-card finder-scan" role="status" aria-live="polite">
                <div className="finder-scan-top">
                  <span className="finder-h2">Reading this computer</span>
                  <span className="finder-time">about {left}s left</span>
                </div>
                <div className="finder-bar" aria-hidden="true"><span style={{ width: `${Math.max(4, progress)}%` }} /></div>
                <p className="finder-count">
                  <b>{rows.length}</b> {rows.length === 1 ? "repository" : "repositories"} so far ·{" "}
                  <b>{scan.folders}</b> {scan.folders === 1 ? "folder" : "folders"} read
                </p>
                <p className="finder-where" title={scan.current}>{tildify(scan.current) || "…"}</p>
                <button type="button" className="setup-btn setup-btn-secondary finder-stop" onClick={onStop}>
                  <StopMark /> Stop
                </button>
              </section>
              <p className="finder-copy finder-quiet">{skipLine(scan.skips)}</p>
            </>
          )}

          {(phase === "stopped" || phase === "nothing" || phase === "failed") && scan && phase !== "failed" && (
            <section className="finder-card">
              <h2 className="finder-h2">
                {phase === "nothing" ? "No git repository turned up" : "That is as far as this search goes"}
              </h2>
              <p className="finder-copy">
                {phase === "nothing"
                  ? `${scopeLine(homedir, scan.roots)} ${skipLine(scan.skips)}`
                  : stoppedLine(scan)}
              </p>
              {phase === "nothing" && <p className="finder-copy">A project you keep somewhere else can be added with a folder path on the step before.</p>}
            </section>
          )}

          {phase === "failed" && (
            <section className="finder-card">
              <h2 className="finder-h2">The search did not run</h2>
              <p className="finder-copy">{failureLine(scan, failure)}</p>
              <p className="finder-copy finder-quiet">Nothing was kept, and no folder was changed.</p>
            </section>
          )}

          {results && (
            <>
              <div className="finder-filters">
                <span className="finder-searchbox">
                  <SearchMark />
                  <input
                    ref={filterRef}
                    className="finder-filter"
                    type="search"
                    value={filter}
                    onChange={(e) => onFilter(e.target.value)}
                    placeholder="Filter by name or path"
                    aria-label="Filter by name or path"
                    spellCheck={false}
                  />
                  <kbd className="finder-kbd">/</kbd>
                </span>
                <button type="button" className="setup-btn setup-btn-xs" onClick={onAll} disabled={!shown.length}>Select all</button>
                <button type="button" className="setup-btn setup-btn-xs" onClick={onNone} disabled={!shown.some((r) => ticked.includes(r.root))}>Select none</button>
              </div>

              {phase === "stopped" && rows.length > 0 && (
                <p className="finder-note" role="status">{stoppedLine(scan!)}</p>
              )}
              {!shown.length && rows.length > 0 && (
                <p className="finder-note" role="status">
                  Nothing matches “{filter}”.{" "}
                  <button type="button" className="setup-link" onClick={() => onFilter("")}>Clear the filter</button>
                </p>
              )}

              {groups.map((g) => {
                const picked = g.rows.filter((r) => ticked.includes(r.root)).length;
                return (
                  <section className="finder-group" key={g.parent} aria-label={tildify(g.parent)}>
                    <div className="finder-group-head">
                      <code className="finder-parent" title={g.parent}>{tildify(g.parent)}</code>
                      <span className="finder-group-n">{g.rows.length}</span>
                      {picked > 0 && <span className="finder-group-picked">· {picked} selected</span>}
                    </div>
                    <div className="finder-rows">
                      {g.rows.map((r) => (
                        <ScanRow key={r.root} row={r} on={ticked.includes(r.root)} onTick={onTick} />
                      ))}
                    </div>
                  </section>
                );
              })}
            </>
          )}

          {addError && <p className="finder-note" role="alert">{addError}</p>}
        </div>
      </div>

      <div className="finder-foot">
        <span className="finder-foot-left">
          {results ? `${n} selected` : phase === "scanning" ? "Nothing is added until the search ends" : "nothing is kept"}
        </span>
        <span className="finder-grow" />
        {(phase === "nothing" || phase === "failed" || (phase === "stopped" && rows.length === 0)) && (
          <button type="button" className="setup-btn setup-btn-secondary" onClick={onBack}>Pick a folder instead</button>
        )}
        {(results || phase === "scanning") && (
          <button type="button" className="setup-btn setup-btn-primary" onClick={onAdd} disabled={!n || adding || phase === "scanning"}>
            {n === 0 ? "Add projects" : addLabel(n)}
          </button>
        )}
        {(phase === "empty" || phase === "nothing" || phase === "failed" || (phase === "stopped" && rows.length === 0)) && (
          <button type="button" className="setup-btn setup-btn-primary" onClick={onStart}>
            {phase === "empty" ? "Start the search" : phase === "failed" ? "Try again" : "Search again"}
          </button>
        )}
      </div>
    </>
  );
}

function ScanRow({ row, on, onTick }: { row: SetupScanRow; on: boolean; onTick: (root: string) => void }) {
  const age = relativeAge(row.touchedAt);
  const cut = branchLabel(row.branch);
  return (
    <label className="finder-row" data-on={on ? "1" : "0"}>
      <input type="checkbox" className="setup-repobox" checked={on} onChange={() => onTick(row.root)}
        aria-label={`${row.name}, on ${row.branch}, last commit ${age}`} />
      <span className="finder-row-name" title={row.name}>{row.name}</span>
      <span className="finder-row-path" title={row.root}>{tildify(row.root)}</span>
      <span className="finder-row-branch" title={row.branch} aria-label={row.branch}><BranchMark /> {cut}</span>
      <span className="finder-row-age">{age}</span>
    </label>
  );
}

function Chevron() {
  return (
    <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3 5 8l5 5" />
    </svg>
  );
}

function Cross() {
  return (
    <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function SearchMark() {
  return (
    <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.4 3.4" />
    </svg>
  );
}

function BranchMark() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4.4" cy="3.4" r="1.7" /><circle cx="4.4" cy="12.6" r="1.7" /><circle cx="11.6" cy="5.6" r="1.7" />
      <path d="M4.4 5.1v5.8" /><path d="M9.9 5.6c0 2.6-2 3.2-4 3.6" />
    </svg>
  );
}

function Dot() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.4" /><path d="M8 7.2v3.2" /><path d="M8 4.9v.2" />
    </svg>
  );
}

function StopMark() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.4" />
    </svg>
  );
}
