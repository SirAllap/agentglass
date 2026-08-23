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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { useDeskPalette, usePaletteTick } from "../../src/state/use-palette.ts";
import { TerminalView, type TerminalHandle, type TerminalState } from "../../src/terminal/TerminalView.tsx";
import { ACCESSORY_KEYS, prefixKey, type AccessoryKey } from "../../src/terminal/keys.ts";
import { editFor } from "../../src/terminal/mirror.ts";
import { onHandoff, takeHandoff } from "../../src/terminal/handoff.ts";
import { BackIcon, ImageIcon } from "../../src/nav/icons.tsx";
import { fileFrom, pastePayload, type Uploaded } from "../../src/terminal/imagePaste.ts";

/** One row of `/terminal/agents`. Declared here rather than in shared/ for the
 *  same reason PrViewCounts is: it is this route's answer shape and nothing
 *  else reads it — see the note in app/(tabs)/prs.tsx. */
interface AgentOffer {
  id: string;
  title: string;
  what: string;
  /** On THIS machine. A name with no binary behind it is drawn and refused,
   *  never offered. */
  installed: boolean;
  /** Whether this CLI has a skip-permissions flag at all. */
  canBypass: boolean;
}
import { bestSession, readStrip, sessionsOf, type Tab } from "../../src/terminal/tabs.ts";
import type { PanesResponse } from "../../../shared/types.ts";
import { Btn, Card, Label, Note, Sheet, SheetRow, TAP } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T, ink } from "../../src/theme.ts";

export default function TerminalScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host, fleet } = useAgentglass();
  const router = useRouter();
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
  /* How many agents are stopped at a gate. Straight off the store's own list
     rather than through the queue's rules: a pending gate IS the fact — the
     hook's request is open and nothing proceeds until somebody answers — and
     it needs no interpretation to be counted. */
  const held = fleet.gates.length;

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
   * The line the PANE already holds, when the field could not be made editable.
   *
   * The third state, and the one that was missing. `shadow` has two: a line
   * this field can type into, or nothing at all. An agent's box that has
   * wrapped is neither — the text is readable and its length is not (see
   * boxedLine in terminal-html.ts), so the field can show it and cannot compute
   * an edit against it.
   *
   * Treating that as `shadow = null`, which is what happened before this
   * existed, is what makes the phone send a line the pane already has. Measured
   * on the emulator: `esto es una linea larga escrita en el ordenador para ver
   * si el movil la` was typed at the computer, the phone's field went empty and
   * became a composer, and one word typed into it submitted
   * "…si el movil la hola2" — the desk's line and the phone's word, run as one
   * prompt. Holding what the pane has is what lets Send know there is nothing
   * to send but a carriage return.
   */
  const onPane = useRef<string | null>(null);
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
   * A `+` that is waiting on tmux, and what to say if it comes back with a
   * reason instead of a window.
   *
   * A button that opens a window somewhere else on the machine has nothing on
   * this screen to show for itself for about a second — the strip is on a
   * two-second poll — so without this the honest reading of a press is "nothing
   * happened", and the second press opens a second agent.
   */
  const [opening, setOpening] = useState(false);
  /** The new-tab menu, and the agents the MACHINE reports. Null until it
   *  answers, so the sheet says it is asking rather than drawing an empty list
   *  that reads as "none available". */
  const [picking, setPicking] = useState(false);
  const [agents, setAgents] = useState<AgentOffer[] | null>(null);
  /** An attachment on its way up. The picker can be open for a long time and
   *  the upload is the only part worth a spinner, so this is set after the
   *  picture has been chosen rather than before the gallery opens. */
  const [sending, setSending] = useState(false);
  /** The deadline on that spinner. A ref because it is cleared from a callback
   *  that must not re-run when it changes. */
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * A pane the server has just made for us, which the strip has not caught up
   * with yet.
   *
   * Held so `load` cannot take the selection back. tmux answers with the new
   * pane immediately; `/terminal/panes` is on a two-second poll, and the tick
   * that lands in between carries a list this pane is not in — so the reselect
   * inside `load` would move the user off the tab they just asked for, once,
   * and only sometimes. A ref rather than state because it is read inside a
   * state updater.
   */
  const wanted = useRef<string | null>(null);

  /*
   * Open a window in the project this pane is in, with the agent running in it.
   *
   * Sent as an INTENT and not a command: the frame carries `yolo` and nothing
   * else. The directory is the server's — it reads the pane's own cwd and rolls
   * it up to that checkout's git root — and so is the binary and the flag. A
   * `new-window` with no directory lands in the home directory, which is the
   * failure this button would otherwise have shipped with: an agent opened in
   * no repository, in a tab that looks exactly like the right one.
   *
   * Permissions off, because that is what this button is FOR. A tab opened from
   * a phone is a tab nobody is sitting in front of, and an agent that stops on
   * its first tool call to ask a question there has done nothing at all. The
   * button says so in as many words rather than hiding it in a mode.
   */
  /* Asked once per host rather than when the sheet opens: it is a small read
     and a menu that spins on the way in is a menu people stop opening. */
  useEffect(() => {
    if (!host) { setAgents(null); return; }
    let gone = false;
    void (async () => {
      const answer = await ask<{ ok: boolean; agents?: AgentOffer[] }>(host, "/terminal/agents");
      if (gone || !answer.ok || !answer.value.ok) return;
      setAgents(answer.value.agents ?? []);
    })();
    return () => { gone = true; };
  }, [host]);

  /**
   * Attach a picture to whatever is running in the pane.
   *
   * `expo-image-picker` is required INSIDE the function and behind a try, which
   * is the rule test/native-imports.test.ts holds: a native module imported at
   * the top of a file the router reaches takes the whole route tree down on a
   * build that does not carry it. This app has shipped a blank screen twice
   * that way.
   *
   * The bytes go up, a path comes back, and the path is pasted — see
   * src/terminal/imagePaste.ts for why a path and why bracketed paste.
   */
  const attach = useCallback(async (): Promise<void> => {
    if (!host || !terminal.current) return;
    let picker: typeof import("expo-image-picker");
    try {
      picker = require("expo-image-picker") as typeof import("expo-image-picker");
    } catch {
      setError("This build has no image picker.");
      return;
    }

    const allowed = await picker.requestMediaLibraryPermissionsAsync();
    if (!allowed.granted) { setError("The gallery is not allowed for this app."); return; }

    // base64 asked for here rather than read from the uri afterwards: the file
    // system module is a second native dependency, and this one already has
    // the bytes.
    const picked = await picker.launchImageLibraryAsync({ base64: true, quality: 0.8 });
    if (picked.canceled || !picked.assets?.length) return;
    const asset = picked.assets[0]!;
    if (!asset.base64) { setError("That picture came back empty."); return; }

    setSending(true);
    setError(null);
    const answer = await ask<Uploaded>(host, "/terminal/image", {
      method: "POST",
      body: { data: asset.base64, name: asset.fileName ?? asset.uri ?? "image.png" },
    });
    setSending(false);

    const got = fileFrom(answer.ok ? answer.value : { ok: false, error: answer.error });
    if ("error" in got) { setError(got.error); return; }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    terminal.current.send(pastePayload(got.file));
  }, [host, terminal]);

  const openAgent = useCallback((kind: string, yolo: boolean): void => {
    if (!terminal.current) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setOpening(true);
    setError(null);
    setPicking(false);
    terminal.current.command({ t: "tmux", cmd: "agent", kind, yolo });
    /*
     * And a deadline, because a spinner with no way out is worse than a
     * refusal.
     *
     * Reported from QA: the control went to `…` and stayed there, for as long
     * as anybody watched. The server had returned silently — the frame reached
     * a guard above this command that answers nothing — and there was no second
     * writer of `opening`, so the button was dead until the screen remounted.
     *
     * That server path is fixed, but it must not be the only thing standing
     * between a user and a permanent spinner. A socket can also drop between
     * the send and the reply, and `command()` puts nothing on the wire at all
     * when the socket is not open, which looks identical from here. So this
     * ends by itself and says so.
     *
     * Eight seconds because the work behind it is `new-window` on a local tmux
     * — measured in tens of milliseconds — plus however long the phone's radio
     * takes to carry two small frames. A second would race a sleeping radio; a
     * minute is a button nobody presses twice.
     */
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpening((waiting) => {
        if (waiting) setError("The computer did not answer about the new tab.");
        return false;
      });
    }, 8000);
  }, []);


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
      // A pane we asked for and the strip has not listed yet — see `wanted`.
      // Held rather than adopted, so the selection does not bounce off it.
      const want = wanted.current;
      if (want) {
        if (!all.some((t) => t.paneId === want)) return current;
        wanted.current = null;
        return want;
      }
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

  /** What came back from that. Either a pane to go to, or a reason. */
  const onOpened = useCallback((answer: { pane: string } | { error: string }): void => {
    // The answer landed, so the deadline above has nothing left to say.
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    setOpening(false);
    if ("error" in answer) { setError(answer.error); return; }
    // Straight there. The pane exists on the machine the moment tmux answers,
    // so the attach does not have to wait for the strip to list it — `wanted`
    // is what stops the next poll undoing this.
    wanted.current = answer.pane;
    setActive(answer.pane);
    setWhy(null);
    void load();
  }, [load]);

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
    // And the read of it, for the same reason: a bar key changes the line under
    // the field, so what `onPane` holds describes a screen that no longer
    // exists. Dropped rather than refreshed — the next report seeds it again.
    onPane.current = null;
    terminal.current?.send(bytes);
  }, []);

  /**
   * Deliver whatever another screen left in the letterbox.
   *
   * Called from two places on purpose, because there are two orders these
   * events arrive in and both happen. Press the button with the terminal
   * already attached and the request is left AFTER the socket exists, so the
   * subscription below is what delivers it; press it having never opened this
   * tab and the socket comes up second, so `onState` going `live` is.
   *
   * `takeHandoff` empties the slot, so whichever of the two gets there first
   * wins and the other finds nothing. That is the whole of the de-duplication:
   * a window-opening frame sent twice is two windows.
   */
  const deliver = useCallback((): void => {
    if (!terminal.current) return;
    const frame = takeHandoff();
    if (!frame) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setOpening(true);
    setError(null);
    terminal.current.command(frame);
    /*
     * The same deadline the `+` carries, and for the same reason written over
     * it: the server can decline silently, and a spinner with no way out is
     * worse than a refusal. Eight seconds is `new-window` on a local tmux plus
     * a phone radio waking up.
     */
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpening((waiting) => {
        if (waiting) setError("The computer did not answer about that window.");
        return false;
      });
    }, 8000);
  }, []);

  // A request left while this screen is already up. The socket may not be open
  // yet — `deliver` reads the ref, and a frame sent into a closed socket is
  // dropped by `command()`, so the guard is that this only fires on arrival and
  // `onState` covers the other order.
  useFocusEffect(useCallback(() => onHandoff(() => {
    if (state === "live") deliver();
  }), [deliver, state]));

  const onState = useCallback((next: TerminalState, detail?: string): void => {
    setState(next);
    setWhy(detail ?? null);
    // A socket that has just come up is the moment a waiting request can go.
    if (next === "live") deliver();
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
  }, [deliver]);

  /*
   * The pane's input line, as the page reads it off the screen.
   *
   * Ignored outright once the line is claimed — see `claimed`. The pane echoes
   * what we send, so every keystroke comes back a moment later: adopting it
   * would move the cursor to the end mid-word and undo an edit made in the
   * middle of a line, and adopting a `null` from a pane too narrow to read
   * silently cuts the field off from the shell it is typing into.
   */
  const onLine = useCallback((text: string | null, exact = true): void => {
    if (claimed.current) return;
    // Editable only when the read is exact. An inexact one still fills the
    // field — that is the whole point, the two sides are meant to show the same
    // thing — but it is remembered as the pane's rather than as ours, so
    // nothing computes a difference against a length that was reconstructed.
    shadow.current = exact ? text : null;
    onPane.current = exact ? null : text;
    setMirror(text !== null);
    if (text !== null) setDraft(text);
  }, []);

  /**
   * Send this line, whatever route it took to be on the pane.
   *
   * Takes the text rather than reading `draft`, because the return key can
   * arrive as part of a change — see `typed` — and then the text to send is the
   * one in that event and not the one the last paint was made from.
   */
  const commit = useCallback((text: string): void => {
    /*
     * With the mirror on, the line is ALREADY on the pane — this key put it
     * there character by character — so sending the text again would run it
     * twice. Enter is all that is left to send, and that is the whole of what
     * this button means.
     */
    if (shadow.current !== null) {
      if (!text) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      terminal.current?.send("\r");
      // Cleared here rather than waiting for the pane to say so: the field is
      // empty the instant Enter is pressed, everywhere else in the world.
      shadow.current = "";
      onPane.current = null;
      // The line is gone, so nobody owns it any more and the pane may seed the
      // next one. Released here rather than on blur alone: sending is how a
      // line ends, and the keyboard usually stays up for the next one.
      claimed.current = false;
      setDraft("");
      return;
    }
    /*
     * The pane has this line and this field only READ it — so, again, Enter
     * and nothing else.
     *
     * The branch below would send the text, and that is the corruption this
     * whole `onPane` business exists to stop: measured on the emulator, a long
     * line typed at the computer plus one word typed here ran as the two of
     * them concatenated. `onPane` is only ever set from a line that is on the
     * screen, so "already there" is a fact and not an assumption.
     */
    if (onPane.current !== null) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      terminal.current?.send("\r");
      onPane.current = null;
      claimed.current = false;
      setDraft("");
      return;
    }
    if (!text) return;
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
    terminal.current?.send(`${text.replace(/\n/g, "\r")}\r`);
    setDraft("");
  }, []);

  /**
   * The bytes an edit becomes, with the one character a terminal must never be
   * handed by accident taken out.
   *
   * A newline in the MIDDLE of the field can only have arrived by paste, and
   * what it means on a pane is not what it means in a text box. Measured
   * against a real Claude Code pane: a bare LF does not submit, it puts a
   * SECOND ROW in the input box — and the cursor then sits on a row with no
   * prompt marker on it, which is the exact state that turns the mirror off.
   * So one keystroke would both fail to do what was asked and break the field
   * that asked it. CR is what the return key is on a terminal, and it is what
   * every other path here already sends.
   */
  const forPane = (keys: string): string => keys.replace(/\n/g, "\r");

  /*
   * Not memoised, and that is deliberate rather than an omission: it reads
   * `raw`, and a `typed` held across a mode switch is a field that goes on
   * behaving like the mode it was created in. A `TextInput`'s `onChangeText` is
   * not a memo boundary, so a new function per render costs nothing here.
   */
  function typed(text: string): void {
    /*
     * A newline at the END of the field is the return key, and it has to be
     * caught here because it does not always arrive as one.
     *
     * `onSubmitEditing` is the documented route and it fires for Gboard's ✓ and
     * for a hardware Enter — both measured on the emulator. It is not the only
     * route: an IME that commits the return as TEXT through the input
     * connection never raises an editor action at all, and then the newline
     * simply lands in the field. That is the shape of "I press enter and
     * nothing sends, and then it works the second time" — the second press
     * comes after the composing region has been ended by the tap, and takes the
     * other route.
     *
     * Both routes now end in `commit`, so whichever the keyboard chooses, the
     * line goes. The newline itself never reaches the pane.
     */
    if (text.endsWith("\n")) {
      const body = text.replace(/\n+$/, "");
      typedBody(body);
      commit(body);
      return;
    }
    typedBody(text);
  }

  /**
   * What the field does with what was typed, which is the whole of the mode.
   *
   * In `keys` the field is a conduit rather than a place: the difference is put
   * on the pane's stdin as it is made, and the field keeps what was typed so a
   * backspace is an ordinary change rather than a key event Android will not
   * deliver — see `keyed`.
   */
  function typedBody(text: string): void {
    if (raw) {
      setKeyed(text);
      // The difference, not the field. See `keyed` above for the measurement
      // that made this the shape it is — and note that a SHRINKING field is a
      // backspace, which `editFor` spells as the DEL a terminal's erase key
      // sends rather than as a retype.
      const keys = editFor(keyedSent.current, text);
      keyedSent.current = text;
      if (keys) terminal.current?.send(forPane(keys));
      return;
    }
    setDraft(text);
    // From here the line is this person's, and what the pane says about it is
    // no longer listened to. An empty field gives it back, so clearing the
    // field and waiting is a way to pick up whatever is typed at the desk.
    claimed.current = text.length > 0;

    /*
     * A line this field only READ can still be typed onto — as long as the
     * typing is at the END of it.
     *
     * That restriction is not caution, it is the whole of what is knowable.
     * `onPane` holds a line rejoined from the rows an agent wrapped it across,
     * so its LENGTH may be off by one per break (see boxedLine); a DEL count
     * computed against it would delete the wrong number of characters from
     * somebody's real prompt. An APPEND needs no length at all — what to send
     * is the part of the field past the text that was shown, and that is exact
     * whatever happened at the joins.
     *
     * Once one character has been appended, this field's own record takes over
     * and every edit after it is ordinary: `shadow` starts from the text that
     * was displayed, so backspacing into what was just typed is exact too, and
     * backspacing PAST it fails the prefix test above and is left alone.
     */
    if (shadow.current === null && onPane.current !== null) {
      if (!text.startsWith(onPane.current)) return;
      shadow.current = onPane.current;
    }

    const was = shadow.current;
    if (was === null) return; // a composer: nothing leaves until it is sent

    // The edit, as the pane would have received it from a keyboard — erase back
    // to where the two lines agree, then type the rest. See `editFor`, which is
    // where the reasoning and the tests for it live.
    const keys = editFor(was, text);
    if (!keys) return;
    shadow.current = text;
    terminal.current?.send(forPane(keys));
  }

  /** What the return key does, in either mode. In `keys` nothing is being held
   *  back, so it is the key itself and goes through the bar's own route. */
  const onReturn = useCallback((): void => {
    if (raw) { onKey("\r"); return; }
    commit(draft);
  }, [raw, onKey, commit, draft]);

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
        {/*
          Where you are, above what you are switching between.

          This bar was empty — a `+` and a `⟳` floating over a strip of pills,
          with nothing saying which checkout the pane in front of you belongs
          to. On a phone that is the question you arrive with: there are six
          windows called `2 AI00` and the only thing that tells them apart is
          the directory, which was one screen further in.

          The count beside it is not decoration either. A strip that has
          scrolled shows three of eight, and "8 tabs" is how you know the other
          five exist without dragging to find out.
        */}
        <View style={{
          flexDirection: "row", alignItems: "center", gap: SPACE.sm,
          paddingHorizontal: SPACE.xs, paddingTop: SPACE.xs,
        }}>
          {/*
            The way out, and it is load-bearing rather than decorative.

            This screen is the one that does not draw the tab bar — see the
            note in src/nav/TabBar.tsx for why it gives the pane those ninety
            points. Which means this is the only control on it that leads
            anywhere, and without it the way back would be Android's own
            gesture, which on the first tab of a navigator closes the app
            rather than going anywhere.
          */}
          <Pressable
            onPress={() => router.replace("/")}
            accessibilityRole="button"
            accessibilityLabel="Back to the inbox"
            style={({ pressed }) => ({
              width: 40, minHeight: 44, alignItems: "center", justifyContent: "center",
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <BackIcon color={C.text3} size={20} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              numberOfLines={1}
              ellipsizeMode="head"
              style={{ color: C.text, fontSize: T.body, fontWeight: "700" }}
            >
              {/* The leaf, because that is what a person calls a checkout —
                  the same rule tabs.ts uses for a window's name. The head is
                  what gets cut when a path is long: the tail is the part that
                  says which one. */}
              {open ? (open.where.split("/").filter(Boolean).pop() ?? open.session) : "Terminal"}
            </Text>
            <Text numberOfLines={1} style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>
              {open
                ? `${open.session}${tabs.length ? ` · ${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}` : ""}`
                : "nothing attached"}
            </Text>
          </View>
          {/*
            A new tab, with an agent already running in it.

            Pinned beside the re-read rather than carried at the end of the
            scroller, and for the reason written on that button: where a control
            riding after the last tab SITS depends on how many tabs there are,
            so with six windows the `+` is off the right-hand edge — and the
            moment somebody wants a seventh is the moment there are six.

            Live only while a pane is attached, because the pane is what says
            WHERE: the server reads this pane's own directory to decide which
            project the window opens in. Without one there is no answer that is
            not the home directory, which is the wrong tab drawn convincingly.
          */}
          <Pressable
            onPress={() => setPicking(true)}
            disabled={!open || opening}
            accessibilityRole="button"
            accessibilityLabel="New tab in this project"
            style={{
              paddingHorizontal: SPACE.md, minHeight: 44, justifyContent: "center",
              borderLeftWidth: 1, borderLeftColor: C.border,
            }}
          >
            <Text style={{
              color: !open || opening ? C.text4 : C.primary,
              fontSize: T.title, fontWeight: "700",
            }}>{opening ? "…" : "+"}</Text>
          </Pressable>
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
        {/* Just the tabs. `+` and the re-read moved up to the header, which is
            where the pair of them stop depending on how many tabs there are:
            riding at the end of this scroller put them off the right-hand edge
            at six windows, and six windows is exactly when somebody reaches for
            a seventh or for the re-read.

            Drawn only when there ARE tabs. An empty strip under the header was
            a rule with nothing above it — a row of chrome whose whole content
            was the absence of content. */}
        {tabs.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            /* No vertical padding on the container: the underline is the bar's
               own bottom edge, and padding under it would leave the mark
               floating above the rule it is supposed to be part of. */
            contentContainerStyle={{ paddingHorizontal: SPACE.xs, gap: 0 }}
          >
            {tabs.map((tab) => {
              const on = tab.paneId === active;
              return (
                <Pressable
                  key={tab.paneId}
                  onPress={() => { setActive(tab.paneId); setWhy(null); }}
                  /*
                    An underline, not a pill.

                    A pill is a button and reads like one — six of them in a row
                    is six things to press, and the selected one is a seventh
                    shade of grey among them. An underline is what a tab strip
                    has always been: the row is the surface, the mark says which
                    part of it you are looking at, and the text carries the rest.
                    It also buys back the horizontal padding a border needs,
                    which is what puts a fourth window on screen.
                  */
                  style={{
                    paddingHorizontal: SPACE.md,
                    paddingVertical: SPACE.sm,
                    borderBottomWidth: 2,
                    borderBottomColor: on ? C.primary : "transparent",
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
        ) : null}
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
            onOpened={onOpened}
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

      {/*
        A held gate, and the way to answer it.

        This is the door the Inbox gave up. Approving a command an agent is
        stopped on is the reason this app exists — it is the only POST a
        phone paired for "answer" may make — and when agents left the Inbox
        it was left reachable only from Settings, which is not where anybody
        would look for it.

        Here, because this is where agents live now: the star is the one
        surface that shows what an agent is doing, so it is the one that
        should say when an agent has stopped and is waiting. It draws only
        when something is actually held, which is what keeps it a signal —
        the same rule the two strips below follow.
      */}
      {held > 0 ? (
        <Pressable
          onPress={() => router.push("/now")}
          accessibilityRole="button"
          accessibilityLabel={`${held} ${held === 1 ? "agent is" : "agents are"} waiting on you. Opens the queue.`}
          style={{
            flexDirection: "row", alignItems: "center", gap: SPACE.sm,
            paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm,
            backgroundColor: C.bg2, borderTopWidth: 2, borderTopColor: C.error,
          }}
        >
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.error }} />
          <Text style={{ color: C.text, fontSize: T.small, fontWeight: "700", flex: 1 }} numberOfLines={1}>
            {held === 1 ? "An agent is stopped, waiting on you" : `${held} agents are stopped, waiting on you`}
          </Text>
          <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "700" }}>Answer</Text>
        </Pressable>
      ) : null}

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
      {/*
        Something this screen was told and has nowhere else to say.

        Reported from QA, and it was the message ABOUT the missing message: the
        `+`'s deadline fired, the control came back — measured — and the
        sentence explaining why never appeared anywhere. `error` had exactly one
        reader, inside the "Nothing open" card, which draws only when NO pane is
        attached. A pane is attached whenever the `+` can be pressed at all, so
        every word written here went to a branch that could not be on screen at
        the same time as the button that wrote it. The server's own refusal —
        "this terminal is not attached to tmux yet" — was invisible for the same
        reason and had never been seen either.

        Tap to dismiss. It is the answer to a press, so it belongs to the person
        who pressed and should go when they have read it, rather than sitting
        over the pane until something else replaces it.
      */}
      {open && error ? (
        <Pressable
          onPress={() => setError(null)}
          accessibilityRole="button"
          accessibilityLabel={`${error}. Tap to dismiss.`}
          style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm, backgroundColor: C.bg2 }}
        >
          <Text style={{ color: C.error, fontSize: T.eyebrow }}>{error}</Text>
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
          {/*
            A picture, beside the field rather than behind a menu.

            It sits here because this is the row where somebody is already
            composing — the thing being attached is part of the sentence they
            are writing, not a separate errand. Only while a pane is open: with
            nothing attached there is nowhere for a path to be pasted, and a
            button that opens a gallery to then say "no pane" is a trip to the
            photo library for nothing.

            No `full` gate. This writes a temporary file the server chose the
            location of and then types into a pane the phone is already allowed
            to type into — it buys no permission the keyboard above it does not
            already have.
          */}
          <Pressable
            onPress={() => { void attach(); }}
            disabled={!open || sending}
            accessibilityRole="button"
            accessibilityLabel="Attach a picture to this pane"
            style={({ pressed }) => ({
              width: 44, height: TAP, alignItems: "center", justifyContent: "center",
              borderRadius: RADIUS.sm, backgroundColor: C.bg3,
              borderWidth: 1, borderColor: C.border2,
              opacity: !open ? 0.4 : pressed ? 0.6 : 1,
            })}
          >
            {sending
              ? <ActivityIndicator color={C.text3} size="small" />
              : <ImageIcon color={C.text3} size={19} />}
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
      {/*
        The new tab, as a choice rather than a silent default.

        `+` used to start Claude with permission prompts OFF, every time, with
        the whole of that decision living in an accessibility label nobody
        hears. That is the most consequential press on this screen — it is an
        agent let loose in a checkout — and it was the one with no dialog.

        The list is what the MACHINE reports, not what this app can imagine.
        `/terminal/agents` answers with `installed` per row, so a CLI that is
        not there is drawn greyed and says so, rather than being offered and
        failing after the window has already opened — which on a phone is a
        blank pane on a computer you are not sitting at.

        Permissions are a second press, not a switch on the row. A row that
        launches and a toggle that arms are two different gestures, and putting
        them in one control is how somebody means to read the list and starts
        an agent instead.
      */}
      <Sheet open={picking} onClose={() => setPicking(false)} title="New tab">
        {agents === null ? (
          <Note>Asking the computer which agents it has…</Note>
        ) : (
          <View style={{ gap: SPACE.xs, paddingBottom: SPACE.md }}>
            {agents.map((a) => (
              <View key={a.id} style={{ gap: SPACE.xs, paddingVertical: SPACE.xs }}>
                <SheetRow
                  label={a.installed ? a.title : `${a.title} — not installed`}
                  sub={a.what}
                  onPress={() => { if (a.installed) openAgent(a.id, false); }}
                />
                {/* Only where the CLI HAS the flag, and only when it is there
                    to run. A switch that buys nothing is a switch that teaches
                    the wrong thing about what pressing it did. */}
                {a.installed && a.canBypass ? (
                  <Pressable
                    onPress={() => openAgent(a.id, true)}
                    accessibilityRole="button"
                    style={({ pressed }) => ({
                      minHeight: TAP, justifyContent: "center",
                      paddingHorizontal: SPACE.lg, opacity: pressed ? 0.6 : 1,
                    })}
                  >
                    <Text style={{ color: C.warning, fontSize: T.small }}>
                      …and skip permission prompts
                    </Text>
                    <Text style={{ color: C.text4, fontSize: T.eyebrow }}>
                      It will not stop to ask before running a command.
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
            {agents.every((a) => !a.installed) ? (
              <Note tone="bad">
                No agent CLI is installed on that computer. A new tab would be a plain shell.
              </Note>
            ) : null}
          </View>
        )}
      </Sheet>

    </KeyboardAvoidingView>
  );
}
