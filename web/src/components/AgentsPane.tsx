import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { fmtAgo } from "../lib/format.ts";
import type { AgentProbe } from "../../../shared/types.ts";

/**
 * The agents already on this machine, and one button each.
 *
 * Connecting a second agent is where people stop. The hooks ship in the app,
 * but somebody still has to know which harness they have, which config file it
 * reads and what to put in it — and the docs explaining that are a correct
 * paragraph, which is less convincing than a working install.
 *
 * The ones that are not installed stay in the list. Hiding them makes the list
 * an inventory of this machine, when the question somebody actually has is
 * *what is supported* — worth answering before they decide to try a second
 * agent at all.
 */

/** Four states, in the order somebody moves through them. */
type State = "live" | "waiting" | "ready" | "missing";

const stateOf = (p: AgentProbe): State =>
  p.seenAt ? "live" : p.connected ? "waiting" : p.found ? "ready" : "missing";

export function AgentsPane({ open }: { open: boolean }) {
  const [agents, setAgents] = useState<AgentProbe[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; bad: boolean } | null>(null);

  const load = useCallback(() => {
    api.agents().then((r) => setAgents(r.agents)).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    // Polled, because the state this pane exists to show is one that changes
    // without anybody pressing anything: the moment the first event from a
    // newly wired agent arrives, "waiting" becomes "live".
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [open, load]);

  const connect = async (p: AgentProbe, undo: boolean) => {
    setBusy(p.id);
    setNote(null);
    const r = await api.agentConnect(p.id, undo).catch(() => null);
    setBusy(null);
    if (r?.agents) setAgents(r.agents);
    // The script's own words when it has some. It knows things this pane does
    // not — that the config already pointed here, or that the user has an
    // `[otel]` block of their own it will not touch.
    const text = r?.detail || r?.error || (r?.ok ? "" : "Could not write the config.");
    if (text) setNote({ id: p.id, text, bad: !r?.ok });
    load();
  };

  if (!agents) return <div className="text-[11px] t-dim2">Looking for agents…</div>;

  return (
    <div className="flex flex-col gap-1.5">
      {agents.map((p) => {
        const state = stateOf(p);
        const tint = state === "live" ? "var(--success)"
          : state === "waiting" ? "var(--warning)"
          : state === "ready" ? "var(--primary-hover)" : "var(--text4)";
        return (
          <div key={p.id} className="flex flex-col gap-1 px-2.5 py-2 rounded-lg" style={{
            background: state === "missing" ? "transparent" : "color-mix(in srgb, var(--bg2) 60%, transparent)",
            border: `1px solid color-mix(in srgb, ${state === "live" ? "var(--success)" : "var(--border)"} ${state === "live" ? 30 : 40}%, transparent)`,
            opacity: state === "missing" ? 0.72 : 1,
          }}>
            <div className="flex items-center gap-2.5">
              <span className="shrink-0 rounded-full" aria-hidden style={{
                width: 7, height: 7,
                background: state === "live" ? "var(--success)" : "transparent",
                border: state === "live" ? "none" : `1px solid ${tint}`,
              }} />
              <div className="min-w-0 flex-1">
                <div className="text-[12px]" style={{ color: "var(--text)" }}>{p.label}</div>
                <div className="text-[10px]" style={{ color: state === "missing" ? "var(--text4)" : tint }}>
                  {state === "live" && `Reporting · last event ${fmtAgo(p.seenAt!)}`}
                  {/* The state this pane exists for. A written config and an
                      arrived event are different facts, and this is the gap
                      somebody otherwise sits in wondering what they did wrong. */}
                  {state === "waiting" && "Wired, but nothing has arrived yet — start a new session for it to take effect"}
                  {state === "ready" && `Installed, not connected · ${p.connects}`}
                  {state === "missing" && `Not on this machine · ${p.install}`}
                </div>
              </div>

              {state === "missing" ? (
                <span className="chip shrink-0 t-dim2">not found</span>
              ) : (
                <button onClick={() => void connect(p, p.connected)} disabled={busy === p.id}
                  title={p.connected
                    ? `Remove the agentglass wiring from ${p.configPath}. The file is backed up first.`
                    : `Write the agentglass wiring into ${p.configPath}. The file is backed up first, and a config we cannot parse is left alone.`}
                  className="shrink-0 text-[10.5px] px-2.5 py-1 rounded-md hover:opacity-80"
                  style={p.connected
                    ? { color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }
                    : { color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 42%, transparent)" }}>
                  {busy === p.id ? "…" : p.connected ? "Disconnect" : "Connect"}
                </button>
              )}
            </div>

            {/* Where the change lands, named rather than implied. It is a file
                in somebody's home directory. */}
            {state !== "missing" && (
              <div className="text-[9.5px] t-dim2 t-mono truncate pl-[17px]">{p.configPath}</div>
            )}
            {note?.id === p.id && (
              <div className="text-[10px] pl-[17px] whitespace-pre-wrap"
                style={{ color: note.bad ? "var(--error)" : "var(--text3)" }}>{note.text}</div>
            )}
          </div>
        );
      })}

      <div className="text-[10px] t-dim2">
        Connected means an event has actually arrived, not that a file was written — every failure here
        looks like a successful write. Each config is backed up before it is touched, and one this app
        cannot parse is left alone.
      </div>
    </div>
  );
}
