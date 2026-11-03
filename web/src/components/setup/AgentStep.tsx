/*
 * Step 1: the agent this machine starts.
 *
 * Five tiles from one `/engines` report. Picking writes `setup.agent` at once
 * (the pick is the app's default agent), so a reload keeps it; Continue alone
 * writes nothing. A report that could not be read keeps the tiles and says so
 * instead of drawing states it does not know.
 */
import type { EnginesReport } from "../../../../shared/types.ts";
import { useState } from "react";
import { ICON } from "../../lib/iconSize.ts";
import { agentTiles, detectedLine, installLine, noneInstalled, type AgentMark } from "../../lib/setupAgents.ts";
import type { AgentTile } from "../../lib/setupAgents.ts";
import { Tile } from "./Tile.tsx";
import { DisplayLine } from "./SetupNotices.tsx";

function Mark({ kind }: { kind: AgentMark }) {
  const paths: Record<AgentMark, string> = {
    spark: "M8 1.6c.5 3.2 2 4.7 5.2 5.2-3.2.5-4.7 2-5.2 5.2-.5-3.2-2-4.7-5.2-5.2C6 6.3 7.5 4.8 8 1.6Z",
    term: "M2.4 4.4 6 8l-3.6 3.6M8 11.6h5.6",
    agent: "M3.4 3.4h9.2v9.2H3.4zM6.2 6.8v2.4M9.8 6.8v2.4",
    star: "M8 2.2 9.7 6l4.1.4-3.1 2.7.9 4-3.6-2.2-3.6 2.2.9-4L2.2 6.4 6.3 6 8 2.2Z",
    bolt: "M9 1.8 3.6 9h3.8l-.4 5.2L12.4 7H8.6l.4-5.2Z",
  };
  return (
    <svg width={ICON.xl} height={ICON.xl} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[kind]} />
    </svg>
  );
}

const Hue: Record<string, string> = { claude: "#bc4c00", opencode: "#0969da", codex: "#1a7f37", gemini: "#8250df", hermes: "#bf3989" };

export function AgentStep({ report, error, picked, busy, display, onPick, onRecheck }: {
  report: EnginesReport | null;
  error: boolean;
  picked: string;
  busy: boolean;
  /** Which display the window is drawn through, from the shell. */
  display: "wayland" | "x11" | null;
  onPick: (id: string) => void;
  onRecheck: () => void;
}) {
  const [cmd, setCmd] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const tiles: AgentTile[] = agentTiles(report, picked);
  const waiting = !report && !error;
  const none = report !== null && noneInstalled(tiles);
  return (
    <>
      <div className="setup-eyebrow">Welcome</div>
      <h1 className="setup-h1">Let's get this machine ready</h1>
      <p className="setup-lede">
        Five short steps: pick the agent you reach for, choose a theme, check what this machine has,
        bring in your repositories, and open a terminal. Every step is optional and every choice is in
        Settings afterwards.
      </p>

      <div className="setup-group">
        <div className="setup-group-head">
          <span className="setup-group-title">Your agent</span>
          <span className="setup-group-why">· {error ? "this machine could not be read" : waiting ? "reading this machine's agents" : detectedLine(tiles)}</span>
        </div>
        {error && (
          <p className="setup-note">
            Could not read this machine's agents.{" "}
            <button type="button" className="setup-link" onClick={onRecheck} disabled={busy}>Recheck</button>
          </p>
        )}
        {!error && none && (
          <p className="setup-note">
            None of these is installed yet. Install one and press{" "}
            <button type="button" className="setup-link" onClick={onRecheck} disabled={busy}>Recheck</button>
            , or carry on — the terminal opens a shell until one is.
          </p>
        )}
        <div className="setup-tiles" role="group" aria-label="Your agent">
          {tiles.map((t) => (
            <Tile
              key={t.id}
              id={`setup-agent-${t.id}`}
              mark={<span className="setup-mark" style={{ ["--setup-hue" as string]: Hue[t.id] ?? "var(--text3)" }}><Mark kind={t.mark} /></span>}
              name={t.title}
              what={t.what}
              state={t.state}
              tone={t.tone}
              selected={t.picked}
              onPick={() => onPick(t.id)}
              action={report !== null && t.installable && installLine(t.id)
                ? <button type="button" className="setup-btn setup-btn-xs" onClick={() => { setCmd(installLine(t.id)); setSaid(""); }}>Install</button>
                : undefined}
            />
          ))}
        </div>
        {cmd && (
          <div className="setup-cmd">
            <code title={cmd}>{cmd}</code>
            <button type="button" className="setup-btn setup-btn-xs" onClick={() => void copy(cmd, setSaid)}>Copy</button>
          </div>
        )}
        {cmd && <p className="setup-hint">{said || "Paste it into a terminal, then press Recheck."}</p>}
      </div>
      <DisplayLine server={display} />
      <p className="setup-hint">
        agentglass runs the CLI you already have rather than bundling one. A second agent can be added
        later in Settings › Agent engines; the one you pick here is simply the default.
      </p>
    </>
  );
}

async function copy(line: string, said: (s: string) => void) {
  try { await navigator.clipboard.writeText(line); said("Copied. Paste it into a terminal, then press Recheck."); }
  catch { said("Could not copy it. Select the line and copy it by hand."); }
}
