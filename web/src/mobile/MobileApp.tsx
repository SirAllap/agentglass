import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { useStats } from "../lib/useStats.ts";
import { fmtUsd, fmtTokens, fmtAgo, sessionTitle, modelLabelOf } from "../lib/format.ts";
import { MobileChats } from "./MobileChats.tsx";
import type { PendingGate, SessionRollup } from "../../../shared/types.ts";

/**
 * agentglass on a phone.
 *
 * Deliberately a different application, not a reflow of the cockpit. The
 * desktop UI is six workspace views around a real terminal, hunk-level staging
 * and a docker table — none of which anyone wants to drive with a thumb, and
 * the terminal in particular is unusable there however it is styled. Shrinking
 * it produces something that technically renders and practically cannot be
 * used, which is worse than saying no.
 *
 * So this is the part of agentglass that is genuinely better from the sofa:
 *
 *   Needs you — approve or deny what an agent is blocked on. The one thing
 *               that is time-critical and takes one tap.
 *   Chats     — read what an agent has been doing, reply to it, take over a
 *               session started at the desk, or start a new one. Monitoring
 *               without this is only half a companion: seeing that an agent
 *               stopped and being unable to say "carry on" is the same as not
 *               knowing.
 *   Fleet     — is it running, is it burning money, is anything failing.
 *
 * Everything else is absent rather than broken, and there is deliberately no
 * way back to the desktop layout from here: it does not work on this screen,
 * so offering it would only be a route to a worse version of the same thing.
 *
 * Nothing heavy mounts here: no xterm, no charts, no radar. On a phone that is
 * a battery decision as much as a layout one.
 */

type Tab = "gates" | "chats" | "fleet";

const WINDOWS: { label: string; ms: number }[] = [
  { label: "1h", ms: 3_600_000 },
  { label: "24h", ms: 86_400_000 },
  { label: "7d", ms: 7 * 86_400_000 },
];

export function MobileApp() {
  const [tab, setTab] = useState<Tab>("gates");
  const [windowMs, setWindowMs] = useState(WINDOWS[1]!.ms);
  const { stats } = useStats(windowMs);
  const [sessions, setSessions] = useState<SessionRollup[]>([]);
  const [gates, setGates] = useState<PendingGate[]>([]);
  const [reachable, setReachable] = useState(true);

  // Polled rather than streamed. The live socket exists and works, but a phone
  // spends most of its life with the screen off, and a reconnecting socket in
  // the background is a worse deal than two small requests when you look at it.
  const load = useCallback(() => {
    api.gatePending()
      .then((r) => { setGates(r.gates); setReachable(true); })
      .catch(() => setReachable(false));
    api.sessions(40).then(setSessions).catch(() => { /* the gate poll reports reachability */ });
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    // Catching up the moment the screen comes back is what makes a poll feel
    // live: a phone returning from sleep would otherwise show the last frame it
    // painted before it slept.
    const wake = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", wake);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", wake); };
  }, [load]);

  const live = useMemo(
    () => sessions.filter((s) => !s.ended_at && Date.now() - s.last_seen < 120_000),
    [sessions]
  );

  return (
    <div className="min-h-[100dvh] flex flex-col" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <header className="sticky top-0 z-10 px-4 pt-3 pb-2 flex items-center gap-2"
        style={{ background: "color-mix(in srgb, var(--bg) 92%, transparent)", backdropFilter: "blur(8px)", borderBottom: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
        <span className="text-[17px] font-semibold tracking-tight">
          agent<span style={{ color: "var(--primary-hover)" }}>glass</span>
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[11px]" style={{ color: reachable ? "var(--success)" : "var(--error)" }}>
          <span className="inline-block rounded-full" style={{ width: 7, height: 7, background: "currentColor" }} />
          {reachable ? "Live" : "Offline"}
        </span>
      </header>

      <main className="flex-1 px-4 pb-24 pt-3">
        {tab === "gates" && <GatesTab gates={gates} onDecided={(id) => setGates((g) => g.filter((x) => x.id !== id))} />}
        {tab === "fleet" && (
          <FleetTab
            stats={stats}
            live={live.length}
            windowMs={windowMs}
            onWindow={setWindowMs}
            sessions={live}
          />
        )}
        {tab === "chats" && <MobileChats sessions={sessions} onRefresh={load} />}
      </main>

      {/* Fixed, thumb-height, and out of the way of the home indicator. */}
      <nav className="fixed bottom-0 left-0 right-0 flex z-20"
        style={{ background: "color-mix(in srgb, var(--bg2) 94%, transparent)", backdropFilter: "blur(10px)", borderTop: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", paddingBottom: "env(safe-area-inset-bottom)" }}>
        <TabButton id="gates" tab={tab} onPick={setTab} label="Needs you" badge={gates.length} />
        <TabButton id="chats" tab={tab} onPick={setTab} label="Chats" badge={live.length} subtle />
        <TabButton id="fleet" tab={tab} onPick={setTab} label="Fleet" />
      </nav>
    </div>
  );
}

function TabButton({ id, tab, onPick, label, badge, subtle }: {
  id: Tab; tab: Tab; onPick: (t: Tab) => void; label: string; badge?: number; subtle?: boolean;
}) {
  const on = tab === id;
  return (
    <button onClick={() => onPick(id)} aria-current={on}
      className="flex-1 flex flex-col items-center justify-center gap-0.5 py-3 text-[12px]"
      style={{ color: on ? "var(--primary-hover)" : "var(--text2)", minHeight: 56 }}>
      <span className="flex items-center gap-1.5">
        {label}
        {!!badge && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full tabular-nums" style={{
            color: subtle ? "var(--text2)" : "var(--bg)",
            background: subtle ? "color-mix(in srgb, var(--border) 60%, transparent)" : "var(--primary-hover)",
          }}>{badge}</span>
        )}
      </span>
      <span className="rounded-full" style={{ width: 18, height: 2, background: on ? "var(--primary-hover)" : "transparent" }} />
    </button>
  );
}

/** The reason to have this on a phone at all. */
function GatesTab({ gates, onDecided }: { gates: PendingGate[]; onDecided: (id: string) => void }) {
  if (!gates.length) {
    return (
      <Empty
        title="Nothing is waiting on you"
        body="When an agent asks permission to run something, it appears here and the fleet waits until you answer."
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {gates.map((g) => <GateCard key={g.id} gate={g} onDecided={onDecided} />)}
    </div>
  );
}

function GateCard({ gate, onDecided }: { gate: PendingGate; onDecided: (id: string) => void }) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [failed, setFailed] = useState(false);

  const decide = async (decision: "allow" | "deny") => {
    setBusy(decision);
    setFailed(false);
    try {
      await api.gateDecide(gate.id, decision);
      onDecided(gate.id);
    } catch {
      // An answer that did not arrive must not look like one that did: the
      // agent is still blocked, and saying otherwise is the worst outcome here.
      setFailed(true);
      setBusy(null);
    }
  };

  return (
    <section className="rounded-2xl p-4 flex flex-col gap-3" style={{
      background: "color-mix(in srgb, var(--bg2) 70%, transparent)",
      border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)",
    }}>
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-semibold">{gate.tool_name}</span>
        <span className="text-[11px] ml-auto" style={{ color: "var(--text2)" }}>{fmtAgo(gate.created)}</span>
      </div>
      <p className="text-[13px] leading-snug break-words" style={{ color: "var(--text)" }}>{gate.summary}</p>
      <div className="text-[11px] t-mono break-all" style={{ color: "var(--text3)" }}>{gate.source_app}</div>
      {failed && (
        <div className="text-[11.5px]" style={{ color: "var(--error)" }}>
          That did not reach the server. The agent is still waiting — try again.
        </div>
      )}
      {/* Big, far apart, and deny is not the one under your thumb by accident. */}
      <div className="flex gap-2.5 pt-0.5">
        <button onClick={() => decide("allow")} disabled={!!busy}
          className="flex-1 rounded-xl text-[15px] font-medium"
          style={{ minHeight: 52, color: "var(--success)", background: "color-mix(in srgb, var(--success) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 45%, transparent)", opacity: busy ? 0.6 : 1 }}>
          {busy === "allow" ? "Allowing…" : "Allow"}
        </button>
        <button onClick={() => decide("deny")} disabled={!!busy}
          className="flex-1 rounded-xl text-[15px] font-medium"
          style={{ minHeight: 52, color: "var(--error)", background: "color-mix(in srgb, var(--error) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)", opacity: busy ? 0.6 : 1 }}>
          {busy === "deny" ? "Denying…" : "Deny"}
        </button>
      </div>
    </section>
  );
}

function FleetTab({ stats, live, windowMs, onWindow, sessions }: {
  stats: ReturnType<typeof useStats>["stats"];
  live: number;
  windowMs: number;
  onWindow: (ms: number) => void;
  sessions: SessionRollup[];
}) {
  const t = stats?.totals;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1.5">
        {WINDOWS.map((w) => (
          <button key={w.label} onClick={() => onWindow(w.ms)}
            className="px-3 py-1.5 rounded-lg text-[12px]"
            style={{
              minHeight: 38,
              color: windowMs === w.ms ? "var(--primary-hover)" : "var(--text2)",
              background: windowMs === w.ms ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
              border: `1px solid color-mix(in srgb, var(--border) ${windowMs === w.ms ? 60 : 30}%, transparent)`,
            }}>
            {w.label}
          </button>
        ))}
      </div>

      <div className="rounded-2xl p-4" style={{ background: "color-mix(in srgb, var(--bg2) 65%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
        <div className="panel-eyebrow">Spend · this window</div>
        <div className="text-[34px] font-semibold tabular-nums leading-tight" style={{ color: "var(--success)" }}>
          {t ? fmtUsd(t.cost_usd) : "—"}
        </div>
        <div className="text-[11.5px]" style={{ color: "var(--text2)" }}>
          {t ? `${fmtTokens(t.input_tokens + t.output_tokens)} tokens · ${fmtTokens(t.cache_read_tokens)} cached` : "…"}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <Tile label="Working" value={String(live)} hint="Live agents" tone={live ? "var(--success)" : undefined} />
        <Tile label="Tools run" value={t ? String(t.tool_calls) : "—"} hint={t ? `${t.events} events` : ""} />
        <Tile label="Sessions" value={t ? String(t.sessions) : "—"} hint="In this window" />
        <Tile label="Failed" value={t ? String(t.errors) : "—"} hint="Tool errors" tone={t?.errors ? "var(--error)" : undefined} />
      </div>

      <div>
        <div className="panel-eyebrow px-1 pb-1.5">What the fleet is doing</div>
        {sessions.length ? (
          <div className="flex flex-col gap-2">{sessions.slice(0, 6).map((s) => <SessionRow key={s.session_id} s={s} />)}</div>
        ) : (
          <Empty title="Nothing running" body="No agent has reported in the last two minutes." compact />
        )}
      </div>

    </div>
  );
}

function SessionRow({ s, open, onToggle }: { s: SessionRollup; open?: boolean; onToggle?: () => void }) {
  const running = !s.ended_at && Date.now() - s.last_seen < 120_000;
  return (
    <button onClick={onToggle} disabled={!onToggle}
      className="w-full text-left rounded-xl px-3.5 py-3 flex flex-col gap-1.5"
      style={{ background: "color-mix(in srgb, var(--bg2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
      <div className="flex items-center gap-2">
        <span className="inline-block rounded-full shrink-0" style={{
          width: 8, height: 8,
          background: running ? "var(--success)" : s.error_count ? "var(--error)" : "var(--text3)",
        }} />
        <span className="text-[13.5px] leading-tight truncate">{sessionTitle(s)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums" style={{ color: "var(--text2)" }}>
        <span>{modelLabelOf(s.model_name)}</span>
        <span>{s.tool_count} tools</span>
        {!!s.error_count && <span style={{ color: "var(--error)" }}>{s.error_count} err</span>}
        <span>{fmtUsd(s.cost_usd)}</span>
        <span className="ml-auto">{fmtAgo(s.last_seen)}</span>
      </div>
      {open && (
        <div className="pt-1.5 mt-1 flex flex-col gap-1 text-[11.5px]" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", color: "var(--text2)" }}>
          <Line k="Project" v={s.project_path || s.source_app} mono />
          <Line k="Tokens" v={`${fmtTokens(s.input_tokens + s.output_tokens)} · ${fmtTokens(s.cache_read_tokens)} cached`} />
          <Line k="Events" v={String(s.event_count)} />
          <Line k="Started" v={fmtAgo(s.started_at)} />
        </div>
      )}
    </button>
  );
}

const Line = ({ k, v, mono }: { k: string; v: string; mono?: boolean }) => (
  <div className="flex gap-2">
    <span className="shrink-0" style={{ color: "var(--text3)" }}>{k}</span>
    <span className={`min-w-0 break-all text-right ml-auto ${mono ? "t-mono text-[10.5px]" : ""}`} style={{ color: "var(--text)" }}>{v}</span>
  </div>
);

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-xl px-3.5 py-3" style={{ background: "color-mix(in srgb, var(--bg2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
      <div className="panel-eyebrow">{label}</div>
      <div className="text-[26px] font-semibold tabular-nums leading-tight" style={{ color: tone ?? "var(--text)" }}>{value}</div>
      {hint && <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>{hint}</div>}
    </div>
  );
}

function Empty({ title, body, compact }: { title: string; body: string; compact?: boolean }) {
  return (
    <div className={`rounded-2xl text-center ${compact ? "px-4 py-6" : "px-5 py-12"}`}
      style={{ background: "color-mix(in srgb, var(--bg2) 45%, transparent)", border: "1px dashed color-mix(in srgb, var(--border) 45%, transparent)" }}>
      <div className="text-[14px]" style={{ color: "var(--text)" }}>{title}</div>
      <div className="text-[12px] mt-1.5 leading-snug" style={{ color: "var(--text2)" }}>{body}</div>
    </div>
  );
}
