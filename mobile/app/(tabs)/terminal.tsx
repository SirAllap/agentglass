/*
 * The machine's real terminals, as tabs.
 *
 * Not "a shell on the phone" — the shells that are already running. Every tab
 * is a live tmux pane on the computer, so opening one shows what is on that
 * screen right now: the agent mid-turn, the build that failed, the rebase
 * waiting on a decision. That is the difference between a companion and a
 * second empty prompt.
 *
 * Attaching does not disturb the desk. tmux sizes a window to whichever client
 * used it last, so the obvious `attach` would drag a 200-column session down to
 * phone width for as long as you looked at it — measured, and it is why the
 * server joins as its own grouped session with `window-size largest`. See
 * `attachArgvFor`.
 *
 * The key bar below is the other half. A software keyboard has letters; a
 * terminal needs Escape, Tab, the arrows, ^C and — since these are tmux panes —
 * the tmux prefix. Without those the phone can run `ls` and nothing else.
 *
 * ── why there is a composer and not a cursor ──────────────────────────────
 * Typing used to mean tapping a bar that called `focus()` on the terminal,
 * which focused xterm's hidden textarea inside the WebView and hoped Android
 * would raise the keyboard. Android does not: an Android WebView shows the IME
 * for a focus that came from a real touch on the element, and the prop that
 * overrides that, `keyboardDisplayRequiresUserAction`, is marked `@platform
 * ios` in react-native-webview's own types. So the bar did nothing at all.
 *
 * It would have been the wrong shape even had it worked. The keyboard covers
 * most of a phone, so typing straight into the pane is typing blind at the two
 * lines still showing. The field below is a composer instead: you write a line
 * where you can see it, and it goes to the pane with a carriage return after
 * it, which is the bargain the agent's own prompt makes. `keys` mode is there
 * for the other half of a terminal, the program waiting on one keystroke.
 */
import { useCallback, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { useDeskPalette, usePaletteTick } from "../../src/state/use-palette.ts";
import { TerminalView, type TerminalHandle, type TerminalState } from "../../src/terminal/TerminalView.tsx";
import { ACCESSORY_KEYS, prefixKey, type AccessoryKey } from "../../src/terminal/keys.ts";
import { editFor } from "../../src/terminal/mirror.ts";
import { bestSession, readStrip, sessionsOf, type Tab } from "../../src/terminal/tabs.ts";
import type { PanesResponse } from "../../../shared/types.ts";
import { Btn, Card, Label, Note, TAP } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T, ink } from "../../src/theme.ts";

export default function TerminalScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  /*
   * The pane is painted by the COMPUTER, so when the computer says which palette
   * that is, the terminal wears it and only the chrome around it wears the
   * phone's.
   *
   * Not a preference — a fact about what is on screen. agentglass syncs the
   * desk's theme into the user's tmux, and that conf carries
   * `window-style "bg=<the desk's background>"`, so every cell arrives with an
   * explicit background and the phone's own is never reached inside the grid.
   *
   * The accent stays the phone's. It paints the cursor and the selection, which
   * are this client's own furniture rather than anything the machine drew, and
   * they are exactly what the accent is for.
   */
  const desk = useDeskPalette(host);
  /*
   * And when the machine will not say, the PHONE'S MODE — which it could not be
   * before, and this is the line the light terminal was stuck behind.
   *
   * It was the dark base, because "the machine has no theme" is not "the pane
   * has no colours": measured on this machine, `/theme/current` answers
   * `{theme:null}` — nothing has written ~/.config/agentglass/theme.json —
   * while ~/.config/agentglass/theme.tmux.conf beside it was synced the same
   * day and carries `set -g window-style "bg=#1e1e1e"`, so every pane is being
   * painted dark by a machine that says it has no theme. Following the phone
   * into Light there put #1f2328 text on #1e1e1e and the words at the top of a
   * session vanished.
   *
   * What changed is that the page no longer has to take anybody's word for it.
   * It reads the background out of its own buffer and wears the set that is
   * legible on THAT (see counterTheme and paneBg in terminal-html.ts), so a
   * wrong guess here is corrected within a second by a measurement, while a
   * machine that paints nothing finally lets the phone's own mode through.
   */
  const paneBase = desk ? { ...C, ...desk } : C;
  const paneColours = { ...paneBase, primary: C.primary, primaryHover: C.primaryHover };
  const insets = useSafeAreaInsets();
  const terminal = useRef<TerminalHandle>(null);

  /*
   * The strip itself, and not the pane list it came from.
   *
   * `/terminal/panes` is grouped into tabs the moment it arrives rather than on
   * every render, because the tabs are also what this screen compares one
   * answer to the next by — see `readStrip` and the poll below. Holding the raw
   * rows would mean deriving the tabs twice: once to decide whether anything
   * moved, once to draw them.
   *
   * `null` is "not read yet", which is a different card from an empty machine.
   */
  const [strip, setStrip] = useState<Tab[] | null>(null);
  /** The last shape adopted, so a tick that changes nothing writes no state —
   *  see `readStrip`. A ref because it is compared against the answer in hand
   *  rather than the one the last paint was made from. */
  const seen = useRef<string | null>(null);
  /** Which tmux session's strip to show. A machine with four sessions has four
   *  strips' worth of windows, and all of them at once is not a strip anybody
   *  reads. */
  const [session, setSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [state, setState] = useState<TerminalState>("connecting");
  const [why, setWhy] = useState<string | null>(null);
  /*
   * How wide the terminal is, in columns — not how big the text is.
   *
   * A number rather than "whatever fits" — and which argument that rests on
   * depends on the switch below, so both are here rather than only the one
   * that happened to be written first:
   *
   *   `fit` off: tmux holds the window at the desk's width and the phone sees
   *   a slice of it. Fitting to the phone would be about 45 columns onto a
   *   200-column pane, which for anything full-screen is border and a prompt.
   *
   *   `fit` on, which is a tap and not the default: the window becomes
   *   whatever this page reports, so this IS the pane's width — at the desk
   *   too, while you are looking. 80 is what every TUI has been written
   *   against since terminals were furniture, and the one width nothing is
   *   surprised by.
   *
   * 80 is also the widest that is still comfortably legible — the arithmetic
   * is unforgiving, and worth writing down rather than rediscovering. A phone
   * WebView is ~400 CSS pixels across and a monospace glyph is ~0.6 of its
   * point size, so N columns means a font of 400/N/0.6: 80 gives 8.3pt, 120
   * gives 5.5pt, and 200 gives 3.3pt, which is a texture rather than text.
   *
   * So the cycle is 60 / 80 — read, and work.
   *
   * 200 was on this cycle and is gone. The arithmetic above says why: it lands
   * under the font floor, so the glyphs stop shrinking and start OVERLAPPING —
   * reported from a phone as "text on top of other text", which is exactly what
   * a grid wider than its floor allows looks like. A rung nobody can read is a
   * rung that only costs taps to get past.
   *
   * AND SO IS 120, for a sharper reason than "small". Measured in a real engine
   * at this phone's 412 CSS px: 60 columns gives a 6.85px cell at 11.4pt, 80
   * gives 5.15px at 8.55pt, and 120 gives 3.43px at 5.7pt — above the font floor,
   * so nothing overlaps and the screenshot looks like tiny text. It is not tiny
   * text. At 3.43px the glyph is clipped inside its own cell and characters
   * change identity: in the same capture `#472` read as `#4/2`, `#467` as
   * `#46/` and `faf0e9d` as `tat0e9d` — a seven drawn without its bar is a
   * slash, an f without its crossbar is a t. A width control that misreports the
   * commit somebody is looking at is worse than one that does not offer that
   * rung. The same pass also put 150 ROWS on the screen, and with nothing wider
   * attached that is the size the real window is given.
   */
  const [columns, setColumns] = useState(80);
  /*
   * Whether the tmux window reflows to this phone.
   *
   * Off, the window keeps the desk's size and the phone shows its left-hand
   * corner — which for a full-screen program is border and a prompt, not the
   * thing you opened it to read. On, tmux resizes the window to the phone and
   * the program redraws itself to fit, so you see what is actually running.
   *
   * OFF by default, and it used to be on. The cost is worse than "a client at
   * the desk sees the same reflow", which is what this comment said: measured
   * on a live five-window session with a phone on ONE pane of it, all five
   * windows had been pulled down to the phone's 80 columns, because
   * `window-size` is read per window and a grouped session shares every window
   * in the group. The one window the desk was actually on got squeezed and let
   * go again, leaving a full-screen program drawn at 80 columns inside a
   * 277-column pane — a desk that looks broken, with nothing on it to say why.
   *
   * tmux does NOT put it back on its own; the server now asks it to, twice, on
   * the way out (see `restoreWindowSizes`). That makes the switch survivable.
   * It does not make it free, and it is the desk's width being spent, so the
   * default is the one that spends nothing.
   */
  const [fit, setFit] = useState(false);
  /** tmux's real prefix, reported by the server once the socket is up. Not a
   *  constant: `C-b` is only the default, and a button sending the wrong key
   *  reads as the feature being broken rather than as a setting being
   *  different. */
  const [prefix, setPrefix] = useState<AccessoryKey | null>(null);
  /** What is in the field. Usually the pane's own input line — see `mirror`. */
  const [draft, setDraft] = useState("");
  /*
   * What we believe is on the pane's input line right now.
   *
   * `null` means the page could not read it: it found no prompt marker on the
   * cursor's row and refused to guess. That is not a detail — it is the switch
   * between the two things this field can be:
   *
   *   read → the field IS the line. What was typed at the computer is already
   *   in it, and every edit here is sent to the pane as it is made, backspaces
   *   included. Enter is then just Enter.
   *
   *   not read → the field is a composer, the way it was before: nothing
   *   reaches the pane until it is sent, all at once.
   *
   * A ref and not state because the send path has to compare against the value
   * as of THIS keystroke. Held through a re-render, it would compare against
   * the value as of the last paint and send the wrong number of backspaces.
   */
  const shadow = useRef<string | null>(null);
  /*
   * Whether somebody has started a line here, and therefore owns it.
   *
   * Not "has the keyboard". Focused and empty, the field should still follow
   * the pane — that is how a line typed at the computer appears in your hand.
   * From the first character it is the other way round: the two would fight
   * over every keystroke and the person typing must win.
   *
   * This is the guard that makes the field's MODE stable for the life of a
   * line, and that is the whole of the 60-column bug. Measured, before it
   * existed: a 60-column phone on a four-pane window gives panes 23 columns
   * wide, so a typed line wraps inside its pane after twenty-odd characters —
   * and tmux redraws a wrap like that by moving the cursor, which leaves no
   * prompt marker on the cursor's row, so the page correctly answered "I cannot
   * tell". That answer was adopted mid-line. `shadow` went null, `typed` below
   * took its early return, and every further keystroke was swallowed in
   * silence; then Send saw a null shadow, believed nothing had been sent, and
   * sent the WHOLE line again on top of the part that was already there.
   *
   * The measurement, on a 30-column pane with 60 characters typed into it: the
   * pane held `abcdefghijklmnopqrstuvwxyz0123` while typing and then ran
   * `abcdefghijklmnopqrstuvwxyz0123abcdefghijklmnopqrstuvwxyz0123456789…` —
   * the first 32 characters twice, which is exactly "se parte en cachos".
   *
   * Once claimed, this field's own record is the truth: it knows what it has
   * sent, and it does not need to read it back off a screen that cannot show
   * it.
   */
  const claimed = useRef(false);
  /** Only to re-render the hint when the mirror comes and goes. `shadow` is
   *  the value that is acted on. */
  const [mirror, setMirror] = useState(false);
  /*
   * How wide the tmux window really is, as the server last measured it.
   *
   * tmux sizes a shared window to the LARGEST client in the group, so when
   * nothing wider than this phone is looking at it the window is exactly what
   * this page asked for, and every tap of the width control moves the real
   * window on the computer. Measured on a live four-agent window with `fit`
   * OFF: 60c gave 60x37, 80c gave 80x56, and its four panes went from 46
   * columns to 23.
   *
   * This used to carry a second number — the width this page was showing when
   * the server last spoke — and infer from the two whether the window was
   * following this phone. It could not: nothing reported a size after our own
   * resize, so the pair was stamped at attach, where an 80-column desk and an
   * 80-column default agree for a reason that has nothing to do with the phone.
   * That is how the strip below came to say "it is 60 columns for the computer
   * too" while columns 61 to 80 were falling off the right-hand edge, proved
   * with an 80-column ruler where `shared` arrived as `sha`.
   *
   * So the server answers with the window's real size after every resize (see
   * `by: "phone"` on the `pane` frame) and this is a measurement rather than an
   * inference. Compared against `columns` directly: under `largest`, a window
   * no wider than what we asked for IS a window with nothing wider attached.
   */
  const [grid, setGrid] = useState<{ cols: number; rows: number } | null>(null);
  /*
   * The pane whose width the computer took back, if it just did.
   *
   * Attribution, and only that. The strip at the bottom becomes true again on
   * its own the moment `fit` goes false — but nobody here touched the switch,
   * so without a line saying so it reads as the control having dropped itself.
   *
   * Keyed by pane rather than a boolean so it cannot outlive what it describes:
   * a tab switch shows a different pane, and telling somebody the computer took
   * the width back on a pane it never touched is the same invisible lie the
   * frame exists to end. The two controls that touch `fit` by hand clear it,
   * because from then on the reflow is theirs.
   */
  const [tookBack, setTookBack] = useState<string | null>(null);
  /*
   * Whether the field composes a line or types into the pane.
   *
   * A line is what a phone is good at — see it, correct it, send it — and it is
   * what nine tenths of the reasons to open this screen want: a command, a
   * reply to an agent. The tenth is a program waiting on ONE key: `y/n`, a
   * pager, vim's `j`, a menu. A line-at-a-time composer cannot answer those,
   * because the answer has been read and acted on before a carriage return
   * would arrive.
   *
   * So: a toggle rather than cleverness about which one is meant. Guessing
   * would have to be right every time — a field that decides on its own to
   * send `y` while somebody is halfway through typing `yarn build` has done
   * something unrecoverable, and one that guesses the other way leaves them
   * tapping at a prompt that is not listening.
   */
  const [raw, setRaw] = useState(false);
  /*
   * What the field holds in `keys` mode, and how much of it has already gone.
   *
   * ── the bug this shape exists to end ──────────────────────────────────────
   * `keys` used to send the WHOLE field on every change and keep the field
   * empty by controlling its value to a constant "". Emptying it is a render,
   * and a render is not synchronous with a thumb: the next character arrives
   * while the native input still holds the last one, so the change event
   * carries both and the whole buffer goes down the socket again. Measured on
   * the emulator against a pane running `cat -v`, typing `hello` at ordinary
   * speed: the pane received `hhehelhello`. Typed with 1.2s between characters
   * the same field was correct, which is the whole tell — the slow case is the
   * one where the render always won the race.
   *
   * So the field is no longer emptied while anybody is typing, and what is sent
   * is the DIFFERENCE — `editFor`, the same function the line mirror uses. The
   * field and the record of what has been sent are then one clock instead of
   * two, and no amount of typing speed can put them out of step.
   *
   * It also gives `keys` a backspace that works. That key never reached the
   * pane: `onKeyPress` was the only path and Android does not fire it for
   * Backspace on an empty soft-keyboard field — measured, `xyz` on the pane was
   * still `xyz` after two presses. A field that holds what you typed reports a
   * backspace as an ordinary change, and `editFor` turns it into the DEL a
   * terminal's erase key sends.
   *
   * Cleared on blur and on the mode switch, and DELIBERATELY NOT on Enter. Both
   * of those are moments when nothing is being typed, which is the only moment
   * an asynchronous clear is safe; clearing on Enter would put the same race
   * back at the boundary between a command and the next one. What it costs is a
   * field that reads as a transcript of the keys sent since the keyboard came
   * up, which is worth having anyway on a screen where the pane is behind the
   * keyboard.
   */
  const [keyed, setKeyed] = useState("");
  const keyedSent = useRef("");
  const forgetKeys = useCallback((): void => { setKeyed(""); keyedSent.current = ""; }, []);

  /**
   * Read the machine's panes, and adopt the answer only if it says something
   * new.
   *
   * `quiet` is the difference between the two callers, and it is about what a
   * failure is allowed to do to the screen. Pressed by hand, a failure is the
   * answer — it says why the strip is empty. Arriving from the timer it is
   * Tuesday: a phone loses the network constantly, and a tick that could not
   * reach the computer must leave the tabs and the attached terminal exactly
   * where they were rather than blanking a working screen every time somebody
   * walks past the router. The one exception is the very first read, where
   * there is nothing on screen to protect and silence would leave "Looking" up
   * for ever.
   */
  const load = useCallback(async (quiet = false): Promise<void> => {
    if (!host) return;
    const answer = await ask<PanesResponse>(host, "/terminal/panes");
    if (!answer.ok) {
      if (quiet && seen.current !== null) return;
      seen.current = null;
      setError(answer.error);
      setStrip([]);
      return;
    }
    /*
     * Nothing below runs when nothing moved, and that is the whole point of the
     * poll being survivable — see `readStrip`. Every line after this writes
     * state, and state written twice a second is a strip that repaints twice a
     * second, which is a strip that eats the tap you were halfway through.
     */
    const next = readStrip(seen.current, answer.value);
    if (!next.changed) return;
    seen.current = next.shape;
    /*
     * A server that does not answer `canAttach` predates the pane attach: it
     * ignores `?pane=` and opens a plain shell instead. Said out loud, because
     * the symptom otherwise is a tab strip that works and a terminal showing an
     * empty prompt where the running session should be — with nothing anywhere
     * to explain it.
     */
    setStale(next.stale);
    setError(null);
    setStrip(next.tabs);
    const all = next.tabs;
    // Where the work is, not the first name alphabetically. See `bestSession`:
    // opening on a session with one idle shell while five agents run in another
    // is how "I cannot see my tabs" happens.
    const best = bestSession(all);
    setSession((current) => (current && all.some((t) => t.session === current) ? current : best));
    setActive((current) => {
      if (current && all.some((t) => t.paneId === current)) return current;
      const inSession = all.filter((t) => t.session === best);
      // The first pane with an agent under it, or the first window. Either way
      // something is on the screen rather than an empty terminal.
      return (inSession.find((t) => t.agent) ?? inSession[0])?.paneId ?? null;
    });
  }, [host]);

  /*
   * Re-read the panes while this screen is on screen, and only then.
   *
   * The reported bug: split a pane at the computer, or open a window, and the
   * phone went on showing the strip it read on mount — the refresh arrow was
   * the only way to see it. The desk does not have the problem because the
   * server sweeps tmux twice a second and pushes it a `t:"tmux"` frame; this
   * phone holds a socket too, but it only ever carries `events`, `notify` and
   * pty bytes. Nothing on it says the panes changed.
   *
   * So: poll, rather than add a frame. A new event type is server work plus a
   * thing to keep in step across two branches, and that has already produced
   * one visible bug today; a GET this screen already makes is neither.
   *
   * TWO SECONDS, and the cost is what picks it rather than taste. `listPanes`
   * is synchronous `tmux` calls — list-clients, list-panes, list-sessions per
   * socket — on Bun's single event loop, so the request is not free at the
   * server end and everything else queues behind it. Measured against the
   * machine this was reported on, 17 panes across its tmux servers: 24 ms per
   * call and 3.5 KB of JSON back. At 2s that is ~1.2% of the server's event
   * loop and ~1.7 KB/s, and the terminal's own pty bytes wait behind those
   * 24 ms — at 1s it would be double both. What is being watched for is a hand
   * on a keyboard splitting a pane, which happens once and not twice a second,
   * so half the cost is worth the beat. Radio and battery barely enter into it:
   * whenever this poll is running the screen is also holding a WebSocket
   * streaming a live pane, so it is a request added to a radio that is already
   * awake rather than one that wakes it.
   *
   * What it feels like, measured on the emulator against a tmux of its own:
   * `split-window` at 20:21:19.9 was on the phone by the poll at 20:21:21.5,
   * and `new-window` landed inside the same two seconds. Thirty-three ticks in
   * a row came out 2.02s apart with the strip unchanged, and not one of them
   * wrote state — which is the half `readStrip` is responsible for.
   *
   * `useFocusEffect` and not `useEffect`: a tab screen stays MOUNTED when you
   * leave it, so an effect keyed on mount would go on polling from the Chats
   * screen, from Settings, and behind a locked phone. Focus is the honest
   * question — is anybody looking at this strip — and its cleanup runs on
   * leaving the tab rather than on unmount.
   */
  useFocusEffect(useCallback(() => {
    void load(true);
    const timer = setInterval(() => { void load(true); }, 2000);
    return () => clearInterval(timer);
  }, [load]));

  const onKey = useCallback((bytes: string): void => {
    void Haptics.selectionAsync();
    /*
     * And the field stops claiming the line — see `claimed`.
     *
     * Every key on the bar is an instruction to the PANE that the field did not
     * make, and the ones people press change the line under it: Tab completes
     * it, up replaces it with the last one, Ctrl+C throws it away. Holding the
     * claim through that leaves the field describing a line that no longer
     * exists, and the next keystroke computing its edit against it — which is
     * how a completion gets erased by the character typed after it.
     */
    claimed.current = false;
    terminal.current?.send(bytes);
  }, []);

  const onState = useCallback((next: TerminalState, detail?: string): void => {
    setState(next);
    setWhy(detail ?? null);
    /*
     * And the switch goes off with the socket that was holding it.
     *
     * `fit` is not a preference, it is a claim on somebody else's window: while
     * it is on, tmux is holding the desk's window at this phone's width. The
     * claim lives in the socket — the server reads it off the attach and the
     * teardown puts the window back — so a socket that is gone is a claim that
     * is gone, and a switch still lit is describing a reflow that is no longer
     * happening.
     *
     * Left on, it was worse than wrong: the next attach reads it and sends
     * `fit=1` again, so simply leaving the app and coming back re-took the
     * width from the desk, on nobody's instruction, right after the person at
     * the computer had asked for it back. Reported exactly that way, and the
     * server-side half of it is the flag cleared in `tellPhonesTheWindowMoved`.
     *
     * Turning it off remounts the view (`fit` is in its key), which opens a
     * socket without the fit rather than reconnecting the old one. That costs
     * nothing while the app is away: the new view has not laid itself out, and
     * the socket waits for that measurement before it opens, so the reattach
     * happens when somebody is looking rather than in a pocket.
     */
    if (next === "gone") setFit(false);
  }, []);

  /*
   * The pane's input line, as the page reads it off the screen.
   *
   * Ignored outright once the line is claimed — see `claimed`. The pane echoes
   * what we send, so every keystroke comes back a moment later: adopting it
   * would move the cursor to the end mid-word and undo an edit made in the
   * middle of a line, and adopting a `null` from a pane too narrow to read
   * silently cuts the field off from the shell it is typing into.
   */
  const onLine = useCallback((text: string | null): void => {
    if (claimed.current) return;
    shadow.current = text;
    setMirror(text !== null);
    if (text !== null) setDraft(text);
  }, []);

  const submit = useCallback((): void => {
    /*
     * With the mirror on, the line is ALREADY on the pane — this key put it
     * there character by character — so sending the text again would run it
     * twice. Enter is all that is left to send, and that is the whole of what
     * this button means.
     */
    if (shadow.current !== null) {
      if (!draft) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      terminal.current?.send("\r");
      // Cleared here rather than waiting for the pane to say so: the field is
      // empty the instant Enter is pressed, everywhere else in the world.
      shadow.current = "";
      // The line is gone, so nobody owns it any more and the pane may seed the
      // next one. Released here rather than on blur alone: sending is how a
      // line ends, and the keyboard usually stays up for the next one.
      claimed.current = false;
      setDraft("");
      return;
    }
    if (!draft) return;
    claimed.current = false;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    /*
     * Carriage return, and the newlines in the middle become one too. Enter on
     * a terminal is CR: the tty turns it into a line feed for a program in
     * canonical mode, and a program in raw mode — vim, an agent's prompt,
     * anything with a TUI — reads CR itself and would not recognise LF. The
     * replace is for pasted text, which is the only way a newline gets in
     * here; `submitBehavior` below spends the return key on sending.
     */
    terminal.current?.send(`${draft.replace(/\n/g, "\r")}\r`);
    setDraft("");
  }, [draft]);

  /*
   * What the field does with what was typed, which is the whole of the mode.
   *
   * In `keys` the field is a conduit rather than a place: the character goes
   * down the socket and the field is emptied again in the same frame, because
   * its `value` is a constant empty string and React Native writes a
   * controlled value back to the native input on every change event. That is
   * also why the keyboard type changes with the mode — a predicting keyboard
   * rewrites what it has already handed over, and here that has already been
   * sent and cannot be taken back.
   */
  const typed = useCallback((text: string): void => {
    if (raw) {
      setKeyed(text);
      // The difference, not the field. See `keyed` above for the measurement
      // that made this the shape it is — and note that a SHRINKING field is a
      // backspace, which `editFor` spells as the DEL a terminal's erase key
      // sends rather than as a retype.
      const keys = editFor(keyedSent.current, text);
      keyedSent.current = text;
      if (keys) terminal.current?.send(keys);
      return;
    }
    setDraft(text);
    // From here the line is this person's, and what the pane says about it is
    // no longer listened to. An empty field gives it back, so clearing the
    // field and waiting is a way to pick up whatever is typed at the desk.
    claimed.current = text.length > 0;

    const was = shadow.current;
    if (was === null) return; // a composer: nothing leaves until it is sent

    // The edit, as the pane would have received it from a keyboard — erase back
    // to where the two lines agree, then type the rest. See `editFor`, which is
    // where the reasoning and the tests for it live.
    const keys = editFor(was, text);
    if (!keys) return;
    shadow.current = text;
    terminal.current?.send(keys);
  }, [raw]);

  /** What the return key does, in either mode. In `keys` nothing is being held
   *  back, so it is the key itself and goes through the bar's own route. */
  const onReturn = useCallback((): void => {
    if (raw) { onKey("\r"); return; }
    submit();
  }, [raw, onKey, submit]);

  if (!host) return null;

  const all = strip ?? [];
  const sessions = sessionsOf(all);
  const tabs = all.filter((t) => !session || t.session === session);
  const open = tabs.find((t) => t.paneId === active) ?? null;
  // Something to send it to, and something to send — which in `keys` is the
  // return key, so the button is live there as soon as a pane is attached.
  const canSend = !!open && (raw || draft.length > 0);
  /*
   * Whether this phone is the widest thing looking at the window — see `grid`.
   *
   * `largest` means the window is never narrower than any client, so a window
   * no wider than what this page is showing can only be a window with nothing
   * wider attached. Which makes the two bottom strips mutually exclusive, and
   * each of them true: either something is wider and part of the pane is off
   * screen, or this phone is what the desk is being drawn at.
   *
   * Against `columns` and not against a width stamped onto the report when it
   * arrived. That stamp is what made the second strip lie — see `grid` — and it
   * only worked at all because nothing ever re-measured the window; the server
   * now answers with its real size after every resize, so the comparison is
   * between two current facts.
   */
  const following = !!grid && grid.cols <= columns;
  const live = !!open && state === "live";

  return (
    /*
     * `padding` on both platforms, which is not the shape the rest of the app
     * uses, and the arithmetic is why.
     *
     * React Native's KeyboardAvoidingView pads by `frame.y + frame.height -
     * keyboardTop`, where the frame is this view's own layout. This view is the
     * whole tab scene: it starts at the top of the display, because the screen
     * hides its header, and it ends where the tab bar starts.
     *
     * Android is meant to resize the window under `adjustResize`, which is
     * Expo's default and what this app is built with. When it does, the frame
     * has already shrunk by the keyboard, the subtraction comes out negative,
     * and the padding is zero — nothing double-counts. When it does not, which
     * is what edge-to-edge does to `adjustResize` on newer Android, the same
     * subtraction is exactly the overlap. One expression, right either way,
     * where `behavior={undefined}` is right only in the first case.
     *
     * Either way the terminal is the flexible child, so it is what gives up
     * the height — and with `fit` on, a shorter terminal is a shorter tmux
     * window at the desk too, for as long as the keyboard is up. That is the
     * same bargain `fit` already makes, arriving at a new moment.
     */
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior="padding">
      {/* ── the tabs ───────────────────────────────────────────────────── */}
      {/* This screen hides the navigation header so the terminal gets the
          height, and hiding the header also gives up the inset that came with
          it — so the strip sat under the status bar, behind the clock, with
          its top half untappable. The inset has to be paid here instead. */}
      <View style={{
        paddingTop: insets.top,
        backgroundColor: C.bg,
        borderBottomWidth: 1, borderBottomColor: C.border,
      }}>
        {/* The session, when there is more than one. A machine running four
            tmux sessions has four strips' worth of windows, and showing them
            all at once is not a strip anybody reads — the desk has the same
            problem and solves it with a session picker. */}
        {sessions.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: SPACE.sm, gap: SPACE.xs, paddingBottom: SPACE.xs }}
          >
            {sessions.map((name) => {
              const on = name === session;
              return (
                <Pressable
                  key={name}
                  onPress={() => {
                    setSession(name);
                    setActive(all.find((t) => t.session === name)?.paneId ?? null);
                  }}
                  style={{ paddingHorizontal: SPACE.sm, minHeight: 32, justifyContent: "center" }}
                >
                  {/* Cut, and cut in the MIDDLE. A session is named after the
                      thing it is for, and on this machine that is a worktree:
                      measured, `agentglass-mobile-feat-android-2026` took two
                      thirds of the strip and pushed the third session off the
                      right-hand edge — and the tail is where a name shaped like
                      that says which one of them it is. */}
                  <Text
                    numberOfLines={1}
                    ellipsizeMode="middle"
                    style={{
                      color: on ? C.primary : C.text4, fontSize: T.eyebrow, fontFamily: MONO,
                      fontWeight: on ? "700" : "400", maxWidth: 130,
                    }}
                  >{name}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
        {/* Re-read pinned outside the scroller, not carried at the end of it.
            It rode after the last tab, so where it sat depended on how many
            tabs there were: with two it was on screen, with six it was off the
            right-hand edge — and a stale list is long, so the moment the button
            is needed is the moment it cannot be reached. */}
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: SPACE.sm, paddingVertical: SPACE.sm, gap: SPACE.xs }}
          >
            {tabs.map((tab) => {
              const on = tab.paneId === active;
              return (
                <Pressable
                  key={tab.paneId}
                  onPress={() => { setActive(tab.paneId); setWhy(null); }}
                  style={{
                    paddingHorizontal: SPACE.md,
                    paddingVertical: SPACE.sm,
                    borderRadius: RADIUS.md,
                    backgroundColor: on ? C.bg3 : "transparent",
                    borderWidth: 1,
                    borderColor: on ? C.border2 : "transparent",
                    minHeight: 44,
                    justifyContent: "center",
                    flexDirection: "row",
                    alignItems: "center",
                  }}
                >
                  {/* Cut at the tail: a window is named index-first, so the
                      front of the label is what tells two of them apart. Six
                      windows named after what they run made the strip four
                      swipes long. */}
                  <Text
                    numberOfLines={1}
                    style={{
                      color: on ? C.text : C.text3, fontSize: T.small,
                      fontWeight: on ? "600" : "400", maxWidth: 150,
                    }}
                  >{tab.label}</Text>
                  {/* An agent running under this pane is the reason to open it,
                      so it is on the tab rather than one screen further in. It
                      sits outside the truncated label, because a dot that a
                      long window name can ellipsise away is a dot that says
                      "no agent here" on exactly the tabs that have one. */}
                  {tab.agent ? <Text style={{ color: C.success, fontSize: T.small }}> ●</Text> : null}
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable
            onPress={() => { void load(); }}
            accessibilityRole="button"
            accessibilityLabel="Read the machine's panes again"
            style={{
              paddingHorizontal: SPACE.md, minHeight: 44, justifyContent: "center",
              borderLeftWidth: 1, borderLeftColor: C.border,
            }}
          >
            <Text style={{ color: C.text4, fontSize: T.title }}>⟳</Text>
          </Pressable>
        </View>
      </View>

      {/* ── the terminal ───────────────────────────────────────────────── */}
      <View style={{ flex: 1 }}>
        {open ? (
          <TerminalView
            // Keyed on the pane so switching tabs tears the old socket down
            // rather than repointing one — a shared terminal that changes what
            // it is attached to is how two panes end up interleaved.
            key={`${open.paneId}:${fit ? "fit" : "desk"}`}
            ref={terminal}
            host={host}
            pane={open.paneId}
            fit={fit}
            columns={columns}
            palette={paneColours}
            onState={onState}
            onTmux={(info) => setPrefix(prefixKey(info.prefix?.[0]))}
            onLine={onLine}
            onGrid={(next) => setGrid(next)}
            // The desk took its width back. Two things follow, and neither is a
            // disconnect: the window's real size is now this, and this phone is
            // no longer what it is fitted to.
            //
            // `fit` going false remounts through the key above, which opens a
            // session without `fit=1` — measured on an isolated server, that new
            // session re-asserts `window-size largest` and the window stays at
            // the desk's 200x49 rather than being handed straight back. tmux
            // redraws the pane at that width, which is the repaint wanted here
            // anyway; the phone shows its left-hand corner and says so below.
            //
            // Read off the frame rather than hardcoded false, because the same
            // frame is what keeps `grid` honest for any other move of this
            // window — a fitted phone whose window merely changed size gets a
            // new number and keeps its fit.
            onPane={(next) => {
              setGrid({ cols: next.cols, rows: next.rows });
              setFit(next.fit);
              if (next.by === "desk" && !next.fit) setTookBack(open.paneId);
            }}
          />
        ) : (
          <View style={{ flex: 1, padding: SPACE.lg, justifyContent: "center" }}>
            <Card>
              <Label text={strip === null ? "Looking" : "Nothing open"} />
              <Note tone={error ? "bad" : "quiet"}>
                {error
                  ? error
                  : strip === null
                    ? "Reading the machine's tmux panes…"
                    : "No tmux pane is open on the computer, or none is in this project. " +
                      "tmux has to have a client attached for its panes to be listed."}
              </Note>
              <Btn label="Look again" onPress={() => { void load(); }} />
            </Card>
          </View>
        )}
      </View>

      {/* Said quietly, and only when it is not fine: a status line that is
          always there is one nobody reads when it matters. */}
      {stale ? (
        <View style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm, backgroundColor: C.bg2 }}>
          <Note tone="bad">
            This computer&apos;s agentglass is older than the pane attach, so a tab opens a new
            shell instead of the session that is running. Update it, or pair with one that has it.
          </Note>
        </View>
      ) : null}
      {/*
        The columns that are not on screen, said out loud.

        Without a fit, tmux goes on rendering this window at the computer's
        width and this phone is shown the left-hand N columns of it. The rest
        is not clipped by anything here — it never arrives. Left unsaid, that
        reads as text being cut off for no reason, and it was reported exactly
        that way twice.

        It names the one control that changes it, and what that control costs,
        because the honest answer is a trade rather than a fix: tmux renders a
        window at ONE size, so a live view is either this phone's shape or the
        computer's. Turning it on reflows this window and only this window, and
        the server puts it back when the phone lets go.
      */}
      {live && !fit && grid && !following && grid.cols > columns ? (
        <Pressable
          onPress={() => { setFit(true); setTookBack(null); }}
          style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm, backgroundColor: C.bg2 }}
        >
          {/* Who ended the reflow, when it was not the person holding the
              phone. Everything under this line is true either way; this is the
              one thing that is not knowable from here. */}
          {tookBack === open?.paneId ? (
            <Text style={{ color: C.text2, fontSize: T.eyebrow, marginBottom: SPACE.xs }}>
              The computer took its width back.
            </Text>
          ) : null}
          <Text style={{ color: C.text3, fontSize: T.eyebrow }}>
            This pane is <Text style={{ color: C.text2, fontFamily: MONO }}>{grid.cols}</Text> columns
            wide and you are seeing <Text style={{ color: C.text2, fontFamily: MONO }}>{columns}</Text>.
            {" "}<Text style={{ color: C.primary, fontWeight: "700" }}>Tap to reflow it</Text> — this
            window only, put back when you leave.
          </Text>
        </Pressable>
      ) : null}
      {/*
        The other half of the same fact, and the one that was missing.

        `fit` off is sold as "the window keeps the desk's size", and when nobody
        wider is attached that is not what happens: `window-size largest` sizes
        the window to whichever client is biggest, and on a session the desk is
        not sitting in, that client is this phone. So the width control below
        reflows the real window whether or not `fit` is on, and there is nothing
        to take back — the phone already has it.

        THIS IS THE STRIP THAT LIED, and what changed is not its wording. It
        claimed "nothing wider is looking at this window" off a comparison
        between the one size the server had ever sent and the width this page
        was showing when it sent it — which at a fresh attach agree because the
        desk is 80 and the default is 80, not because anything was measured.
        With a real 80-column client attached and the phone at 60 it therefore
        asserted the opposite of the truth while columns 61 to 80 fell off the
        right-hand edge with no way to reach them. `grid` now carries the
        window's real size after every resize (see the `pane` frame's
        `by: "phone"`), so `following` is a measurement and the two strips
        cannot both be wrong about the same window.

        It only speaks under 80 because that is where it starts to cost
        something. 80 is what every TUI is written against; below it a window
        split in two or four gives its panes twenty-odd columns each, which is
        where an agent's prompt box stops being a box. Measured at 60: the four
        panes of a live window were 23, 36, 23 and 36 columns.

        The tap goes to 80 rather than toggling `fit`, because `fit` is not the
        control that is doing this and offering it would be the third wrong
        thing this strip has said.
      */}
      {live && !fit && following && columns < 80 ? (
        <Pressable
          onPress={() => setColumns(80)}
          style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm, backgroundColor: C.bg2 }}
        >
          <Text style={{ color: C.text3, fontSize: T.eyebrow }}>
            Nothing wider is looking at this window, so it is
            {" "}<Text style={{ color: C.text2, fontFamily: MONO }}>{columns}</Text> columns for the
            computer too — and a split pane gets a share of that.
            {" "}<Text style={{ color: C.primary, fontWeight: "700" }}>Tap for 80</Text>.
          </Text>
        </Pressable>
      ) : null}
      {open && state !== "live" ? (
        <View style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.xs, backgroundColor: C.bg2 }}>
          <Text style={{ color: state === "gone" ? C.error : C.text3, fontSize: T.eyebrow }}>
            {state === "connecting" ? "Attaching…" : why ?? "Disconnected"}
          </Text>
        </View>
      ) : null}

      {/*
        ── the keys a phone does not have, and the composer ────────────────

        No bottom inset is paid here, and that absence is the point: this used
        to end in `insets.bottom + SPACE.sm` and the band of empty background
        under the bar was the inset, paid twice. A tab screen is laid out ABOVE
        the tab bar rather than behind it, and BottomTabBar already sets
        `paddingBottom: insets.bottom` on itself — so the gesture bar is
        already accounted for by the time this row exists, and adding it again
        just pushes everything up by the height of a navigation bar.
      */}
      <View style={{ borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <ScrollView
            horizontal
            // The default is "never", which with the composer focused spends
            // the first tap on dismissing the keyboard and never delivers it —
            // and Esc, Tab and the arrows are what a person wants mid-line,
            // not after putting the keyboard away.
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: SPACE.sm, paddingVertical: SPACE.sm, gap: SPACE.xs }}
          >
            {/* The prefix goes first, before Esc: on a tmux pane it is the key
                that reaches the session itself — new window, next window,
                detach — and everything else only reaches the program inside it. */}
            {[...(prefix ? [prefix] : []), ...ACCESSORY_KEYS].map((key) => (
              <Pressable
                key={key.id}
                accessibilityRole="button"
                accessibilityLabel={key.spoken}
                onPress={() => onKey(key.bytes)}
                // Held down for the arrows and the deletes only — the table says
                // which, and nothing that runs a command is in that set.
                onLongPress={key.repeatable ? () => onKey(key.bytes + key.bytes + key.bytes) : undefined}
                style={({ pressed }) => ({
                  // 36 for the arrows. Under the 44 tap target and said out
                  // loud rather than tuned quietly: they are one glyph, they
                  // are 40 tall either way, and the eight points each buys the
                  // seventh key at the fold — which measured is the difference
                  // between Ctrl+C being on the bar and being behind a swipe.
                  minWidth: key.narrow ? 36 : 44,
                  borderWidth: key.id === "tmuxPrefix" ? 1 : 0,
                  borderColor: C.primary,
                  minHeight: 40,
                  // Only ⇧Tab is wider than the minimum, and its padding is the
                  // only thing between it and the fold.
                  paddingHorizontal: SPACE.xs,
                  borderRadius: RADIUS.sm,
                  backgroundColor: pressed ? C.bg4 : C.bg3,
                  alignItems: "center",
                  justifyContent: "center",
                })}
              >
                <Text style={{ color: C.text2, fontSize: T.small, fontFamily: MONO }}>{key.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* How the pane is drawn, pinned to the end of the key row rather
              than given a row of its own. With the keyboard up the terminal
              has something like two hundred points left, and a row of controls
              is fifty of them — a quarter of what there is to read, spent on
              two switches. The key bar scrolls, so lending it the width costs
              scrolling and nothing else. */}
          <View style={{
            flexDirection: "row", gap: SPACE.xs, alignItems: "center",
            // Four points each side rather than eight: at eight the seventh key
            // came out cut down the middle of its own glyph, which reads as a
            // fault rather than as "the row scrolls".
            paddingHorizontal: SPACE.xs,
            borderLeftWidth: 1, borderLeftColor: C.border,
          }}>
            <Pressable
              // Either way round this is now the person's own doing, so the
              // computer stops being credited for it.
              onPress={() => { setFit((v) => !v); setTookBack(null); }}
              accessibilityLabel={fit ? "The window fits this phone. Tap to keep the desk's size." : "The window keeps the desk's size. Tap to fit this phone."}
              // 40 rather than 52, and the width control 44 rather than 56:
              // these two are pinned, so every point they take is a point the
              // scrolling keys never get back, and neither label wants more.
              style={{ minWidth: 40, height: 40, alignItems: "center", justifyContent: "center",
                borderRadius: RADIUS.sm, backgroundColor: C.bg3,
                borderWidth: 1, borderColor: fit ? C.primary : "transparent" }}
            >
              <Text style={{ color: fit ? C.primary : C.text4, fontSize: T.small, fontFamily: MONO }}>fit</Text>
            </Pressable>
            {/* Width in columns, cycled rather than typed. 60 is a comfortable
                read and 80 is what every TUI is written against. Which you want
                depends on whether you are reading or driving, and it changes
                several times in a session — so it is one tap, not a settings
                screen. The rung above 80 is gone: see `columns`, where the
                measurement is that at 120 the glyphs are clipped inside their
                cells and characters change identity. */}
            <Pressable
              onPress={() => setColumns((n) => (n >= 80 ? 60 : 80))}
              accessibilityLabel={`Terminal width, ${columns} columns. Tap to change.`}
              style={{ minWidth: 44, height: 40, alignItems: "center", justifyContent: "center",
                borderRadius: RADIUS.sm, backgroundColor: C.bg3 }}
            >
              <Text style={{ color: C.text2, fontSize: T.small, fontFamily: MONO }}>{columns}c</Text>
            </Pressable>
          </View>
        </View>

        <View style={{
          flexDirection: "row", gap: SPACE.xs, alignItems: "flex-end",
          paddingHorizontal: SPACE.sm, paddingBottom: SPACE.sm,
        }}>
          <Pressable
            // The transcript is emptied on the way past, in both directions: it
            // belongs to `keys`, and a deliberate tap is a moment when nothing
            // is being typed.
            onPress={() => { setRaw((v) => !v); forgetKeys(); }}
            accessibilityRole="button"
            accessibilityLabel={raw
              ? "Every key goes straight to the pane. Tap to compose a line instead."
              : "The field composes a line. Tap to send every key straight to the pane."}
            // Bordered in BOTH states. Unbordered and grey it read as a label
            // on the field rather than a switch — "line" is a plausible thing
            // for a text box to be called, so there was nothing on screen to
            // suggest the other half of this screen's behaviour exists.
            style={{ minWidth: 52, height: TAP, alignItems: "center", justifyContent: "center",
              borderRadius: RADIUS.sm, backgroundColor: C.bg3,
              borderWidth: 1, borderColor: raw ? C.primary : C.border2 }}
          >
            <Text style={{ color: raw ? C.primary : C.text3, fontSize: T.small, fontFamily: MONO }}>
              {raw ? "keys" : "line"}
            </Text>
          </Pressable>
          <TextInput
            value={raw ? keyed : draft}
            onChangeText={typed}
            placeholder={open
              ? raw
                ? "Keys go straight through"
                // Said differently in the two cases, because they behave
                // differently and a field that lies about which one it is in is
                // worse than one that says nothing.
                : mirror ? "This is the pane's line — type into it" : "Write a line for this pane"
              : "Nothing is open"}
            placeholderTextColor={C.text4}
            editable={!!open}
            // Putting the phone down hands the line back to the pane, which is
            // the only moment it is safe to: the field is no longer where
            // anybody is looking. See `claimed`. `keys` empties its transcript
            // on the same event and for the same reason — a field nobody is
            // typing into is the one place an asynchronous clear cannot race a
            // keystroke.
            onBlur={() => { claimed.current = false; forgetKeys(); }}
            // A shell is case-sensitive and knows its own words. Every one of
            // these on is a keyboard rewriting a command into English.
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            // The keyboard that does not predict, which in `keys` is not a
            // preference: prediction rewrites characters it has already given
            // up, and those have gone down the socket.
            keyboardType={raw ? (Platform.OS === "android" ? "visible-password" : "ascii-capable") : "default"}
            // Multiline so a long command wraps and the field grows to about
            // five lines, but the return key SENDS rather than adding a line —
            // this is a terminal, and Enter has meant "run it" the whole time.
            // A newline can still arrive by paste, and `submit` handles that.
            multiline
            submitBehavior="submit"
            /*
             * There is no onKeyPress here any more, and its absence is the fix
             * rather than an omission.
             *
             * It was the only route a backspace had in `keys`, on the reasoning
             * that an always-empty field has nothing to delete and so reports no
             * change. Android does not fire it: measured on the emulator, `xyz`
             * on the pane was still `xyz` after two presses of the soft
             * keyboard's backspace. Now that the field keeps what was typed (see
             * `keyed`), a backspace IS an ordinary change and `editFor` turns it
             * into DEL — and leaving this handler in would send that DEL twice.
             * Backspace against an empty field still does nothing, which is what
             * it should do; the bar's own ⌫ is what reaches a pane with nothing
             * of ours in front of it.
             */
            onSubmitEditing={onReturn}
            style={{
              flex: 1, minHeight: TAP, maxHeight: 120,
              borderRadius: RADIUS.md, backgroundColor: C.bg,
              borderWidth: 1, borderColor: C.border, color: C.text,
              paddingHorizontal: SPACE.md, paddingTop: SPACE.sm, paddingBottom: SPACE.sm,
              fontSize: T.body, fontFamily: MONO,
            }}
          />
          {/* Send, or Enter — the same thing the return key does, put where a
              thumb already is. */}
          <Pressable
            onPress={onReturn}
            accessibilityRole="button"
            accessibilityLabel={raw ? "Enter" : "Send this line to the pane"}
            disabled={!canSend}
            style={{
              width: TAP, height: TAP, borderRadius: RADIUS.md,
              alignItems: "center", justifyContent: "center",
              backgroundColor: canSend ? C.primary : C.bg3,
            }}
          >
            <Text style={{ color: canSend ? ink(C.primary) : C.text4, fontSize: T.title }}>
              {raw ? "⏎" : "↑"}
            </Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
