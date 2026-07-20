import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { THEMES, applyTheme } from "../lib/themes.ts";
import { IS_DESKTOP } from "../lib/desktop.ts";
import { api } from "../lib/api.ts";

interface Cmd {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  apps,
  types,
  onFilter,
  onWindow,
  onTheme,
  onStats,
  onSkills,
  onChanges,
  onGit,
  onDocker,
  onTerminal,
  onChat,
  onSearch,
  onClear,
  onZoom,
}: {
  open: boolean;
  onClose: () => void;
  apps: string[];
  types: string[];
  onFilter: (f: { app?: string; type?: string }) => void;
  onWindow: (ms: number) => void;
  onTheme: (id: string) => void;
  onStats: () => void;
  onSkills: () => void;
  onChanges: () => void;
  onGit: () => void;
  onDocker: () => void;
  onTerminal: () => void;
  onChat: () => void;
  onSearch: () => void;
  onClear: () => void;
  onZoom: (dir: 1 | -1 | 0) => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  const cmds = useMemo<Cmd[]>(() => {
    const list: Cmd[] = [];
    list.push({ id: "search", group: "View", label: "Search all history — prompts, commands, outputs", run: () => onSearch() });
    list.push({ id: "skills", group: "View", label: "Browse skills — every available skill & command", run: () => onSkills() });
    list.push({ id: "changes", group: "View", label: "File changes — every diff the fleet made", run: () => onChanges() });
    list.push({ id: "git", group: "View", label: "Source control — stage, commit, push/pull the working tree", run: () => onGit() });
    list.push({ id: "docker", group: "View", label: "Docker — containers, logs, stats & actions", run: () => onDocker() });
    list.push({ id: "terminal", group: "View", label: "Terminal — a real shell in any repo/worktree", run: () => onTerminal() });
    list.push({ id: "chat", group: "View", label: "Chat — drive a Claude session in a repo/worktree", run: () => onChat() });
    list.push({ id: "stats", group: "View", label: "Show statistics — skills, tools, apps", run: () => onStats() });
    list.push({ id: "clear", group: "Filter", label: "Clear all filters", run: () => onClear() });
    // Discoverability more than convenience — the keys are faster once you know
    // them, but nothing on screen would ever have told you they exist.
    if (IS_DESKTOP) {
      list.push({ id: "zoom-in", group: "Display", label: "Bigger — scale the whole window up", run: () => onZoom(1) });
      list.push({ id: "zoom-out", group: "Display", label: "Smaller — scale the whole window down", run: () => onZoom(-1) });
      list.push({ id: "zoom-reset", group: "Display", label: "Reset display size to 100%", run: () => onZoom(0) });
    }
    for (const a of apps) list.push({ id: "app:" + a, group: "Filter by app", label: a, run: () => onFilter({ app: a }) });
    for (const t of types) list.push({ id: "type:" + t, group: "Filter by event", label: t, run: () => onFilter({ type: t }) });
    for (const w of [["15m", 900000], ["1h", 3600000], ["6h", 21600000], ["24h", 86400000], ["7d", 604800000]] as const)
      list.push({ id: "win:" + w[0], group: "Time window", label: w[0], run: () => onWindow(w[1] as number) });
    for (const t of THEMES) list.push({ id: "theme:" + t.id, group: "Theme", label: t.name, run: () => { applyTheme(t.id); onTheme(t.id); } });
    list.push({ id: "csv", group: "Export", label: "Download CSV", run: () => window.open(api.exportUrl("csv")) });
    list.push({ id: "json", group: "Export", label: "Download JSON", run: () => window.open(api.exportUrl("json")) });
    return list;
  }, [apps, types, onFilter, onWindow, onTheme, onStats, onSkills, onChanges, onGit, onDocker, onTerminal, onChat, onSearch, onClear, onZoom]);

  const filtered = useMemo(
    () => (q ? cmds.filter((c) => (c.group + " " + c.label).toLowerCase().includes(q.toLowerCase())) : cmds),
    [cmds, q]
  );

  useEffect(() => {
    setSel(0);
  }, [q, open]);

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const act = (c?: Cmd) => {
    if (!c) return;
    c.run();
    onClose();
  };

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={onClose} />
            {/* Centering wrapper: Motion owns the modal's `transform` (scale/y
                animation), which clobbers a Tailwind -translate-x-1/2 — so a
                flex wrapper does the centering instead. */}
            <div className="fixed inset-0 flex justify-center items-start pt-[14vh] px-4 pointer-events-none" style={{ zIndex: 10001 }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: -12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: -8 }}
              transition={{ type: "spring", stiffness: 360, damping: 30 }}
              className="w-[min(560px,92vw)] rounded-2xl overflow-hidden pointer-events-auto"
              style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}
            >
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(filtered.length - 1, s + 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
                  else if (e.key === "Enter") { e.preventDefault(); act(filtered[sel]); }
                  else if (e.key === "Escape") onClose();
                }}
                placeholder="Type a command… theme, filter, window, export"
                className="w-full px-4 py-3 text-[13px] outline-none"
                style={{ background: "transparent", color: "var(--text)", borderBottom: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}
              />
              <div className="max-h-[52vh] overflow-auto py-1">
                {filtered.map((c, i) => (
                  <button
                    key={c.id}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => act(c)}
                    className="w-full flex items-center justify-between px-4 py-2 text-left text-[12px]"
                    style={{ background: i === sel ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent" }}
                  >
                    <span style={{ color: "var(--text2)" }}>{c.label}</span>
                    <span className="text-[10px] t-dim2">{c.group}</span>
                  </button>
                ))}
                {filtered.length === 0 && <div className="px-4 py-6 text-center t-dim2 text-[12px]">no commands</div>}
              </div>
            </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
