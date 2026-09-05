// The screenshot tool, in the shape Firefox's is.
//
// Ctrl+Shift+S over a page: hover an element and it outlines, drag and you get
// a region — and then NOTHING HAPPENS until you say so. The selection stays on
// screen with handles, its size beside it, and a bar offering Copy and
// Download. That pause is the whole feature: the first version captured on
// mouse-up, which meant a selection one pixel off was a selection you could not
// fix, and a click meant to start a drag was a screenshot of whatever was under
// it.
//
// All of it on OUR side of the glass. The earlier attempt drew the marquee
// inside the page from an injected script, where it fought the page's own
// listeners and the element highlighter cancelled the drag. Here the overlay is
// an ordinary element of this app that happens to sit over a `<webview>`, and
// the guest is asked exactly one question — "what is at this point" — and only
// while nothing is selected yet.
//
// The capture takes the whole visible view and crops in a canvas. That is not
// laziness: a rectangle drawn here is in this window's CSS pixels, the guest's
// own is in the page's, and `capturePage` wants the view's — three spaces, two
// zoom factors, and every previous bug in this area was a conversion between
// them. The ratio between the captured image and the element it came from is
// one number that can be measured instead of derived.

import { useCallback, useEffect, useRef, useState } from "react";
import { CloseButton } from "../CloseButton.tsx";

export interface Rect { x: number; y: number; width: number; height: number }

type Guest = {
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(rect?: Rect): Promise<{ toDataURL(): string }>;
} | null;

/** The desktop clipboard, which works while the guest holds the focus —
 *  `navigator.clipboard` does not, and that is not a fixable thing here. */
type Bridge = { copyImage?: (d: string) => Promise<boolean>; saveImage?: (d: string, n: string) => Promise<{ ok: boolean; path?: string; error?: string }> };
const bridge = (): Bridge | undefined => (window as unknown as { agentglass?: Bridge }).agentglass;

async function copyImage(dataUrl: string): Promise<boolean> {
  const write = bridge()?.copyImage;
  if (write) { try { return (await write(dataUrl)) !== false; } catch { return false; } }
  try {
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
    return true;
  } catch { return false; }
}

/** A press that did not travel is a click, and a click takes the element under
 *  it. Six pixels, the same slop the shelf's drag uses. */
const SLOP = 6;

const norm = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({
  x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
  width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
});

/** What is under the pointer, as the PAGE sees it. Its own rectangle, in the
 *  page's CSS pixels — the caller scales it by the page's zoom to draw it. */
const elementAt = (x: number, y: number): string => `(() => {
  const e = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
  if (!e) return "";
  const r = e.getBoundingClientRect();
  return JSON.stringify({ x: r.left, y: r.top, width: r.width, height: r.height, tag: e.tagName.toLowerCase() });
})()`;

export function Shooter({ view, onNote, onDone }: {
  view: Guest;
  onNote: (msg: string) => void;
  onDone: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Rect | null>(null);
  const [sel, setSel] = useState<Rect | null>(null);
  const [busy, setBusy] = useState("");
  /** The drag in flight: where it started, and what kind. Moving and resizing
   *  an existing selection are the same gesture with a different anchor. */
  const drag = useRef<{ from: { x: number; y: number }; base: Rect | null; handle: string | null } | null>(null);

  /* Ask the page what is under the pointer, and not more often than that is
     worth: one round trip to another process per pointer move would make the
     outline lag behind the hand. Only while nothing is selected — once there is
     a selection the pointer is for adjusting it. */
  /*
   * How many of this window's pixels one of the page's is worth.
   *
   * MEASURED, not derived. The first version computed it from the zoom level
   * (1.2 to the power of the step) and the outline landed nowhere near what the
   * pointer was over — because that is only one of the factors: the app's own
   * window zoom is another, and a viewport preset makes the page narrower than
   * the area this overlay covers. `innerWidth` against the element's own width
   * is one number that contains all of them, and it is the same trick the crop
   * uses (image width against element width), which is the part that works.
   */
  const [k, setK] = useState(1);
  const el = () => (view as unknown as HTMLElement | null);

  useEffect(() => {
    let live = true;
    const measure = () => {
      const node = el();
      if (!view || !node) return;
      void view.executeJavaScript("String(window.innerWidth)").then((raw) => {
        const pageWidth = Number(raw);
        const own = node.getBoundingClientRect().width;
        if (live && pageWidth > 0 && own > 0) setK(own / pageWidth);
      }).catch(() => {});
    };
    measure();
    window.addEventListener("resize", measure);
    return () => { live = false; window.removeEventListener("resize", measure); };
  }, [view]);

  /** Where the page's area sits inside this overlay. Not always zero: a
   *  viewport preset centres the page in a column narrower than the pane. */
  const offset = (): { x: number; y: number } => {
    const node = el()?.getBoundingClientRect();
    const mine = box.current?.getBoundingClientRect();
    if (!node || !mine) return { x: 0, y: 0 };
    return { x: node.left - mine.left, y: node.top - mine.top };
  };

  const askedAt = useRef(0);
  const askElement = useCallback((x: number, y: number) => {
    if (!view || sel) return;
    const now = Date.now();
    if (now - askedAt.current < 60) return;
    askedAt.current = now;
    const node = el()?.getBoundingClientRect();
    if (!node) return;
    const off = offset();
    void view.executeJavaScript(elementAt((x - node.left) / k, (y - node.top) / k)).then((raw) => {
      if (typeof raw !== "string" || !raw) return;
      try {
        const e = JSON.parse(raw) as Rect;
        setHover({ x: e.x * k + off.x, y: e.y * k + off.y, width: e.width * k, height: e.height * k });
      } catch { /* the page answered something else */ }
    }).catch(() => {});
  }, [view, sel, k]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      /* Ctrl+C on a selection is the thing every hand tries first, and until it
         worked the bar was the only way — which is the bar he pressed and
         watched do nothing. */
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && sel) {
        e.preventDefault();
        e.stopPropagation();
        void copyRef.current();
        return;
      }
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      // Escape backs out one step: the selection first, the tool second. A
      // single Escape that threw away both would punish a mis-drag with a
      // restart.
      if (sel) { setSel(null); return; }
      onDone();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [sel, onDone]);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const r = box.current?.getBoundingClientRect();
    const at = { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
    const handle = (e.target as HTMLElement).dataset?.handle ?? null;
    drag.current = { from: at, base: handle || (sel && inside(sel, at)) ? sel : null, handle };
    if (!drag.current.base) setSel(null);
  };

  const onMove = (e: React.PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    const at = { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
    const d = drag.current;
    if (!d) { askElement(e.clientX, e.clientY); return; }
    if (d.base && d.handle) { setSel(resize(d.base, d.handle, at)); return; }
    if (d.base) {
      setSel({ ...d.base, x: d.base.x + (at.x - d.from.x), y: d.base.y + (at.y - d.from.y) });
      return;
    }
    setSel(norm(d.from, at));
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.base) return;
    const r = box.current?.getBoundingClientRect();
    const at = { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
    const moved = Math.abs(at.x - d.from.x) >= SLOP || Math.abs(at.y - d.from.y) >= SLOP;
    // A click takes the element under it; a drag takes what was dragged.
    if (!moved) { setSel(hover ? { ...hover } : null); return; }
    setSel(norm(d.from, at));
  };

  /**
   * The selection, as an image.
   *
   * The whole visible view is captured and cropped here rather than handing
   * `capturePage` a rectangle: the ratio between the image and the element it
   * came from is one number that can be MEASURED, where the conversion between
   * this window's pixels, the page's and the view's is three spaces and two
   * zoom factors — and every bug this tool has had was one of those.
   */
  const crop = useCallback(async (): Promise<string | null> => {
    if (!view || !sel || sel.width < 2 || sel.height < 2) return null;
    const node = el()?.getBoundingClientRect();
    if (!node) return null;
    const shot = await view.capturePage();
    const url = shot.toDataURL();
    const img = new Image();
    await new Promise((done, fail) => { img.onload = done; img.onerror = fail; img.src = url; });
    /* The image against the element it came from: one measurable ratio, and it
       is not the same one as `k` — this one carries the device's pixel ratio as
       well. */
    const scale = img.width / node.width;
    const off = offset();
    const at = { x: (sel.x - off.x) * scale, y: (sel.y - off.y) * scale, width: sel.width * scale, height: sel.height * scale };
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(at.width));
    canvas.height = Math.max(1, Math.round(at.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, at.x, at.y, at.width, at.height, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  }, [view, sel]);

  /* The chord and the button do the same thing, and the listener is registered
     once — a ref, so it is never holding the first render's copy of it. */
  const copyRef = useRef<() => Promise<void>>(async () => {});

  const doCopy = async () => {
    setBusy("copy");
    const png = await crop();
    setBusy("");
    if (!png) { onNote("There was nothing in that selection"); return; }
    onNote(await copyImage(png) ? `Copied — ${Math.round(sel!.width)}×${Math.round(sel!.height)}` : "The clipboard refused the image");
    onDone();
  };

  const doSave = async () => {
    setBusy("save");
    const png = await crop();
    setBusy("");
    if (!png) { onNote("There was nothing in that selection"); return; }
    const save = bridge()?.saveImage;
    if (!save) { onNote("This build cannot save a file"); return; }
    const r = await save(png, `agentglass-${Math.round(sel!.width)}x${Math.round(sel!.height)}.png`);
    onNote(r.ok && r.path ? `Saved to ${r.path}` : (r.error || "It could not be saved"));
    onDone();
  };

  copyRef.current = doCopy;

  const showing = sel ?? hover;

  return (
    <div ref={box} className="absolute inset-0" style={{ zIndex: 32, cursor: sel ? "default" : "crosshair" }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
      {/* Everything outside the selection, dimmed. Four panels rather than one
          box with a hole: a hole needs a mask, and a mask over a `<webview>` is
          a compositing question nobody wants to answer. */}
      {showing && [
        { top: 0, left: 0, right: 0, height: Math.max(0, showing.y) },
        { top: showing.y + showing.height, left: 0, right: 0, bottom: 0 },
        { top: showing.y, left: 0, width: Math.max(0, showing.x), height: showing.height },
        { top: showing.y, left: showing.x + showing.width, right: 0, height: showing.height },
      ].map((s, i) => (
        <div key={i} className="absolute" style={{ ...s, background: "rgba(6,4,12,0.45)", pointerEvents: "none" }} />
      ))}
      {!showing && <div className="absolute inset-0" style={{ background: "rgba(6,4,12,0.25)", pointerEvents: "none" }} />}

      {showing && (
        <div className="absolute" style={{
          left: showing.x, top: showing.y, width: showing.width, height: showing.height,
          border: `1px ${sel ? "solid" : "dashed"} var(--primary-hover)`,
          background: sel ? "transparent" : "color-mix(in srgb, var(--primary) 8%, transparent)",
          pointerEvents: "none",
        }} />
      )}

      {/* The handles, and the size. Firefox puts the number in the middle of
          the selection and it is the thing you read while resizing, so it is
          there rather than in the bar. */}
      {sel && (
        <>
          {HANDLES.map((h) => (
            <div key={h.id} data-handle={h.id} className="absolute rounded-full"
              style={{
                left: sel.x + sel.width * h.fx - 5, top: sel.y + sel.height * h.fy - 5,
                width: 10, height: 10, background: "var(--text)", border: "1px solid var(--primary-hover)",
                cursor: h.cursor,
              }} />
          ))}
          <div className="absolute px-1.5 py-0.5 rounded text-[11px] tabular-nums pointer-events-none"
            style={{
              left: sel.x + sel.width / 2, top: sel.y + sel.height / 2, transform: "translate(-50%, -50%)",
              background: "rgba(6,4,12,0.85)", color: "var(--text)",
            }}>{Math.round(sel.width)} × {Math.round(sel.height)}</div>
        </>
      )}

      {/* The bar. Under the selection when there is room, over it when there is
          not — a bar off the bottom of the window is a bar you cannot press. */}
      {/*
        * The bar takes its own presses.
        *
        * Everything in this overlay is a drag surface, buttons included: the
        * press on Copy started a NEW selection, the release ended it, and the
        * click never arrived. Measured — he pressed Copy and watched the
        * selection grow to the whole window instead.
        */}
      <div className="absolute flex items-center gap-1.5"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        style={sel
          ? {
              left: Math.min(Math.max(8, sel.x + sel.width - 240), (box.current?.clientWidth ?? 800) - 248),
              top: sel.y + sel.height + 8 > (box.current?.clientHeight ?? 600) - 44 ? Math.max(8, sel.y - 44) : sel.y + sel.height + 8,
            }
          : { right: 8, top: 8 }}>
        {sel ? (
          <>
            <CloseButton onClick={onDone} title="Cancel (Esc)" hit={30}
              style={{ background: "var(--bg2)", color: "var(--text3)", border: BORDER }} />
            <button onClick={() => void doCopy()} disabled={!!busy}
              className="px-3 py-1.5 rounded-lg text-[11.5px] disabled:opacity-50"
              style={{ background: "var(--bg2)", color: "var(--text)", border: BORDER }}>
              {busy === "copy" ? "Copying…" : "Copy"}
            </button>
            <button onClick={() => void doSave()} disabled={!!busy}
              className="px-3 py-1.5 rounded-lg text-[11.5px] disabled:opacity-50"
              style={{ background: "color-mix(in srgb, var(--primary) 30%, var(--bg2))", color: "var(--text)", border: BORDER }}>
              {busy === "save" ? "Saving…" : "Download"}
            </button>
          </>
        ) : (
          <>
            <button onClick={() => { setSel({ x: 0, y: 0, width: box.current?.clientWidth ?? 0, height: box.current?.clientHeight ?? 0 }); }}
              className="px-2.5 py-1.5 rounded-lg text-[11px]"
              style={{ background: "var(--bg2)", color: "var(--text)", border: BORDER }}>Visible</button>
            {/* WHOLE PAGE IS GONE, and the reason is worth keeping.
                `captureBeyondViewport` paints the page in strips and repaints
                anything `position: fixed` in EVERY strip, so a page with a
                sticky header came back with the navigation bar repeated down
                the middle of the image. Four attempts at it — content width,
                re-layout, zoom, pinning the fixed elements — and the last one
                still duplicated. A capture that repeats content is evidence
                that is simply wrong, and a button that produces it is worth
                less than no button. `Visible` does what people were reaching
                for anyway. */}
            <button onClick={onDone}
              className="px-2.5 py-1.5 rounded-lg text-[11px]"
              style={{ background: "var(--bg2)", color: "var(--text3)", border: BORDER }}>Cancel</button>
          </>
        )}
      </div>

      {!sel && (
        <div className="absolute left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg text-[11.5px] pointer-events-none"
          style={{ bottom: 16, background: "rgba(6,4,12,0.9)", color: "var(--text2)", border: BORDER }}>
          Drag a region, or click an element · Esc to cancel
        </div>
      )}
    </div>
  );
}

const BORDER = "1px solid color-mix(in srgb, var(--border) 60%, transparent)";

const HANDLES = [
  { id: "nw", fx: 0, fy: 0, cursor: "nwse-resize" },
  { id: "n", fx: 0.5, fy: 0, cursor: "ns-resize" },
  { id: "ne", fx: 1, fy: 0, cursor: "nesw-resize" },
  { id: "e", fx: 1, fy: 0.5, cursor: "ew-resize" },
  { id: "se", fx: 1, fy: 1, cursor: "nwse-resize" },
  { id: "s", fx: 0.5, fy: 1, cursor: "ns-resize" },
  { id: "sw", fx: 0, fy: 1, cursor: "nesw-resize" },
  { id: "w", fx: 0, fy: 0.5, cursor: "ew-resize" },
];

const inside = (r: Rect, p: { x: number; y: number }): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/**
 * One edge or corner, moved.
 *
 * Normalised at the end, so dragging the left edge past the right one flips the
 * selection instead of producing a negative width — which is what a rectangle
 * with a negative width does everywhere else: nothing, silently.
 */
export function resize(base: Rect, handle: string, to: { x: number; y: number }): Rect {
  let { x, y, width, height } = base;
  const right = x + width;
  const bottom = y + height;
  if (handle.includes("w")) { x = to.x; width = right - to.x; }
  if (handle.includes("e")) { width = to.x - x; }
  if (handle.includes("n")) { y = to.y; height = bottom - to.y; }
  if (handle.includes("s")) { height = to.y - y; }
  return {
    x: width < 0 ? x + width : x,
    y: height < 0 ? y + height : y,
    width: Math.abs(width),
    height: Math.abs(height),
  };
}
