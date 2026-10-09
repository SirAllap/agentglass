/*
 * The file the finder has selected, as three things the panes need at once: its
 * facts (the rail), its text (the reader and the outline) and, for a picture or
 * a PDF, its bytes (the reader).
 *
 * One hook so the centre and the right rail cannot be looking at two different
 * moments of the same file, and so walking the list with the arrow keys costs
 * one cheap facts call per row while the bytes wait until the selection settles
 * (SETTLE_MS) — a 12MB screenshot is fetched for the row you stopped on, not for
 * the forty you passed. The object URL is revoked on every change and on
 * unmount, or a session of browsing a photo folder holds every photo it drew.
 *
 * A file found on a BRANCH is not on disk, so it has no facts and no bytes: its
 * text is read from the object store by `filesRead`, as the document viewer
 * always did.
 */
import { useEffect, useRef, useState } from "react";
import type { FileFacts } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { viewerKind, type ViewerKind } from "../../lib/finderViewer.ts";

export const SETTLE_MS = 220;

export interface FileSource {
  /** Absolute path on disk; null for a file that only exists on a ref. */
  abs: string | null;
  root: string;
  rel: string;
  ref?: string;
}

export interface LoadedFile {
  source: FileSource | null;
  name: string;
  kind: ViewerKind | null;
  facts: FileFacts | null;
  text: string | null;
  truncated: boolean;
  error: string | null;
  media: { url: string; mime: string } | null;
  mediaError: string | null;
  /** Facts or text still on their way. */
  loading: boolean;
}

const BYTES = new Set(["image", "image-convert", "pdf", "video", "audio"]);

export function useFileSource(source: FileSource | null): LoadedFile {
  const key = source ? `${source.abs ?? `${source.root}:${source.rel}`}@${source.ref ?? ""}` : "";
  const [facts, setFacts] = useState<FileFacts | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [media, setMedia] = useState<{ url: string; mime: string } | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const url = useRef<string | null>(null);
  const drop = () => { if (url.current) { URL.revokeObjectURL(url.current); url.current = null; } setMedia(null); };

  useEffect(() => {
    drop(); setMediaError(null); setFacts(null); setText(null); setTruncated(false); setError(null);
    if (!source) return;
    let live = true;
    if (source.abs && !source.ref) {
      void api.previewFacts(source.abs).then((f) => {
        if (!live) return;
        setFacts(f);
        if (!f.ok) setError(f.error ?? "cannot be read");
        else if (f.kind === "text") { setText(f.text ?? ""); setTruncated(!!f.textTruncated); }
      }).catch((e) => { if (live) setError(String(e)); });
    } else {
      void api.filesRead(source.root, source.rel, source.ref).then((r) => {
        if (!live) return;
        if (r.ok) { setText(r.text); setTruncated(!!r.truncated); } else setError(r.error || "Could not read that file");
      }).catch((e) => { if (live) setError(String(e)); });
    }
    return () => { live = false; };
    // `key` stands for the whole source; the object is a new one per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const abs = source?.abs;
    if (!abs || source?.ref || !facts?.ok || !BYTES.has(facts.kind)) return;
    if (facts.kind === "image-convert" && !facts.converter) return;
    let live = true;
    const t = setTimeout(() => {
      void api.previewBlob(abs).then((r) => {
        if (!live) { if (r.ok) URL.revokeObjectURL(r.url); return; }
        if (!r.ok) { setMediaError(r.error); return; }
        url.current = r.url;
        setMedia({ url: r.url, mime: r.mime });
      });
    }, SETTLE_MS);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, facts?.ok, facts?.kind, facts?.converter]);

  useEffect(() => drop, []);

  const name = source ? source.rel.slice(source.rel.lastIndexOf("/") + 1) : "";
  const kind = source ? viewerKind(name, facts?.ok ? facts.kind : undefined) : null;
  return {
    source, name, kind, facts, text, truncated, error, media, mediaError,
    loading: !!source && !error && (source.abs && !source.ref ? !facts : text === null),
  };
}
