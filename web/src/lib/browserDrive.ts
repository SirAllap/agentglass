import type { BrowserAskFrame } from "../../../shared/types.ts";
import { COLLECTOR, observeScript } from "./browserObserve.ts";
import { jsLit } from "../../../shared/jsLit.ts";

/**
 * The window's half of "let an agent drive the browser".
 *
 * The server parks the agent's HTTP request and sends the ask down the socket
 * (see server/src/browserdrive.ts); this runs it against the guest and reports
 * back. Kept out of the panel so the interesting part — what each verb actually
 * does to a page — can be tested against a stand-in element instead of a real
 * Chromium.
 *
 * Everything reaches the page through `executeJavaScript`, which is the only
 * door the webview tag offers, and that is exactly why the verbs are a closed
 * set with no `eval` among them: the code below is written here, and a selector
 * arriving from outside is embedded as a literal rather than pasted into a
 * template. A selector is data. It has been a source of injection everywhere it
 * was ever treated as anything else.
 *
 * The literal is built by `jsLit`, which is the repository's one answer to
 * this and not `JSON.stringify` — JSON is not a subset of JavaScript, and the
 * server's gate on a selector refuses a newline while letting U+2028 through.
 * See `shared/jsLit.ts`.
 */

/*
 * ────────────────────────────────────────────────────────────────────────────
 * WHO OWNS THE TAB THIS ASK IS ABOUT
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Reported from the other side first: "another agent was getting into that
 * container and putting its data on that screen... the other agent was going
 * in to take screenshots and could not, because the first one kept
 * overwriting on top of it." A proof-of-life run was being overwritten by an
 * agent that believed it was isolated. It was: isolation here is the TAB an
 * identity holds, and an ask that names no tab is not "unspecified" to the
 * panel — it is "the tab in front", whoever owns it.
 *
 * These are the decisions the panel makes about that, lifted out of the
 * component. Not for tidiness: under `bun test` there is no DOM, effects never
 * run, and the panel's ask handler is unreachable — so a rule that lives
 * inside it is a rule with no lock on it. Out here each one is a function with
 * inputs and an answer, and the suite can break it on purpose.
 */

/** What the panel worked out about one ask before serving it. */
export interface AskOwnership {
  /** The tab the panel resolved this ask to. */
  tab: string;
  /** That tab's container, under the name `tabs` reports — `default` said out
   *  loud, never an empty string, because "not set" and "the shared space
   *  everybody else is also in" are not the same answer. */
  container: string;
  /** Who is asking, or empty when the wire carried no identity. */
  as: string;
  /** The operator typed `--page`, or named this exact tab with `tab <id>`. */
  pageExplicit: boolean;
  /** The verb changes the page, as opposed to only reading it. Stamped beside
   *  `as` by the server (see `isActing` in server/src/browserdrive.ts) rather
   *  than kept here as a second copy of that eighteen-verb list. */
  acts: boolean;
}

/**
 * Why this ask must not be served, or `null` to serve it.
 *
 * UNVERIFIABLE IS NOT A MISMATCH, and this is the line that keeps every
 * existing client working: the MCP surface and any hand-written caller send no
 * identity at all, and `--shared` deliberately sends none either. An empty
 * `as` means "cannot tell", and cannot-tell is allowed — closing that hole is
 * the CLI's job and the MCP surface's, not this function's.
 *
 * The read/act split is in the PREFIX only, argued rather than assumed. The
 * measured harm from an unowned read here was evidence contamination, not
 * exfiltration: an agent reads 15 KB of somebody else's DOM, gets `ok: true`,
 * and files a conclusion or a proof-of-life screenshot from it — and a picture
 * of the wrong page looks exactly like a picture of the right one, which is
 * what the capture guard further down this file already refuses for. So a read
 * is refused too; it just says so in a way a caller can retry from without a
 * human deciding.
 */
export function crossContainerRefusal(o: AskOwnership): string | null {
  if (!o.as) return null;
  if (o.pageExplicit) return null;
  if (o.container === o.as) return null;
  const kind = o.acts ? "cross-container act refused" : "cross-container read refused";
  return `${kind}: tab ${o.tab} is in container "${o.container}" and you are "${o.as}" — `
    + "refused rather than acted on, because two agents in one tab is a page that changes "
    + "under somebody mid-task and neither of you sees it. "
    + `Open your own with \`open --as ${o.as} <url>\`, or say you meant this one with \`--page ${o.tab}\`.`;
}

/**
 * Does a tab an ask just minted take the visible pane?
 *
 * It always did — `addTab(...)` then set-active — which is why an agent's
 * routine work moved what the person was looking at, and, before the ownership
 * check above, silently re-aimed every other agent's un-addressed verb at it.
 * "You are giving focus to your container with your tests... you have to work
 * in the background inside your container."
 *
 * Two exceptions and no more. A window with nothing in it has to show the tab
 * it just made, or the person is left looking at an empty pane with no way back
 * to a page that exists. And a caller that asked to be shown gets what it asked
 * for — which is what `--show` now means on a mint, as opposed to the
 * failure-retry it was. A person clicking a link is not an ask at all and never
 * reaches this.
 */
export function mintTakesThePane(o: { existing: number; show: boolean }): boolean {
  return o.show || o.existing === 0;
}

/**
 * The tab and container an answer came from, stamped onto the answer.
 *
 * §8's defect, in one sentence: a navigating `open` answers `{url, title}` — a
 * description of the page AFTER the action — so it can never contradict the
 * caller even when the target was wrong. Measured on the incident: 80 of its 81
 * bare calls returned `ok: true`, and one of them was
 * `{"url": "http://127.0.0.1:8799/bench-page.html", "title": "Acme Ops
 * Console"}`, returned from a foreign tab and read as success.
 *
 * These ride INSIDE `value` rather than beside it, and that is not a
 * preference: the reply crosses `/browser/result`, which rebuilds the frame
 * from four named keys (`ok`, `value`, `error`, `diagnosis`), so anything at
 * the top level is dropped on the way through. A value that is not a plain
 * object is left exactly as it was — wrapping it would change what `text`
 * prints, and stdout is a contract here.
 */
export function stampWhere<T extends { ok: boolean; value?: unknown; error?: string }>(
  reply: T, where: { tab?: unknown; container?: unknown },
): T {
  const tab = typeof where.tab === "string" ? where.tab : "";
  const container = typeof where.container === "string" ? where.container : "";
  if (!tab && !container) return reply;
  const v = reply.value;
  if (!v || typeof v !== "object" || Array.isArray(v)) return reply;
  return { ...reply, value: { ...(v as Record<string, unknown>), tab, profile: container } };
}

/** The slice of Electron's `<webview>` this needs. Narrowed rather than `any`,
 *  so a fake in a test has to be honest about what it implements. */
export interface DrivableWebview {
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  /* `sendInputEvent` was here, and it is GONE. It sent a real key — to the
     widget that has the keyboard focus, which an embedded page never is, so
     the key landed in the app's own window and the page saw nothing. See the
     press case for the measurement. Nothing in this file may use it again. */
  getURL(): string;
  getTitle(): string;
  executeJavaScript(code: string): Promise<unknown>;
  /** Cropped at the source when `rect` is given — Electron's own
   *  `capturePage(rect)`, not a full frame trimmed afterwards. */
  capturePage(rect?: ShotClip): Promise<{ toDataURL(): string }>;
  /** A hard reload, for assets versioned by query string — without it there is
   *  no way to force a new bundle from the CLI. */
  reload(): void;
  reloadIgnoringCache(): void;
  addEventListener(type: string, fn: (e: Event) => void): void;
  removeEventListener(type: string, fn: (e: Event) => void): void;
}

/** How much page text is worth sending back. An agent reading a page needs the
 *  page, not a novel: past this the useful signal is long gone and the tokens
 *  are not. */
const MAX_TEXT = 20_000;

interface TabSettings {
  cache: "normal" | "bypass";
  ignoreCertErrors: boolean;
  blockedByOrigin: Map<string, { images: boolean; js: boolean }>;
}

/**
 * §13's settings, as this panel last set them — PER TAB.
 *
 * The source of truth for "is caching on" is Chromium's own session, which
 * this cannot read back from CDP any cheaper than remembering what it was last
 * told. What it must not do is remember it ONCE for the window: all three of
 * these are issued as CDP commands against one webview's guest
 * (`Network.setCacheDisabled`, `Security.setIgnoreCertificateErrors`,
 * `Network.setBlockedURLs`), so a single ledger described one tab and reported
 * it as if it were the browser. Two agents, and `settings get` answered each
 * of them with the other's state.
 *
 * Keyed by the ELEMENT, the way `agentZoom` above already is: one `<webview>`
 * per tab, kept mounted across navigations, and a closed tab takes its
 * settings with it for free. A WeakMap also keeps this module's promise of
 * knowing nothing about the tab strip.
 */
let tabSettings = new WeakMap<object, TabSettings>();

function settingsFor(el: object): TabSettings {
  let s = tabSettings.get(el);
  if (!s) {
    s = { cache: "normal", ignoreCertErrors: false, blockedByOrigin: new Map() };
    tabSettings.set(el, s);
  }
  return s;
}

/** For tests — a fresh panel, same as a real remount. A new map rather than a
 *  clear(): a WeakMap has no way to enumerate what it holds, and dropping the
 *  whole thing is the same fact. */
export function resetBrowserSettings(): void {
  tabSettings = new WeakMap<object, TabSettings>();
}

/**
 * The zoom an AGENT asked for, per tab.
 *
 * MEASURED: `zoom 2` answers 200%, then `open` on that same tab and the page is
 * back at the person's 158% — because the panel hands every fresh guest the
 * window level on `dom-ready` (see `reapplyZoom`). The agent is never told; it
 * goes on believing 200%, and every capture after it is at another size.
 *
 * Keyed by the ELEMENT, which is what a tab is here: one `<webview>` per tab,
 * kept mounted across navigations while the guest inside it is thrown away and
 * built again. A WeakMap rather than a map of tab ids because this module is
 * handed one webview and deliberately knows nothing about the strip — and
 * because a closed tab should take its override with it, which is exactly what
 * a weak key does for free.
 *
 * Only a `zoom` that SET something is remembered. Reading the zoom back is how
 * an agent matches a screen; it is not a claim on the tab.
 */
const agentZoom = new WeakMap<object, number>();

/** One `intercept` rule, in the shape the shell matches against. */
interface InterceptRule {
  pattern: string;
  fulfill?: boolean;
  status?: number;
  body?: string;
  abort?: boolean;
  reason?: string;
}

/** The rules each guest is under. Held here rather than in the page: the page
 *  is not what answers a paused request, and a variable in it survives neither
 *  a navigation nor a reader. */
const interceptRules = new WeakMap<object, InterceptRule[]>();

/** The zoom calls, which neither `DrivableWebview` nor the panel's `WebviewEl`
 *  declares in full: the level is the panel's ladder, the factor is what an
 *  agent asks in. Chromium holds one number — `factor = 1.2 ** level` — so
 *  setting either is setting the same thing. */
interface ZoomableWebview {
  setZoomLevel?(level: number): void;
  setZoomFactor?(factor: number): void;
  getZoomFactor?(): number;
}

/**
 * Put a fresh guest back to the zoom its tab is owed, on `dom-ready`.
 *
 * The window level for a tab nobody has claimed — that is the person's Ctrl+
 * and Ctrl-, and it must go on winning everywhere it did before. An agent's
 * factor for a tab it set one on, because the alternative is an agent that
 * asked for 200%, was told 200%, and is photographing 158%.
 */
export function reapplyZoom(el: object, windowLevel: number): void {
  const w = el as ZoomableWebview;
  const want = agentZoom.get(el);
  /*
   * A CLAIMED TAB IS LEFT ALONE, which is not what this did when it was
   * written.
   *
   * It re-applied the agent's factor with `setZoomFactor`, on the belief that
   * a guest's zoom factor is a thing that takes effect. Measured since: it is
   * not — a guest's zoom level and factor are both set and then ignored,
   * because the scale the page is drawn at comes from the window embedding
   * it. So an agent's zoom is a device-metrics override on that guest's own
   * DevTools session, and THAT survives a navigation on its own.
   *
   * What survives from the original is the distinction, which is the part
   * that mattered: a tab an agent has set a size on must not be handed the
   * person's level on every navigation, or the agent asked for 200%, was told
   * 200% and is photographing 158%.
   */
  if (want === undefined) w.setZoomLevel?.(windowLevel);
}

/** An agent claiming a tab's size. Named rather than reached at through the
 *  map, so the claim and the release are the same shape and a test can make
 *  one without driving the whole verb. */
export function claimAgentZoom(el: object, factor: number): void {
  agentZoom.set(el, factor);
}

/** What a caller needs of a guest to zoom it: run a snippet in the page, and
 *  reach that page's DevTools session. Both are already injected everywhere
 *  this is used; naming them keeps this testable without Electron. */
export interface ZoomableGuest {
  executeJavaScript(code: string): Promise<unknown>;
}
export type ZoomCdp = (method: string, params?: unknown) => Promise<{ ok: boolean; error?: string }>;

/** What the page ended up at, read back FROM the page. */
export interface GuestZoom {
  factor: number;
  percent: number;
  /** What it is a zoom OF, so a caller comparing two pages knows the two
   *  numbers are about different-sized panes. */
  pane: { width: number; height: number };
}

/**
 * Zoom a guest, the only way that takes effect.
 *
 * ONE implementation, called by the agent's `zoom` verb and by the person's
 * Ctrl+ / Ctrl- alike. It was two: the verb did this, and everything a person
 * could touch called `setZoomLevel`, which the notes on `reapplyZoom` and in
 * the verb both record as measured to do nothing. So an agent could zoom a
 * page and a person could not, on the same tab, in the same window.
 *
 * Not copied into the panel, deliberately. A second copy of "find the guest,
 * measure it, override it" is exactly how the capture ended up photographing
 * whichever tab was in front instead of the one it was asked for.
 *
 * `factor` 1 clears the override and hands the page back to the window's own
 * scale. Anything else lays the page out at `width / factor` CSS pixels and
 * draws each at `factor` device pixels, which is what browser zoom is.
 */
export async function applyGuestZoom(
  el: ZoomableGuest, factor: number, cdp: ZoomCdp,
): Promise<{ ok: true; value: GuestZoom } | { ok: false; error: string }> {
  if (!(factor > 0.1 && factor <= 5)) {
    return { ok: false, error: "zoom takes a factor between 0.1 and 5 — 1 is a page at its own size" };
  }
  /* The natural size is read with the override CLEARED, so a second zoom
     measures the pane and not its own previous answer. That is the bug this
     had in its first form, one layer up. */
  const clear = await cdp("Emulation.clearDeviceMetricsOverride");
  if (!clear.ok) return { ok: false, error: `this shell cannot zoom a page: ${clear.error || "no DevTools relay"}` };

  /*
   * MEASURED AFTER THE LAYOUT, NOT AFTER THE REQUEST.
   *
   * There was nothing between the call above and this read, so it described
   * the page as it was BEFORE the override was cleared — the previous zoom's
   * width, standing in for the natural one. The factor came out inflated, the
   * inflated level was fed back into the next press, and it compounded: he
   * ended up looking at `Page 524%` on a scale whose ceiling is 358%.
   *
   * Two frames is the idiom for "after style and layout have run": the first
   * fires before the next paint, the second after the one that includes it.
   * A fixed sleep would have been a guess at a machine's speed; this waits for
   * the thing itself.
   */
  const measure = `new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(
    JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })
  ))))`;
  const nat = await el.executeJavaScript(measure) as string;
  const base = JSON.parse(nat || "{}") as { w?: number; h?: number; dpr?: number };
  const natW = Math.max(1, Math.round(base.w ?? 0)), natH = Math.max(1, Math.round(base.h ?? 0));

  if (factor !== 1) {
    /*
     * BOTH NUMBERS ARE TAKEN LITERALLY. Measured, on the running app, by
     * asking for widths and reading `innerWidth` back:
     *
     *     asked width=2000 dsf=1      ->  innerWidth 2000  dpr 1.0
     *     asked width=2325 dsf=1.2    ->  innerWidth 2326  dpr 1.2
     *     asked width=2325 dsf=1.5    ->  innerWidth 2326  dpr 1.5
     *
     * This used to ask for `natW * dpr / factor` on the belief that the
     * override is given in the embedder's pixels and divided again by the
     * window's scale. It is not, and the cost was exact: on his window at
     * 125%, `zoom 1.2` laid the page out at 2790 x 1.25 / 1.2 = 2906 CSS
     * pixels — WIDER than the 2790 it started at, so asking to zoom in made
     * the page smaller. The verb reported it honestly, which is the only
     * reason it was findable: asked 1.2, answered 0.96.
     *
     * So: the same physical rectangle, laid out at `natW / factor` CSS pixels,
     * each drawn at `natDpr * factor` device pixels. The `natDpr` half is what
     * keeps a zoomed page as sharp as the window around it, and it is measured
     * rather than assumed because this machine has one monitor at 1.5 and
     * another at 1 — no constant is right on both.
     */
    const natDpr = base.dpr && base.dpr > 0 ? base.dpr : 1;
    const r = await cdp("Emulation.setDeviceMetricsOverride", {
      width: Math.max(1, Math.round(natW / factor)),
      height: Math.max(1, Math.round(natH / factor)),
      deviceScaleFactor: Math.round(natDpr * factor * 1000) / 1000,
      mobile: false,
    });
    if (!r.ok) return { ok: false, error: `could not zoom: ${r.error || "the DevTools protocol refused it"}` };
  }

  /* Read back from the PAGE, not from what we just asked for: a verb that
     reports its own argument is how this one was broken twice. */
  /* Same wait on the way out, and for the same reason: read too early and the
     answer describes the page before the override landed. */
  const now = JSON.parse(await el.executeJavaScript(measure) as string || "{}") as { w?: number };
  /*
   * A READING THAT CANNOT BE TRUE IS NOT A READING.
   *
   * The whole reason the answer is measured rather than repeated back is that
   * a wrong formula once reported 1.2 while the page sat at 0.96 — a real
   * disagreement, inside the scale, and worth surfacing. What is NOT worth
   * surfacing is arithmetic on a guest that has no page laid out: a pane a few
   * pixels wide divides into anything.
   *
   * So the page has to look like a page before its numbers are believed. 50 is
   * well under any real pane and well over the handful of pixels a webview
   * reports while it is attaching.
   */
  const MIN_PAGE_PX = 50;
  if (natW < MIN_PAGE_PX || (now.w ?? 0) < MIN_PAGE_PX) {
    return { ok: false, error: "that tab has no page laid out yet, so there is nothing to measure" };
  }
  const shown = natW / Math.max(1, now.w ?? natW);
  return {
    ok: true,
    value: {
      factor: Math.round(shown * 1000) / 1000,
      percent: Math.round(shown * 100),
      pane: { width: natW, height: natH },
    },
  };
}

/**
 * The panel's way in for the person's zoom keys.
 *
 * Ctrl+ and Ctrl- are owned by the renderer (see lib/zoomTarget.ts and the note
 * in electron/main.js that explains why they are NOT handled in the main
 * process), and the rule is "zoom whatever the pointer is over". Over a web
 * page that has to mean the page — it meant the whole window, measured: on a
 * page at innerWidth 2790 the window's dpr went 1.25 -> 1.5625 and the page
 * came back 2790, unchanged to the pixel.
 *
 * A registered function rather than an import, because only the panel knows
 * which tab is on screen, and `zoomTarget` must not learn: it has no business
 * resolving a guest, and a second resolver is the bug this file already had.
 */
let pageZoomer: ((dir: 1 | -1 | 0) => Promise<GuestZoom | null>) | null = null;

/** Registered by the browser panel while it is mounted. Passing `null` on
 *  teardown is what stops the keys reaching a guest that is gone. */
export function setPageZoomer(fn: ((dir: 1 | -1 | 0) => Promise<GuestZoom | null>) | null): void {
  pageZoomer = fn;
}

/** Whoever is currently able to zoom the page on screen, if anyone. */
export function currentPageZoomer(): ((dir: 1 | -1 | 0) => Promise<GuestZoom | null>) | null {
  return pageZoomer;
}

/** The person taking the tab back: Ctrl+, Ctrl-, Ctrl+0 or the stepper on a
 *  tab an agent had set. Whoever is in front wins — and after this the tab is
 *  an ordinary one again, following the window level as it always did. */
export function forgetAgentZoom(el: object | null | undefined): void {
  if (el) agentZoom.delete(el);
}

/**
 * How much of a script actually ran, from V8's precise-coverage ranges.
 *
 * THE RANGES ARE NESTED, and summing them counts the same bytes many times.
 * Measured against a real page: 476,253 used bytes of a 133,567-byte file —
 * more than three times its own length, which is not a number anybody can act
 * on, and worse than no number because it looks like one.
 *
 * V8 hands back, per function, an OUTER range plus the sub-ranges inside it
 * whose count differs. So a byte's real count is the count of the INNERMOST
 * range covering it, and everything wider is a default the inner one overrode.
 * Swept here: every boundary becomes an elementary interval, and the interval
 * takes the count of the tightest range around it.
 *
 * `total` is the widest offset any range reaches, which for V8 is the
 * script-level function and therefore the script's own length.
 */
export function coverageOf(
  functions: ReadonlyArray<{ ranges?: ReadonlyArray<{ count: number; startOffset: number; endOffset: number }> }>,
): { usedBytes: number; totalBytes: number } {
  const ranges: { count: number; start: number; end: number }[] = [];
  let total = 0;
  for (const fn of functions ?? []) {
    for (const r of fn.ranges ?? []) {
      if (!(r.endOffset > r.startOffset)) continue;
      ranges.push({ count: r.count, start: r.startOffset, end: r.endOffset });
      total = Math.max(total, r.endOffset);
    }
  }
  if (!ranges.length) return { usedBytes: 0, totalBytes: 0 };

  const edges = [...new Set(ranges.flatMap((r) => [r.start, r.end]))].sort((a, b) => a - b);
  /* Ranges by start, so the sweep can drop the ones already behind it rather
     than rescanning every range for every interval — a real bundle has tens of
     thousands and this runs while somebody waits. */
  const byStart = [...ranges].sort((a, b) => a.start - b.start);
  const open: { count: number; start: number; end: number }[] = [];
  let next = 0, used = 0;

  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i]!, to = edges[i + 1]!;
    while (next < byStart.length && byStart[next]!.start <= from) open.push(byStart[next++]!);
    let tightest: { count: number; start: number; end: number } | null = null;
    for (let k = open.length - 1; k >= 0; k--) {
      const r = open[k]!;
      if (r.end <= from) { open.splice(k, 1); continue; }
      /* Tightest wins: the innermost range is the one V8 meant for these
         bytes, and it is the one whose count is the truth about them. */
      if (!tightest || (r.end - r.start) < (tightest.end - tightest.start)) tightest = r;
    }
    if (tightest && tightest.count > 0) used += to - from;
  }
  return { usedBytes: used, totalBytes: total };
}

/** `Network.setBlockedURLs` wants one flat list of match patterns; this is
 *  every origin's own list, folded into it. Rebuilt from scratch on every
 *  change rather than appended to, because CDP's own call replaces the list
 *  wholesale — keeping our own map is what lets "block js, then also block
 *  images" on the same origin end up as one call with both patterns in it,
 *  instead of the second call silently dropping the first. */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico", "bmp"];
function blockedUrlPatterns(el: object): string[] {
  const patterns: string[] = [];
  for (const [origin, { images, js }] of settingsFor(el).blockedByOrigin) {
    if (images) for (const ext of IMAGE_EXTS) patterns.push(`*://${origin}/*.${ext}`);
    if (js) { patterns.push(`*://${origin}/*.js`); patterns.push(`*://${origin}/*.mjs`); }
  }
  return patterns;
}

/** A rectangle in CSS pixels, viewport-relative — what `shot --selector` and
 *  `shot --clip` both boil down to before they reach a capture. */
interface ShotClip { x: number; y: number; width: number; height: number }

/**
 * Resolve a selector to exactly one element, or say precisely why not (§15).
 *
 * Two failures used to be indistinguishable from a plain "nothing matches":
 * a selector that matched several elements silently acted on the first one —
 * "selector matched 3 elements" is what should have been said instead of
 * failing flat, or worse, clicking the wrong one — and a selector Chromium's
 * CSS engine cannot parse (`a:has-text(...)`, a Playwright-ism) threw inside
 * `executeJavaScript` and surfaced as "Error invoking remote method
 * GUEST_VIEW_MANAGER_CALL", which told nobody it was the selector's fault.
 * `querySelectorAll` catches both in one pass — a throw is the syntax error,
 * a length is the count — before `body` ever runs against a real element.
 */
function resolveOne(selLit: string, body: string): string {
  return `(() => {
    let __all;
    /*
       An id from an observation is accepted wherever a selector is, because
       section 17 lists inventing CSS selectors as an anti-feature and handing
       back e17 only to refuse it on the next call would be the anti-feature
       with extra steps. It is a data attribute on the node, so it needs no
       special path — just the selector it stands for.
    */
    const __raw = ${selLit};
    const __sel = /^e[0-9]+$/.test(__raw) ? '[data-agx-e="' + __raw + '"]' : __raw;
    try { __all = document.querySelectorAll(__sel); }
    catch (__e) { return { kind: "invalid", message: String((__e && __e.message) || __e) }; }
    if (__all.length === 0) return { kind: "none" };
    if (__all.length > 1) {
      /* Something that TELLS THEM APART. It described a node by tag, id and
         testid, which on a page whose elements have none of the last two says
         "p, p" — true, and no help at all to somebody being asked to narrow
         the selector. Found by running it against a real page. Position always
         distinguishes, so it always appears; the trimmed text is what a person
         actually recognises. */
      const __describe = (__n, __i) => {
        const __same = __n.parentElement
          ? [...__n.parentElement.children].filter((__c) => __c.tagName === __n.tagName)
          : [__n];
        const __nth = __same.indexOf(__n) + 1;
        const __text = (__n.innerText || __n.value || "").trim().replace(/\\s+/g, " ").slice(0, 40);
        return __n.tagName.toLowerCase()
          + (__n.id ? "#" + __n.id : "")
          + (__n.getAttribute && __n.getAttribute("data-testid") ? "[data-testid=" + __n.getAttribute("data-testid") + "]" : "")
          + (__same.length > 1 ? ":nth-of-type(" + __nth + ")" : "")
          + (__text ? ' "' + __text + '"' : "");
      };
      return { kind: "many", count: __all.length, samples: [...__all].slice(0, 5).map(__describe) };
    }
    const e = __all[0];
    ${body}
  })()`;
}

/** The sentence for whichever way `resolveOne` failed. */
function selectorError(sel: string, r: { kind?: string; message?: string; count?: number; samples?: string[] } | null | undefined): string {
  if (r?.kind === "invalid") return `invalid selector "${sel}": ${r.message}`;
  if (r?.kind === "many") {
    return `selector matched ${r.count} elements${r.samples?.length ? " — " + r.samples.join(", ") : ""}: narrow ${sel} to one`;
  }
  return `nothing on the page matches ${sel}`;
}

/**
 * Wait for a resolved element to actually be actionable, and say WHAT is
 * wrong when it is not (§3).
 *
 * A selector that matched one node used to be treated as ready the instant
 * it resolved: `e.click()` ran against an element still mid-transition, past
 * the fold, or hidden behind another one — the last of which cost half an
 * hour today, a modal backdrop sitting exactly over the cell under test with
 * nothing in the CLI able to say so. This is Playwright's four checks —
 * visible, enabled, stable, unobstructed — polled inside the page so it is
 * one round trip and not four, ending either in a click-ready element or a
 * reason an agent can act on: `covered by e42 .modal-backdrop`.
 *
 * Returns a Promise (JS source, not a value) so callers embed it as
 * `${actionable()}.then(...)` inside a `resolveOne` body.
 */
function actionable(timeoutMs = 3000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${timeoutMs};
    let last = null;
    const describe = (n) => {
      if (!n) return "nothing";
      const cls = typeof n.className === "string" && n.className.trim()
        ? "." + n.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
      const tid = n.getAttribute && n.getAttribute("data-testid");
      return n.tagName.toLowerCase() + (n.id ? "#" + n.id : cls) + (tid ? "[data-testid=" + tid + "]" : "");
    };
    const tick = () => {
      if (e.scrollIntoView) e.scrollIntoView({ block: "center", inline: "center" });
      const rect = e.getBoundingClientRect();
      const style = getComputedStyle(e);
      const visible = rect.width > 0 && rect.height > 0
        && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
      const enabled = !e.disabled && e.getAttribute("aria-disabled") !== "true";
      // Two reads of the same rect agreeing is "stable" — an element still
      // animating into place never matches its own previous frame. The
      // comparisons read backwards (0.5 first) because this codebase treats
      // a bare less-than anywhere in a verb's generated code as a
      // hostile-selector escape (see browser-drive.test.ts) and a comparison
      // operator does not get an exemption.
      const stable = !!last && 0.5 > Math.abs(rect.top - last.top) && 0.5 > Math.abs(rect.left - last.left)
        && 0.5 > Math.abs(rect.width - last.width) && 0.5 > Math.abs(rect.height - last.height);
      last = rect;
      if (visible && enabled && stable) {
        const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
        const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
        const top = document.elementFromPoint(cx, cy);
        if (!top) return resolve({ ok: false, reason: "not on screen" });
        if (top !== e && !e.contains(top)) return resolve({ ok: false, reason: "covered by " + describe(top) });
        return resolve({ ok: true });
      }
      if (Date.now() > deadline) {
        return resolve({ ok: false, reason: !visible ? "not visible" : !enabled ? "disabled" : "still moving" });
      }
      setTimeout(tick, 60);
    };
    tick();
  })`;
}

/** The sentence for a `resolveOne` body that returned `{ kind: "blocked" }` —
 *  an element found, but not safe to act on yet. Falls back to
 *  `selectorError` for the other three ways resolution fails. */
function actionError(sel: string, r: { kind?: string; reason?: string; message?: string; count?: number; samples?: string[] } | null | undefined): string {
  if (r?.kind === "blocked") return `${sel} is not ready — ${r.reason}`;
  return selectorError(sel, r);
}

/** `shot --selector`'s crop, and `--highlight`'s box: both need the same
 *  viewport-relative rectangle around one element, rounded to whole pixels
 *  because a capture's rect is a pixel grid and a fraction just gets
 *  truncated somewhere less predictable than here. */
function elementRectScript(selLit: string): string {
  return resolveOne(selLit, `
    e.scrollIntoView({ block: "center", inline: "center" });
    const rect = e.getBoundingClientRect();
    return { kind: "ok", rect: {
      x: Math.round(rect.left), y: Math.round(rect.top),
      width: Math.round(rect.width), height: Math.round(rect.height),
    } };
  `);
}

/**
 * CROP THE PICTURE, DO NOT ASK THE PAGE TO BE A DIFFERENT SHAPE.
 *
 * `--selector` and `--clip` used to be served by overriding the page's device
 * metrics to the rectangle's size and passing the rectangle to CDP. Measured:
 * the SIZE came out right and the CONTENTS did not — a crop of a 90x42 element
 * came back 191x89 (which is 90x42 at this screen's 2.125) and entirely blank,
 * because the override re-lays the page out and the coordinates measured before
 * it no longer point anywhere. Reported as "the --selector calls return blank
 * crops".
 *
 * So the capture is the one we know is right — the whole viewport, no clip, no
 * override, at the screen's own resolution — and the rectangle is taken out of
 * the pixels afterwards. `getBoundingClientRect` is in css pixels of that same
 * viewport, so the mapping is one multiplication and nothing has to agree about
 * coordinate spaces.
 */
async function cropPng(dataUrl: string, rect: ShotClip, scale: number): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const x = Math.max(0, Math.round(rect.x * scale));
  const y = Math.max(0, Math.round(rect.y * scale));
  /* Clamped to what was actually captured: an element hanging off the bottom of
     the viewport is cropped to what is on screen rather than producing a canvas
     with a band of nothing in it. */
  const w = Math.max(1, Math.min(Math.round(rect.width * scale), img.naturalWidth - x));
  const h = Math.max(1, Math.min(Math.round(rect.height * scale), img.naturalHeight - y));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

/** A fixed marker id, so the removal script does not need the selector that
 *  found it — the page may have changed underneath by the time it runs. */
const HIGHLIGHT_BOX_ID = "__agx_shot_highlight__";
const HIGHLIGHT_LABEL_ID = "__agx_shot_highlight_label__";

/**
 * `--highlight e17 --label "still Online"` — a box and a caption drawn ON
 * the page, so the capture that follows has them baked in. This is deliberately
 * DOM elements composited by the same rendering pass as the page, not pixels
 * drawn onto the PNG afterwards: it needs no image library, and it survives
 * every one of `shot`'s three capture routes (compositor, debugger, the
 * element's own `capturePage`) because all three photograph the same page.
 *
 * Dimmed backdrop plus a solid box, the shape a spotlight takes, so the thing
 * being pointed at is unambiguous even to someone skimming the image and not
 * reading the caption.
 */
function highlightScript(selLit: string, label: string | undefined): string {
  const labelLit = label !== undefined ? jsLit(label) : "";
  return resolveOne(selLit, `
    /*
     * DOCUMENT COORDINATES, not viewport ones.
     *
     * The box used to be \`position: fixed\` at the element's viewport rect,
     * which was right when a shot captured the viewport. A shot now frames the
     * whole document, so on any page that scrolls, a fixed box lands wherever
     * the viewport happens to be and points at nothing. Absolute positioning
     * plus the scroll offset puts it on the element itself, wherever that is.
     */
    const r = e.getBoundingClientRect();
    const top = r.top + window.scrollY;
    const left = r.left + window.scrollX;
    const box = document.createElement("div");
    box.id = ${jsLit(HIGHLIGHT_BOX_ID)};
    box.style.cssText = "position:absolute;left:" + left + "px;top:" + top + "px;"
      + "width:" + r.width + "px;height:" + r.height + "px;"
      + "border:3px solid #ff3b30;border-radius:4px;box-sizing:border-box;"
      + "box-shadow:0 0 0 9999px rgba(0,0,0,.35);pointer-events:none;z-index:2147483647;";
    document.body.appendChild(box);
    ${label !== undefined ? `
    /*
     * THE CAPTION IS NOT CLIPPED TO THE ELEMENT.
     *
     * It used to be capped at the element's own width (floor 120px) with
     * ellipsis, so highlighting anything narrow threw the caption away — a
     * 55px sidebar captioned "the table that proves the change" rendered as
     * nothing readable at all. A caption exists to be read; it takes the width
     * it needs, and only the page's width can stop it.
     */
    const cap = document.createElement("div");
    cap.id = ${jsLit(HIGHLIGHT_LABEL_ID)};
    cap.textContent = ${labelLit};
    const above = top > 28;
    cap.style.cssText = "position:absolute;top:" + (above ? top - 26 : r.bottom + window.scrollY + 6) + "px;"
      + "max-width:min(90vw,640px);"
      + "background:#ff3b30;color:#fff;font:600 12px/18px -apple-system,system-ui,sans-serif;"
      + "padding:3px 8px;border-radius:4px;pointer-events:none;z-index:2147483647;"
      + "white-space:nowrap;width:max-content;";
    /* Placed, then nudged back inside if it would hang off the right edge —
       measured after insertion, because its width is whatever the text needs. */
    cap.style.left = left + "px";
    document.body.appendChild(cap);
    const docW = document.documentElement.scrollWidth;
    const over = (left + cap.offsetWidth) - docW;
    if (over > 0) cap.style.left = Math.max(0, left - over - 4) + "px";
    ` : ""}
    return { kind: "ok" };
  `);
}

/** Undoes `highlightScript`, by id rather than by re-resolving the selector —
 *  a page that navigated or re-rendered under a slow capture may no longer
 *  match it, and the marker elements are still there to remove either way. */
const REMOVE_HIGHLIGHT_SCRIPT = `(() => {
  const box = document.getElementById(${jsLit(HIGHLIGHT_BOX_ID)});
  if (box) box.remove();
  const cap = document.getElementById(${jsLit(HIGHLIGHT_LABEL_ID)});
  if (cap) cap.remove();
})()`;

/** Wait for the guest to finish a navigation it has just been given. Resolves
 *  either way — "it loaded" and "it failed" are both answers, and the failure
 *  text is more useful to an agent than a timeout would be. */
function settled(el: DrivableWebview, timeoutMs = 40_000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (err: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener("did-stop-loading", onStop);
      el.removeEventListener("did-fail-load", onFail);
      resolve(err);
    };
    const onStop = () => finish(null);
    const onFail = (e: Event) => {
      const d = e as Event & { errorDescription?: string; isMainFrame?: boolean; errorCode?: number };
      // A subframe that failed is not the page failing, and -3 is the abort
      // that every interrupted navigation reports.
      if (d.isMainFrame === false || d.errorCode === -3) return;
      finish(d.errorDescription || "the page could not be loaded");
    };
    const timer = setTimeout(() => finish("the page did not finish loading"), timeoutMs);
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("did-fail-load", onFail);
  });
}

/** §8's `freezeAnimations`: a stylesheet the page cannot out-rank, plus
 *  pausing whatever the Web Animations API already has running. Idempotent —
 *  a second call finds the tag already there and pauses nothing twice. */
const FREEZE_ANIMATIONS_SCRIPT = `(() => {
  if (document.getElementById("__agxFreezeAnim")) return { already: true };
  const style = document.createElement("style");
  style.id = "__agxFreezeAnim";
  style.textContent = "*,*::before,*::after{animation-play-state:paused!important;" +
    "transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important}";
  (document.head || document.documentElement).appendChild(style);
  try { document.getAnimations().forEach((a) => a.pause()); } catch {}
  return { already: false };
})()`;

/** §8's `seal`: `Math.random()` made deterministic, so two runs of the same
 *  steps produce the same numbers to screenshot-diff against. Only `.random`
 *  is replaced — `Math.imul` and the rest of `Math` are untouched, and this
 *  file leans on `Math.imul` to build the generator itself. `Date.now()`
 *  needs no equivalent patch here: once `advanceMs` engages Chromium's
 *  virtual time, `Date.now()` already reports virtual time, which is exactly
 *  the "repeatable across runs" the spec is asking for — patching it again on
 *  top would be two clocks disagreeing with each other. */
const SEAL_RANDOM_SCRIPT = `(() => {
  if (window.__agxRandomSealed) return;
  window.__agxRandomSealed = true;
  let seed = 0x9e3779b9;
  window.Math.random = function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})()`;

/**
 * §8's `waitFor: "noTimers"`.
 *
 * Wraps `setTimeout`/`setInterval` to keep a live count of what is still
 * scheduled, because CDP has a pause-for-network policy but no pause-for-timers
 * one — advancing virtual time runs every timer inside the jump back to back
 * regardless, so this is read AFTER the jump to say whether anything is still
 * outstanding rather than a knob that changes what the jump does.
 *
 * This is the thing worth naming out loud: a page that polls on
 * `setInterval` never reaches zero here, because the interval re-arms itself
 * forever — that is correct, not a bug in the counter. A long `advanceMs`
 * jump against a page like that fires every tick the jump crosses in one
 * burst before this ever gets read, not once per real interval period; a
 * caller wanting to catch it mid-flight wants a SMALLER `advanceMs`, not
 * `waitFor: "noTimers"`, which only ever reports "still ticking".
 */
const PENDING_TIMERS_SCRIPT = `(() => {
  if (window.__agxTimersPatched) return;
  window.__agxTimersPatched = true;
  window.__agxLog = window.__agxLog || {};
  window.__agxLog.pendingTimers = 0;
  const real = { st: window.setTimeout, ct: window.clearTimeout, si: window.setInterval, ci: window.clearInterval };
  const active = new Set();
  const note = () => { window.__agxLog.pendingTimers = active.size; };
  window.setTimeout = (fn, ms, ...rest) => {
    const id = real.st.call(window, (...a) => { active.delete(id); note(); fn.apply(undefined, a); }, ms, ...rest);
    active.add(id); note(); return id;
  };
  window.clearTimeout = (id) => { active.delete(id); note(); return real.ct.call(window, id); };
  window.setInterval = (fn, ms, ...rest) => {
    const id = real.si.call(window, fn, ms, ...rest);
    active.add(id); note(); return id;
  };
  window.clearInterval = (id) => { active.delete(id); note(); return real.ci.call(window, id); };
})()`;

/**
 * Poll the GUEST's `Date.now()` from the HOST's real clock, not the guest's.
 *
 * Once `advanceMs` engages virtual time, `Date.now()` and `performance.now()`
 * INSIDE the page are both virtualised — so a wait loop built as one
 * `executeJavaScript` promise (the way `waitfor` does it) would be timing
 * itself against the very clock it just asked to stop meaning wall time. This
 * loop's own ceiling has to live out here instead, where `Date.now()` is
 * still real.
 *
 * `Emulation.setVirtualTimePolicy` only QUEUES the budget — Chromium drains
 * it asynchronously — so this is the one thing that survives a test double
 * for `cdp`: the page's own clock moving is the only signal available from
 * outside the protocol.
 */
async function pollGuestClock(
  el: DrivableWebview, target: number, realCapMs = 10_000,
): Promise<{ settled: boolean; dateNow: number }> {
  const startedReal = Date.now();
  for (;;) {
    const dateNow = Number(await el.executeJavaScript("Date.now()"));
    if (dateNow >= target) return { settled: true, dateNow };
    if (Date.now() - startedReal > realCapMs) return { settled: false, dateNow };
    await new Promise((r) => setTimeout(r, 15));
  }
}

/**
 * Run one verb against the guest, and say where it happened.
 *
 * The wrapper exists because `runVerb` answers from about seventy `return`
 * statements and §8 needs the tab and container on ALL of them — a stamp added
 * per-verb is the "somebody forgot to mark this one" shape the audit seam in
 * server/src/browserdrive.ts already argues against. The panel resolved both
 * before it called, and hands them down on the frame (`atTab`/`atProfile`):
 * this file cannot work out a tab id on its own, it is handed one webview.
 */
export async function runBrowserAsk(...a: Parameters<typeof runVerb>): ReturnType<typeof runVerb> {
  const ask = a[1];
  return stampWhere(await runVerb(...a), { tab: ask.args.atTab, container: ask.args.atProfile });
}

/** Run one verb against the guest. Throws nothing: every failure is an answer,
 *  because the caller's job is to report it to an agent, not to crash a panel. */
async function runVerb(
  el: DrivableWebview,
  ask: BrowserAskFrame,
  /** How to screenshot a pane nobody is looking at — the shell's capture, which
   *  this module deliberately does not import: reaching for it directly would
   *  drag the whole desktop bridge (and an origin, and a fetch) into the one
   *  file whose job is small enough to test without any of them. */
  captureFromShell: (opts?: { clip?: ShotClip; fullPage?: boolean }) => Promise<{ png: string | null; why: string; via?: string; cut?: boolean }> = async () => ({ png: null, why: "" }),
  /** Last thing tried before giving up on a screenshot: put the guest's surface
   *  back. A page can leave Chromium's compositor without a frame sink to copy
   *  from — measured on one with a voice SDK on it — and from then on EVERY
   *  capture fails, on every page, because navigating reuses the same view.
   *  Resizing the element is what makes Chromium allocate a new one. */
  revive: () => Promise<void> = async () => {},
  /** §4: registers `source` with the shell's CDP session for this guest under
   *  `name`, so Chromium runs it at document-start on every navigation from
   *  now on — the one thing `executeJavaScript` cannot do, because it only
   *  reaches a page that is already running. A `name` already registered is
   *  REPLACED, not stacked. Injected, like `captureFromShell`: the panel
   *  supplies the real thing; this module stays testable without Electron,
   *  a debugger session or a guest process behind it. */
  registerInitScript: (name: string, source: string) => Promise<{ ok: boolean; error?: string }> =
    async () => ({ ok: false, error: "this shell cannot register an init script" }),
  /** §5: one DevTools protocol command. Injected for the same reason as
   *  `registerInitScript` — the ergonomic verbs built on it (`listeners`,
   *  `coverage`) are then testable against a stand-in protocol, which is the
   *  only way to test them at all: a real one needs Electron, a guest process
   *  and a debugger seat. */
  cdp: (method: string, params?: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }> =
    async () => ({ ok: false, error: "this shell has no DevTools protocol relay" }),
  /** §5: whatever CDP sent while nobody was asking — a debugger pause, a DOM
   *  breakpoint firing. Draining empties it. */
  cdpEvents: () => Promise<Array<{ at: number; method: string; params: unknown }>> = async () => [],
  /** §13: apply session-level settings (proxy, extensions, cookies, DNS) through
   *  the Electron main process. */
  applySessionSettings: (req: Record<string, unknown>) => Promise<{ ok: boolean; applied?: string[]; error?: string }> =
    async () => ({ ok: false, error: "this shell does not support session settings" }),
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const sel = jsLit(String(ask.args.selector ?? ""));
  try {
    switch (ask.op) {
      case "open": {
        const url = String(ask.args.url ?? "");
        /* Where it was, so "it never moved" can be told from "it arrived
           somewhere slightly different", which a redirect makes common. */
        const before = el.getURL();
        const nav = settled(el);
        try {
          await el.loadURL(url);
        } catch (e) {
          // ERR_ABORTED (-3) is what Chromium calls the navigation this one just
          // replaced, and Electron rejects loadURL with it — so interrupting a
          // page that was still loading reported failure for a navigation that
          // then succeeded. Measured: `open example.com` over a half-loaded
          // GitHub answered "(-3) loading https://github.com/..." while the new
          // page loaded fine and every later verb saw it.
          //
          // `settled` is the authority either way: a genuinely bad address still
          // arrives as did-fail-load with its own reason.
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("(-3)") && !msg.includes("ERR_ABORTED")) return { ok: false, error: msg };
        }
        const err = await nav;
        if (err) return { ok: false, error: err };
        /*
         * DID IT ACTUALLY GO THERE.
         *
         * The guest guard refuses some schemes — `data:` among them, and
         * rightly, since it is a way to run markup nobody vetted. But
         * `loadURL` does not reject when the guard does: the navigation simply
         * never happens, and this answered ok with the URL it was ALREADY on.
         * Ask for A, get B, and be told yes. Measured today: three `open`s to
         * data: URLs in a row, each reporting success, with the page never
         * leaving the site it had been on since the first one.
         *
         * Equality is the wrong test — a redirect to https, or to /index, or a
         * trailing slash are all legitimate arrivals. What is NOT legitimate is
         * ending up exactly where it started when somewhere else was asked
         * for.
         */
        const landed = el.getURL();
        if (landed === before && landed !== url) {
          return {
            ok: false,
            error: `it did not navigate — still on ${landed}. The browser refused ${url.slice(0, 80)}: some schemes (data:, file:, blob:) are not allowed in this view.`,
          };
        }
        return { ok: true, value: { url: landed, title: el.getTitle() } };
      }

      case "read": {
        const value = await el.executeJavaScript(
          `({ url: location.href, title: document.title,
              text: (document.body ? document.body.innerText : "").slice(0, ${MAX_TEXT}) })`,
        );
        return { ok: true, value };
      }

      case "click": {
        // Reports whether it found ONE thing, because "clicked nothing",
        // "clicked something" and "clicked whichever of three came first" are
        // three different shapes of outcome, and an agent that cannot tell
        // them apart carries on down a path that never happened. Before the
        // click itself: §3's gate — visible, enabled, stable, unobstructed —
        // so a click against a covered or still-animating element fails with
        // WHAT is wrong rather than landing on the wrong thing in silence.
        const hit = await el.executeJavaScript(resolveOne(sel,
          `return (${actionable()}).then((r) => {
             if (!r.ok) return { kind: "blocked", reason: r.reason };
             e.click();
             return { kind: "ok" };
           });`,
        )) as { kind: string; reason?: string } | boolean;
        if (!hit || (hit as { kind: string }).kind !== "ok") {
          return { ok: false, error: actionError(String(ask.args.selector ?? ""), hit as never) };
        }
        // Then a beat, and where we are now. A click is the commonest way a page
        // moves, and answering the instant the element was hit tells an agent
        // nothing about whether it did — measured: a click that navigated was
        // followed by a `back` that acted on the history from before it, because
        // the navigation had not started yet. Not a wait for a navigation that
        // may never come: 250ms and an honest url.
        await new Promise((r) => setTimeout(r, 250));
        return { ok: true, value: { clicked: ask.args.selector, url: el.getURL(), title: el.getTitle() } };
      }

      case "dblclick":
      case "rightclick":
      case "hover":
      case "check": {
        // Same gate as `click` — a double-click, a right-click, a hover or a
        // checkbox toggle all act on a point on screen, and all four fail the
        // same way a plain click does when something else is sitting on that
        // point. `focus`/`blur` are handled separately below: they act on the
        // element itself, not a point, so a modal above it does not matter.
        const dispatch = ask.op === "dblclick"
          ? `e.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));`
          : ask.op === "rightclick"
            ? `e.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));`
            : ask.op === "hover"
              ? `e.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
                 e.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));`
              : /* check: the native setter so a framework bound to `checked` sees it,
                   not just the DOM — the same gap `type` closes for `value`. */
                `const wantOn = ${ask.args.checked !== false};
                 const proto = HTMLInputElement.prototype;
                 const set = Object.getOwnPropertyDescriptor(proto, "checked");
                 if (set && set.set) set.set.call(e, wantOn); else e.checked = wantOn;
                 e.dispatchEvent(new Event("input", { bubbles: true }));
                 e.dispatchEvent(new Event("change", { bubbles: true }));`;
        const hit = await el.executeJavaScript(resolveOne(sel,
          `return (${actionable()}).then((r) => {
             if (!r.ok) return { kind: "blocked", reason: r.reason };
             ${dispatch}
             return { kind: "ok" };
           });`,
        )) as { kind: string; reason?: string } | boolean;
        if (!hit || (hit as { kind: string }).kind !== "ok") {
          return { ok: false, error: actionError(String(ask.args.selector ?? ""), hit as never) };
        }
        return { ok: true, value: { [ask.op]: ask.args.selector } };
      }

      case "focus":
      case "blur": {
        const hit = await el.executeJavaScript(resolveOne(sel,
          `e.${ask.op}(); return { kind: "ok" };`,
        )) as { kind: string } | boolean;
        if (!hit || (hit as { kind: string }).kind !== "ok") {
          return { ok: false, error: selectorError(String(ask.args.selector ?? ""), hit as never) };
        }
        return { ok: true, value: { [ask.op]: ask.args.selector } };
      }

      case "fill": {
        // A whole form as one call: the same native-setter path `type` uses,
        // one field at a time, inside a single round trip instead of one per
        // field — and a failure says WHICH field, since "some of the form
        // filled" is not an answer an agent can act on.
        const fields = (ask.args.fields ?? {}) as Record<string, string>;
        const pairs = Object.entries(fields).map(([s, v]) => `[${jsLit(s)}, ${jsLit(v)}]`).join(", ");
        const result = await el.executeJavaScript(
          `(() => {
             const pairs = [${pairs}];
             const filled = [];
             for (const [fsel, text] of pairs) {
               let all;
               try { all = document.querySelectorAll(fsel); }
               catch (err) { return { kind: "invalid", selector: fsel, message: String((err && err.message) || err) }; }
               if (all.length === 0) return { kind: "none", selector: fsel };
               if (all.length > 1) return { kind: "many", selector: fsel, count: all.length };
               const fe = all[0];
               fe.focus();
               const proto = fe instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
               const set = Object.getOwnPropertyDescriptor(proto, "value");
               if (set && set.set) set.set.call(fe, text); else fe.value = text;
               fe.dispatchEvent(new Event("input", { bubbles: true }));
               fe.dispatchEvent(new Event("change", { bubbles: true }));
               filled.push(fsel);
             }
             return { kind: "ok", filled };
           })()`,
        ) as { kind: string; selector?: string; message?: string; count?: number; filled?: string[] };
        if (result?.kind !== "ok") {
          const badSel = result?.selector ?? "";
          return { ok: false, error: `could not fill ${badSel} — ${selectorError(badSel, result as never)}` };
        }
        return { ok: true, value: { filled: result.filled } };
      }

      case "type": {
        const text = jsLit(String(ask.args.text ?? ""));
        const submit = ask.args.submit === true;
        const hit = await el.executeJavaScript(resolveOne(sel,
          `e.focus();
             // The native setter, then an input event: React and every other
             // framework listens for the event and ignores a value assigned
             // behind its back, so a plain e.value = x types into a field that
             // snaps back on the next render.
             const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
             const set = Object.getOwnPropertyDescriptor(proto, "value");
             if (set && set.set) set.set.call(e, ${text}); else e.value = ${text};
             e.dispatchEvent(new Event("input", { bubbles: true }));
             e.dispatchEvent(new Event("change", { bubbles: true }));
             ${submit ? `if (e.form) e.form.requestSubmit ? e.form.requestSubmit() : e.form.submit();
                          else e.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));` : ""}
             /* Whether what was just typed is a secret, decided HERE because
                this is the only side that can see the node. The relay only
                ever sees the selector, so typing a real password into a field
                whose id a framework generated reaches its audit log intact:
                the id names nothing and the value has no token shape. That is
                the exact incident that got another browser MCP banned from
                this machine, and no selector heuristic can close it.
                (No backticks in here: this comment lives inside the template
                literal that builds the page script, and one would end it.) */
             const secret = e.type === "password"
               || /(^|\\s)(current|new)-password|one-time-code/.test(e.autocomplete || "");
             return { kind: "ok", secret };`,
        )) as { kind: string; secret?: boolean } | boolean;
        if (!hit || (hit as { kind: string }).kind !== "ok") {
          return { ok: false, error: selectorError(String(ask.args.selector ?? ""), hit as never) };
        }
        if (submit) await settled(el, 20_000);
        return {
          ok: true,
          value: {
            typed: ask.args.selector, submitted: submit,
            /* Carried back so the relay redacts the argument it logged. The
               value itself never crosses back — only the fact about it. */
            secretField: (hit as { secret?: boolean }).secret === true,
          },
        };
      }

      case "wait": {
        // Polled inside the page rather than from here: one round trip instead
        // of one every 100ms, and it sees the DOM as it changes.
        const found = await el.executeJavaScript(
          `new Promise((resolve) => {
             const deadline = Date.now() + 30000;
             const tick = () => {
               if (document.querySelector(${sel})) return resolve(true);
               if (Date.now() > deadline) return resolve(false);
               setTimeout(tick, 120);
             };
             tick();
           })`,
        );
        return found === true
          ? { ok: true, value: { appeared: ask.args.selector } }
          : { ok: false, error: `${ask.args.selector} never appeared` };
      }

      case "back":
      case "forward": {
        const can = ask.op === "back" ? el.canGoBack() : el.canGoForward();
        // Asked before doing it, because Electron's goBack() at the end of the
        // history is a silent no-op — and an agent that reads the same page
        // twice concludes the page did not change, not that it never moved.
        if (!can) return { ok: false, error: `there is nothing ${ask.op === "back" ? "back" : "forward"} from here` };
        const nav = settled(el);
        if (ask.op === "back") el.goBack(); else el.goForward();
        const err = await nav;
        if (err) return { ok: false, error: err };
        return { ok: true, value: { url: el.getURL(), title: el.getTitle() } };
      }

      case "html": {
        /* The markup of one element, so a selector can be chosen by reading
           the page rather than by curling the server and opening the .vue
           file it was built from — which is what somebody did today. */
        const max = Number(ask.args.max ?? 20_000);
        const value = await el.executeJavaScript(
          `(() => { const e = document.querySelector(${sel});
             return e ? { html: e.outerHTML.slice(0, ${max}), truncated: e.outerHTML.length > ${max} } : null; })()`,
        );
        return value
          ? { ok: true, value }
          : { ok: false, error: `nothing on the page matches ${ask.args.selector}` };
      }
      case "waitfor": {
        /* A CONDITION rather than an element appearing. "Until this text
           changes", "until the spinner is gone" — the waits that `wait
           --selector` cannot express, and the ones people actually have.
           Polled in the page rather than by re-asking from here, so a
           condition that becomes true for one frame is not missed between
           two round trips. */
        const ms = Number(ask.args.timeoutMs ?? 15_000);
        const js = String(ask.args.js ?? "");
        /* A condition that does not PARSE never reaches the try/catch inside:
           the wrapper itself fails, and what comes back is the bridge's
           "GUEST_VIEW_MANAGER_CALL" sentence — the one §15 exists to abolish.
           Measured by passing a selector, which is what the CLI's own help
           told people to pass: "Uncaught SyntaxError: Private field '#done'
           must be declared in an enclosing class". */
        const value = await el.executeJavaScript(
          `(() => new Promise((done) => {
             const started = Date.now();
             const test = () => { try { return !!(${js}); } catch { return false; } };
             if (test()) return done({ ready: true, waitedMs: 0 });
             const id = setInterval(() => {
               if (test()) { clearInterval(id); done({ ready: true, waitedMs: Date.now() - started }); }
               else if (Date.now() - started > ${ms}) { clearInterval(id); done({ ready: false, waitedMs: Date.now() - started }); }
             }, 60);
           }))()`,
        ).catch((e: unknown) => {
          const msg = String((e as Error)?.message ?? e);
          return /GUEST_VIEW_MANAGER_CALL|failed to execute/i.test(msg)
            ? { ready: false, waitedMs: 0, bad: true }
            : Promise.reject(e);
        }) as { ready: boolean; waitedMs: number; bad?: boolean };
        if (value?.bad) {
          return {
            ok: false,
            error: `waitfor takes a JavaScript CONDITION, not a selector, and this one did not parse: ${js.slice(0, 80)}`
              + " — try `wait <selector>` for an element appearing, or a condition like"
              + " `document.querySelector('#done')`.",
          };
        }
        return value?.ready
          ? { ok: true, value }
          : { ok: false, error: `still not true after ${Math.round(ms / 1000)}s` };
      }
      case "eval": {
        /* The verb the documentation used to forbid. See browserdrive.ts for
           why "no arbitrary JavaScript" is the wrong fence for an agent, and
           which fence is the right one. */
        const js = String(ask.args.js ?? "");
        const max = Number(ask.args.max ?? 20_000);
        /*
         * THE ERROR IS CAUGHT IN THE PAGE, because that is the only place it
         * is legible.
         *
         * An exception crossing the webview bridge arrives as "Error invoking
         * remote method GUEST_VIEW_MANAGER_CALL: Script failed to execute,
         * this normally means an error was thrown. Check the renderer console
         * for the error" — and an agent cannot check the renderer console.
         * That is precisely the opaque message §15 exists to abolish, and it
         * was still being produced by the verb that unblocks everything else.
         *
         * A syntax error is different: the wrapper itself fails to parse, so
         * there is no try/catch to reach and the bridge message is all there
         * is. That case is named separately below rather than left as the
         * same sentence.
         */
        /*
         * SYNCHRONOUS UNLESS ASKED OTHERWISE — and this is not a style choice.
         *
         * Making the wrapper `async` unconditionally broke every eval,
         * including `1+1`, on every page. A webview's `executeJavaScript`
         * handles a promise-returning script differently from a plain one, and
         * the failure comes back through the bridge as the same opaque
         * GUEST_VIEW_MANAGER_CALL that this rewrite existed to remove — so the
         * fix reported the breakage it had just caused as a quoting problem,
         * and said so even when the script came from a file. Two wrong
         * sentences on top of a working feature.
         *
         * Measured: the identical wrapper through `Runtime.evaluate` returned
         * 2, which is what proved the JavaScript was never the problem.
         */
        const catchBlock = `catch (__e) {
            return {
              __agxOk: false,
              __agxErr: String((__e && __e.message) || __e),
              /* No escape sequence here, on purpose: this string is built by a
                 template literal and then bundled, and a "\n" arrives at the
                 page as a REAL newline inside a string literal — which does not
                 parse, so nothing runs. That broke every eval, including 1+1.
                 The first 300 characters of a stack are the frames anybody
                 reads, and slicing needs no escapes at all. */
              __agxWhere: String((__e && __e.stack) || "").slice(0, 300),
            };
          }`;
        const wrapped = ask.args.await === true
          ? `(async () => {
          try { const __v = await (${js}); return { __agxOk: true, __agxV: __v }; }
          ${catchBlock}
        })()`
          : `(() => {
          try { return { __agxOk: true, __agxV: (${js}) }; }
          ${catchBlock}
        })()`;
        try {
          const outcome = await el.executeJavaScript(wrapped) as
            { __agxOk?: boolean; __agxV?: unknown; __agxErr?: string; __agxWhere?: string };
          if (outcome && outcome.__agxOk === false) {
            return {
              ok: false,
              error: `the page threw: ${String(outcome.__agxErr).slice(0, 400)}`
                + (outcome.__agxWhere ? ` — at ${outcome.__agxWhere.slice(0, 200)}` : ""),
            };
          }
          const raw = outcome?.__agxV;
          /* Serialised here rather than handed back whole: a page object with
             cycles in it cannot cross the bridge, and an agent asking for the
             app's store wants what is IN it. */
          let value: unknown = raw;
          if (raw !== null && typeof raw === "object") {
            try { value = JSON.parse(JSON.stringify(raw)); }
            catch { value = String(raw).slice(0, max); }
          }
          const text = typeof value === "string" ? value : JSON.stringify(value);
          return { ok: true, value: { value, truncated: !!text && text.length > max } };
        } catch (e) {
          /* Only a script that would not PARSE reaches here — a thrown error
             was caught in the page above. So say that, rather than repeating
             the bridge's sentence about a renderer console nobody can open. */
          const msg = String((e as Error)?.message ?? e);
          return {
            ok: false,
            /*
             * NAME WHAT IS KNOWN, GUESS AT NOTHING. This said "that is not
             * valid JavaScript — check your quoting" for every bridge failure,
             * including ones where the script came from a FILE and the quoting
             * could not possibly be at fault. It sent somebody looking at
             * their shell escaping while the real fault was in this file. A
             * confident wrong diagnosis costs more than a vague true one.
             */
            /* And the most common way to write something that does not parse
               HERE is to write statements: the body goes into an expression
               position, so `a = 1; b = 2` is a syntax error while `a = 1` is
               not. Measured twice tonight by whoever was driving. */
            error: /GUEST_VIEW_MANAGER_CALL|failed to execute/i.test(msg)
              ? "the page would not run it, and the browser did not say why. Most often it is not an EXPRESSION: "
                + "a sequence of statements needs wrapping — `(() => { a; b; return c; })()`. "
                + "If you are quoting it on a shell, `eval --file` cannot be mangled on the way."
              : `the page could not run it: ${msg.slice(0, 400)}`,
          };
        }
      }
      case "cdp": {
        /* §5, the whole protocol. Not nine verbs for nine DevTools features:
           every one of them is a CDP domain Chromium already implements, and
           nine wrappers would be nine ways to be missing the tenth on the day
           somebody needs it. The ergonomic verbs below are built ON this. */
        if (ask.args.events === true) {
          return { ok: true, value: { events: await cdpEvents() } };
        }
        const method = String(ask.args.method ?? "");
        /*
         * THE ONE DOMAIN THAT CANNOT WORK HERE, said out loud.
         *
         * `Input.*` answered {} and did nothing — the worst possible answer,
         * and two sessions spent an afternoon on it each. Measured: a key sent
         * to a guest's DevTools session arrives at the APP'S OWN renderer. The
         * listener in the guest recorded zero events; the listener in the
         * embedder recorded "keydown:Z" from the same call.
         *
         * That is not a bug in the relay. A page embedded in a <webview> is
         * not the widget that holds the focus, and Chromium delivers
         * synthesised input to the focused widget — so the events land on the
         * app's own window, where nobody wants them. Nothing in this file can
         * change that.
         *
         * So it is refused, by name, with what to use instead. Everything a
         * caller wanted from Input.* has a verb that works on a background
         * tab, because those verbs act in the page.
         */
        if (/^Input\./.test(method)) {
          return {
            ok: false,
            error: `${method} cannot reach a page in this browser: an embedded page is not the widget that holds the keyboard focus, `
              + "so Chromium delivers the event to the app's own window instead — measured, the page receives nothing. "
              + "Use the verbs, which act inside the page and work on a tab nobody is looking at: `press` for keys, "
              + "`type` for text, `click`/`dblclick`/`hover` for the mouse, `drag` for a drag.",
          };
        }
        const r = await cdp(method, ask.args.params);
        return r.ok
          ? { ok: true, value: { result: r.result } }
          : { ok: false, error: r.error || "the DevTools protocol refused that" };
      }

      case "emulate": {
        /*
         * §10, and it is not cosmetic: the spec records a centred modal
         * covering exactly the cell that had to be proved, with no way to
         * frame both in one capture. Colour scheme, timezone and language
         * change what a real app RENDERS, not how it looks.
         *
         * One verb rather than nine, because these are set together and read
         * together — "this page, as a phone, in Tokyo, in dark mode" is one
         * thought. Each key is applied only when present, so a second call
         * changing one thing does not silently reset the rest.
         */
        const a = ask.args as Record<string, unknown>;
        const applied: string[] = [];
        const fail = (r: { ok: boolean; error?: string }, what: string) =>
          r.ok ? (applied.push(what), null) : { ok: false as const, error: r.error || `could not set ${what}` };

        if (a.width !== undefined || a.height !== undefined || a.scale !== undefined || a.mobile !== undefined) {
          const bad = fail(await cdp("Emulation.setDeviceMetricsOverride", {
            width: Number(a.width ?? 0), height: Number(a.height ?? 0),
            deviceScaleFactor: Number(a.scale ?? 0), mobile: a.mobile === true,
          }), "device metrics");
          if (bad) return bad;
          if (a.mobile !== undefined) {
            /* Touch is a separate override, and a "mobile" viewport without it
               is a phone-shaped desktop: hover menus still open, :active never
               fires, and a layout that branches on pointer type takes the
               wrong branch. */
            const t = fail(await cdp("Emulation.setTouchEmulationEnabled", {
              enabled: a.mobile === true, maxTouchPoints: a.mobile === true ? 5 : 0,
            }), "touch");
            if (t) return t;
          }
        }
        if (typeof a.userAgent === "string") {
          const bad = fail(await cdp("Emulation.setUserAgentOverride", {
            userAgent: a.userAgent,
            ...(typeof a.language === "string" ? { acceptLanguage: a.language } : {}),
          }), "user agent");
          if (bad) return bad;
        } else if (typeof a.language === "string") {
          /* Accept-Language rides on the UA override, so setting the language
             alone means sending the UA the page already has back with it. */
          const bad = fail(await cdp("Emulation.setUserAgentOverride", {
            userAgent: navigator.userAgent, acceptLanguage: a.language,
          }), "language");
          if (bad) return bad;
        }
        if (typeof a.timezone === "string") {
          const bad = fail(await cdp("Emulation.setTimezoneOverride", { timezoneId: a.timezone }), "timezone");
          if (bad) return bad;
        }
        if (typeof a.locale === "string") {
          /* Distinct from `language` above: that rides on the UA override and
             changes Accept-Language, the HTTP header. This changes what
             `Intl` reports inside the page — `toLocaleDateString()`,
             `Intl.NumberFormat` — which §8 needs sealed alongside the clock
             for a capture to be repeatable, not just the request headers. */
          const bad = fail(await cdp("Emulation.setLocaleOverride", { locale: a.locale }), "locale");
          if (bad) return bad;
        }
        if (a.geolocation && typeof a.geolocation === "object") {
          const g = a.geolocation as { lat?: number; lon?: number; accuracy?: number };
          const bad = fail(await cdp("Emulation.setGeolocationOverride", {
            latitude: Number(g.lat ?? 0), longitude: Number(g.lon ?? 0), accuracy: Number(g.accuracy ?? 1),
          }), "geolocation");
          if (bad) return bad;
        }
        const features: Array<{ name: string; value: string }> = [];
        if (typeof a.colorScheme === "string") features.push({ name: "prefers-color-scheme", value: a.colorScheme });
        if (typeof a.reducedMotion === "string") features.push({ name: "prefers-reduced-motion", value: a.reducedMotion });
        if (features.length) {
          const bad = fail(await cdp("Emulation.setEmulatedMedia", { features }), "media features");
          if (bad) return bad;
        }
        if (typeof a.vision === "string") {
          /* Colour-vision deficiency: the spec asks for it by name, and it is
             the one emulation that answers a question a person cannot answer
             by squinting. "none" clears it. */
          const bad = fail(await cdp("Emulation.setEmulatedVisionDeficiency", { type: a.vision }), "vision deficiency");
          if (bad) return bad;
        }
        if (a.reset === true) {
          /* Everything back, in one call, because an emulation left on is a
             wrong answer that arrives hours later in an unrelated run. */
          await cdp("Emulation.clearDeviceMetricsOverride", {});
          await cdp("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 0 });
          await cdp("Emulation.setEmulatedMedia", { features: [] });
          await cdp("Emulation.setEmulatedVisionDeficiency", { type: "none" });
          await cdp("Emulation.clearGeolocationOverride", {});
          await cdp("Emulation.setLocaleOverride", { locale: "" });
          applied.push("reset");
        }
        return { ok: true, value: { emulating: applied } };
      }

      case "clock": {
        /*
         * §8: three minutes of real waiting, measured, for one screenshot of
         * a thirty-second timer. `advanceMs` is `Emulation.setVirtualTimePolicy`
         * doing the actual jump; `seal` and `freezeAnimations` are the other
         * two things a REPEATABLE capture needs alongside it, so this is one
         * verb rather than three that a caller has to remember to call
         * together every time.
         */
        const a = ask.args as Record<string, unknown>;
        const applied: string[] = [];
        const value: Record<string, unknown> = {};

        if (a.freezeAnimations === true) {
          await el.executeJavaScript(FREEZE_ANIMATIONS_SCRIPT);
          applied.push("animations frozen");
          value.animationsFrozen = true;
        }

        if (a.seal === true) {
          /* Registered for every navigation from here on, AND applied to the
             page already loaded — `addInitScript`'s effect only starts at the
             next navigation, and a page open right now still needs sealing. */
          const r = await registerInitScript("__agxSealRandom", SEAL_RANDOM_SCRIPT);
          if (!r.ok) return { ok: false, error: r.error || "could not seal Math.random for future navigations" };
          await el.executeJavaScript(SEAL_RANDOM_SCRIPT);
          applied.push("Math.random sealed");
          value.randomSealed = true;
        }

        const advanceMs = Number(a.advanceMs ?? 0);
        if (advanceMs > 0) {
          if (a.waitFor === "noTimers") {
            await registerInitScript("__agxPendingTimers", PENDING_TIMERS_SCRIPT);
            await el.executeJavaScript(PENDING_TIMERS_SCRIPT);
          }
          const before = Number(await el.executeJavaScript("Date.now()"));
          const policy = a.waitFor === "networkIdle" ? "pauseIfNetworkFetchesPending" : "advance";
          const r = await cdp("Emulation.setVirtualTimePolicy", { policy, budget: advanceMs });
          if (!r.ok) return { ok: false, error: r.error || "could not advance the virtual clock" };
          const { settled: caughtUp, dateNow } = await pollGuestClock(el, before + advanceMs);
          value.advancedMs = dateNow - before;
          value.dateNow = dateNow;
          applied.push(`clock advanced ${dateNow - before}ms`);
          if (!caughtUp) {
            /* Not a failure — the jump was queued and IS happening, just not
               finished inside this call's real-time patience. Reported rather
               than silently returned as if it were the full amount. */
            value.stillRunning = true;
          }
          if (a.waitFor === "noTimers") {
            value.pendingTimers = await el.executeJavaScript(
              `(() => (window.__agxLog && window.__agxLog.pendingTimers) || 0)()`,
            );
          }
        }

        value.applied = applied;
        return { ok: true, value };
      }

      case "settings": {
        /* §13. Page-level settings (cache, certificate errors, blocking) are
           applied through CDP; session-level settings (proxy, extensions,
           cookies, DNS) are applied through the Electron main process. */
        const a = ask.args as Record<string, unknown>;
        /* THIS TAB'S, and the caller is told which — `settings get` used to
           read one module-global ledger and present it as the window's, so
           with two agents each was shown the other's cache policy and
           certificate override as its own. `el` is the webview the relay
           already resolved from `page`, so "this tab" needs no new plumbing. */
        const mine = settingsFor(el);
        if (a.action === "get") {
          return {
            ok: true,
            value: {
              cache: mine.cache,
              ignoreCertErrors: mine.ignoreCertErrors,
              blocked: Object.fromEntries(mine.blockedByOrigin),
              scope: "tab",
            },
          };
        }
        const applied: string[] = [];
        /* Page-level settings via CDP. Every one of these three is a command
           against THIS guest's debugger session, which is why remembering them
           per window was wrong in the first place. */
        if (typeof a.cache === "string") {
          const r = await cdp("Network.setCacheDisabled", { cacheDisabled: a.cache === "bypass" });
          if (!r.ok) return { ok: false, error: r.error || "could not set the cache policy" };
          mine.cache = a.cache as "normal" | "bypass";
          applied.push("cache");
        }
        if (typeof a.ignoreCertErrors === "boolean") {
          await cdp("Security.enable", {});
          const r = await cdp("Security.setIgnoreCertificateErrors", { ignore: a.ignoreCertErrors });
          if (!r.ok) return { ok: false, error: r.error || "could not set certificate error handling" };
          mine.ignoreCertErrors = a.ignoreCertErrors;
          applied.push("ignoreCertErrors");
        }
        if (a.block && typeof a.block === "object") {
          const blk = a.block as { origin: string; images?: boolean; js?: boolean };
          const prev = mine.blockedByOrigin.get(blk.origin) ?? { images: false, js: false };
          const next = {
            images: blk.images !== undefined ? blk.images : prev.images,
            js: blk.js !== undefined ? blk.js : prev.js,
          };
          if (next.images || next.js) mine.blockedByOrigin.set(blk.origin, next);
          else mine.blockedByOrigin.delete(blk.origin);
          const r = await cdp("Network.setBlockedURLs", { urls: blockedUrlPatterns(el) });
          if (!r.ok) return { ok: false, error: r.error || "could not update the block list" };
          applied.push(`block:${blk.origin}`);
        }
        /* `internalPage`, not `page`: `page` now names the TAB, the same as on
           every other verb, and this navigating the front tab to about:blank
           because the two shared a name is exactly what §14 closed. */
        if (a.internalPage === "blank") {
          await el.loadURL("about:blank");
          applied.push("internalPage");
        }
        /* Session-level settings via the Electron main process. */
        const sessionSettings: Record<string, unknown> = {};
        if (a.proxy) sessionSettings.proxy = a.proxy;
        if (a.cookies) sessionSettings.cookies = a.cookies;
        if (a.extensions) sessionSettings.extensions = a.extensions;
        if (a.dns) sessionSettings.dns = a.dns;
        if (Object.keys(sessionSettings).length > 0) {
          const r = await applySessionSettings(sessionSettings);
          if (!r.ok) return { ok: false, error: r.error || "could not apply session settings" };
          if (r.applied) applied.push(...r.applied);
        }
        return { ok: true, value: { applied } };
      }

      case "debug": {
        /*
         * §5's debugger, as one verb with an action rather than six verbs.
         *
         * The protocol is already reachable whole through `cdp`, so this exists
         * for the part that is genuinely awkward there: a pause is an EVENT,
         * and reading the scope of a paused frame takes three calls whose
         * arguments come out of the previous one. That chain is the thing worth
         * wrapping; the rest of CDP is fine as it is.
         */
        const a = ask.args as Record<string, unknown>;
        const action = String(a.action ?? "");
        if (action === "on") {
          const r = await cdp("Debugger.enable", {});
          return r.ok ? { ok: true, value: { debugger: "on" } }
            : { ok: false, error: r.error || "could not enable the debugger" };
        }
        if (action === "off") {
          await cdp("Debugger.disable", {});
          return { ok: true, value: { debugger: "off" } };
        }
        if (action === "break") {
          /* By url and line, which is what a person has in front of them.
             `urlRegex` rather than `url` so a bundle served with a cache-buster
             query still matches — the exact-url form silently never binds, and
             a breakpoint that never binds looks identical to code that never
             runs. */
          const r = await cdp("Debugger.setBreakpointByUrl", {
            urlRegex: String(a.url ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            lineNumber: Math.max(0, Number(a.line ?? 1) - 1),
            ...(typeof a.condition === "string" && a.condition ? { condition: a.condition } : {}),
          }) as { ok: boolean; result?: { breakpointId?: string; locations?: unknown[] }; error?: string };
          if (!r.ok) return { ok: false, error: r.error || "could not set that breakpoint" };
          const where = r.result?.locations ?? [];
          return {
            ok: true,
            value: {
              breakpointId: r.result?.breakpointId, boundAt: where,
              /* Saying so, because an unbound breakpoint and a line that never
                 runs look the same from the outside and mean opposite things. */
              bound: where.length > 0,
              ...(where.length ? {} : { note: "it did not bind to any loaded script — check the url, or set it before the script loads" }),
            },
          };
        }
        if (action === "dom") {
          /* "Who deleted this row." The one question a debugger answers that
             nothing else here can. */
          const ev = await cdp("Runtime.evaluate", { expression: `document.querySelector(${sel})` }) as
            { ok: boolean; result?: { result?: { objectId?: string; subtype?: string } }; error?: string };
          const objectId = ev.result?.result?.objectId;
          if (!objectId || ev.result?.result?.subtype === "null") {
            return { ok: false, error: `nothing on the page matches ${String(a.selector ?? "")}` };
          }
          await cdp("DOM.enable", {});
          /* The same protocol rule `upload` was caught by: DOM.requestNode
             translates a Runtime object through the DOM agent's node map, and
             that map is EMPTY until the document has been pulled once.
             DOM.enable does not pull it. Measured here too — "could not
             address that node" about a node the querySelector two lines above
             had just returned. depth 1: the map only has to exist. */
          await cdp("DOM.getDocument", { depth: 1 });
          const node = await cdp("DOM.requestNode", { objectId }) as
            { ok: boolean; result?: { nodeId?: number }; error?: string };
          if (!node.result?.nodeId) return { ok: false, error: node.error || "could not address that node" };
          const kind = String(a.on ?? "subtree-modified");
          const r = await cdp("DOMDebugger.setDOMBreakpoint", { nodeId: node.result.nodeId, type: kind });
          return r.ok ? { ok: true, value: { watching: a.selector, on: kind } }
            : { ok: false, error: r.error || "could not set that DOM breakpoint" };
        }
        if (action === "where") {
          /*
           * Where it is paused and what is in scope — the three-call chain,
           * done here. `Debugger.paused` arrived as an event, so its frames are
           * in the buffer rather than in an answer, and the caller would
           * otherwise have to know that.
           */
          const evs = await cdpEvents();
          const paused = [...evs].reverse().find((e) => e.method === "Debugger.paused");
          if (!paused) return { ok: true, value: { paused: false } };
          const frames = ((paused.params as { callFrames?: unknown[] })?.callFrames ?? []) as Array<{
            functionName?: string; location?: { lineNumber?: number };
            url?: string; scopeChain?: Array<{ type?: string; object?: { objectId?: string } }>;
          }>;
          const top = frames[0];
          let locals: unknown = null;
          const scopeId = top?.scopeChain?.find((s2) => s2.type === "local")?.object?.objectId;
          if (scopeId) {
            const props = await cdp("Runtime.getProperties", { objectId: scopeId, ownProperties: true }) as
              { ok: boolean; result?: { result?: Array<{ name: string; value?: { description?: string; type?: string } }> } };
            locals = (props.result?.result ?? []).map((p2) => ({
              name: p2.name, type: p2.value?.type, value: p2.value?.description,
            }));
          }
          return {
            ok: true,
            value: {
              paused: true,
              reason: (paused.params as { reason?: string })?.reason,
              /* The stack trimmed to what fits a decision — §14. The whole
                 chain of a real app is hundreds of frames and the answer is
                 almost always in the first few. */
              stack: frames.slice(0, 12).map((f) => ({
                fn: f.functionName || "(anonymous)", url: f.url,
                line: (f.location?.lineNumber ?? 0) + 1,
              })),
              locals,
            },
          };
        }
        /* step / resume, by their protocol names. */
        const STEP: Record<string, string> = {
          resume: "Debugger.resume", into: "Debugger.stepInto",
          over: "Debugger.stepOver", out: "Debugger.stepOut",
        };
        const method = STEP[action];
        if (!method) return { ok: false, error: `unknown debug action: ${action}` };
        const r = await cdp(method, {});
        return r.ok ? { ok: true, value: { did: action } }
          : { ok: false, error: r.error || `could not ${action}` };
      }

      case "drag": {
        /*
         * §3. Not two clicks: a drag is a sequence of pointer events with the
         * button held between them, and a page listening for dragstart or for
         * pointermove sees nothing at all from click-then-click. HTML5 drag
         * and drop needs its own event family on top, with a DataTransfer that
         * survives the whole gesture — a fresh one per event is the mistake
         * that makes a drop silently do nothing.
         */
        const to = jsLit(String((ask.args as Record<string, unknown>).to ?? ""));
        const r = await el.executeJavaScript(`(async () => {
          const pick = (q) => document.querySelector(/^e[0-9]+$/.test(q) ? '[data-agx-e="' + q + '"]' : q);
          const a = pick(${sel}), b = pick(${to});
          if (!a) return { kind: "none", which: "source" };
          if (!b) return { kind: "none", which: "target" };
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          const at = (r) => [r.left + r.width / 2, r.top + r.height / 2];
          const [x1, y1] = at(ra), [x2, y2] = at(rb);
          const dt = new DataTransfer();
          const fire = (el2, type, x, y, extra) => el2.dispatchEvent(new (extra ? DragEvent : PointerEvent)(type, {
            bubbles: true, cancelable: true, clientX: x, clientY: y,
            ...(extra ? { dataTransfer: dt } : { pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1 }),
          }));
          /*
           * AND THE MOUSE FAMILY, which is what the drag libraries listen to.
           *
           * Measured against a page that reports what it received: the pointer
           * events arrived, the HTML5 drag events arrived, and the mouse list
           * came back empty.
           * Sortable.js — and so vuedraggable, and so every Vue editor built on
           * it — binds mousedown, mousemove and mouseup, not pointer events, so
           * a drag over one of those did nothing at all and said it had worked.
           * Reported from a real editor: "the drag CLI is broken".
           *
           * (No backticks anywhere in here: this comment lives inside the
           * template literal that builds the page script, and one would end it.
           * The same note is written two hundred lines up, for the same reason.)
           *
           * Both families, in the order a real gesture produces them: a page
           * that listens to only one still sees exactly one, and a page that
           * listens to both sees what a hand would have made.
           */
          const mouse = (el2, type, x, y) => el2.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, clientX: x, clientY: y,
            button: 0, buttons: type === "mouseup" ? 0 : 1,
          }));
          /*
           * THE HANDLE IS NOT THE THING BEING DRAGGED.
           *
           * Measured on a real Sortable list: every event arrived, in order,
           * and the list did not move. Sortable saw choose:true, start:false —
           * it recognised the tap on the handle and never began the drag —
           * and left a .sortable-drag element in the page that nothing came
           * back to clear.
           *
           * The reason: Sortable puts draggable="true" on the ITEM and uses
           * the handle only to decide whether a tap counts. Its _onDragStart
           * expects the dragstart to come from that item, so a dragstart
           * dispatched on the handle is not associated with the gesture in
           * flight and _triggerDragStart is never called.
           *
           * So the item is resolved AFTER the mousedown — that is the event
           * that makes Sortable mark it — and the two events that must come
           * from the item, dragstart and dragend, are dispatched there.
           * dragover, drop and mouseup keep going to what is under the
           * pointer, which is where they already went and where they belong.
           */
          /* A timer, NOT requestAnimationFrame. A tab that is not the one on
             screen does not paint, so rAF never fires there and the whole
             gesture hung until the verb timed out — measured: "the browser did
             not answer in time (drag)" on a background tab, with choose:true
             and nothing else. A drag has to work on a page nobody is looking
             at; that is most of what an agent drags. */
          const frame = () => new Promise((r) => setTimeout(r, 16));
          fire(a, "pointerdown", x1, y1);
          mouse(a, "mousedown", x1, y1);
          /* A frame, so a library that arms itself on the next tick has had
             it. Sortable sets the item's draggable flag inside its own tap
             handler, but nothing says every library does it synchronously. */
          await frame();
          const item = a.closest('[draggable="true"]')
            /* Sortable marks the item it chose with this class the moment the
               tap counts — the same fact as the draggable flag, from the
               library that does not set the flag until later. */
            || a.closest(".sortable-chosen")
            || a;
          fire(item, "dragstart", x1, y1, true);
          /* dragenter before the first dragover: a drop target that arms itself
             on enter never armed, so the drop landed on a target that had not
             accepted it. */
          fire(b, "dragenter", x1, y1, true);
          /* A few steps rather than one jump: a sortable list decides where a
             row lands from the moves it saw, and a single move from A to B
             reads as a drag that never passed over anything. */
          for (let i = 1; i <= 4; i++) {
            const x = x1 + (x2 - x1) * (i / 4), y = y1 + (y2 - y1) * (i / 4);
            fire(b, "pointermove", x, y);
            mouse(b, "mousemove", x, y);
            fire(b, "dragover", x, y, true);
            /* One frame per step. A sortable list moves its placeholder in an
               animation frame, and four moves in the same tick are four moves
               it has not drawn yet — which is also not what a hand produces. */
            await frame();
          }
          fire(b, "drop", x2, y2, true);
          fire(b, "pointerup", x2, y2);
          mouse(b, "mouseup", x2, y2);
          fire(item, "dragend", x2, y2, true);
          return { kind: "ok" };
        })()`) as { kind: string; which?: string };
        if (r.kind !== "ok") {
          return { ok: false, error: `nothing on the page matches the ${r.which} of the drag` };
        }
        /*
         * A DRAG DOES NOT NAVIGATE, so it must not wait for a load.
         *
         * This was a bare `settled(el, 5_000)`, which resolves on
         * did-stop-loading — an event a reorder never fires — so every
         * successful drag paid the full five seconds before answering.
         * Measured from outside: 10.07s for one drag. Raced with a short beat
         * now: a drop that DID navigate still gets its load reported, and one
         * that did not answers as soon as the list has had a moment.
         */
        await Promise.race([settled(el, 5_000), new Promise((r) => setTimeout(r, 400))]);
        return { ok: true, value: { dragged: ask.args.selector, onto: (ask.args as Record<string, unknown>).to } };
      }

      case "upload": {
        /*
         * §11. A file input cannot be filled from script — the value is
         * read-only by design, which is the whole point of it. The shell has
         * to hand Chromium the paths through the debugger, so this verb is
         * thin here and real over there.
         */
        const paths = ((ask.args as Record<string, unknown>).paths ?? []) as string[];
        const node = await cdp("Runtime.evaluate", {
          expression: `document.querySelector(${sel})`,
        }) as { ok: boolean; result?: { result?: { objectId?: string; subtype?: string } }; error?: string };
        const objectId = node.result?.result?.objectId;
        if (!objectId || node.result?.result?.subtype === "null") {
          return { ok: false, error: `nothing on the page matches ${String(ask.args.selector ?? "")}` };
        }
        await cdp("DOM.enable", {});
        /*
         * getDocument, and it is not decoration.
         *
         * DOM.requestNode translates a Runtime object into a nodeId by looking
         * it up in the agent's node map — and that map is EMPTY until the
         * document has been pulled once. DOM.enable does not pull it. Without
         * this line requestNode answered with no nodeId at all, and the verb
         * reported "could not address that input" about an input it had just
         * found: measured against a page whose file input existed, was of type
         * file, and was returned by the querySelector two lines above.
         *
         * depth 1 on purpose: the map only has to exist, and a full tree on a
         * heavy page is a cost paid for nothing.
         */
        await cdp("DOM.getDocument", { depth: 1 });
        const dn = await cdp("DOM.requestNode", { objectId }) as { ok: boolean; result?: { nodeId?: number } };
        if (!dn.result?.nodeId) return { ok: false, error: "could not address that input" };
        const set = await cdp("DOM.setFileInputFiles", { files: paths, nodeId: dn.result.nodeId });
        return set.ok
          ? { ok: true, value: { uploaded: paths.length, to: ask.args.selector } }
          : { ok: false, error: set.error || "the browser refused those files" };
      }

      case "fake": {
        /*
         * §6: force a 404, a 500 or a hang on requests whose URL contains
         * `pattern` — enforced inside the page itself, in the same fetch/XHR
         * wrappers `console`/`network` already read from (see COLLECTOR), so
         * a faked request never touches the real network at all.
         *
         * The collector is injected first, same as `observe`: a fake
         * registered before any navigation still needs somewhere to live.
         */
        await el.executeJavaScript(COLLECTOR).catch(() => 0);
        const patternLit = jsLit(String(ask.args.pattern ?? ""));
        if (ask.args.clear === true) {
          const removed = await el.executeJavaScript(
            `(() => { const log = window.__agxLog; if (!log || !log.fakes) return false;
               const before = log.fakes.length;
               log.fakes = log.fakes.filter((f) => f.pattern !== ${patternLit});
               return log.fakes.length < before; })()`,
          );
          return { ok: true, value: { cleared: ask.args.pattern, wasActive: removed === true } };
        }
        const bodyLit = typeof ask.args.body === "string" ? jsLit(ask.args.body) : "undefined";
        const statusLit = ask.args.status !== undefined ? String(Number(ask.args.status)) : "undefined";
        const timeoutLit = ask.args.timeout === true ? "true" : "false";
        const delayLit = String(Number(ask.args.delayMs ?? 0));
        await el.executeJavaScript(
          `(() => { const log = window.__agxLog; if (!log) return 0;
             log.fakes = (log.fakes || []).filter((f) => f.pattern !== ${patternLit});
             log.fakes.push({ pattern: ${patternLit}, status: ${statusLit}, timeout: ${timeoutLit}, body: ${bodyLit}, delayMs: ${delayLit} });
             return 1; })()`,
        );
        return {
          ok: true,
          value: {
            faking: ask.args.pattern,
            status: ask.args.status, timeout: ask.args.timeout === true, delayMs: Number(ask.args.delayMs ?? 0),
          },
        };
      }

      case "headers": {
        /*
         * §6's `--header`. Set once and every request carries it — which is
         * the difference from passing one on a single call: a page makes
         * dozens of requests and a header that only rides on the one you
         * happened to name proves nothing about the rest.
         *
         * Cleared by passing nothing, and an observation while any are set
         * says so: a header the page did not ask for is a lie it believes,
         * and the same rule `fake` follows applies for the same reason.
         */
        const a = ask.args as Record<string, unknown>;
        const headers = (a.headers ?? {}) as Record<string, string>;
        await cdp("Network.enable", {});
        const r = await cdp("Network.setExtraHTTPHeaders", { headers });
        return r.ok
          ? { ok: true, value: { headers: Object.keys(headers), count: Object.keys(headers).length } }
          : { ok: false, error: r.error || "the browser refused those headers" };
      }

      case "clipboard": {
        /*
         * §11. The scar this follows: `navigator.clipboard` fails when focus
         * is in the guest, which is why the picker copies through the shell's
         * own clipboard instead. Same route here rather than rediscovering it.
         */
        const a = ask.args as Record<string, unknown>;
        if (typeof a.write === "string") {
          const r = await cdp("Input.insertText", { text: "" });
          void r;
          const ok = await el.executeJavaScript(
            `(async () => { try { await navigator.clipboard.writeText(${jsLit(a.write)}); return true; } catch (e) { return false; } })()`,
          ) as boolean;
          return ok
            ? { ok: true, value: { wrote: String(a.write).length } }
            : { ok: false, error: "the page would not write to the clipboard — it needs focus, or the permission (see `permission`)" };
        }
        const text = await el.executeJavaScript(
          `(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return null; } })()`,
        ) as string | null;
        return text === null
          ? { ok: false, error: "the page would not read the clipboard — grant clipboardReadWrite with `permission` first" }
          : { ok: true, value: { text } };
      }

      case "save": {
        /*
         * §11: the whole page, as one file. Not the HTML alone — that is
         * `html`, and it is a document that no longer renders once it is off
         * the network. MHTML keeps the images and the stylesheets with it,
         * which is what "save the page" is asked for.
         */
        /*
         * `Page.enable` FIRST, or `captureSnapshot` never answers.
         *
         * Measured on a four-line local page, twice, with the tab in front:
         * `Page.captureSnapshot` sat until the shell's 8-second deadline reset
         * the session — "did not answer in 8s". The same call on a tab that
         * had been sent a `Page.enable` returned an MHTML document at once,
         * and `save` then wrote 1404 bytes.
         *
         * It does not fail — it hangs, which is the failure mode this file
         * has now met three times (`captureScreenshot` on a tab that is not
         * compositing, and `Fetch.enable` with nobody answering). Enabling is
         * idempotent, so it costs one round trip on a page that already had
         * it.
         */
        await cdp("Page.enable", {});
        const r = await cdp("Page.captureSnapshot", { format: "mhtml" }) as
          { ok: boolean; result?: { data?: string }; error?: string };
        return r.ok && r.result?.data
          ? { ok: true, value: { mhtml: r.result.data } }
          : { ok: false, error: r.error || "the page could not be captured" };
      }

      case "intercept": {
        /*
         * §6: at the NETWORK level, which is what makes it different from
         * `fake` — it catches what the page did not make through fetch.
         *
         * THE RULES LIVE IN THE SHELL, and this is the whole fix. They used to
         * be written into a variable in the page while `Fetch.enable` was
         * turned on here — and Fetch.enable pauses every request until
         * something answers it. Nothing did: `Fetch.requestPaused` appears
         * nowhere in this repo outside the shell's new handler. Measured by a
         * peer session: one call and the tab stopped loading anything, a
         * matching URL and a non-matching URL alike, and `--clear` did not
         * bring it back — only `Fetch.disable` by hand did.
         *
         * So the list goes to the shell, which is where the events arrive, and
         * the domain is on exactly while there is something to match.
         */
        const pattern = String(ask.args.pattern ?? "");
        const rules = interceptRules.get(el) ?? [];
        const rest = rules.filter((r) => r.pattern !== pattern);
        if (ask.args.clear === true) {
          const was = rest.length !== rules.length;
          interceptRules.set(el, rest);
          const off = await cdp("Fetch.agxSetRules", { rules: rest });
          if (!off.ok) return { ok: false, error: off.error || "could not clear the rule" };
          if (!rest.length) await cdp("Fetch.disable");
          return { ok: true, value: { cleared: pattern, wasActive: was, rules: rest.length } };
        }
        const rule: InterceptRule = ask.args.fulfill === true
          ? { pattern, fulfill: true, status: Number(ask.args.status ?? 200), body: typeof ask.args.body === "string" ? ask.args.body : "" }
          : { pattern, abort: true, reason: typeof ask.args.reason === "string" ? ask.args.reason : "Failed" };
        const next = [...rest, rule];
        /* The rules first, the domain second. The other order is a window —
           however short — in which requests are paused and the shell does not
           yet know what to do with them. */
        const set = await cdp("Fetch.agxSetRules", { rules: next });
        if (!set.ok) return { ok: false, error: set.error || "this shell cannot intercept requests" };
        const on = await cdp("Fetch.enable", {});
        if (!on.ok) {
          await cdp("Fetch.agxSetRules", { rules: rest });
          return { ok: false, error: on.error || "could not enable request interception" };
        }
        interceptRules.set(el, next);
        return {
          ok: true,
          value: {
            intercepting: pattern,
            rules: next.length,
            ...(rule.fulfill ? { status: rule.status } : { abort: true }),
          },
        };
      }
      case "region": {
        /*
         * §2's last flag: the tree of ONE subtree instead of the page. A
         * modal on a busy page is fifteen nodes inside three hundred, and the
         * other two hundred and eighty-five are paid for on every turn after
         * (§14). Same shape as `observe`, scoped.
         */
        const r = await el.executeJavaScript(`(() => {
          const pick = (q) => document.querySelector(/^e[0-9]+$/.test(q) ? '[data-agx-e="' + q + '"]' : q);
          const root = pick(${sel});
          if (!root) return { kind: "none" };
          const name = (el2) => (
            el2.getAttribute("aria-label") ||
            el2.getAttribute("placeholder") ||
            el2.getAttribute("title") ||
            (el2.innerText || "").trim().slice(0, 80) || ""
          ).trim().slice(0, 80);
          const stamp = (el2) => {
            if (!el2.dataset.agxE) {
              window.__agxSeq = (window.__agxSeq || 0) + 1;
              el2.dataset.agxE = "e" + window.__agxSeq;
            }
            return el2.dataset.agxE;
          };
          const tree = [];
          for (const el2 of root.querySelectorAll("a,button,input,select,textarea,[role],[data-testid],summary,h1,h2,h3")) {
            if (tree.length >= 120) break;
            const rect = el2.getBoundingClientRect();
            tree.push({
              e: stamp(el2),
              role: el2.getAttribute("role") || el2.tagName.toLowerCase(),
              name: name(el2),
              testid: el2.getAttribute("data-testid") || undefined,
              disabled: el2.disabled === true || undefined,
              at: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
            });
          }
          return { kind: "ok", e: stamp(root), text: (root.innerText || "").trim().slice(0, 4000), tree };
        })()`) as { kind: string; e?: string; text?: string; tree?: unknown[] };
        return r.kind === "ok"
          ? { ok: true, value: { region: ask.args.selector, e: r.e, text: r.text, tree: r.tree } }
          : { ok: false, error: `nothing on the page matches ${String(ask.args.selector ?? "")}` };
      }

      case "throttle": {
        /*
         * §6. The other half of faking a broken API: a SLOW one. A page that
         * works on a fast machine and falls over at 3G is the commonest bug
         * that never reproduces locally, and the only honest way to see it is
         * to make the machine slow rather than to reason about it.
         *
         * Offline is not zero bandwidth — it is a different failure. A request
         * that fails immediately with a network error takes a different path
         * through most apps than one that takes twelve seconds, and treating
         * them as the same setting hides one of the two bugs.
         */
        const a = ask.args as Record<string, unknown>;
        if (a.off === true) {
          await cdp("Network.emulateNetworkConditions", {
            offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
          });
          await cdp("Emulation.setCPUThrottlingRate", { rate: 1 });
          return { ok: true, value: { throttling: "off" } };
        }
        const PRESETS: Record<string, { latency: number; down: number; up: number }> = {
          /* Chromium's own numbers, so a report here matches a report from a
             person's DevTools rather than being a second set to argue about. */
          "slow-3g": { latency: 400, down: 50_000, up: 50_000 },
          "fast-3g": { latency: 150, down: 180_000, up: 84_375 },
          "4g": { latency: 20, down: 1_000_000, up: 500_000 },
        };
        if (a.offline === true) {
          const r = await cdp("Network.emulateNetworkConditions", {
            offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
          });
          return r.ok ? { ok: true, value: { offline: true } }
            : { ok: false, error: r.error || "could not go offline" };
        }
        const applied: Record<string, unknown> = {};
        if (typeof a.network === "string") {
          const p2 = PRESETS[a.network]!;
          const r = await cdp("Network.emulateNetworkConditions", {
            offline: false, latency: p2.latency, downloadThroughput: p2.down, uploadThroughput: p2.up,
          });
          if (!r.ok) return { ok: false, error: r.error || "could not throttle the network" };
          applied.network = a.network;
        }
        if (typeof a.cpu === "number") {
          const r = await cdp("Emulation.setCPUThrottlingRate", { rate: a.cpu });
          if (!r.ok) return { ok: false, error: r.error || "could not throttle the CPU" };
          applied.cpu = a.cpu;
        }
        return { ok: true, value: applied };
      }

      case "har": {
        /*
         * §6: "a HAR, exportable as evidence". Built from the same buffer the
         * network log already fills rather than from a second recording — a
         * second one would drift, and the whole value of a HAR is that it is
         * what actually happened.
         */
        /*
         * AND IT INSTALLS THE COLLECTOR, like its two siblings.
         *
         * It only read the buffer, so a HAR taken on a page nobody had
         * collected on came back with zero entries — indistinguishable from a
         * page that made no requests, which is the exact confusion `listening`
         * exists to prevent. `console` and `network` learned this already;
         * this one was left behind, and it is the one whose whole purpose is
         * to be evidence.
         */
        await el.executeJavaScript(COLLECTOR).catch(() => 0);
        const got = await el.executeJavaScript(
          `(() => { const log = window.__agxLog;
             return { rows: ((log && log.network) || []).slice(-1000),
                      listening: (log && log.startedAt) || 0, now: Date.now() }; })()`,
        ) as { rows: Array<{ at: number; method: string; url: string; status: number; ms: number; size?: number }>; listening: number; now: number };
        const rows = got.rows || [];
        return {
          ok: true,
          value: {
            /* Outside the `log`, because a HAR file has a shape other tools
               read and this is ours: how long we have been collecting, so an
               empty one can be told from an unwatched one. */
            listening: got.listening,
            now: got.now,
            log: {
              version: "1.2",
              creator: { name: "agentglass", version: "1" },
              entries: rows.map((r) => ({
                startedDateTime: new Date(r.at).toISOString(),
                time: r.ms,
                request: { method: r.method, url: r.url, httpVersion: "HTTP/1.1", headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: -1 },
                response: { status: r.status, statusText: "", httpVersion: "HTTP/1.1", headers: [], cookies: [], content: { size: r.size ?? 0, mimeType: "" }, redirectURL: "", headersSize: -1, bodySize: r.size ?? 0 },
                cache: {},
                timings: { send: 0, wait: r.ms, receive: 0 },
              })),
            },
          },
        };
      }

      case "storage": {
        /*
         * §7. Cookies landed; the rest of a session did not. A login is as
         * often a token in localStorage as a cookie, and restoring one without
         * the other gives a page that is half signed in — which fails later
         * and somewhere else.
         *
         * Reading gives keys and values here, unlike `observe`, which gives
         * keys alone: an observation is a thing an agent keeps in its context
         * and §16 keeps secrets out of it, while this is an explicit ask for
         * the values, usually to write them back into another profile.
         */
        const a = ask.args as Record<string, unknown>;
        const where = String(a.where ?? "local");
        const key = jsLit(String(a.key ?? ""));
        const val = jsLit(String(a.value ?? ""));
        const store = where === "session" ? "sessionStorage" : "localStorage";
        if (a.set === true) {
          const r = await el.executeJavaScript(
            `(() => { try { ${store}.setItem(${key}, ${val}); return { ok: true }; } catch (e) { return { ok: false, why: String(e && e.message || e) }; } })()`,
          ) as { ok: boolean; why?: string };
          return r.ok ? { ok: true, value: { set: a.key, in: where } }
            : { ok: false, error: r.why || "the page refused that write" };
        }
        if (a.remove === true) {
          await el.executeJavaScript(`${store}.removeItem(${key})`);
          return { ok: true, value: { removed: a.key, in: where } };
        }
        if (where === "idb") {
          /* IndexedDB by NAME and version only. Its contents are arbitrary
             structured clones — a page's whole offline cache — and dumping
             them into an answer is the §14 mistake in its purest form. What a
             caller actually asks is "did this page create its database", and
             the name answers it. */
          const dbs = await el.executeJavaScript(`(async () => {
            try {
              if (!indexedDB.databases) return { ok: false, why: "this browser cannot list databases" };
              const list = await indexedDB.databases();
              return { ok: true, items: list.map((d) => ({ name: d.name, version: d.version })) };
            } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
          })()`) as { ok: boolean; items?: unknown[]; why?: string };
          return dbs.ok
            ? { ok: true, value: { where: "idb", items: dbs.items, count: (dbs.items ?? []).length } }
            : { ok: false, error: dbs.why || "could not list the databases" };
        }
        const all = await el.executeJavaScript(`(() => {
          try {
            const out = {};
            for (let i = 0; i < ${store}.length; i++) {
              const k = ${store}.key(i);
              out[k] = String(${store}.getItem(k) ?? "").slice(0, 4000);
            }
            return { ok: true, items: out, count: Object.keys(out).length };
          } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
        })()`) as { ok: boolean; items?: unknown; count?: number; why?: string };
        return all.ok ? { ok: true, value: { where, items: all.items, count: all.count } }
          : { ok: false, error: all.why || "the page would not let its storage be read" };
      }

      case "permission": {
        /*
         * §7: "permissions per origin granted by API, not by a dialog nobody
         * can click". A dialog is worse than a refusal for an agent — a
         * refusal is an answer, a dialog is a page that stops responding.
         */
        const a = ask.args as Record<string, unknown>;
        const r = await cdp("Browser.grantPermissions", {
          origin: String(a.origin ?? ""),
          permissions: (a.permissions ?? []) as string[],
        });
        return r.ok ? { ok: true, value: { granted: a.permissions, to: a.origin } }
          : { ok: false, error: r.error || "the browser refused to grant that" };
      }

      case "pdf": {
        /* §10. Not a screenshot of a page: a PDF is what "print this" produces,
           with the page's print stylesheet applied — which is a different
           document from what is on screen, and usually the one being asked
           about. It goes to disk like `record` does, because a base64 PDF in
           an agent's context is paid for on every turn after. */
        const a = ask.args as Record<string, unknown>;
        const r = await cdp("Page.printToPDF", {
          printBackground: a.background !== false,
          landscape: a.landscape === true,
        }) as { ok: boolean; result?: { data?: string }; error?: string };
        if (!r.ok || !r.result?.data) return { ok: false, error: r.error || "the page produced no PDF" };
        return { ok: true, value: { pdf: r.result.data } };
      }

      case "listeners": {
        /* "Which listeners does this node have, and which file are they from"
           — §5. `DOMDebugger.getEventListeners` wants a remote object id, so
           the node is resolved through Runtime first; doing it in one verb is
           the difference between one call and four. */
        const ev = await cdp("Runtime.evaluate", {
          expression: `document.querySelector(${sel})`, includeCommandLineAPI: true,
        }) as { ok: boolean; result?: { result?: { objectId?: string; subtype?: string } }; error?: string };
        const objectId = ev.result?.result?.objectId;
        if (!ev.ok) return { ok: false, error: ev.error || "the DevTools protocol refused that" };
        if (!objectId || ev.result?.result?.subtype === "null") {
          return { ok: false, error: `nothing on the page matches ${String(ask.args.selector ?? "")}` };
        }
        const got = await cdp("DOMDebugger.getEventListeners", { objectId, depth: 1 }) as
          { ok: boolean; result?: { listeners?: unknown[] }; error?: string };
        return got.ok
          ? { ok: true, value: { listeners: got.result?.listeners ?? [] } }
          : { ok: false, error: got.error || "could not read the listeners" };
      }

      case "coverage": {
        /*
         * "Did my change even load" — §5, and the row in §18 that says this
         * was answered by comparing bytes of a bundle with `cmp`. Coverage
         * says which lines actually RAN, which is the question underneath.
         *
         * start/stop rather than one call, because coverage is a recording:
         * a single call would only ever report the instant it was made.
         */
        const which = String(ask.args.action ?? "start");
        if (which === "start") {
          const a = await cdp("Profiler.enable", {});
          if (!a.ok) return { ok: false, error: a.error || "could not start coverage" };
          await cdp("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
          await cdp("CSS.enable", {});
          await cdp("CSS.startRuleUsageTracking", {});
          return { ok: true, value: { coverage: "recording" } };
        }
        const js = await cdp("Profiler.takePreciseCoverage", {}) as
          { ok: boolean; result?: { result?: Array<{ url: string; functions?: Array<{ ranges?: Array<{ count: number; startOffset: number; endOffset: number }> }> }> } };
        const css = await cdp("CSS.stopRuleUsageTracking", {}) as
          { ok: boolean; result?: { ruleUsage?: Array<{ styleSheetId: string; used: boolean }> } };
        await cdp("Profiler.stopPreciseCoverage", {});
        /* Summarised here, not handed over raw: a precise-coverage dump of a
           real bundle is megabytes, and §14 exists because that lands in an
           agent's context and is re-read every turn after. Per-file used and
           total bytes answers "did it load and did it run"; the raw ranges are
           one `cdp Profiler.takePreciseCoverage` away for anyone who needs
           them. */
        const files = (js.result?.result ?? [])
          .map((f) => ({ url: f.url, ...coverageOf(f.functions ?? []) }))
          .filter((f) => f.totalBytes > 0);
        const rules = css.result?.ruleUsage ?? [];
        return {
          ok: true,
          value: {
            js: files,
            css: { rules: rules.length, used: rules.filter((r) => r.used).length },
          },
        };
      }

      case "addInitScript": {
        /* The name is only ever a MAP KEY on the shell side — it never gets
           pasted into JavaScript here, so it needs no `jsLit`. The js body is
           trusted the same way `eval`'s is: it is the agent's own code,
           handed to the page verbatim rather than through a template. */
        const name = String(ask.args.name ?? "");
        const js = String(ask.args.js ?? "");
        const r = await registerInitScript(name, js);
        /*
         * AND IT SAYS WHAT IT ACTUALLY DID.
         *
         * "Runs in every new document from now on" is what this protocol call
         * promises and not what a `<webview>` guest does: measured with the
         * raw protocol, the script runs in the document that is there and is
         * gone after one navigation, reload or Page.navigate alike. The verb
         * answered {"registered": ...} either way, so a caller that navigated
         * was driving a page its setup had never touched.
         */
        return r.ok
          ? {
            ok: true,
            value: {
              registered: name,
              ranNow: true,
              note: "it ran in the page that is open now. A guest does not keep registered scripts "
                + "across a navigation on this shell — register again after `open`, `reload` or a link.",
            },
          }
          : { ok: false, error: r.error || "could not register the init script" };
      }
      case "expose": {
        /* Built as an init script rather than a new mechanism: it defines
           `window[name]` at document-start, on every navigation, so a page
           that calls it in its own first tick still finds it there. The
           calls themselves land in the same buffer `console`/`network`
           already read from — `exposed` is that read. */
        const name = String(ask.args.name ?? "");
        const nameLit = jsLit(name);
        const source = `(() => {
          window.__agxLog = window.__agxLog || {};
          window.__agxLog.exposed = window.__agxLog.exposed || [];
          window[${nameLit}] = (...args) => {
            window.__agxLog.exposed.push({ name: ${nameLit}, args, at: Date.now() });
          };
        })()`;
        const r = await registerInitScript(`__expose_${name}`, source);
        return r.ok
          ? { ok: true, value: { exposed: name } }
          : { ok: false, error: r.error || "could not expose the function" };
      }
      case "exposed": {
        /* Same shape as `console`/`network`: a buffer the page has been
           filling, read since a timestamp so a caller polling twice does not
           see the same call again. */
        const limit = Number(ask.args.limit ?? 100);
        const since = Number(ask.args.since ?? 0);
        const value = await el.executeJavaScript(
          `(() => {
             const buf = (window.__agxLog && window.__agxLog.exposed) || [];
             const rows = buf.filter((r) => !${since} || r.at > ${since}).slice(-${limit});
             return { rows, dropped: Math.max(0, buf.length - rows.length), now: Date.now() };
           })()`,
        );
        return { ok: true, value };
      }
      case "select": {
        /* Set the value AND fire the events a framework listens for — a
           `<select>` whose value changes without `change` leaves Vue and
           React holding the old one, which is the bug this verb exists to
           stop reproducing. */
        const value = jsLit(String(ask.args.value ?? ""));
        const done = await el.executeJavaScript(
          `(() => { const e = document.querySelector(${sel});
             if (!e || e.tagName !== "SELECT") return { ok: false, why: e ? "not a <select>" : "nothing matched" };
             const opts = [...e.options];
             const hit = opts.find((o) => o.value === ${value}) || opts.find((o) => (o.text || "").trim() === ${value});
             if (!hit) return { ok: false, why: "no such option", options: opts.map((o) => o.value).slice(0, 40) };
             e.value = hit.value;
             e.dispatchEvent(new Event("input", { bubbles: true }));
             e.dispatchEvent(new Event("change", { bubbles: true }));
             return { ok: true, value: hit.value, text: (hit.text || "").trim() }; })()`,
        ) as { ok: boolean; why?: string; options?: string[] };
        return done?.ok
          ? { ok: true, value: done }
          : { ok: false, error: `${done?.why ?? "could not select"}${done?.options ? ` — options: ${done.options.join(", ")}` : ""}` };
      }
      case "reload": {
        const hard = ask.args.bypassCache !== false;
        const nav = settled(el);
        if (hard) el.reloadIgnoringCache(); else el.reload();
        await nav;
        return { ok: true, value: { url: el.getURL(), bypassedCache: hard } };
      }
      case "cookies": {
        /* Through the page rather than the session: document.cookie is what
           the page itself sees, which is the thing an agent is reasoning
           about. HttpOnly cookies are invisible here and that is honest —
           they are invisible to the page too. */
        if (ask.args.set) {
          const c = ask.args.set as { name: string; value: string; path?: string; domain?: string };
          await el.executeJavaScript(
            `(() => { document.cookie = ${jsLit(`${c.name}=${c.value}; path=${c.path || "/"}${c.domain ? `; domain=${c.domain}` : ""}`)}; return 1; })()`,
          );
        }
        const value = await el.executeJavaScript(
          `(() => ({ cookies: document.cookie, note: "httpOnly cookies are not visible to the page and so not here" }))()`,
        ) as { cookies: string };
        /* document.cookie can take a write and drop it without a throw — a
           domain that does not match the page, a path outside the current
           one, a session cookie policy. Answering `ok` because the script
           didn't throw was reporting the write, not the result: check the
           jar the same read just brought back before saying so. */
        if (ask.args.set) {
          const c = ask.args.set as { name: string; value: string };
          const landed = value.cookies.split("; ").some((p) => {
            const eq = p.indexOf("=");
            return eq !== -1 && p.slice(0, eq) === c.name && p.slice(eq + 1) === c.value;
          });
          if (!landed) {
            return { ok: false, error: `cookie "${c.name}" was not set — it is not in the page's jar after the write` };
          }
        }
        return { ok: true, value };
      }
      case "frames": {
        const value = await el.executeJavaScript(
          `(() => ({
             frames: [...document.querySelectorAll("iframe,frame")].map((f, i) => ({
               index: i, src: f.getAttribute("src") || "", name: f.getAttribute("name") || "",
               id: f.id || undefined,
               /* Same-origin frames can be read; cross-origin ones cannot, and
                  saying which is which saves an agent from trying. */
               reachable: (() => { try { return !!f.contentDocument; } catch { return false; } })(),
             })),
             workers: (navigator.serviceWorker && navigator.serviceWorker.controller)
               ? [{ scriptURL: navigator.serviceWorker.controller.scriptURL, state: navigator.serviceWorker.controller.state }] : [],
             shadowRoots: [...document.querySelectorAll("*")].filter((e) => e.shadowRoot).length,
           }))()`,
        );
        return { ok: true, value };
      }
      case "observe": {
        /* One round trip instead of six. The collector is injected first in
           case this page has not been through a navigation since it was added
           — it returns immediately when it is already there. */
        const since = Number(ask.args.since ?? 0);
        await el.executeJavaScript(COLLECTOR).catch(() => 0);
        const value = await el.executeJavaScript(observeScript(since, 200)) as Record<string, unknown>;
        if (ask.args.shot === true) {
          /* In the SAME answer. Asking for the picture separately is the
             second call this verb exists to remove. The shell's capture
             first, for the same reason `shot` prefers it: it can photograph a
             pane the window is not showing and the element's cannot. A
             failure here is not a failed observe — the state above is still
             the answer. */
          const shell = await captureFromShell().catch(() => ({ png: null, why: "" }));
          const png = shell.png ?? await el.capturePage().then((i) => i.toDataURL()).catch(() => null);
          if (png) (value as { shot?: string }).shot = png;
          else (value as { shotError?: string }).shotError = shell.why || "the page could not be captured";
        }
        return { ok: true, value };
      }
      case "console":
      case "network": {
        /* Read off a buffer the page has been filling since it loaded — see
           the preload script for why it is collected there and not here.
           Reported as the most expensive gap of the day: a blank SPA with no
           way to see the JS error or the failed request, which leaves trying
           things at random as the only method. */
        const kind = ask.op === "console" ? "console" : "network";
        const limit = Number(ask.args.limit ?? 100);
        const since = Number(ask.args.since ?? 0);
        /*
         * INSTALL IT FIRST, AND SAY SINCE WHEN WE HAVE BEEN LISTENING.
         *
         * This only read the buffer, so a page nobody had collected on
         * answered `{rows: []}` — which an agent reads as "no console errors"
         * and acts on. An empty answer has to be able to mean "nothing
         * happened" and nothing else; "nobody was listening" is a different
         * fact and it was wearing the same clothes.
         *
         * Installing here cannot recover what was said before this call, which
         * is exactly why `listening` comes back with it: an empty answer over
         * a window that started a moment ago is not evidence of a quiet page.
         */
        await el.executeJavaScript(COLLECTOR).catch(() => 0);
        const value = await el.executeJavaScript(
          `(() => {
             const log = window.__agxLog;
             const buf = (log && log.${kind}) || [];
             const rows = buf.filter((r) => !${since} || r.at > ${since}).slice(-${limit});
             return { rows, dropped: Math.max(0, buf.length - rows.length), now: Date.now(),
                      listening: (log && log.startedAt) || 0 };
           })()`,
        );
        return { ok: true, value };
      }
      case "zoom": {
        /*
         * THE BROWSER'S OWN ZOOM, so an agent can match what a person is
         * looking at.
         *
         * "the zoom I do on the web with ctrl + and ctrl - is not the same as
         * the one the agent does" — and it was not: the only zoom an agent
         * could reach was `document.documentElement.style.zoom`, a CSS
         * property that reflows the page and multiplies with whatever the
         * person has set. This is the same call Ctrl+ and Ctrl- make, so
         * `zoom 1.58` and a person's 158% are one number.
         *
         * Read back with no factor, which is how you match a screen rather
         * than guess at it. And the guest is asked rather than the panel's own
         * remembered level: what a capture will show is what the GUEST is at.
         */
        /*
         * The mechanism lives in `applyGuestZoom`, which the person's Ctrl+
         * and Ctrl- now call too — see the note there for why a guest's
         * `setZoomLevel` is set and then ignored, and why this is a device
         * metrics override instead.
         */
        const factorAsked = typeof ask.args.factor === "number" ? ask.args.factor : null;
        /* No factor is a READ: match a screen rather than guess at it. Done as
           a zoom of 1 through the same call, so reading and setting cannot
           disagree about what the page is at. */
        const r = await applyGuestZoom(el, factorAsked ?? 1, cdp);
        if (!r.ok) return r;
        /* The tab is claimed by the agent that sized it — see `reapplyZoom`.
           Only a `zoom` that SET something claims it: reading the zoom back is
           how an agent matches a screen, not a claim on the tab. */
        if (factorAsked !== null) claimAgentZoom(el, factorAsked);
        return { ok: true, value: r.value };
      }
      case "resize": {
        /* A viewport of your own. A modal that covers the column you came to
           look at is not a reason to give up on the capture, and two shots of
           the same page should be the same size when they are going into the
           same GIF. */
        const w = Number(ask.args.width), h = Number(ask.args.height);
        /*
         * THE METRICS, not a lie told to `window.innerWidth`.
         *
         * The comment here said "overriding the device metrics is what a
         * headless driver does" and the code below it redefined two properties
         * on `window`. Scripts that read innerWidth saw the new number and
         * NOTHING ELSE changed: no reflow, no media query, no different
         * screenshot — which for a verb whose whole purpose is "two shots of
         * the same page should be the same size" is the opposite of what it
         * promises.
         */
        /* In the embedder's pixels, like the zoom above: a window at 140%
           divides them again before the page sees them, so 390 asked for came
           out as 279. The page's own dpr with no override is that scale. */
        const scale0 = Number(await el.executeJavaScript(`window.devicePixelRatio`)) || 1;
        const r = await cdp("Emulation.setDeviceMetricsOverride", {
          width: Math.max(1, Math.round(w * scale0)),
          height: Math.max(1, Math.round(h * scale0)),
          deviceScaleFactor: 1,
          mobile: false,
        });
        if (!r.ok) {
          return { ok: false, error: `could not resize the page: ${r.error || "this shell has no DevTools relay"}` };
        }
        /* Measured from the page, because the override can be refused or
           clamped and an agent framing a capture needs the real number. */
        const got = JSON.parse(await el.executeJavaScript(
          `JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`,
        ) as string || "{}") as { w?: number; h?: number };
        return { ok: true, value: { width: got.w ?? w, height: got.h ?? h, asked: { width: w, height: h } } };
      }
      case "text": {
        const value = await el.executeJavaScript(
          `(() => { const e = document.querySelector(${sel});
             return e ? { text: (e.innerText || e.textContent || "").slice(0, ${MAX_TEXT}) } : null; })()`,
        );
        return value
          ? { ok: true, value }
          : { ok: false, error: `nothing on the page matches ${ask.args.selector}` };
      }

      case "scroll": {
        // Answers with where it ended up rather than "done": scrolling to the
        // bottom of a page that was already at the bottom, and scrolling a page
        // that cannot scroll at all, are both invisible from a bare success.
        const move = ask.args.selector !== undefined
          ? `{ const e = document.querySelector(${sel});
               if (!e) return null;
               e.scrollIntoView({ block: "center" }); }`
          : ask.args.to !== undefined
            ? `window.scrollTo({ top: ${ask.args.to === "top" ? "0" : "document.body.scrollHeight"} });`
            : `window.scrollBy({ top: ${Number(ask.args.by)} });`;
        const value = await el.executeJavaScript(
          `(() => { ${move}
             return { y: Math.round(window.scrollY),
                      atBottom: Math.ceil(window.scrollY + window.innerHeight) >= document.body.scrollHeight - 1 }; })()`,
        );
        return value
          ? { ok: true, value }
          : { ok: false, error: `nothing on the page matches ${ask.args.selector}` };
      }

      case "press": {
        const key = String(ask.args.key ?? "");
        /*
         * IN THE PAGE, because the keyboard does not reach a guest.
         *
         * This was two `sendInputEvent` calls, and it answered
         * {"pressed": "Backspace"} while the field kept every character.
         * Measured, with a page that records what it receives: a press
         * produced ZERO key events in the guest — not a keydown that failed to
         * edit, nothing at all.
         *
         * Where they went: an embedded guest is not the widget that has the
         * focus, and Chromium delivers a synthesised key to the focused one.
         * Proved by listening in the app's OWN renderer while a key was sent
         * to the guest's DevTools session — the app got "keydown:Z" and the
         * page got nothing. It is the same for `cdp Input.*`, which is why
         * that one now says so instead of answering {} (see the cdp case).
         *
         * So the events are made where the page can see them, and the EFFECT
         * of an editing key is applied by hand — a synthetic keydown does not
         * move a caret or delete a character, in any browser, by design. A
         * page that calls preventDefault is obeyed: `prevented` says so, and
         * nothing is applied.
         */
        const r = await el.executeJavaScript(`(() => {
          const spec = ${jsLit(key)};
          const parts = spec.split("+");
          const name = parts.pop() || "";
          const mods = parts.map((m) => m.toLowerCase());
          const has = (m) => mods.includes(m);
          const one = name.length === 1;
          const init = {
            key: name === "Space" ? " " : name,
            code: one ? "Key" + name.toUpperCase() : name,
            bubbles: true, cancelable: true, composed: true,
            ctrlKey: has("control") || has("ctrl"), shiftKey: has("shift"),
            altKey: has("alt"), metaKey: has("meta") || has("cmd"),
          };
          const target = document.activeElement || document.body;
          const send = (type) => target.dispatchEvent(new KeyboardEvent(type, init));
          const wentThrough = send("keydown");
          if (one && !init.ctrlKey && !init.metaKey) send("keypress");
          /* An editable field, and where the caret is in it. contentEditable is
             left to the page: rewriting arbitrary rich text by hand is how a
             verb corrupts a document it does not understand. */
          const editable = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
            && !target.disabled && !target.readOnly;
          const fireInput = (type2, data) => target.dispatchEvent(new InputEvent("input", {
            bubbles: true, inputType: type2, data: data === undefined ? null : data,
          }));
          let applied = "none";
          if (wentThrough && editable) {
            const v = target.value;
            let a = target.selectionStart, b = target.selectionEnd;
            if (a === null || b === null) { a = v.length; b = v.length; }
            const put = (next, caret, how, data) => {
              const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const set = Object.getOwnPropertyDescriptor(proto, "value");
              if (set && set.set) set.set.call(target, next); else target.value = next;
              try { target.setSelectionRange(caret, caret); } catch (e2) { /* a type with no caret */ }
              fireInput(how, data);
              applied = "edit";
            };
            if (name === "Backspace") {
              if (a !== b) put(v.slice(0, a) + v.slice(b), a, "deleteContentBackward");
              else if (a > 0) put(v.slice(0, a - 1) + v.slice(a), a - 1, "deleteContentBackward");
              else applied = "nothing to delete";
            } else if (name === "Delete") {
              if (a !== b) put(v.slice(0, a) + v.slice(b), a, "deleteContentForward");
              else if (a < v.length) put(v.slice(0, a) + v.slice(a + 1), a, "deleteContentForward");
              else applied = "nothing to delete";
            } else if (one && !init.ctrlKey && !init.metaKey && !init.altKey) {
              put(v.slice(0, a) + init.key + v.slice(b), a + 1, "insertText", init.key);
            } else if (name === "Space") {
              put(v.slice(0, a) + " " + v.slice(b), a + 1, "insertText", " ");
            } else if ((init.ctrlKey || init.metaKey) && name.toLowerCase() === "a") {
              try { target.setSelectionRange(0, v.length); applied = "select all"; } catch (e2) { /* no caret */ }
            } else if (name === "Home" || name === "End" || name === "ArrowLeft" || name === "ArrowRight") {
              const at = name === "Home" ? 0 : name === "End" ? v.length
                : name === "ArrowLeft" ? Math.max(0, a - 1) : Math.min(v.length, b + 1);
              try { target.setSelectionRange(at, at); applied = "caret"; } catch (e2) { /* no caret */ }
            }
          }
          if (wentThrough && name === "Enter" && applied === "none") {
            /* A single-line field in a form submits; a textarea takes a newline.
               A page that handles Enter itself already saw the keydown above. */
            if (editable && target.tagName === "TEXTAREA") {
              const v2 = target.value, a2 = target.selectionStart ?? v2.length;
              const proto = HTMLTextAreaElement.prototype;
              const set = Object.getOwnPropertyDescriptor(proto, "value");
              const next = v2.slice(0, a2) + String.fromCharCode(10) + v2.slice(target.selectionEnd ?? a2);
              if (set && set.set) set.set.call(target, next); else target.value = next;
              try { target.setSelectionRange(a2 + 1, a2 + 1); } catch (e2) { /* no caret */ }
              fireInput("insertLineBreak");
              applied = "newline";
            } else if (target && target.form) {
              if (target.form.requestSubmit) target.form.requestSubmit(); else target.form.submit();
              applied = "submit";
            }
          }
          /* The keys that move a PAGE rather than a caret. A synthetic keydown
             scrolls nothing, and half the keys this verb accepts — PageUp,
             PageDown, Home, End, the arrows — are scroll keys on a page with
             no field in focus. The page's own handler already saw the keydown
             above; this is only what the browser itself would have done. */
          if (wentThrough && applied === "none" && !editable) {
            const page = window.innerHeight * 0.9;
            const by = name === "PageDown" ? page : name === "PageUp" ? -page
              : name === "ArrowDown" ? 60 : name === "ArrowUp" ? -60 : 0;
            if (by !== 0) { window.scrollBy(0, by); applied = "scroll"; }
            else if (name === "Home" || name === "End") {
              window.scrollTo(0, name === "Home" ? 0 : document.body.scrollHeight);
              applied = "scroll";
            }
          }
          if (wentThrough && name === "Tab") {
            const all = [...document.querySelectorAll(
              'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            )].filter((n) => n.offsetParent !== null || n === target);
            const i = all.indexOf(target);
            const next = all[(i + (init.shiftKey ? -1 : 1) + all.length) % (all.length || 1)];
            if (next && next.focus) { next.focus(); applied = "focus"; }
          }
          send("keyup");
          return {
            kind: "ok", applied, prevented: !wentThrough,
            on: (target.id ? "#" + target.id : (target.tagName || "").toLowerCase()),
          };
        })()`) as { kind: string; applied?: string; prevented?: boolean; on?: string };
        // Enter and the like commonly navigate. Waiting on a navigation that
        // never comes would cost forty seconds a keystroke, so this gives the
        // page a beat and reports where it is, rather than promising either way.
        await new Promise((r2) => setTimeout(r2, 250));
        return {
          ok: true,
          value: {
            pressed: key, on: r?.on, applied: r?.applied, prevented: !!r?.prevented,
            url: el.getURL(), title: el.getTitle(),
          },
        };
      }

      case "shot": {
        /* What the picture should CONTAIN, resolved before any capture is
           attempted — cropping a frame after the fact is the ImageMagick step
           this verb exists to remove. `--selector` is the easy path: it costs
           one round trip to turn a node into the same rectangle `--clip` would
           have needed spelled out by hand. */
        let clip: ShotClip | undefined = ask.args.clip as ShotClip | undefined;
        if (typeof ask.args.selector === "string") {
          const r = await el.executeJavaScript(elementRectScript(sel)) as
            { kind: string; rect?: ShotClip; count?: number; samples?: string[]; message?: string };
          if (r.kind !== "ok") return { ok: false, error: selectorError(String(ask.args.selector), r) };
          if (!r.rect || r.rect.width < 1 || r.rect.height < 1) {
            return { ok: false, error: `${ask.args.selector} has no visible size to capture` };
          }
          clip = r.rect;
        }
        /* No full-page. `captureBeyondViewport` paints the page in strips and
           repaints anything `position: fixed` in EVERY strip, so a page with a
           sticky header came back with the navigation bar repeated down the
           middle. Four attempts failed. A capture that duplicates content is
           evidence that is simply wrong, and an agent cannot see the picture
           it is holding to notice.

           What replaces it: make the viewport bigger and take a visible shot.
           `resize` and `emulate` both do that, the result is correct at any
           size, and the caller chooses the framing. */
        const fullPage = false;
        /*
         * THE VIEWPORT, SPELLED OUT — because "capture whatever is showing" is
         * the one request that fails.
         *
         * Measured against a real page today: `shot --clip 0,0,w,h` produced
         * pixels 10 times out of 10 and plain `shot` produced none, on the
         * same page, in the same second. The difference is that a capture with
         * no rectangle asks the compositor for the frame it is currently
         * painting, and a panel that is not on screen is painting nothing; a
         * capture WITH one is served from the debugger instead, which does not
         * care whether anybody is looking.
         *
         * An agent driving this is exactly the caller whose panel is not on
         * screen, so the working route is made the default rather than left as
         * a workaround somebody has to be told about. `--full-page` keeps its
         * own path: its whole point is to go beyond the viewport.
         */
        /*
         * A PLAIN SHOT IS WHAT IS ON SCREEN — measured, not argued.
         *
         * This block used to manufacture a clip out of the document's scroll
         * size for every plain `shot`, and the clip brought a metrics override
         * with it. Both fight the person's browser zoom, and the result was a
         * capture of the TOP-LEFT CORNER of the page: at 158% only 1/1.58 of
         * the width and the height survive, about 40% of the area.
         *
         * It hid behind a bad probe for a while. A page with a label in each
         * corner comes back with all four even when it is cropped, because
         * `position: fixed` follows the frame. What shows it is a grid drawn in
         * PAGE coordinates: the page draws a line every tenth of its width, the
         * person sees nine of them, and the capture fitted six.
         *
         * Measured against this Chromium, same page, same second, at
         * `1678x1069 css, devicePixelRatio 1.9718`:
         *
         *   {format:"png"}                                  3310x2108, 10.0 gaps across
         *   {..., clip w1678 h1069 scale 1}                  1678x1069,  6.3 gaps  (what shipped)
         *   {..., clip w1678 h1069 scale 1.9718}             1064x 678,  crops harder
         *
         * The first is the viewport, whole, at the resolution the screen draws
         * it with. So a plain shot asks for nothing: no clip, no override.
         *
         * What this gives up is the old behaviour of capturing the whole
         * DOCUMENT on a plain shot. That was standing in for `--full-page`,
         * which was deleted over `captureBeyondViewport` repeating the page
         * into the frame — and it was delivering a crop, so it was not
         * delivering the whole document either.
         */
        /* `--highlight e17 --label "still Online"` — drawn into the page
           itself, before the capture, so every route below photographs it the
           same way it photographs the rest of the page. Cleared in `finally`:
           a capture that throws must not leave the marker on a page somebody
           is still looking at. */
        /* The page's own pixel ratio, asked of the page. The obvious arithmetic
           — the guest's zoom times the display's scale factor — answers 1 on a
           desktop scaled to 1.25, because on Wayland `scaleFactor` is 1 whatever
           the desktop is set to. This is the number that turns a css rectangle
           into pixels of the capture. */
        const dpr = Number(await el.executeJavaScript("window.devicePixelRatio").catch(() => 1)) || 1;

        const highlightSel = typeof ask.args.highlight === "string" ? ask.args.highlight : null;
        if (highlightSel) {
          const label = typeof ask.args.label === "string" ? ask.args.label : undefined;
          const hi = await el.executeJavaScript(highlightScript(jsLit(highlightSel), label)) as
            { kind: string; count?: number; samples?: string[]; message?: string };
          if (hi.kind !== "ok") return { ok: false, error: selectorError(highlightSel, hi) };
        }
        try {
          // The shell first: its capture can ask for a frame of a pane the window
          // is not showing, and the element's cannot — it hangs or comes back
          // blank instead, which is precisely the case an agent is in. The element
          // stays as the fallback for a shell too old to have been asked.
          // Both halves raced against the clock, for the same reason: a capture of
          // a pane that is painting nothing does not fail, it waits — and a verb
          // that waits until the server gives up tells an agent the browser is
          // broken rather than that the pane is not showing.
          /* Longer than the shell's own budget for all of its routes, and short
             enough that the element's own attempt still fits before the relay
             hangs up at twenty. Five cut off captures that were going to succeed,
             which is the worst way to spend a timeout. */
          /*
           * THE DEBUGGER FIRST, because it is the only route that does not
           * depend on somebody looking.
           *
           * Measured today against a real page: a clip of 800x600 produced
           * pixels and 1200x800 produced none, same page, same second. The
           * limit is not the page — it is how much of the PANEL is painted.
           * A compositor can only hand over the frame it is drawing, and a
           * browser pane that is small, behind another view, or off screen is
           * drawing that much and no more.
           *
           * An agent is always that caller. `Page.captureScreenshot` with
           * `captureBeyondViewport` renders into an offscreen surface instead,
           * which is what §12's report asked for in as many words: "capture
           * against an offscreen surface so it does not depend on the pane
           * being painted".
           *
           * The compositor routes below are kept as the fallback, for a shell
           * with no debugger relay — and because when the pane IS on screen
           * they are faster.
           */
          /*
           * ONE PIXEL PER CSS PIXEL, whatever screen this is running on.
           *
           * `clip.scale: 1` does NOT mean that on its own: CDP multiplies it by
           * the device's scale factor, so one clip of 2014x1283 came back as a
           * 2518x1604 PNG on this desktop and would come back another size on
           * the next. Evidence whose dimensions depend on whose laptop took it
           * is worse than useless when a before and an after are compared side
           * by side. Pinning the viewport at 1x fixes the size for everyone.
           *
           * THERE IS NO `--scale`. It existed for an hour and produced four
           * copies of the same page in one image, twice, in two different
           * arrangements: a rectangle larger than the viewport is filled by
           * `captureBeyondViewport` REPEATING the page, and that is true
           * whether the magnification is asked for in the metrics or in the
           * clip. It is the defect that got `--full-page` deleted, and the
           * reason it matters more than a crash is that the agent holding the
           * duplicated picture cannot see that it is wrong.
           *
           * What it was for — a sharper picture — was never worth that. A
           * capture at one pixel per css pixel is already exactly what the page
           * lays out.
           */
          /*
           * `deviceScaleFactor: 1` IS WHERE HALF THE PIXELS WENT.
           *
           * The override decides how many device pixels the page is drawn
           * with, and this pinned it at one per css pixel. On a desktop scaled
           * to 1.25 at 158% browser zoom — 1.9718 device pixels per css pixel
           * — a pane the screen draws with 3310x2108 came back as 1678x1069.
           * Nothing was cropped; a page carrying a label in each corner comes
           * back with all four. It was half the resolution, and text at half
           * resolution reads as a different picture, which is exactly how it
           * was reported, twice: "the capture is nowhere near like mine… it
           * looks shifted, as if it had more zoom".
           *
           * Asked of the PAGE. The obvious arithmetic — the guest's zoom times
           * the display's scale factor — answers 1 on this machine, because on
           * Wayland `scaleFactor` is 1 whatever the desktop is scaled to.
           * `devicePixelRatio` is the number, and it is one round trip.
           */
          /*
           * NO METRICS OVERRIDE, FOR ANY SHOT.
           *
           * It was here to make the viewport the size of the rectangle, and it
           * re-lays the page out to do it — so every coordinate measured before
           * it points somewhere else. Measured: a crop of a 90x42 element came
           * back the right SIZE (191x89, which is that element at this screen's
           * 2.125) and completely blank.
           *
           * The rectangle is taken out of the pixels instead — see `cropPng`.
           * What the page is doing while it is photographed is now exactly what
           * the person is looking at, which is the only version of this that
           * can be checked by looking.
           */
          const density = (() => {
            const d = Number(dpr);
            return Number.isFinite(d) ? Math.max(1, Math.min(4, d)) : 1;
          })();
          /*
           * A PLAIN SHOT, AT THE RESOLUTION THE SCREEN HAS.
           *
           * Measured, with a page carrying a label in each corner: this route
           * returns the viewport WHOLE — all four labels are in the file — but
           * at one pixel per css pixel. On a 1.25x display at 158% zoom that is
           * 1678x1069 for a pane the screen draws with 3309x2108, and a capture
           * meant as evidence of what somebody is looking at should be what
           * they are looking at. Reported exactly that way, twice.
           *
           * `scale` is the whole of the fix: the clip stays in css pixels, so
           * the AREA is the visible viewport either way, and the scale decides
           * how many pixels that area is drawn with.
           *
           * And `captureBeyondViewport` goes OFF when it is used. That flag is
           * what makes a rectangle larger than the viewport get filled by
           * REPEATING the page — the defect that got `--full-page` deleted —
           * and the guard against it is not to refuse the resolution but to
           * ask for an area that is exactly what is already on screen, which
           * has nothing to grow into.
           */
          /*
           * `captureBeyondViewport` IS WHAT WAS THROWING AWAY HALF THE PIXELS.
           *
           * Measured against this Chromium, three ways, on a pane whose page
           * reports `1678x1069` css at `devicePixelRatio 1.9718`:
           *
           *     {format:"png"}                                 -> 3310 x 2108
           *     {format:"png", captureBeyondViewport:true}      -> 1678 x 1069
           *     {..., clip:{...w:1678,h:1069,scale:1.97}}       -> 1064 x  678
           *
           * The first is the screen's own resolution and is what a capture
           * meant as evidence should be. The second is what this sent, and the
           * reason two people in a row reported the same thing: "the capture is
           * nowhere near like mine… it looks shifted, as if it had more
           * zoom". Nothing was ever cropped — a page carrying a label in each
           * corner comes back with all four — it was half the resolution, and
           * text at half resolution reads as a different picture.
           *
           * The flag stays for a clip, which is the case it exists for: a
           * rectangle that may reach past what is on screen. Without one there
           * is nothing to reach for, and asking for it costs the pixels.
           */
          /*
           * ON A LEASH, because this one does not fail — it never returns.
           *
           * `Page.captureScreenshot` through the debugger answers in half a
           * second on a tab that is in front, and on a tab that is NOT it waits
           * for a frame the renderer is not producing. Nothing bounded it, so
           * the ask sat until the relay gave up on its own: measured against a
           * real app, four times, 61.37 / 61.42 / 61.36 / 61.38 seconds and no
           * file — while `record --frames 1` on the same tab in the same second
           * answered in 1.1.
           *
           * Three seconds is well past a healthy answer and well short of
           * useless. Past it, the shell route below takes over — and that one
           * exists precisely for a pane the window is not showing: it renders
           * off-screen instead of copying a surface nobody is painting.
           */
          /*
           * NOT RACED HERE. The deadline belongs with the command, in the shell
           * — see CDP_DEADLINE_MS in electron/main.js.
           *
           * Racing it from this side was measured to be worse than the hang it
           * replaced: abandoning the promise leaves the capture outstanding in
           * the debugger session, and from then on that tab answers nothing.
           * "One `newtab` is enough for that tab to never be capturable
           * again." A timeout that poisons what it was protecting is not a
           * timeout.
           */
          const viaCdp = await cdp("Page.captureScreenshot", { format: "png" })
            .catch(() => ({ ok: false })) as { ok: boolean; result?: { data?: string } };
          if (viaCdp.ok && viaCdp.result?.data) {
            const whole = `data:image/png;base64,${viaCdp.result.data}`;
            const png = clip ? await cropPng(whole, clip, density).catch(() => whole) : whole;
            if (highlightSel) await el.executeJavaScript(REMOVE_HIGHLIGHT_SCRIPT).catch(() => {});
            return {
              ok: true,
              value: {
                url: el.getURL(), title: el.getTitle(), png, via: "the debugger",
              },
            };
          }
          const askShell = () => Promise.race([
            /* No clip: the rectangle is taken out of the pixels here, once,
               whichever route produced them. */
            captureFromShell({ fullPage }),
            new Promise<{ png: string | null; why: string; via?: string; cut?: boolean }>((r) => setTimeout(() => r({ png: null, why: "the shell did not answer in time" }), 12_000)),
          ]);
          let fromShell = await askShell();
          /* A guest whose frame sink is gone answers the same way forever, so it
             is worth acting on rather than reporting — but resizing the element to
             make Chromium allocate a new one does NOT bring it back: MEASURED,
             the second ask got the same UnknownVizError. What it did cost was the
             whole budget twice over. So this is one ask, and the revive is kept
             for the case it does help: a guest that has never been laid out.  */
          if (!fromShell.png && /never been shown|no frame sink/i.test(fromShell.why)) {
            await revive();
            const second = await askShell();
            if (second.png) fromShell = { ...second, via: `${second.via ?? "shell"} after a resize` };
          }
          /* The element's own capture is the last resort, and its FAILURE must
             not become the answer: it throws `UnknownVizError` on a guest whose
             frame sink is broken, and that exception used to escape as the whole
             verb's error — hiding everything the shell had already found out.
             It also cannot do `fullPage`: cropping beyond the current viewport
             needs the debugger route inside the shell, which is exactly what
             this fallback is for when the shell itself is unreachable — so a
             fallback full-page shot is the viewport instead of a failure. */
          const whole = fromShell.png ?? await Promise.race([
            el.capturePage().then((i) => i.toDataURL()).catch(() => ""),
            /* Short: this one only runs after the shell has spent its budget
               failing twice over, and a guest that can answer answers at once. */
            new Promise<string>((r) => setTimeout(() => r(""), 2000)),
          ]);
          // An empty capture is a data URL with nothing after the comma, and it
          // used to be returned as a success: the CLI then wrote a zero-byte PNG
          // and said where it had put it. Measured, twice, and it is the worst
          // shape of failure here — an agent reports on a screenshot that does not
          // exist. A pane hidden behind another view produces no frames at all,
          // so say that, in the words the caller can act on.
          const png = whole && clip ? await cropPng(whole, clip, density).catch(() => whole) : whole;
          const payload = png.slice(png.indexOf(",") + 1);
          if (!payload) {
            /* The shell's own reason when it has one. "The pane is not on screen"
               was reported for every failure, including the one where the pane is
               perfectly visible and the INSPECTOR has the debugger — which sent
               everybody looking in the wrong place, twice. */
            return { ok: false, error: fromShell.why || "the browser pane is not on screen, so there was no frame to capture" };
          }
          // `via` is diagnosis, not decoration: the routes to a frame differ in
          // what they can survive, and knowing which one produced this picture is
          // the difference between fixing the next failure and guessing at it.
          return {
            ok: true,
            value: {
              url: el.getURL(), title: el.getTitle(), png,
              via: fromShell.via ?? (fromShell.png ? "shell" : "the element itself"),
              // Chromium refuses a capture past 16384px: a `--full-page` shot
              // on a page taller than that comes back cropped rather than not
              // at all, and this is how the caller finds out rather than
              // trusting a picture that quietly stops partway down the page.
              ...(fullPage && fromShell.cut ? { cut: true } : {}),
            },
          };
        } finally {
          if (highlightSel) await el.executeJavaScript(REMOVE_HIGHLIGHT_SCRIPT).catch(() => {});
        }
      }

      case "trace": {
        const which = String(ask.args.action ?? "start");
        if (which === "start") {
          const r = await cdp("Tracing.start", {
            /*
             * AS A STREAM, not as events.
             *
             * A trace of a few seconds is thousands of `Tracing.dataCollected`
             * messages and megabytes of JSON. The shell's event buffer is
             * CAPPED — it has to be, or a page logging in a loop would push a
             * debugger pause out before anyone read it — so collecting a trace
             * through it would silently keep the last N chunks of a file that
             * only means anything whole. One handle and an `IO.read` loop is
             * the shape this data has.
             */
            transferMode: "ReturnAsStream",
            traceConfig: {
              recordMode: "recordAsMuchAsPossible",
              includedCategories: [
                "blink", "blink.console", "blink.net",
                "devtools.timeline", "disabled-by-default-devtools.timeline",
                "disabled-by-default-devtools.timeline.frame", "toplevel",
                "disabled-by-default-network", "disabled-by-default-memory",
              ],
            },
          });
          if (!r.ok) return { ok: false, error: r.error || "could not start tracing" };
          return { ok: true, value: { tracing: "recording" } };
        }
        if (which === "stop") {
          const r = await cdp("Tracing.end", {}) as { ok: boolean; error?: string };
          if (!r.ok) return { ok: false, error: r.error || "could not end tracing" };
          return { ok: true, value: { tracing: "stopped" } };
        }
        return { ok: false, error: 'trace action must be "start" or "stop"' };
      }

      default:
        return { ok: false, error: `unknown operation` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
