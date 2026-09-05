// The files on a card, and a way to actually look at them.
//
// On the board this was built for, a bug card carries fifteen screenshots — which is
// the evidence, and the one thing the panel could not show at all. The reason it is a
// tab rather than a strip at the bottom of the card is arithmetic: the metadata rides
// on the payload the card already fetches, so knowing there are fifteen is free, while
// the images behind them are half a megabyte each. Nothing is fetched until the tab is
// opened; then the browser fetches THUMBNAILS (a few kilobytes), lazily, as they come
// into view; the full image is fetched once, when it is opened in the viewer.
//
// The viewer is the point. A grid of 150px screenshots is a grid of grey rectangles —
// what a screenshot is FOR is being read.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CardAttachment } from "../../../shared/providers.ts";
import { externalUrl, openExternal } from "../lib/externalUrl.ts";
import { SERVER, withToken } from "../lib/api.ts";
import { CloseButton } from "./CloseButton.tsx";
import { claimZoom } from "../lib/zoomOwner.ts";

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

/** Bytes as a person reads them. `0` means the workspace did not say, and an unknown
 *  size is drawn as nothing rather than as "0 B", which is a claim. */
export function fileSize(bytes: number): string {
  if (!bytes || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Only what the browser will actually draw. ClickUp makes a thumbnail for images and
 *  nothing else, so its absence is the honest test — better than a list of extensions
 *  this app would have to keep in step with theirs. */
/*
 * A VIDEO IS NOT AN IMAGE, and the thumbnail is why it looked like one.
 *
 * `isImage` was "the workspace made a thumbnail for it", which is true of a
 * screen recording too — so a 20 MB .mov went into the picture grid, opened in
 * the viewer, and rendered as a broken-image icon with its own filename beside
 * it. The file was fine; nothing had ever asked it to play.
 *
 * By EXTENSION rather than by mime, because the extension is what the
 * attachment carries — `ext` is a field on it and a content type is not. The
 * list is the ones a browser will actually play; a .wmv or an .avi still gets
 * named and downloaded rather than dropped into a player that would show a
 * black rectangle.
 */
const PLAYS = new Set(["mp4", "webm", "ogg", "ogv", "mov", "m4v"]);

/*
 * A video is played THROUGH this app, not straight off the tracker's host.
 *
 * That host sends `content-disposition: attachment` on every file, which means
 * "this is a download" — so a <video> pointed at it fails before it looks at
 * the bytes, whatever they are. Measured after two wrong guesses: the host
 * answers range requests, and the stream is avc1/H.264, which this browser
 * plays without complaint. The header was the whole thing.
 *
 * `/clickup/file` passes the bytes through with that header dropped and
 * `video/mp4` in its place, forwarding Range so seeking still works. See the
 * route for why it can only serve files this app has already offered.
 */
export const playableUrl = (a: CardAttachment): string =>
  /* `withToken`, because a <video src> carries no headers — the same reason
     avatars ride one. */
  withToken(`${SERVER}/clickup/file?id=${encodeURIComponent(a.id)}`);
export const isVideo = (a: CardAttachment): boolean => PLAYS.has((a.ext || "").toLowerCase());
export const isImage = (a: CardAttachment): boolean => !!a.thumb && !isVideo(a);
/** What the viewer can show: a picture, or a video it can play. */
export const isViewable = (a: CardAttachment): boolean => isImage(a) || isVideo(a);

/** How far in and out the viewer's own zoom will go. Past 8× a screenshot is grain;
 *  below fit there is nothing left to see. */
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

export function CardFiles({ files }: { files: CardAttachment[] }) {
  /** Which one is open in the viewer, by index. Null is closed. */
  const [at, setAt] = useState<number | null>(null);
  /*
   * The viewer's OWN zoom, and it is deliberately not the application's.
   *
   * Ctrl+wheel and ⌘= zoom the whole interface — the panes, the type, the terminal —
   * which is the wrong tool for reading a screenshot: it scales the app around the
   * image as well, and it is remembered afterwards. So the viewer zooms the IMAGE, on
   * a plain wheel and on +/-/0, and leaves the application's own zoom exactly where it
   * was. Nothing here consumes Ctrl+wheel or ⌘=, so both still do what they always do.
   *
   * `1` is fit-to-window rather than 100%: a 2560px screenshot in a 1400px window
   * opens whole, which is what somebody wants first, and 1:1 is a press away.
   */
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  /*
   * Whether the full picture for the CURRENT index has arrived.
   *
   * Reported, and it is the worst kind of slow: pressing → left the previous image on
   * screen with nothing moving, so it read as a button that did nothing and got
   * pressed again and again. Half a megabyte over somebody else's CDN is not instant,
   * and a viewer that says nothing while it waits is a viewer that looks broken.
   *
   * Keyed by the image's own id rather than a bare boolean, so a late `load` from the
   * picture you have already walked past cannot clear the spinner for the one you are
   * waiting on.
   */
  const [shown, setShown] = useState<string | null>(null);
  /** The one that came back undecodable, so the viewer can say so instead of
   *  showing a player stuck at 0:00 forever. */
  const [broke, setBroke] = useState<string | null>(null);
  /* Videos join the grid rather than the named list: they have a thumbnail,
     they are the thing somebody attached to show what happened, and a screen
     recording filed under "other files" is one nobody opens. */
  const images = files.filter(isViewable);
  const others = files.filter((f) => !isViewable(f));

  /** Both go back to fit whenever the picture changes: a pan held over from the last
   *  image points at a place this one does not have. */
  const reset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);
  const zoomBy = useCallback((factor: number) => {
    setZoom((z) => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const step = useCallback((by: number) => {
    reset();
    setAt((cur) => {
      if (cur === null || !images.length) return cur;
      return (cur + by + images.length) % images.length;
    });
  }, [images.length, reset]);

  /* The keys somebody already has their hands on: arrows walk, Escape leaves. Bound
     while the viewer is open and never otherwise — a card is a page with a comment box
     on it, and a global arrow handler would fight the caret. */
  useEffect(() => {
    if (at === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey) return;
      /* WITH or without the modifier. While a screenshot is on screen, ⌘= means "make
         this bigger" — not "make the application bigger with the screenshot inside
         it". The menu accelerator is switched off for as long as the viewer is open
         (see the effect below), because a menu accelerator is handled in the main
         process and a renderer cannot preventDefault it. */
      const zoomKey = e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_" || e.key === "0";
      if ((e.metaKey || e.ctrlKey) && !zoomKey) return;
      if (e.key === "Escape") { e.preventDefault(); setAt(null); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); e.stopPropagation(); zoomBy(1.25); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); e.stopPropagation(); zoomBy(1 / 1.25); }
      else if (e.key === "0") { e.preventDefault(); e.stopPropagation(); reset(); }
    };
    /* Capture, so it is heard before anything else in the page — the card underneath
       has its own keys. */
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [at, step, zoomBy, reset]);

  /*
   * The neighbours, fetched while you are looking at this one.
   *
   * Walking a card's screenshots is almost always → → →, and the second press should
   * not pay the same wait as the first. One forward and one back, no more: fifteen
   * screenshots at half a megabyte each is not something to pull down because somebody
   * opened the first.
   */
  useEffect(() => {
    if (at === null) return;
    for (const k of [at + 1, at - 1]) {
      const n = images[(k + images.length) % images.length];
      if (n && n !== images[at]) { const img = new Image(); img.src = n.url; }
    }
  }, [at, images]);

  /*
   * The zoom gestures, held for as long as this is open.
   *
   * The application zooms ITSELF on Ctrl+wheel and ⌘=, from a window-level capture
   * listener that runs before anything this component can attach — so without this,
   * one gesture zoomed the interface and the picture at once. The app asks who owns
   * the zoom before it acts; while a screenshot is on screen, the answer is here.
   */
  useEffect(() => {
    if (at === null) return;
    return claimZoom("image-viewer");
  }, [at]);

  /*
   * The wheel, listened for the hard way.
   *
   * React attaches `onWheel` PASSIVELY at the root, so `preventDefault` inside a JSX
   * handler is a no-op and Chromium zooms the page anyway — which is exactly the bug
   * this is fixing. A native listener with `passive: false` is the only version that
   * can refuse the gesture, and it has to be bound to the node itself.
   */
  const stage = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = stage.current;
    if (at === null || !el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [at, zoomBy]);

  if (!files.length) {
    return <div className="p-5 text-center text-[11.5px]" style={{ color: "var(--text3)" }}>No files on this card.</div>;
  }

  const open = at !== null ? images[at] : null;

  return (
    <div className="flex flex-col gap-3 pt-2">
      {!!images.length && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
          {images.map((a, i) => (
            <button key={a.id} onClick={() => setAt(i)}
              title={`${a.title}${a.size ? ` · ${fileSize(a.size)}` : ""}${a.who ? ` · ${a.who}` : ""}`}
              className="agx-btn text-left rounded-lg overflow-hidden flex flex-col"
              style={{ border: edge(14), background: "color-mix(in srgb, var(--text) 4%, transparent)" }}>
              {/* `loading="lazy"` is the whole performance story: fifteen thumbnails
                  are fetched as they scroll into view, not when the tab mounts. */}
              {/* A play mark on the ones that play, so a recording is not a
                  still you press and then wait on. Its own thumbnail when the
                  workspace made one, and a plain ground when it did not — some
                  formats get no still and a grey box with a ▶ on it is still
                  the right answer. */}
              <span className="relative block">
                {a.thumb
                  ? <img src={a.thumb} alt={a.title} loading="lazy" decoding="async"
                      style={{ width: "100%", height: 104, objectFit: "cover", display: "block", background: "var(--bg3)" }} />
                  : <span style={{ width: "100%", height: 104, display: "block", background: "var(--bg3)" }} />}
                {isVideo(a) && (
                  <span className="absolute inset-0 grid place-items-center" aria-hidden>
                    <span className="grid place-items-center rounded-full" style={{
                      width: 30, height: 30,
                      background: "color-mix(in srgb, var(--bg) 62%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--text) 26%, transparent)",
                    }}>
                      <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--text)", marginLeft: 2 }}>
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </span>
                  </span>
                )}
              </span>
              <span className="px-2 py-1.5 text-[10px] truncate" style={{ color: "var(--text3)" }}>{a.title}</span>
            </button>
          ))}
        </div>
      )}

      {!!others.length && (
        <div className="flex flex-col">
          {others.map((a) => (
            <button key={a.id} onClick={() => openExternal(a.url)}
              className="agx-btn text-left flex items-center gap-2 py-1.5 text-[11px]"
              style={{ borderBottom: edge(8), color: "var(--text2)" }}>
              <span className="shrink-0 text-[9.5px] px-1.5 py-0.5 rounded uppercase"
                style={{ color: "var(--text4)", border: edge(14) }}>{a.ext || "file"}</span>
              <span className="min-w-0 truncate">{a.title}</span>
              <span className="ml-auto shrink-0 text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>{fileSize(a.size)}</span>
            </button>
          ))}
        </div>
      )}

      {open && (
        /* Over the card, not in it: a screenshot is read at the size it was taken, and
           the pane it would sit in is 380px wide. */
        <div role="dialog" aria-modal="true" aria-label={open.title}
          onClick={() => setAt(null)}
          className="fixed inset-0 z-50 flex flex-col"
          style={{ background: "color-mix(in srgb, var(--bg) 88%, black)" }}>
          <div className="flex items-center gap-3 px-4 py-2 shrink-0 text-[11px]"
            onClick={(e) => e.stopPropagation()}
            style={{ color: "var(--text2)", borderBottom: edge(12) }}>
            <span className="min-w-0 truncate">{open.title}</span>
            <span className="shrink-0 tabular-nums" style={{ color: "var(--text4)" }}>
              {at! + 1} / {images.length}{open.size ? ` · ${fileSize(open.size)}` : ""}
            </span>
            {shown !== open.id && (
              <span className="shrink-0 flex items-center gap-1.5 text-[10px]" style={{ color: "var(--text3)" }}>
                <span className="agx-spin" aria-hidden style={{ width: 9, height: 9, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />
                loading
              </span>
            )}
            <span className="ml-auto flex items-center gap-1.5 shrink-0">
              {/* The viewer's own zoom, said out loud so nobody wonders whether it is
                  the app's: it says what it is doing and 0 puts it back. */}
              <button onClick={() => zoomBy(1 / 1.25)} disabled={zoom <= ZOOM_MIN} title="Zoom out (−)"
                className="agx-btn px-2 py-0.5 rounded disabled:opacity-30" style={{ border: edge(18), color: "var(--text2)" }}>−</button>
              <button onClick={reset} title="Fit to the window (0)"
                className="agx-btn px-2 py-0.5 rounded tabular-nums" style={{ border: edge(18), color: zoom === 1 ? "var(--text3)" : "var(--text)" }}>
                {zoom === 1 ? "fit" : `${Math.round(zoom * 100)}%`}
              </button>
              <button onClick={() => zoomBy(1.25)} disabled={zoom >= ZOOM_MAX} title="Zoom in (+)"
                className="agx-btn px-2 py-0.5 rounded disabled:opacity-30" style={{ border: edge(18), color: "var(--text2)" }}>+</button>
              <span aria-hidden style={{ color: "var(--text4)" }}>·</span>
              <button onClick={() => step(-1)} disabled={images.length < 2} title="Previous (←)"
                className="agx-btn px-2 py-0.5 rounded disabled:opacity-30" style={{ border: edge(18), color: "var(--text2)" }}>←</button>
              <button onClick={() => step(1)} disabled={images.length < 2} title="Next (→)"
                className="agx-btn px-2 py-0.5 rounded disabled:opacity-30" style={{ border: edge(18), color: "var(--text2)" }}>→</button>
              <a href={externalUrl(open.url) || undefined} target="_blank" rel="noreferrer noopener"
                className="px-2 py-0.5 rounded" style={{ border: edge(18), color: "var(--text2)" }} title="Open the file itself">Open ↗</a>
              {/* The app's one close control — same grid, same stroke, and a target
                  you can actually hit. See CloseButton. */}
              <CloseButton onClick={() => setAt(null)} title="Close (Esc)" />
            </span>
          </div>
          {/*
            * The picture, and the gestures that belong to a picture.
            *
            * Any wheel zooms it, Ctrl or no Ctrl: with a screenshot open, that gesture
            * means this picture. Dragging pans once there is something to pan.
            * Double-click is the toggle everybody tries first: fit, then twice life
            * size, then fit again.
            *
            * `onWheel` is passive:false by way of React's synthetic handler plus the
            * preventDefault below, which is what stops the page (and the app) taking
            * the gesture instead.
            */}
          <div ref={stage} className="flex-1 min-h-0 overflow-hidden grid place-items-center p-4"
            onClick={() => setAt(null)}
            onDoubleClick={(e) => { e.stopPropagation(); if (zoom === 1) setZoom(2); else reset(); }}
            onPointerDown={(e) => {
              if (zoom <= 1) return;
              drag.current = { x: e.clientX, y: e.clientY, ox: pan.x, oy: pan.y };
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              setPan({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
            }}
            onPointerUp={() => { drag.current = null; }}
            style={{ cursor: zoom > 1 ? (drag.current ? "grabbing" : "grab") : "default" }}>
            {/* The thumbnail, already in the browser from the grid, standing in until
                the real one arrives. It is the same picture at 300px — so the moment
                you press →, what you see IS the next screenshot, blurred, rather than
                the previous one pretending nothing happened. */}
            <div className="relative grid place-items-center" style={{ maxWidth: "100%", maxHeight: "100%" }}
              onClick={(e) => e.stopPropagation()}>
              {open.thumb && shown !== open.id && !isVideo(open) && (
                <img src={open.thumb} alt="" aria-hidden draggable={false}
                  style={{
                    maxWidth: "100%", maxHeight: "100%", objectFit: "contain",
                    filter: "blur(2px)", opacity: 0.55,
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  }} />
              )}
              {isVideo(open) ? (
                /*
                 * `preload="none"`, and that is the whole point.
                 *
                 * It was "metadata", which sounds cheap and is not — for THIS
                 * kind of file. Reported as "it takes ages and does not play —
                 * is it actually DOWNLOADING it?", and it was.
                 *
                 * Measured rather than guessed, and the first two guesses were
                 * both wrong. The host answers range requests (206,
                 * accept-ranges: bytes), so it is not a server that refuses to
                 * seek. The codec is avc1 — H.264 — which this browser plays
                 * fine, so it is not an undecodable file either.
                 *
                 * It is where QuickTime puts the metadata. A .mov written by a
                 * screen recorder keeps its `moov` atom at the END, so "just
                 * the metadata" means reading to the end of a 21.6 MB file
                 * before the player can show a duration. Asking for nothing
                 * until Play is the only honest setting here.
                 *
                 * No autoplay either — a recording that starts talking the
                 * moment a card opens is why people mute browsers.
                 */
                <video key={open.id} src={playableUrl(open)} controls preload="none" poster={open.thumb}
                  onError={() => setBroke(open.id)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ maxWidth: "100%", maxHeight: "100%", outline: "none", display: broke === open.id ? "none" : undefined }} />
              ) : (
              <img key={open.id} src={open.url} alt={open.title} draggable={false}
                /* `complete` as well as `onLoad`: an image already in the cache can be
                   done before React has attached the handler, and a spinner that never
                   clears is worse than no spinner. */
                ref={(el) => { if (el?.complete) setShown(open.id); }}
                onLoad={() => setShown(open.id)}
                onError={() => setShown(open.id)}
                style={{
                  maxWidth: "100%", maxHeight: "100%", objectFit: "contain",
                  ...(open.thumb && shown !== open.id
                    ? { position: "absolute", opacity: 0, pointerEvents: "none" as const }
                    : null),
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: "center",
                  transition: drag.current ? "none" : "transform 90ms ease-out",
                }} />
              )}
              {/* A player draws its own state: a poster, a spinner while it
                  buffers, a time that moves. Ours on top of it was a second
                  spinner over a picture that never cleared, because nothing is
                  being loaded until Play is pressed. */}
              {isVideo(open) && broke === open.id && (
                <span className="absolute flex flex-col items-center gap-2 px-3 py-2.5 rounded-lg text-[11.5px] text-center"
                  style={{ background: "color-mix(in srgb, var(--bg) 88%, transparent)", border: edge(18), color: "var(--text2)", maxWidth: 340 }}>
                  <span>This browser could not play {open.ext ? `this .${open.ext}` : "this file"}.</span>
                  <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>
                    Usually a codec it has no decoder for — some recorders write HEVC. It will open outside.
                  </span>
                  <a href={open.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                    className="text-[11px] px-2.5 py-1 rounded-lg"
                    style={{ border: edge(28), color: "var(--text)" }}>Open it outside ↗</a>
                </span>
              )}
              {shown !== open.id && !isVideo(open) && (
                <span className="absolute flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[10.5px]"
                  style={{ background: "color-mix(in srgb, var(--bg) 80%, transparent)", border: edge(18), color: "var(--text2)" }}>
                  <span className="agx-spin" aria-hidden style={{ width: 11, height: 11, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />
                  Loading{open.size ? ` ${fileSize(open.size)}` : ""}…
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
