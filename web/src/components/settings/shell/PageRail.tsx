import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { SHELL_RAIL_MIN, SHELL_SIZE, activeSection, afterQuiet, releaseOrphanRowPin, type SectionMeta } from "./shellRules.ts";
import { LAYER } from "../../../lib/layers.ts";

/** The element that actually scrolls: the page is not its own scroller any more (one scroll box per modal). */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === "auto" || o === "scroll") return n;
  }
  return null;
}

/**
 * The sticky `top`, in the element's own CSS px, from two rects read in the same (zoomed) space: the
 * element at rest and the top of the content that scrolls with it. Both move together on scroll, so
 * the result does not depend on where the page is scrolled to.
 */
export function restingTop(elTop: number, contentTop: number, zoom: number | undefined): number {
  return Math.max(0, Math.round((elTop - contentTop) / (zoom && zoom > 0 ? zoom : 1)));
}

/**
 * What the resting offset is measured from: the scrolled content when the column's page is the first one
 * in it, else the column's own page. A folded-in page (Tasks shows Tools & services under its own rows)
 * rests ~1200 px below the content top, and a sticky top that size pinned its rail to the bottom of the
 * window instead of beside its first section.
 */
export function stickyReference(el: HTMLElement, content: HTMLElement): HTMLElement {
  const page = el.closest<HTMLElement>("[data-settings-page]");
  if (!page || page === content) return content;
  return content.querySelector("[data-settings-page]") === page ? content : page;
}

/**
 * The sticky `top` of the right column (rail or aside): its own resting offset from the scroll box, measured
 * with sticking switched off and measured again when the content above it changes height. Any fixed top
 * makes the column ride up by the difference before it sticks.
 */
export function useStickyTop(ref: RefObject<HTMLElement | null>, enabled: boolean): number | undefined {
  const [stickTop, setStickTop] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = scrollParent(el);
    if (!enabled || !el || !box) return;
    // Measured against the scrolled content, not the box plus scrollTop: from 2200px the settings are
    // zoomed (1.107), rects come in zoomed px and scrollTop does not, so `rect + scrollTop` changed with
    // the scroll position. Each re-measure (a section opening, a late read growing the page) then gave a
    // new top, and the rail stepped 7-9 times on Files, Data & privacy and About. The CSS `top` is in the
    // element's own unzoomed px, so the zoomed distance is divided by its zoom.
    const content = (box.firstElementChild as HTMLElement | null) ?? box;
    const from = stickyReference(el, content);
    const measure = () => {
      const prev = el.style.position;
      el.style.position = "static";
      const top = restingTop(el.getBoundingClientRect().top, from.getBoundingClientRect().top, (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom);
      el.style.position = prev;
      setStickTop(top);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    if (box.firstElementChild) ro.observe(box.firstElementChild);
    // Content beside the column (a header above it) also moves its resting offset.
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [ref, enabled]);
  return stickTop;
}

/** How long the landed section stays marked; the CSS animation (`agx-rail-flash`) uses the same 1.2 s. */
export const RAIL_FLASH_MS = 1200;

/**
 * The folded blocks to open before a jump: the target's own `<details>` (a "More options" section) and
 * any closed `<details>` around it. Open ones are left alone. Ordered outermost first.
 */
export function foldedToOpen(el: Element): HTMLDetailsElement[] {
  const out: HTMLDetailsElement[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.tagName === "DETAILS" && !(n as HTMLDetailsElement).open) out.unshift(n as HTMLDetailsElement);
  }
  const own = el.querySelector?.("details");
  if (own && !own.open && own.closest("[data-section]") === el) out.push(own);
  return out;
}

/**
 * Whether the jump will move the scroller at all. The box can only reach [0, max]: a section near the
 * end of the page cannot come to the top, so when the clamped target equals where we are (within 1px)
 * no scroll happens, no `scrollend` will fire, and the flash must start at once.
 */
export function jumpMoves(scrollTop: number, delta: number, maxScroll: number): boolean {
  const to = Math.min(Math.max(scrollTop + delta, 0), Math.max(0, maxScroll));
  return Math.abs(to - scrollTop) > 1;
}

/** The system preference or the app's own Reduce motion setting (`html[data-reduce-motion]`). */
export function prefersReducedMotion(doc: Pick<Document, "documentElement"> | undefined = typeof document === "undefined" ? undefined : document,
  mm: ((q: string) => { matches: boolean }) | undefined = typeof matchMedia === "function" ? matchMedia : undefined): boolean {
  return !!doc?.documentElement.hasAttribute("data-reduce-motion") || !!mm?.("(prefers-reduced-motion: reduce)").matches;
}

/** Mark the landed section; the attribute drives a CSS fade (a static tint under reduced motion) and clears itself. */
export function flashSection(el: HTMLElement) {
  el.removeAttribute("data-rail-flash");
  void el.offsetWidth; // restart the animation when the same section is flashed twice in a row
  el.setAttribute("data-rail-flash", "");
  el.addEventListener("animationend", () => el.removeAttribute("data-rail-flash"), { once: true });
}

/** The one jump still waiting for its `scrollend`: a new jump cancels it, so a cut-off jump never flashes. */
let pendingFlash: { box: HTMLElement; fn: () => void } | null = null;

/** Drop the waiting flash of an earlier jump, if any. */
export function cancelPendingFlash() {
  if (!pendingFlash) return;
  pendingFlash.box.removeEventListener("scrollend", pendingFlash.fn);
  pendingFlash = null;
}

/** Whether a jump is still waiting for its scroll to end (tests read it). */
export const hasPendingFlash = () => pendingFlash !== null;

/**
 * Scroll to a section, smoothly (instantly under reduced motion), and focus its heading. A folded
 * target is opened first, so the scroll measures its real height. When the jump ends (`scrollend` on
 * the scroller, or at once when nothing has to move) the section flashes, so the eye finds where it landed.
 */
export function jumpToSection(root: HTMLElement | null, id: string) {
  const el = root?.querySelector<HTMLElement>(`[data-section="${CSS.escape(id)}"]`);
  if (!el) return;
  for (const d of foldedToOpen(el)) d.open = true;
  const reduce = prefersReducedMotion();
  const box = scrollParent(el);
  cancelPendingFlash();
  if (box) {
    const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top - margin;
    if (jumpMoves(box.scrollTop, delta, box.scrollHeight - box.clientHeight)) {
      const fn = () => { pendingFlash = null; flashSection(el); };
      pendingFlash = { box, fn };
      box.addEventListener("scrollend", fn, { once: true });
    } else {
      flashSection(el);
    }
  }
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  el.querySelector<HTMLElement>("[data-section-heading]")?.focus({ preventScroll: true });
}

/**
 * What the scroll-spy effect keys on: the section ids, not the array. Every page builds its `sections`
 * as a fresh literal, so any re-render above the rail (the modal reacting to the click's own scroll)
 * handed a new array, re-ran the effect, reset the pin and let the spy move the highlight to a neighbour.
 * Only a real change of list (a scope switch) changes this key.
 */
export function railListKey(sections: readonly Pick<SectionMeta, "id">[]): string {
  return sections.map((s) => s.id).join("\u0000");
}

/** How far (px) a pinned section may sit from where a jump lands it and still count as "the person has not moved". */
export const PIN_LANDING_SLACK = 8;

/** A realign only re-lands a section still at its landing spot; one the person scrolled away from stays put. */
export function pinStillLanded(sectionTop: number, rootTop: number, scrollMargin: number): boolean {
  return Math.abs(sectionTop - rootTop - scrollMargin) <= PIN_LANDING_SLACK;
}

/**
 * Whether a realign may re-land the pinned section. The person's input (wheel, touch, key, pointerdown)
 * already releases the pin, so a still-pinned section was not moved by them: while the page grows, the
 * section drifts from its landing spot with no scroll of the person's, and that must not stop the realign.
 * The distance test only applies once a scroll that neither the jump nor a realign made has been seen.
 */
export function shouldRealign(pinned: boolean, foreignScroll: boolean, sectionTop: number, rootTop: number, scrollMargin: number): boolean {
  if (!pinned) return false;
  return foreignScroll ? pinStillLanded(sectionTop, rootTop, scrollMargin) : true;
}

/** The event a row jump sends to the rail: the row to keep centered and the section that holds it. */
export const PIN_ROW_EVENT = "agx-pin-row";

/** How long the page height must stay unchanged before a row pin lets go (ms). */
export const ROW_PIN_STABLE_MS = 500;

/**
 * How far (px) a row sits from the vertical middle of the scroller. A realign scrolls by this much, so the
 * row lands centered again after the page grew above it.
 */
export function rowCenterDelta(rowTop: number, rowHeight: number, rootTop: number, rootHeight: number): number {
  return rowTop + rowHeight / 2 - (rootTop + rootHeight / 2);
}

/** A scroll event within this gap of our own last scroll (or of the last event judged ours) is still ours. */
export const SELF_SCROLL_GAP_MS = 150;

/**
 * Whether a scroll event belongs to a jump or realign of ours. Scroll events arrive a frame after the
 * scroll, and a realign cuts the jump's smooth scroll short, so the jump's `scrollend` can land BEFORE
 * the realign's own scroll event: a flag cleared by `scrollend` called that event foreign, the distance
 * test then failed for a page that kept growing, and every later realign was refused (section 1255 px
 * down, no input). A chain of events no more than the gap apart, started by our own scroll, is ours.
 */
export function scrollIsOurs(now: number, selfAt: number, lastOursAt: number): boolean {
  return now - Math.max(selfAt, lastOursAt) <= SELF_SCROLL_GAP_MS;
}

/**
 * Sticky "On this page" rail (the aside's width, 192px entries left-aligned, right of the content) or, when the page's content area is
 * narrow (`chips`, measured by SettingsPage), a chip band sticky at the top. Same entries and active state in both.
 * `scrollRoot` is the page's own scroll container. The nav must stay a direct child of the
 * full-height row in SettingsPage: a bare wrapper would shrink its sticky range to its own height.
 */
export function PageRail({ sections, scrollRoot, chips, scopeKey, narrow = false }: { sections: readonly SectionMeta[]; scrollRoot: () => HTMLElement | null; chips: boolean; scopeKey?: string; /** A wide page: the rail at its 192 px entry width. */ narrow?: boolean }) {
  const [active, setActive] = useState<string | undefined>(sections[0]?.id);
  const nav = useRef<HTMLElement>(null);
  // A click highlights its entry at once; the scroll-spy must not override it until the user scrolls again.
  const pinned = useRef(false);
  // The entry a click pinned, so a late change of the list or of the page height re-lands on it, not on the spy's pick.
  const pinnedId = useRef<string | null>(null);
  // Set when the pin is a row inside that section: the realign keeps this row centered instead of the section at the top.
  const pinnedRow = useRef<string | null>(null);
  // When our own last scroll (the jump, a realign) started, and the last scroll event judged ours; a scroll outside that chain is foreign.
  const selfAt = useRef(-Infinity);
  const lastOursAt = useRef(-Infinity);
  const foreignScroll = useRef(false);
  const lastScope = useRef(scopeKey);
  const listKey = railListKey(sections);
  const stickTop = useStickyTop(nav, !chips);
  // In chip mode the band is sticky at the top: a jumped-to heading must land below it, so the sections'
  // scroll margin (`--agx-rail-band`, read by Section) is the measured band height plus the usual 16px.
  useLayoutEffect(() => {
    const el = nav.current;
    const box = scrollParent(el);
    if (!chips || !el || !box) return;
    const publish = () => box.style.setProperty("--agx-rail-band", `${Math.ceil(el.getBoundingClientRect().height) + 16}px`);
    publish();
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(publish);
    ro?.observe(el);
    return () => { ro?.disconnect(); box.style.removeProperty("--agx-rail-band"); };
  }, [chips]);
  // A row pin ends for good only when the rail goes away (Settings closes, the page changes), not on a list-key re-arm.
  useEffect(() => () => {
    const next = releaseOrphanRowPin({ pinned: pinned.current, id: pinnedId.current, row: pinnedRow.current });
    pinned.current = next.pinned; pinnedId.current = next.id; pinnedRow.current = next.row;
  }, []);
  useEffect(() => {
    // A new section list or a scope switch starts unpinned. The scope is keyed on its own: two projects
    // share the same section ids, so the list key alone stayed the same and the rail stayed frozen.
    const root = scrollParent(nav.current) ?? scrollRoot();
    const ids = listKey ? listKey.split("\u0000") : [];
    if (lastScope.current !== scopeKey) { lastScope.current = scopeKey; pinnedId.current = null; }
    if (pinnedId.current && !ids.includes(pinnedId.current)) pinnedId.current = null;
    if (!pinnedId.current) pinnedRow.current = null;
    pinned.current = pinnedId.current !== null;
    foreignScroll.current = false;
    if (!root || typeof IntersectionObserver === "undefined") return;
    let cancelStable: (() => void) | undefined;
    const armQuiet = (rowId: string) => {
      cancelStable?.();
      cancelStable = afterQuiet(() => { if (pinnedRow.current === rowId) { pinned.current = false; pinnedId.current = null; pinnedRow.current = null; } }, ROW_PIN_STABLE_MS);
    };
    const realign = () => {
      const id = pinnedId.current;
      if (!id) return;
      const rowId = pinnedRow.current;
      const el = rowId
        ? root.querySelector<HTMLElement>(`[data-row="${CSS.escape(rowId)}"], [data-setting-id="${CSS.escape(rowId)}"]`)
        : root.querySelector<HTMLElement>(`[data-section="${CSS.escape(id)}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const rr = root.getBoundingClientRect();
      // A scroll that was not ours moved the page: the pin is theirs to leave, not ours to undo.
      // A row is "landed" when centered, so its distance from the middle is judged against 0.
      const ok = rowId
        ? shouldRealign(pinned.current, foreignScroll.current, rowCenterDelta(r.top, r.height, rr.top, rr.height), 0, 0)
        : shouldRealign(pinned.current, foreignScroll.current, r.top, rr.top, parseFloat(getComputedStyle(el).scrollMarginTop) || 0);
      if (!ok) return;
      selfAt.current = performance.now();
      setActive(id);
      el.scrollIntoView({ behavior: "auto", block: rowId ? "center" : "start" });
      // A row pin ends when the page height has been still for a while (a section pin ends on input only).
      if (rowId) {
        armQuiet(rowId);
      }
    };
    const pinRow = (e: Event) => {
      const d = (e as CustomEvent<{ row: string; section: string | null }>).detail;
      if (!d?.row) return;
      e.preventDefault(); // tells the sender the pin was handled (it scrolls itself otherwise)
      pinnedId.current = d.section ?? ids[0] ?? null;
      pinnedRow.current = d.row;
      pinned.current = pinnedId.current !== null;
      selfAt.current = performance.now();
      lastOursAt.current = -Infinity;
      foreignScroll.current = false;
      realign();
    };
    root.addEventListener(PIN_ROW_EVENT, pinRow);
    // Re-armed for a list change while a row pin is live (the page grows after the jump): keep the pin, restart its quiet timer.
    if (pinnedRow.current) armQuiet(pinnedRow.current);
    const update = () => {
      if (pinned.current) return;
      const base = root.getBoundingClientRect().top;
      const tops = ids.map((id) => (root.querySelector(`[data-section="${CSS.escape(id)}"]`)?.getBoundingClientRect().top ?? Infinity) - base);
      setActive(activeSection(ids, tops, undefined, root.scrollTop + root.clientHeight >= root.scrollHeight - 2 && root.scrollTop > 0));
    };
    const io = new IntersectionObserver(update, { root, threshold: [0, 1] });
    for (const id of ids) {
      const el = root.querySelector(`[data-section="${CSS.escape(id)}"]`);
      if (el) io.observe(el);
    }
    update();
    // The page grows after a jump (late reads, folded bodies): re-land on the pinned section once it settles.
    // Not only the first child: a page that grows inside a fixed-height wrapper never resizes that child, so the
    // scroller and every section are watched too (a section growing is what moves the target down).
    const content = root.firstElementChild;
    const ro = typeof ResizeObserver === "undefined" || !content ? undefined : new ResizeObserver(realign);
    if (content) ro?.observe(content);
    ro?.observe(root);
    for (const id of ids) { const el = root.querySelector(`[data-section="${CSS.escape(id)}"]`); if (el) ro?.observe(el); }
    // A click pins its entry until the USER scrolls (wheel, touch, key, pointer press); the end of the
    // click's own smooth scroll releases nothing. The at-bottom rule therefore only applies to user scrolling.
    const release = () => { if (pinned.current) { cancelStable?.(); pinned.current = false; pinnedId.current = null; pinnedRow.current = null; update(); } };
    const onScroll = () => {
      if (!pinned.current) { update(); return; }
      const now = performance.now();
      if (scrollIsOurs(now, selfAt.current, lastOursAt.current)) lastOursAt.current = now; else foreignScroll.current = true;
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    const userEvents = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const e of userEvents) root.addEventListener(e, release, { passive: true });
    return () => {
      cancelStable?.();
      root.removeEventListener(PIN_ROW_EVENT, pinRow); io.disconnect(); ro?.disconnect(); root.removeEventListener("scroll", onScroll); for (const e of userEvents) root.removeEventListener(e, release);
    };
  }, [listKey, scrollRoot, scopeKey]);

  const entry = (s: SectionMeta) => (
    <button
      key={s.id}
      type="button"
      data-rail-entry={s.id}
      aria-current={active === s.id ? "true" : undefined}
      onClick={() => {
        setActive(s.id);
        pinned.current = true;
        pinnedId.current = s.id;
        pinnedRow.current = null;
        selfAt.current = performance.now();
        lastOursAt.current = -Infinity;
        foreignScroll.current = false;
        jumpToSection(scrollRoot(), s.id);
      }}
      // Full width of the rail column: at 192 px the entries ended 168 px short of the column, so a
      // centred page showed 478 px free on the left and 697 px on the right (2540 px window).
      className={chips ? "px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap" : "block w-full text-left px-2 py-1 rounded text-[12px]"}
      style={{
        color: active === s.id ? "var(--text)" : "var(--text2)",
        background: active === s.id ? "var(--surface-inset)" : "transparent",
      }}
    >
      {s.count && !chips ? <span className="flex items-center justify-between gap-2"><span className="min-w-0">{s.title}</span><small className="tabular-nums shrink-0 text-[11px]" style={{ color: "var(--text3)" }}>{s.count}</small></span> : s.title}
    </button>
  );

  return (
    <nav
      ref={nav}
      aria-label="On this page"
      data-page-rail={chips ? "chips" : "rail"}
      className={chips ? "flex flex-wrap gap-1.5 py-2" : "flex flex-col items-start gap-0.5"}
      style={chips ? { position: "sticky", top: 0, zIndex: LAYER.pane, background: "var(--surface-page)" } : { position: "sticky", top: stickTop ?? 24, alignSelf: "flex-start", width: SHELL_SIZE.aside, minWidth: SHELL_RAIL_MIN, ...(narrow ? { width: SHELL_RAIL_MIN } : null) }}
    >
      {/* A label, not an entry: smaller, upper case and quieter than the entries, and not selectable, so it does not read as a thing to click. */}
      {!chips && <div aria-hidden className="px-2 pb-1.5 text-[10px] uppercase tracking-wider select-none cursor-default" style={{ color: "var(--text3)" }}>On this page</div>}
      {sections.map(entry)}
    </nav>
  );
}
