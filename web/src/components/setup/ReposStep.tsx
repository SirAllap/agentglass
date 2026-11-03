/*
 * Step 4: bring your code in, by hand.
 *
 * A folder comes back as the repositories it holds, one checkbox each with its
 * branch; Continue hands the ticked ones to the workspace. Nothing is written
 * until Continue, and the projects already open stay open beside the new ones.
 * The search over the whole machine is its own mode (S4); this step picks a
 * folder and reads it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SetupRepoRow, SetupRepos } from "../../../../shared/types.ts";
import { ICON } from "../../lib/iconSize.ts";
import { api } from "../../lib/api.ts";
import { CAN_BROWSE_FOLDER, chooseFolder } from "../../lib/desktop.ts";
import { tildify } from "../../lib/projectsPaths.ts";
import { FolderField } from "../projects/FolderField.tsx";
import { addedRoots, branchLabel, repoRowsOf, reposView, repoTally, tickAll } from "../../lib/setupRepos.ts";

export interface ReposFrame {
  /** The footer's tally for this step; null falls back to the step number. */
  tally: { n: number; of: number } | null;
  /** True while Continue would do nothing (nothing ticked, or a read in the air). */
  blocked: boolean;
}

export function ReposStep({ onFrame, onCommit, onSearch }: {
  onFrame: (f: ReposFrame) => void;
  /** The frame's Continue calls this; `true` means it may move on. */
  onCommit: (fn: (() => Promise<boolean>) | null) => void;
  /** `Search this computer` replaces the window with the Finder. */
  onSearch: () => void;
}) {
  const [asked, setAsked] = useState("");
  const [answer, setAnswer] = useState<SetupRepos | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState<string[]>([]);
  const [say, setSay] = useState("");
  const [busy, setBusy] = useState(false);
  // Only the latest folder read is drawn: two clicks can be in the air at once.
  const round = useRef(0);

  useEffect(() => {
    let live = true;
    void api.projects().then((r) => { if (live) setOpen(r.workspaces ?? []); }).catch(() => { /* nothing open is fine */ });
    return () => { live = false; };
  }, []);

  const read = useCallback((path: string) => {
    const p = path.trim();
    if (!p) return;
    const mine = ++round.current;
    setAsked(p);
    setAnswer(null);
    setTicked([]);
    setSay("");
    setBusy(true);
    void api.setupRepos(p)
      .then((r) => { if (mine === round.current) setAnswer(r); })
      .catch(() => { if (mine === round.current) setAnswer({ path: p, exists: false, repos: [], capped: false }); })
      .finally(() => { if (mine === round.current) setBusy(false); });
  }, []);

  const browse = async () => {
    const picked = await chooseFolder(asked || undefined);
    if (picked) read(picked);
  };

  const view = reposView(asked, answer);
  const rows = repoRowsOf(view);
  const tally = view.state === "rows" ? repoTally(ticked, rows) : null;
  const blocked = view.state !== "rows" || tally!.n === 0;

  useEffect(() => { onFrame({ tally, blocked }); }, [tally?.n, tally?.of, blocked, onFrame]);

  // Continue sends the ticked roots, added to what is already open.
  useEffect(() => {
    if (view.state !== "rows" || !ticked.length) { onCommit(null); return; }
    onCommit(async () => {
      try {
        const r = await api.setWorkspaces(addedRoots(open, ticked));
        if (!r.ok) { setSay(r.error || "The server did not take those repositories."); return false; }
        return true;
      } catch (e) {
        setSay(String(e));
        return false;
      }
    });
    return () => onCommit(null);
  }, [ticked, open, view.state, onCommit]);

  const toggle = (root: string) => setTicked((t) => (t.includes(root) ? t.filter((r) => r !== root) : [...t, root]));
  const all = rows.every((r) => ticked.includes(r.root));

  return (
    <>
      <div className="setup-eyebrow">Repositories</div>
      <h1 className="setup-h1">Bring your code in</h1>
      <p className="setup-lede">
        Pick the folder you keep projects in. Every git repository inside it is listed — nothing is added
        until you choose it.
      </p>

      <div className={`setup-picks${CAN_BROWSE_FOLDER ? " setup-picks-2" : ""}`}>
        {CAN_BROWSE_FOLDER && (
          <button type="button" className="setup-pick" onClick={() => void browse()} disabled={busy}>
            <span className="setup-pick-mark" aria-hidden="true"><Folder /></span>
            <span className="setup-pick-text">
              <span className="setup-pick-name">Pick a folder</span>
              <span className="setup-pick-what">Every git repository inside it, listed at once.</span>
            </span>
            <span className="setup-pick-go" aria-hidden="true">Choose…</span>
          </button>
        )}
        <button type="button" className="setup-pick" onClick={onSearch} disabled={busy}>
          <span className="setup-pick-mark setup-pick-search" aria-hidden="true"><Search /></span>
          <span className="setup-pick-text">
            <span className="setup-pick-name">Search this computer</span>
            <span className="setup-pick-what">Looks through your home folder and the drives you chose. It can take a while.</span>
          </span>
          <span className="setup-pick-go" aria-hidden="true">Search</span>
        </button>
      </div>
      {view.state !== "rows" && (
        <div className="setup-typed">
          <label className="setup-typed-label" htmlFor="setup-repo-path">Or type a folder path</label>
          <FolderField id="setup-repo-path" label="Folder path" value={typed} onChange={setTyped} onSubmit={() => read(typed)}
            placeholder={asked || "~/code"} />
        </div>
      )}

      {view.state !== "rows" && view.state !== "empty" && !busy && (
        <p className="setup-note" role="status">
          {view.state === "gone" ? "That folder is gone." : "That folder is not a git repository, and holds none."}{" "}
          <button type="button" className="setup-link" onClick={() => { setAsked(""); setAnswer(null); setTyped(""); }}>Pick another</button>
        </p>
      )}
      {busy && <p className="setup-note" role="status">Reading {tildify(asked)}…</p>}

      {view.state === "rows" && (
        <>
          <div className="setup-folder">
            <span className="setup-folder-mark" aria-hidden="true"><Folder /></span>
            <code title={view.path}>{tildify(view.path)}</code>
            <button type="button" className="setup-btn setup-btn-xs" onClick={() => (CAN_BROWSE_FOLDER ? void browse() : setAsked(""))} disabled={busy}>
              {CAN_BROWSE_FOLDER ? "Choose another folder…" : "Type another path"}
            </button>
          </div>
          <div className="setup-repos-head">
            <span className="setup-note setup-repos-count">
              <b>{rows.length}</b> {rows.length === 1 ? "repository" : "repositories"} in <code>{tildify(view.path)}</code>
            </span>
            <span className="setup-grow" />
            <button type="button" className="setup-btn setup-btn-xs" onClick={() => setTicked(tickAll(ticked, rows))} disabled={all}>
              Select all
            </button>
          </div>
          <RepoList path={view.path} rows={rows} ticked={ticked} onToggle={toggle} />
          {view.capped && <p className="setup-hint">The first 200 are listed. The rest are in Projects once this folder is open.</p>}
          <p className="setup-hint">
            A project opens as its own chip in the workspace, with its branches and its own terminals.
            Repositories can be added or removed later under Projects.
          </p>
          {say && <p className="setup-note" role="alert">{say}</p>}
        </>
      )}
    </>
  );
}

/** A folder's repositories, one checkbox each, in the order the server sorted them. */
export function RepoList({ path, rows, ticked, onToggle }: {
  path: string;
  rows: readonly SetupRepoRow[];
  ticked: readonly string[];
  onToggle: (root: string) => void;
}) {
  return (
    <div className="setup-repolist" role="group" aria-label={`Repositories in ${tildify(path)}`}>
      {rows.map((r) => {
        const on = ticked.includes(r.root);
        return (
          <label className="setup-repo" key={r.root} data-on={on ? "1" : "0"}>
            <input type="checkbox" className="setup-repobox" checked={on} onChange={() => onToggle(r.root)}
              aria-label={`${r.name}, on ${r.branch}`} />
            <span className="setup-repomark" aria-hidden="true"><Branch /></span>
            <span className="setup-reponame" title={r.name}>{r.name}</span>
            <span className="setup-repobranch" title={r.branch} aria-label={r.branch}>{branchLabel(r.branch)}</span>
          </label>
        );
      })}
    </div>
  );
}

function Folder() {
  return (
    <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.8 4.2h4.1l1.4 1.7h6.9v6.1a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V4.2Z" />
    </svg>
  );
}

function Search() {
  return (
    <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.4 3.4" />
    </svg>
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
