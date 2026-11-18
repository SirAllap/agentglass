import { useRef, useState } from "react";
import { AnchoredMenu } from "../../AnchoredMenu.tsx";
import { CaretIcon, DoneIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { openProjectPicker } from "../../../lib/openSettings.ts";
import { parentOf, tildify } from "../../../lib/projectsPaths.ts";
import { Button, DIVIDER, FilterField, ListRow } from "../../workspace/Chrome.tsx";
import { OPEN_A_PROJECT, SEARCH_FROM, enterPick, menuRows, triggerLabel, typeAhead, type RowTag, type ScopeChoice } from "./scopeModel.ts";

/**
 * "Applies to  [All projects ▾]": the page header's one scope control. One
 * button at the HIT height says the current choice; its menu lists "All
 * projects", a divider, then every project the app knows (the open one first,
 * the folder under each name, a check on the current one, a search field from
 * SEARCH_FROM projects up). It opens under the button's left edge. With no
 * project open the button is disabled and the line beside it says what to do.
 */
export function ScopeControl({ project, projects, value, onChange, onPick }: {
  /** The project the page is scoped to when "project" is chosen, or null. */
  project: string | null;
  /** Every project the app knows. Left out: just `project`. */
  projects?: readonly string[];
  value: ScopeChoice;
  onChange: (next: ScopeChoice) => void;
  /** Pick one project from the menu. Left out: picking `project` is onChange("project"). */
  onPick?: (root: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLSpanElement>(null);
  const typed = useRef({ buf: "", at: 0 });
  const blocked = project === null;
  const list = onPick ? (projects ?? (project ? [project] : [])) : (project ? [project] : []);
  const searchable = list.length > SEARCH_FROM;
  const rows = menuRows(list, project, value, query);
  const close = () => { setOpen(false); setQuery(""); };
  const chooseAll = () => { onChange("all"); close(); };
  const chooseProject = (root: string) => { if (onPick) onPick(root); else onChange("project"); close(); };
  /* Type to move: without a search field, letters jump to the first project they start. With one, they go in the field. */
  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement) {
      const pick = e.key === "Enter" ? enterPick(rows, query) : null;
      if (pick) { e.preventDefault(); chooseProject(pick); }
      return;
    }
    if (searchable || e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
    const now = Date.now();
    typed.current = { buf: now - typed.current.at > 800 ? e.key : typed.current.buf + e.key, at: now };
    const i = typeAhead(rows, typed.current.buf);
    if (i >= 0) { e.preventDefault(); e.currentTarget.querySelector<HTMLElement>(`[data-row="${i}"]`)?.focus(); }
  };
  return (
    <div data-scope-control className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-[12px]" style={{ color: "var(--text2)" }}>Applies to</span>
      <span ref={anchor} className="inline-flex">
        <Button size="hit" data-scope-trigger aria-haspopup="menu" aria-expanded={open}
          disabled={blocked} onClick={() => (open ? close() : setOpen(true))} className="gap-1.5">
          <span className="whitespace-nowrap">{triggerLabel(value, project)}</span>
          <span aria-hidden className="inline-flex opacity-70"><CaretIcon size={ICON.xs} /></span>
        </Button>
      </span>
      {open && (
        <AnchoredMenu anchor={anchor} align="left" minWidth={240} maxHeight={360} placeKey={rows.length} focus={searchable ? "input" : undefined} keepTab={searchable} onClose={close}>
          <div className="flex flex-col gap-px" onKeyDown={onMenuKey}>
            {searchable && <div className="p-1"><FilterField value={query} onChange={setQuery} placeholder="Search projects" label="Search projects" className="w-full" /></div>}
            {rows.map((r, i) => {
              if (r.kind === "divider") return <div key="divider" role="separator" className="mx-1 my-1" style={{ borderTop: DIVIDER }} />;
              if (r.kind === "empty") return <div key="empty" className="px-2.5 py-1.5 text-[11px]" style={{ color: "var(--text3)" }}>{r.label}</div>;
              const check = r.checked ? <DoneIcon size={ICON.sm} /> : undefined;
              return r.kind === "all"
                ? <ListRow key="all" role="menuitem" data-row={i} current={r.checked} trailing={check} onClick={chooseAll}>{r.label}</ListRow>
                : <ListRow key={r.root} role="menuitem" data-row={i} current={r.checked} trailing={check} sub={tildify(parentOf(r.root))} onClick={() => chooseProject(r.root)}>{r.name}</ListRow>;
            })}
          </div>
        </AnchoredMenu>
      )}
      {blocked && <span className="text-[12px]" style={{ color: "var(--text3)" }}>{OPEN_A_PROJECT}{" "}<button type="button" className="underline" style={{ color: "var(--accent)" }} onClick={openProjectPicker}>Open a project</button></span>}
    </div>
  );
}

/** The tag under a row: muted text, the purple dot and Reset link when it differs, the lock for a machine value. */
export function ScopeTag({ tag, onReset }: { tag: RowTag; onReset?: () => void }) {
  if (tag.kind === "none") return null;
  if (tag.kind === "differs") {
    return (
      <span data-scope-tag="differs" className="flex flex-wrap items-center gap-x-2 text-[12px]" style={{ color: "var(--text2)" }}>
        <span aria-hidden className="agx-orch-own" data-own-dot />
        {tag.text}
        {onReset && <button type="button" className="underline" style={{ color: "var(--accent)" }} onClick={onReset}>{tag.reset}</button>}
      </span>
    );
  }
  return <span data-scope-tag={tag.kind} className="text-[12px]" style={{ color: "var(--text3)" }}>{tag.text}</span>;
}

/** The header summary, with the press that filters the page to those rows. Null text keeps the empty line. */
export function ScopeSummary({ text, filtered, onShow }: { text: string | null; filtered: boolean; onShow: () => void }) {
  const [lead] = (text ?? "").split(" · ");
  // The line is always there at a fixed height, so showing it never moves the page.
  return (
    <span data-scope-summary className="block h-[18px] text-[12px] leading-[18px]" style={{ color: "var(--text2)" }}>
      {text && <>
        {lead} {"·"}{" "}
        <button type="button" aria-pressed={filtered} className="underline" style={{ color: "var(--accent)" }} onClick={onShow}>
          {filtered ? "Show all" : "Show them"}
        </button>
      </>}
    </span>
  );
}
