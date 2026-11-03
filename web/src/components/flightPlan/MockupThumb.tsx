import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";

/** The page a thumbnail lays out at before it is scaled down to the box. */
const PAGE_W = 1280, PAGE_H = 800;

/**
 * The mockup itself, small: a PNG as an image, an HTML page in a sandboxed
 * iframe scaled to the box. The server serves HTML under a sandbox policy, so
 * the page shows but runs nothing and reaches nothing. A file that is gone or
 * refused falls back to its name.
 * Chosen over a PNG captured at attach time, which needs a browser started per
 * attach: the ceiling is a mockup drawn by script or styled from a CDN, which
 * shows blank or unstyled here. A mockup meant to be seen is self-contained.
 */
export function MockupThumb({ planId, n, kind, name }: { planId: string; n: number; kind: string; name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(242);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 242));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setBad(false), [planId, n]);
  const src = api.flightMockupUrl(planId, n);
  return (
    <div ref={box} className="shot" aria-hidden={bad ? undefined : true}>
      {bad || !src ? <div className="none">{name}</div>
        : kind === "html"
          ? <iframe title={`Mockup: ${name}`} src={src} sandbox="" tabIndex={-1} loading="lazy" onError={() => setBad(true)}
              style={{ width: PAGE_W, height: PAGE_H, transform: `scale(${w / PAGE_W})` }} />
          : <img src={src} alt="" loading="lazy" onError={() => setBad(true)} />}
    </div>
  );
}
