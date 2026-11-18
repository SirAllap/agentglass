import type { ReactNode } from "react";
import { MoreIcon } from "../../lib/glyphIcons.tsx";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { PrSection } from "./PrSection.tsx";

/** One rail section; the dots button opens the picker for what it lists. */
export function PrRailSection({ title, count, onEdit, children }: {
  title: string; count?: number; onEdit?: (e: React.MouseEvent<HTMLButtonElement>) => void; children: ReactNode;
}) {
  return (
    <PrSection title={title} count={count} rail
      action={onEdit && (
        <button type="button" className="agx-btn prov-dots" aria-label={`Edit ${title.toLowerCase()}`} onClick={onEdit}
          style={{ width: HIT, height: HIT }}><MoreIcon size={ICON.xs} /></button>
      )}>
      {children}
    </PrSection>
  );
}

/** The rail: beside the main column from BP_PAGE, under the story below it (CSS, `.prov-cols`). */
export function PrRail({ children }: { children: ReactNode }) {
  return <aside className="prov-rail" aria-label="Pull request details">{children}</aside>;
}
