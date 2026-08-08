// Draw on the page, then hand the drawing over.
//
// A canvas on THIS side of the boundary, over the guest — not injected into the
// page. Drawing does not need to touch the site, and a canvas the page cannot
// see is a canvas no site can interfere with. The only thing that crosses the
// boundary is the screenshot, at the moment the markup is handed over: the
// drawing is composed onto it here, so what an agent receives is one image of
// the page with the circles and arrows on it.
import { useCallback, useEffect, useRef, useState } from "react";
import { addShape, COLOURS, emptyMarkup, paintAll, paintShape, redo, undo, WIDTHS, type MarkupTool, type Shape } from "../../lib/markup.ts";
import { requestTermIssue } from "../../lib/termIssue.ts";
import { feedbackWindowName } from "../../lib/pageRef.ts";
import { api } from "../../lib/api.ts";
import type { GitRepoRef } from "../../../../shared/types.ts";
import { CheckoutPicker } from "../CheckoutPicker.tsx";

type Guest = { capturePage(): Promise<{ toDataURL(): string }> } | null;

const TOOLS: { id: MarkupTool; glyph: string; label: string }[] = [
  { id: "pen", glyph: "✎", label: "Draw freehand" },
  { id: "arrow", glyph: "↗", label: "Arrow" },
  { id: "box", glyph: "▭", label: "Box" },
  { id: "ellipse", glyph: "◯", label: "Circle" },
];

export function MarkupLayer({ view, url, onNote, onDone }: {
  view: Guest;
  url: string;
  onNote: (msg: string) => void;
  onDone: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState(emptyMarkup);
  const [tool, setTool] = useState<MarkupTool>("pen");
  const [colour, setColour] = useState(COLOURS[0]!);
  const [width, setWidth] = useState(WIDTHS[1]!);
  const drawing = useRef<Shape | null>(null);
  const [, bump] = useState(0);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.gitRepos().then((r) => { setRepos(r.repos ?? []); setRepo((c) => c || r.repos?.[0]?.root || ""); }).catch(() => {});
  }, []);

  /** Repaint everything: the committed shapes plus the one being dragged. */
  const repaint = useCallback(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    paintAll(ctx, state.shapes);
    if (drawing.current) paintShape(ctx, drawing.current);
  }, [state.shapes]);

  /* The canvas is sized in device pixels and scaled back down, or the strokes
     are soft on any display that is not 1×. */
  useEffect(() => {
    const c = canvas.current, box = wrap.current;
    if (!c || !box) return;
    const fit = () => {
      const r = box.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
      const ctx = c.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      repaint();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [repaint]);

  useEffect(repaint, [repaint]);

  const at = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const down = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = { tool, colour, width, points: [at(e), at(e)] };
    bump((n) => n + 1);
  };
  const move = (e: React.PointerEvent) => {
    const d = drawing.current;
    if (!d) return;
    // Freehand keeps the trail; the shapes only ever need where it started and
    // where the pointer is now.
    if (d.tool === "pen") d.points.push(at(e));
    else d.points[1] = at(e);
    repaint();
  };
  const up = () => {
    const d = drawing.current;
    drawing.current = null;
    if (d) setState((s) => addShape(s, d));
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onDone(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setState((s) => (e.shiftKey ? redo(s) : undo(s)));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onDone]);

  /**
   * The page with the drawing on it, as one image.
   *
   * Composed here rather than handed over as two files: an agent given a
   * screenshot and a separate list of strokes has to imagine the result, which
   * is exactly the work the drawing was supposed to save.
   */
  const compose = useCallback(async (): Promise<string | null> => {
    if (!view) return null;
    const shot = await view.capturePage().then((i) => i.toDataURL()).catch(() => null);
    if (!shot) return null;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = shot; });
    const out = document.createElement("canvas");
    out.width = img.naturalWidth;
    out.height = img.naturalHeight;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    // The overlay is measured in CSS pixels of the pane; the capture is in the
    // page's own pixels. Scale the strokes rather than the image, so the page
    // itself is untouched.
    const box = wrap.current?.getBoundingClientRect();
    if (box && box.width) ctx.scale(out.width / box.width, out.height / (box.height || box.width));
    paintAll(ctx, state.shapes);
    return out.toDataURL("image/png");
  }, [view, state.shapes]);

  const copy = async () => {
    if (!state.shapes.length) return onNote("Nothing drawn yet");
    setBusy(true);
    try {
      const png = await compose();
      if (!png) return onNote("The page could not be captured");
      const blob = await (await fetch(png)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      onNote("The marked-up page is on your clipboard");
    } catch { onNote("The markup could not be copied"); }
    finally { setBusy(false); }
  };

  /*
   * Handing a drawing to an agent in a terminal.
   *
   * The image goes to a file rather than into the prompt: a tmux window takes
   * text, and a data URL of a megabyte pasted into a shell is not text anybody
   * wants. The agent is told where the file is, which it can read.
   */
  const hand = async () => {
    if (!state.shapes.length) return onNote("Nothing drawn yet");
    const cwd = repo || repos[0]?.root;
    if (!cwd) return onNote("No repository is open for an agent to work in");
    setBusy(true);
    try {
      const png = await compose();
      if (!png) return onNote("The page could not be captured");
      const saved = await api.saveScratchImage(png, "page-markup");
      if (!saved.ok || !saved.path) return onNote(saved.error || "The image could not be saved");
      requestTermIssue(cwd, feedbackWindowName(url), [
        "I have marked up a page I am looking at and want the marked parts changed.",
        "",
        `Page: ${url}`,
        `The screenshot with my drawing on it: ${saved.path}`,
        "",
        "Read that image. The circles, boxes and arrows on it are mine — they point at what",
        "is wrong. Find where each one is produced in the source and make the change.",
        "Explain anything you had to decide. Do not commit — leave it for me to review.",
      ].join("\n"), true);
      onNote(`Handed to Claude in a tmux window, with the image at ${saved.path.split("/").pop()}`);
      onDone();
    } catch { onNote("The markup could not be handed over"); }
    finally { setBusy(false); }
  };

  return (
    <div ref={wrap} className="absolute inset-0" style={{ zIndex: 30 }}>
      <canvas ref={canvas}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        className="absolute inset-0"
        style={{ cursor: "crosshair", touchAction: "none", background: "transparent" }} />

      <div className="absolute left-1/2 -translate-x-1/2 bottom-4 flex flex-col items-center gap-1.5"
        style={{ pointerEvents: "auto" }}>
        <div className="flex items-center gap-1 px-1.5 py-1 rounded-xl shadow-2xl"
          style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)" }}>
          {TOOLS.map((t) => (
            <button key={t.id} onClick={() => setTool(t.id)} title={t.label}
              className="agx-btn rounded-lg flex items-center justify-center"
              style={{
                width: 26, height: 26, fontSize: 12,
                color: tool === t.id ? "var(--text)" : "var(--text3)",
                background: tool === t.id ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent",
              }}>{t.glyph}</button>
          ))}
          <span style={{ width: 1, height: 16, background: "color-mix(in srgb, var(--border) 45%, transparent)" }} />
          {COLOURS.map((c) => (
            <button key={c} onClick={() => setColour(c)} title={c}
              className="rounded-full shrink-0"
              style={{
                width: 15, height: 15, background: c,
                outline: colour === c ? "2px solid var(--text)" : "none", outlineOffset: 1,
              }} />
          ))}
          <span style={{ width: 1, height: 16, background: "color-mix(in srgb, var(--border) 45%, transparent)" }} />
          {WIDTHS.map((w) => (
            <button key={w} onClick={() => setWidth(w)} title={`${w}px`}
              className="rounded-lg flex items-center justify-center"
              style={{ width: 22, height: 22, background: width === w ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent" }}>
              <span className="rounded-full" style={{ width: w, height: w, background: "var(--text2)", display: "block" }} />
            </button>
          ))}
          <span style={{ width: 1, height: 16, background: "color-mix(in srgb, var(--border) 45%, transparent)" }} />
          <button onClick={() => setState(undo)} disabled={!state.shapes.length} title="Undo (Ctrl+Z)"
            className="agx-btn rounded-lg disabled:opacity-25" style={{ width: 24, height: 24, fontSize: 12, color: "var(--text3)" }}>↶</button>
          <button onClick={() => setState(redo)} disabled={!state.undone.length} title="Redo (Ctrl+Shift+Z)"
            className="agx-btn rounded-lg disabled:opacity-25" style={{ width: 24, height: 24, fontSize: 12, color: "var(--text3)" }}>↷</button>
          <button onClick={() => setState(emptyMarkup())} disabled={!state.shapes.length} title="Clear it all"
            className="agx-btn rounded-lg disabled:opacity-25" style={{ width: 24, height: 24, fontSize: 12, color: "var(--error)" }}>⌫</button>
        </div>

        <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-xl shadow-2xl"
          style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)" }}>
          <span className="text-[10.5px] mr-1" style={{ color: "var(--text3)" }}>
            Draw on the page, then
          </span>
          {repos.length > 1 && (
            <CheckoutPicker repos={repos} value={repo} onPick={setRepo}
              title="Which checkout the agent works in" triggerMaxWidth={180} />
          )}
          <button onClick={() => void hand()} disabled={busy || !state.shapes.length}
            className="agx-btn text-[11px] px-2.5 py-1 rounded-lg disabled:opacity-40"
            style={{ color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>
            ▸_ Hand it to Claude
          </button>
          <button onClick={() => void copy()} disabled={busy || !state.shapes.length}
            className="agx-btn text-[11px] px-2 py-1 rounded-lg disabled:opacity-40"
            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
            Copy it
          </button>
          <button onClick={onDone} className="text-[10px] px-1" style={{ color: "var(--text3)" }}>Done</button>
        </div>
      </div>
    </div>
  );
}
