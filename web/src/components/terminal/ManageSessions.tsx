/*
 * Manage tmux sessions: every session with what is in it, and the three things
 * you can do to one besides go there.
 *
 * Lock keeps it from being ended (by name, so a lock survives the session being
 * recreated). End asks in the row, in words: it takes everything running in it
 * and there is no undo. "Clean up" ends the sessions that hold one window with
 * nothing in it, after the same question. Window names come from the pane list
 * the server already answers, read when the dialog opens and again whenever the
 * strip reports a window opening, closing or changing state; nothing polls.
 *
 * The age is the time tmux made the session (the frame carries it). The server
 * has no command that creates a session, so "New" is shown off with the reason
 * rather than a button that does nothing: the ceiling of this dialog.
 */
import { useEffect, useMemo, useState } from "react";
import type { AgentPane } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { NO_DRAG } from "../../lib/dragRegion.ts";
import { useModalDialog } from "../../lib/focusTrap.ts";
import { LockIcon, PlusIcon, PowerIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { LAYER } from "../../lib/layers.ts";
import { subscribe as onWindowsChanged } from "../../lib/liveWindow.ts";
import { canEnd, cleanupSentence, cleanupTargets, endBlockedWhy, endSentence, namesText, sessionAge, windowsBySession } from "../../lib/sessionsManage.ts";
import { CloseButton } from "../CloseButton.tsx";
import { Portal } from "../Portal.tsx";
import { Button, EDGE, LINE, Badge } from "../workspace/Chrome.tsx";
import type { SessionInfo } from "./SessionSwitcher.tsx";

type Asking = { kind: "end"; name: string } | { kind: "cleanup" } | null;

export function ManageSessions({ sessions, current, engine, prefix, needsYou, onEnd, onLock, onClose }: {
  sessions: readonly SessionInfo[];
  current: string;
  /** Whose tmux this is, and the key it listens to: the header says both. */
  engine: boolean;
  prefix: readonly string[];
  /** Windows in the current session that wait on the person. */
  needsYou: number;
  onEnd: (name: string) => void;
  onLock: (name: string, after: boolean) => void;
  onClose: () => void;
}) {
  const modal = useModalDialog(true, "Manage tmux sessions");
  const [panes, setPanes] = useState<AgentPane[]>([]);
  const [asking, setAsking] = useState<Asking>(null);

  useEffect(() => {
    let live = true;
    const read = () => { void api.agentPanes().then((r) => { if (live && r.ok) setPanes(r.panes); }).catch(() => {}); };
    read();
    const off = onWindowsChanged(read);
    return () => { live = false; off(); };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); e.preventDefault();
      if (asking) setAsking(null); else onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [asking, onClose]);

  const by = useMemo(() => windowsBySession(panes), [panes]);
  const namesOf = (name: string) => (by.get(name) ?? []).map((w) => w.name);
  const targets = cleanupTargets(sessions, current, by);
  const now = Date.now();

  return (
    <Portal z={LAYER.termDialog}>
      <div className="fixed inset-0 agx-scrim" style={NO_DRAG} onClick={onClose} />
      <div {...modal} className="fixed left-1/2 top-[14vh] -translate-x-1/2 flex flex-col rounded-xl overflow-hidden outline-none"
        style={{ ...NO_DRAG, width: 620, maxWidth: "calc(100vw - 32px)", maxHeight: "72vh", background: "var(--bg)", border: EDGE, boxShadow: "0 24px 60px -18px color-mix(in srgb, #000 60%, transparent)" }}>
        <div className="flex items-center gap-2 pl-4 pr-2 shrink-0" style={{ height: 48, borderBottom: LINE }}>
          <h2 className="m-0 text-[13px] font-semibold" style={{ color: "var(--text)" }}>tmux sessions</h2>
          <span className="text-[11px] tabular-nums truncate" style={{ color: "var(--text3)" }}>
            {sessions.length} · {engine ? "agentglass tmux" : "Your tmux"}{prefix.length ? ` · prefix ${prefix.join(" or ")}` : ""}
          </span>
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            <Button size="compact" tone="plain" disabled={targets.length === 0}
              title={targets.length ? `End ${targets.map((t) => t.name).join(", ")}` : "No session holds a single idle window"}
              onClick={() => setAsking({ kind: "cleanup" })}>
              Clean up{targets.length ? ` ${targets.length}` : ""}
            </Button>
            <Button size="compact" tone="plain" disabled title="Creating a session needs a server command that does not exist yet. Until then, tmux new-session -d -s <name> from any shell does it.">
              <PlusIcon size={ICON.xs} />New
            </Button>
            <CloseButton onClick={onClose} title="Close" />
          </span>
        </div>

        {asking?.kind === "cleanup" && (
          <div role="alert" className="shrink-0 flex items-center gap-2 flex-wrap text-[11.5px] mx-3 mt-2 px-3 py-2 rounded-lg"
            style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--error) 8%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--error) 30%, transparent)" }}>
            <span className="min-w-0 flex-1">{cleanupSentence(targets)}</span>
            <Button size="compact" tone="danger" onClick={() => { setAsking(null); for (const t of targets) onEnd(t.name); }}>End {targets.length === 1 ? targets[0]!.name : `${targets.length} sessions`}</Button>
            <Button size="compact" tone="plain" onClick={() => setAsking(null)}>Keep them</Button>
          </div>
        )}

        <div className="overflow-y-auto agx-scroll p-1.5 flex flex-col min-h-0">
          {sessions.map((s) => {
            const here = s.name === current;
            const names = namesOf(s.name);
            const why = endBlockedWhy(s, current);
            const confirming = asking?.kind === "end" && asking.name === s.name;
            const age = sessionAge(s.created, now);
            return (
              <div key={s.id}>
                <div className="grid items-center gap-2 rounded-lg px-1.5 py-1.5"
                  style={{ gridTemplateColumns: "18px 1fr auto 54px 26px 26px", background: here ? "color-mix(in srgb, var(--primary) 6%, transparent)" : undefined }}>
                  <span className="flex justify-center">{here && <span aria-hidden className="rounded-full" style={{ width: 7, height: 7, background: "var(--primary)" }} />}</span>
                  <span className="min-w-0 flex flex-col gap-px">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate text-[12px] font-semibold" style={{ color: "var(--text)" }}>{s.name}</span>
                      {here && <span className="uppercase"><Badge tint="var(--text3)" tight>here</Badge></span>}
                    </span>
                    {names.length > 0 && <span className="text-[10.5px] truncate" style={{ color: "var(--text3)" }} title={names.map((n) => n || "shell").join(", ")}>{namesText(names)}</span>}
                  </span>
                  <span className="text-right text-[11px] tabular-nums flex flex-col" style={{ color: "var(--text2)" }}>
                    {s.windows === 1 ? "1 window" : `${s.windows} windows`}
                    {here && needsYou > 0 && <span className="text-[10.5px] font-semibold" style={{ color: "var(--warning-ink)" }}>{needsYou} need{needsYou === 1 ? "s" : ""} you</span>}
                  </span>
                  <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{age}</span>
                  <Button size="compact" tone="quiet" square label={s.locked ? `Unlock ${s.name}` : `Lock ${s.name} so it cannot be ended`}
                    title={s.locked ? `${s.name} is protected. Click to allow ending it.` : `Protect ${s.name} from being ended`}
                    style={{ color: s.locked ? "var(--text)" : "var(--text4)", background: s.locked ? "var(--surface-inset)" : undefined }}
                    onClick={() => { setAsking(null); onLock(s.name, s.locked === true); }}>
                    <LockIcon size={ICON.xs} open={!s.locked} />
                  </Button>
                  <Button size="compact" tone="quiet" square label={`End ${s.name}`} disabled={!canEnd(s, current)} title={why ?? `End ${s.name} and everything running in it`}
                    style={{ color: canEnd(s, current) ? "var(--error)" : undefined }}
                    onClick={() => setAsking({ kind: "end", name: s.name })}>
                    <PowerIcon size={ICON.xs} />
                  </Button>
                </div>
                {confirming && (
                  <div role="alert" className="flex items-center gap-2 flex-wrap text-[11.5px] mx-1.5 mb-1 px-3 py-2 rounded-lg"
                    style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--error) 8%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--error) 30%, transparent)" }}>
                    <span className="min-w-0 flex-1">{endSentence(s.name, s.windows, names)}</span>
                    <Button size="compact" tone="danger" onClick={() => { setAsking(null); onEnd(s.name); }}>End session</Button>
                    <Button size="compact" tone="plain" onClick={() => setAsking(null)}>Keep it</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="shrink-0 flex items-center gap-2 px-4 py-2 text-[10.5px]" style={{ borderTop: LINE, color: "var(--text3)" }}>
          <span className="min-w-0">Locked sessions cannot be ended. New sessions made by tools show up here.</span>
          <kbd className="ml-auto shrink-0 px-1 rounded" style={{ background: "var(--surface-inset)" }}>Esc</kbd>
        </div>
      </div>
    </Portal>
  );
}
