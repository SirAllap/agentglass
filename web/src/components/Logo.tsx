import { useId } from "react";

// The agentglass mark: a satellite pass — a shaded world, a steeply inclined
// orbit, and one live contact riding it. The product folded into one glyph
// (the world = your machine and everything running on it, the orbit = the
// fleet working out of sight, the bright node = the one session calling home).
//
// It is deliberately THEME-REACTIVE: the structure inherits the active theme's
// --primary via `currentColor` and every value above or below it is a white or
// ink overlay rather than a second hue, so the mark turns violet / green /
// amber / blue with the palette instead of being locked to one "AI purple".
// The contact uses --success, the same green the queue paints "ready" with.
//
// Below 32px a simplified cut takes over — the graticule and the specular
// gradient are a smudge at that size, so they are dropped rather than shrunk.
//
// DO NOT EDIT the drawing below by hand. It is generated, along with the
// favicon, the boot splash, the README mark and the landing page's copies,
// from scripts/logo.mjs — which is also what CI checks. Change it there.
export function Logo({ size = 22, className, style, title }: {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}) {
  const sheen = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title ?? "agentglass"}
      className={className}
      style={{ color: "var(--primary)", display: "block", ...style }}
    >
      {title ? <title>{title}</title> : null}
      {/* logo:start */}
      {size < 32 ? (
        <><path d="M14.1 54.9 A29 8.5 -52 0 1 49.9 9.1" fill="none" stroke="currentColor" strokeOpacity=".45" strokeWidth="6" strokeLinecap="round"/><circle cx="30" cy="34" r="15" fill="currentColor"/><circle cx="30" cy="34" r="15" fill="#fff" fillOpacity=".34"/><path d="M30 19 A15 15 0 0 1 30 49 A21.0 21.0 0 0 0 30 19 Z" fill="#1b0b38" fillOpacity=".52"/><path d="M49.9 9.1 A29 8.5 -52 0 1 14.1 54.9" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round"/><circle cx="50.7" cy="10.4" r="6" fill="var(--success)"/></>
      ) : (
        <><defs><radialGradient id={sheen} cx=".34" cy=".28" r=".82"><stop offset="0" stopColor="#fff" stopOpacity=".72"/><stop offset=".5" stopColor="#fff" stopOpacity=".15"/><stop offset="1" stopColor="#fff" stopOpacity="0"/></radialGradient></defs><path d="M14.1 54.9 A29 8 -52 0 1 49.9 9.1" fill="none" stroke="currentColor" strokeOpacity=".4" strokeWidth="3.2" strokeLinecap="round"/><circle cx="30" cy="34" r="12.5" fill="currentColor"/><circle cx="30" cy="34" r="12.5" fill={`url(#${sheen})`}/><g fill="none" stroke="#fff" strokeOpacity=".2" strokeWidth="1.1"><ellipse cx="30" cy="34" rx="12.5" ry="4.5"/><ellipse cx="30" cy="34" rx="6" ry="12.1"/></g><path d="M30 21.5 A12.5 12.5 0 0 1 30 46.5 A17.0 17.0 0 0 0 30 21.5 Z" fill="#1b0b38" fillOpacity=".42"/><path d="M49.9 9.1 A29 8 -52 0 1 14.1 54.9" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round"/><circle cx="50.8" cy="10.7" r="6.8" fill="var(--success)" fillOpacity=".18"/><circle cx="50.8" cy="10.7" r="3.6" fill="var(--success)"/></>
      )}
      {/* logo:end */}
    </svg>
  );
}

/**
 * The mark, alive: the landing's header mark, contact and all, riding its
 * orbit once every sixteen seconds. It is the brand mark in the title bar and
 * the one the launch cover flies in to — `coverTarget` is where it lands (see
 * lib/cover.ts), which is why there is exactly one of them.
 *
 * Always the full cut, though the title bar draws it at 22px — under the 32
 * at which the static mark switches to its simplified cut — because this is
 * the landing's mark and the flight ends on it: a different drawing at the end
 * of the flight is a visible swap. The ceiling that buys: at 1x it is 22
 * device pixels, and the graticule there is a hint of texture, not a line.
 *
 * It moves on CSS animations of transform and opacity only, which the
 * compositor runs off the main thread, and the sheet it is drawn by lives in
 * web/index.html because the cover has to paint before the bundle does. It
 * stops for reduced motion and while the window is not being looked at.
 *
 * DO NOT EDIT the drawing below by hand either — scripts/logo.mjs again.
 */
export function LivingMark({ size = 22, className, style, title, coverTarget = false }: {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  coverTarget?: boolean;
}) {
  const sheen = useId();
  return (
    <span
      role="img"
      aria-label={title ?? "agentglass"}
      className={className}
      data-cover-target={coverTarget ? "" : undefined}
      style={{ display: "block", flex: "none", width: size, height: size, ...style }}
    >
      {/* living:start */}
      <span className="ag-lm"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14.1 54.9 A29 8 -52 0 1 49.9 9.1" fill="none" stroke="currentColor" strokeOpacity=".4" strokeWidth="3.2" strokeLinecap="round"/></svg><span className="ag-lm-o ag-lm-b"><span className="ag-lm-arm"><span className="ag-lm-dot"></span></span></span><svg viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id={sheen} cx=".34" cy=".28" r=".82"><stop offset="0" stopColor="#fff" stopOpacity=".72"/><stop offset=".5" stopColor="#fff" stopOpacity=".15"/><stop offset="1" stopColor="#fff" stopOpacity="0"/></radialGradient></defs><circle cx="30" cy="34" r="12.5" fill="currentColor"/><circle cx="30" cy="34" r="12.5" fill={`url(#${sheen})`}/><g fill="none" stroke="#fff" strokeOpacity=".2" strokeWidth="1.1"><ellipse cx="30" cy="34" rx="12.5" ry="4.5"/><ellipse cx="30" cy="34" rx="6" ry="12.1"/></g><path d="M30 21.5 A12.5 12.5 0 0 1 30 46.5 A17.0 17.0 0 0 0 30 21.5 Z" fill="#1b0b38" fillOpacity=".42"/><path d="M49.9 9.1 A29 8 -52 0 1 14.1 54.9" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round"/></svg><span className="ag-lm-o ag-lm-f"><span className="ag-lm-arm"><span className="ag-lm-dot"></span></span></span></span>
      {/* living:end */}
    </span>
  );
}
