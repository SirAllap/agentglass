/**
 * Every past agent session in this project, one press away.
 *
 * By hand it is four steps: open a tab, start the agent, type `/resume`, and
 * find the session in a list. The fourth is the one that cannot be fixed by
 * typing faster — the CLI's list is scoped to the directory the agent happens
 * to be running in, so a session from a worktree is simply not in the list you
 * get from the main checkout, and those are usually the ones being looked for.
 *
 * So this asks the server for the whole project's transcripts (every checkout,
 * see agentsessions.ts) and opens the chosen one where you say: a tab of its
 * own, or a split beside what you are already reading.
 *
 * Cards rather than lines, asked for in those words: a title is four words the
 * CLI guessed, and four words is not enough to tell two mornings apart. Each
 * card carries how the session started and where it got to, which between them
 * are what "was it this one" is actually answered by.
 *
 * A session that is ALREADY running is not one to resume — resuming it twice is
 * two agents appending to one transcript. Those cards are dimmed, say which
 * window they are in, and offer the trip instead of the launch.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { AgentSessionRow } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { ago } from "../lib/fileRecents.ts";
import { Portal } from "./Portal.tsx";
import { LAYER } from "../lib/layers.ts";
import { CHIP, CHIP_SURFACE, CHIP_SURFACE_CLS } from "./workspace/Chrome.tsx";
import { ICON } from "../lib/iconSize.ts";

const YOLO_KEY = "agentglass.resume.yolo";

/** Bytes as the CLI shows them — the one honest hint of how long a conversation
 *  is before opening it. */
function weight(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)}MB`;
  if (size >= 1024) return `${Math.round(size / 1024)}KB`;
  return `${size}B`;
}

/** The checkout's own name, which is what tells `orbit` from `orbit-CARD-1`. */
const where = (cwd: string) => cwd.split("/").filter(Boolean).pop() ?? cwd;

export function ResumeSessions({ root, disabled, onOpen, onGo }: {
  /** The project on screen. Its whole family of checkouts is searched. */
  root: string;
  disabled?: boolean;
  /** Start it: a window of its own, or a split beside what is on screen. */
  onOpen: (s: AgentSessionRow, how: { split: boolean; yolo: boolean }) => void;
  /** Take me to the pane it is already running in. */
  onGo: (at: NonNullable<AgentSessionRow["openIn"]>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AgentSessionRow[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [yolo, setYolo] = useState(() => {
    try { return localStorage.getItem(YOLO_KEY) === "1"; } catch { return false; }
  });
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; maxHeight: number }>(
    { top: 0, left: 0, maxHeight: 460 });

  const close = useCallback(() => { setOpen(false); setQ(""); }, []);

  /* Asked for when the menu opens, not on a timer: a transcript list is a
     directory read per checkout and this is a menu, not a live view. */
  useEffect(() => {
    if (!open || !root) return;
    let alive = true;
    setErr("");
    api.agentSessions(root)
      .then((r) => { if (alive) { setRows(r.sessions ?? []); if (!r.ok) setErr("could not read the sessions"); } })
      .catch(() => { if (alive) setErr("could not read the sessions"); });
    return () => { alive = false; };
  }, [open, root]);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    // The same rule every other menu in this app uses: up only when down does
    // not fit and up is roomier.
    const up = below < 240 && above > below;
    setPos({
      top: up ? undefined : r.bottom + 6,
      bottom: up ? window.innerHeight - r.top + 6 : undefined,
      left: Math.max(8, Math.min(r.left, window.innerWidth - 560)),
      maxHeight: Math.max(220, Math.min(560, up ? above : below)),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = rows ?? [];
    if (!needle) return all;
    return all.filter((s) => `${s.title} ${s.opening} ${s.last} ${where(s.cwd)}`.toLowerCase().includes(needle));
  }, [rows, q]);

  const setYoloKept = (v: boolean) => {
    setYolo(v);
    try { localStorage.setItem(YOLO_KEY, v ? "1" : "0"); } catch { /* private mode */ }
  };

  return (
    <>
      <button ref={btnRef} disabled={disabled || !root}
        onClick={() => (open ? close() : setOpen(true))}
        title="Resume a past agent session from this project — any of its checkouts"
        className={`${CHIP} ${CHIP_SURFACE_CLS} flex items-center gap-1.5 shrink-0 disabled:opacity-40`}
        style={CHIP_SURFACE}>
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" aria-hidden="true"
          stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" />
          <path d="M2.4 2.6v3h3" />
          <path d="M8 5.2V8l2 1.4" />
        </svg>
        <span>Sessions</span>
        <span style={{ color: "var(--text4)" }}>▾</span>
      </button>

      <Portal z={LAYER.menu}>
        <AnimatePresence>
          {open && (
            <>
              <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={close} />
              <motion.div
                initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="fixed rounded-xl overflow-hidden flex flex-col"
                style={{
                  ...(pos.bottom == null ? { top: pos.top } : { bottom: pos.bottom }),
                  left: pos.left, width: 540, maxHeight: pos.maxHeight, zIndex: 9999,
                  background: "color-mix(in srgb, var(--bg2) 97%, black)",
                  border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                  boxShadow: "0 24px 60px -18px rgba(0,0,0,0.7)",
                }}>
                <div className="p-2 flex items-center gap-2 shrink-0"
                  style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 10%, transparent)" }}>
                  <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
                    placeholder="Filter these sessions…"
                    className="flex-1 min-w-0 rounded-md px-2 py-1 text-[11px] outline-none"
                    style={{ background: "color-mix(in srgb, var(--text) 6%, transparent)", color: "var(--text)" }} />
                  {/* Remembered, and stated where the press happens: what a
                      resumed agent may do without asking is not something to
                      find out afterwards. */}
                  <label className="flex items-center gap-1.5 text-[10px] shrink-0 cursor-pointer"
                    title="Start it with --dangerously-skip-permissions"
                    style={{ color: yolo ? "var(--warning)" : "var(--text3)" }}>
                    <input type="checkbox" checked={yolo} onChange={(e) => setYoloKept(e.target.checked)} />
                    yolo
                  </label>
                </div>

                <div className="agx-scroll flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1.5">
                  {rows === null && !err && (
                    <p className="m-0 px-1 py-2 text-[10.5px]" style={{ color: "var(--text4)" }}>Reading the transcripts…</p>
                  )}
                  {err && <p className="m-0 px-1 py-2 text-[10.5px]" style={{ color: "var(--warning)" }}>{err}</p>}
                  {rows !== null && !err && shown.length === 0 && (
                    <p className="m-0 px-1 py-2 text-[10.5px]" style={{ color: "var(--text4)" }}>
                      {rows.length ? "Nothing matches that." : "No agent sessions in this project yet."}
                    </p>
                  )}
                  {shown.map((s) => {
                    const at = s.openIn;
                    return (
                      <div key={s.id} className="rounded-lg px-2.5 py-2 group/rs"
                        style={{
                          border: "1px solid color-mix(in srgb, var(--text) 10%, transparent)",
                          background: "color-mix(in srgb, var(--text) 3%, transparent)",
                          // Running already: still legible, plainly not on offer.
                          opacity: at ? 0.62 : 1,
                        }}>
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="text-[11.5px] truncate" style={{ color: "var(--text)" }}
                              title={s.title || s.id}>{s.title || "(untitled session)"}</div>
                            {!!s.opening && (
                              <div className="text-[10px] mt-0.5 leading-snug" style={{
                                color: "var(--text3)", display: "-webkit-box", WebkitLineClamp: 2,
                                WebkitBoxOrient: "vertical", overflow: "hidden",
                              }}>{s.opening}</div>
                            )}
                            {!!s.last && (
                              <div className="text-[10px] mt-0.5 truncate" style={{ color: "var(--text4)" }}
                                title={s.last}>↳ {s.last}</div>
                            )}
                          </div>
                          <div className="shrink-0 flex items-center gap-1">
                            {at ? (
                              <button onClick={() => { onGo(at); close(); }}
                                title={`Running in ${at.session}:${at.windowIndex} ${at.windowName}`}
                                className="agx-btn text-[10px] px-1.5 py-0.5 rounded"
                                style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
                                Go →
                              </button>
                            ) : (
                              <>
                                <button onClick={() => { onOpen(s, { split: false, yolo }); close(); }}
                                  title="Resume it in a tab of its own"
                                  className="agx-btn text-[10px] px-1.5 py-0.5 rounded"
                                  style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 18%, transparent)" }}>
                                  Tab
                                </button>
                                <button onClick={() => { onOpen(s, { split: true, yolo }); close(); }}
                                  title="Resume it beside this pane"
                                  className="agx-btn text-[10px] px-1.5 py-0.5 rounded"
                                  style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 18%, transparent)" }}>
                                  Split
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-[9.5px]" style={{ color: "var(--text4)" }}>
                          <span className="truncate" title={s.cwd}>{where(s.cwd)}</span>
                          <span>·</span>
                          <span>{ago(s.at)}</span>
                          <span>·</span>
                          <span>{weight(s.size)}</span>
                          {at && (
                            <span className="ml-auto truncate" style={{ color: "var(--primary)" }}
                              title={`${at.session}:${at.windowIndex} ${at.windowName} · ${at.paneId}`}>
                              open in {at.windowIndex} {at.windowName}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}
