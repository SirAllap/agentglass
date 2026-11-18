/*
 * Step 6, Checks: is it all working.
 *
 * Four rows read from calls the app already has. Each Fix does one thing and
 * then that row checks again. Nothing here blocks Finish; a red row is still
 * listed in Settings ▸ About afterwards.
 */
import { useCallback, useEffect, useState } from "react";
import type { AgentProbe, BrowserUseStatus } from "../../../../shared/types.ts";
import type { DepReport } from "../../../../shared/deps.ts";
import { ICON } from "../../lib/iconSize.ts";
import { api, SERVER } from "../../lib/api.ts";
import { installLine } from "../../lib/setupAgents.ts";
import { askNotifyPermission, notifyPermission } from "../../lib/sysNotify.ts";
import { shellNotices } from "../../lib/desktop.ts";
import { apiPortOf, noticePorts } from "../../lib/setupNotices.ts";
import { askTestNote } from "../../lib/notifyTestDoor.ts";
import { checkRows, checksNeedingYou, type CheckInput, type CheckRow } from "../../lib/setupChecks.ts";

export function ChecksStep({ picked, onNeeds }: {
  /** The agent picked at step 1, for its install line. */
  picked: string;
  onNeeds: (n: number) => void;
}) {
  return (
    <>
      <div className="setup-eyebrow">Checks</div>
      <h1 className="setup-h1">Is it all working</h1>
      <p className="setup-lede">One last look. Each Fix does one thing, then this row checks again.</p>
      <ChecksList picked={picked} onNeeds={onNeeds} />
    </>
  );
}

/** The rows and their Fix buttons; Settings ▸ About draws the same list. */
export function ChecksList({ picked, onNeeds }: {
  picked: string;
  onNeeds?: (n: number) => void;
}) {
  const [tmux, setTmux] = useState<DepReport | undefined>(undefined);
  const [agents, setAgents] = useState<AgentProbe[] | null>(null);
  const [browser, setBrowser] = useState<BrowserUseStatus | null>(null);
  const [gh, setGh] = useState<CheckInput["gh"]>(null);
  const [hooks, setHooks] = useState<boolean | null>(null);
  const [ports] = useState(() => noticePorts(shellNotices(), apiPortOf(SERVER)));
  const [notify, setNotify] = useState(() => notifyPermission());
  const [busy, setBusy] = useState<CheckRow["id"] | null>(null);
  const [said, setSaid] = useState("");

  const readTmux = useCallback((force = false) => api.dependencies(force)
    .then((r) => setTmux(r.deps.find((d) => d.id === "tmux"))).catch(() => {}), []);
  const readAgents = useCallback(() => api.agents().then((r) => setAgents(r.agents)).catch(() => setAgents([])), []);
  const readBrowser = useCallback(() => api.browserUseStatus().then(setBrowser).catch(() => setBrowser(null)), []);

  const readGh = useCallback((force = false) => api.prCapability(force).then(setGh).catch(() => setGh(null)), []);
  const readHooks = useCallback(() => api.hooksStatus().then((s) => setHooks(s.installed)).catch(() => setHooks(null)), []);

  useEffect(() => { void readTmux(); void readAgents(); void readBrowser(); void readGh(); void readHooks(); }, [readTmux, readAgents, readBrowser, readGh, readHooks]);

  const rows = checkRows({ tmux, agents, agentInstall: installLine(picked), browser, notify, gh, ports, hooks });
  const needs = checksNeedingYou(rows);
  useEffect(() => { onNeeds?.(needs); }, [needs, onNeeds]);

  const recheck = (id: CheckRow["id"]) => {
    if (id === "tmux") return readTmux(true);
    if (id === "agents") return readAgents();
    if (id === "browser") return readBrowser();
    if (id === "gh") return readGh(true);
    if (id === "hooks") return readHooks();
    setNotify(notifyPermission());
    return Promise.resolve();
  };

  const fix = async (r: CheckRow) => {
    if (!r.fix) return;
    setBusy(r.id);
    setSaid("");
    try {
      switch (r.fix.kind) {
        case "copy":
          try { await navigator.clipboard.writeText(r.fix.line); setSaid("Copied. Paste it into a terminal, then press Recheck."); }
          catch { setSaid(`Could not copy it. Run this by hand: ${r.fix.line}`); }
          break;
        case "browserInstall": {
          const res = await api.browserUseInstall();
          if (!res.ok) setSaid(res.error || "The browser tools did not install.");
          break;
        }
        case "notify": {
          const p = await askNotifyPermission();
          setNotify(p);
          if (p === "granted") { try { askTestNote("other", 0); } catch { /* one test per 10 s is fine */ } }
          break;
        }
        case "hooksInstall": {
          const res = await api.hooksInstall();
          if (!res.ok) setSaid(res.error || "The hooks did not install.");
          break;
        }
        case "osHelp":
          setSaid(r.fix.help);
          break;
        case "recheck":
          break;
      }
      if (r.fix.kind !== "copy" && r.fix.kind !== "osHelp") await recheck(r.id);
    } catch (e) {
      setSaid(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="setup-tool-card" role="list" aria-label="Checks">
        {rows.map((r) => (
          <div className="setup-tool-row" data-tone={r.tone} key={r.id} role="listitem">
            <span className="setup-tool-mark" aria-hidden="true"><Mark tone={r.tone} /></span>
            <span className="setup-tool-what">
              <span className="setup-tool-name">{r.title}</span>
              <span className="setup-tool-help">{r.detail}</span>
            </span>
            <span className="setup-tool-end">
              <span className="sr-only">{r.tone === "ok" ? "Working" : r.pending ? "Checking" : "Needs you"}</span>
              {r.fix && (
                <button type="button" disabled={busy != null}
                  className={`setup-btn setup-btn-xs${r.fix.kind === "recheck" ? " setup-btn-quiet" : ""}`}
                  onClick={() => void fix(r)}>
                  {busy === r.id ? "Working…" : r.fix.label}
                </button>
              )}
              {r.fix?.kind === "copy" && (
                <button type="button" className="setup-btn setup-btn-xs setup-btn-quiet" disabled={busy != null}
                  onClick={() => void recheck(r.id)}>Recheck</button>
              )}
            </span>
          </div>
        ))}
      </div>
      <p className="setup-hint">{said || "Finish is never blocked. A row that is still red shows again in Settings ▸ About."}</p>
    </>
  );
}

function Mark({ tone }: { tone: CheckRow["tone"] }) {
  const s = { width: ICON.xs, height: ICON.xs, viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true } as const;
  if (tone === "ok") return <svg {...s}><circle cx="6" cy="6" r="5.25" /><path d="M3.6 6.2l1.6 1.6 3.2-3.4" /></svg>;
  if (tone === "warn") return <svg {...s} strokeLinejoin="round"><path d="M6 1.2l5 9.3H1z" /><path d="M6 4.6v2.6M6 8.6v.1" /></svg>;
  return <svg {...s}><circle cx="6" cy="6" r="5.25" /><path d="M4 4l4 4M8 4l-4 4" /></svg>;
}
