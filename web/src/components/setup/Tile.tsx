/*
 * One choice among a few things: the agent, the theme, later a project.
 *
 * 160x120 at least, a mark, a name, one line, its state in the foot, and a
 * check when it is the choice. The whole upper part is the pick (a button);
 * the foot holds the state and, when the thing is not here, its Install, so
 * the two controls never nest.
 */
import type { ReactNode } from "react";
import { DoneIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";

export function Tile({ mark, name, what, state, tone = "off", selected, onPick, action, preview, id }: {
  /** The glyph, or a theme's preview, drawn above the name. */
  mark?: ReactNode;
  preview?: ReactNode;
  name: string;
  what: string;
  /** The state line in the foot. Absent draws only the foot's action, if any. */
  state?: string | null;
  tone?: "ok" | "warn" | "off";
  selected: boolean;
  onPick: () => void;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <div className={`setup-tile${preview ? " setup-tile-theme" : ""}`} data-on={selected ? "1" : "0"} id={id}>
      <button type="button" className="setup-tile-pick" aria-pressed={selected} onClick={onPick}>
        {mark && <span className="setup-tile-mark">{mark}</span>}
        {preview && <span className="setup-tile-preview">{preview}</span>}
        <span className="setup-tile-text">
          <span className="setup-tile-name">{name}</span>
          <span className="setup-tile-what">{what}</span>
        </span>
        {selected && <span className="setup-tile-check" aria-hidden="true"><DoneIcon size={ICON.xs} /></span>}
      </button>
      {(state !== undefined || action) && (
        <span className="setup-tile-foot">
          {state != null && state !== "" && <span className={`setup-badge setup-badge-${tone}`}>{state}</span>}
          {action}
        </span>
      )}
    </div>
  );
}

/** A theme's mark: a window with a ground, a card and three lines. */
export function ThemePreview({ kind }: { kind: "system" | "light" | "dark" }) {
  if (kind === "system") {
    return (
      <span className="setup-prev" aria-hidden="true">
        <span className="setup-prev-side" data-half="light" />
        <span className="setup-prev-side" data-half="dark" />
      </span>
    );
  }
  return (
    <span className="setup-prev" data-kind={kind} aria-hidden="true">
      <span className="setup-prev-side" />
      <span className="setup-prev-main">
        <span className="setup-prev-line" style={{ width: "64%" }} />
        <span className="setup-prev-line" style={{ width: "44%" }} />
        <span className="setup-prev-line" style={{ width: "52%" }} />
      </span>
    </span>
  );
}
