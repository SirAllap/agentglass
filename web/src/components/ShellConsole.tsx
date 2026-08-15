/**
 * A real shell, with the command already typed and the Enter left to you.
 *
 * Built for installing a missing dependency; it turned out to be the shape any
 * command with consequences wants, so tidying a git checkout uses it too. The
 * name says shell rather than install because there are two callers now and
 * the second one deletes branches.
 *
 * The alternative was an Install button, and it is the wrong shape for this
 * job in three ways. Half of these installs need `sudo`, and an app that asks
 * for a password is an app you have to trust with it — here the password is
 * typed by the owner of the machine into their own shell, and never travels.
 * A command that runs before you have read it is a command you did not agree
 * to; this one sits at the prompt until you press a key. And when it fails, it
 * fails in front of you with its whole output, instead of being flattened into
 * a toast that says "install failed".
 *
 * The guess is allowed to be wrong precisely because of this. See the note at
 * the top of shared/deps.ts: a package name that is right most of the time
 * beats a link that is right always, as long as being wrong costs one
 * keystroke to correct rather than installing the wrong thing.
 */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ptyWsUrl } from "../lib/api.ts";
import { termOptions } from "../lib/termPrefs.ts";
// The panel's own palette reader, reused rather than reimplemented: a console
// that drew itself in slightly different colours would look like a screenshot
// pasted into the settings page.
import { themeFromCss } from "./TerminalPanel.tsx";
import { isRemoteScript } from "../../../shared/deps.ts";
import { CloseButton } from "./CloseButton.tsx";

export function ShellConsole({ command, cwd, onClose }: {
  /** Typed into the shell verbatim, and never followed by a newline. */
  command: string;
  /** Where the shell opens. Which checkout hardly matters — `apt-get install`
   *  behaves the same anywhere — and the server vets it regardless, falling
   *  back to its own choice for a path it will not accept. */
  cwd: string;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"opening" | "ready" | "failed">("opening");
  const [copied, setCopied] = useState(false);
  const remote = isRemoteScript(command);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const tp = termOptions();
    const term = new Terminal({
      fontFamily: tp.fontFamily,
      fontSize: Math.max(11, tp.fontSize - 1),
      lineHeight: tp.lineHeight,
      cursorBlink: true,
      cursorStyle: tp.cursorStyle,
      // Small on purpose: this is a console for one command, not a workspace.
      // A long build still scrolls, and the terminal panel is a click away for
      // anything that deserves room.
      scrollback: 600,
      theme: themeFromCss(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try { fit.fit(); } catch { /* not laid out yet; the observer below refits */ }

    /* `fresh`: a shell of our own, never the tmux session the desk was last in.
       This console pre-types a command and leaves the Enter to you — and on a
       machine where the server resumed that session, the command would have
       been typed into whatever pane the terminal view was showing. */
    const ws = new WebSocket(ptyWsUrl(cwd, term.cols, term.rows, undefined, false, undefined, true, true));
    let typed = false;
    /**
     * Our own teardown is not a failure, and it has to say so.
     *
     * React mounts an effect, unmounts it and mounts it again in development,
     * so the first socket is closed while still CONNECTING — and its `onclose`
     * fired into the same state the second, healthy socket was about to use.
     * The console reported "the shell could not be opened" over a shell that
     * had opened perfectly well a moment later. The flag is not a workaround
     * for the double mount: any close WE cause is by definition not the
     * server refusing us, and reporting it as one would be wrong in production
     * too, on every close of the panel.
     */
    let disposed = false;
    const send = (d: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "in", d })); };

    // Shell output arrives as binary and control frames as JSON — the panel's
    // protocol, read rather than guessed at. Assuming a `{t:"out"}` that does
    // not exist bought a console that connected happily and stayed blank.
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") { term.write(new Uint8Array(ev.data as ArrayBuffer)); return; }
      let msg: { t?: string; mode?: string };
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t !== "ready" || typed) return;
      /**
       * Type it when the shell says it is listening, and not before.
       *
       * Sending on `onopen` loses the text: the socket is up before the shell
       * is, and anything written meanwhile is read by the terminal driver and
       * dropped. `ready` is the server saying the pty exists — the moment a
       * person would have started typing.
       */
      typed = true;
      // A pipe-mode shell has no pty, so nothing echoes what is typed and the
      // whole gesture is invisible. Better to say so than to leave a command
      // sitting in a terminal that will never show it.
      if (msg.mode === "pipe") {
        term.writeln("\x1b[2m(no pty on this host: the command below will not echo as you type — copy it and run it in your own terminal.)\x1b[0m");
      }
      /**
       * A beat after `ready`, not on it.
       *
       * `ready` means the pty exists, which is a moment BEFORE the login shell
       * has finished sourcing its rc and drawn a prompt. Typing into that gap
       * still works — the driver buffers it — but the buffered text is echoed
       * once raw and then redrawn by readline at the prompt, so the command
       * appears twice with the rc's output between the copies. Waiting lets the
       * prompt land first and the line is written once, where it belongs.
       */
      setTimeout(() => {
        if (disposed) return;
        send(command);
        setState("ready");
        term.focus();
      }, 350);
    };
    ws.onerror = () => { if (!disposed) setState("failed"); };
    ws.onclose = () => { if (!disposed) setState((s) => (s === "ready" ? s : "failed")); };

    const off = term.onData((d) => send(d));
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* hidden */ }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    });
    ro.observe(el);

    return () => {
      disposed = true;
      ro.disconnect();
      off.dispose();
      // Closed rather than left running: this shell exists for one command, and
      // a settings pane that quietly accumulates pseudo-terminals every time it
      // is opened is a leak nobody would think to look for.
      try { ws.close(); } catch { /* already gone */ }
      term.dispose();
    };
    // Deliberately once: re-running would tear down a shell mid-install.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mt-2 rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
      {/* The command, readable and copyable before it is anything else. The
          copy button is the way out for someone who would rather run it in
          their own terminal, which is a preference worth respecting. */}
      <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ background: "color-mix(in srgb, var(--bg3) 45%, transparent)" }}>
        <code className="flex-1 min-w-0 truncate text-[11px]" style={{ color: "var(--text)" }} title={command}>{command}</code>
        <button
          onClick={() => { void navigator.clipboard?.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}
          className="shrink-0 text-[10px] px-2 py-0.5 rounded"
          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
          {copied ? "copied" : "copy"}
        </button>
        <CloseButton onClick={onClose} style={{ color: "var(--text3)" }} title="Close this console" className="shrink-0" />
      </div>
      <div className="px-2.5 py-1 text-[10px]" style={{ color: "var(--text3)", borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>
        {state === "failed"
          ? "The shell could not be opened — copy the command and run it yourself."
          : state === "opening"
            ? "Opening a shell…"
            : remote
              // A different sentence for a different decision. `apt-get install`
              // asks you to trust a distribution you already trust; this asks
              // you to run a script you cannot read until it has been fetched.
              // Both are typed and not run, but only one of them is a choice.
              ? "It is typed, not run. This downloads a script and runs it — the project's own recommended install. Press Enter to accept that."
              : "It is typed, not run. Press Enter when you have read it."}
      </div>
      <div ref={host} style={{ height: 190, background: "var(--bg)" }} />
    </div>
  );
}
