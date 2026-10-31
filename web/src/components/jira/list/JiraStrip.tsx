/*
 * The strip between the chips and the lanes: a 2 high progress line that is always there (so a read starting moves
 * nothing) and, under it, one note when something needs saying: a failed read with cards still on screen, or a drop the
 * site refused. One flex column with a gap of 12, so a note is never glued to the chips above it.
 */
import { CrossIcon, WarningIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { Ctl, ListIconBtn } from "./ListControls.tsx";
import { staleNote } from "./laneModel.ts";
import type { JiraListModel } from "./model.ts";

export interface JiraStripProps {
  model: JiraListModel;
  onRefresh: () => void;
}

function Note({ tone, text, children }: { tone: "warn" | "err" | "info"; text: string; children: React.ReactNode }) {
  return (
    <div className="agx-jl-note" data-tone={tone} role="status">
      <WarningIcon size={ICON.sm} />
      <span>{text}</span>
      {children}
    </div>
  );
}

export function JiraStrip({ model, onRefresh }: JiraStripProps) {
  const note = staleNote(model);
  const busy = model.refreshing || model.phase === "loading";
  return (
    <div data-slot="strip" className="flex flex-col shrink-0" style={{ gap: 12 }}>
      <div className="agx-jl-ld" role="progressbar" aria-label="Reading" aria-hidden={!busy} aria-busy={busy}>{busy && <i />}</div>
      {note && <Note tone={note.tone} text={note.text}><Ctl compact onClick={onRefresh}>Try now</Ctl></Note>}
      {model.said && (
        <Note tone="err" text={model.said.text}>
          <ListIconBtn label="Dismiss" size={22} onClick={model.dismissSaid}><CrossIcon size={ICON.xs} /></ListIconBtn>
        </Note>
      )}
    </div>
  );
}
