// The state icon of a pinned pull request and the one request that fills it,
// shared by the Terminal bar menu and the PR view's pinned popover.
import { useEffect, useState } from "react";
import { api, type PinState } from "../lib/api.ts";
import { ICON } from "../lib/iconSize.ts";
import { CrossIcon, DraftIcon, MergeIcon, PullRequestIcon } from "../lib/glyphIcons.tsx";
import type { Pin } from "../lib/prPins.ts";
import { GROUP_HEADING } from "./workspace/Chrome.tsx";

const PIN_STATE: Record<PinState, { label: string; color: string; Icon: typeof PullRequestIcon }> = {
  open: { label: "Open", color: "var(--success)", Icon: PullRequestIcon },
  draft: { label: "Draft", color: "var(--text3)", Icon: DraftIcon },
  merged: { label: "Merged", color: "var(--merged)", Icon: MergeIcon },
  closed: { label: "Closed", color: "var(--error)", Icon: CrossIcon },
};

/* Nothing until the answer arrives, so the row does not jump for it. */
export function PinStateIcon({ state }: { state?: PinState }) {
  if (!state) return null;
  const { label, color, Icon } = PIN_STATE[state];
  return <span className="shrink-0 flex" role="img" title={label} aria-label={label} style={{ color }}><Icon size={ICON.sm} /></span>;
}

/* Asked once per opening, for every listed pin in one request (the server
   caches 60 s); a failure leaves the rows as they were. Keyed `repo#number`. */
export function usePinStates(list: readonly Pin[], open: boolean): Record<string, PinState> {
  const [states, setStates] = useState<Record<string, PinState>>({});
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.prPinStates(list.map((p) => `${p.repo}#${p.number}`)).then((r) => { if (live && r.ok) setStates(r.states); }, () => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the pins are read at the moment of opening, not on each pin change
  }, [open]);
  return states;
}

/* The label between the current repository's pins and the others. */
export function OtherReposLabel() {
  return <div className={GROUP_HEADING} style={{ color: "var(--text4)" }}>Other repositories</div>;
}
