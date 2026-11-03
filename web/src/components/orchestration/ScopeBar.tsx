import { useContext, useEffect, useRef, type ReactNode } from "react";
import { Filter } from "../SettingRow.tsx";
import { LINE } from "../workspace/Chrome.tsx";
import { OrchSeg } from "./OrchKit.tsx";
import { SHEET_ROWS } from "../../lib/layers.ts";
import { OWN_SETTING } from "./orchestrationCopy.ts";

const baseName = (root: string) => root.split("/").filter(Boolean).pop() ?? root;

/**
 * Whose setting is on screen: the breadcrumb, the project chips and the chip
 * that says whether what is on screen is saved, in one row — the mockup's bar.
 *
 * ONE row, because the scope is chrome: two rows of explanation above the page
 * cost 87px of a 763px region. The action that changes the scope sits in the
 * banner over the title, which is where the mockup puts it.
 *
 * It sticks under the page's index band, at the offset that band publishes
 * (`--agx-pin-top`), and writes its own height onto the scroll region as
 * `--orch-stick`, so a card scrolled to from a link stops under the bar.
 */
export function ScopeBar({ root, projects, overrides, note, saved, lead, onRoot }: {
  root: string;
  projects: string[];
  /** The projects that have a setting of their own. */
  overrides: string[];
  /** The server's sentence when the last change was refused. */
  note: string | undefined;
  /** The chip that says whether what is on screen is saved, beside the choice. */
  saved?: ReactNode;
  /** A quiet line that belongs to the same row: the Flight plan link. */
  lead?: ReactNode;
  onRoot: (root: string) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  // A settings search lists matching rows only; a bar stuck over them would name a project nothing below is about.
  const searching = useContext(Filter).on;
  useEffect(() => {
    const el = bar.current;
    // Published on the one scroll region, not the page wrapper: the index rail
    // and the page's own sticky column are siblings of this bar, not children.
    const page = el?.closest<HTMLElement>("[data-settings-scroll]") ?? el?.parentElement;
    if (!el || !page || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => page.style.setProperty("--orch-stick", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => { ro.disconnect(); page.style.removeProperty("--orch-stick"); };
  }, [searching]);
  const options = [
    { id: "", label: "All projects", title: "The setting every project without its own uses" },
    ...projects.map((r) => (overrides.includes(r)
      ? { id: r, own: true, label: <><span aria-hidden className="agx-orch-own" data-own-dot />{baseName(r)}</>, title: `${r} \u2014 ${OWN_SETTING}` }
      : { id: r, label: baseName(r), title: r })),
  ];
  if (searching) return null;
  return (
    <div ref={bar} data-scope-bar className="sticky agx-flow-scope agx-settings-x"
      style={{ top: "var(--agx-pin-top, 0px)", zIndex: SHEET_ROWS.bar, marginTop: "calc(var(--agx-pin-gap, 12px) - var(--agx-page-gap, 18px))", background: "var(--surface-page)", borderBottom: LINE }}>
      <span className="agx-flow-crumb">Settings {"\u203a"} <b>Orchestration</b></span>
      <span className="agx-flow-sp" />
      <OrchSeg label="Settings for" value={root} options={options} onChange={onRoot} />
      {saved}
      {lead}
      {note && <div role="alert" className="agx-flow-scope-note text-[12px]" style={{ color: "var(--error-ink)" }}>{note}</div>}
    </div>
  );
}
