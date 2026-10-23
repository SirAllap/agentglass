import type { ReactNode } from "react";
import { SettingsCard } from "../SettingsKit.tsx";

/**
 * A page with a live preview: the cards on the left, the preview on the right
 * in view while the left scrolls, stacked (preview after the cards) under
 * 1280px. The preview is handed the page's own current values, so the picture
 * follows each control and there is no second copy of the state.
 */
export function WithPreview({ preview, children }: { preview: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-4 items-start">
      <div className="min-w-0">{children}</div>
      <div className="min-w-0 xl:sticky" style={{ top: "calc(var(--agx-ph-h, 0px) + 16px)" }}>{preview}</div>
    </div>
  );
}

/** The card a preview sits in. `data-preview-slot` names the page it follows. */
export function PreviewCard({ id, title, actions, children }: { id: string; title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <SettingsCard title={title} actions={actions}>
      <div data-preview-slot={id} className="px-4 py-3">{children}</div>
    </SettingsCard>
  );
}
