import type { ReactNode } from "react";
import { Avatar } from "../Avatar.tsx";
import { Button } from "../workspace/Chrome.tsx";
import type { ActivityItem } from "../../lib/prOverviewBody.ts";
import { PrSection } from "./PrSection.tsx";

/** The latest two things people wrote, so the Overview is not a dead end. "Open N" is the Conversation tab. */
export function PrActivityPreview({ items, total, onOpen, when, renderBody }: {
  items: ActivityItem[]; total: number; onOpen: () => void; when: (iso: string) => string;
  /** Draws an excerpt as markdown (the Conversation tab's renderer, passed in so this file does not import the panel). */
  renderBody?: (body: string) => ReactNode;
}) {
  if (!items.length) return null;
  return (
    <PrSection title="Latest in the conversation" testid="pr-activity-preview"
      action={<Button size="compact" tone="quiet" onClick={onOpen}>Open {total}</Button>}>
      <div className="prov-tl">
        {items.map((it) => (
          <div key={it.id} className="prov-ev">
            <span className="prov-ev-gl"><Avatar login={it.author} size={20} /></span>
            <div>
              <div className="prov-ev-hd"><b>{it.author}</b><span>{it.verb} {when(it.at)}</span></div>
              {it.body && <div className="prov-ev-tx">{renderBody ? renderBody(it.body) : it.body}</div>}
            </div>
          </div>
        ))}
      </div>
    </PrSection>
  );
}
