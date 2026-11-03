/*
 * Step 5: the last one, and the only one that leaves the wizard.
 *
 * The project, the command that will run, and one primary naming the outcome.
 * The ticket is minted in the selected project with the picked agent as its
 * kind; the Terminal view makes the pane. A failure stays here with the
 * server's own sentence, and `Not now` is the footer's way out without one.
 */
import { useEffect, useRef, useState } from "react";
import type { EnginesReport, SetupState } from "../../../../shared/types.ts";
import type { LaunchMode } from "../../../../shared/launchModes.ts";
import { ICON } from "../../lib/iconSize.ts";
import { api } from "../../lib/api.ts";
import { tildify } from "../../lib/projectsPaths.ts";
import {
  engineFor, firstWorkView, firstWorkProjects, openFirstWork, openFirstWorkShell,
  projectTileLines, projectTiles, type FirstWorkProject,
} from "../../lib/setupFirstWork.ts";

export interface FirstWorkFrame {
  /** The footer's tally, or null for the step number. */
  tally: number | null;
  /** The footer's primary label. */
  primary: string;
  /** Whether the primary does nothing at all. */
  blocked: boolean;
}

export function FirstWorkStep({ state, agent, onFrame, onCommit, onBack }: {
  state: SetupState;
  agent: string;
  onFrame: (f: FirstWorkFrame) => void;
  onCommit: (fn: (() => Promise<boolean>) | null) => void;
  /** `← Repositories`, for the no-project state. */
  onBack: () => void;
}) {
  const [projects, setProjects] = useState<FirstWorkProject[] | null>(null);
  const [report, setReport] = useState<EnginesReport | null>(null);
  const [mode, setMode] = useState<LaunchMode>("default");
  const [picked, setPicked] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Only the latest attempt draws its outcome: Try again twice is two answers.
  const round = useRef(0);

  useEffect(() => {
    let live = true;
    void Promise.all([api.projects(), api.gitRepos(), api.engines(), api.launchPermissions()]).then(([p, g, e, m]) => {
      if (!live) return;
      setMode(m.mode);
      const list = firstWorkProjects(g.repos ?? [], p.workspaces ?? []);
      setProjects(list);
      setPicked(list[0]?.root ?? "");
      setReport(e);
    }).catch(() => {
      if (!live) return;
      setProjects([]);
      setReport(null);
    });
    return () => { live = false; };
  }, []);

  const list = projects ?? [];
  const selected = list.find((p) => p.root === picked) ?? list[0] ?? null;
  const view = firstWorkView({ engine: engineFor(report, agent), agent, mode, project: selected });

  useEffect(() => {
    onFrame({ tally: projects === null ? null : list.length, primary: view.primary, blocked: projects === null });
  }, [projects, list.length, view.primary, view.blocked, onFrame]);

  const run = async (): Promise<boolean> => {
    if (!selected) return false;
    const mine = ++round.current;
    setBusy(true);
    setError("");
    const r = view.action === "shell"
      ? await openFirstWorkShell(selected)
      : await openFirstWork(selected, agent);
    if (mine !== round.current) return false;
    setBusy(false);
    if (!r.ok) { setError(r.error || "the terminal did not open"); return false; }
    return true;
  };

  useEffect(() => {
    // With no project the primary is `Pick a folder`, which goes back to step 4
    // and reports false: the wizard must not finish on it.
    onCommit(selected ? run : async () => { onBack(); return false; });
    return () => onCommit(null);
    // `run` is rebuilt from the same selected/action facts the frame reads.
  }, [selected?.root, picked, view.action, onCommit, onBack]);

  const tiles = projectTiles(list);
  const branch = selected ? projectTileLines(selected).branch : "";

  return (
    <>
      <div className="setup-eyebrow">First work</div>
      <h1 className="setup-h1">Open a terminal and start</h1>
      <p className="setup-lede">
        The agent you picked starts in the project you choose, on the branch it is on, in a pane of its
        own. Nothing else is needed: this is the last step.
      </p>

      {selected ? (
        <>
          <div className="setup-group">
            <div className="setup-group-head">
              <span className="setup-group-title">Project</span>
              <span className="setup-group-why">· {list.length} imported</span>
            </div>
            <div className="setup-projects" role="group" aria-label="The project to open">
              {tiles.shown.map((p) => {
                const lines = projectTileLines(p);
                return (
                  <button type="button" key={p.root} className="setup-project" data-on={p.root === selected.root ? "1" : "0"}
                    aria-pressed={p.root === selected.root} title={p.name}
                    onClick={() => setPicked(p.root)}>
                    <span className="setup-project-name" title={p.name}>{lines.name}</span>
                    <span className="setup-project-branch" title={p.branch} aria-label={`branch ${p.branch}`}>
                      <Branch /> {lines.branch}
                    </span>
                    <span className="setup-project-worked">{lines.worked}</span>
                  </button>
                );
              })}
            </div>
            {tiles.more > 0 && (
              <p className="setup-hint">{tiles.more} more — the list is in Projects.</p>
            )}
          </div>

          <div className="setup-group">
            <div className="setup-group-head">
              <span className="setup-group-title">This will run</span>
              <span className="setup-group-why">· in {projectTileLines(selected).name}</span>
            </div>
            <p className="setup-run">
              <code>{view.command}</code> in <code title={selected.root}>{tildify(selected.root)}</code>
              {branch ? <> on <code title={selected.branch}>{branch}</code></> : null}
            </p>
            <p className="setup-hint setup-lock"><Lock /> {view.lock}</p>
          </div>

          <div className="setup-preview" aria-label="What the terminal will look like">
            <div className="setup-preview-bar">
              <Term /> <span title={selected.name}>{projectTileLines(selected).name}</span>
              {branch && <span className="setup-preview-branch" title={selected.branch}>· {branch}</span>}
              <span className="setup-grow" />
              <span className="setup-badge setup-badge-ok">opens here</span>
            </div>
            <div className="setup-preview-screen" aria-hidden="true">
              <div className="setup-preview-dim">{tildify(selected.root)}  {branch} ~ $ <span className="setup-preview-cmd">{view.command}</span></div>
              <div className="setup-preview-dim">✻ {view.agentTitle} · starting in this project</div>
              <div className="setup-preview-dim">cwd {tildify(selected.root)} · branch {selected.branch}</div>
              <div className="setup-preview-blue">&gt; <span className="setup-preview-cursor" /></div>
            </div>
          </div>

          {view.notice && <p className="setup-note">{view.notice}</p>}
          {error && (
            <p className="setup-note" role="alert">
              The terminal did not open: {error}.{" "}
              <button type="button" className="setup-link" onClick={() => void run()} disabled={busy}>Try again</button>
            </p>
          )}
          <p className="setup-hint">
            Your agent runs with the permissions set in Settings › Terminal: it asks before a tool it has
            not been allowed. Loosening that is a choice you make there, not one this screen makes for you.
          </p>
        </>
      ) : projects === null ? (
        <p className="setup-note" role="status">Reading your projects…</p>
      ) : (
        <div className="setup-noproject">
          <p className="setup-note">No project yet — pick the folder you keep code in, or add a repository.</p>
          <div className="setup-noproject-acts">
            <button type="button" className="setup-btn setup-btn-secondary" onClick={onBack}>← Repositories</button>
          </div>
        </div>
      )}
    </>
  );
}

function Branch() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4.4" cy="3.4" r="1.7" /><circle cx="4.4" cy="12.6" r="1.7" /><circle cx="11.6" cy="5.6" r="1.7" />
      <path d="M4.4 5.1v5.8" /><path d="M9.9 5.6c0 2.6-2 3.2-4 3.6" />
    </svg>
  );
}
function Term() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.4 4.4 6 8l-3.6 3.6" /><path d="M8 11.6h5.6" />
    </svg>
  );
}
function Lock() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4" /><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" />
    </svg>
  );
}
