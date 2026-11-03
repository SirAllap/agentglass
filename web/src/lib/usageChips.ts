// What one provider's cell says, pulled out of the strip so the four states
// can be tested without a renderer.
//
// The rule this file exists to hold: an unavailable provider gets a dash and a
// sentence, never a number. A 0% would be read as "nothing used" at exactly the
// moment the truth is "nobody would say".
import type { ProviderUsage, QuotaWindow } from "../../../shared/types.ts";
import { openCodePanelWindows } from "../../../shared/opencodePanel.ts";

export type ChipView =
  | {
    kind: "reading";
    provider: ProviderUsage["provider"];
    label: string;
    window: QuotaWindow;
    /** "5h", "wk", "mo" — the window the number belongs to. */
    tag: string;
    percent: number;
    hot: boolean;
    tip: string;
  }
  | { kind: "spend"; provider: ProviderUsage["provider"]; label: string; usd: number; span: string; source: string; tip: string }
  | { kind: "none"; provider: ProviderUsage["provider"]; label: string; tip: string };

/**
 * The window to put on the bar: the one closest to its limit.
 *
 * Ties go to the shorter window, which is deterministic and the one that comes
 * back first — the same reason the panel orders windows shortest first.
 */
export function worstWindow(u: ProviderUsage): QuotaWindow | null {
  let best: QuotaWindow | null = null;
  for (const w of u.windows) {
    if (!best) { best = w; continue; }
    if (w.usedPercent > best.usedPercent) best = w;
    else if (w.usedPercent === best.usedPercent && w.minutes < best.minutes) best = w;
  }
  return best;
}

/** The tag says which window the number is about; 71% of a week and 4% of an
 *  hour are not comparable, and dropping it is how a strip starts lying. */
export function shortWindow(w: QuotaWindow): string {
  if (w.minutes === 300) return "5h";
  if (w.minutes === 10080) return "wk";
  if (w.minutes === 43200) return "mo";
  return w.label;
}

/**
 * What a sheet tab says in place of a percentage, and whether it draws a track.
 *
 * A spend-only provider has dollars and no track, exactly as its cell on the
 * bar does: a dash over an empty track beside a bar cell and a headline that
 * both say `$7.07` reads as a provider with no reading at all.
 */
export function tabBadge(v: ChipView): { text: string; percent: number | null; track: boolean } {
  if (v.kind === "reading") return { text: `${v.percent}%`, percent: v.percent, track: true };
  if (v.kind === "spend") return { text: `$${v.usd.toFixed(2)}`, percent: null, track: false };
  return { text: "—", percent: null, track: true };
}

export function chipView(u: ProviderUsage, now = Date.now()): ChipView {
  if (!u.available) {
    return {
      kind: "none", provider: u.provider, label: u.label,
      tip: `${u.label} — no reading. ${u.note ?? "No usage note provided."}`,
    };
  }
  // The strip says what the panel says: for OpenCode Go that is the key or console reading when
  // it is fresh, not the local estimate, which under-reads the plan.
  const w = worstWindow(u.provider === "opencode" ? { ...u, windows: openCodePanelWindows(u, now).windows } : u);
  if (!w) {
    // Real spend with no windows is still a reading: the engine's own stats
    // know the dollars but not the plan's three buckets. A "none" beside a
    // number that is on disk is the bug this branch exists to stop.
    if (u.spend) {
      const source = u.source ? ` from ${u.source}` : "";
      return {
        kind: "spend", provider: u.provider, label: u.label, usd: u.spend.usd, span: u.spend.window, source: u.source ?? "",
        tip: `${u.label} — $${u.spend.usd.toFixed(2)} spent over ${u.spend.window}${source}. No quota windows reported.`,
      };
    }
    return {
      kind: "none", provider: u.provider, label: u.label,
      tip: `${u.label} — no reading. It reports no quota windows.`,
    };
  }
  const tag = shortWindow(w);
  return {
    kind: "reading", provider: u.provider, label: u.label, window: w, tag,
    percent: w.usedPercent, hot: w.usedPercent >= 85,
    tip: `${u.label} — ${w.label} window, ${w.usedPercent}% used. Open for every window.`,
  };
}
