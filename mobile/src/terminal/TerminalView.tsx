/*
 * A live terminal on the phone: the WebView, the socket, and the wire between.
 *
 * The socket lives here rather than in the page, because the upgrade to
 * `/terminal/pty` needs an `Origin` header and only React Native's WebSocket
 * takes one (live.ts explains why the server insists). It also means a WebView
 * reload — which happens for reasons of its own — does not take the shell with
 * it.
 *
 * The protocol is the dashboard's, unchanged, and now written down in one
 * place instead of three — `PtyServerFrame` and `PtyClientFrame` in
 * shared/types.ts. Binary frames are raw PTY bytes and are the one thing that
 * cannot be in a contract: they have no envelope, which is the point of them.
 *
 * Bytes reach the page base64-encoded, because decoding a PTY frame as UTF-8
 * on the way through breaks any multi-byte character that lands across a frame
 * boundary — permanently, and in a TUI that is most of the box drawing.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { PtyClientFrame, PtyServerFrame } from "../../../shared/types.ts";
import { b64Encode } from "../lib/b64.ts";
import type { Host } from "../lib/host.ts";
import { C, type Palette } from "../theme.ts";
import { terminalDocument, terminalTheme } from "./terminal-html.ts";
import { createCoalescer, type Coalescer } from "./writeCoalescer.ts";

export type TerminalState = "connecting" | "live" | "gone";

export interface TerminalHandle {
  /** Send bytes as if they had been typed. The key bar's only route in. */
  send: (bytes: string) => void;
  /**
   * Ask the machine's tmux for something, on the socket this pane is on.
   *
   * Separate from `send` because it is the opposite kind of thing: `send` puts
   * bytes on a shell's stdin, this asks the SERVER to act — and the server is
   * what decides what that means. The only caller today is the `+`, whose whole
   * security argument is that the client names an intent and never a command.
   */
  command: (frame: PtyClientFrame) => void;
  focus: () => void;
}

interface Props {
  host: Host;
  /** tmux's id for the pane to show, `%58`. Without one the server opens a new
   *  shell in `root` instead — which is a different feature, not a fallback. */
  pane?: string;
  root?: string;
  /** Reflow the tmux window to this client. See attachArgvFor on the server. */
  fit?: boolean;
  /**
   * A finger touched the pane and did not drag it.
   *
   * Decided inside the page, because the WebView swallows the gesture and a
   * Pressable wrapped around it would take the drag away from the scroller.
   * What arrives is the intent and never a coordinate — the screen above uses
   * it to hand the keyboard over, which is the only thing a tap on something
   * you are reading can reasonably mean here.
   */
  onTap?: () => void;
  /** How many columns to show. See terminal-html.ts — this is what decides
   *  whether you see the pane or the left-hand corner of it. */
  columns: number;
  palette: Palette;
  onState: (state: TerminalState, detail?: string) => void;
  /**
   * What the server found on the other end of this socket.
   *
   * It reports tmux's real prefix key here, and that is not a nicety: the bar
   * needs it. `C-b` is the default and the first machine this was pointed at
   * uses `C-f`, so a hardcoded prefix button is one that silently does nothing
   * on any configured machine.
   */
  onTmux?: (info: { prefix?: string[]; session?: string }) => void;
  /**
   * The line currently being typed on the pane, whenever it changes.
   *
   * `null` means the page could not tell — it found no prompt marker on the
   * cursor's row, so it is refusing to guess rather than handing up a line of
   * output. A caller that seeds a field from this must treat `null` as "leave
   * it alone", never as "empty".
   *
   * `exact` is whether that text is something an EDIT may be computed against.
   *
   * True when the marker was on the cursor's own row, which is the case the
   * mirror was built for: the field is the line and every keystroke goes on as
   * the difference. False when the line was rejoined from the rows an agent
   * wrapped it onto — the text is right to show and its LENGTH is not
   * trustworthy, because a screen cannot say whether a break was a wrap, a word
   * wrap that ate its space, or a newline. See boxedLine in terminal-html.ts.
   */
  onLine?: (text: string | null, exact: boolean) => void;
  /** A window this client asked the server to open, and the pane it landed on.
   *  The `+` uses it to put the user inside the tab they just made rather than
   *  leaving them to find it in a strip that repolls every two seconds. */
  onOpened?: (opened: { pane: string; window: string; cwd: string } | { error: string }) => void;
  /** How wide and tall the tmux window really is, once the server has said.
   *  Without a fit this is the desk's size, and the difference between it and
   *  what is on screen is exactly what is missing. */
  onGrid?: (grid: { cols: number; rows: number }) => void;
  /**
   * The window changed under this attach — its size now, and whether this
   * client is still the one it is sized to. `by` says who moved it.
   *
   * `onGrid` above fires exactly once per socket, off `t:"ready"`, and that was
   * the only time the phone ever learned a size. So anything that resized the
   * window after the attach left this screen quoting a dead number with its own
   * "you are seeing 80 of 200" hint suppressed, because `fit` was still true: a
   * fitted UI over a window that is no longer fitted, with nothing on screen to
   * say so. This frame is the second writer, and the one that closes that.
   *
   * Nothing here closes the socket, and that is why the desk sends a frame
   * instead of the obvious `kill-session`. Measured: killing the phone's client
   * leaves the window at 80x24 anyway — the fit is a `manual` size on the
   * *shared* window and outlives the client that asked for it — so a kill is
   * strictly the same resize plus somebody mid-command left on "Disconnected".
   */
  onPane?: (pane: { cols: number; rows: number; fit: boolean; by?: string }) => void;
}

/** A client frame out, as a string. The client half of this protocol had no
 *  declaration either — see PtyClientFrame — so every send here was its own
 *  object literal that nothing could disagree with. */
const ptyFrame = (frame: PtyClientFrame): string => JSON.stringify(frame);

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  { host, pane, root, fit, columns, palette, onState, onTmux, onLine, onGrid, onPane, onOpened, onTap }, ref,
) {
  const webview = useRef<WebView>(null);
  const socket = useRef<WebSocket | null>(null);
  const ready = useRef(false);
  /** Frames that arrived before the page said it was ready. Dropping them
   *  loses the first screen — which for an attach is the whole point, because
   *  tmux redraws the pane exactly once on connect. */
  const pending = useRef<string[]>([]);
  const size = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 });
  /*
   * Nothing connects until this page has measured itself.
   *
   * The socket used to open immediately, carrying the 80x24 above — a guess,
   * because the WebView has not laid anything out yet. Everything downstream
   * then had to be corrected: tmux resized the window to 24 rows and the pane
   * filled a third of the phone until a second resize arrived, and the first
   * screen tmux painted was for a grid nobody had.
   *
   * Orca reaches the same conclusion from a different architecture and says it
   * plainly — its mobile client carries the viewport in the subscribe params
   * "so the server auto-fits before serializing scrollback (no focus→safeFit
   * race)". It costs the couple of hundred milliseconds the page takes to
   * measure, and it buys a first frame that is already the right shape.
   */
  const [measured, setMeasured] = useState(false);
  const [doc] = useState(() => terminalDocument({ palette, columns }));
  /*
   * Bumped to open a new socket on the same pane.
   *
   * The effect below is keyed on what a connection IS — host, pane, root, fit —
   * and none of those change when a socket merely dies, so nothing reopened it:
   * the screen said "Disconnected" and stayed there. Reported from the phone as
   * "I minimise the app, come back, and the terminal is frozen; I have to tap
   * another tab" — and tapping another tab is exactly a remount, which is why
   * that worked and nothing else did.
   */
  const [attempt, setAttempt] = useState(0);

  /*
   * The palette, as the page's own theme object, recomputed every render.
   *
   * A string and not the palette: `palette` is the app's mutable singleton (see
   * theme.ts), so its identity NEVER changes — an effect that depended on it
   * would fire once and never again, which is precisely the bug this is here to
   * avoid. Serialising is twenty-one keys of JSON per render and gives the
   * effect below an identity that moves exactly when a colour does.
   */
  const themeJson = JSON.stringify(terminalTheme(palette));
  /** The colours in `doc` — the ones a reload of this WebView comes back in —
   *  and the ones it is painted in now. They differ once somebody has changed
   *  theme with this screen open, which is the case the reload has to survive. */
  const baked = useRef(themeJson);
  const painted = useRef(themeJson);

  /*
   * The callbacks, held in refs, and this is not a micro-optimisation.
   *
   * The socket effect below must depend on the PANE and nothing else. When it
   * depended on the callbacks too, an inline arrow at the call site — the
   * ordinary way to write one — changed identity on every render, so the effect
   * tore the socket down and opened a new one; the new one called `onState`,
   * which set state, which re-rendered, which made another arrow. An infinite
   * loop that also spawned a fresh tmux session on the machine every time round.
   *
   * Refs mean the effect always reaches the CURRENT callback while depending on
   * none of them, which is the shape this needs: the socket's lifetime belongs
   * to the pane, not to whoever happens to be listening.
   */
  const handlers = useRef({ onState, onTmux, onLine, onGrid, onPane, onOpened, onTap });
  handlers.current = { onState, onTmux, onLine, onGrid, onPane, onOpened, onTap };

  const inject = useCallback((js: string): void => {
    webview.current?.injectJavaScript(`${js};true;`);
  }, []);

  /**
   * Frames, batched into one crossing of the bridge.
   *
   * `writeMany` rather than a loop of `write` on this side: the expensive part
   * is the injection, not the decode, so twelve frames in one array cost one
   * trip. src/terminal/writeCoalescer.ts holds the rule and the reason for the
   * window; what is here is only the delivery.
   *
   * A ref, and built once: the coalescer holds a timer and a buffer, and one
   * rebuilt on a render would drop whatever it was holding on the floor.
   */
  const bytes = useRef<Coalescer | null>(null);
  if (bytes.current === null) {
    bytes.current = createCoalescer((chunks) => {
      inject(`window.AGX.writeMany(${JSON.stringify(chunks)})`);
    });
  }

  const push = useCallback((b64: string): void => {
    // Before the page says `ready` there is nothing to write TO, so those go on
    // the queue the ready handler drains — a different problem from batching,
    // and one the coalescer must not be handed or it would deliver into a
    // document that does not exist yet.
    if (!ready.current) { pending.current.push(b64); return; }
    bytes.current?.push(b64);
  }, []);

  useImperativeHandle(ref, () => ({
    send: (bytes: string): void => {
      const ws = socket.current;
      if (ws && ws.readyState === 1) ws.send(ptyFrame({ t: "in", d: bytes }));
    },
    command: (frame: PtyClientFrame): void => {
      const ws = socket.current;
      if (ws && ws.readyState === 1) ws.send(ptyFrame(frame));
    },
    focus: (): void => inject("window.AGX.focus()"),
  }), [inject]);

  // One socket per pane. Re-opening on a width change would drop the session,
  // so `columns` is deliberately not in here — the page resizes itself and
  // reports the new geometry, which the server takes as a plain resize.
  useEffect(() => {
    // See `measured`: a socket opened before the page has laid itself out
    // carries a guess, and everything downstream spends a round trip undoing
    // it — including tmux, in front of somebody who is watching.
    if (!measured) return;
    const query = new URLSearchParams({
      token: host.token,
      cols: String(size.current.cols),
      rows: String(size.current.rows),
    });
    if (pane) query.set("pane", pane);
    if (root) query.set("root", root);
    if (fit) query.set("fit", "1");

    const Ctor = WebSocket as unknown as new (
      url: string,
      protocols?: string | string[],
      options?: { headers?: Record<string, string> },
    ) => WebSocket;
    const ws = new Ctor(
      `${host.origin.replace(/^http/, "ws")}/terminal/pty?${query.toString()}`,
      undefined,
      { headers: { Origin: host.origin } },
    );
    ws.binaryType = "arraybuffer";
    socket.current = ws;
    handlers.current.onState("connecting");

    ws.onopen = (): void => {
      handlers.current.onState("live");
      // The page may have measured itself before the socket existed.
      ws.send(ptyFrame({ t: "resize", ...size.current }));
    };

    ws.onmessage = (event: { data: unknown }): void => {
      if (typeof event.data === "string") {
        /*
         * The protocol, from the one declaration of it — see PtyServerFrame.
         *
         * This was a private list of optional fields, and the desk had its own,
         * different one. That is how `t:"pane"` could have its `by` renamed
         * with both of those files still green and only this screen going
         * wrong: back to a fitted UI over an unfitted window, which is the bug
         * the comment on `onPane` above records as having already shipped once.
         * `session` came out of it too — this declared it `string`, the wire
         * carries `string | null`, and nothing had ever compared the two.
         */
        let frame: PtyServerFrame;
        try { frame = JSON.parse(event.data) as PtyServerFrame; } catch { return; }
        // The only control frame worth surfacing: the server refusing, and
        // saying why. "that pane is gone" is a real answer somebody can act on.
        if (frame.t === "fatal") handlers.current.onState("gone", frame.error);
        if (frame.t === "opened") {
          handlers.current.onOpened?.({ pane: frame.pane, window: frame.window, cwd: frame.cwd });
        }
        // The refusal, and NOT through onState: see the note on `openfail`.
        // A button that did not work must not read as a terminal that died.
        if (frame.t === "openfail") handlers.current.onOpened?.({ error: frame.error });
        if (frame.t === "ready" && frame.pane) handlers.current.onGrid?.(frame.pane);
        // The same numbers as `ready`'s, arriving later because the window
        // moved. `ready` is sent once; this is how a size stays true after it.
        if (frame.t === "pane" && frame.cols && frame.rows) {
          handlers.current.onPane?.({
            cols: frame.cols, rows: frame.rows, fit: !!frame.fit, by: frame.by,
          });
        }
        if (frame.t === "tmux") {
          // `?? undefined` because the server sends `session: null` when it has
          // no session to name, and "no session" is what this callback spells
          // as absent. The old private frame type simply said `string` and the
          // null went through unremarked.
          handlers.current.onTmux?.({ prefix: frame.prefix, session: frame.session ?? undefined });
        }
        return;
      }
      push(b64Encode(new Uint8Array(event.data as ArrayBuffer)));
    };

    /*
     * "Disconnected", but only for the socket that is still ours.
     *
     * `fit` changing is the phone's own key in terminal.tsx, so it remounts this
     * whole view: the outgoing socket is closed and the incoming one is opened,
     * in that order but not atomically — the same non-atomicity that let a
     * teardown undo a fit 300ms after it was applied (2330a50). React runs the
     * cleanup before the new effect body and a close event is dispatched as a
     * task rather than inline, so the retired socket's close ALWAYS arrives
     * after the new one has said it is connecting, and nothing orders it against
     * the new one's open either. Ungated it paints "Disconnected" over a
     * terminal that is working, and can leave it there: the socket effect re-runs
     * on the connection's identity and nothing about it changed, so the only way
     * out is tapping another tab.
     *
     * That matters now because the desk's take-over drops `fit` on this phone
     * while somebody is mid-command on it. The cleanup below nulls this ref
     * before closing, so a socket the effect retired can never speak again; a
     * real drop still has the ref pointing at it, and still reports.
     */
    const closed = (): void => {
      if (socket.current !== ws) return;
      handlers.current.onState("gone");
    };
    ws.onerror = closed;
    ws.onclose = closed;

    return () => {
      socket.current = null;
      /* Whatever this pane's socket left in the batch is thrown away rather
         than delivered. It belongs to a pane nobody is looking at any more,
         and 48ms is easily enough time for the next one to have arrived —
         which would put one pane's output into another's screen. */
      bytes.current?.clear();
      // Closing the socket ends the grouped tmux session on the machine, which
      // is what should happen: leaving one behind per tab visited would fill
      // `tmux ls` with sessions nobody is in.
      try { ws.close(); } catch { /* already gone */ }
    };
    // Deliberately only what identifies the CONNECTION, plus `attempt`, which
    // is the one way to ask for the same connection again. See the refs above.
  }, [host, pane, root, fit, push, measured, attempt]);

  /*
   * Come back with the app.
   *
   * A phone in a pocket loses this socket: Android stops the process's timers
   * and the network goes with the screen, so the connection is gone long before
   * anybody looks again. Nothing here noticed, because a dead socket does not
   * change the pane it was attached to.
   *
   * Only on the way IN, and only when there is nothing live. Reconnecting while
   * the app is away would put a tmux client back on somebody's machine for a
   * phone in a pocket — every attach is a grouped session on the desk's tmux —
   * and reconnecting over a socket that survived would drop a session that is
   * working to replace it with an identical one.
   *
   * CONNECTING counts as alive: the first foreground event often lands while
   * the initial socket is still opening, and racing it would throw away the
   * attach that is already on its way.
   *
   * The pane keeps running on the machine throughout. This reattaches a view to
   * work that never stopped, which is the whole promise of the tmux side of the
   * app — the frozen screen was making it look otherwise.
   */
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      const ws = socket.current;
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
      setAttempt((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  const onMessage = useCallback((event: WebViewMessageEvent): void => {
    let message: { t?: string; d?: string; cols?: number; rows?: number; text?: string | null; exact?: boolean; lines?: number };
    try { message = JSON.parse(event.nativeEvent.data) as typeof message; } catch { return; }
    const ws = socket.current;

    if (message.t === "ready") {
      ready.current = true;
      // The colours first, then the bytes, and only when the page has come back
      // in the wrong ones: a WebView reload replays the document this component
      // was built with, whose palette is whatever was current at mount.
      if (painted.current !== baked.current) inject(`window.AGX.theme(${painted.current})`);
      const waiting = pending.current.splice(0);
      // Everything held while the page booted, in one crossing. This is the
      // biggest single batch the bridge ever carries — a pane with scrollback
      // replays it all at `ready`.
      if (waiting.length) inject(`window.AGX.writeMany(${JSON.stringify(waiting)})`);
      return;
    }
    if (message.t === "tap") { handlers.current.onTap?.(); return; }
    if (message.t === "in" && typeof message.d === "string") {
      if (ws && ws.readyState === 1) ws.send(ptyFrame({ t: "in", d: message.d }));
      return;
    }
    /*
     * A finger asking the pane's scrollback to move, on the one route where a
     * wheel cannot say it.
     *
     * Forwarded as a COUNT and never as bytes. That is the point of the frame:
     * the page reaches this branch precisely when nothing on the far end is
     * listening for a mouse, which is when xterm would have turned the gesture
     * into cursor keys — 53 of them for one drag, measured. See the note on
     * `cmd:"scroll"` in the contract for what those keys did.
     */
    if (message.t === "scroll" && typeof message.lines === "number") {
      if (ws && ws.readyState === 1) ws.send(ptyFrame({ t: "tmux", cmd: "scroll", lines: message.lines }));
      return;
    }
    /*
     * The pane's own input line. Forwarded straight through, `null` included:
     * "I could not tell" and "it is empty" are different answers, and a field
     * that treats the first as the second wipes what somebody is typing.
     */
    if (message.t === "line") {
      // `exact` absent is the safe reading, not the convenient one: a page from
      // before this field existed only ever posted a single-row read, which IS
      // exact. A default of false there would turn every mirror on an older
      // WebView into a composer.
      handlers.current.onLine?.(
        typeof message.text === "string" ? message.text : null,
        message.exact !== false,
      );
      return;
    }
    if (message.t === "size" && message.cols && message.rows) {
      size.current = { cols: message.cols, rows: message.rows };
      // The first one is what lets the socket open at all — before it, every
      // number this component has is a guess. Later ones are ordinary resizes.
      setMeasured(true);
      if (ws && ws.readyState === 1) ws.send(ptyFrame({ t: "resize", cols: message.cols, rows: message.rows }));
    }
  }, [inject]);

  // A width change is a repaint and a resize, not a reconnect.
  useEffect(() => { inject(`window.AGX.columns(${columns})`); }, [columns, inject]);

  /*
   * A theme change is a repaint and NOTHING ELSE. Same shape as the width above,
   * and for a much sharper reason.
   *
   * The document is built once, with the palette in it — all sixteen ANSI
   * colours included — so the obvious way to change theme is to rebuild it. It
   * is also the wrong way: `source` changing reloads the WebView, the page
   * comes up empty, and the only thing that ever repaints a tmux pane is tmux
   * redrawing it on attach. Somebody watching a build would see their terminal
   * blink out and re-attach because they tapped a colour. The socket does not
   * belong to the page (see the top of this file), so it survives — which makes
   * "reload and re-attach" survivable rather than correct.
   *
   * `window.AGX &&` because this fires on mount too, before the page exists.
   * The mount case is already correct — the palette is in the document — so the
   * guard is the whole handling it needs.
   */
  useEffect(() => {
    painted.current = themeJson;
    inject(`window.AGX && window.AGX.theme(${themeJson})`);
  }, [themeJson, inject]);

  const source = useMemo(() => ({ html: doc, baseUrl: "about:blank" }), [doc]);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <WebView
        ref={webview}
        source={source}
        originWhitelist={["about:*"]}
        onMessage={onMessage}
        // Nothing here is fetched: the document carries its own engine, and a
        // terminal that could load something is a terminal that can be told to.
        javaScriptEnabled
        domStorageEnabled={false}
        cacheEnabled={false}
        setSupportMultipleWindows={false}
        allowsLinkPreview={false}
        overScrollMode="never"
        androidLayerType="hardware"
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        style={{ flex: 1, backgroundColor: C.bg }}
      />
    </View>
  );
});
