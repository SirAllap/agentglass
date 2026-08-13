/*
 * "There is a new version", where somebody will actually see it.
 *
 * The update path has worked for a while and nothing ever knocked on the door:
 * the only signal was a dot on the settings gear, which means a release could
 * sit published for weeks unless you happened to open that pane. A working
 * update path nobody is told about is not a working update path.
 *
 * Two states in one card, because they are one errand: the offer, and then the
 * progress of taking it. Bottom right, out of the way of everything, and
 * dismissable per version — told about v0.8.0, you do not need telling again
 * until v0.8.1.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api.ts";
import { subscribeUpdate, updateState, updateAvailable } from "../lib/updateStore.ts";
import { readProgress, fraction, elapsed, PHASES, CLOSES_AT, type Progress } from "../lib/updateProgress.ts";
import { ReleaseNotesModal } from "./ReleaseNotesModal.tsx";
import { CloseButton } from "./CloseButton.tsx";

/** Dismissed for this version only. A later release is a different piece of
 *  news and gets to knock again. */
const HIDDEN_KEY = "agentglass.update.dismissed";
/** Long enough that the app is up and whoever opened it has done the thing they
 *  opened it for. A card that lands on top of the first keystroke is a card
 *  that gets closed unread. */
const APPEAR_AFTER_MS = 20_000;
/** The log is a file on disk being appended to; a second is plenty. */
const POLL_MS = 1_000;

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

export function UpdateToast() {
  const st = useSyncExternalStore(subscribeUpdate, updateState, () => null);
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState<string>(() => {
    try { return localStorage.getItem(HIDDEN_KEY) || ""; } catch { return ""; }
  });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState(false);
  const [notesText, setNotesText] = useState<{ text: string; error?: string } | null>(null);
  const startedAt = useRef(0);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setReady(true), APPEAR_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  /* While it runs, read the log the script is writing. Not a websocket and not
     a second channel: the thing doing the work is the thing being read. */
  useEffect(() => {
    if (!running) return;
    const tick = async () => {
      try {
        const r = await api.updateLog();
        const p = readProgress(r.text ?? "");
        setProgress(p);
        if (p.failed) { setError("The update did not finish"); setRunning(false); }
      } catch {
        /* The server going away IS the update working — it stops the app to
           install. Nothing to report; the window is about to close. */
      }
      setNow(Date.now());
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, [running]);

  const start = useCallback(async () => {
    setError(null);
    startedAt.current = Date.now();
    const r = await api.updateRun().catch(() => ({ ok: false, error: "Could not reach the server" }));
    if (!r.ok) { setError(r.error || "Could not start the update"); return; }
    setRunning(true);
  }, []);

  const hide = () => {
    const tag = st?.branch ?? "";
    setDismissed(tag);
    try { localStorage.setItem(HIDDEN_KEY, tag); } catch { /* private mode */ }
  };

  const available = updateAvailable();
  // While it is running the card stays regardless: an update in flight is not
  // something to be quietly hidden by a status refresh.
  if (!running && (!ready || !available || !st || dismissed === st.branch)) return null;

  const p = progress;
  const closing = !!p && p.reached > CLOSES_AT;

  return (
    <>
      <div className="fixed rounded-xl text-left"
        style={{
          right: 16, bottom: 16, width: 320, zIndex: 60,
          background: "var(--bg2)", border: edge(14), boxShadow: "0 12px 34px #000a",
          padding: "12px 14px",
        }}
        role="status" aria-live="polite">
        {!running && st ? (
          <>
            <CloseButton onClick={hide} title="Dismiss" hit={22} style={{ top: 8, right: 9, color: "var(--text4)" }} className="absolute rounded" />
            <div className="text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>A new version is out</div>
            <div className="text-[11.5px] mt-1.5" style={{ color: "var(--text3)" }}>
              {st.branch}
              {st.behind > 1 ? ` · ${st.behind} releases newer than yours` : ""}
            </div>
            <button onClick={() => {
                setNotes(true);
                if (!notesText) {
                  void api.updateNotes(st.branch)
                    .then((r) => setNotesText({ text: r.notes ?? "", error: r.error }))
                    .catch(() => setNotesText({ text: "", error: "Could not read the notes" }));
                }
              }}
              className="text-[11px] mt-1.5 underline" style={{ color: "var(--primary)" }}>
              See what changes
            </button>
            {/* Orca can promise your sessions survive because it swaps a
                downloaded binary. This compiles here and its own script says
                "this stops the running app", so the card says that instead —
                twice, and the second time is while it is happening. */}
            <div className="text-[10.5px] mt-2" style={{ color: "var(--warning)" }}>
              Built on this machine. The window will close and come back on its own.
            </div>
            {error && <div className="text-[10.5px] mt-1.5" style={{ color: "var(--error)" }}>{error}</div>}
            <button onClick={() => void start()}
              className="block w-full text-center text-[11.5px] mt-2.5 py-1.5 rounded-lg font-medium"
              style={{ background: "color-mix(in srgb, var(--primary) 18%, transparent)",
                border: "1px solid color-mix(in srgb, var(--primary) 48%, transparent)", color: "var(--text)" }}>
              Update
            </button>
          </>
        ) : (
          <>
            <div className="text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>
              Updating to {st?.branch ?? "the new version"}
            </div>
            <div className="flex flex-col gap-1 mt-2">
              {PHASES.map((ph, i) => {
                const state = !p ? "wait" : i < p.reached - 1 ? "done" : i === p.reached - 1 ? "now" : "wait";
                return (
                  <div key={ph.id} className="flex items-center gap-2 text-[11px]"
                    style={{ color: state === "now" ? "var(--text2)" : state === "done" ? "var(--text3)" : "var(--text4)" }}>
                    <span aria-hidden style={{
                      width: 6, height: 6, borderRadius: 999, flexShrink: 0,
                      background: state === "done" ? "var(--success)" : state === "now" ? "var(--primary)" : "var(--bg4)",
                      animation: state === "now" ? "agxPulse 1.1s ease-in-out infinite" : undefined,
                    }} />
                    {ph.label}
                    {i === 0 && p?.firstTime && (
                      <span className="text-[9.5px]" style={{ color: "var(--text4)" }}>· first time, slower</span>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ height: 4, borderRadius: 999, background: "color-mix(in srgb, var(--text) 8%, transparent)", marginTop: 10, overflow: "hidden" }}>
              <span style={{
                display: "block", height: "100%", borderRadius: 999, background: "var(--primary)",
                width: `${Math.round(fraction(p ?? readProgress("")) * 100)}%`,
                transition: "width 400ms ease",
              }} />
            </div>
            <div className="flex justify-between text-[10px] mt-1" style={{ color: "var(--text4)" }}>
              <span>{p?.reached ? `step ${Math.min(p.reached, PHASES.length)} of ${PHASES.length}` : "starting"}</span>
              <span className="tabular-nums">{elapsed(now - startedAt.current)}</span>
            </div>
            <div className="text-[10.5px] mt-2" style={{ color: closing ? "var(--warning)" : "var(--text4)" }}>
              {closing
                ? "Closing now to install. It comes back on its own."
                : "The window will close at the building step."}
            </div>
            {error && (
              <div className="mt-2">
                <div className="text-[10.5px]" style={{ color: "var(--error)" }}>{error}</div>
                {p?.tail && (
                  <pre className="mt-1 text-[10px] whitespace-pre-wrap break-all m-0 max-h-[90px] overflow-y-auto agx-scroll"
                    style={{ color: "var(--text4)" }}>{p.tail}</pre>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <ReleaseNotesModal open={notes} tag={st?.branch ?? ""} title="What's in this update"
        notes={notesText?.text ?? ""} loading={notes && !notesText} error={notesText?.error}
        onClose={() => setNotes(false)} />
    </>
  );
}
