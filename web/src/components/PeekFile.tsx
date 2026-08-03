// A file, in an editor, without leaving the panel you were reading.
//
// The gap this closes: you are looking at a diff or a filtered list of changed
// files, you want to see one of them whole, and the only route was to find a
// terminal, get it into the right worktree, and type the path — by which point
// you have lost the list you were working from. It opens over the panel, on the
// file you clicked, and closes back to it.
//
// Its own PTY rather than a tab in the terminal view, on purpose: the terminal
// you have open is in whatever directory you left it in, and a pull request's
// file lives in a specific checkout. Borrowing that session would mean either
// moving it — losing your place — or opening the wrong file with a confident
// path.
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
// The stylesheet the renderer needs. It arrives via TerminalPanel today, but a
// component that cannot draw without it should say so itself.
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Portal } from "./Portal.tsx";
import { ptyWsUrl } from "../lib/api.ts";
import { themeFromCss } from "./TerminalPanel.tsx";
import { answerDecrqm } from "../lib/xtermDecrqm.ts";
import { termOptions } from "../lib/termPrefs.ts";

export type Peek = { root: string; path: string; label?: string };

export function PeekFile({ peek, onClose }: { peek: Peek; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * `onClose` is a new function on every render of the parent, and it was in
   * this effect's dependencies — so the whole terminal was torn down and rebuilt
   * on any re-render, and the teardown's own `ws.close()` fired `onclose`, which
   * called `onClose`. The window opened, the parent re-rendered, and it shut
   * itself: "closed before the connection is established" in the console.
   *
   * The callback lives in a ref so the effect depends only on which file it is
   * showing, and a flag tells our own teardown apart from the editor exiting.
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let ours = false;
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      // The terminal's own resolved preferences, not a font stack written out
      // again here. Mine omitted the Nerd Font entirely, so every glyph a
      // statusline draws came out as a tofu box — and it would have drifted
      // from the terminal's size and family the first time either changed.
      ...termOptions(),
      theme: themeFromCss(),
      scrollback: 5000,
    });
    // Registered before anything is written: the first thing an editor sends is
    // the mode query xterm 6.0.0 dies on.
    const decrqm = answerDecrqm(term as never);
    // No WebGL renderer here, unlike the panel. That one draws from a texture
    // atlas built out of a single face, which is exactly where a Nerd Font
    // glyph borrowed from the back of the stack goes missing; the DOM renderer
    // falls back per glyph the way the browser does everywhere else. A file
    // viewer is not the surface that needs the throughput.
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    // After a frame: this dialog is fixed-positioned and has no size in the tick
    // it mounts, so a fit here measures zero and the pty is created with a
    // window an editor cannot draw into.
    requestAnimationFrame(() => fit.fit());

    const ws = new WebSocket(ptyWsUrl(peek.root, term.cols, term.rows, peek.path));
    ws.binaryType = "arraybuffer";

    /*
     * The protocol the terminal panel already speaks, rather than a second one
     * invented here.
     *
     * Input goes as `{t:"in", d}` — raw text on the wire is not a frame this
     * server reads, so every keystroke was dropped, and `:q` never reached the
     * editor. Output arrives binary. And nothing is sent before `{t:"ready"}`:
     * a resize that lands before the pty exists is a resize the pty never sees,
     * which is how a full-screen editor ends up drawing into a zero-row
     * terminal and showing nothing at all.
     */
    let ready = false;
    const pending: string[] = [];
    const send = (d: string) => {
      if (!ready || ws.readyState !== WebSocket.OPEN) { pending.push(d); return; }
      ws.send(JSON.stringify({ t: "in", d }));
    };
    const sendSize = () => {
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") { term.write(new Uint8Array(e.data as ArrayBuffer)); return; }
      let f: { t?: string; mode?: string; error?: string };
      // A string that is not a frame is not output on this socket; dropping it
      // is better than printing the server's own JSON into the file you opened.
      try { f = JSON.parse(e.data); } catch { return; }
      if (f.t === "ready") {
        ready = true;
        // The size the pty was created with came from a fit that ran before the
        // dialog had been laid out, so the real one is sent the moment there is
        // somebody to receive it.
        fit.fit();
        sendSize();
        for (const d of pending.splice(0)) ws.send(JSON.stringify({ t: "in", d }));
        if (f.mode === "pipe") term.writeln("\x1b[2m(no pty on this host: an editor cannot draw here. Install python3 and reopen.)\x1b[0m");
        return;
      }
      if (f.t === "fatal") { setError(f.error || "the terminal could not start"); return; }
      // `exit` is the editor finishing — `:q`. The socket closes right after,
      // and `onclose` is what takes the window down.
    };
    ws.onerror = () => setError("lost the connection to the terminal");
    // The editor exited — `:q`, or it never started. Ours is a re-render or an
    // unmount, and must not be reported as the user finishing with the file.
    ws.onclose = () => { if (!ours) closeRef.current(); };

    const onData = term.onData((d) => send(d));
    const ro = new ResizeObserver(() => { fit.fit(); sendSize(); });
    ro.observe(el);
    // The point of opening it is to type in it.
    requestAnimationFrame(() => term.focus());

    return () => {
      ours = true;
      decrqm.dispose();
      ro.disconnect();
      onData.dispose();
      try { ws.close(); } catch { /* already gone */ }
      term.dispose();
    };
  }, [peek.root, peek.path]);

  return (
    <Portal>
      {/* Escape belongs to the editor — it is a modal editor, and stealing it
          would make the pane unusable for the thing it opened. The backdrop and
          the button are the ways out that do not collide. */}
      <div className="fixed inset-0" style={{ zIndex: 9998, background: "color-mix(in srgb, var(--bg) 62%, transparent)" }}
        onClick={onClose} />
      <div role="dialog" aria-label={`Viewing ${peek.path}`}
        className="fixed rounded-xl overflow-hidden flex flex-col"
        style={{
          zIndex: 9999, top: "6vh", bottom: "6vh", left: "8vw", right: "8vw",
          background: "var(--bg)",
          border: "1px solid color-mix(in srgb, var(--text) 22%, transparent)",
          boxShadow: "0 40px 90px -24px var(--shadow)",
        }}>
        <div className="flex items-center gap-2 px-3 py-1.5 shrink-0 text-[11px]"
          style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", background: "var(--bg2)" }}>
          <span className="min-w-0 truncate" style={{ color: "var(--text)" }}>{peek.label ?? peek.path}</span>
          <span className="ml-auto shrink-0" style={{ color: "var(--text3)" }}>:q to close</span>
          <button onClick={onClose} aria-label="Close" className="agx-btn shrink-0 px-1.5 rounded"
            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 18%, transparent)" }}>✕</button>
        </div>
        {error ? (
          <div className="p-4 text-[11.5px]" style={{ color: "var(--error)" }}>{error}</div>
        ) : (
          <div ref={host} className="flex-1 min-h-0" style={{ padding: 6 }} />
        )}
      </div>
    </Portal>
  );
}
