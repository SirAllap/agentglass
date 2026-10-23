import { useState } from "react";
import { LINE } from "../workspace/Chrome.tsx";

/**
 * The picture a plugin ships for its card: the `preview` its market listing
 * carries (an https URL the server already vetted, see plugin-catalogue.ts).
 * A card without one, or one whose picture fails to load, draws nothing rather
 * than a hole, so the four zones under it never move.
 */
export function PluginPreview({ src, name }: { src: string | undefined; name: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (!src || broken === src) return null;
  return (
    <div className="shrink-0 overflow-hidden" style={{ aspectRatio: "16 / 9", background: "var(--surface-inset)", borderBottom: LINE }}>
      {/* no-referrer: the listing's host learns a picture was read, not from which app. */}
      <img src={src} alt={`${name} preview`} loading="lazy" referrerPolicy="no-referrer" draggable={false}
        onError={() => setBroken(src)} className="block w-full h-full" style={{ objectFit: "cover", objectPosition: "top" }} />
    </div>
  );
}
