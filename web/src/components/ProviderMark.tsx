// One mark per provider, at the strip's glyph rung.
//
// The name is dropped on a narrow window, so the shape has to carry identity
// for a moment; it never carries the reading, which is always the number.
import type { ProviderUsage } from "../../../shared/types.ts";
import { ICON } from "../lib/iconSize.ts";

type Provider = ProviderUsage["provider"];

export function ProviderMark({ provider, size = ICON.xs }: { provider: Provider; size?: number }) {
  const common = {
    width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
    strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const,
  };
  switch (provider) {
    case "anthropic":
      return <svg {...common}><path d="M8 1.8v12.4M1.8 8h12.4M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" /></svg>;
    case "opencode":
      return (
        <svg {...common}>
          <rect x="2.4" y="3" width="11.2" height="10" rx="2.2" />
          <path d="M5.4 6.4 7.6 8.4 5.4 10.4" />
          <path d="M9 10.4h2" />
        </svg>
      );
    case "codex":
      return (
        <svg {...common}>
          <path d="M8 1.9 13.3 4.9v6.2L8 14.1 2.7 11.1V4.9Z" />
          <circle cx="8" cy="8" r="1.9" />
        </svg>
      );
    case "antigravity":
      return (
        <svg {...common}>
          <path d="M8 2.4 14 13.2H2Z" />
          <path d="M8 6.6v3.2" />
        </svg>
      );
  }
}
