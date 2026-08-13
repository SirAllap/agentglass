// Finding a word inside a rendered document.
//
// The browser's own Ctrl+F cannot reach this: the viewer is a fixed panel over
// the app, so the page's find bar searches everything BEHIND it too — the
// terminal, the board, the notifications — and walks you through matches in
// text you cannot see. A twelve-section status report is exactly the document
// where "where does it say SPI" is the first thing you ask, and the answer was
// to scroll.
//
// Highlighted through the CSS Custom Highlight API rather than by wrapping
// matches in <mark>. That matters here specifically: this text is React's
// output, and mutating it would be undone on the next render and would fight
// the renderer for ownership of the same nodes. Highlights live beside the DOM
// — ranges held by the browser, painted by ::highlight() — so the document is
// never touched and clearing them is one call.

/** The two registries: everything found, and the one you are standing on. */
export const ALL = "agx-md-find";
export const CURRENT = "agx-md-find-on";

type HighlightCtor = new (...ranges: Range[]) => unknown;
type HighlightRegistry = { set(k: string, v: unknown): void; delete(k: string): void };
const registry = (): HighlightRegistry | null =>
  (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights ?? null;

/** Whether this engine can paint highlights at all. Chromium 105+, so every
 *  Electron this ships in — but a bare `CSS.highlights` read in a test
 *  environment or an older webview would throw rather than degrade. */
export const canHighlight = (): boolean => !!registry()
  && typeof (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight === "function";

/**
 * Where a needle occurs in a haystack, case-insensitively and without overlap.
 *
 * Split out from the DOM walk below and exported, because this is where the
 * decisions are: what counts as a match, and that "aa" in "aaaa" is two
 * matches rather than three. The walk around it is plumbing — concatenate,
 * search, map back — and this is the half worth pinning down in a test, in a
 * runner with no DOM to walk.
 */
export function matchOffsets(haystack: string, needle: string): number[] {
  const want = needle.toLowerCase();
  if (!want) return [];
  const hay = haystack.toLowerCase();
  const out: number[] = [];
  // `i + want.length`, not `i + 1`: matches must not overlap, or the same run
  // of text is highlighted twice and the count on the bar is wrong.
  for (let i = hay.indexOf(want); i !== -1; i = hay.indexOf(want, i + want.length)) out.push(i);
  return out;
}

/**
 * Every occurrence of `needle` under `root`, as ranges.
 *
 * The text of every node is concatenated first and searched as one string,
 * rather than each node being searched on its own. Markdown is full of inline
 * elements — `**bold**`, a code span, a link — and a per-node search cannot see
 * a phrase that crosses one of them, so searching "risk monitoring" in
 * "risk **monitoring**" would answer "not found" about a document with it in
 * the title.
 *
 * Case-insensitive, because nobody types the capitalisation of a heading they
 * are trying to find.
 */
/**
 * Whether text under this element is on screen at all.
 *
 * A viewer of prose did not need this — everything in it is visible by
 * construction. A find that walks a whole view does: an app screen is full of
 * text nobody can see, and a match in a closed menu is a match the user is sent
 * to and cannot find. Measured on this app's own markup, the four sources are a
 * `display:none` block, a `hidden` attribute, a screen-reader-only span, and
 * xterm's accessibility layer — a full copy of the terminal's buffer, in the
 * DOM, invisible.
 *
 * `checkVisibility` when the engine has it (Chromium 125+, so every Electron
 * this ships in) because it is the one call that answers the whole question;
 * `offsetParent` as the fallback, which catches `display:none` and nothing
 * else. Deliberately NOT `getBoundingClientRect`: an element scrolled out of
 * view is still findable — that is what scrolling to a match is for — and a
 * rect test would rule it out.
 */
type Visible = Element & { checkVisibility?: (o?: { visibilityProperty?: boolean; contentVisibilityAuto?: boolean }) => boolean };
function shows(el: Element | null): boolean {
  if (!el) return false;
  const e = el as Visible;
  if (typeof e.checkVisibility === "function") {
    return e.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
  }
  return !!(el as HTMLElement).offsetParent || el === document.body;
}

/** xterm keeps a copy of the buffer in the DOM for screen readers, and it is
 *  the one place where "invisible text" is a whole terminal's worth. Its own
 *  search addon owns finding in there. */
const SKIP = ".xterm, [aria-hidden='true'], [hidden]";

export function findRanges(root: Node | null, needle: string): Range[] {
  const want = needle.toLowerCase();
  if (!root || !want) return [];

  const seen = new Map<Element, boolean>();
  const visible = (el: Element | null): boolean => {
    if (!el) return false;
    const had = seen.get(el);
    if (had !== undefined) return had;
    // Walk up to the root, remembering the answer for every element on the way:
    // a paragraph of forty text nodes asks about the same three ancestors.
    const ok = !el.closest(SKIP) && shows(el);
    seen.set(el, ok);
    return ok;
  };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && visible(n.parentElement)
      ? NodeFilter.FILTER_ACCEPT
      : NodeFilter.FILTER_REJECT),
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let all = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.data) continue;
    starts.push(all.length);
    nodes.push(t);
    all += t.data;
  }
  if (!nodes.length) return [];

  // Which node holds an absolute offset. Binary search rather than a scan: a
  // long document has thousands of text nodes and this runs per match.
  const at = (off: number): number => {
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  const out: Range[] = [];
  for (const i of matchOffsets(all, want)) {
    const s = at(i);
    const e = at(i + want.length - 1);
    const r = document.createRange();
    try {
      r.setStart(nodes[s]!, i - starts[s]!);
      r.setEnd(nodes[e]!, i + want.length - starts[e]!);
      out.push(r);
    } catch { /* a node that moved between the walk and here — skip it */ }
  }
  return out;
}

/** Paint them: all of the matches, and the current one on top. */
export function paint(ranges: Range[], current: number): void {
  const reg = registry();
  const H = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  if (!reg || typeof H !== "function") return;
  if (!ranges.length) { clear(); return; }
  reg.set(ALL, new H(...ranges));
  const on = ranges[current];
  if (on) reg.set(CURRENT, new H(on));
  else reg.delete(CURRENT);
}

/** Take them down. Called on close and on unmount — a highlight registry is
 *  global, so a viewer that forgot would leave its marks on the next document. */
export function clear(): void {
  const reg = registry();
  if (!reg) return;
  reg.delete(ALL);
  reg.delete(CURRENT);
}

/** Step through them, wrapping at both ends — the way every find bar does, so
 *  holding Enter walks the document rather than stopping at the last hit. */
export const step = (i: number, total: number, dir: 1 | -1): number =>
  total <= 0 ? 0 : (i + dir + total) % total;

/** Bring a match into view. The range itself has no `scrollIntoView`, so the
 *  element that holds it is asked — `center`, because a match landing one line
 *  under the find bar reads as "not found". */
export function reveal(r: Range | undefined): void {
  if (!r) return;
  const node = r.startContainer;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
}
