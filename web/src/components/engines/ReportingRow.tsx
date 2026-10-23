import { SettingRow } from "../SettingRow.tsx";
import { StatusBadge } from "../SettingsKit.tsx";
import { fmtAgo } from "../../lib/format.ts";
import type { AgentProbe } from "../../../../shared/types.ts";
import { Button } from "../workspace/Chrome.tsx";
import { REPORT_BADGE, type ReportState } from "./enginesCopy.ts";

/**
 * Whether an engine is reporting to this app, and the one button to wire it.
 *
 * Connecting a second agent is where people stop. The hooks ship in the app,
 * but somebody still has to know which harness they have, which config file it
 * reads and what to put in it. The distinction this row exists for: a config
 * that was written and an event that arrived are different facts, and every
 * failure in this area looks like the first. A tick over a file that changed
 * nothing stops the search, which is worse than no tick at all.
 *
 * It lived in Settings › Agents as a list of its own. It is a row of each
 * engine's card now, so what an engine can do and whether it reports are read
 * in one place. Nothing polls it: the page loads on open and on Recheck, so
 * "waiting" turns into "reporting" the next time somebody looks.
 */

/** Four states, in the order somebody moves through them. */
const stateOf = (p: AgentProbe): ReportState =>
  p.seenAt ? "live" : p.connected ? "waiting" : p.found ? "ready" : "missing";

export function ReportingRow({ p, busy, note, onConnect }: {
  p: AgentProbe;
  busy: boolean;
  note: { text: string; bad: boolean } | null;
  onConnect: (p: AgentProbe, undo: boolean) => void;
}) {
  const state = stateOf(p);
  const badge = REPORT_BADGE[state];
  return (
    <SettingRow disabled={state === "missing"}
      label="Reporting to agentglass"
      hint={<>
        <span className="block">
          {state === "live" && `Last event ${fmtAgo(p.seenAt!)}`}
          {/* The state this row exists for. Almost always the answer is that the
              session predates the change. */}
          {state === "waiting" && "Wired, but nothing has arrived yet — start a new session for it to take effect"}
          {state === "ready" && `Installed, not connected · ${p.connects}`}
          {state === "missing" && `Not on this machine · ${p.install}`}
        </span>
        {/* Where the change lands, named rather than implied. It is a file in
            somebody's home directory, and shown whole. */}
        {state !== "missing" && <span className="block t-mono break-all mt-1.5">{p.configPath}</span>}
        {note && (
          <span className="block whitespace-pre-wrap mt-1.5"
            style={{ color: note.bad ? "var(--error-ink)" : "var(--text3)" }}>{note.text}</span>
        )}
      </>}
      detail={{
        summary: "What “connected” means here",
        body: "An event has actually arrived — not that a file was written. Every failure in this list looks like a successful write, which is why the state comes from traffic rather than from the config. Each config is backed up before it is touched, and one this app cannot parse is left alone.",
      }}
      status={<StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>}
      actions={state === "missing" ? undefined : (
        <Button onClick={() => onConnect(p, p.connected)} disabled={busy}
          title={p.connected
            ? `Remove the agentglass wiring from ${p.configPath}. The file is backed up first.`
            : `Write the agentglass wiring into ${p.configPath}. The file is backed up first, and a config we cannot parse is left alone.`}>
          {busy ? "…" : p.connected ? "Disconnect" : "Connect"}
        </Button>
      )} />
  );
}
