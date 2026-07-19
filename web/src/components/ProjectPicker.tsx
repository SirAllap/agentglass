// Project picker — "which folder is this cockpit about?"
//
// Shown on first open (when the instance isn't scoped yet) and reachable from
// the header afterwards. Picking a project hands the server its directory: the
// dashboard, git panel and terminal then work on exactly that folder — its
// Makefile commands, its repos, its sessions — instead of everything on the
// machine. The choice is persisted server-side (config.json), so the next
// launch opens straight into the same project.
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { GitRepoRef, FsEntry } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { api, IS_DEMO } from "../lib/api.ts";
import { SCROLLBAR_CSS } from "./ChangesModal.tsx";

/** Set once the user has answered the startup question (either way), so an
 *  unscoped instance doesn't re-ask on every reload. */
export const PICKER_ANSWERED_KEY = "agentglass.projectChosen";
const markAnswered = () => { try { localStorage.setItem(PICKER_ANSWERED_KEY, "1"); } catch { /* ignore */ } };

export function ProjectPicker({ open, workspace, onClose }: { open: boolean; workspace: string | null; onClose: () => void }) {
  const [repos, setRepos] = useState<GitRepoRef[] | null>(null);
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Directory completions for the free-text path box. `sel` is -1 until the user
  // arrows into the list: until then Enter means "open what I typed", which is
  // what someone pasting a full path expects — pre-highlighting a row would
  // silently redirect that Enter into a completion instead.
  const [sugg, setSugg] = useState<FsEntry[]>([]);
  const [more, setMore] = useState(false);
  const [sel, setSel] = useState(-1);
  const pathRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setError("");
    setRepos(null);
    api.gitReposAll().then(({ repos }) => setRepos(repos)).catch(() => setRepos([]));
  }, [open]);

  // Completions, debounced. Every keystroke is a directory read on the server,
  // and typing a long path would otherwise fire a dozen of them for answers
  // nobody sees. The stale-response guard matters more than the delay: a slow
  // read of a big directory must not overwrite the newer answer for what the
  // user has typed since.
  useEffect(() => {
    const p = path.trim();
    // Only absolute / `~`-rooted input has a meaningful parent to list, which is
    // the same rule the server applies before it will answer at all.
    if (!open || (!p.startsWith("/") && !p.startsWith("~"))) { setSugg([]); setMore(false); return; }
    let live = true;
    const t = setTimeout(() => {
      api.fsComplete(p)
        .then((r) => { if (live) { setSugg(r.entries); setMore(r.truncated); } })
        .catch(() => { if (live) { setSugg([]); setMore(false); } });
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [path, open]);

  // A new set of candidates invalidates whatever row was highlighted — keeping
  // index 3 across a re-filter would point at an unrelated directory.
  useEffect(() => { setSel(-1); }, [sugg]);

  /** Accept a suggestion: replace the half-typed segment and leave a trailing
   *  slash, so the very next completion lists inside the folder just chosen.
   *  That makes Tab-Tab-Tab walk down a tree, which is the whole point. */
  const accept = (e: FsEntry) => {
    setPath(e.path + "/");
    setSel(-1);
    pathRef.current?.focus();
  };

  const onPathKey = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    const p = path.trim();
    if (ev.key === "Tab" && sugg.length) {
      // Tab with nothing highlighted takes the first match — the shell habit.
      ev.preventDefault();
      accept(sugg[sel >= 0 ? sel : 0]);
      return;
    }
    if (ev.key === "ArrowDown" && sugg.length) { ev.preventDefault(); setSel((s) => (s + 1) % sugg.length); return; }
    if (ev.key === "ArrowUp" && sugg.length) { ev.preventDefault(); setSel((s) => (s <= 0 ? sugg.length : s) - 1); return; }
    if (ev.key === "Escape" && sugg.length) {
      // Dismiss the list without closing the whole modal — the outer handler
      // would otherwise throw away a path the user is halfway through typing.
      ev.stopPropagation();
      setSugg([]);
      return;
    }
    if (ev.key === "Enter") {
      if (sel >= 0 && sugg[sel]) { accept(sugg[sel]); return; }
      if (p) choose(p);
    }
  };

  const choose = (root: string | null) => {
    if (busy) return;
    markAnswered();
    if (root === workspace) { onClose(); return; } // already there — nothing to change
    setBusy(true);
    setError("");
    api.setWorkspace(root)
      .then((res) => {
        if (!res.ok) { setBusy(false); setError(res.error || "could not switch project"); return; }
        // A failed persist or an env override only affects the *next* launch —
        // the switch itself worked — so say so without blocking the reload.
        if (res.note) console.warn(`[agentglass] ${res.note}`);
        else if (!res.persisted) console.warn("[agentglass] project choice applied but could not be saved — it won't survive a server restart");
        // Everything on screen — events, repos, sessions — belongs to the old
        // scope. A clean reload is the honest way to rescope all of it.
        location.reload();
      })
      .catch((e) => { setBusy(false); setError(String(e)); });
  };

  // No closing mid-switch: the reload lands when the server answers, and a
  // dismissed modal reappearing as a surprise page reload is worse than a
  // short wait watching the "switching…" note.
  const close = () => { if (busy) return; markAnswered(); onClose(); };

  // Name, full path and branch are all searchable, and each whitespace-separated
  // term has to match somewhere. One substring over the joined string meant
  // "hdd alavera" found nothing, because the terms are far apart in the path —
  // yet typing the two memorable fragments of a long path is exactly how people
  // look for `/mnt/hdd/code/current_project/alavera_app`.
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (repos ?? []).filter((r) => {
    const hay = (r.name + " " + r.root + " " + r.branch).toLowerCase();
    return terms.every((t) => hay.includes(t));
  });

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={close} />
            <div className="fixed inset-0 flex items-center justify-center p-3 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 14 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ type: "spring", stiffness: 330, damping: 30 }}
                className="w-[560px] max-w-[95vw] max-h-[85vh] rounded-2xl flex flex-col pointer-events-auto overflow-hidden"
                style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>
                <style>{SCROLLBAR_CSS}</style>

                <div className="flex items-center gap-3 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>⌂ Open a project</span>
                  <span className="text-[11px] t-dim2">a project — or a folder your projects live in</span>
                  <button onClick={close} className="ml-auto text-[18px] leading-none px-2 t-dim2 hover:opacity-70">✕</button>
                </div>

                <div className="px-4 pt-3 shrink-0">
                  <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="filter projects…"
                    className="w-full px-3 py-2 rounded-lg text-[12px] outline-none"
                    style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                </div>

                <div className="agx-scroll overflow-y-auto flex-1 px-2 py-2" style={{ minHeight: 160 }}>
                  {/* machine-wide is a real choice, not just the absence of one */}
                  <button onClick={() => choose(null)} disabled={busy}
                    className="w-full text-left px-3 py-2 rounded-lg flex items-center gap-2.5"
                    style={{ background: !workspace ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
                    <span className="text-[13px]">🖥</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-medium" style={{ color: "var(--text)" }}>Whole machine</span>
                      <span className="block text-[10px] t-dim2">every project at once — no scope</span>
                    </span>
                    {!workspace && <span className="text-[9.5px] px-1.5 py-0.5 rounded-full" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 15%, transparent)" }}>current</span>}
                  </button>

                  {repos === null && <div className="px-3 py-3 text-[11px] t-dim2">looking for repos…</div>}
                  {repos !== null && !shown.length && <div className="px-3 py-3 text-[11px] t-dim2">no repos found{terms.length ? " for that filter" : ""}</div>}
                  {shown.map((r) => (
                    <button key={r.root} onClick={() => choose(r.root)} disabled={busy}
                      className="w-full text-left px-3 py-2 rounded-lg flex items-center gap-2.5 hover:bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]"
                      style={{ background: r.root === workspace ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
                      <span className="text-[13px]">📁</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] font-medium truncate" style={{ color: "var(--text)" }}>
                          {r.name}
                          {r.dirty > 0 && <span className="t-dim2 font-normal"> · {r.dirty} change{r.dirty === 1 ? "" : "s"}</span>}
                        </span>
                        <span className="block text-[10px] t-dim2 truncate" title={r.root}>{r.root}</span>
                      </span>
                      <span className="shrink-0 text-[9.5px] t-dim2 truncate" style={{ maxWidth: 120 }}>{r.branch}</span>
                      {r.root === workspace && <span className="shrink-0 text-[9.5px] px-1.5 py-0.5 rounded-full" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 15%, transparent)" }}>current</span>}
                    </button>
                  ))}
                </div>

                {/* a project that lives somewhere the sweep doesn't reach */}
                <div className="px-4 py-3 border-t shrink-0 flex items-center gap-2 relative" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  {/* Completions sit ABOVE the input: this row is pinned to the
                      bottom of the modal, so a dropdown hanging below it would
                      fall off the viewport on a short window. */}
                  {!!sugg.length && (
                    <div className="agx-scroll absolute left-4 right-4 bottom-full mb-1 rounded-lg overflow-y-auto py-1"
                      style={{ maxHeight: 220, zIndex: 1, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 12px 32px -12px rgba(0,0,0,0.7)" }}>
                      {sugg.map((e, i) => (
                        // onMouseDown, not onClick: a click first blurs the input,
                        // and blur-driven dismissal would unmount the row before
                        // the click ever landed on it.
                        <div key={e.path} onMouseDown={(ev) => { ev.preventDefault(); accept(e); }} onMouseEnter={() => setSel(i)}
                          className="px-3 py-1 flex items-center gap-2 cursor-pointer text-[11px]"
                          style={{ background: i === sel ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent", color: "var(--text)" }}>
                          <span className="text-[11px]">{e.repo ? "📁" : "🗀"}</span>
                          <span className="truncate">{e.name}</span>
                          {e.repo && <span className="ml-auto shrink-0 text-[9px] px-1.5 py-0.5 rounded-full" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 15%, transparent)" }}>git</span>}
                        </div>
                      ))}
                      {more && <div className="px-3 py-1 text-[10px] t-dim2">more matches — keep typing</div>}
                    </div>
                  )}
                  <input ref={pathRef} value={path} onChange={(e) => setPath(e.target.value)} placeholder="…or type a folder: ~/code/my-project, or ~/code for everything in it"
                    onKeyDown={onPathKey} onBlur={() => setSugg([])} spellCheck={false} autoComplete="off"
                    className="flex-1 px-3 py-1.5 rounded-lg text-[11px] outline-none"
                    style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                  <button onClick={() => path.trim() && choose(path.trim())} disabled={busy || !path.trim()}
                    className="text-[11px] px-3 py-1.5 rounded-lg font-medium"
                    style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)", opacity: path.trim() ? 1 : 0.5 }}>
                    open
                  </button>
                </div>
                {(error || busy || IS_DEMO) && (
                  <div className="px-4 pb-3 text-[10.5px] shrink-0" style={{ color: error ? "var(--error)" : "var(--text2)" }}>
                    {IS_DEMO ? "the demo is never scoped — run agentglass locally to open a project" : error || "switching project…"}
                  </div>
                )}
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
