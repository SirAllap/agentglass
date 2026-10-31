import type { CSSProperties, ReactNode } from "react";
import { WarningIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";

/**
 * The panel's one "this cannot be shown" box (the mockup's error box): a red
 * ring, a tile, what is wrong, what the board does about it, the raw reason in
 * mono when there is one, and the ways out underneath.
 */
export function PrNotice({ title, children, reason, actions, tone = "var(--error)" }: {
  title: string; children: ReactNode; reason?: string; actions: ReactNode; tone?: string;
}) {
  return (
    <div className="agx-blank h-full">
      <div className="agx-notice" style={{ "--tone": tone } as CSSProperties} role="alert">
        <div className="agx-notice-head">
          <span aria-hidden className="agx-blank-tile"><WarningIcon size={ICON.lg} /></span>
          <div className="text-left min-w-0">
            <div className="agx-blank-t">{title}</div>
            <div className="agx-blank-s">{children}</div>
          </div>
        </div>
        {reason && <pre className="agx-notice-pre">{reason}</pre>}
        <div className="agx-notice-act">{actions}</div>
      </div>
    </div>
  );
}
