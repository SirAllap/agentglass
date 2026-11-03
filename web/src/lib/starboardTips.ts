// What a person reads when they point at a Starboard number: where it comes
// from, how it is made, what it cannot say. One entry per number, one place, so
// a number cannot ship without its card. Rendered by TipHost (lib/tip.ts).
import { tipAttr, type TipSpec } from "./tip.ts";

export const SB_TIPS = {
  quiet: { name: "Quiet", trust: "measured", from: "The Lantern board.", how: "Sessions with a pane that have shown no activity for ten minutes.", caveat: "An age, not a verdict: a long background shell may still be running." },
  finished: { name: "Finished", trust: "measured", from: "The Lantern board.", how: "Sessions whose last turn ended, or whose pane is gone.", caveat: "Finished is not merged or shipped: it only says the agent stopped." },
  uptime: { name: "Uptime", trust: "measured", from: "This server.", how: "Time since the server started.", caveat: "Events before that were read from disk, not seen live." },
  sessions: { name: "Sessions", trust: "measured", from: "Hook events received by this server.", how: "Distinct session ids in the selected window.", caveat: "A session counts while its events are inside the window, running or not." },
  working: { name: "Working", trust: "measured", from: "The Lantern board (the rail pip reads the same).", how: "Agents the board reports as running a turn.", caveat: "A session with an open tool call counts as working. A turn that waits only on a background shell does not yet." },
  waiting: { name: "Waiting on you", trust: "measured", from: "The Lantern board.", how: "Agents blocked on a permission or a gate waiting on you.", caveat: "Same rule as the rail pip, so the two always agree." },
  eventsMin: { name: "Events per minute", trust: "measured", from: "Events received over the last minute.", how: "Counted when they arrive, not when they were made.", caveat: "Bursts after a reconnect land together." },
  tools: { name: "Tools run", trust: "measured", from: "Tool-call events in the window.", how: "Count of PostToolUse events.", caveat: "A tool that never reported back is not counted." },
  failed: { name: "Tool failures", trust: "measured", from: "Tool-call events marked as errors.", how: "Count of failed tool calls in the window.", caveat: "Other errors (model, notification) are not in this number." },
  spend: { name: "Spend", trust: "estimated", from: "Token counts times a price table.", how: "Input, output and cache tokens priced per model.", caveat: "Never an invoice: prices change and subscription plans are not billed per token." },
  crew: { name: "Crew", trust: "measured", from: "Sessions seen in the window.", how: "One card per session, by project.", caveat: "State words are working, waiting on you, quiet, finished." },
  orrery: { name: "Orrery", trust: "measured", from: "Sessions seen in the window.", how: "One orbit per project; body size is estimated spend.", caveat: "Position is layout, not meaning." },
  needs: { name: "Needs you", trust: "measured", from: "The Lantern board.", how: "Permissions, gates and prompts waiting on a person.", caveat: "Shows what was asked, not whether it is still open in the pane." },
  alerts: { name: "Alerts", from: "Rules over recent events (lib/derive.ts).", how: "Heuristics that flag failures and retries.", caveat: "Heuristics, not facts." },
  tools_panel: { name: "Tools", trust: "measured", from: "Tool-call events in the window.", how: "Mix by tool; wall-clock per call.", caveat: "Wall-clock includes time spent waiting on you." },
  feed: { name: "Live events", trust: "measured", from: "Every hook event, newest first.", how: "Streamed over the socket.", caveat: "If the link drops, the last events stay on screen greyed." },
  thru: { name: "Throughput", trust: "measured", from: "Event timestamps.", how: "Events per second, last 60 seconds.", caveat: "Counts events, not work done." },
  quota: { name: "Plan quota", trust: "measured", from: "Your provider's own usage endpoint.", how: "Percent of each window used, as the provider reports it.", caveat: "Old when the provider did not answer; the panel says how old." },
  clock: { name: "Clock", trust: "measured", from: "This computer's clock.", how: "Local time, read when the screen last refreshed.", caveat: "Minutes only; it moves when the screen refreshes, not on every second." },
  stalled: { name: "Possibly stalled", from: "Not measured today.", how: "Claimed work, not finished, no open prompt, live pane and no life sign for 20 minutes.", caveat: "Drawn dashed: the engine cannot yet tell a worker waiting on its subagent from a dead one." },
  cost: { name: "Cost", trust: "estimated", from: "Token counts times a price table.", how: "Spend by model in the window.", caveat: "Estimated, never an invoice." },
} satisfies Record<string, TipSpec>;

export type SbTip = keyof typeof SB_TIPS;
/** The `data-tip` attribute for one of them. */
export const sbTip = (k: SbTip): string => tipAttr(SB_TIPS[k] as TipSpec);

/** The QUOTA tile's tip with one row per provider that has a reading, so the
 *  windows are read down a column instead of run together in a sentence. */
export const sbQuotaTip = (lines: readonly { label: string; windows: string }[]): string =>
  tipAttr({
    ...(SB_TIPS.quota as TipSpec),
    // A card carrying this PC's OpenCode turns is partly an estimate, whatever
    // the provider endpoints said, so the badge must not say "measured".
    trust: lines.some((l) => l.label.includes("this PC")) ? "estimated" : "measured",
    rows: lines.map((l) => ({ k: l.label, v: l.windows })),
  });
