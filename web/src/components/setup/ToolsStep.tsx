/*
 * Step 3: what this machine has, in the catalog's three levels.
 *
 * Counters are computed from the report, never typed: `N ready` over the two
 * counted groups, `M needs you` over the whole answer with the picked agent.
 * A row that is installed and unusable gets the next step's own command and a
 * Copy; nothing here runs anything.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DepsResponse } from "../../../../shared/deps.ts";
import { ICON } from "../../lib/iconSize.ts";
import { api } from "../../lib/api.ts";
import { fixableRows, needsCount, readyCount, toolGroups, toolRow, type ToolRowView } from "../../lib/setupTools.ts";
import { useModalDialog } from "../../lib/focusTrap.ts";
import { LAYER } from "../../lib/layers.ts";

export function ToolsStep({ picked, onNeeds }: {
  picked: string;
  /** Lets the frame's footer count what needs the person, as the mock does. */
  onNeeds: (n: number) => void;
}) {
  const [deps, setDeps] = useState<DepsResponse | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [sheet, setSheet] = useState(false);
  const [optional, setOptional] = useState(true);
  // Only the latest answer is drawn: two rechecks can be in the air at once.
  const round = useRef(0);

  const load = useCallback((force: boolean) => {
    const mine = ++round.current;
    setBusy(true);
    void api.dependencies(force)
      .then((r) => { if (mine === round.current) { setDeps(r); setErr(false); } })
      .catch(() => { if (mine === round.current) setErr(true); })
      .finally(() => { if (mine === round.current) setBusy(false); });
  }, []);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => { if (deps) onNeeds(needsCount(deps, picked)); }, [deps, picked, onNeeds]);

  const groups = deps ? toolGroups(deps, picked) : [];
  const ready = deps ? readyCount(deps, picked) : 0;
  const needs = deps ? needsCount(deps, picked) : 0;

  return (
    <>
      <div className="setup-eyebrow">Tools</div>
      <h1 className="setup-h1">What this machine has</h1>
      <p className="setup-lede">
        agentglass drives the tools you already have. Each one says what it is for and what is missing;
        the command is shown before anything runs.
      </p>

      <div className="setup-tools-head">
        <span className="setup-chips">
          <span className="setup-badge setup-badge-ok">{deps ? `${ready} ready` : "Checking"}</span>
          {deps && (needs > 0
            ? <span className="setup-badge setup-badge-warn">{needs} need{needs === 1 ? "s" : ""} you</span>
            : <span className="setup-badge setup-badge-ok">Nothing needed</span>)}
        </span>
        <span className="setup-grow" />
        <button type="button" className="setup-btn setup-btn-secondary" onClick={() => load(true)} disabled={busy}>
          <Spark /> Recheck
        </button>
        <button
          type="button"
          className="setup-btn setup-btn-primary"
          onClick={() => setSheet(true)}
          disabled={!deps || needs === 0}
        >
          {needs > 0 ? `Fix all needed · ${needs}` : "Nothing to fix"}
        </button>
      </div>

      {err && (
        <p className="setup-note">
          Could not read this machine's tools.{" "}
          <button type="button" className="setup-link" onClick={() => load(true)} disabled={busy}>Recheck</button>
        </p>
      )}
      {!deps && !err && <p className="setup-note">Checking this machine…</p>}

      {groups.map((g) => {
        const collapsed = g.level === "optional" && !optional;
        return (
          <div className="setup-group" key={g.level}>
            <div className="setup-group-head">
              <span className="setup-group-title">{g.title}</span>
              <span className="setup-group-count">{g.rows.length}</span>
              <span className="setup-group-why">· {g.why}</span>
              {g.level === "optional" && (
                <button type="button" className="setup-group-toggle" aria-expanded={!collapsed}
                  onClick={() => setOptional((v) => !v)}>
                  {collapsed ? "Show" : "Hide"}
                </button>
              )}
            </div>
            {!collapsed && (
              <div className="setup-tool-card">
                {g.rows.length === 0 && <p className="setup-note setup-tool-empty">Nothing in this group.</p>}
                {g.rows.map((d) => {
                  const row = toolRow(d);
                  return (
                    <ToolRow key={d.id} row={row} open={open === d.id}
                      onToggle={() => { setOpen(open === d.id ? null : d.id); setSaid(""); }}
                      onCopy={(line) => void copy(line, setSaid)} />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {deps && <p className="setup-hint">{said || "Install it the way you install anything here, then press Recheck. Only the Needed tools decide whether the app can work; the Optional list is here to be read, not cleared."}</p>}

      {sheet && deps && (
        <FixAllSheet rows={fixableRows(deps, picked)} onClose={() => setSheet(false)} onCopy={(line) => void copy(line, setSaid)} />
      )}
    </>
  );
}

export function ToolRow({ row, open, onToggle, onCopy }: {
  row: ToolRowView;
  open: boolean;
  onToggle: () => void;
  onCopy: (line: string) => void;
}) {
  const d = row.d;
  return (
    <div className="setup-tool-row" data-tone={row.tone}>
      <span className="setup-tool-mark" aria-hidden="true">{d.title.charAt(0).toUpperCase()}</span>
      <span className="setup-tool-what">
        <span className="setup-tool-name">
          {d.title}
          {row.version && <span className="setup-badge setup-badge-ok" title={row.version}>{row.version}</span>}
        </span>
        <span className="setup-tool-help">{row.help}</span>
      </span>
      <span className="setup-tool-end">
        <span className={`setup-badge setup-badge-${row.tone}`}>{row.state}</span>
        {row.action && (
          <button type="button" className="setup-btn setup-btn-xs" aria-expanded={open} onClick={onToggle}>
            {row.action.label}
          </button>
        )}
      </span>
      {open && row.action?.command && (
        <div className="setup-tool-cmd">
          <div className="setup-cmd">
            <code title={row.action.command}>{row.action.command}</code>
            <button type="button" className="setup-btn setup-btn-xs" onClick={() => onCopy(row.action!.command!)}>
              <Copy /> Copy
            </button>
          </div>
          <p className="setup-hint">Paste it into the terminal you already have, then press Recheck.</p>
        </div>
      )}
    </div>
  );
}

/** The needed rows that are not ok, command first, with its Copy. */
function FixAllSheet({ rows, onClose, onCopy }: {
  rows: ReturnType<typeof fixableRows>;
  onClose: () => void;
  onCopy: (line: string) => void;
}) {
  const modal = useModalDialog(true, "Fix all needed");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="setup-scrim" style={{ zIndex: LAYER.settings }} onMouseDown={onClose}>
      <div {...modal} className="setup-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="setup-sheet-head">
          <div className="setup-sheet-title">Fix all needed</div>
          <p className="setup-sheet-lead">
            These are the lines for the needed tools that are not ready, in this order. Paste them one at a
            time; agentglass does not type your password and does not run anything you have not read.
          </p>
        </div>
        <div className="setup-sheet-body">
          {rows.map((d) => {
            const line = d.status === "missing" ? d.install : (d.signIn ?? d.install);
            return (
              <div className="setup-sheet-line" key={d.id}>
                <span className="setup-sheet-what">
                  <span className="setup-sheet-name">{d.title}</span>
                  <span className="setup-sheet-tier">{d.status === "missing" ? "Needed" : "Needed · next step"}</span>
                </span>
                {line ? (
                  <span className="setup-sheet-cmd">
                    <code title={line}>{line}</code>
                    <button type="button" className="setup-btn setup-btn-xs" onClick={() => onCopy(line)}>
                      <Copy /> Copy
                    </button>
                  </span>
                ) : (
                  <span className="setup-sheet-note">{d.detail ?? "This one has no one-line fix on every machine."}</span>
                )}
              </div>
            );
          })}
          {rows.length === 0 && <p className="setup-note">Nothing needed is missing.</p>}
          <p className="setup-hint">
            Recommended and Optional are not part of this list: an install that runs what you did not ask
            for is the thing this screen exists to avoid.
          </p>
        </div>
        <div className="setup-sheet-foot">
          <button type="button" className="setup-btn setup-btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

async function copy(line: string, said: (s: string) => void) {
  try { await navigator.clipboard.writeText(line); said("Copied. Paste it into a terminal, then press Recheck."); }
  catch { said("Could not copy it. Select the line and copy it by hand."); }
}

function Copy() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="5" width="8.4" height="8.4" rx="1.4" />
      <path d="M10.6 3.2H3.8a1.2 1.2 0 0 0-1.2 1.2v6.8" />
    </svg>
  );
}

function Spark() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.8v3.4M8 10.8v3.4M1.8 8h3.4M10.8 8h3.4M3.7 3.7l2.4 2.4M9.9 9.9l2.4 2.4M12.3 3.7 9.9 6.1M6.1 9.9l-2.4 2.4" />
    </svg>
  );
}
