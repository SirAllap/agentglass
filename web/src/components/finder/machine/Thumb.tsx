// An image's own picture, drawn by the browser: in Icons view a tile, in a row the
// 17 px square Strata draws in place of the file icon. A file the browser cannot
// decode falls back to what the caller draws instead: the row never shows a broken image.
import { useState } from "react";
import { api } from "../../../lib/api.ts";

export function Thumb({ path, size, radius, fallback }: { path: string; size: number; radius: number; fallback: React.ReactNode }) {
  const [bad, setBad] = useState(false);
  if (bad) return <>{fallback}</>;
  return <img src={api.previewUrl(path)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBad(true)}
    style={{ width: size, height: size, objectFit: "cover", borderRadius: radius, background: "color-mix(in srgb, var(--text) 7%, transparent)" }} />;
}
