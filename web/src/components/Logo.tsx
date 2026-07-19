// The agentglass mark: a loupe whose lens is a mission-control radar — the
// product folded into one glyph (the loupe = "glass"/inspect, the sweep =
// real-time, the blips = your fleet, the bright one = the session that needs
// you). It is deliberately THEME-REACTIVE: the structure inherits the active
// theme's --primary via `currentColor`, and the live blip uses --success, so
// the logo turns violet / green / amber / blue with the palette instead of
// being locked to one "AI purple". Pure vector, scales from 16px to a hero.
export function Logo({ size = 22, className, style, title }: {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label={title ?? "agentglass"}
      className={className}
      style={{ color: "var(--primary)", display: "block", ...style }}
    >
      {title ? <title>{title}</title> : null}
      {/* handle (drawn first so the rim sits on top of it) */}
      <line x1="20.2" y1="20.2" x2="27" y2="27" stroke="currentColor" strokeWidth="3.1" strokeLinecap="round" />
      {/* glass */}
      <circle cx="13.5" cy="13.5" r="9" fill="currentColor" fillOpacity="0.1" />
      {/* scope rings + crosshair */}
      <g stroke="currentColor" fill="none">
        <circle cx="13.5" cy="13.5" r="5.6" strokeOpacity="0.28" strokeWidth="1" />
        <path d="M13.5 5.6 V21.4 M5.6 13.5 H21.4" strokeOpacity="0.16" strokeWidth="1" />
      </g>
      {/* radar sweep */}
      <path d="M13.5 13.5 L13.5 4.6 A8.9 8.9 0 0 1 19.7 7 Z" fill="currentColor" fillOpacity="0.2" />
      <line x1="13.5" y1="13.5" x2="19.7" y2="7" stroke="currentColor" strokeWidth="1" strokeOpacity="0.8" />
      {/* blips — the bright one is the session that needs you (semantic --success) */}
      <circle cx="9" cy="16.4" r="3" fill="none" stroke="var(--success)" strokeOpacity="0.5" strokeWidth="1" />
      <circle cx="9" cy="16.4" r="1.7" fill="var(--success)" />
      <circle cx="16.4" cy="16" r="1.1" fill="currentColor" fillOpacity="0.75" />
      {/* rim */}
      <circle cx="13.5" cy="13.5" r="9.6" fill="none" stroke="currentColor" strokeWidth="2.3" />
    </svg>
  );
}
