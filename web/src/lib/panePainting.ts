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

/**
 * Run something with the guest's pane painting, then put the pane back exactly
 * as it was.
 *
 * A no-op when the pane is already on screen, which is the common case for a
 * person clicking the camera themselves — there is nothing to warm up and no
 * reason to pay 300ms for it.
 */
export async function whilePainting<T>(
  el: Element | null,
  run: () => Promise<T>,
  /** Injected so a test can assert the order without a real browser. */
  deps: {
    hiddenNow?: (pane: HTMLElement) => boolean;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
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
      if (n.style && hiddenNow(n)) chain.push(n);
    }
    if (hiddenNow(pane)) chain.push(pane);
  }
  if (!chain.length) return run();

  const was = chain.map((n) => ({
    node: n,
    visibility: n.style.visibility,
    opacity: n.style.opacity,
    pointerEvents: n.style.pointerEvents,
  }));
  for (const n of chain) {
    n.style.visibility = "visible";
    n.style.opacity = "0";
    n.style.pointerEvents = "none";
  }
  try {
    await wait(WARMUP_MS);
    return await run();
  } finally {
    // Unconditionally, and by assignment rather than by removal: these three
    // are the properties ViewBox and this function share, and leaving anything
    // painting would cost a page's compositing for as long as the app is open.
    for (const w of was) {
      w.node.style.visibility = w.visibility;
      w.node.style.opacity = w.opacity;
      w.node.style.pointerEvents = w.pointerEvents;
    }
  }
}
