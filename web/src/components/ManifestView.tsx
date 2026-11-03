/*
 * THE MANIFEST.
 *
 * What got merged, what is running, what landed after the build that is running,
 * and what waits for a verdict — read from this machine's own trunk and agents.
 * The approved mockup (outside this repository) is the shape; the plan and the
 * lead's decisions are the behaviour. Every state's copy is written here, so a
 * screen can be judged without the mockup beside it.
 *
 * `ManifestScreen` is pure and exported: the tests draw every state from a
 * fixture, with no server and no effects. `ManifestView` is the wiring.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import "./manifestView.css";
import { ICON, HIT, TOUCH } from "../lib/iconSize.ts";
import { api } from "../lib/api.ts";
import {
  ageWords, ALL_PROJECTS, clock, dayWords, fixesLanded, leftLine, projectView, readProject, readScope,
  rememberScope, showsFilter, signoffLine, signOff, startLineWords, startProject, startedLine, stripBars,
  subscribeSummary, summarySnapshot, verdictLine, type ManifestProjectView, type ManifestRowRef,
} from "../lib/manifest.ts";
import { MANIFEST_NOTE_MAX, type ManifestProject, type ManifestSummaryProject } from "../../../shared/manifest.ts";
import { ManifestIcon } from "./workspace/icons.tsx";
import { RefreshButton } from "./workspace/Chrome.tsx";

/** The whole view's data, drawn or wired. */
export interface ManifestScreenProps {
  /** The filter's scope merged into one answer, or null before the first. */
  project: ManifestProjectView | null;
  /** The project's name before the first answer, so the header can name it. */
  name: string;
  summary: ManifestSummaryProject[] | null;
  /** `ALL_PROJECTS`, or the root of the one project the filter shows. */
  scope: string;
  /** Last successful answer, ms. */
  readAt: number | null;
  now: number;
  loading: boolean;
  /** The sentence the failed read answered with, or "" when the read did not answer. */
  error: string | null;
  /** The last refetch failed while rows from an earlier answer are on screen. */
  failedRefetch: boolean;
  /** `sha:verdict` while a write is in flight. */
  busy: string | null;
  /** The start line's one-line confirmation is open. */
  startAsk: boolean;
  /** Moving the start line is in flight. */
  startBusy: boolean;
  /** The sentence a refused move answered with. */
  startError: string | null;
  rowErrors: Record<string, string>;
  notes: Record<string, string>;
  openRow: string | null;
  toTestLimit: number;
  doneOpen: boolean;
  readyOpen: boolean;
  onRefresh: () => void;
  onProject: () => void;
  onScope: (scope: string) => void;
  onSign: (row: ManifestRowRef, verdict: "tested" | "failed") => void;
  onUndo: (row: ManifestRowRef) => void;
  onRetry: (row: ManifestRowRef) => void;
  onOpenRow: (sha: string | null) => void;
  onNote: (sha: string, text: string) => void;
  onSaveNote: (row: ManifestRowRef) => void;
  onShowOlder: () => void;
  onDoneToggle: () => void;
  onReadyToggle: () => void;
  onShowIt: (row: { paneId?: string; name: string }) => void;
  onStartAsk: () => void;
  onStartCancel: () => void;
  onStartConfirm: () => void;
}

const Check = ({ size = ICON.sm }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12.5l5 5L20 6.5" />
  </svg>
);
const Cross = ({ size = ICON.sm }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const Tray = ({ size = ICON.sm }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7h9l3 3h4v9H4z" /><path d="M4 11h16" />
  </svg>
);
const Chevron = ({ size = ICON.sm }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
    <path d="M6 9l6 6 6-6" />
  </svg>
);
const Clock = ({ size = ICON.xs }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
    <circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" />
  </svg>
);
const Live = ({ size = ICON.sm }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round">
    <path d="M3 12h4l2.5-6 4 12 2.5-6h5" />
  </svg>
);
const Install = ({ size = ICON.sm }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v10" /><path d="M8 10.5L12 15l4-4.5" /><path d="M5 20h14" />
  </svg>
);
const DoneBox = ({ size = ICON.sm }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 7v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7" /><path d="M4 7h16M9 7V4.5h6V7" /><path d="M10 11.5v4M14 11.5v4" />
  </svg>
);
const Folder = ({ size = ICON.sm }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

/** The words a caller may sign in, when it may not. */
function refusalLine(signOff: "yes" | "grant" | "off"): string | null {
  if (signOff === "yes") return null;
  return signOff === "grant"
    ? "Signing off needs the answer grant; this device can read the list."
    : "Sign-off is off in this window. Open it in the app, or from a paired phone.";
}

/** One group's card: header row, then rows. Clips because `.agx-card` does not. */
function Group({ className = "", icon, title, count, say, extra, children }: {
  className?: string; icon: ReactNode; title: string; count?: number | null; say: string;
  extra?: ReactNode; children: ReactNode;
}) {
  return (
    <section className={`agx-card mv-grp ${className}`}>
      <div className="mv-gh">
        <span className="mv-gpic">{icon}</span>
        <h2>{title}</h2>
        {count === null ? null : <span className="mv-cnt">{count}</span>}
        <span className="mv-say">{say}</span>
        {extra ? <span className="mv-gsp" /> : null}
        {extra}
      </div>
      {children}
    </section>
  );
}

function Skeleton() {
  return (
    <div className="mv-grp agx-card mv-skel-card" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div className="mv-skel" key={i}>
          <span className="mv-skel-t" />
          <span className="mv-skel-col">
            <span className="mv-skel-b" style={{ width: i === 0 ? "46%" : i === 1 ? "38%" : "52%", height: 12 }} />
            <span className="mv-skel-b" style={{ width: i === 0 ? "78%" : i === 1 ? "64%" : "70%" }} />
            <span className="mv-skel-b" style={{ width: "30%", height: 9 }} />
          </span>
          <span className="mv-skel-right" />
        </div>
      ))}
    </div>
  );
}

/** The tile's ink and tint: the verdict when there is one, quiet otherwise. */
function Tile({ signed, state }: { signed: "tested" | "failed" | null; state?: "live" | "ready" }) {
  const kind = signed ?? state ?? null;
  return (
    <span className={`mv-tile ${kind ?? ""}`}>
      {signed === "tested" ? <Check /> : signed === "failed" ? <Cross /> : state === "live" ? <Live /> : state === "ready" ? <Install /> : <Tray />}
    </span>
  );
}

function RowBody({ row, note, onNote, onSaveNote, limitOver, signable }: {
  row: ManifestRowRef; note: string; onNote: (t: string) => void; onSaveNote: () => void;
  limitOver: boolean; signable: boolean;
}) {
  if (row.verdict) {
    return (
      <div className="mv-rbody">
        <div className="mv-signoff">
          <span className={`mv-tile-s ${row.verdict}`}>{row.verdict === "tested" ? <Check size={ICON.xs} /> : <Cross size={ICON.xs} />}</span>
          <span>
            <b>{row.verdict === "tested" ? "Tested" : "Failed"}</b>
            {row.at == null ? "" : ` by you · ${clock(row.at)}`}
            {row.kind === "phone" ? " · from the phone" : " · from the desktop"}
            {row.note ? ` · “${row.note}”` : ""}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="mv-rbody">
      <div className="mv-note">
        <input
          className="mv-note-in"
          value={note}
          onChange={(e) => onNote(e.target.value)}
          placeholder="Test it, then sign off with a note"
          aria-label="Note"
        />
        {/* The verdict press carries the note, so Save is the seat of the rule
            "a note is saved only with a verdict": quiet, and it says why. */}
        <button type="button" className="mv-mini" disabled title="Pick Tested or Failed first" onClick={onSaveNote}>Save</button>
      </div>
      {limitOver ? (
        <span className="mv-note-help over">500 characters at most</span>
      ) : signable ? null : (
        <span className="mv-note-help">Pick Tested or Failed first</span>
      )}
    </div>
  );
}

export function ManifestScreen(p: ManifestScreenProps) {
  const project = p.project;
  const signOff = project?.signOff ?? "off";
  const maySign = signOff === "yes";
  const refusal = project ? refusalLine(signOff) : null;
  const name = project?.name ?? p.name;
  const age = p.readAt == null ? "" : ageWords(Math.max(0, p.now - p.readAt));
  const stale = p.readAt != null && (p.now - p.readAt >= 120_000 || p.failedRefetch);

  const stateLine = (() => {
    if (p.loading && !project) return "reading this machine";
    if (!name) return "no project open";
    if (project && !project.trunk) return "no branch to read";
    if (project && project.boundary === "none") return "no install boundary";
    // With every project merged, "N left for you in another project" would name
    // one of the projects already on screen, so the line stops at the count.
    return leftLine({ left: project?.left ?? 0, name }, p.scope === ALL_PROJECTS ? null : p.summary);
  })();

  const merged = p.scope === ALL_PROJECTS && (p.summary?.length ?? 0) > 1;
  const rows = project?.rows ?? [];
  const startLine = startLineWords(project?.start ?? null);
  const toTest = useMemo(() => rows.filter((r) => r.group === "toTest"), [rows]);
  const done = useMemo(() => rows.filter((r) => r.group === "done"), [rows]);
  const ready = useMemo(() => rows.filter((r) => r.group === "ready"), [rows]);
  const inProgress = project?.inProgress ?? [];
  const emptyWindow = !!project && project.trunk && rows.length === 0;
  const drawn = p.toTestLimit === 0 ? [] : toTest.slice(0, p.toTestLimit);
  const older = Math.max(0, toTest.length - drawn.length);

  const sign = (row: ManifestRowRef, verdict: "tested" | "failed") => () => {
    if (!maySign) return;
    p.onSign(row, verdict);
  };
  const signedPill = (row: ManifestRowRef) => (
    <>
      <span className={`mv-verdict ${row.verdict === "tested" ? "ok" : "bad"}`}>
        {row.verdict === "tested" ? <Check size={ICON.sm} /> : <Cross size={ICON.sm} />}
        {verdictLine(row.verdict!, row.at)}
      </span>
      <button type="button" className="mv-undo" onClick={(e) => { e.stopPropagation(); p.onUndo(row); }}
        disabled={!maySign || p.busy != null} title="Undo removes the verdict and its note">Undo</button>
    </>
  );
  const verdictButtons = (row: ManifestRowRef) => {
    const over = (p.notes[row.sha] ?? "").length > MANIFEST_NOTE_MAX;
    const off = !maySign || p.busy != null || over;
    const doing = p.busy === `${row.sha}:tested` ? "tested" : p.busy === `${row.sha}:failed` ? "failed" : null;
    return (
      <span className="mv-vset">
        <button type="button" className={`mv-vb ${doing === "tested" ? "on-ok" : ""}`} disabled={off} onClick={(e) => { e.stopPropagation(); sign(row, "tested")(); }}>
          <Check />Tested
        </button>
        <button type="button" className={`mv-vb ${doing === "failed" ? "on-bad" : ""}`} disabled={off} onClick={(e) => { e.stopPropagation(); sign(row, "failed")(); }}>
          <Cross />Failed
        </button>
      </span>
    );
  };
  const rowError = (row: ManifestRowRef) => p.rowErrors[row.sha] ? (
    <div className="mv-rowerr">
      <span>{p.rowErrors[row.sha]}</span>
      <button type="button" className="mv-mini" onClick={() => p.onRetry(row)} disabled={p.busy != null}>Try again</button>
    </div>
  ) : null;
  const toggle = (sha: string) => p.onOpenRow(p.openRow === sha ? null : sha);

  const counter = (cls: "ok" | "live" | "wait", n: number | null, label: string, hint?: string) => (
    <div className={`mv-count ${cls}`} title={hint}>
      <span className="mv-bar" />
      <div className="mv-n">{n == null ? "–" : n}</div>
      <div className="mv-l">{label}</div>
    </div>
  );

  const sinceStart = p.now - 24 * 60 * 60_000;
  const bars = project && rows.length ? stripBars(rows.map((r) => r.time * 1000), sinceStart, p.now) : [];

  return (
    <div className="mv" data-active="" style={{ "--mv-touch": `${TOUCH}px`, "--mv-hit": `${HIT}px` } as CSSProperties}>
      <header className="mv-head">
        <div className="mv-vh">
          <span className="mv-pic"><ManifestIcon size={ICON.lg} /></span>
          <div className="mv-vtitle">
            <h1>Manifest</h1>
            <p>
              {name ? <><button type="button" className="mv-project" onClick={p.onProject} title="Open another project">{name}</button><span> · {stateLine}</span></> : <span>{stateLine}</span>}
            </p>
          </div>
          <div className="mv-tools">
            {p.readAt == null ? null : <span className="mv-read"><Clock />read {age}</span>}
            {project?.trunk ? (
              <button type="button" className="mv-btn mv-startbtn" onClick={p.onStartAsk}
                disabled={p.startBusy || !maySign}
                title={maySign ? "Count only commits after the trunk's current commit" : "Only the desk moves the start line"}>
                Start from zero now
              </button>
            ) : null}
            <RefreshButton onRefresh={p.onRefresh} busy={p.loading} title="Read this list again" />
          </div>
        </div>
        {startLine ? <p className="mv-countline">{startLine}</p> : null}
        {p.startAsk ? (
          <div className="mv-startask" role="group" aria-label="Start from zero">
            <span>Count from the current commit on? Older commits leave the list.</span>
            <button type="button" className="mv-btn mv-startyes" onClick={p.onStartConfirm} disabled={p.startBusy}>
              {p.startBusy ? "Starting…" : "Start from zero"}
            </button>
            <button type="button" className="mv-mini" onClick={p.onStartCancel} disabled={p.startBusy}>Cancel</button>
          </div>
        ) : null}
        {p.startError ? <p className="mv-starterr">{p.startError}</p> : null}
        {showsFilter(p.summary) ? (
          <div className="mv-filter agx-seg" role="tablist" aria-label="Projects">
            <button type="button" role="tab" className="agx-seg-b" aria-selected={p.scope === ALL_PROJECTS}
              onClick={() => p.onScope(ALL_PROJECTS)}>All</button>
            {(p.summary ?? []).map((proj) => (
              <button key={proj.root} type="button" role="tab" className="agx-seg-b"
                aria-selected={p.scope === proj.root} title={proj.root}
                onClick={() => p.onScope(proj.root)}>{proj.name}</button>
            ))}
          </div>
        ) : null}
        {refusal ? <p className="mv-refusal">{refusal}</p> : null}
      </header>

      <div className="mv-body">
        {p.loading && !project ? <Skeleton /> : null}

        {project && !emptyWindow ? (
          <div className="mv-since">
            <div className="mv-since-lab">
              <div className="mv-k">Since</div>
              <div className="mv-v">{clock(sinceStart)} {dayWords(sinceStart, p.now)}</div>
            </div>
            {bars.length > 1 ? (
              <div className="mv-strip" aria-hidden="true">
                {bars.map((h, i) => (
                  <i key={i} className={i === bars.length - 1 ? "now" : h > 2 ? "hit" : ""} style={{ height: h }} />
                ))}
              </div>
            ) : null}
            <div className="mv-counts">
              {counter("ok", project.counters.merged, "merged into main")}
              {counter("live", project.counters.running, "running right now")}
              {counter("wait", project.counters.builtWaiting, "built, waiting for you", project.counters.builtWaiting == null ? "no boundary for this project" : undefined)}
            </div>
          </div>
        ) : null}

        {p.error !== null ? (
          <div className="mv-errbox">
            <span className="mv-erric"><Cross size={ICON.lg} /></span>
            <h3>This machine did not answer</h3>
            <p>
              {p.error
                ? p.error
                : `The view could not read the checkout at ${name || "this project"}. Nothing was lost; the verdicts you already gave are on the server.`}
            </p>
            <button type="button" className="mv-btn" onClick={p.onRefresh}>Try again</button>
            {p.readAt == null ? null : <span className="mv-last">read {ageWords(Math.max(0, p.now - p.readAt))} · the last answer this window got</span>}
          </div>
        ) : null}

        {!project && !p.loading && p.error === null ? (
          p.name ? null : (
            <div className="mv-grp agx-card">
              <div className="mv-empty">
                <span className="mv-empty-ic"><ManifestIcon size={ICON.xl} /></span>
                <h3>No project is open</h3>
                <p>Open a project to see what landed in it.</p>
                <button type="button" className="mv-btn" onClick={p.onProject}>Choose a project</button>
              </div>
            </div>
          )
        ) : null}

        {project && !project.trunk ? (
          <div className="mv-grp agx-card">
            <div className="mv-empty">
              <span className="mv-empty-ic"><Folder size={ICON.xl} /></span>
              <h3>No branch to read</h3>
              <p>This checkout has no branch to compare against.</p>
            </div>
          </div>
        ) : null}

        {project && project.trunk ? (
          emptyWindow ? (
            <div className="mv-grp agx-card">
              <div className="mv-empty">
                <span className="mv-empty-ic"><ManifestIcon size={ICON.xl} /></span>
                <h3>Nothing merged this week</h3>
                <p>Nothing merged, nothing running, nothing waiting for your eyes. The next thing a worker lands will appear here on its own.</p>
              </div>
            </div>
          ) : (
            <>
              <Group
                className="mv-to-test"
                icon={<Check size={ICON.sm} />}
                title="To test"
                count={toTest.length}
                say={project.boundary === "none"
                  ? "This app's build is not in this checkout, so there is nothing to measure installed against."
                  : stale
                    ? `these rows were read ${ageWords(Math.max(0, p.now - (p.readAt ?? p.now)))} — a merge may have landed since`
                    : "merged into the build you are running"}
              >
                <div className="mv-rows">
                  {drawn.map((row) => {
                    const isOpen = p.openRow === row.sha;
                    return (
                      <article key={row.sha} className={`mv-row ${isOpen ? "open" : ""}`}>
                        <div className="mv-rh">
                          <button type="button" className="mv-openarea" aria-expanded={isOpen} onClick={() => toggle(row.sha)} title={row.subject}>
                            <Tile signed={row.verdict} />
                            <span className="mv-rtext">
                              <span className="mv-title">{row.subject}</span>
                              <span className="mv-meta">
                                <span className="mv-pill">{row.projectName}</span>
                                {row.ticket ? <span className="mv-pill mono">{row.ticket}</span> : null}
                                <span className="mv-pill mono">{row.sha.slice(0, 7)}</span>
                                <span className="mv-pill hollow">committed {clock(row.time * 1000)}</span>
                                {stale ? <span className="mv-pill hollow">read {ageWords(Math.max(0, p.now - (p.readAt ?? p.now)))}</span> : null}
                                <span className="mv-pill warn"><i />no steps — ask the builder</span>
                              </span>
                            </span>
                          </button>
                          <span className="mv-ractions">
                            {row.verdict ? signedPill(row) : verdictButtons(row)}
                            <button type="button" className="mv-chev" aria-label={isOpen ? "Close this row" : "Open this row"} aria-expanded={isOpen} onClick={() => toggle(row.sha)}>
                              <Chevron />
                            </button>
                          </span>
                        </div>
                        {rowError(row)}
                        {isOpen ? (
                          <RowBody
                            row={row}
                            note={p.notes[row.sha] ?? ""}
                            onNote={(t) => p.onNote(row.sha, t)}
                            onSaveNote={() => p.onSaveNote(row)}
                            limitOver={(p.notes[row.sha] ?? "").length > MANIFEST_NOTE_MAX}
                            signable={maySign}
                          />
                        ) : null}
                      </article>
                    );
                  })}
                  {toTest.length === 0 ? <div className="mv-quiet">Nothing waiting for your eyes right now.</div> : null}
                </div>
                {older > 0 ? (
                  <div className="mv-more"><button type="button" className="mv-mini" onClick={p.onShowOlder}>Show {older} older</button></div>
                ) : null}
              </Group>

              {inProgress.length ? (
                <Group className="mv-live" icon={<Live size={ICON.sm} />} title="In progress" count={inProgress.length} say="read from this machine · nothing to sign off">
                  <div className="mv-rows">
                    {inProgress.map((row) => (
                      <article className="mv-row" key={`${row.project}:${row.name}:${row.branch}`}>
                        <div className="mv-rh">
                          <Tile signed={null} state="live" />
                          <span className="mv-rtext">
                            <span className="mv-title">{row.name}{row.branch ? ` · ${row.branch}` : ""}</span>
                            {row.doing ? <span className="mv-what">{row.doing}</span> : null}
                            <span className="mv-meta">
                              <span className="mv-pill">{row.projectName}</span>
                              {row.branch ? <span className="mv-pill mono">{row.branch}</span> : null}
                              <span className="mv-pill hollow">{startedLine(row.startedAt, p.now)}</span>
                            </span>
                          </span>
                          <span className="mv-ractions">
                            {row.paneId ? (
                              <button type="button" className="mv-btn mv-showit" onClick={() => p.onShowIt(row)}>Show it</button>
                            ) : null}
                          </span>
                        </div>
                        {row.paneId && p.rowErrors[`pane:${row.paneId}`] ? <div className="mv-rowerr">{p.rowErrors[`pane:${row.paneId}`]}</div> : null}
                      </article>
                    ))}
                  </div>
                </Group>
              ) : (
                <div className="mv-quiet">{merged ? "Nothing is running in any of these projects." : "Nothing is running on this project."}</div>
              )}

              {project.boundary === "build" && ready.length ? (
                <Group
                  className="mv-install"
                  icon={<Install size={ICON.sm} />}
                  title="Ready to install"
                  count={ready.length}
                  say="merged, not in the build you are looking at"
                  extra={
                    <button type="button" className="mv-ghbtn" onClick={p.onReadyToggle} aria-expanded={p.readyOpen}>
                      {p.readyOpen ? "Hide" : "Show"}<Chevron />
                    </button>
                  }
                >
                  <div className="mv-rows">
                    <div className="mv-installrow">
                      <Tile signed={null} state="ready" />
                      <span className="mv-rtext">
                        <span className="mv-title">{fixesLanded(ready.length)}</span>
                        <span className="mv-what">Testing these before installing them is testing code this window does not run. Install first, then the rows move to <b>To test</b> by themselves.</span>
                        <span className="mv-ahead"><b>{ready.length} commits ahead</b> of the build you are running{ready.some((r) => r.ticket) ? ` · ${ready.map((r) => r.ticket).filter(Boolean).join(" · ")}` : ""}</span>
                      </span>
                    </div>
                    {p.readyOpen ? (
                      <div className="mv-subjects">
                        {ready.map((r) => <div key={r.sha} className="mv-subject">{merged ? <span className="mv-pill">{r.projectName}</span> : null}<span className="mv-pill mono">{r.sha.slice(0, 7)}</span>{r.subject}</div>)}
                      </div>
                    ) : null}
                  </div>
                </Group>
              ) : null}

              <section className="agx-card mv-grp mv-done-group">
                <div className="mv-gh">
                  <span className="mv-gpic"><DoneBox size={ICON.sm} /></span>
                  <h2>Done this week</h2>
                  <span className="mv-cnt">{done.length}</span>
                  <span className="mv-say">in the build you are running · signed off or not</span>
                  <span className="mv-gsp" />
                  <button type="button" className="mv-ghbtn" onClick={p.onDoneToggle} aria-expanded={p.doneOpen}>
                    {p.doneOpen ? "Hide" : "Show"} {done.length}<Chevron />
                  </button>
                </div>
                {p.doneOpen ? (
                  <div className="mv-rows">
                    {done.length === 0 ? <div className="mv-quiet">Nothing has moved out of To test yet this week.</div> : null}
                    {done.map((row) => {
                      const isOpen = p.openRow === row.sha;
                      return (
                        <div key={row.sha} className="mv-done-wrap">
                          <button type="button" className={`mv-donerow ${isOpen ? "open" : ""}`} aria-expanded={isOpen} onClick={() => toggle(row.sha)} title={row.subject}>
                            <span className={`mv-tile small ${row.verdict ?? ""}`}>{row.verdict === "tested" ? <Check size={ICON.xs} /> : row.verdict === "failed" ? <Cross size={ICON.xs} /> : <Tray size={ICON.xs} />}</span>
                            <span className="mv-donetitle">{row.subject}</span>
                            {merged ? <span className="mv-pill">{row.projectName}</span> : null}
                            <span className="mv-donemeta mono">{row.ticket ? `${row.ticket} · ` : ""}{row.sha.slice(0, 7)}</span>
                            <span className="mv-when">{clock(row.time * 1000)}</span>
                          </button>
                          {isOpen ? (
                            <>
                              {row.verdict ? (
                                <div className="mv-rbody done">
                                  <div className="mv-signoff">
                                    <span className={`mv-tile-s ${row.verdict}`}>{row.verdict === "tested" ? <Check size={ICON.xs} /> : <Cross size={ICON.xs} />}</span>
                                    <span>{signoffLine(row.verdict, row.at, row.kind, row.note)}</span>
                                  </div>
                                </div>
                              ) : (
                                <RowBody row={row} note={p.notes[row.sha] ?? ""} onNote={(t) => p.onNote(row.sha, t)}
                                  onSaveNote={() => p.onSaveNote(row)} limitOver={(p.notes[row.sha] ?? "").length > MANIFEST_NOTE_MAX}
                                  signable={maySign} />
                              )}
                              <div className="mv-doneacts">
                                {row.verdict ? signedPill(row) : verdictButtons(row)}
                                {rowError(row)}
                              </div>
                            </>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

/* ── the wiring ────────────────────────────────────────────────────────── */

export function ManifestView({ active, onOpenProject }: { active: boolean; onOpenProject: () => void }) {
  const summary = useSyncExternalStore(subscribeSummary, summarySnapshot, summarySnapshot);
  const roots = useMemo(() => (summary ?? []).map((p) => p.root), [summary]);
  // Keyed by the set, not the array: the summary is a fresh object every minute
  // and a load that re-ran with it would add one GET per project every minute.
  const rootKey = roots.join("\0");
  const name = summary?.[0]?.name ?? "";
  const [answers, setAnswers] = useState<ManifestProject[]>([]);
  const [scope, setScope] = useState(ALL_PROJECTS);
  const [reading, setReading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [failedRefetch, setFailedRefetch] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [toTestLimit, setToTestLimit] = useState(50);
  const [doneOpen, setDoneOpen] = useState(false);
  const [readyOpen, setReadyOpen] = useState(false);
  const [startAsk, setStartAsk] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const attempts = useRef<Record<string, { verdict: "tested" | "failed"; note?: string }>>({});
  const hadAnswer = useRef(false);
  const adopted = useRef(false);

  // The remembered project is adopted once, when the summary first names the
  // open ones; after that only a project that has been closed falls back to All.
  useEffect(() => {
    if (!rootKey) return;
    const open = rootKey.split("\0");
    if (!adopted.current) {
      adopted.current = true;
      setScope(readScope(open));
      return;
    }
    setScope((cur) => cur === ALL_PROJECTS || open.includes(cur) ? cur : ALL_PROJECTS);
  }, [rootKey]);

  const load = useCallback(async () => {
    const open = rootKey ? rootKey.split("\0") : [];
    if (!open.length) { setReading(false); return; }
    setReading(true);
    try {
      // One GET per project: the server answers one project at a time. Switching
      // the filter is local and asks for nothing.
      const read = await Promise.all(open.map((r) => readProject(r)));
      const good = read.flatMap((a) => (a.ok && a.answer ? [a.answer] : []));
      if (good.length) setAnswers(good);
      const bad = read.find((a) => !a.ok);
      if (bad) {
        setError(bad.error || "");
        if (hadAnswer.current) setFailedRefetch(true);
      } else {
        setError(null);
        setReadAt(Date.now());
        setFailedRefetch(false);
        hadAnswer.current = true;
      }
    } catch {
      setError("");
      if (hadAnswer.current) setFailedRefetch(true);
    } finally {
      setReading(false);
      setNow(Date.now());
    }
  }, [rootKey]);

  useEffect(() => { if (active) void load(); }, [active, load]);
  useEffect(() => {
    if (!active) return;
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, load]);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [active]);
  // A project read is never polled: only opening, Refresh, and focus.
  useEffect(() => { setToTestLimit(50); setNow(Date.now()); }, [rootKey]);
  useEffect(() => { setToTestLimit(50); }, [scope]);

  // One project has nothing to choose, so its name is the scope's name whether
  // or not "All" was the remembered value.
  const effectiveScope = showsFilter(summary) || !roots.length ? scope : roots[0]!;
  const view = useMemo(() => projectView(answers, effectiveScope), [answers, effectiveScope]);

  // A different filter is a different confirmation.
  useEffect(() => { setStartAsk(false); setStartError(null); }, [effectiveScope]);

  const onStartConfirm = useCallback(async () => {
    const open = effectiveScope === ALL_PROJECTS ? roots : [effectiveScope];
    if (!open.length) return;
    setStartBusy(true);
    setStartError(null);
    try {
      const answer = await Promise.all(open.map((root) => startProject(root)));
      const bad = answer.find((a) => !a.ok);
      if (bad) setStartError(bad.error || "The change did not reach the server.");
      else {
        setStartAsk(false);
        await load();
      }
    } catch {
      setStartError("The change did not reach the server.");
    } finally {
      setStartBusy(false);
    }
  }, [effectiveScope, roots, load]);

  const write = useCallback(async (row: ManifestRowRef, verdict: "tested" | "failed" | "cleared", note?: string) => {
    // The row's own project, never the filter's: a merged list signs each commit
    // where its verdict lives.
    if (!row.project) return;
    setBusy(`${row.sha}:${verdict}`);
    setRowErrors((cur) => { const next = { ...cur }; delete next[row.sha]; return next; });
    if (verdict !== "cleared") attempts.current[row.sha] = { verdict, note };
    try {
      const answer = await signOff(row.project, row.sha, verdict, note);
      if (!answer.ok) setRowErrors((cur) => ({ ...cur, [row.sha]: answer.error || "The write did not reach the server." }));
      else {
        setNotes((cur) => { const next = { ...cur }; delete next[row.sha]; return next; });
        await load();
      }
    } catch {
      setRowErrors((cur) => ({ ...cur, [row.sha]: "The write did not reach the server." }));
    } finally {
      setBusy(null);
    }
  }, [load]);

  const onSign = useCallback((row: ManifestRowRef, verdict: "tested" | "failed") => {
    void write(row, verdict, (notes[row.sha] ?? "").trim() || undefined);
  }, [write, notes]);

  const onSaveNote = useCallback((row: ManifestRowRef) => {
    const attempt = attempts.current[row.sha];
    if (attempt) void write(row, attempt.verdict, (notes[row.sha] ?? "").trim() || undefined);
  }, [write, notes]);

  const onShowIt = useCallback(async (row: { paneId?: string; name: string }) => {
    if (!row.paneId) return;
    try {
      const answer = await api.focusPane({ sessionId: "", windowId: "", paneId: row.paneId });
      if (!answer.ok) setRowErrors((cur) => ({ ...cur, [`pane:${row.paneId}`]: answer.error || "tmux would not go there — the pane may be gone" }));
    } catch {
      setRowErrors((cur) => ({ ...cur, [`pane:${row.paneId}`]: "tmux would not go there — the pane may be gone" }));
    }
  }, []);

  return (
    <ManifestScreen
      project={view}
      name={name}
      summary={summary}
      scope={effectiveScope}
      readAt={readAt}
      now={now}
      loading={reading || summary === null}
      error={error}
      failedRefetch={failedRefetch}
      busy={busy}
      startAsk={startAsk}
      startBusy={startBusy}
      startError={startError}
      rowErrors={rowErrors}
      notes={notes}
      openRow={openRow}
      toTestLimit={toTestLimit}
      doneOpen={doneOpen}
      readyOpen={readyOpen}
      onRefresh={() => { void load(); }}
      onProject={onOpenProject}
      onScope={(next) => { setScope(next); rememberScope(next); }}
      onSign={onSign}
      onUndo={(row) => void write(row, "cleared")}
      onRetry={(row) => { const a = attempts.current[row.sha]; if (a) void write(row, a.verdict, a.note); }}
      onOpenRow={setOpenRow}
      onNote={(sha, text) => setNotes((cur) => ({ ...cur, [sha]: text }))}
      onSaveNote={onSaveNote}
      onShowOlder={() => setToTestLimit((n) => n + 50)}
      onDoneToggle={() => setDoneOpen((v) => !v)}
      onReadyToggle={() => setReadyOpen((v) => !v)}
      onShowIt={(row) => { void onShowIt(row); }}
      onStartAsk={() => { setStartError(null); setStartAsk(true); }}
      onStartCancel={() => { setStartAsk(false); setStartError(null); }}
      onStartConfirm={() => { void onStartConfirm(); }}
    />
  );
}
