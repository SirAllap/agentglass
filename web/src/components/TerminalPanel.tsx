// In-browser terminal — a REAL machine terminal (xterm.js ⇄ WebSocket ⇄ PTY).
// The server spawns your login shell inside a pseudo-terminal per repo/worktree,
// so everything a local terminal does works here: job control, Ctrl+C/Ctrl+R,
// tab-completion, colors, vim/htop/lazygit. Shell sessions are kept alive in a
// module-level store, so closing the panel (or switching repos) never kills a
// running job — reopening reattaches to the live session, scrollback intact.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { GitRepoRef, ProjectCommand, TerminalCommands } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { api, IS_DEMO, ptyWsUrl, hasToken, probeAuth, reauthPrompt } from "../lib/api.ts";
import { SCROLLBAR_CSS } from "./ChangesModal.tsx";

const ROOT_KEY = "agentglass.terminalRoot";
const QUICK = ["git status", "git log --oneline -15", "git diff --stat", "git branch -vv"];
const repoName = (p: string) => p.split("/").pop() || p;

// xterm draws in its own DOM — resolve theme vars to concrete colors for it.
const rootStyle = () => getComputedStyle(document.documentElement); // one style-recalc per read batch
const readVar = (s: CSSStyleDeclaration, name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
const alpha = (hex: string, a: string) => (/^#[0-9a-fA-F]{6}$/.test(hex) ? hex + a : hex);
function themeFromCss() {
  const s = rootStyle();
  const bg = readVar(s, "--bg", "#0d1117");
  return {
    background: bg,
    foreground: readVar(s, "--text2", "#c8ccd4"),
    cursor: readVar(s, "--primary", "#a78bfa"),
    cursorAccent: bg,
    selectionBackground: alpha(readVar(s, "--primary", "#a78bfa"), "44"),
    black: "#5b6472", red: "#f06c75", green: "#98c379", yellow: "#e5c07b",
    blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#c8ccd4",
    brightBlack: "#7f8896", brightRed: "#ff7b86", brightGreen: "#b5e08f", brightYellow: "#f0d08a",
    brightBlue: "#82c0ff", brightMagenta: "#d79be8", brightCyan: "#7fd6df", brightWhite: "#ffffff",
  };
}
const TERM_FONT = '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "JetBrains Mono", "SF Mono", ui-monospace, "Cascadia Code", "Fira Code", Menlo, Monaco, "Roboto Mono", Consolas, "Liberation Mono", monospace';

// --- persistent per-repo shell sessions (outlive the panel) ------------------
type SessStatus = "idle" | "connecting" | "live" | "exited" | "error" | "unauthorized";
type Sess = {
  id: string;             // many shells can share a repo, so the id is the key
  root: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  holder: HTMLDivElement; // xterm's home element — reparented into the panel
  ws: WebSocket | null;
  status: SessStatus;
  mode: "pty" | "pipe" | null;
  shell: string;
  canResize: boolean;
  opened: boolean;
  pending: string[]; // input queued while (re)connecting — flushed on ready
  createdAt: number;
  lastUsed: number;
  retries: number;        // consecutive failed reconnects
  retryTimer: number | null;
  subs: Set<() => void>;
};
const sessions = new Map<string, Sess>();
let seq = 0;
/** Shells for one repo, in creation order. */
const sessionsFor = (root: string) => [...sessions.values()].filter((s) => s.root === root).sort((a, b) => a.createdAt - b.createdAt);
const notify = (s: Sess) => s.subs.forEach((fn) => fn());
// Set by the mounted panel so the terminal itself can close it (Shift+Esc).
let panelClose: () => void = () => {};

// The panel is built to keep many shells open at once, so eviction is a last
// resort rather than routine: it only runs at the server's own ceiling, and it
// never touches a shell that is still connected — closing a live job to make
// room for a new tab would lose work the user can't see.
const MAX_CLIENT_SESSIONS = 60;
function evictLru(exceptRoot: string) {
  if (sessions.size < MAX_CLIENT_SESSIONS) return;
  let lru: Sess | null = null;
  for (const s of sessions.values()) {
    if (s.root === exceptRoot || s.status === "live" || s.status === "connecting") continue;
    if (!lru || s.lastUsed < lru.lastUsed) lru = s;
  }
  if (!lru) return;
  const ws = lru.ws;
  lru.ws = null; // detach first so its handlers see a stale socket and stay quiet
  // An evicted session must not resurrect itself from a pending retry.
  if (lru.retryTimer) { clearTimeout(lru.retryTimer); lru.retryTimer = null; }
  try { ws?.close(); } catch { /* already gone */ }
  try { lru.term.dispose(); } catch { /* already disposed */ }
  lru.holder.remove();
  sessions.delete(lru.id);
}

function connect(s: Sess) {
  if (s.ws || IS_DEMO) return;
  s.status = "connecting";
  notify(s);
  const ws = new WebSocket(ptyWsUrl(s.root, s.term.cols, s.term.rows));
  ws.binaryType = "arraybuffer";
  s.ws = ws;
  ws.onmessage = (ev) => {
    if (s.ws !== ws) return; // a stale socket (replaced by ⟲ new shell) must not touch the session
    if (typeof ev.data !== "string") { s.term.write(new Uint8Array(ev.data as ArrayBuffer)); return; }
    let f: { t?: string; mode?: "pty" | "pipe"; shell?: string; resize?: boolean; code?: number; error?: string };
    try { f = JSON.parse(ev.data); } catch { return; }
    if (f.t === "ready") {
      reconnected(s);
      s.status = "live"; s.mode = f.mode ?? null; s.shell = f.shell || "shell"; s.canResize = f.resize !== false;
      if (f.mode === "pipe") s.term.writeln("\x1b[2m(no pty available on this host — plain-pipe shell: TUI apps won't render)\x1b[0m");
      for (const d of s.pending.splice(0)) ws.send(JSON.stringify({ t: "in", d }));
      // the fit that ran while connecting may not have reached the server
      ws.send(JSON.stringify({ t: "resize", cols: s.term.cols, rows: s.term.rows }));
      notify(s);
    } else if (f.t === "exit" || f.t === "fatal") {
      s.status = f.t === "exit" ? "exited" : "error";
      if (f.t === "exit") s.term.write(`\r\n\x1b[2m— shell exited (${f.code ?? "?"}) · press Enter for a new one —\x1b[0m\r\n`);
      else s.term.writeln(`\r\n\x1b[31m${f.error || "terminal error"}\x1b[0m`);
      s.ws = null; // detach now so Enter can reconnect without waiting for onclose
      try { ws.close(); } catch { /* server closes it anyway */ }
      notify(s);
    }
  };
  ws.onclose = () => {
    if (s.ws !== ws) return; // stale socket — the session already moved on
    const wasLive = s.status === "live";
    s.ws = null;
    if (s.status === "connecting" || s.status === "live") {
      s.status = "error";
      notify(s);
      // The server is on this machine, so a drop is nearly always something
      // restarting rather than a real outage — the shell itself survives it.
      // Making the user press Enter to come back is asking them to do the
      // computer's job; retry on our own and say so, with the manual path
      // still there if the retries give up.
      maybeReconnect(s, wasLive);
    }
  };
}

/** Reconnect delay, backing off so a server that's down for a while isn't
 *  hammered, but a quick restart is picked up almost immediately. */
const RETRY_MS = [400, 800, 1500, 3000, 5000, 8000];
// Stop after ~2 minutes of failed reconnects (the backoff tops out at 8s). Left
// unbounded, a wrong/rotated token — which rejects every upgrade with a 401 a
// browser WS can't read — printed a reconnect dot forever (~450/hour).
const MAX_RETRIES = 15;

/** Decide whether to keep reconnecting after a socket dropped. A close before
 *  the shell ever went live, on a token-protected server, is almost always the
 *  401 that rejects the WS upgrade — unreadable off a browser WebSocket — so we
 *  probe an authenticated endpoint to tell an auth wall from a plain outage and
 *  stop retrying (with a way back) instead of spinning forever. */
async function maybeReconnect(s: Sess, wasLive: boolean) {
  if (!wasLive && hasToken()) {
    const state = await probeAuth();
    if (s.ws) return; // a manual reconnect (Enter / ⟲) beat us to it
    if (state === "unauthorized") {
      if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
      s.retries = 0;
      s.status = "unauthorized";
      s.term.write("\r\n\x1b[31m— unauthorized: this server needs an access token —\x1b[0m\r\n\x1b[2m  reopen the dashboard with ?token=… (or click the ⚿ status) to re-enter it\x1b[0m\r\n");
      notify(s);
      return;
    }
  }
  scheduleReconnect(s);
}

function scheduleReconnect(s: Sess) {
  if (s.retryTimer) return;
  if (s.retries >= MAX_RETRIES) {
    s.status = "error";
    s.term.write("\r\n\x1b[2m— still no server after many tries · press Enter to retry —\x1b[0m\r\n");
    notify(s);
    return;
  }
  const wait = RETRY_MS[Math.min(s.retries, RETRY_MS.length - 1)];
  s.retries++;
  if (s.retries === 1) s.term.write("\r\n\x1b[2m— disconnected · reconnecting…\x1b[0m");
  else s.term.write("\x1b[2m.\x1b[0m");
  s.retryTimer = setTimeout(() => {
    s.retryTimer = null;
    if (s.ws) return; // something else already reconnected it
    connect(s);
  }, wait) as unknown as number;
}

/** Called once a socket reports ready: the connection is good again. */
function reconnected(s: Sess) {
  if (s.retries) s.term.write("\r\n\x1b[2m— reconnected —\x1b[0m\r\n");
  s.retries = 0;
  if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
}

/** A brand-new shell for `root`. Repos hold as many as you open. */
function createSession(root: string): Sess {
  evictLru(root);
  const term = new Terminal({
    fontFamily: readVar(rootStyle(), "--font-mono", "") ? `var(--font-mono), ${TERM_FONT}` : TERM_FONT,
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 10_000,
    theme: themeFromCss(),
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Shift+Esc closes the panel — plain Esc belongs to the shell (vim, fzf…).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.key === "Escape" && e.shiftKey) { panelClose(); return false; }
    return true;
  });
  const holder = document.createElement("div");
  holder.style.cssText = "width:100%;height:100%";
  const id = `t${++seq}-${Date.now().toString(36)}`;
  const sess: Sess = { id, root, title: `shell ${sessionsFor(root).length + 1}`, term, fit, holder, ws: null, status: "idle", mode: null, shell: "shell", canResize: true, opened: false, pending: [], createdAt: Date.now(), lastUsed: Date.now(), retries: 0, retryTimer: null, subs: new Set() };
  term.onData((d) => {
    sess.lastUsed = Date.now();
    if (sess.status === "live" && sess.ws?.readyState === WebSocket.OPEN) sess.ws.send(JSON.stringify({ t: "in", d }));
    else if (sess.status === "connecting") sess.pending.push(d); // don't drop keys typed before the shell is up
    else if (sess.status === "unauthorized" && d.includes("\r")) reauthPrompt(); // Enter → re-enter the token
    else if ((sess.status === "exited" || sess.status === "error") && d.includes("\r")) { sess.retries = 0; connect(sess); } // Enter → new shell, scrollback kept
  });
  term.onResize(({ cols, rows }) => {
    if (sess.ws?.readyState === WebSocket.OPEN) sess.ws.send(JSON.stringify({ t: "resize", cols, rows }));
  });
  sessions.set(id, sess);
  return sess;
}

/** Close a shell and drop it: its socket, its terminal and its pending retry. */
function killSession(s: Sess) {
  if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
  const ws = s.ws;
  s.ws = null; // detach first so the close handler stays quiet
  try { ws?.close(); } catch { /* already gone */ }
  try { s.term.dispose(); } catch { /* already disposed */ }
  s.holder.remove();
  sessions.delete(s.id);
}

/** Type a command into the repo's shell (starting one if needed). */
function runInShell(s: Sess, cmd: string) {
  const line = cmd + "\r";
  s.lastUsed = Date.now();
  if (s.status === "live" && s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ t: "in", d: line }));
  else { s.pending.push(line); if (!s.ws) connect(s); }
  s.term.focus();
}

// --- the panel ---------------------------------------------------------------
export function TerminalPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [root, setRoot] = useState<string>(() => { try { return localStorage.getItem(ROOT_KEY) || ""; } catch { return ""; } });
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState("");
  const [cmds, setCmds] = useState<TerminalCommands | null>(null);
  const [cmdsOpen, setCmdsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    if (!open) return;
    api.gitRepos().then(({ repos }) => {
      setRepos(repos);
      // When the scoped repo list doesn't contain the remembered root, DROP it
      // rather than keep it: a stale localStorage root from a previous scope
      // would silently open shells (and list commands) in an out-of-scope repo
      // while the header claims "pick a repo".
      setRoot((cur) => (cur && repos.some((r) => r.root === cur) ? cur : repos[0]?.root || ""));
    }).catch(() => {});
  }, [open]);
  useEffect(() => { if (root) { try { localStorage.setItem(ROOT_KEY, root); } catch { /* ignore */ } } }, [root]);
  useEffect(() => {
    if (!open || !root) return;
    setCmds(null);
    api.terminalCommands(root).then(setCmds).catch(() => setCmds({ enabled: true, make: [], scripts: [] }));
  }, [open, root]);

  // Which shells are on screen. One id per visible pane: a single pane is the
  // plain case, and a split shows several at once the way tmux does — the point
  // being to watch a build in one while working in another.
  const [paneIds, setPaneIds] = useState<string[]>([]);
  const [focusIdx, setFocusIdx] = useState(0);
  const paneRefs = useRef<(HTMLDivElement | null)[]>([]);

  const tabs = !IS_DEMO && root ? sessionsFor(root) : [];

  // Every repo opens with a shell, and the panes always name shells that still
  // exist — closing one must not leave an empty frame behind.
  useEffect(() => {
    if (!open || !root || IS_DEMO) return;
    const live = sessionsFor(root);
    const first = live[0] ?? createSession(root);
    setPaneIds((prev) => {
      const kept = prev.filter((id) => sessions.get(id)?.root === root);
      return kept.length ? kept : [first.id];
    });
    setFocusIdx(0);
  }, [open, root]);

  // Mount each pane's terminal into its slot. xterm keeps its own DOM, so the
  // holder is moved between slots rather than re-created — that's what keeps
  // scrollback and running jobs intact across splits and reopens.
  useEffect(() => {
    if (!open || IS_DEMO) return;
    panelClose = onClose;
    const mounted: { s: Sess; el: HTMLDivElement; ro: ResizeObserver }[] = [];
    paneIds.forEach((id, i) => {
      const s = sessions.get(id);
      const el = paneRefs.current[i];
      if (!s || !el) return;
      el.appendChild(s.holder);
      if (!s.opened) { s.term.open(s.holder); s.opened = true; }
      s.term.options.theme = themeFromCss(); // pick up theme switches between opens
      s.subs.add(force);
      const doFit = () => { try { s.fit.fit(); } catch { /* not measurable yet */ } };
      doFit();
      if (s.status === "idle") connect(s);
      const ro = new ResizeObserver(doFit);
      ro.observe(el);
      mounted.push({ s, el, ro });
    });
    const focused = sessions.get(paneIds[focusIdx] ?? "");
    if (focused) requestAnimationFrame(() => focused.term.focus());
    return () => {
      panelClose = () => {};
      for (const { s, el, ro } of mounted) {
        ro.disconnect();
        s.subs.delete(force);
        if (s.holder.parentElement === el) el.removeChild(s.holder);
      }
    };
  }, [open, paneIds, focusIdx, onClose]);

  const sess = sessions.get(paneIds[focusIdx] ?? "");
  const status: SessStatus = sess?.status ?? "idle";

  const addShell = useCallback(() => {
    if (!root || IS_DEMO) return;
    const s = createSession(root);
    setPaneIds([s.id]);
    setFocusIdx(0);
  }, [root]);

  /** Show one more shell beside the current one (new if there isn't a spare). */
  const splitPane = useCallback(() => {
    if (!root || IS_DEMO) return;
    setPaneIds((prev) => {
      if (prev.length >= 4) return prev; // beyond four a pane is too small to use
      const spare = sessionsFor(root).find((s) => !prev.includes(s.id)) ?? createSession(root);
      return [...prev, spare.id];
    });
  }, [root]);

  const showOnly = useCallback((id: string) => { setPaneIds([id]); setFocusIdx(0); }, []);

  const closeShell = useCallback((id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    const r = s.root;
    killSession(s);
    setPaneIds((prev) => {
      const kept = prev.filter((x) => x !== id);
      if (kept.length) return kept;
      const next = sessionsFor(r)[0] ?? createSession(r);
      return [next.id];
    });
    setFocusIdx(0);
  }, []);

  const run = useCallback((cmd: string) => {
    if (!root || IS_DEMO) return;
    const s = sessions.get(paneIds[focusIdx] ?? "") ?? createSession(root);
    runInShell(s, cmd);
    setCmdsOpen(false);
  }, [root, paneIds, focusIdx]);

  const restart = useCallback(() => {
    const s = sessions.get(paneIds[focusIdx] ?? "");
    if (!s || IS_DEMO) return;
    if (s.ws) { s.status = "exited"; s.ws.close(); s.ws = null; }
    s.term.write("\r\n\x1b[2m— restarting shell —\x1b[0m\r\n");
    connect(s);
    s.term.focus();
  }, [paneIds, focusIdx]);

  const repoRef = repos.find((r) => r.root === root);
  const nCmds = (cmds?.make.length ?? 0) + (cmds?.scripts.length ?? 0);
  const disabled = cmds ? !cmds.enabled : false;

  const statusDot: Record<SessStatus, { color: string; label: string }> = {
    idle: { color: "var(--text2)", label: "idle" },
    connecting: { color: "var(--warning)", label: "connecting…" },
    live: { color: "var(--success, #98c379)", label: sess ? `${sess.shell} · ${sess.mode === "pipe" ? "pipe" : "pty"}${sess.mode !== "pipe" && !sess.canResize ? " · fixed size" : ""}` : "live" },
    exited: { color: "var(--text2)", label: "exited" },
    error: { color: "var(--error)", label: "disconnected" },
    unauthorized: { color: "var(--error)", label: "unauthorized ⚿" },
  };

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center p-3 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 14 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ type: "spring", stiffness: 330, damping: 30 }}
                className="w-[95vw] h-[95vh] rounded-2xl flex flex-col pointer-events-auto overflow-hidden"
                style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>
                <style>{SCROLLBAR_CSS}</style>

                {/* header: repo picker + command launcher + actions */}
                <div className="flex items-center gap-3 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>▶ Terminal</span>
                  <div className="relative">
                    <button onClick={() => { setRepoOpen((o) => !o); setCmdsOpen(false); }} className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg" style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }}>
                      <span className="font-medium">{repoRef ? repoName(repoRef.root) : "pick a repo"}</span><span className="t-dim2">▼</span>
                    </button>
                    {repoOpen && (
                      <div className="absolute left-0 mt-1 rounded-lg text-[11px] shadow-2xl flex flex-col" style={{ zIndex: 30, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", minWidth: 320, maxHeight: 420, overflow: "hidden" }}>
                        <input autoFocus value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)} placeholder="filter repos…" className="m-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0" style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                        <div className="agx-scroll overflow-y-auto pb-1" style={{ minHeight: 0 }}>
                          {repos.filter((r) => { const q = repoQuery.trim().toLowerCase(); return !q || (r.name + " " + r.branch).toLowerCase().includes(q); }).map((r) => {
                            const live = sessionsFor(r.root).some((s) => s.status === "live");
                            return (
                              <button key={r.root} onClick={() => { setRoot(r.root); setRepoOpen(false); setRepoQuery(""); }} className="w-full text-left px-2.5 py-1.5 flex items-center gap-2" style={{ background: r.root === root ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
                                <span className="min-w-0 flex-1 truncate font-medium" style={{ color: "var(--text)" }}>{r.name}{live && <span title="live shell" style={{ color: "var(--success, #98c379)" }}> ●</span>}</span>
                                <span className="shrink-0 truncate t-dim2 text-[9.5px]" style={{ maxWidth: 150 }}>{r.branch}</span>
                              </button>
                            );
                          })}
                          {!repos.length && <div className="px-3 py-2 t-dim2">no repos seen yet</div>}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* project commands: Makefile targets + package scripts, explained */}
                  <div className="relative">
                    <button onClick={() => { setCmdsOpen((o) => !o); setRepoOpen(false); }} disabled={!nCmds}
                      title="Ready-to-run project commands: Makefile targets & package scripts, with what each one does"
                      className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg font-medium"
                      style={{ color: nCmds ? "var(--primary-hover)" : "var(--text2)", background: "color-mix(in srgb, var(--primary) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)", opacity: nCmds ? 1 : 0.5 }}>
                      ⚙ commands{nCmds ? ` (${nCmds})` : cmds ? " (none)" : " …"}<span className="t-dim2">▼</span>
                    </button>
                    {cmdsOpen && cmds && (
                      <div className="absolute left-0 mt-1 rounded-lg text-[11px] shadow-2xl flex flex-col" style={{ zIndex: 30, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", width: 460, maxHeight: 480, overflow: "hidden" }}>
                        <div className="agx-scroll overflow-y-auto py-1" style={{ minHeight: 0 }}>
                          {/* commands come from the whole selected project — the
                              root Makefile/package.json plus any in subfolders —
                              so each folder gets its own labelled group */}
                          {groupByDir(cmds.make).map(([dir, list]) => (
                            <div key={"m:" + dir}>
                              <div className="px-3 pt-1.5 pb-0.5 t-dim2 text-[9.5px] uppercase tracking-wider">make — {dir ? `${dir}/Makefile` : "Makefile"}</div>
                              {list.map((c) => <CommandRow key={"m:" + dir + ":" + c.name} c={c} onRun={run} />)}
                            </div>
                          ))}
                          {groupByDir(cmds.scripts).map(([dir, list]) => (
                            <div key={"s:" + dir}>
                              <div className="px-3 pt-2 pb-0.5 t-dim2 text-[9.5px] uppercase tracking-wider">scripts — {dir ? `${dir}/package.json` : "package.json"}</div>
                              {list.map((c) => <CommandRow key={"s:" + dir + ":" + c.name} c={c} onRun={run} />)}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1 overflow-x-auto agx-scroll">
                    {QUICK.map((q) => (
                      <button key={q} onClick={() => run(q)} disabled={!root || IS_DEMO || disabled} className="text-[10px] px-2 py-1 rounded-md whitespace-nowrap" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>{q}</button>
                    ))}
                  </div>

                  <div className="ml-auto flex items-center gap-1.5 shrink-0">
                    <span onClick={status === "unauthorized" ? reauthPrompt : undefined}
                      className={`flex items-center gap-1.5 text-[10px] t-dim2 mr-1 ${status === "unauthorized" ? "cursor-pointer" : ""}`}
                      title={status === "unauthorized" ? "this server needs an access token — click to enter it" : "shell status"}>
                      <span style={{ color: statusDot[status].color }}>●</span>{statusDot[status].label}
                    </span>
                    <button onClick={splitPane} disabled={!root || IS_DEMO || disabled || paneIds.length >= 4} title="show another shell beside this one" className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", opacity: paneIds.length >= 4 ? 0.45 : 1 }}>⊞ split</button>
                    <button onClick={restart} disabled={!root || IS_DEMO || disabled} title="kill this shell and start a fresh one" className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>⟲ restart</button>
                    <button onClick={() => sess?.term.clear()} className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)" }}>clear</button>
                    <button onClick={onClose} className="text-[18px] leading-none px-2 t-dim2 hover:opacity-70">✕</button>
                  </div>
                </div>

                {/* shells open in this repo — scrolls, so the count can grow */}
                {!IS_DEMO && !disabled && (
                  <div className="shrink-0 flex items-center gap-1 px-3 py-1 border-b overflow-x-auto agw-noscrollbar" style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
                    {tabs.map((t) => {
                      const shown = paneIds.includes(t.id);
                      const focused = t.id === paneIds[focusIdx];
                      return (
                        <div key={t.id} onClick={() => showOnly(t.id)}
                          className="group flex items-center gap-1.5 px-2 py-1 rounded-md text-[10.5px] cursor-pointer shrink-0"
                          style={focused
                            ? { background: "color-mix(in srgb, var(--primary) 20%, transparent)", color: "var(--primary-hover)" }
                            : shown
                              ? { background: "color-mix(in srgb, var(--bg3) 55%, transparent)", color: "var(--text2)" }
                              : { color: "var(--text3)" }}>
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.status === "live" ? "var(--success, #98c379)" : t.status === "error" ? "var(--error)" : "color-mix(in srgb, var(--text4) 60%, transparent)" }} />
                          <span>{t.title}</span>
                          <button onClick={(e) => { e.stopPropagation(); closeShell(t.id); }} className="opacity-0 group-hover:opacity-100 leading-none px-0.5" title="close shell">✕</button>
                        </div>
                      );
                    })}
                    <button onClick={addShell} className="shrink-0 px-2 py-1 rounded-md text-[10.5px]" style={{ color: "var(--text3)" }} title="new shell in this repo">+</button>
                  </div>
                )}

                {/* the terminals — one slot per visible pane */}
                <div className="flex-1 min-h-0 relative" style={{ background: "var(--bg)" }}>
                  <div className="absolute inset-0 p-1.5 grid gap-1.5"
                    style={{
                      gridTemplateColumns: paneIds.length > 1 ? "1fr 1fr" : "1fr",
                      gridTemplateRows: paneIds.length > 2 ? "1fr 1fr" : "1fr",
                    }}>
                    {paneIds.map((id, i) => (
                      <div key={id}
                        ref={(el) => { paneRefs.current[i] = el; }}
                        onMouseDown={() => setFocusIdx(i)}
                        className="min-w-0 min-h-0 rounded-lg overflow-hidden px-2 py-1"
                        style={{
                          border: paneIds.length > 1 && i === focusIdx
                            ? "1px solid color-mix(in srgb, var(--primary) 45%, transparent)"
                            : "1px solid transparent",
                        }} />
                    ))}
                  </div>
                  {(IS_DEMO || disabled) && (
                    <div className="absolute inset-0 flex items-center justify-center text-[12px] t-dim2" style={{ background: "color-mix(in srgb, var(--bg) 80%, transparent)" }}>
                      {IS_DEMO ? "the terminal is disabled in the demo — run agentglass locally for a real shell" : "terminal disabled (AGENTGLASS_TERMINAL_DISABLED=1)"}
                    </div>
                  )}
                </div>

                {/* status line */}
                <div className="shrink-0 flex items-center gap-3 px-4 py-1.5 border-t text-[9.5px] t-dim2" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <span>real shell — Ctrl+C, Ctrl+R, Tab-complete, vim/htop all work · sessions survive closing this panel · Shift+Esc closes it</span>
                  <span className="ml-auto">{sess ? `${sess.term.cols}×${sess.term.rows}` : ""}</span>
                </div>
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}

/** Bucket commands by the project folder they belong to, repo root first. */
function groupByDir(list: ProjectCommand[]): [string, ProjectCommand[]][] {
  const by = new Map<string, ProjectCommand[]>();
  for (const c of list) {
    const dir = c.dir ?? "";
    if (!by.has(dir)) by.set(dir, []);
    by.get(dir)!.push(c);
  }
  return [...by.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
}

function CommandRow({ c, onRun }: { c: ProjectCommand; onRun: (cmd: string) => void }) {
  return (
    <button onClick={() => onRun(c.cmd)} title={c.cmd} className="w-full text-left px-3 py-1.5 flex items-baseline gap-2.5 hover:bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]">
      <span className="shrink-0 font-medium" style={{ color: "var(--primary-hover)", fontFamily: TERM_FONT }}>{c.cmd}</span>
      <span className="min-w-0 flex-1 truncate t-dim2">{c.desc || "—"}</span>
    </button>
  );
}
