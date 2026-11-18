// An image's own picture: in Icons view a tile, in a row the 17 px square Strata
// draws in place of the file icon. A file the browser cannot decode falls back to
// what the caller draws instead: the row never shows a broken image.
//
// The picture is a thumbnail made once per file version (lib/finderThumb.ts), not
// the file. Pointed at the file, 22 screenshots of 0.6 MB were fetched whole and
// decoded at about 5 megapixels each for 17 px, and again on every scroll back,
// because the file route is `no-store` and a virtual row unmounts.
import { memo, useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { thumbEdge, thumbKey, thumbNow, thumbPlan, thumbUrl } from "../../../lib/finderThumb.ts";

interface ThumbProps { path: string; name: string; mtime: number; bytes: number | null; size: number; radius: number; fallback: React.ReactNode }

/** The same picture: everything but `fallback`, which the row builds new on every render and which only depends on the file these already name. */
export function sameThumb(a: Omit<ThumbProps, "fallback">, b: Omit<ThumbProps, "fallback">): boolean {
  return a.path === b.path && a.name === b.name && a.mtime === b.mtime && a.bytes === b.bytes && a.size === b.size && a.radius === b.radius;
}

/* A memo, because the list re-renders every row on each selection change (the
   selected name is a prop of the column) and a row's picture does not depend on
   which row is selected. Guessed, not measured: a re-render here is two hooks
   and an unchanged <img>, so this is the small one of the finder's lag causes. */
export const Thumb = memo(function Thumb({ path, name, mtime, bytes, size, radius, fallback }: ThumbProps) {
  const plan = thumbPlan(name, bytes);
  const edge = thumbEdge(size, typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  const key = thumbKey(path, mtime, bytes, edge);
  // Read while rendering, so a row that scrolls back paints its picture in the same frame it mounts.
  const [made, setMade] = useState<{ key: string; url: string | null } | null>(() => { const url = plan === "shrink" ? thumbNow(key) : undefined; return url ? { key, url } : null; });
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setBad(false);
    if (plan !== "shrink") return;
    const have = thumbNow(key);
    if (have) { setMade({ key, url: have }); return; }
    const leave = new AbortController();
    void thumbUrl(key, api.previewUrl(path), edge, leave.signal).then((url) => { if (!leave.signal.aborted) setMade({ key, url }); });
    return () => leave.abort();
  }, [key, plan, path, edge]);
  if (bad || plan === "icon") return <>{fallback}</>;
  const box = { width: size, height: size, borderRadius: radius, background: "color-mix(in srgb, var(--text) 7%, transparent)" } as const;
  const mine = made && made.key === key ? made : null;
  // The same box while the thumbnail is made, so the name beside it never moves.
  if (plan === "shrink" && !mine) return <span aria-hidden style={{ ...box, display: "block" }} />;
  // A null url is "this window could not shrink it": the file itself, as before.
  const src = plan === "shrink" && mine?.url ? mine.url : api.previewUrl(path);
  return <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBad(true)} style={{ ...box, objectFit: "cover" }} />;
}, sameThumb);
