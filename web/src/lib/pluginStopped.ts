import type { PublicPlugin } from "../../../shared/types.ts";

/** What a stopped plugin has to say about why, or null when it said nothing:
 *  a plugin that ran for a while and then went away leaves no trace here. */
export type StopReason = { headline: string; detail: string };

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function stopReason(plugin: Pick<PublicPlugin, "lastExit" | "lastBoxFailure">): StopReason | null {
  const { lastExit: x, lastBoxFailure: box } = plugin;
  if (!x && !box) return null;
  const parts: string[] = [];
  let headline = "";
  if (x) {
    const how = x.signal ? `was stopped by ${x.signal}` : `exited with code ${x.code ?? "unknown"}`;
    headline = `It ${how} ${seconds(x.afterMs)} after starting.`;
    if (x.stderrTail) parts.push(x.stderrTail);
  }
  if (box) {
    if (!headline) headline = "The box it runs in failed to start.";
    // The tail usually repeats the box's own line; say it once.
    if (!parts.some((p) => p.includes(box))) parts.push(`box: ${box}`);
  }
  return { headline, detail: parts.join("\n") };
}
