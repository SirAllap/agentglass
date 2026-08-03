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
import { FitAddon } from "@xterm/addon-fit";
import { Portal } from "./Portal.tsx";
import { ptyWsUrl } from "../lib/api.ts";
import { themeFromCss } from "./TerminalPanel.tsx";

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
      fontSize: 12.5,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono")
        || '"SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace',
      theme: themeFromCss(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const ws = new WebSocket(ptyWsUrl(peek.root, term.cols, term.rows, peek.path));
    ws.binaryType = "arraybuffer";
    const send = (s: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(s); };

    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        // Control frames are JSON; anything else is output.
        try {
          const m = JSON.parse(e.data) as { t?: string; error?: string };
          if (m.t === "fatal") { setError(m.error || "the terminal could not start"); return; }
        } catch { /* not a control frame — it is output */ }
        term.write(e.data);
        return;
      }
      term.write(new Uint8Array(e.data as ArrayBuffer));
    };
    ws.onerror = () => setError("lost the connection to the terminal");
    // Closing the editor closes the window: `:q` is how you leave a file, and
    // having to then close a dead pane by hand would be a second gesture for
    // one intention.
    // The editor exited — `:q`, or it never started. Ours is a re-render or an
    // unmount, and must not be reported as the user finishing with the file.
    ws.onclose = () => { if (!ours) closeRef.current(); };

    const onData = term.onData((d) => send(d));
    const ro = new ResizeObserver(() => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    });
    ro.observe(el);
    // The point of opening it is to type in it.
    requestAnimationFrame(() => term.focus());

    return () => {
      ours = true;
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
