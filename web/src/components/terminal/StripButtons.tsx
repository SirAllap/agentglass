/*
 * The pinned pull requests, one click from the shell. Commands moved to
 * CommandsPopover and Resume to the "+" menu (PlusButton).
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { pins as allPins, subscribePins } from "../../lib/prPins.ts";
import { termPins } from "../../lib/termPins.ts";
import { openPr } from "../../lib/openPrs.ts";
import { PinIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { PinList, PIN_MENU_W } from "../PinList.tsx";
import { AnchoredMenu } from "../AnchoredMenu.tsx";
import { Button } from "../workspace/Chrome.tsx";

/* The pinned pull requests, one click from the shell. The button is always
   there, so the place does not move when the first pin arrives; with none the
   count is muted and the popover says how to get one. */
export function PrPinsButton({ repo }: { repo?: string | null }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => subscribePins(bump), []);
  const list = termPins(allPins(), repo);
  const none = list.length === 0;
  return (
    <span ref={box} className="relative shrink-0">
      <Button size="strip" tone="quiet" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}
        label={none ? "Pinned pull requests, none" : `Pinned pull requests, ${list.length}`}
        title={none ? "No pinned pull requests" : `${list.length} pinned pull request${list.length === 1 ? "" : "s"}`}
        className="shrink-0 tabular-nums font-semibold"
        style={{ color: none ? "var(--text3)" : "var(--merged-ink)", paddingInline: 8, gap: 4 }}>
        <PinIcon size={ICON.sm} filled={!none} />{list.length}
      </Button>
      {open && (
        <AnchoredMenu anchor={box} align="right" minWidth={PIN_MENU_W} plain placeKey={list.length} onClose={() => setOpen(false)}>
          <PinList pins={list} repo={repo} grouped onOpen={(p) => { setOpen(false); openPr(p.repo, p.number); }} />
        </AnchoredMenu>
      )}
    </span>
  );
}
