import { ICON } from "../../lib/iconSize.ts";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.ts";
import type { GitRepoRef } from "../../../../shared/types.ts";
import { CheckoutPicker } from "../CheckoutPicker.tsx";
import { focusedPaneRoot } from "../TerminalPanel.tsx";
import { projectName, titleFrom, type Size } from "../../lib/flightPlan.ts";
import { DocIcon, PlaneIcon } from "./fpIcons.tsx";
import type { Cfg } from "./useFlightPlan.ts";

export interface Preset { root?: string; request?: string; taskId?: string; from?: string }

const hint = (size: Size, c: Cfg | undefined): string =>
  size === "S" ? "Small plans launch without Preflight."
    : !c || c.before === "off" ? "Preflight is off for this project."
    : "Preflight reads the plan before Launch in this project.";

/** "New flight plan": a request in the person's own words, a project and a size. The author turns it into the plan. */
export function Composer({ projects, root, preset, cfg, onClose, onCreated }: {
  projects: string[]; root: string; preset: Preset; cfg: Record<string, Cfg>; onClose: () => void;
  onCreated: (r: { id: string; root: string; ticket?: string }) => void;
}) {
  const [request, setRequest] = useState(preset.request ?? "");
  /* The project the focused terminal is in, else the window's. A worktree stands for its project below. */
  const [proj, setProj] = useState(preset.root || focusedPaneRoot() || root || projects[0] || "");
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [size, setSize] = useState<Size>("M");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { if (!proj && root) setProj(root); }, [root, proj]);
  useEffect(() => {
    let live = true;
    api.gitRepos().then(({ repos: all }) => {
      if (!live) return;
      setRepos(all);
      setProj((cur) => all.find((r) => r.root === cur)?.worktreeOf ?? cur);
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  /* Projects, not checkouts: a plan is for a project. One that is open but not a repository is still listed, by name. */
  const choices = useMemo<GitRepoRef[]>(() => {
    const known = repos.filter((r) => !r.worktreeOf);
    const have = new Set(known.map((r) => r.root));
    const extra = [...new Set([proj, ...projects].filter((p) => p && !have.has(p)))]
      .map((p) => ({ root: p, name: projectName(p), branch: "", dirty: 0, ahead: 0, behind: 0, touchedAt: 0 }));
    return [...known.filter((r) => projects.length === 0 || projects.includes(r.root) || r.root === proj), ...extra];
  }, [repos, projects, proj]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);

  const submit = async () => {
    if (!request.trim() || !proj || busy) return;
    setBusy(true); setErr("");
    const r = await api.flightPlanNew({ root: proj, title: titleFrom(request), request: request.trim(), visual: false, size, ...(preset.taskId ? { taskId: preset.taskId } : {}) })
      .catch(() => ({ ok: false, error: "could not reach the server" } as { ok: boolean; plan?: Record<string, unknown>; ticket?: string; error?: string }));
    setBusy(false);
    if (!r.ok || !r.plan) { setErr(r.error ?? "the plan was not created"); return; }
    onCreated({ id: String(r.plan.id), root: proj, ...(r.ticket ? { ticket: r.ticket } : {}) });
  };

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pop" role="dialog" aria-label="New flight plan">
        <div className="poll" style={{ boxShadow: "var(--fp-lift-lg)" }}>
          <div className="hd"><span className="ic"><PlaneIcon size={15} /></span><b>New flight plan</b><span className="esc">Esc closes</span></div>
          <div className="srow flat" style={{ borderTop: 0, gridTemplateColumns: "1fr", justifyItems: "start" }}>
            <div><div className="rn">Project</div><div className="rh">Where it will be built.</div></div>
            {/* Left-aligned: the list opens rightwards, and the dialog clips what leaves it. */}
            <CheckoutPicker repos={choices} value={proj} onPick={setProj} placeholder="Pick a project" triggerMaxWidth={220} branchLabel={null} title="Which project this plan is for" />
          </div>
          {preset.from && <div className="pr from"><span className="chip off" style={{ gridRow: "auto" }}><DocIcon size={ICON.xs} />From task</span><span style={{ fontSize: 11.2, color: "var(--text2)" }}>{preset.from}</span></div>}
          <div className="rq">
            <label htmlFor="fp-rq">What should be built?</label>
            <div className="h">In your own words. The author turns it into the flight plan.</div>
            <textarea id="fp-rq" rows={4} autoFocus value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Describe the change, who it is for, and what done looks like…" />
          </div>
          <div className="srow flat">
            <div><div className="rn">Size</div><div className="rh">{hint(size, cfg[proj])}</div></div>
            <div className="seg" role="group" aria-label="Size">
              {(["S", "M", "L"] as const).map((s) => <button key={s} type="button" aria-pressed={size === s} onClick={() => setSize(s)}>{s}</button>)}
            </div>
          </div>
          <div className="gobar">
            <div className="row2">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="button" className="btn primary" disabled={!request.trim() || !proj || busy} onClick={() => void submit()}>{busy ? "Writing…" : "Write the flight plan"}</button>
            </div>
            <small>Nothing is built yet. The plan comes back here, goes through Preflight, and waits for Go.</small>
            {err && <small role="alert" style={{ color: "var(--error)" }}>{err}</small>}
          </div>
        </div>
      </div>
    </div>
  );
}
