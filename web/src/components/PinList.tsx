// The pinned pull requests as a menu body. The Terminal bar and the PR view
// both open this one component, so the two cannot drift: repositories as
// groups (the current one first), each pin with its state icon, age and an
// unpin cross. The doors only own where it opens.
import { useState } from "react";
import { CloseIcon } from "./CloseButton.tsx";
import { HIT, ICON, MIN_BOX } from "../lib/iconSize.ts";
import { filterPins, togglePin, type Pin } from "../lib/prPins.ts";
import { repoGroups } from "../lib/termPins.ts";
import { PinStateIcon, usePinStates } from "./PinState.tsx";
import { INPUT, INPUT_STYLE, LINE, ListRow } from "./workspace/Chrome.tsx";

/** The filter box appears past this many pins, where scanning by eye stops being quicker. */
export const PIN_FILTER_FROM = 8;
/** The menu's outer width; the list inside is 14px less: the Terminal door pads 6px and borders 1px a side, the PR door 4px. A list as wide as the door made both scroll sideways. */
export const PIN_MENU_W = 420;
const WASH = "color-mix(in srgb, var(--primary) 14%, transparent)";

export function pinAge(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function PinList({ pins, repo, selected, grouped, onOpen, updatedAt, note }: {
  pins: readonly Pin[];
  /** The repository the door is in: its group comes first and carries the "this repo" chip. */
  repo?: string | null;
  /** The pull request on screen, tinted; the Terminal has none. */
  selected?: number | null;
  /** A repository header (avatar, name, count) even over one repository: the Terminal's popover always shows where a pin lives. */
  grouped?: boolean;
  onOpen: (p: Pin) => void;
  /** A fresher moment than the pin's own, when the door knows one. */
  updatedAt?: (p: Pin) => string | undefined;
  /** What the checks are doing, for the row tooltip, when the door knows. */
  note?: (p: Pin) => string | undefined;
}) {
  const [q, setQ] = useState("");
  // Mounted only while the menu is open, so this is one request per opening.
  const states = usePinStates(pins, true);
  const filtering = pins.length > PIN_FILTER_FROM;
  const shown = filtering ? filterPins(pins, q) : pins;
  const groups = repoGroups(shown, repo);
  const several = grouped || groups.length > 1;

  const row = (p: Pin) => {
    const cur = p.repo === repo && p.number === selected;
    const key = `${p.repo}#${p.number}`;
    return (
      <div key={key} className="flex items-center rounded-lg" style={{ minHeight: HIT, background: cur ? WASH : undefined }}>
        <div className="flex-1 min-w-0">
          <ListRow role="menuitem" current={cur} onClick={() => onOpen(p)} title={note?.(p) ?? `${key} — ${p.title}`}
            leading={<PinStateIcon state={states[key]} />}>
            <span className="tabular-nums" style={{ fontWeight: 600 }}>#{p.number}</span>{" "}{p.title}
          </ListRow>
        </div>
        <span className="shrink-0 w-9 text-right tabular-nums text-[10px] mr-1" style={{ color: "var(--text4)" }}>{pinAge(updatedAt?.(p) ?? new Date(p.at).toISOString())}</span>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => togglePin(p.repo, p.number, p.title)}
          title={`Unpin #${p.number}`} aria-label={`Unpin #${p.number}`}
          className="agx-btn leading-none grid place-items-center shrink-0 rounded-md mr-1"
          style={{ color: "var(--text3)", width: MIN_BOX, height: MIN_BOX }}>
          <CloseIcon size={ICON.xs} />
        </button>
      </div>
    );
  };

  return (
    <div style={{ width: PIN_MENU_W - 14, maxWidth: "calc(100vw - 46px)" }}>
      <div className="px-2.5 pt-1 pb-1 text-[10px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>Pinned ({pins.length})</div>
      {filtering && (
        <div className="px-1 pb-1">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by number or title"
            aria-label="Filter pinned pull requests" className={`${INPUT} w-full`} style={INPUT_STYLE} />
        </div>
      )}
      <div className="overflow-y-auto overflow-x-hidden agw-noscrollbar" style={{ maxHeight: 336 }}>
        {pins.length === 0 && <div className="px-2.5 py-3 text-[11px] leading-snug" style={{ color: "var(--text3)" }}>Nothing pinned yet. Pin a pull request from its page and it waits here.</div>}
        {pins.length > 0 && shown.length === 0 && <div className="px-2.5 py-2 text-[11px]" style={{ color: "var(--text3)" }}>No pinned pull request matches.</div>}
        {groups.map((g) => (
          <div key={g.repo}>
            {several && (
              <div className="flex items-center gap-2 px-2 h-[30px] mt-1.5 first:mt-0 text-[11px]" style={{ color: "var(--text2)" }}>
                <span className="grid place-items-center shrink-0 rounded-md text-[9.5px] font-bold text-white" aria-hidden
                  style={{ width: 18, height: 18, background: g.current ? "var(--primary)" : "var(--text4)" }}>{g.repo.split("/").pop()?.[0]?.toUpperCase()}</span>
                <span className="truncate min-w-0" style={{ fontWeight: 600 }}>{g.repo}</span>
                {g.current && <span className="shrink-0 rounded px-1.5 text-[9px] uppercase tracking-wider" style={{ color: "var(--primary-ink)", background: WASH }}>this repo</span>}
                <span className="ml-auto shrink-0 tabular-nums text-[10px]" style={{ color: "var(--text4)" }}>{g.pins.length}</span>
              </div>
            )}
            <div className={several ? "ml-4 pl-1 flex flex-col gap-px" : "flex flex-col gap-px"}
              style={several ? { borderLeft: LINE } : undefined}>
              {g.pins.map(row)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
