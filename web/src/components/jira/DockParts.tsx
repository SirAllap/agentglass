/*
 * The small parts of the card dock that more than one Jira file draws: the icon-only button with the app's tooltip, and the
 * state chip. Icon-only always means a `data-tip` (name, one sentence) and an `aria-label`, never a native title.
 */
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { DoneIcon } from "../../lib/glyphIcons.tsx";
import { dataInk } from "../../lib/contrast.ts";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { tipAttr, type TipSpec } from "../../lib/tip.ts";
import { externalUrl } from "../../lib/externalUrl.ts";

const IB = "inline-flex items-center justify-center rounded-lg shrink-0 transition-colors disabled:opacity-40 hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]";

/** A 26 square icon control. `on` is the lit state (following); `href` makes it a link that opens outside the app. */
export function DockIcon({ tip, label, onClick, href, on, disabled, children, size = HIT }: {
  tip: TipSpec; label?: string; onClick?: (e: MouseEvent) => void; href?: string; on?: boolean; disabled?: boolean; children: ReactNode; size?: number;
}) {
  const style: CSSProperties = {
    width: size, height: size,
    color: on ? "var(--info-ink)" : "var(--text3)",
    background: on ? "color-mix(in srgb, var(--info) 12%, transparent)" : undefined,
  };
  const name = label ?? tip.name;
  const safe = href ? externalUrl(href) : "";
  if (href) {
    return safe
      ? <a href={safe} target="_blank" rel="noreferrer" data-tip={tipAttr(tip)} aria-label={name} className={IB} style={style}>{children}</a>
      : <span aria-hidden />;
  }
  return <button type="button" onClick={onClick} disabled={disabled} data-tip={tipAttr(tip)} aria-label={name} aria-pressed={on === undefined ? undefined : on} className={IB} style={style}>{children}</button>;
}

/** The arrow out of a box: opens on the site. */
export function ExtIcon({ size = ICON.md }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
    </svg>
  );
}

/** The colour a status wears: the site's own for an open one, success for a finished one, the quiet ink with none. */
export function stateTone(color: string | undefined, done: boolean): { c: string; ink: string } {
  if (done) return { c: "var(--success)", ink: "var(--success-ink)" };
  if (color) return { c: color, ink: dataInk(color) };
  return { c: "var(--text3)", ink: "var(--text3)" };
}

/** The state chip's skin (26 as the dock's one move menu, 22 on a sub-task or linked row). Shared by the chip and the button that opens the menu. */
export function stateStyle(color: string | undefined, done: boolean, h: number): CSSProperties {
  const { c, ink } = stateTone(color, done);
  return {
    height: h, padding: "0 10px", borderRadius: 8, fontSize: 11, fontWeight: 600, gap: 6, color: ink,
    background: `color-mix(in srgb, ${c} 10%, transparent)`,
    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${c} 30%, transparent)`,
  };
}

/** What a status chip says: a tick before a finished one. */
export function StateLabel({ status, done }: { status: string; done: boolean }) {
  return <>{done && <DoneIcon size={ICON.xs} />}<span className="truncate">{status}</span></>;
}

export function StateChip({ status, color, done, h = 22 }: { status: string; color?: string; done: boolean; h?: number }) {
  return (
    <span className="inline-flex items-center shrink-0 whitespace-nowrap max-w-[45%] min-w-0" style={stateStyle(color, done, h)}>
      <StateLabel status={status} done={done} />
    </span>
  );
}

/*
 * The dock's own classes, the card's tiles. One sheet, drawn once by the card (JiraCard), so a hover and a focus are a rule here and
 * not an inline style that cannot hover. Sizes are the spacing scale: 2 / 4 / 6 / 8 / 12 / 16, and 10 only as a control's inline padding.
 * Prose (a title, a description, a comment) is the sans face; keys, counts and chips stay mono.
 */
export const DOCK_CSS = `
.agx-dk-stack{display:flex;flex-direction:column;gap:6px;min-width:0}
.agx-dk-mini{display:flex;align-items:center;gap:8px;min-height:36px;padding:0 12px;border-radius:8px;background:var(--bg);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text) 10%,transparent);font-size:12px;min-width:0}
.agx-dk-mini:hover{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--info) 50%,transparent)}
.agx-dk-mini:focus-within{outline:2px solid var(--primary);outline-offset:0}
.agx-dk-k{font-size:11px;color:var(--text3)}
.agx-dk-t{font-family:var(--font-prose);font-size:12.5px;color:var(--text)}
.agx-dk-done .agx-dk-k,.agx-dk-done .agx-dk-t{color:var(--text3);text-decoration:line-through}
.agx-dk-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.agx-dk-fact{position:relative;display:flex;flex-direction:column;gap:4px;min-width:0;padding:8px 12px;border-radius:3px 8px 3px 8px;text-align:left;background:color-mix(in srgb,var(--tc,var(--text3)) 6%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tc,var(--text3)) 18%,transparent)}
.agx-dk-fact:hover{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--info) 45%,transparent)}
.agx-dk-fact:focus-within{outline:2px solid var(--primary)}
.agx-dk-lb{font-size:10.5px;line-height:1;color:var(--text3)}
.agx-dk-vl{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;font-weight:600;line-height:1.3;color:var(--text)}
.agx-dk-lock{position:absolute;right:6px;top:6px;color:var(--text4);display:flex}
.agx-dk-prt{display:flex;align-items:center;gap:12px;padding:12px;border-radius:3px 14px 3px 14px;min-width:0;background:var(--bg);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text) 10%,transparent),0 1px 2px color-mix(in srgb,var(--text) 8%,transparent)}
.agx-dk-prt:hover{box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--st,var(--text3)) 65%,transparent)}
.agx-dk-prt:focus-within{outline:2px solid var(--primary)}
.agx-dk-cmt{background:var(--surface-card);border-radius:10px;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text) 10%,transparent)}
.agx-dk-tl{position:relative;display:flex;flex-direction:column;gap:8px;padding-left:24px}
.agx-dk-tl::before{content:"";position:absolute;left:6px;top:4px;bottom:4px;width:2px;background:var(--surface-line)}
.agx-dk-ev{position:relative;font-size:10.5px;line-height:1.4;color:var(--text3)}
.agx-dk-ev::before{content:"";position:absolute;left:-22px;top:4px;width:10px;height:10px;border-radius:50%;background:var(--bg);box-shadow:inset 0 0 0 2px var(--border2)}
`;
