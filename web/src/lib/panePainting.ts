/*
 * Making a hidden pane paint, for exactly as long as a screenshot takes.
 *
 * The workspace keeps every visited view mounted and hides the inactive ones
 * with `visibility: hidden` (see ViewBox). For a `<webview>` that is not a
 * cosmetic detail: Chromium propagates the element's visibility to the guest,
 * a hidden page is throttled to no frames at all, and a capture then has
 * nothing to copy — the compositor answers `UnknownVizError` and the debugger's
 * `Page.captureScreenshot` never answers. MEASURED, on this app, three builds
 * running:
 *
 *   compositor  ->  UnknownVizError, twice, 250ms apart
 *   debugger, from the frame / own viewport / off-screen  ->  no answer at all
 *
 * The fix is not to show the browser — an agent taking a screenshot must not
 * take the screen off the person, which is where this whole thread started. It
 * is to make the pane paint while staying invisible: `visibility: visible` with
 * `opacity: 0` and no pointer events. The guest starts producing frames, the
 * capture gets one, and the pane goes back to hidden. Nothing appears, nothing
 * moves, and no click lands anywhere new.
 */

/** How long Chromium needs after being told to paint before there is a frame to
 *  copy. Two animation frames is not enough — the guest is a separate process
 *  and has to be told, schedule, draw and hand over. */
const WARMUP_MS = 300;

/** The pane a guest lives in, if it is one of the workspace's stacked views. */
export function paneOf(el: Element | null): HTMLElement | null {
  if (!el || typeof (el as Element).closest !== "function") return null;
  return el.closest("[data-agx-viewbox]") as HTMLElement | null;
}

/** Injected so a test can assert the order without a real browser. */
type PaintDeps = {
  hiddenNow?: (pane: HTMLElement) => boolean;
  wait?: (ms: number) => Promise<void>;
};

/**
 * Run something with the guest's pane painting, then put the pane back exactly
 * as it was.
 *
 * A no-op when the pane is already on screen, which is the common case for a
 * person clicking the camera themselves — there is nothing to warm up and no
 * reason to pay 300ms for it.
 */
export async function whilePainting<T>(el: Element | null, run: () => Promise<T>, deps: PaintDeps = {}): Promise<T> {
  const restore = await light(el, deps);
  try {
    return await run();
  } finally {
    restore();
  }
}

/*
 * TRUSTED INPUT NEEDS A PAINTING PANE TOO, not only a screenshot.
 *
 * `sendInputEvent` on a guest whose pane is `visibility: hidden` is dropped
 * before the page: no pointerdown, no keydown, nothing in a capture listener on
 * the document, and the DevTools `Input.dispatchKeyEvent` was dropped the same
 * way. Measured on an isolated build of the app with the terminal in front:
 * `click` and `type` answered `trusted: true, confirmed: false` and the page
 * logged nothing. Lit like a screenshot's pane (visible, opacity 0, no pointer
 * events) the same events arrived, trusted; lit or not, being BEHIND another
 * tab did not matter. And they are dropped, not held: lighting the pane later
 * did not deliver the earlier ones.
 *
 * So a verb lights the pane the first time it sends input, and only then — a
 * `read` or an act that falls back to the script path pays nothing — and keeps
 * it lit until the verb has answered, because the page confirms what it got
 * after the send and a pane put out mid-act would drop the rest of a `fill`.
 */
export function paintOnDemand(el: Element | null, deps: PaintDeps = {}) {
  let on: Promise<() => void> | null = null;
  return {
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
      await (on ??= light(el, deps));
      return fn();
    },
    release: async (): Promise<void> => {
      if (on) (await on)();
    },
  };
}

/** What this module has lit, how many are holding it, and what it was. */
const lit = new Map<HTMLElement, { count: number; visibility: string; opacity: string; pointerEvents: string }>();

/** Lights every hidden step from `el` up to its pane, waits for a frame, and
 *  answers how to put them back. Nothing hidden: nothing lit, no wait. */
async function light(el: Element | null, deps: PaintDeps): Promise<() => void> {
  /*
   * EVERY HIDDEN ANCESTOR, not just the view.
   *
   * This unhid the pane — `[data-agx-viewbox]`, the workspace's container — and
   * that was the whole story when a pane held one guest. It holds one per TAB
   * now, and a tab that is not the active one carries its own
   * `visibility: hidden`. So for a background tab the view came up and the tab
   * stayed dark: the guest never composited, no frame sink was ever allocated,
   * and every capture route failed in turn.
   *
   * Measured by somebody using it, one tab, four steps: fresh and in front,
   * 0.648s and a file; sent to the background, 19.70s and nothing; brought back
   * to the front, 19.86s and nothing; reloaded in front, 15.32s and
   * `UnknownVizError`. Two runs, identical to a tenth. The tell is that
   * bringing it forward did not fix it — a surface is not reallocated by
   * turning the lights back on.
   *
   * So the whole chain from the guest up to the pane is lit, and every step of
   * it is put back afterwards. A no-op when nothing on the way is hidden, which
   * is the common case for a person pressing the camera themselves.
   */
  const chain: HTMLElement[] = [];
  const pane = paneOf(el);
  const hiddenNow = deps.hiddenNow ?? ((p: HTMLElement) => {
    // The inline style is what ViewBox sets, and reading it costs no layout.
    // `getComputedStyle` is the fallback for a pane hidden by a class instead.
    if (p.style.visibility === "hidden") return true;
    return typeof getComputedStyle === "function" && getComputedStyle(p).visibility === "hidden";
  });
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (pane) {
    /* From the guest up to the pane, then the pane itself — reached by the walk
       or added on its own. A caller may hand us an element with no parent chain
       to follow (a test double, a guest not in the document yet), and the pane
       is the one that has always had to be lit. */
    for (let n: HTMLElement | null = el as HTMLElement | null; n && n !== pane; n = n.parentElement) {
      if (n.style && (lit.has(n) || hiddenNow(n))) chain.push(n);
    }
    if (lit.has(pane) || hiddenNow(pane)) chain.push(pane);
  }
  if (!chain.length) return () => {};

  let fresh = false;
  for (const n of chain) {
    const held = lit.get(n);
    if (held) { held.count++; continue; }
    lit.set(n, { count: 1, visibility: n.style.visibility, opacity: n.style.opacity, pointerEvents: n.style.pointerEvents });
    n.style.visibility = "visible";
    n.style.opacity = "0";
    n.style.pointerEvents = "none";
    fresh = true;
  }
  // By assignment rather than by removal: these three are the properties
  // ViewBox and this function share, and leaving anything painting would cost
  // a page's compositing for as long as the app is open. Only what still holds
  // our value: a verb keeps the pane lit while it runs, and React may restyle a
  // tab meanwhile (one an agent starts driving loses its `visibility`) — writing
  // the old value over that left the tab hidden after it came to the front.
  // Last one out: two agents' verbs on two tabs share the pane, and the first
  // to answer used to put it out under the other's keys.
  const restore = () => {
    for (const n of chain) {
      const w = lit.get(n);
      if (!w || --w.count > 0) continue;
      lit.delete(n);
      const st = n.style;
      if (st.visibility === "visible") st.visibility = w.visibility;
      if (st.opacity === "0") st.opacity = w.opacity;
      if (st.pointerEvents === "none") st.pointerEvents = w.pointerEvents;
    }
  };
  if (!fresh) return restore;
  try {
    await wait(WARMUP_MS);
  } catch (err) {
    restore();
    throw err;
  }
  return restore;
}
