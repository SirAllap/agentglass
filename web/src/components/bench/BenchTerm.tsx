/*
 * One tab of the bench, as a terminal.
 *
 * Every tab that runs something is this: a shell, an agent CLI, an editor on a
 * file. What changes is what the tmux session was told to run — the server
 * decides that from the query (see engineBenchArgv), and from here it is one
 * socket and one xterm either way.
 *
 * The tab is bound to a SESSION, not to this socket. Closing the window
 * disconnects; the session keeps running on the engine and the next connection
 * with the same slot reattaches to it. That is the whole promise of the bench,
 * and it is why this component is allowed to be as small as it is: persistence
 * is tmux's job, not React's.
 */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ptyWsUrl } from "../../lib/api.ts";
import { termOptions } from "../../lib/termPrefs.ts";
import { isAppChord } from "../../lib/termKeys.ts";
import { themeFromCss } from "../TerminalPanel.tsx";

export function BenchTerm({ root, slot, view, line, edit, agent, type, active, onTitle }: {
  root: string;
  /** Which bench session this tab is. See engineBenchArgv. */
  slot: number;
  /** A file for the session to open instead of a shell. */
  view?: string;
  line?: number;
  edit?: boolean;
  /** A single-use ticket for an agent CLI to start in this session. */
  agent?: string;
  /**
   * Text put at the prompt, with the Enter left to you.
   *
   * The recipe's shape, borrowed from the install console: a command that runs
   * before you have read it is a command you did not agree to. Sent once, on
   * the first `ready` of this socket — reattaching later must not retype it
   * into the middle of whatever is running.
   */
  type?: string;
  /**
   * Is this the tab on screen, in a window that is open?
   *
   * It decides the CARET, and that is not a nicety. Tabs stay mounted when they
   * are not showing, so nothing about being rendered says "the keys are yours" —
   * and a window you have just opened over a shell, with the focus still behind
   * it, is worse than no window: the Ctrl+C you typed to clear the prompt in
   * here went to whatever had the focus out there. It did, and it stopped an
   * agent mid-run.
   */
  active?: boolean;
  /** What the session turned out to be, when the server says so — so a tab can
   *  stop saying "starting…" without the window polling for it. */
  onTitle?: (title: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  /** The live terminal, so the focus effect below can reach it without tearing
   *  the socket down and building it again. */
  const termRef = useRef<Terminal | null>(null);
  /** Refit-and-report, held so the tab becoming visible can call it: a tab that
   *  was hidden while the window was resized has a stale grid. */
  const settleRef = useRef<null | (() => void)>(null);
  const [state, setState] = useState<"opening" | "live" | "gone">("opening");
  const [why, setWhy] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const tp = termOptions();
    const term = new Terminal({
      fontFamily: tp.fontFamily,
      fontSize: tp.fontSize,
      lineHeight: tp.lineHeight,
      cursorBlink: true,
      cursorStyle: tp.cursorStyle,
      /* Small, because tmux is holding the real scrollback: this buffer only
         has to carry what arrived since the window opened. Asking xterm for a
         hundred thousand lines per tab is how a window with six tabs becomes
         the reason the app feels heavy. */
      scrollback: 2000,
      theme: themeFromCss(),
      allowProposedApi: true,
    });
    /*
     * The app's chords are the app's, even in here.
     *
     * Measured, and it was a mess to watch: with the caret in a bench terminal,
     * Ctrl+Shift+P went to the PTY as well as to the app, so the palette opened
     * AND the shell got the escape sequence — and with nvim in the tab, the
     * next thing typed went into somebody's buffer. Returning false keeps the
     * keystroke out of the pty; App's window listener still sees it, so the
     * palette (and this window's own chord) still work from inside a tab.
     *
     * Read from the live bindings rather than listed, so rebinding moves both
     * halves at once — see termKeys.isAppChord.
     */
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      return !isAppChord(e);
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    try { fit.fit(); } catch { /* not laid out yet; the observer refits */ }

    const ws = new WebSocket(ptyWsUrl(root, term.cols, term.rows, view, !!edit, agent, false, false, line ?? 0, slot));
    ws.binaryType = "arraybuffer";
    /* Our own teardown is not a failure. React mounts, unmounts and mounts
       again in development, and the first socket's close used to be reported
       over the second, healthy one — the same trap ShellConsole documents. */
    let disposed = false;
    let typed = false;

    const send = (d: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "in", d })); };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") { term.write(new Uint8Array(ev.data as ArrayBuffer)); return; }
      let msg: { t?: string; error?: string; mode?: string };
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === "ready") {
        setState("live");
        settle();
        setTimeout(() => { if (!disposed) settle(); }, 150);
        setTimeout(() => { if (!disposed) settle(); }, 500);
        onTitle?.(view ? (view.split("/").pop() ?? "file") : agent ? "agent" : "shell");
        /*
         * A redraw, once, a beat after the session says it is up.
         *
         * A tmux client that attaches while its pane is not visible has nothing
         * to paint from, and this app has met that before: a pane nobody was
         * looking at handed back a blank capture. Ctrl-L costs one keystroke
         * and answers it for a shell; for tmux it is the refresh that follows.
         */
        setTimeout(() => { if (!disposed) { term.focus(); } }, 120);
        /* A beat after `ready`, not on it: `ready` means the pty exists, which
           is before the shell has drawn a prompt, and text typed into that gap
           is echoed once raw and then again by readline. */
        if (type && !typed) {
          typed = true;
          setTimeout(() => { if (!disposed) send(type); }, 400);
        }
        return;
      }
      if (msg.t === "fatal") { setWhy(msg.error ?? "the session could not be opened"); setState("gone"); }
    };
    ws.onerror = () => { if (!disposed) setState((s) => (s === "live" ? s : "gone")); };
    ws.onclose = () => {
      if (disposed) return;
      setState((s) => (s === "live" ? "gone" : s));
    };

    const off = term.onData(send);
    /*
     * Measure again and SAY SO, whatever the observer did.
     *
     * The bug this closes looked like a broken window: minimise, open again, and
     * the pane was drawn 80×24 in the corner of a window five times that size.
     * The reason is a race with no error in it — ResizeObserver fires once the
     * moment it observes, which here is while the socket is still CONNECTING, so
     * the resize was dropped by the `readyState` guard; the element never
     * changed size afterwards, so nothing fired again, and tmux kept the size
     * the URL had carried.
     *
     * Twice more after `ready`, because the window is still animating in when
     * the session says hello and a fit taken mid-transform measures a box that
     * is about to change.
     */
    const settle = () => {
      try { fit.fit(); } catch { /* not laid out yet */ }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    };
    settleRef.current = settle;
    const ro = new ResizeObserver(settle);
    ro.observe(el);

    return () => {
      disposed = true;
      ro.disconnect();
      off.dispose();
      /* Closed, and that is not the same as killed: the socket goes, the tmux
         session stays. Leaving the socket open for a tab nobody is looking at
         would keep a client attached to that session — which is what makes two
         clients mirror, the bug this app has already paid for twice. */
      try { ws.close(); } catch { /* already gone */ }
      term.dispose();
      if (termRef.current === term) termRef.current = null;
    };
    // Re-runs only when the tab is pointed somewhere else. A resize must never
    // reach this list: it would tear down a live session mid-command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, slot, view, line, edit, agent, type]);

  /*
   * The caret follows the tab you are looking at.
   *
   * Deferred a frame: the tab becomes visible in the same commit this runs in,
   * and xterm refuses focus on an element that is still `visibility: hidden`.
   */
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      termRef.current?.focus();
      // The window may have been resized while this tab was hidden; the
      // observer does not fire for a box that never changed.
      settleRef.current?.();
    }, 60);
    return () => clearTimeout(t);
  }, [active, state]);

  return (
    <div className="relative w-full h-full" style={{ background: "var(--bg)" }}>
      <div ref={host} className="w-full h-full" />
      {state !== "live" && (
        <div className="absolute inset-x-0 bottom-0 px-3 py-1.5 text-[10.5px]"
          style={{ color: state === "gone" ? "var(--error)" : "var(--text3)", background: "color-mix(in srgb, var(--bg2) 92%, transparent)" }}>
          {state === "opening"
            ? "Attaching to this tab's session…"
            : (why ?? "This tab's session ended. Close the tab, or open a new one.")}
        </div>
      )}
    </div>
  );
}
