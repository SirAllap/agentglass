import { type ReactElement, type ReactNode } from "react";
import { ICON } from "../lib/iconSize.ts";
import { hueVar, type HeaderChip, type NavGroup } from "../lib/settingsNav.ts";
import { StatusBadge } from "./SettingsKit.tsx";

/**
 * The top of a page: where you are (group, then page), what it is, how it
 * stands, and the one thing you can do to it as a whole.
 *
 * It sits outside the page's scroll region, so it never moves and needs no
 * height published for anything to stick under. The chips come from the page's
 * mark (headerChips in lib/settingsNav.ts): a page with no real signal has
 * none. `primary` is the one action slot; Reset page, where the page can be
 * reset, sits beside it.
 */
export function SettingsPageHeader({ label, group, icon: Icon, what, chips, primary, reset, scope }: {
  label: string;
  group: NavGroup | null;
  icon: (p: { size?: number }) => ReactElement;
  what?: string;
  chips: readonly HeaderChip[];
  /** What this page's values apply to, said once under the header. A page whose
   *  values are machine-wide states it; it never fakes a selector. */
  scope?: ReactNode;
  primary?: ReactNode;
  /** Shown when the page has something to put back. */
  reset?: ReactNode;
}) {
  return (
    <header className="agx-ph" style={{ "--hue": hueVar(group?.id ?? "system") } as React.CSSProperties}>
      {group && (
        <div className="agx-ph-crumb">
          <i aria-hidden />{group.name}
          {group.name !== label && <><span aria-hidden>›</span>{label}</>}
        </div>
      )}
      <div className="agx-ph-row">
        <span className="agx-ph-pic" aria-hidden><Icon size={ICON.lg} /></span>
        <h2 className="agx-ph-title">{label}</h2>
        {chips.length > 0 && (
          <span className="agx-ph-chips">
            {chips.map((c) => <StatusBadge key={c.text} tone={c.tone}>{c.text}</StatusBadge>)}
          </span>
        )}
        <span className="agx-ph-sp" />
        {reset}
        {primary}
      </div>
      {what && <p className="agx-ph-sum">{what}</p>}
      {scope && <div className="agx-ph-scope">{scope}</div>}
    </header>
  );
}
