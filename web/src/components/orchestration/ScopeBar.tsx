import { useContext, useEffect, useRef, type ReactNode } from "react";
import { Filter } from "../SettingRow.tsx";
import { Button, LINE } from "../workspace/Chrome.tsx";
import { OrchSeg } from "./OrchKit.tsx";
import { OWN_LEGEND, OWN_SETTING, scopeSentence } from "./orchestrationCopy.ts";

const baseName = (root: string) => root.split("/").filter(Boolean).pop() ?? root;

/**
 * Whose setting is on screen: the project chips, one line saying what that
 * means, and the one action that changes it (give a project a setting of its
 * own, or send it back to the general one).
 *
 * It stays at the top of the page while the rest scrolls, directly under the
 * page header: the header is sticky too and publishes its height as
 * `--agx-ph-h` on the settings scroller, which is the bar's `top`. With
 * `top-0` the bar slid under the header and the cards scrolled through the gap
 * (measured). It stays because every card below is read for the project it
 * names. It writes its own height onto the
 * page's wrapper as `--orch-stick`, so a card scrolled to from a link stops
 * under the bar and not behind it; the height is measured when the bar
 * changes size, never on a timer.
 */
export function ScopeBar({ root, projects, overrides, inherited, busy, note, saved, onRoot, onScope }: {
  root: string;
  projects: string[];
  /** The projects that have a setting of their own. */
  overrides: string[];
  inherited: boolean;
  busy: boolean;
  /** The server's sentence when the last change was refused. */
  note: string | undefined;
  /** The chip that says whether what is on screen is saved, beside the choice. */
  saved?: ReactNode;
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
      ? { id: r, own: true, label: <><span aria-hidden className="agx-orch-own" data-own-dot />{baseName(r)}</>, title: `${r} \u2014 ${OWN_SETTING}` }
      : { id: r, label: baseName(r), title: r })),
  ];
  const sentence = scopeSentence(root, inherited, baseName(root));
  if (searching) return null;
  return (
    <div ref={bar} data-scope-bar className="sticky z-10 grid gap-1.5 pt-2 pb-2.5 mb-4 agx-settings-x"
      style={{ top: "var(--agx-ph-h, 0px)", background: "var(--bg)", borderBottom: LINE }}>
      <div className="flex flex-wrap items-center gap-2">
        <OrchSeg label="Settings for" value={root} options={options} onChange={onRoot} />
        {saved}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="m-0 min-w-0 text-[12px]" style={{ color: "var(--text3)" }} aria-live="polite">
          {overrides.length > 0 && <><span aria-hidden className="agx-orch-own" />{OWN_LEGEND} </>}Showing <b style={{ color: "var(--text)" }}>{sentence.showing}</b>{sentence.tail}
        </p>
        {root !== "" && (
          <Button disabled={busy} className="shrink-0" onClick={() => onScope(inherited)}>{inherited ? "Set for this project" : "Use the general setting"}</Button>)}
      </div>
      {note && <div role="alert" className="text-[12px]" style={{ color: "var(--error-ink)" }}>{note}</div>}
    </div>
  );
}
