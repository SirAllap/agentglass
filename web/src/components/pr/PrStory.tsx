import type { ReactNode } from "react";
import { Button } from "../workspace/Chrome.tsx";
import { EditIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { PrSection } from "./PrSection.tsx";

/** "What changed": the description in the prose face. `data-pr-body` is the address mentions jump to. */
export function PrStory({ onEdit, busy, children }: { onEdit: () => void; busy: boolean; children: ReactNode }) {
  return (
    <PrSection title="What changed" testid="pr-story"
      action={<Button size="compact" tone="quiet" onClick={onEdit} disabled={busy}><EditIcon size={ICON.xs} />Edit</Button>}>
      <div className="prov-story" data-pr-body>{children}</div>
    </PrSection>
  );
}
