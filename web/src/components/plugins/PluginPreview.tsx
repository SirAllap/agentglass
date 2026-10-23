import { useState, type ReactNode } from "react";
import { LINE } from "../workspace/Chrome.tsx";

/**
 * The top of a plugin card: the picture its market listing ships (an https URL
 * the server already vetted, see plugin-catalogue.ts), or, when there is none
 * or it fails to load, a tile in the plugin's own tint with its mark on it.
 * The Electron CSP lets `img-src` reach only a few hosts, and a blocked image
 * fires `error` like any other, so a listing on another host reads as a tile,
 * never as a broken-image glyph. The box keeps one shape either way, so the
 * zones under it line up from card to card.
 */
export function PluginPreview({ src, name, tint, children }: { src: string | undefined; name: string; tint: string; children: ReactNode }) {
  const [broken, setBroken] = useState<string | null>(null);
  const shown = src && broken !== src;
  return (
    <div className="shrink-0 overflow-hidden grid place-items-center" data-preview={shown ? "image" : "tile"}
      style={{
        aspectRatio: "16 / 9", borderBottom: LINE,
        background: `linear-gradient(145deg, color-mix(in srgb, ${tint} 24%, var(--surface-inset)), var(--surface-inset))`,
      }}>
      {shown
        // no-referrer: the listing's host learns a picture was read, not from which app.
        ? <img src={src} alt={`${name} preview`} loading="lazy" referrerPolicy="no-referrer" draggable={false}
            onError={() => setBroken(src)} className="block w-full h-full" style={{ objectFit: "cover", objectPosition: "top" }} />
        : children}
    </div>
  );
}
