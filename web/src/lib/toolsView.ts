// Pure decisions of the "Tools on this machine" and "Services" sections: what a
// tool tile's install line says, what the ready group is called and counted as,
// and which service cards would only repeat a tool tile. No React, so tests need no DOM.
import type { DepStatus } from "../../../shared/deps.ts";
import { PROVIDERS, type ProviderStatus } from "../../../shared/providers.ts";

/**
 * The install line of a tool tile. The label is the fact, so it can never say
 * "Installed" for a tool that is not there (it did: "Installed — not on your PATH").
 */
export function installedFact(status: DepStatus): { tone: "ok" | "off"; label: string; value: "bin" | "missing" | "unused" } {
  if (status === "ok" || status === "attention") return { tone: "ok", label: "Installed", value: "bin" };
  if (status === "unsupported") return { tone: "off", label: "Not used here", value: "unused" };
  return { tone: "off", label: "Not installed", value: "missing" };
}

/**
 * The card that folds every ready tool. The count is said once, in the badge; the
 * fold under it carries no second number ("23 ready" and "23 more ready" were two
 * headings for one group). The badge names its set ("tools") so it does not read
 * as the page filter's "Ready" count, which adds the connected services.
 */
export function readyGroup(readyN: number, wantsN: number): { title: string; badge: string; fold: string } {
  return {
    title: wantsN ? "Ready" : "Everything found",
    badge: `${readyN} ${readyN === 1 ? "tool" : "tools"}`,
    fold: readyN === 1 ? "Show it" : "Show them",
  };
}

/**
 * Service cards that would only repeat a tool tile: a service whose one problem is
 * its command-line tool is missing ("GitLab · Not installed" under Services, under
 * "GitLab CLI · Not installed" in Tools). The tool tile says it once and carries
 * the Install, so the service card is left out until the tool is there.
 */
export function servicesCoveredByTools(status: readonly Pick<ProviderStatus, "id" | "state">[] | null): Set<string> {
  const out = new Set<string>();
  for (const s of status ?? []) {
    const spec = PROVIDERS.find((p) => p.id === s.id);
    if (spec?.dep && s.state === "missing-tool") out.add(s.id);
  }
  return out;
}
