import { usd } from "../../lib/flightPlan.ts";
import type { Strip, StripButtonId } from "../../lib/flightPilot.ts";
import { FlagIcon, PlayIcon, StarIcon, UserIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { meter } from "../../lib/pilotSettings.ts";
import { CoinIcon, PauseIcon, PlaneIcon } from "./fpIcons.tsx";

const BADGE = { autopilot: PlaneIcon, copilot: StarIcon, manual: UserIcon, held: PauseIcon, budget: CoinIcon } as const;
const money = (n: number): string => (Number.isInteger(n) ? `$${n}` : usd(n));
/** The buttons that call the engine: with no engine they stay, disabled, so nothing moves. */
const NEEDS_ENGINE: StripButtonId[] = ["hold", "resume"];

function Meter({ label, used, cap, withCap, known }: { label: string; used: number; cap: number; withCap: boolean; known: boolean }) {
  const m = meter(used, cap);
  return (
    <div className="pv-meter" data-unknown={known ? undefined : ""} title={known ? undefined : "Spend is read from the orchestrator engine, which does not answer yet."}>
      <div className="lab"><span>{label}</span><b>{known ? `${usd(used)}${withCap ? ` / ${money(cap)}` : ""}` : "not read"}</b></div>
      <div className="pv-bar" role="meter" aria-label={`${label} spend`} aria-valuemin={0} aria-valuemax={cap} aria-valuenow={known ? Math.min(used, cap) : 0} data-tone={known ? m.tone : undefined} style={{ ["--p" as string]: known ? m.pct : 0 }}><i /></div>
    </div>
  );
}

/** The mode as a badge: the strip's, and the one each project wears in Settings. */
export function ModeBadge({ strip }: { strip: Pick<Strip, "mode" | "badge"> }) {
  const Badge = BADGE[strip.mode];
  return <span className="pv-badge" data-mode={strip.mode}><span className="pv-tile"><Badge size={ICON.xs} /></span>{strip.badge}</span>;
}

/**
 * The strip under the header: the same four slots in every mode (badge, one
 * sentence, the meters, one button), so nothing jumps when the mode changes.
 * Its height is fixed in the stylesheet; the sentence is a polite live region.
 */
export function PilotStrip({ strip, engine, busy, error, onButton, onSecondary }: {
  strip: Strip; engine: boolean; busy: boolean; error: string; onButton: (id: StripButtonId) => void; onSecondary: () => void;
}) {
  const b = strip.button;
  const rest = strip.sentence.startsWith(strip.lead) ? strip.sentence.slice(strip.lead.length) : ` ${strip.sentence}`;
  const withCap = strip.mode === "autopilot" || strip.mode === "budget";
  const down = !engine && NEEDS_ENGINE.includes(b.id);
  return (
    <div className="pv-strip" data-mode={strip.mode}>
      <div><ModeBadge strip={strip} /></div>
      <div className="pv-say" aria-live="polite" title={strip.sentence}>
        <strong>{strip.lead}</strong>{rest}{error && <> <span className="bad" role="alert">{error}</span></>}
      </div>
      <div className="pv-acts">
        <div className="pv-meters">
          <Meter label="Today" used={strip.meters.today.used} cap={strip.meters.today.cap} withCap={withCap} known={engine} />
          {strip.mode === "autopilot" && <Meter label="Week" used={strip.meters.week.used} cap={strip.meters.week.cap} withCap known={engine} />}
        </div>
        <div className="pv-btnwrap">
          {strip.secondary && <button type="button" className="btn ghost" disabled={busy || !engine} onClick={onSecondary}>{strip.secondary.label}</button>}
          <button
            type="button" className={`btn ${b.tone === "danger" ? "hold" : b.tone === "go" ? "go" : ""}`} aria-busy={busy || undefined}
            disabled={busy || b.disabled || down} title={down ? "The orchestrator engine does not answer yet." : undefined}
            aria-label={b.id === "hold" ? "Hold Autopilot: no new Go, builders stop at their next safe point" : undefined}
            onClick={() => onButton(b.id)}
          >
            {b.id === "hold" && <PauseIcon size={ICON.xs} />}{b.id === "review-go" && <FlagIcon size={ICON.xs} />}{b.id === "resume" && <PlayIcon size={ICON.xs} />}
            {b.label}{b.count ? ` · ${b.count}` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
