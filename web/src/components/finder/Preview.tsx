/*
 * What the thing under the cursor actually is.
 *
 * The finder could name files and not show them, so "is this the screenshot I
 * mean?" was answered by opening it — and opening a `.png` sent it to the
 * floating nvim modal, which nobody asked for and which cannot draw a picture.
 * This is the other half: a pane that shows the file where it is, for every
 * kind of file the finder can reach.
 *
 * Two costs are managed here and they are the reason this is a component and
 * not three lines in the palette:
 *
 *   - FACTS ARE CHEAP, BYTES ARE NOT. Walking the list with ↓ asks for facts on
 *     every row; a 12MB screenshot's bytes are asked for only once the cursor
 *     settles. Both are dropped when the cursor moves on.
 *   - A BLOB URL IS A LEAK UNTIL IT IS REVOKED. One per image, revoked on every
 *     change and on unmount, or a session of browsing a photo folder holds
 *     every photo it ever drew.
 */
import { useEffect, useRef, useState } from "react";
import type { FileFacts } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { CODE_FONT_STYLE } from "../diff/DiffLines.tsx";

/** How long the cursor has to stay on a row before its bytes are fetched.
 *  Long enough that holding ↓ through forty rows fetches nothing. */
const SETTLE_MS = 220;

const human = (bytes: number): string => {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1000;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
};

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 14 ? `${d} d ago` : `${Math.round(d / 7)} wk ago`;
};

export function Preview({ path, onOpen, onCopyPath, compact }: {
  /** Absolute path of the row under the cursor, or null for nothing selected. */
  path: string | null;
  /** Open it properly — the editor for text, the desktop for the rest. */
  onOpen?: (path: string, facts: FileFacts) => void;
  onCopyPath?: (path: string) => void;
  /** Half the height, for when the palette is sharing the screen with a
   *  document underneath it. */
  compact?: boolean;
}) {
  const [facts, setFacts] = useState<FileFacts | null>(null);
  const [media, setMedia] = useState<{ url: string; mime: string } | null>(null);
  const [mediaErr, setMediaErr] = useState<string | null>(null);
  /** Why the desktop would not take it — said next to the button that asked. */
  const [openErr, setOpenErr] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  /** Drop whatever object URL is held. Called on every change and on unmount:
   *  a blob URL lives until it is revoked, whatever happens to the element. */
  const dropMedia = () => {
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setMedia(null);
  };

  useEffect(() => {
    dropMedia();
    setMediaErr(null);
    setOpenErr(null);
    setFacts(null);
    if (!path) return;
    let live = true;
    void api.previewFacts(path).then((f) => { if (live) setFacts(f); }).catch(() => { /* the pane simply stays empty */ });
    return () => { live = false; };
  }, [path]);

  // The bytes, only once the cursor has settled and only for what is worth
  // drawing. Everything else — binaries, folders — has nothing to fetch.
  useEffect(() => {
    if (!path || !facts?.ok) return;
    if (!["image", "image-convert", "pdf", "video", "audio"].includes(facts.kind)) return;
    if (facts.kind === "image-convert" && !facts.converter) return;
    let live = true;
    const t = setTimeout(() => {
      void api.previewBlob(path).then((r) => {
        if (!live) { if (r.ok) URL.revokeObjectURL(r.url); return; }
        if (!r.ok) { setMediaErr(r.error); return; }
        urlRef.current = r.url;
        setMedia({ url: r.url, mime: r.mime });
      });
    }, SETTLE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [path, facts?.ok, facts?.kind, facts?.converter]);

  useEffect(() => dropMedia, []);

  if (!path) {
    return (
      <div className="flex-1 grid place-items-center text-[11px] t-dim2 px-4 text-center">
        Nada seleccionado
      </div>
    );
  }
  if (!facts) {
    return <div className="flex-1 grid place-items-center"><span className="agx-spin" aria-hidden="true" /></div>;
  }
  if (!facts.ok) {
    return (
      <div className="flex-1 grid place-items-center text-[11px] px-4 text-center" style={{ color: "var(--warning)" }}>
        {facts.error ?? "cannot be read"}
      </div>
    );
  }

  const box = compact ? 150 : 320;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* The facts, always, whatever the file turns out to be. This is the part
          that answers "which one is this" for a binary the pane cannot draw. */}
      <div className="px-3 py-2 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
        <div className="text-[12px] truncate" style={{ color: "var(--text)" }} title={facts.name}>{facts.name}</div>
        <div className="text-[10px] t-dim2 flex items-center gap-2 flex-wrap">
          <span>{facts.kind === "dir" ? "carpeta" : facts.mime.split(";")[0] || facts.kind}</span>
          {facts.width && facts.height ? <span>{facts.width}×{facts.height}</span> : null}
          {facts.kind !== "dir" && <span>{human(facts.bytes)}</span>}
          <span>{ago(facts.mtime)}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-1.5">
          {/*
            * "Abrir" is not one action.
            *
            * A text file opens in the editor, which is what an editor is for. A
            * picture, a pdf, a video opens in whatever this desktop opens those
            * with — sending them to the editor is how "abrir" on a PNG drew a
            * floating nvim with a binary in it, which is the report this fixes.
            */}
          {facts.kind === "text" || facts.kind === "binary" ? (
            onOpen && (
              <button onClick={() => onOpen(path, facts)}
                className="text-[10px] px-2 py-0.5 rounded-md min-h-[20px]"
                style={{ color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }}>
                editar
              </button>
            )
          ) : facts.kind !== "dir" ? (
            <button onClick={() => { setOpenErr(null); void api.previewOpen(path).then((r) => { if (!r.ok) setOpenErr(r.error ?? "no se pudo abrir"); }); }}
              className="text-[10px] px-2 py-0.5 rounded-md min-h-[20px]"
              style={{ color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }}
              title="Open with the desktop application">
              abrir
            </button>
          ) : null}
          {openErr && <span className="text-[9.5px]" style={{ color: "var(--warning)" }}>{openErr}</span>}
          {onCopyPath && (
            <button onClick={() => onCopyPath(path)}
              className="text-[10px] px-2 py-0.5 rounded-md min-h-[20px]"
              style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
              copiar ruta
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto agx-scroll">
        {facts.kind === "image" || facts.kind === "image-convert" ? (
          media ? (
            <div className="grid place-items-center p-3">
              {/* object-fit rather than a fixed size: a screenshot and an icon
                  are both images and neither should be stretched to the other's
                  shape. The checkerboard is what makes transparency legible. */}
              <img src={media.url} alt={facts.name}
                style={{
                  maxWidth: "100%", maxHeight: box, objectFit: "contain",
                  background: "repeating-conic-gradient(color-mix(in srgb, var(--text) 6%, transparent) 0% 25%, transparent 0% 50%) 50% / 16px 16px",
                  borderRadius: 6,
                }} />
            </div>
          ) : mediaErr ? (
            <div className="p-3 text-[11px]" style={{ color: "var(--warning)" }}>{mediaErr}</div>
          ) : facts.kind === "image-convert" && !facts.converter ? (
            /* An image the browser will not draw and this machine cannot
               convert. Saying which tool would do it beats "binary file". */
            <div className="p-3 text-[11px] t-dim2">
              This format needs converting and this machine has no tool for it
              (<span style={{ color: "var(--text2)" }}>magick</span>, <span style={{ color: "var(--text2)" }}>convert</span>,
              <span style={{ color: "var(--text2)" }}> heif-convert</span> o <span style={{ color: "var(--text2)" }}>ffmpeg</span>).
            </div>
          ) : (
            <div className="p-6 grid place-items-center"><span className="agx-spin" aria-hidden="true" /></div>
          )
        ) : facts.kind === "text" ? (
          <pre className="px-3 py-2 text-[10.5px] leading-[1.55] whitespace-pre-wrap break-all m-0"
            style={{ ...CODE_FONT_STYLE, color: "var(--text2)" }}>
            {facts.text}
            {facts.textTruncated && <span className="t-dim2">{"\n\n… the rest does not fit in a preview"}</span>}
          </pre>
        ) : facts.kind === "pdf" ? (
          media
            ? <embed src={media.url} type="application/pdf" style={{ width: "100%", height: box + 60 }} />
            : <div className="p-6 grid place-items-center"><span className="agx-spin" aria-hidden="true" /></div>
        ) : facts.kind === "video" ? (
          media
            ? <video src={media.url} controls style={{ maxWidth: "100%", maxHeight: box }} />
            : <div className="p-6 grid place-items-center"><span className="agx-spin" aria-hidden="true" /></div>
        ) : facts.kind === "audio" ? (
          media ? <div className="p-3"><audio src={media.url} controls style={{ width: "100%" }} /></div>
            : <div className="p-6 grid place-items-center"><span className="agx-spin" aria-hidden="true" /></div>
        ) : facts.kind === "dir" ? (
          <div className="p-3 text-[11px] t-dim2">A folder — <span style={{ color: "var(--text2)" }}>⏎</span> to enter</div>
        ) : (
          /* Not drawable, and that is a fact rather than a failure. The facts
             above are still the answer to "which file is this". */
          <div className="p-3 text-[11px] t-dim2">No preview for this kind of file</div>
        )}
      </div>

      <div className="px-3 py-1 border-t shrink-0 text-[9.5px] t-dim2 truncate" title={path}
        style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
        {path}
      </div>
    </div>
  );
}
