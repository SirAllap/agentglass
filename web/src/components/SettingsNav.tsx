import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { ICON } from "../lib/iconSize.ts";
import {
  NAV_SHUT_KEY, buildNav, groupByName, hueVar, openGroupOf, parseShut, serializeShut,
  type NavGroupId, type NavPageIn, type NavSection, type PageMark,
} from "../lib/settingsNav.ts";
import { ChevronDownIcon, GroupIcon } from "./settingsNavIcons.tsx";

type Page = NavPageIn & { icon: (p: { size?: number }) => ReactElement };

/** What the nav says at the right of a page: a count that wants you, a dot that is on or off, a word for an update. */
function Mark({ m }: { m: PageMark }) {
  if (m.state === "none") return null;
  if (m.state === "needs") return <span className="agx-sn-meta"><span className="agx-sn-cnt" title={m.title}>{m.count}</span></span>;
  if (m.state === "update") return <span className="agx-sn-meta"><span className="agx-sn-cnt" data-tone="info" title={m.title}>update</span></span>;
  return (
    <span className="agx-sn-meta">
      <i className="agx-sn-dot" data-state={m.state} role="img" aria-label={m.state === "on" ? "on" : "off"} />
    </span>
  );
}

/**
 * The page list: five coloured groups that collapse, and a System footer that
 * does not. Back-to-app and the search box sit above the scroller, so a long
 * list can never push either off the top; the legend sits under it.
 *
 * What a page shows at the right comes from `marks` (see navMarks in
 * lib/settingsNav.ts) and nowhere else: no mark means no real signal.
 */
export function SettingsNav({ pages, marks, current, onGo, onClose, pinned, search }: {
  pages: readonly Page[];
  marks: Readonly<Record<string, PageMark | undefined>>;
  /** The page on screen, as a nav id. */
  current: string;
  onGo: (id: string) => void;
  onClose: () => void;
  /** The pinned "Get started" row: how many of its steps are done, or null for no row. */
  pinned: { done: number; total: number; active: boolean } | null;
  /** The search box and its results panel. */
  search: ReactNode;
}) {
  const [shut, setShut] = useState<Set<NavGroupId>>(() => {
    try { return parseShut(localStorage.getItem(NAV_SHUT_KEY)); } catch { return parseShut(null); }
  });
  const remember = (s: Set<NavGroupId>) => {
    setShut(s);
    try { localStorage.setItem(NAV_SHUT_KEY, serializeShut(s)); } catch { /* private mode: the groups simply open fresh next time */ }
  };
  const model = useMemo(() => buildNav(pages, marks, shut), [pages, marks, shut]);
  const currentGroup = groupByName(pages.find((p) => p.id === current)?.group ?? "")?.id;
  // A page asked for from outside (a link, a search hit) must not land inside a shut group.
  useEffect(() => {
    if (currentGroup && shut.has(currentGroup)) remember(openGroupOf(shut, currentGroup));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of page opens its group; a click on the header may shut it again
  }, [current]);

  const icons = useMemo(() => new Map(pages.map((p) => [p.id, p.icon])), [pages]);
  const item = (p: NavSection["pages"][number]) => {
    const Icon = icons.get(p.id)!;
    return (
      <button key={p.id} type="button" data-settings-page={p.id} title={p.label} onClick={() => onGo(p.id)}
        aria-current={current === p.id ? "page" : undefined}
        className="agx-sn-it" data-on={current === p.id ? "" : undefined}>
        <span className="agx-sn-ic"><Icon size={ICON.lg} /></span>
        <span className="agx-sn-lbl">{p.label}</span>
        <Mark m={p.mark} />
      </button>
    );
  };

  return (
    <aside className="agx-settings-nav shrink-0 flex flex-col border-r"
      style={{ background: "var(--surface-nav)", borderColor: "var(--surface-line)" }}>
      {/* Leaving is a button you press, not an x you hunt for in a corner, and
          it says where it takes you. The row IS the button: it was a button
          the size of its text inside a padded bar, so only the arrow and the
          words answered the pointer. Full width, no padding around it, and
          the only things that change on hover and press are its fill and its
          ink, so nothing under the pointer moves. */}
      <button onClick={onClose} type="button"
        className="agx-navback agx-sn-back shrink-0 w-full flex items-center gap-2 px-4 text-[13px] text-left"
        style={{ color: "var(--text3)", minHeight: 44 }}>
        <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <path d="M19 12H5" /><path d="m12 19-7-7 7-7" />
        </svg>
        <span>Back to app</span>
      </button>
      <div className="agx-sn-top shrink-0">{search}</div>

      <div className="agx-sn-scroll min-h-0 flex-1 agx-scroll overflow-y-auto overflow-x-hidden">
        {pinned && (
          <button type="button" data-settings-page="onboarding" onClick={() => onGo("onboarding")}
            aria-current={pinned.active ? "page" : undefined}
            className="agx-sn-pin" data-on={pinned.active ? "" : undefined}>
            <span className="min-w-0 truncate">Get started</span>
            <span className="agx-sn-pin-n">{pinned.done}/{pinned.total}</span>
          </button>
        )}
        {model.sections.map((s) => (
          <div key={s.group.id} className="agx-sn-grp" data-shut={s.shut ? "true" : undefined} style={{ "--hue": hueVar(s.group.id) } as React.CSSProperties}>
            <button type="button" className="agx-sn-gh" aria-expanded={!s.shut}
              onClick={() => { const n = new Set(shut); if (n.has(s.group.id)) n.delete(s.group.id); else n.add(s.group.id); remember(n); }}>
              <span className="agx-sn-chip"><GroupIcon name={s.group.icon} size={ICON.md} /></span>
              <span className="agx-sn-gn">{s.group.name}</span>
              {s.shut && s.rollup > 0 && (
                <span className="agx-sn-roll"><span className="agx-sn-cnt" title={`${s.rollup} ${s.rollup === 1 ? "page wants" : "pages want"} you`}>{s.rollup}</span></span>
              )}
              <span className="agx-sn-caret"><ChevronDownIcon size={ICON.sm} /></span>
            </button>
            <div className="agx-sn-items">{s.pages.map(item)}</div>
          </div>
        ))}
      </div>

      {model.system && (
        <div className="agx-sn-sys" style={{ "--hue": hueVar("system") } as React.CSSProperties}>
          <div className="agx-sn-items">{model.system.pages.map(item)}</div>
        </div>
      )}
      <div className="agx-sn-legend" aria-hidden>
        <span><i className="agx-sn-dot" data-state="on" />on</span>
        <span><i className="agx-sn-dot" data-state="needs" />needs you</span>
        <span><i className="agx-sn-dot" data-state="off" />off</span>
      </div>
    </aside>
  );
}
