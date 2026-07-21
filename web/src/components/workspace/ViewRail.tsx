import { VIEWS, type ViewId } from "./views.ts";
import { MOD_KEY } from "../../lib/format.ts";

export type RailPip = { dot?: boolean; count?: number };

/** Icon-only switcher down the side of the workspace.
 *
 *  Deliberately 52px and wordless: this is the frame around every view, so
 *  every pixel it takes is taken from the thing you actually came to look at.
 *  The name lives in a hover tooltip, and after a day nobody uses the rail
 *  anyway — the letter keys are faster. Status (a live shell, a chat that
 *  replied) rides as a corner pip so it costs no width at all.
 */
export function ViewRail({
  view, onSelect, onClose, pips,
}: {
  view: ViewId;
  onSelect: (v: ViewId) => void;
  onClose: () => void;
  pips?: Partial<Record<ViewId, RailPip>>;
}) {
  // Arrow keys move between tabs, matching the tablist pattern. Without this
  // the rail is reachable by Tab but not traversable, which is the usual way
  // an icon rail fails a keyboard user.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = VIEWS.findIndex((v) => v.id === view);
    const n = VIEWS[(i + (e.key === "ArrowDown" ? 1 : VIEWS.length - 1)) % VIEWS.length];
    onSelect(n.id);
    (e.currentTarget.querySelector(`[data-view="${n.id}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <nav
      role="tablist"
      aria-label="Workspace views"
      onKeyDown={onKeyDown}
      className="w-[52px] shrink-0 flex flex-col gap-[3px] p-2 overflow-visible"
      style={{
        borderRight: "1px solid color-mix(in srgb, var(--primary) 14%, transparent)",
        background: "color-mix(in srgb, var(--bg) 55%, transparent)",
      }}
    >
      {VIEWS.map((v, i) => {
        const on = v.id === view;
        const pip = pips?.[v.id];
        const Icon = v.icon;
        return (
          <button
            key={v.id}
            data-view={v.id}
            role="tab"
            aria-selected={on}
            aria-label={v.label}
            tabIndex={on ? 0 : -1}
            onClick={() => onSelect(v.id)}
            className="agw-tip relative h-10 w-full grid place-items-center rounded-[10px] transition-colors"
            // The modifier binding, not the bare letter. Inside the workspace
            // the letters no longer navigate — they belong to whatever has
            // focus, usually a shell — and a tooltip advertising a key that
            // does nothing is worse than no tooltip.
            data-tip={`${v.label} · ${MOD_KEY}${i + 1}`}
            style={{
              color: on ? "var(--primary-hover)" : "var(--text4)",
              background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent",
            }}
          >
            <Icon size={17} />
            {/* the 3px edge marker: reads as "you are here" from the far side
                of the screen, where a background tint alone doesn't. */}
            {on && (
              <span className="absolute left-[-8px] top-[9px] bottom-[9px] w-[3px] rounded-r-[3px]"
                style={{ background: "var(--primary)" }} />
            )}
            {pip?.count ? (
              <span className="absolute top-[5px] right-[6px] min-w-[14px] h-[14px] px-[3px] grid place-items-center rounded-full text-[9px] font-bold tabular-nums"
                style={{ background: "var(--success)", color: "#06281c" }}>{pip.count}</span>
            ) : pip?.dot ? (
              <span className="absolute top-[7px] right-[9px] w-[6px] h-[6px] rounded-full"
                style={{ background: "var(--success)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--success) 22%, transparent)" }} />
            ) : null}
          </button>
        );
      })}

      <div className="mt-auto pt-2" style={{ borderTop: "1px solid color-mix(in srgb, var(--primary) 10%, transparent)" }}>
        <button
          onClick={onClose}
          aria-label="Close workspace"
          data-tip="close · esc"
          className="agw-tip relative h-10 w-full grid place-items-center rounded-[10px] transition-colors"
          style={{ color: "var(--text4)" }}
        >
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
