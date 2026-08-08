/*
 * The terminal, as a document.
 *
 * There is no bundler and no network inside a WebView, so the whole thing —
 * xterm, its stylesheet, the icon font and the bridge below — is built here as
 * one string and handed over as HTML. `engine.generated.ts` holds the first
 * two and `nerdfont.generated.ts` the third; this is the last.
 *
 * ── who owns the socket ───────────────────────────────────────────────────
 * React Native does, not this page. Two reasons, and the first is decisive:
 * the upgrade to `/terminal/pty` needs an `Origin` header, and only React
 * Native's WebSocket takes one (see live.ts). The second is that a WebView is
 * reloaded for all sorts of reasons and a socket inside it would take the
 * shell down with it.
 *
 * So bytes cross the bridge in both directions:
 *   RN → page   `AGX.write(<base64>)`, injected.
 *   page → RN   `postMessage` with a small JSON envelope.
 *
 * Base64 and not text: a PTY frame is raw bytes, and decoding it as UTF-8 on
 * the way through turns a multi-byte character split across two frames into two
 * replacement characters — permanently, and half the box drawing in a TUI is
 * exactly that.
 */
import { XTERM_CSS, XTERM_JS } from "./engine.generated.ts";
import { NERD_ICONS_RANGE, NERD_ICONS_WOFF2_B64 } from "./nerdfont.generated.ts";
import { BASE, type Palette } from "../../../shared/palettes.ts";
import { contrastRatio, deriveAnsi } from "../../../shared/termPalette.ts";

export interface TerminalDocOptions {
  palette: Palette;
  /**
   * How many COLUMNS to show, not how big the text is.
   *
   * This is the whole difference between seeing the pane and seeing a corner
   * of it. tmux keeps the shared window at the desk's width (`window-size
   * largest`, so the phone cannot squeeze the desk), and a terminal that fits
   * ITSELF to a phone screen ends up 45 columns wide looking at a 200-column
   * window — tmux draws the left 45 and the rest is simply not on screen.
   *
   * So the phone asks for a column count and the font is computed from it. Ask
   * for 200 and you see all of a 200-column pane, tiny; ask for 80 and the text
   * is comfortable and you see the left 80. Which of those you want depends on
   * whether you are reading or driving, so it is a control rather than a
   * constant.
   */
  columns: number;
}

/**
 * The palette as xterm's theme object — all sixteen ANSI colours included.
 *
 * Exported because it has two callers now and must not have two copies: this
 * file bakes it into the document, and TerminalView injects it through
 * `AGX.theme` when the phone's theme changes under a terminal that is already
 * attached. A second mapping would mean the colours you get on a theme change
 * are not the colours you get on the next cold start.
 *
 * ── why the sixteen come from shared/ and not from the palette's own fields ──
 * They used to be a field-for-slot map: bg3 was black, info was blue AND cyan,
 * text was brightWhite. A palette carries four hues and a terminal needs six, so
 * that map could not be right, and measured against the two bases it was not:
 * black came out #21262d at 1.24:1 on the dark base and 1.17:1 on white —
 * invisible, in both — cyan was the same hex as blue, brightWhite the same as
 * white, and sixteen slots held ten colours. `ls --color` paints directories
 * blue and archives magenta; a diff paints its two sides red and green. Ten of
 * sixteen is a screen where some of that is silently the same colour.
 *
 * `deriveAnsi` is the desk's answer to the identical question and it branches on
 * the background's luminance, which is the part the phone had no notion of. It
 * is imported rather than reimplemented because a phone with its own idea of
 * what red means in a terminal is two products wearing one name.
 */
export function terminalTheme(palette: Palette): Record<string, string> {
  return {
    background: palette.bg,
    foreground: palette.text,
    cursor: palette.primary,
    cursorAccent: palette.bg,
    selectionBackground: `${palette.primary}55`,
    ...deriveAnsi({
      bg: palette.bg, text: palette.text, primary: palette.primary,
      error: palette.error, success: palette.success, warning: palette.warning, info: palette.info,
    }),
  };
}

/**
 * The same theme for the other kind of surface, kept in the page beside it.
 *
 * The pane is not always painted on the background this app chose. agentglass
 * syncs the desk's theme into the user's tmux, and that conf carries
 * `window-style "bg=<the desk's background>"` — measured on this machine with a
 * real tmux and a real client, every cell arrives carrying
 * `ESC[48;2;30;30;30m`, and it does so for xterm-256color, tmux-256color and
 * xterm-direct alike. So the phone's `background` is never reached inside the
 * grid, and a phone in Light against a dark synced tmux painted its default
 * foreground #1f2328 on #1e1e1e: the words at the top of a session vanished,
 * which is why the pane was pinned to dark and stopped following the phone at
 * all.
 *
 * Pinning it was the right refusal and the wrong fix — it made Light a lie on
 * the one screen people read most. So the page carries both sets and picks by
 * WHAT THE PANE IS ACTUALLY PAINTED WITH, read out of the buffer (see paneBg
 * below). The phone's mode decides the pane whenever the desk is not painting
 * one, and when the desk is, the colours match what it painted.
 *
 * The accent stays whatever the phone chose in both sets: it paints the cursor
 * and the selection, which are this client's own furniture and not something
 * the machine drew.
 */
export function counterTheme(palette: Palette): Record<string, string> {
  const isLight = contrastRatio(palette.bg, "#000000") > contrastRatio(palette.bg, "#ffffff");
  return terminalTheme({
    ...BASE[isLight ? "dark" : "light"],
    primary: palette.primary,
    primaryHover: palette.primaryHover,
  });
}

/**
 * Everything below the `return` is one template literal, so it may contain no
 * backticks — not even in a comment. One in a prose aside closed the string and
 * produced a syntax error thirty lines further down, in code that was fine.
 */
export function terminalDocument({ palette, columns }: TerminalDocOptions): string {
  // Serialised rather than interpolated field by field, so a colour that is
  // somehow not a colour cannot become script.
  const theme = JSON.stringify(terminalTheme(palette));
  const counter = JSON.stringify(counterTheme(palette));

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<style>${XTERM_CSS}</style>
<style>
  /*
   * The icons in the prompt, and only the icons.
   *
   * Android ships no Nerd Font, and asking for ui-monospace on it gets a face
   * with none of these glyphs: a prompt made of powerline separators, a
   * branch, a penguin and a clock came out as a row of empty boxes. The face
   * is carried in the page rather than fetched because this document lives on
   * about:blank with no network — see the top of this file.
   *
   * It is a FALLBACK and must stay one. See FONT_STACK below: xterm measures
   * the cell from the first face that answers, so a whole Nerd Font in front
   * would re-metric every character of text on the screen to fix seven
   * symbols.
   *
   * block rather than swap, because the alternative is drawing the boxes and
   * then replacing them. There is nothing to wait for — the bytes are already
   * in the document — so the block period is a decode and not a download.
   *
   * ── why unicode-range is not decoration ───────────────────────────────────
   * Being last in the stack keeps this face away from the cell WIDTH. It does
   * not keep it away from the cell HEIGHT, and without the ranges below it took
   * it: measured in the emulator's WebView, 32 W at 8.55px came out 164.143px
   * wide either way, but the line box went 9.905px → 11.429px, and the screen
   * went from 56 rows to 47. On a phone that is nine lines of somebody's
   * output; with fit on it is also nine rows off the desk's tmux window, since
   * the server resizes the window to the geometry this page reports.
   *
   * The cause is the CSS strut: the line box comes from the FIRST AVAILABLE
   * font, and on Android ui-monospace, Menlo and Consolas are all absent — so
   * the first face that actually exists is this one, and a Nerd Font is built
   * tall. A font whose unicode-range excludes U+0020 is skipped when that is
   * decided, which is exactly what these ranges do. Measured again with them:
   * the line box is back to 9.905px and the powerline glyph still draws.
   *
   * The other candidate was ascent-override/descent-override. It also restored
   * the strut, and it did it by shrinking the icon's own box to 8.381px — a
   * powerline separator is drawn to fill the cell it sits in, so that fixes the
   * grid by mis-drawing the glyph the grid is for.
   *
   * The list is read out of the face's own cmap, not written down beside it,
   * and it is not a formality either. A range WIDER than the font is its own
   * bug: a character inside it that this face has not got and that nothing on
   * the device has either draws this face's .notdef, which in a subset is
   * empty. Measured with the ranges the subset was cut with: U+23F5 went from
   * an empty box to nothing at all. With the real coverage it is a box again.
   */
  @font-face {
    font-family: "NerdIcons";
    src: url(data:font/woff2;base64,${NERD_ICONS_WOFF2_B64}) format("woff2");
    font-display: block;
    unicode-range: ${NERD_ICONS_RANGE};
  }
  html, body { margin: 0; padding: 0; height: 100%; background: ${palette.bg}; overflow: hidden; }
  #screen { position: absolute; inset: 0; }
  /* The cursor keeps blinking behind a screen nobody is looking at otherwise,
     which on a phone is a repaint per second for no reader. */
  .xterm.agx-idle .xterm-cursor-blink { animation: none !important; }
</style>
</head>
<body>
<div id="screen"></div>
<script>${XTERM_JS}</script>
<script>
(function () {
  var post = function (message) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };

  /*
   * The faces, in the order they are asked for, and the same list for the
   * probe below and for the terminal — measuring one stack and rendering
   * another is measuring somebody else's glyph.
   *
   * NerdIcons is second to last on purpose. A font stack is per CHARACTER: the
   * system monospace answers for everything it has, which is all the text, and
   * the icon face is only reached for the codepoints it has not got. Put it
   * first and it answers for everything — including the cell xterm measures.
   *
   * Being last is only half of it. The line HEIGHT does not follow the stack
   * order, and the unicode-range on the face is what keeps that honest — see
   * the @font-face above before touching either.
   */
  var FONT_STACK = 'ui-monospace, Menlo, Consolas, "NerdIcons", monospace';

  // The face is measured rather than assumed: a monospace glyph is about 0.6
  // of its point size wide, but "about" is not good enough when the answer
  // decides whether the last column is on screen. So one is drawn and read.
  //
  // This is the cold start and nothing more. It is read at 100px because there
  // is no terminal yet to read, and a hinted face at 100px is not the same
  // shape as the same face at 8px, so the number below gets replaced by a
  // measurement of the real cell as soon as there is one.
  var probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;font-size:100px;white-space:pre;font-family:' + FONT_STACK;
  probe.textContent = '0'.repeat(10);
  document.body.appendChild(probe);
  var ratio = (probe.getBoundingClientRect().width / 10) / 100;
  document.body.removeChild(probe);
  if (!(ratio > 0.3 && ratio < 1)) ratio = 0.6; // a face that measured absurdly

  var wanted = ${columns};
  /*
   * The finest step in the font size that can change anything.
   *
   * xterm sizes a cell by writing 32 glyphs into a span and reading its
   * offsetWidth, which is a whole number, so the cell it reports can only move
   * in thirty-seconds of a pixel; at a ratio near 0.6 that is a twentieth of a
   * point in the font. The step used to be 0.1, which left up to 0.06 of a
   * pixel unused per column, and at eighty columns that is five pixels of the
   * band down the right-hand side.
   */
  var STEPS = 20;
  var sizeFor = function (cols) {
    // Floor rather than round: a font half a pixel too wide loses the last
    // column, which is where a prompt's cursor lives.
    return Math.max(4, Math.floor((window.innerWidth / cols) / ratio * STEPS) / STEPS);
  };

  var term = new window.Terminal({
    fontSize: sizeFor(wanted),
    fontFamily: FONT_STACK,
    theme: ${theme},
    cursorBlink: true,
    // A phone scrolls with a thumb and the desk's own scrollback is right
    // there in tmux, so this is for the last few screens rather than history.
    scrollback: 2000,
    allowProposedApi: true,
    convertEol: false,
    macOptionIsMeta: false
  });

  try {
    var uni = new window.Unicode11Addon();
    term.loadAddon(uni);
    term.unicode.activeVersion = '11';
  } catch (e) {
    // Widths will be wrong for some emoji and CJK. Everything else still runs,
    // which is the right trade against not opening at all.
  }

  term.open(document.getElementById('screen'));

  // Everything typed on the device keyboard, plus everything the key bar sends
  // through AGX.send — one path out, so there is one place that can be wrong.
  term.onData(function (data) { post({ t: 'in', d: data }); });

  /*
   * One cell, in CSS pixels, as xterm actually laid it out.
   *
   * Both numbers used to be guesses and both guesses were wrong. The width came
   * from the probe, and the grid it produced covered about 85% of the viewport:
   * a dead band down the right, with the tmux status line inside the pane
   * stopping at the same place. The height came from the font size times 1.2.
   *
   * Reaching into _core is what the official fit addon does, so it is as
   * supported as this gets. The row element is the fallback because the DOM
   * renderer writes the canvas width and the cell height onto every row, and a
   * private field renamed by a version bump would otherwise leave this page
   * unable to size itself at all.
   */
  var cellOf = function () {
    var render = term._core && term._core._renderService;
    var dims = render && render.dimensions;
    var cell = dims && dims.css && dims.css.cell;
    if (cell && cell.width > 0 && cell.height > 0) return cell;
    var row = term.element && term.element.querySelector('.xterm-rows > div');
    var box = row && row.getBoundingClientRect();
    if (box && box.width > 0 && box.height > 0 && term.cols > 0) {
      return { width: box.width / term.cols, height: box.height };
    }
    return null;
  };

  /**
   * Set the font, and answer how wide the grid came out at it.
   *
   * Assigning the option is what makes the reading valid: xterm re-measures its
   * glyph and recomputes its dimensions before the assignment returns, so the
   * cell read here is this size's cell and not the last one's.
   */
  var apply = function (size) {
    size = Math.max(4, Math.round(size * STEPS) / STEPS);
    if (term.options.fontSize !== size) term.options.fontSize = size;
    var cell = cellOf();
    if (cell) {
      // The same sanity band the probe gets. A cell outside it is a WebView
      // refusing the size it was given — Android keeps a minimum font size of
      // its own — and believing it would walk the font into a clamp instead of
      // settling on an answer.
      var measured = cell.width / size;
      if (measured > 0.3 && measured < 1) ratio = measured;
    }
    return { size: size, grid: cell ? cell.width * wanted : 0 };
  };

  /*
   * The largest font at which the asked-for columns reach the right edge
   * without going past it.
   *
   * A search rather than a formula, because the cell is a step function of the
   * font size and not a line through the origin: xterm measures 32 glyphs with
   * offsetWidth and then rounds the whole canvas to a pixel, so two sizes a
   * twentieth of a point apart can produce the same cell. Solving for the size
   * and trusting the answer oscillates — on a 412px viewport at 80 columns the
   * same iteration produced a 410px grid one pass and a 413px one the next, and
   * kept whichever pass happened to run last.
   *
   * So it aims twice, the second aim using a ratio measured near the answer
   * rather than the probe's at 100px, and then tries the five sizes around that
   * and keeps the widest grid that still fits. Eight span measurements at the
   * very worst, and xterm coalesces the repaint they ask for into one frame.
   *
   * The leftover goes into the font rather than anywhere else, and the other
   * two places were weighed. Rounding the size up fills the width by pushing
   * the last column off the right edge, and that is the column the cursor sits
   * in. Handing the leftover to an extra column only pays when the leftover is
   * a whole cell, and once the font is measured it is a pixel or two; it would
   * also have the phone quietly reflowing the desk's tmux window, since with
   * fit on the server resizes the real window to the geometry this page
   * reports. Scaling the rendered surface is the one that looks right in a
   * screenshot and wrong in the hand: this WebView draws on a hardware layer,
   * so the layer is rasterised at its own size and then stretched, and every
   * glyph in an eight-pixel grid comes back resampled.
   */
  var fitFont = function () {
    apply(sizeFor(wanted));
    var aim = apply(sizeFor(wanted)).size;
    var best = 0, widest = 0;
    for (var i = -2; i <= 2; i++) {
      var tried = apply(aim + i / STEPS);
      // Ties go to the later, larger size: two sizes a step apart often land on
      // the same cell, and at the same grid width the bigger glyph is the one
      // worth having.
      if (tried.grid >= widest && tried.grid > 0 && tried.grid <= window.innerWidth) {
        widest = tried.grid;
        best = tried.size;
      }
    }
    // Nothing fitted: the font is against its floor with more columns than the
    // screen holds at that size, so the right-hand ones hang off the edge. That
    // is the trade the column control makes, and a 3px font is not the way out.
    return apply(best || aim).size;
  };

  var lastCols = 0, lastRows = 0;
  var report = function () {
    /*
     * Not fit(). Fitting asks "how many columns fit at this font size", and
     * the answer on a phone is 45 — which is the bug this screen had. The
     * question here is the other way round: the column count is chosen, and
     * the font follows from it.
     *
     * Rows still come from the height, because vertical space is not a choice
     * anybody makes — you get what the screen has.
     */
    // The column count goes in before the font is measured. xterm rounds the
    // whole canvas to a pixel and divides that by the columns it is holding, so
    // a cell read against the previous count carries the previous count's
    // rounding: 0.7px of it, which was enough to let a 413px grid pass as
    // fitting a 412px screen the moment the width control moved 60 to 80.
    if (term.cols !== wanted) {
      try { term.resize(wanted, term.rows); } catch (e) { /* mid-teardown */ }
    }
    var size = fitFont();
    var cell = cellOf();
    /*
     * Rows off the cell xterm reports, never off the font size times 1.2. That
     * 1.2 was a guess at the line height and it is nobody's in particular: the
     * real one is the face's own line box, ceiled to a device pixel and
     * multiplied by xterm's lineHeight. Guessing under it asks for more rows
     * than the screen has — 68 where 52 fit, measured — and the bottom ones are
     * drawn past the edge. On a shell that is the line you are typing on.
     *
     * The 1.2 survives only as a cold start, for a run with no cell to read.
     */
    var line = cell ? cell.height : size * 1.2;
    var rows = Math.max(4, Math.floor(window.innerHeight / line));
    if (term.cols !== wanted || term.rows !== rows) {
      try { term.resize(wanted, rows); } catch (e) { /* mid-teardown */ }
    }
    if (term.cols === lastCols && term.rows === lastRows) return;
    lastCols = term.cols;
    lastRows = term.rows;
    post({ t: 'size', cols: term.cols, rows: term.rows });
  };

  // Decode without TextDecoder: it is absent on some older WebViews and this
  // is the one path that must never fail.
  var bytes = function (b64) {
    var binary = atob(b64);
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  };

  /*
   * The line being typed on the pane, so the phone's field can BE it.
   *
   * The cursor's row is the line being typed — that is true of a shell, of an
   * agent's prompt, of anything that takes a line — so no program has to be
   * recognised. What DOES have to be recognised is where the prompt stops and
   * the typing starts, and there is no general answer to that: the marker is
   * chosen by whatever drew it. So a marker is looked for, and when none is
   * found this says NOTHING rather than guessing. Putting a line of somebody's
   * build output into a field they are about to press Enter on is worse than
   * leaving the field empty.
   *
   * Leading box-drawing is skipped first: an agent draws its prompt inside a
   * border, so the row starts with the border and not with the marker.
   */
  var PROMPT = /^[\\s\\u2502\\u2503\\u250a\\u2506|]*[>$#%\\u276f\\u276d\\u203a\\u27e9\\u3009\\u25b6]\\s?/;
  var lastLine;
  var lineNow = function () {
    var buffer = term.buffer.active;
    var end = buffer.baseY + buffer.cursorY;
    if (!buffer.getLine(end)) return null;
    /*
     * Back up over any rows this one is a continuation of.
     *
     * A line longer than the terminal is wide is several rows in the buffer,
     * and xterm marks the continuations — so a long command typed at a shell
     * reads back whole rather than from its last wrap onwards.
     *
     * It does NOT cover a prompt drawn inside a box, which is what an agent
     * does: there the program moves the cursor to each row itself, so nothing
     * is marked as wrapped and only the cursor's row comes back. That is the
     * honest limit of reading a screen rather than a program's state.
     */
    var start = end;
    while (start > 0) {
      var above = buffer.getLine(start);
      if (!above || !above.isWrapped) break;
      start--;
    }
    var raw = '';
    for (var y = start; y <= end; y++) {
      var row = buffer.getLine(y);
      // Not trimmed, on any row. The cursor is an index into the FULL grid, so
      // trimming a row before it is counted moves everything after it.
      if (row) raw += row.translateToString(false);
    }
    /*
     * Everything after the cursor is somebody else's, and on a split window it
     * literally is.
     *
     * A tmux pane is not a terminal — it is a rectangle inside one. Two panes
     * side by side share every buffer row, so the row under the cursor reads
     * "what I am typing │ what the pane next door is showing". Seen on a real
     * phone against a four-pane window: the field came back holding the divider
     * and the NEIGHBOUR'S prompt marker. Harmless to look at and not harmless
     * to edit — the difference this field sends is computed against what it
     * believes the line is, so a backspace would have been aimed at a character
     * belonging to another pane.
     *
     * The cursor is the boundary and it is exact: it sits at the end of what is
     * being typed, in the pane that is being typed in.
     */
    var rowStart = (end - start) * term.cols;
    var at = rowStart + buffer.cursorX;
    raw = raw.slice(0, at);
    /*
     * And then only what is on THIS side of the pane border.
     *
     * The cursor bounds the read on the right; nothing bounded it on the left,
     * and on a split the row starts in somebody else's pane. Measured on a real
     * two-pane window: tmux draws the divider as U+2502 (38 of them in one
     * repaint, no ACS charset switch), so the row under a cursor in the RIGHT
     * pane reads "their output │ what I am typing". The marker search below
     * takes the last marker before the cursor, which was meant to solve this and
     * does not: when the typed line has wrapped inside its own pane the cursor
     * row holds no marker of ours at all, and the last one before it is the
     * NEIGHBOUR'S prompt — so the field came back holding their prompt and every
     * character between it and here.
     *
     * Only the cursor's own row is trimmed, never the rows it wrapped from. A
     * line is only marked wrapped when tmux let the characters run past the
     * right edge, which it only does for a pane that spans the whole window —
     * and such a pane has no divider on its rows to cut at.
     *
     * The box-drawing verticals only, never the ASCII pipe: a shell line being
     * typed is full of pipes, and cutting at the last one would hand back the
     * tail of somebody's pipeline as the whole of it.
     */
    var border = -1;
    for (var b = at - 1; b >= rowStart; b--) {
      var code = raw.charCodeAt(b);
      if (code === 0x2502 || code === 0x2503 || code === 0x250a || code === 0x2506 || code === 0x2551) {
        border = b;
        break;
      }
    }
    if (border >= 0) raw = raw.slice(border + 1);
    /*
     * And the prompt is at the START of what survives that cut, or there is no
     * prompt here.
     *
     * This used to search BACKWARDS and keep the LAST marker on the row. The
     * marker class is [>$#%...] and every one of those is ordinary shell syntax,
     * so the marker it kept was usually one the USER HAD JUST TYPED. Measured in
     * a real browser against this document:
     *
     *   echo $HOME             the field believed the line was "HOME"
     *   cat a > b              "b"
     *   git log --format=%h    "h"
     *   git commit -m fix#12   "12"
     *   make 2>&1              "&1"
     *
     * Which is data loss and not a wrong-looking field, because the field sends
     * the DIFFERENCE between what it believes and what it now holds. The pane
     * holds "make build > log.txt", the field believes "log.txt", so clearing
     * the field sends seven DELs and the pane is left holding "make build > ".
     * Type ls, press Enter, and that TRUNCATES A FILE CALLED ls while the field
     * still reads "ls". Nobody sees it: the keyboard is over the pane, which is
     * the whole reason this composer exists.
     *
     * The backwards search was there for exactly one thing — the neighbour's
     * prompt on a split — and the border cut two blocks above already removes
     * the neighbour, at the divider, rather than by guessing which marker was
     * theirs. So index 0 is the only marker this is allowed to believe.
     *
     * What it costs, written down rather than found later: a prompt with
     * anything in front of the marker — bash's own "user@host:~/code$ " — no
     * longer reads, and this answers null. That is the failure worth having:
     * the screen treats null as "leave the field alone", so the composer still
     * types and still sends, it only stops mirroring. The other failure typed
     * DELs into somebody's real command.
     */
    var match = PROMPT.exec(raw);
    if (!match) return null;
    /*
     * Trailing blanks off, and xterm's own trim is not enough.
     *
     * It drops cells that were never written. A cell holding a SPACE was
     * written, so it stays — and an erase arriving from the computer is often
     * exactly that: backspace, space, backspace, which paints a space over the
     * character. Measured in a real engine: erasing three characters that way
     * left the line reading "…bien y   ", and the field would have carried
     * those spaces, sent them on the next edit, and drifted a character at a
     * time from what the shell actually holds.
     *
     * A space somebody genuinely typed at the end is lost from the field by
     * this, and that is the cheaper mistake: the pane keeps its own space, so
     * the next character still lands after it. The screen cannot tell the two
     * apart — both are a space in a cell — so one of them has to be chosen.
     */
    // Doubled, like PROMPT above: this whole file is a template literal, and a
    // lone \s in one is not an escape — it collapses to a plain "s", so this
    // read /s+$/ and trimmed the letter s off the end of people's commands.
    return raw.slice(match[0].length).replace(/\\s+$/, '');
  };
  var reportLine = function () {
    try {
      var text = lineNow();
      if (text === lastLine) return;
      lastLine = text;
      post({ t: 'line', text: text });
    } catch (e) {
      // The buffer is mid-resize. The next render says the same thing.
    }
  };
  /*
   * Once the paint has settled, not once per write.
   *
   * An agent redraws its whole prompt box on every keystroke, so onRender fires
   * in bursts; posting from inside one sends the half-drawn state, and posting
   * on every one of them puts a message on the bridge for each frame of an
   * animation nobody is reading. 90ms is under the time it takes to reach for
   * the next key and long enough that a burst collapses into one.
   */
  var lineTimer = null;
  var lineSoon = function () {
    if (lineTimer) clearTimeout(lineTimer);
    lineTimer = setTimeout(function () { lineTimer = null; reportLine(); }, 90);
  };
  /*
   * Hung off the BYTES ARRIVING, not off the painting.
   *
   * This was term.onRender, and on the phone the field only caught up when
   * the terminal was tapped: an Android WebView defers its frames while nobody
   * is touching it, so a render-driven report is a report that waits for a
   * finger. Typing at the computer is not an event on this device, and hanging
   * the answer off the one thing that happens locally was the mistake.
   *
   * write() takes a completion callback and fires it when the parser has
   * consumed the data — after the buffer is updated and regardless of whether
   * anything has been drawn. That is the real event: the line can only change
   * because bytes arrived, or because we sent some.
   */
  term.onCursorMove(lineSoon);
  // And a slow backstop, for the one case neither of those covers: a pane that
  // changed while this page was asleep. Reading a buffer row costs nothing and
  // posting only happens when the text is actually different.
  setInterval(reportLine, 1000);

  /*
   * A finger, turned into wheels, at the rate the PANE answers — but only when
   * a wheel is something the other end is listening for. See routeOf below for
   * the case that is not, which is the one that shipped broken.
   *
   * Reported: the terminal does not scroll with a thumb. It could not. The pane
   * is attached to tmux, which is a full-screen program — measured on the real
   * one, alternate_on=1 and history_size=0 — so xterm has no scrollback of its
   * own to drag, and there is nothing under the finger to move. The thing that
   * scrolls a screen like that is the PROGRAM, and the only way to ask it is
   * the same way a mouse does: a wheel event.
   *
   * So the drag is converted, and the encoding is deliberately left to xterm.
   * It already knows which mouse protocol the program turned on (tmux with
   * mouse on negotiates SGR), and hand-writing the escape sequence here would
   * be a second, worse copy of that knowledge that goes wrong the moment
   * something asks for a different mode.
   *
   * ── why the rate is measured and not a constant ───────────────────────────
   * This shipped at one notch per three rows, because three rows is what a
   * desktop wheel sends, and the complaint came back the same day: "el scroll
   * con el dedo es pesimo, apenas se mueve unos pixeles". Three rows is true
   * about a desktop and irrelevant here, because HOW FAR A NOTCH GOES IS NOT
   * OURS TO DECIDE. A notch is a request; the program on the other end picks
   * the distance. Measured on this machine, on the same pane, minutes apart:
   *
   *   tmux's own copy mode        5 lines a notch   (3.6a, WheelUpPane)
   *   a program with mouse on     1 line  a notch   (less --mouse — and this is
   *                                                  the case an agent's TUI is)
   *
   * Five to one, so no constant serves both. At three rows a notch, an 800px
   * drag — thirty rows of finger on this phone — moved forty lines in copy mode
   * and EIGHT in less. Both numbers come from reading the pane afterwards,
   * which is the only measurement worth anything here: the tests that let this
   * ship asserted the notches that went out and never that a screen moved.
   *
   * The ratio was not the whole of it either, and no amount of reasoning would
   * have found the other half — see the dispatch below, where four wheels out
   * of five were being swallowed inside xterm before anything left the page.
   * Both halves multiply, and eight lines for a thirty-row drag is what they
   * came to.
   *
   * So the page asks the pane. The first notch of a gesture is a probe: the
   * rows on screen are photographed, one notch goes out alone, and when the
   * repaint lands they are matched against the photograph to see HOW FAR THE
   * SCREEN ACTUALLY MOVED. That is the notch's worth in lines, and the rest of
   * the drag goes out at one notch per that many rows — so the content travels
   * with the finger whatever is in the pane, and keeps doing so when the pane
   * changes to something with different ideas.
   *
   * preventDefault, so the WebView does not also try to move the page under a
   * terminal that fills it — hence passive:false on this one listener and
   * passive:true on the others, which never call it.
   */
  var surface = document.getElementById('screen');

  /*
   * ── where a scroll gesture is allowed to go ───────────────────────────────
   *
   * Three answers, and the third is the one this screen did not have.
   *
   *   'local'  the normal buffer, where xterm holds its own scrollback. A
   *            wheel scrolls the viewport and nothing leaves the page.
   *   'wheel'  a mouse protocol is live, so a wheel becomes a mouse report and
   *            the far end decides what it means. tmux with 'mouse on' takes it
   *            from here — it forwards to a program that asked for the mouse,
   *            and otherwise enters its own copy mode.
   *   'tmux'   neither. NOTHING may be dispatched, and the app is asked to move
   *            the scrollback instead.
   *
   * The third exists because of what xterm does when it is left to answer a
   * wheel on the alternate screen with no scrollback of its own: it sends a
   * CURSOR KEY, one per wheel. Measured through this exact document, in a real
   * engine, against a real pane running 'cat -v' — one 760px drag delivered 53
   * of them, a mix of ESC[B and ESC O B in the same gesture (so it is not even
   * reading DECCKM consistently), pane_in_mode stayed 0 and the screen moved one
   * line. At a shell those arrows walk history onto somebody's prompt; in an
   * agent's TUI they move the selection, and one of the things they move is an
   * Allow/Deny gate. This app exists to answer those from a phone.
   *
   * The two facts are read from xterm's public API and both were measured
   * against a real tmux before anything was written against them: with
   * 'mouse on' the page reads mouseTrackingMode "drag" and the drag delivered
   * SGR reports and ZERO keystrokes; with 'mouse off' it reads "none" and the
   * same drag delivered the 53 arrows. 'buffer.active.type' is 'alternate' in
   * both, which is why the buffer alone cannot decide this.
   */
  var routeOf = function () {
    try {
      if (term.buffer.active.type === 'normal') return 'local';
      return term.modes.mouseTrackingMode !== 'none' ? 'wheel' : 'tmux';
    } catch (e) {
      // Mid-teardown, or an engine that renamed one of those. The safe answer
      // is the one that cannot type into somebody's shell.
      return 'tmux';
    }
  };

  /*
   * And the same rule again, inside xterm, where it cannot be got round.
   *
   * The block above decides what this page DISPATCHES. This decides what xterm
   * will act on at all, and it is not the same question: a wheel can also
   * arrive from the platform — a mouse or a trackpad on a tablet, an
   * accessibility gesture, a stylus — and none of those come through the touch
   * handlers below. Returning false is checked by xterm before either of its
   * two wheel paths, the mouse-report one and the cursor-key one, so a wheel
   * this page did not want can no longer become input.
   */
  term.attachCustomWheelEventHandler(function () { return routeOf() !== 'tmux'; });

  /*
   * What one notch is worth, in lines of the pane, as last measured.
   *
   * Seeded at one, and the two errors are not equal: too small is the complaint
   * being fixed, while too large lasts exactly one notch — this gesture's own
   * probe corrects it before the second one goes out.
   */
  var linesPerNotch = 1;
  var MIN_RATE = 0.5, MAX_RATE = 16;
  var HOLD = 220;   // ms: the longest a drag waits on the answer to its probe
  var QUIET = 45;   // ms without bytes that means the repaint has landed
  var MATCH = 6;    // rows that must line up before a shift is believed

  /** The rows on screen, as text. This is the sensor: what the pane SHOWS. */
  var screenRows = function () {
    var buffer = term.buffer.active, out = [];
    for (var i = 0; i < term.rows; i++) {
      var line = buffer.getLine(buffer.viewportY + i);
      out.push(line ? line.translateToString(true) : '');
    }
    return out;
  };

  /*
   * How far the screen moved between two photographs of it, in rows.
   *
   * The shift that lines the most rows up wins, and "did not move" is one of
   * the candidates rather than the leftover: a pane whose rows repeat — an
   * agent's box has twenty identical border rows — scores well at every shift,
   * and without k=0 in the running one of them would win a race nothing moved
   * in. It also has to win outright, so a screen that fits two shifts equally
   * measures nothing and the last known rate stands.
   *
   * Empty rows are not evidence and are not counted.
   */
  var shiftOf = function (before, after) {
    var n = Math.min(before.length, after.length);
    var limit = Math.max(1, n - 1);
    var best = 0, top = -1, second = -1;
    for (var k = -limit; k <= limit; k++) {
      var score = 0;
      for (var i = 0; i < n; i++) {
        var j = i + k;
        if (j < 0 || j >= n) continue;
        if (before[i] && before[i] === after[j]) score++;
      }
      if (score > top) { second = top; top = score; best = k; }
      else if (score > second) { second = score; }
    }
    return (best !== 0 && top >= MATCH && top > second) ? best : 0;
  };

  var lastY = null, carry = 0, vel = 0, lastT = 0, burstY = 0, burstT = 0;
  var probe = null;      // a notch out on its own, waiting to be measured
  var calibrate = false; // this gesture has not probed yet
  var probes = 0;
  var MAX_PROBES = 3;
  var fling = null;

  var closeProbe = function () {
    if (!probe) return;
    var sent = probe;
    probe = null;
    clearTimeout(sent.hold);
    clearTimeout(sent.quiet);
    var moved = shiftOf(sent.snap, screenRows());
    /*
     * Only movement the notch asked for counts. A wheel up moves the content
     * DOWN the screen; output arriving from the pane moves it up, and crediting
     * a notch with somebody's newline would set the rate off a line nobody
     * scrolled. A pane already at the end of its history answers zero, which is
     * not a rate either — the previous one stands.
     */
    if (moved && (moved > 0) === !sent.down) {
      linesPerNotch = Math.min(MAX_RATE, Math.max(MIN_RATE, Math.abs(moved)));
    } else if (probes < MAX_PROBES) {
      /*
       * Nothing moved, so ask again with the next notch. The first wheel into a
       * plain tmux pane is spent ENTERING copy mode and scrolls zero lines —
       * measured, scroll_position stayed 0 and went to 5 on the second — so a
       * page that gave up after one probe would run that whole first drag at
       * the seeded rate and overshoot it five times over.
       *
       * Capped, because the other reason for a still screen is a pane that has
       * nothing left to give: at the end of its history every notch would be a
       * probe, and each probe costs the drag a wait.
       */
      calibrate = true;
    }
    drain();
  };
  /** Bytes arrived: the answer to a probe is in them, once they stop. */
  var probeSaw = function () {
    if (!probe) return;
    clearTimeout(probe.quiet);
    probe.quiet = setTimeout(closeProbe, QUIET);
  };

  /*
   * ── the tmux route ────────────────────────────────────────────────────────
   *
   * One request in flight at a time, closed when the pane has answered.
   *
   * Not a timer, and not a request per touchmove. A finger produces about sixty
   * moves a second and each request is a 'tmux' call plus a repaint of the whole
   * pane coming back down the socket, so a fixed rate is either slower than the
   * link (a scroll that keeps going after the finger stops) or faster than it (a
   * queue nobody can cancel). Waiting for the pane's own bytes to stop makes the
   * gesture run at exactly the speed the machine can serve it, which is the same
   * shape — and the same two constants — the wheel probe above already uses.
   *
   * The finger's pixels are kept in 'carry' and only whole lines are spent, so
   * nothing is lost to rounding across a drag: the remainder is still there for
   * the next one.
   */
  var asked = null;
  var closeAsk = function () {
    if (!asked) return;
    clearTimeout(asked.hold);
    clearTimeout(asked.quiet);
    asked = null;
    drain();
  };
  /** Bytes arrived: the pane has begun answering the last request. */
  var askSaw = function () {
    if (!asked) return;
    clearTimeout(asked.quiet);
    asked.quiet = setTimeout(closeAsk, QUIET);
  };

  var drain = function () {
    var cell = cellOf();
    var row = cell && cell.height ? cell.height : 15;
    var route = routeOf();
    if (route === 'tmux') {
      // A request is out; the carry keeps until it has been answered.
      if (asked) return;
      // Toward the bottom of the screen with the finger is back into history,
      // which is negative — see the contract on 'cmd:"scroll"'. Truncated
      // towards zero either way, so a half-line never rounds into a whole one.
      var lines = carry > 0 ? Math.floor(carry / row) : Math.ceil(carry / row);
      if (!lines) return;
      carry -= lines * row;
      post({ t: 'scroll', lines: lines });
      asked = { quiet: null, hold: setTimeout(closeAsk, HOLD) };
      return;
    }
    // Pixels of finger to a notch: the height of the content that notch is
    // expected to move.
    var step = row * linesPerNotch;
    var target = term.element || surface;
    while (Math.abs(carry) >= step) {
      if (probe) return; // a probe is out; the carry keeps for its answer
      var down = carry > 0;
      carry += down ? -step : step;
      if (calibrate) {
        calibrate = false;
        probes++;
        probe = { snap: screenRows(), down: down, quiet: null, hold: null };
        probe.hold = setTimeout(closeProbe, HOLD);
      }
      /*
       * In LINES, not pixels, and this is half of why the screen barely moved.
       *
       * Measured through the phone's own WebView, with a counter on the wheel
       * events going in and another on the mouse reports coming out: a drag of
       * 303 CSS px produced 40 wheels and TWELVE reports. xterm damps a small
       * pixel delta before it decides whether anything happened —
       * consumeWheelEvent: a DOM_DELTA_PIXEL event under 50px is multiplied by
       * 0.3, and the fraction is carried until it crosses a whole row. One row
       * of ours is 10.29px, so five sixths of every notch was thrown away and
       * the pane got one report per three and a third. The old three-row notch
       * was 30.9px and still under 50, so it was damped too — 8 lines out of a
       * thirty-row drag, which is exactly the number that came back off the
       * pane. A desktop wheel sends 100 or 120 and is never damped, which is
       * why this only bites a finger.
       *
       * DOM_DELTA_LINE takes that whole branch out: xterm reads the delta as
       * rows, one notch is one report, and the number stops depending on
       * anything's idea of a pixel.
       */
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: down ? linesPerNotch : -linesPerNotch, deltaMode: 1, bubbles: true, cancelable: true
      }));
      if (probe) return;
    }
  };

  /*
   * A flick keeps going after the finger leaves, and stops there.
   *
   * Worth having because the alternative is a swipe per screen through an
   * afternoon of somebody's output. Deliberately small: velocity decays by a
   * twelfth every frame — about 190ms to fall to a third — and the whole coast
   * is capped at two screens, because this is not a local list. Every row of it
   * is a wheel on the wire and a repaint back, and a fling that outruns the
   * link is a scroll nobody can stop.
   *
   * What was NOT built, and why: no rubber band at the ends, because the page
   * cannot know where the ends are — only the program does, and it answers by
   * not moving; and no catch-up when the pane is slower than the coast, which
   * would mean holding a finger's gesture hostage to a round trip.
   */
  var FLICK = 0.6;  // CSS px per ms: a deliberate drag lands well under this
  var DECAY = 0.92;
  var stopFling = function () { if (fling) { clearTimeout(fling); fling = null; } };
  var coast = function (v) {
    var left = window.innerHeight * 2;
    var step = function () {
      carry += v * 16;
      left -= Math.abs(v * 16);
      v *= DECAY;
      drain();
      fling = (Math.abs(v) > 0.08 && left > 0) ? setTimeout(step, 16) : null;
    };
    fling = setTimeout(step, 16);
  };

  /*
   * When the finger was there, not when this ran.
   *
   * A WebView delivers touches late and in bursts while it is busy painting a
   * terminal, and clock time between two handlers is then the SCHEDULER's
   * interval rather than the finger's — which turns a flick into a slow drag
   * whenever the page is under load, exactly when somebody is scrolling. The
   * event carries the moment it was sampled; that is the one to subtract.
   * Date.now stays as the fallback for anything that reports no timestamp.
   */
  var clockOf = function (e) { return e.timeStamp > 0 ? e.timeStamp : Date.now(); };

  surface.addEventListener('touchstart', function (e) {
    // Touching a moving screen stops it, the way it does everywhere else.
    stopFling();
    // One finger only. Two is a pinch, and stealing it would take the zoom
    // away from somebody trying to read four-pixel text.
    if (e.touches.length !== 1) { lastY = null; return; }
    lastY = e.touches[0].clientY;
    lastT = clockOf(e);
    carry = 0;
    vel = 0;
    burstY = 0;
    burstT = 0;
    // One probe per gesture. The pane can be running something else than it was
    // a second ago — an agent exits and leaves a shell — and asking again costs
    // one notch of the drag that is starting anyway.
    calibrate = true;
    probes = 0;
  }, { passive: true });
  surface.addEventListener('touchmove', function (e) {
    if (lastY === null || e.touches.length !== 1) return;
    var y = e.touches[0].clientY;
    var now = clockOf(e);
    // Finger up means the content goes up, which is a wheel DOWN — the same
    // direction a touchpad uses, and the opposite of what the arithmetic
    // suggests, which is why it is written out.
    var dy = lastY - y;
    var dt = now - lastT;
    lastY = y;
    lastT = now;
    carry += dy;
    /*
     * Velocity off the accumulated move, not off one event over the gap.
     *
     * Android hands touchmoves over in bursts: measured in the emulator's own
     * WebView, four events carrying the SAME timestamp and then a 16ms step —
     * 0 0 0 16 0 0 0 17, and Date.now says exactly the same thing. Dividing one
     * event's pixels by the whole burst's milliseconds counts a quarter of the
     * distance, which is a flick reading as a drag. So the moves are added up
     * until the clock has actually advanced, and then divided.
     *
     * Averaged after that, so one stuttering frame does not decide whether this
     * was a flick; a gap long enough to be a pause starts the average again.
     */
    burstY += dy;
    burstT += dt;
    if (burstT >= 8) {
      var rate = burstY / burstT;
      vel = burstT > 120 ? rate : vel * 0.6 + rate * 0.4;
      burstY = 0;
      burstT = 0;
    }
    drain();
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  surface.addEventListener('touchend', function () {
    lastY = null;
    if (Math.abs(vel) > FLICK) coast(vel);
    vel = 0;
  }, { passive: true });
  // Cancelled is the gesture being taken away, not released: no coast.
  surface.addEventListener('touchcancel', function () { lastY = null; vel = 0; }, { passive: true });

  /*
   * ── the colours the pane is actually painted with ─────────────────────────
   *
   * Two sets are carried: OWN is the phone's mode, ALT is the same accent on the
   * other kind of surface. Which one is worn is not a preference, it is a
   * measurement — see counterTheme in this file for the bytes.
   *
   * A tmux with agentglass's theme conf in it paints EVERY CELL with an explicit
   * background, so the phone's own never shows through the grid: measured
   * against a real tmux and a real client, ESC[48;2;30;30;30m, and the same for
   * xterm-256color, tmux-256color and xterm-direct. Wearing a light foreground
   * on that is what made a phone in Light lose the words at the top of a
   * session, and wearing the dark set unconditionally is what made Light a lie.
   *
   * So the buffer is asked what it is painted on, and the set that reads on THAT
   * is the set that goes on. Nothing here is a guess about the machine: when the
   * pane paints nothing, the phone's mode is what is left and Light is finally
   * light.
   */
  var OWN = ${theme}, ALT = ${counter}, worn = null;
  // WCAG relative luminance, and 0.4 is the same cut deriveAnsi uses to decide
  // light from dark. Written out because this page is a string with no imports
  // — and it has to be the same number, or the page picks the set the colours
  // were not derived for.
  var LIGHT = 0.4;
  var lumOf = function (hex) {
    var n = parseInt(hex.slice(1), 16);
    var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  };
  var hexOf = function (rgb) {
    var s = (rgb & 0xffffff).toString(16);
    return '#' + '000000'.slice(s.length) + s;
  };

  /*
   * The background most of the screen carries, or null when the pane leaves it
   * to us.
   *
   * A vote rather than one cell, because a status line, a selection and a
   * highlighted row are all backgrounds that are not THE background; two thirds
   * of the sample has to agree before anything is believed. Sampled every other
   * row and every eighth column — 170-odd cells on a phone screen, once a
   * second, against a repaint that is thousands.
   *
   * A BLANK CELL AT THE DEFAULT BACKGROUND ABSTAINS, and that is not tidiness.
   * The phone's grid is taller than the window it is looking at whenever the
   * desk's terminal is shorter — a 24-row window inside a 64-row grid leaves
   * forty rows of nothing below the pane — and counting that nothing as "the
   * pane leaves its background to us" is how a pane that IS painted loses the
   * vote 37% to 63% and keeps the wrong set. An empty cell is the absence of a
   * pane, not evidence about one.
   *
   * Only default and true colour are counted. An indexed background from 0 to 15
   * is one of OUR sixteen, so measuring it would be measuring ourselves, and 16
   * to 255 is a program painting a block of its own rather than the surface
   * underneath — neither is the question being asked.
   */
  var paneBg = function () {
    var buffer = term.buffer.active, votes = {}, seen = 0;
    for (var y = 0; y < term.rows; y += 2) {
      var line = buffer.getLine(buffer.viewportY + y);
      if (!line) continue;
      for (var x = 0; x < term.cols; x += 8) {
        var cell = line.getCell(x);
        if (!cell) continue;
        var key;
        if (!cell.isBgDefault()) key = cell.isBgRGB() ? hexOf(cell.getBgColor()) : null;
        else if (cell.getCode() > 32) key = 'none';
        else continue;
        seen++;
        if (key === null) continue;
        votes[key] = (votes[key] || 0) + 1;
      }
    }
    var best = null, top = 0;
    for (var k in votes) if (votes[k] > top) { top = votes[k]; best = k; }
    if (!seen || top * 3 < seen * 2) return undefined; // no clear answer: keep what is on
    return best === 'none' ? null : best;
  };

  /** Put on the set that reads on what the pane is painting, and only when it
   *  is not already on — assigning a theme repaints the whole screen. */
  var dress = function () {
    var bg = paneBg();
    if (bg === undefined) return;
    var next = {};
    var want = bg === null || (lumOf(bg) > LIGHT) === (lumOf(OWN.background) > LIGHT) ? OWN : ALT;
    for (var key in want) next[key] = want[key];
    if (bg !== null) {
      // The pane's own colour, not the set's approximation of it: the frame
      // around the grid and any cell the program does leave at the default have
      // to match the cells beside them.
      next.background = bg;
      next.cursorAccent = bg;
    }
    var json = JSON.stringify(next);
    if (json === worn) return;
    worn = json;
    term.options.theme = next;
    document.documentElement.style.background = next.background;
    document.body.style.background = next.background;
  };
  var dressTimer = null;
  var dressSoon = function () {
    if (dressTimer) clearTimeout(dressTimer);
    // Longer than the line's 90ms: a program clearing its screen paints default
    // cells for a frame on its way to painting its own, and switching sets on
    // that intermediate frame is a flash of the wrong palette.
    dressTimer = setTimeout(function () { dressTimer = null; dress(); }, 400);
  };
  setInterval(dress, 1000);

  // Four things wait on bytes: the typed line, a scroll probe wanting to know
  // what its notch did, a scroll request wanting to know the pane has answered,
  // and the palette wanting to know what it is painted on. All four are
  // answered when the parser has taken the data in, so all four hang off the
  // one callback.
  var arrived = function () { lineSoon(); probeSaw(); askSaw(); dressSoon(); };

  window.AGX = {
    // The callback is why the field keeps up. See lineSoon(): it fires once the
    // parser has taken the data in, which is the moment the typed line can have
    // changed — no paint required, and no finger.
    write: function (b64) { term.write(bytes(b64), arrived); },
    /** The key bar. Goes through onData so the app cannot end up with two
     *  different ideas of what was sent. */
    send: function (text) { post({ t: 'in', d: text }); },
    clear: function () { term.clear(); },
    focus: function () { term.focus(); },
    blur: function () { term.blur(); },
    idle: function (on) { term.element && term.element.classList.toggle('agx-idle', !!on); },
    /** Ask for a different number of columns. The font follows. */
    columns: function (n) { wanted = Math.max(20, Math.min(400, n | 0)); report(); },
    /*
     * New colours, on the terminal that is already attached.
     *
     * The document is built once with the palette in it, so the obvious way to
     * change theme is to build another one — and that reloads the WebView. The
     * socket would survive (it belongs to React Native, see the top of this
     * file) but the SCREEN would not: a tmux pane is only ever painted by tmux
     * redrawing it on attach, so somebody watching a build would see their
     * terminal go blank and come back because they tapped a colour.
     *
     * Assigning term.options.theme is xterm re-colouring the buffer it already
     * has. Nothing is re-parsed, nothing is re-attached, and the bytes on the
     * wire do not know it happened — the same trade AGX.columns makes with the
     * font size.
     *
     * The page background goes with it. It is set in the stylesheet above from
     * the palette the document was built with, and a stylesheet is not something
     * the theme can reach, so without these two lines a dark page keeps a dark
     * frame around a light terminal wherever the grid does not reach the edge.
     *
     * What arrives is the phone's mode, which is one of the two sets this page
     * keeps — so the set it replaces becomes the other one when the mode has
     * flipped, and both stay current without a second message on the bridge.
     * Then the pane is measured again, because whether the new set is the one
     * that goes on is a question about the pane and not about the phone.
     */
    theme: function (next) {
      if (!next || !next.background) return;
      if ((lumOf(next.background) > LIGHT) !== (lumOf(OWN.background) > LIGHT)) ALT = OWN;
      OWN = next;
      worn = null; // the mode moved: re-dress even if the pane has not changed
      term.options.theme = next;
      document.documentElement.style.background = next.background;
      document.body.style.background = next.background;
      dress();
    },
    fit: report
  };

  window.addEventListener('resize', report);
  report();
  post({ t: 'ready', cols: term.cols, rows: term.rows });
})();
</script>
</body>
</html>`;
}
