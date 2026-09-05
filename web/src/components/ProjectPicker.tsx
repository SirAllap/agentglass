// Project picker — "which folder is this cockpit about?"
//
// Shown on first open (when the instance isn't scoped yet) and reachable from
// the header afterwards. Picking a project hands the server its directory: the
// dashboard, git panel and terminal then work on exactly that folder — its
// Makefile commands, its repos, its sessions — instead of everything on the
// machine. The choice is persisted server-side (config.json), so the next
// launch opens straight into the same project.
//
// It used to be a list and a path box, and the path box was the only way in for
// a project the sweep had never seen. That is the least discoverable control
// there is: it asks somebody to type an absolute path from memory, and gives no
// sign that it is even a control. So the ways of *adding* a project are now
// named and given rows of their own — browse for it, clone it, start an empty
// one — with the typed path kept underneath for a browser tab, which has no
// system folder chooser to offer.
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { GitRepoRef, FsEntry } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { api, IS_DEMO } from "../lib/api.ts";
import { CAN_BROWSE_FOLDER, chooseFolder } from "../lib/desktop.ts";
import { ContextMenu, MenuItem } from "./ContextMenu.tsx";
import { SCROLLBAR_CSS } from "./diff/DiffLines.tsx";
import { CloseButton } from "./CloseButton.tsx";

/** Set once the user has answered the startup question (either way), so an
 *  unscoped instance doesn't re-ask on every reload. */
export const PICKER_ANSWERED_KEY = "agentglass.projectChosen";
const markAnswered = () => { try { localStorage.setItem(PICKER_ANSWERED_KEY, "1"); } catch { /* ignore */ } };

// Mirrors isAbsoluteLike() in server/src/fsbrowse.ts: POSIX absolute (`/...`)
// or a Windows drive-letter root (`C:\...` / `C:/...`). Kept local rather than
// a shared import since this is the client bundle, not the server process.
const DRIVE_LETTER_ROOT = /^[a-zA-Z]:[\\/]/;
const isAbsoluteLike = (p: string) => p.startsWith("/") || DRIVE_LETTER_ROOT.test(p);

const parentOf = (p: string) => p.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";

/** Where a new project should go, guessed from where the existing ones live.
 *  The commonest parent among the repos already found beats any hardcoded
 *  `~/code`: it is right for the person whose projects are in `/mnt/hdd/work`,
 *  and identical to the guess for everybody else. */
function likelyParent(repos: GitRepoRef[] | null, workspace: string | null | undefined): string {
  if (workspace) return parentOf(workspace);
  const count = new Map<string, number>();
  for (const r of repos ?? []) {
    const p = parentOf(r.root);
    count.set(p, (count.get(p) ?? 0) + 1);
  }
  let best = "", n = 0;
  for (const [p, c] of count) if (c > n) { best = p; n = c; }
  return best || "~";
}

/**
 * A folder path with completions — the picker's one text control, used three
 * times over (open a path, clone into, create in).
 *
 * Every keystroke is a directory read on the server, so it is debounced, and
 * the stale-response guard matters more than the delay: a slow read of a big
 * directory must not overwrite the newer answer for what has been typed since.
 */
function FolderField({
  value, onChange, onSubmit, placeholder, autoFocus, small,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder: string;
  autoFocus?: boolean;
  small?: boolean;
}) {
  const [sugg, setSugg] = useState<FsEntry[]>([]);
  const [more, setMore] = useState(false);
  // -1 until the user arrows into the list: until then Enter means "take what I
  // typed", which is what someone pasting a full path expects — pre-selecting a
  // row would silently redirect that Enter into a completion instead.
  const [sel, setSel] = useState(-1);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const p = value.trim();
    if (!isAbsoluteLike(p) && !p.startsWith("~")) { setSugg([]); setMore(false); return; }
    let live = true;
    const t = setTimeout(() => {
      api.fsComplete(p)
        .then((r) => { if (live) { setSugg(r.entries); setMore(r.truncated); } })
        .catch(() => { if (live) { setSugg([]); setMore(false); } });
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [value]);

  // A new set of candidates invalidates whatever row was highlighted — keeping
  // index 3 across a re-filter would point at an unrelated directory.
  useEffect(() => { setSel(-1); }, [sugg]);

  /** Accept a suggestion: replace the half-typed segment and leave a trailing
   *  slash, so the very next completion lists inside the folder just chosen.
   *  That makes Tab-Tab-Tab walk down a tree, which is the whole point. */
  const accept = (e: FsEntry) => { onChange(e.path + "/"); setSel(-1); ref.current?.focus(); };

  const onKey = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Tab" && sugg.length) {
      // Tab with nothing highlighted takes the first match — the shell habit.
      ev.preventDefault();
      accept(sugg[sel >= 0 ? sel : 0]!);
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
      if (sel >= 0 && sugg[sel]) { accept(sugg[sel]!); return; }
      onSubmit?.();
    }
  };

  return (
    <div className="relative flex-1 min-w-0">
      {!!sugg.length && (
        // Above the input: this sits low in a modal, and a list hanging below
        // would fall off the viewport on a short window.
        <div className="agx-scroll absolute left-0 right-0 bottom-full mb-1 rounded-lg overflow-y-auto py-1"
          style={{ maxHeight: 220, zIndex: 3, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 12px 32px -12px rgba(0,0,0,0.7)" }}>
          {sugg.map((e, i) => (
            // onMouseDown, not onClick: a click first blurs the input, and
            // blur-driven dismissal would unmount the row before the click
            // ever landed on it.
            <div key={e.path} onMouseDown={(ev) => { ev.preventDefault(); accept(e); }} onMouseEnter={() => setSel(i)}
              className="px-3 py-1 flex items-center gap-2 cursor-pointer text-[11px]"
              style={{ background: i === sel ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent", color: "var(--text)" }}>
              <span className="text-[11px]">{e.repo ? "📁" : "🗀"}</span>
              <span className="truncate">{e.name}</span>
              {e.repo && <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded-full" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 15%, transparent)" }}>git</span>}
            </div>
          ))}
          {more && <div className="px-3 py-1 text-[10px] t-dim2">More matches — keep typing</div>}
        </div>
      )}
      <input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onBlur={() => setSugg([])}
        placeholder={placeholder} spellCheck={false} autoComplete="off" autoFocus={autoFocus}
        className={`w-full rounded-lg outline-none ${small ? "px-3 py-1.5 text-[11px]" : "px-3 py-2 text-[12px]"}`}
        style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
    </div>
  );
}

/** One of the "add a project" rows: an icon, what it does, and what that means.
 *  Big enough to read as a button from across the modal, which the old path box
 *  never did. */
function AddRow({ icon, title, sub, onClick, disabled }: { icon: string; title: string; sub: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="agx-btn w-full text-left px-2.5 py-2 rounded-xl flex items-center gap-3 disabled:opacity-50"
      style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
      <span className="shrink-0 grid place-items-center rounded-lg text-[13px]"
        style={{ width: 30, height: 30, background: "color-mix(in srgb, var(--primary) 12%, transparent)", color: "var(--primary-hover)" }}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-medium" style={{ color: "var(--text)" }}>{title}</span>
        <span className="block text-[10px] t-dim2">{sub}</span>
      </span>
      <span className="shrink-0 text-[11px]" style={{ color: "var(--text4)" }}>›</span>
    </button>
  );
}

type Mode = "list" | "clone" | "new";

/** `workspace` may be undefined — the server has not answered yet. No row is
 *  marked open in that case, which is the honest rendering: the picker does not
 *  know either. */
export function ProjectPicker({ open, workspace, onClose }: { open: boolean; workspace: string | null | undefined; onClose: () => void }) {
  const [repos, setRepos] = useState<GitRepoRef[] | null>(null);
  /** Paths this picker has been told to stop offering. Server-side, in the same
   *  config file as the scope, so it holds across restarts and across windows. */
  const [hidden, setHidden] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  /** Which row was right-clicked, and where. The menu is the only way to act on
   *  a row beyond opening it — see the note on Row. */
  const [menu, setMenu] = useState<{ root: string; x: number; y: number } | null>(null);
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<Mode>("list");
  // The two add-a-project forms. Kept here rather than inside each panel so
  // stepping back to the list and returning does not lose what was typed.
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  /** What the slow half is doing, in words. A clone is the one thing here that
   *  can take minutes, and a spinner with no sentence reads as a hang. */
  const [working, setWorking] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setMode("list");
    setRepos(null);
    setShowHidden(false);
    setMenu(null);
    api.gitReposAll()
      .then(({ repos, hidden }) => { setRepos(repos); setHidden(hidden ?? []); })
      .catch(() => setRepos([]));
  }, [open]);

  const suggestedParent = useMemo(() => likelyParent(repos, workspace), [repos, workspace]);
  // Only ever a default: once somebody edits it, their answer stands.
  useEffect(() => { if (open && !parent) setParent(suggestedParent); }, [open, suggestedParent, parent]);

  const choose = (root: string | null) => {
    if (busy) return;
    markAnswered();
    if (root === workspace) { onClose(); return; } // already there — nothing to change
    setBusy(true);
    setError("");
    setWorking("Switching project…");
    api.setWorkspace(root)
      .then((res) => {
        if (!res.ok) { setBusy(false); setWorking(""); setError(res.error || "Could not switch project"); return; }
        // A failed persist or an env override only affects the *next* launch —
        // the switch itself worked — so say so without blocking the reload.
        if (res.note) console.warn(`[agentglass] ${res.note}`);
        else if (!res.persisted) console.warn("[agentglass] project choice applied but could not be saved — it won't survive a server restart");
        // Everything on screen — events, repos, sessions — belongs to the old
        // scope. A clean reload is the honest way to rescope all of it.
        location.reload();
      })
      .catch((e) => { setBusy(false); setWorking(""); setError(String(e)); });
  };

  /**
   * Take a project off the list, or put it back.
   *
   * Optimistic, and deliberately so: this is a list row disappearing, the
   * server call is local, and a round trip before the row moves makes a ✕ feel
   * broken. A failure puts it back and says why.
   */
  const toggleHidden = (root: string) => {
    const wasHidden = hidden.includes(root);
    setHidden((h) => (wasHidden ? h.filter((p) => p !== root) : [...h, root]));
    api.hideProject(root, !wasHidden)
      .then((r) => {
        if (r.ok) { setHidden(r.hidden); return; }
        setHidden((h) => (wasHidden ? [...h, root] : h.filter((p) => p !== root)));
        setError(r.error || "Could not save that");
      })
      .catch((e) => {
        setHidden((h) => (wasHidden ? [...h, root] : h.filter((p) => p !== root)));
        setError(String(e));
      });
  };

  /** The system chooser, and then straight into the project. On a browser tab
   *  there is nothing to open, so this focuses the path box instead of doing
   *  nothing — see CAN_BROWSE_FOLDER. */
  const browse = async () => {
    const picked = await chooseFolder(parent || undefined);
    if (picked) choose(picked);
  };

  const runClone = () => {
    if (busy) return;
    setBusy(true); setError(""); setWorking("Cloning… this can take a while for a big repository");
    api.cloneProject(url.trim(), parent.trim())
      .then((r) => {
        if (!r.ok || !r.path) { setBusy(false); setWorking(""); setError(r.error || "Could not clone that repository"); return; }
        setWorking("Cloned — opening it…");
        choose(r.path);
      })
      .catch((e) => { setBusy(false); setWorking(""); setError(String(e)); });
  };

  const runCreate = () => {
    if (busy) return;
    setBusy(true); setError(""); setWorking("Creating…");
    api.newProject(name.trim(), parent.trim())
      .then((r) => {
        if (!r.ok || !r.path) { setBusy(false); setWorking(""); setError(r.error || "Could not create that project"); return; }
        // `error` alongside `ok` means the folder exists but `git init` did not
        // run — worth saying, and not worth refusing to open it over.
        if (r.error) console.warn(`[agentglass] ${r.error}`);
        choose(r.path);
      })
      .catch((e) => { setBusy(false); setWorking(""); setError(String(e)); });
  };

  // No closing mid-switch: the reload lands when the server answers, and a
  // dismissed modal reappearing as a surprise page reload is worse than a
  // short wait watching the "switching…" note.
  const close = () => { if (busy) return; markAnswered(); onClose(); };
  const back = () => { if (!busy) { setMode("list"); setError(""); } };

  // Name, full path and branch are all searchable, and each whitespace-separated
  // term has to match somewhere. One substring over the joined string meant
  // "hdd alavera" found nothing, because the terms are far apart in the path —
  // yet typing the two memorable fragments of a long path is exactly how people
  // look for `/mnt/hdd/code/current_project/alavera_app`.
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = (repos ?? []).filter((r) => {
    const hay = (r.name + " " + r.root + " " + r.branch).toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  // Hidden rows are held out of the list, not out of the answer: the count
  // below is what makes them recoverable, and a filter that quietly dropped
  // them would leave somebody hunting for a project they hid last week.
  const isHidden = (r: GitRepoRef) => hidden.includes(r.root);
  const shown = showHidden ? matching : matching.filter((r) => !isHidden(r));
  const hiddenHere = matching.filter(isHidden).length;

  const title = mode === "clone" ? "Clone a repository" : mode === "new" ? "New project" : "Open a project";
  const sub = mode === "clone" ? "It is cloned on this machine, then opened"
    : mode === "new" ? "An empty folder with a git repository in it"
    : "A project — or a folder your projects live in";

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 agx-scrim" style={{ zIndex: 10000 }} onClick={close} />
            <div className="fixed inset-0 flex items-center justify-center p-3 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 14 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ type: "spring", stiffness: 330, damping: 30 }}
                className="w-[560px] max-w-[95vw] max-h-[85vh] rounded-2xl flex flex-col pointer-events-auto overflow-hidden"
                style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>
                <style>{SCROLLBAR_CSS}</style>

                <div className="flex items-center gap-3 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  {mode !== "list" && (
                    <button onClick={back} disabled={busy} className="agx-btn text-[13px] leading-none px-1.5 py-0.5 rounded-md -ml-1.5" style={{ color: "var(--text2)" }} title="Back">‹</button>
                  )}
                  <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>{title}</span>
                  <span className="text-[11px] t-dim2 truncate">{sub}</span>
                  <CloseButton onClick={close} className="ml-auto" />
                </div>

                {mode === "list" && (
                  <>
                    <div className="px-4 pt-3 shrink-0">
                      <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter projects…"
                        className="w-full px-3 py-2 rounded-lg text-[12px] outline-none"
                        style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                    </div>

                    <div className="agx-scroll overflow-y-auto overflow-x-hidden flex-1 px-2 py-2" style={{ minHeight: 140 }}>
                      {/* machine-wide is a real choice, not just the absence of one */}
                      <Row current={workspace === null} icon="🖥" title="All repos/projects" sub="Every repo/project — no scope" onClick={() => choose(null)} disabled={busy} />

                      {repos === null && <div className="px-3 py-3 text-[11px] t-dim2">Looking for repos…</div>}
                      {/* Two different empty states. A filter that matches nothing
                          is about the filter; an empty list with no filter is about
                          configuration, and saying "no repos found" there states a
                          fact about the machine ("you have no code") when the true
                          statement is about this app ("nothing is configured to
                          look in"). The first reads as a bug in discovery, which is
                          how it was reported. */}
                      {repos !== null && !shown.length && (terms.length ? (
                        <div className="px-3 py-3 text-[11px] t-dim2">No repos match that filter</div>
                      ) : (
                        <div className="px-3 py-3 text-[11px] t-dim2 leading-relaxed">
                          <div style={{ color: "var(--text2)" }}>Nothing found to open yet</div>
                          <div className="mt-1">
                            agentglass sweeps the folders your projects already live in, and the usual ones
                            (<code>~/code</code>, <code>~/src</code>, <code>~/projects</code>…). If yours are somewhere else,
                            browse to one below — or name the folders with <code>repoDirs</code> in your config.
                          </div>
                        </div>
                      ))}
                      {shown.map((r) => (
                        <Row key={r.root} current={r.root === workspace} icon="📁" disabled={busy} onClick={() => choose(r.root)}
                          hidden={isHidden(r)}
                          // The open project has no menu: the only thing in it
                          // is "take this off the list", and hiding the one you
                          // are standing in would take the row away and leave
                          // the scope exactly where it was.
                          onMenu={r.root === workspace ? undefined : (x, y) => setMenu({ root: r.root, x, y })}
                          title={r.name} sub={r.root} right={r.branch}
                          meta={[
                            r.dirty > 0 ? `${r.dirty} change${r.dirty === 1 ? "" : "s"}` : "",
                            // The worktrees folded into this project. They aren't
                            // listed separately — they're the same project on
                            // another branch — but a dozen of them shouldn't be
                            // invisible either, and opening the project makes all
                            // of them available in git, terminal and chat.
                            r.worktrees ? `${r.worktrees} worktree${r.worktrees === 1 ? "" : "s"}` : "",
                          ].filter(Boolean).join(" · ")} />
                      ))}
                      {(hiddenHere > 0 || showHidden) && (
                        <button onClick={() => setShowHidden((v) => !v)}
                          className="agx-btn w-full text-left px-3 py-1.5 mt-1 rounded-lg text-[10.5px]"
                          style={{ color: "var(--text3)" }}>
                          {showHidden
                            ? "Hide removed projects again"
                            : `${hiddenHere} removed from this list · show`}
                        </button>
                      )}
                      {/* A right-click menu is exactly as invisible as the
                          hover button it replaces unless something says it is
                          there. One dim line, and only while there is a row to
                          try it on. */}
                      {!!shown.length && !showHidden && hiddenHere === 0 && (
                        <div className="px-3 pt-1.5 pb-0.5 text-[9.5px]" style={{ color: "var(--text4)" }}>
                          Right-click a project to take it off this list
                        </div>
                      )}
                    </div>

                    <div className="px-4 pt-2 pb-3 border-t shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                      <div className="text-[9.5px] uppercase tracking-wider mb-1.5" style={{ color: "var(--text4)" }}>Add a project</div>
                      <div className="flex flex-col gap-1.5">
                        {CAN_BROWSE_FOLDER && (
                          <AddRow icon="🗀" title="Browse folder…" sub="A project, a git repo, or a folder with many repos" onClick={() => void browse()} disabled={busy} />
                        )}
                        <AddRow icon="⌥" title="Clone from URL" sub="Clone a remote git repository onto this machine" onClick={() => { setMode("clone"); setError(""); }} disabled={busy} />
                        <AddRow icon="＋" title="Create new project" sub="Start from an empty folder" onClick={() => { setMode("new"); setError(""); }} disabled={busy} />
                      </div>

                      {/* The typed path stays: a browser tab has no system
                          chooser, and pasting a path somebody already has on the
                          clipboard beats browsing to it. */}
                      <div className="flex items-center gap-2 mt-2">
                        <FolderField value={path} onChange={setPath} onSubmit={() => path.trim() && choose(path.trim())} small
                          placeholder={CAN_BROWSE_FOLDER ? "…or paste a path: ~/code/my-project" : "Type a folder: ~/code/my-project, or ~/code for everything in it"} />
                        <button onClick={() => path.trim() && choose(path.trim())} disabled={busy || !path.trim()}
                          className="agx-btn text-[11px] px-3 py-1.5 rounded-lg font-medium shrink-0"
                          style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)", opacity: path.trim() ? 1 : 0.5 }}>
                          Open
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {mode !== "list" && (
                  <div className="px-4 py-4 flex flex-col gap-3">
                    {mode === "clone" ? (
                      <label className="flex flex-col gap-1">
                        <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>Repository URL</span>
                        <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off"
                          onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) runClone(); }}
                          placeholder="https://github.com/owner/repo.git  ·  git@github.com:owner/repo.git"
                          className="w-full px-3 py-2 rounded-lg text-[12px] outline-none"
                          style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                      </label>
                    ) : (
                      <label className="flex flex-col gap-1">
                        <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>Project name</span>
                        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoComplete="off"
                          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) runCreate(); }}
                          placeholder="my-project"
                          className="w-full px-3 py-2 rounded-lg text-[12px] outline-none"
                          style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                      </label>
                    )}

                    <div className="flex flex-col gap-1">
                      <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>{mode === "clone" ? "Clone into" : "Create in"}</span>
                      <div className="flex items-center gap-2">
                        <FolderField value={parent} onChange={setParent} placeholder="~/code" />
                        {CAN_BROWSE_FOLDER && (
                          <button onClick={() => void chooseFolder(parent || undefined).then((p) => p && setParent(p))} disabled={busy}
                            className="agx-btn text-[11px] px-3 py-2 rounded-lg shrink-0"
                            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>Browse…</button>
                        )}
                      </div>
                      {/* Say where it lands before it lands: the name is derived
                          from the URL, and "where did it go" is the first thing
                          anybody asks after a clone. */}
                      <span className="text-[10px] t-dim2 truncate">
                        {mode === "clone"
                          ? (url.trim() ? `→ ${parent.replace(/\/+$/, "")}/${(url.trim().split(/[?#]/)[0] ?? "").replace(/\/+$/, "").split(/[/:]/).pop()?.replace(/\.git$/i, "") || "…"}` : "\u00a0")
                          : (name.trim() ? `→ ${parent.replace(/\/+$/, "")}/${name.trim()}` : "\u00a0")}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 mt-1">
                      <button onClick={back} disabled={busy} className="agx-btn text-[11px] px-3 py-1.5 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>Cancel</button>
                      <button onClick={mode === "clone" ? runClone : runCreate} disabled={busy || !(mode === "clone" ? url.trim() : name.trim())}
                        className="agx-btn ml-auto text-[11px] px-4 py-1.5 rounded-lg font-medium"
                        style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)", opacity: busy || !(mode === "clone" ? url.trim() : name.trim()) ? 0.5 : 1 }}>
                        {mode === "clone" ? "Clone and open" : "Create and open"}
                      </button>
                    </div>
                  </div>
                )}

                {menu && (() => {
                  const wasHidden = hidden.includes(menu.root);
                  return (
                    <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
                      <MenuItem danger={!wasHidden} onClick={() => { toggleHidden(menu.root); setMenu(null); }}>
                        {wasHidden ? "Put back on the list" : "Remove from this list"}
                      </MenuItem>
                      {/* Says what it does NOT do, in the menu rather than in a
                          tooltip nobody waits for: "remove" next to a folder
                          path is a word people reasonably read as delete. */}
                      <div className="px-2 pb-1 pt-0.5 text-[10.5px] leading-snug" style={{ color: "var(--text4)" }}>
                        {wasHidden ? "It will be offered here again" : "Only here — the folder is not touched"}
                      </div>
                    </ContextMenu>
                  );
                })()}

                {(error || busy || IS_DEMO) && (
                  <div className="px-4 pb-3 text-[10.5px] shrink-0" style={{ color: error ? "var(--error)" : "var(--text2)" }}>
                    {IS_DEMO ? "The demo is never scoped — run agentglass locally to open a project" : error || working || "Working…"}
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

/**
 * One project in the list, and the current one made unmistakable.
 *
 * A tinted background alone was not enough to find at a glance in a list of
 * twenty: the eye needs an edge. So the open project keeps the tint, gains a
 * bar down its left side and says so in words — three signals, because the one
 * question this list has to answer without being read is "which am I in?".
 *
 * Acting on a row is a right-click, not a button in the row. The button was
 * tried: a ✕ that appeared on hover, wedged between the branch name and the
 * edge, three-quarters hidden until you happened to be over it. It bought a
 * cramped row for one action, and there is more than one action coming. A menu
 * costs no width at all, holds the next item without redesigning anything, and
 * has room to say what "remove" does not mean.
 *
 * Which leaves the row a single control again, so it is a plain <button>: the
 * two-control version could not be, because a <button> inside a <button> is
 * invalid HTML that browsers resolve by dropping the inner one.
 */
function Row({ current, icon, title, sub, meta, right, onClick, disabled, hidden, onMenu }: {
  current: boolean; icon: string; title: string; sub: string; meta?: string; right?: string;
  onClick: () => void; disabled?: boolean;
  /** Already off the list — drawn dimmed, and the menu offers the way back. */
  hidden?: boolean;
  /** Absent means this row has nothing to offer on a right-click, so the
   *  browser's own menu is left alone rather than replaced by an empty one. */
  onMenu?: (x: number, y: number) => void;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); } : undefined}
      className="agx-btn w-full text-left pl-3 pr-3 py-2 rounded-lg flex items-center gap-2.5 relative"
      style={{ background: current ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent", opacity: hidden ? 0.45 : 1 }}>
      {current && <span className="absolute left-0 top-1.5 bottom-1.5 rounded-full" style={{ width: 3, background: "var(--primary)" }} />}
      <span className="text-[13px]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] truncate" style={{ color: "var(--text)", fontWeight: current ? 600 : 500 }}>
          {title}
          {!!meta && <span className="t-dim2 font-normal"> · {meta}</span>}
        </span>
        <span className="block text-[10px] t-dim2 truncate" title={sub}>{sub}</span>
      </span>
      {!!right && <span className="shrink-0 text-[9.5px] t-dim2 truncate" style={{ maxWidth: 120 }}>{right}</span>}
      {current && <span className="shrink-0 text-[9.5px] px-1.5 py-0.5 rounded-full" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 15%, transparent)" }}>Open</span>}
    </button>
  );
}
