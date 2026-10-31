import type { ListStatus, ProviderTask } from "../../../../../shared/providers.ts";
import { ContextMenu } from "../../ContextMenu.tsx";
import { useMenuAt } from "../../tasks/TaskMenu.tsx";
import { Caret, Ctl } from "./ListControls.tsx";
import { MenuHead, MenuRowBtn, MenuRule } from "./MenuParts.tsx";
import { statusMenuOf, statusTrigger, togglePick, type StatusRow } from "./toolbarModel.ts";

/** Multi-select over the board's statuses: stays open on a pick, working ones first, finished ones under "Done", each with a dot and a count. */
export function StatusMenu({ statuses, cards, picked, onPick }: {
  statuses: readonly ListStatus[]; cards: readonly ProviderTask[]; picked: string[]; onPick: (v: string[]) => void;
}) {
  const { at, open, close } = useMenuAt();
  if (!statuses.length) return null;
  const { working, finished } = statusMenuOf(statuses, cards, picked);
  const row = (r: StatusRow) => (
    <MenuRowBtn key={r.status} on={r.on} count={r.count} label={r.status} onClick={() => onPick(togglePick(picked, r.status))}
      lead={<span aria-hidden className="shrink-0" style={{ width: 8, height: 8, borderRadius: 99, background: r.color || "var(--text3)" }} />}>
      {r.status.toUpperCase()}
    </MenuRowBtn>
  );
  return (
    <>
      <Ctl pressed={picked.length > 0} aria-haspopup="menu" aria-expanded={!!at} onClick={(e) => open(e.currentTarget)}
        tip={{ name: "Status", text: "Show only the cards in the statuses you pick.", hint: { text: "Click to choose" } }}>
        {statusTrigger(picked)} <Caret />
      </Ctl>
      {at && (
        <ContextMenu x={at.x} y={at.y} onClose={close} width={252} plain label="Status">
          <MenuHead>Status</MenuHead>
          {working.map(row)}
          {!!finished.length && <><MenuRule /><MenuHead>Done</MenuHead>{finished.map(row)}</>}
          {!!picked.length && <><MenuRule /><MenuRowBtn label="Clear" onClick={() => { onPick([]); close(); }}>Clear</MenuRowBtn></>}
        </ContextMenu>
      )}
    </>
  );
}
