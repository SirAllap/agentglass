import { useContext, useEffect, useRef } from "react";
import { Filter } from "../SettingRow.tsx";
import { Button, Chip, LINE } from "../workspace/Chrome.tsx";
import { OWN_SETTING, scopeLine } from "./orchestrationCopy.ts";

const baseName = (root: string) => root.split("/").filter(Boolean).pop() ?? root;

/**
 * Whose setting is on screen: the project chips, one line saying what that
 * means, and the one action that changes it (give a project a setting of its
 * own, or send it back to the general one).
 *
 * It stays at the top of the page while the rest scrolls. `-top-8` cancels
 * the `pt-8` of the settings scroller: a sticky box holds its offset from
 * that scroller's content edge, not its top, so with `top-0` the cards
 * scrolled through a 32px strip above the bar (measured). The page's source
 * keeps the two numbers together under test. because every card
 * below is read for the project it names. It writes its own height onto the
 * page's wrapper as `--orch-stick`, so a card scrolled to from a link stops
 * under the bar and not behind it; the height is measured when the bar
 * changes size, never on a timer.
 */
export function ScopeBar({ root, projects, overrides, inherited, busy, note, onRoot, onScope }: {
  root: string;
  projects: string[];
  /** The projects that have a setting of their own. */
  overrides: string[];
  inherited: boolean;
  busy: boolean;
  /** The server's sentence when the last change was refused. */
  note: string | undefined;
  onRoot: (root: string) => void;
  /** true: give the project its own setting; false: back to the general one. */
  onScope: (override: boolean) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  // A settings search lists matching rows only; a bar stuck over them would name a project nothing below is about.
  const searching = useContext(Filter).on;
  useEffect(() => {
    const el = bar.current;
    const page = el?.parentElement;
    if (!el || !page || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => page.style.setProperty("--orch-stick", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => { ro.disconnect(); page.style.removeProperty("--orch-stick"); };
  }, [searching]);
  const options = [
    { id: "", label: "All projects", title: "The setting every project without its own uses" },
    ...projects.map((r) => (overrides.includes(r)
      ? { id: r, label: <>{baseName(r)}<span aria-hidden className="inline-block rounded-full ml-1.5 align-middle" style={{ width: 6, height: 6, background: "var(--primary)" }} /></>, title: `${r} — ${OWN_SETTING}` }
      : { id: r, label: baseName(r), title: r })),
  ];
  if (searching) return null;
  return (
    <div ref={bar} data-scope-bar className="sticky -top-8 z-10 grid gap-1.5 pt-2 pb-2.5 mb-4 agx-settings-x"
      style={{ background: "var(--bg)", borderBottom: LINE }}>
      {/* Segmented's chips, but allowed to run onto a second line: the list grows with the person's projects. */}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Settings for">
        {options.map((o) => <Chip key={o.id} on={root === o.id} resting onClick={() => onRoot(o.id)} title={o.title}>{o.label}</Chip>)}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="m-0 min-w-0 text-[12px]" style={{ color: "var(--text3)" }} aria-live="polite">{scopeLine(root, inherited, baseName(root))}</p>
        {root !== "" && (
          <Button disabled={busy} className="shrink-0" onClick={() => onScope(inherited)}>{inherited ? "Set for this project" : "Use the general setting"}</Button>)}
      </div>
      {note && <div role="alert" className="text-[12px]" style={{ color: "var(--error-ink)" }}>{note}</div>}
    </div>
  );
}
