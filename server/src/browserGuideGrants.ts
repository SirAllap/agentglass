/*
 * Guide grants: which worker may guide the person on their own tab, and on
 * which site.
 *
 * A worker's credential works in its own container. Guide mode is the one
 * exception, and it is narrow on purpose: a grant names ONE agent (the name
 * its credential was minted for) and ONE site (an origin). With a live grant
 * the worker may run guide start/point/next/end and the reads in
 * GUIDE_READ_VERBS on a tab of the person's container whose origin is that
 * site, while its own guide runs there. Every act stays refused.
 *
 * A grant ends on its own after GUIDE_GRANT_MS, or when the agent's session
 * ends (its credential is revoked: forgetWorkerPages), whichever comes first.
 * Kept in memory only: a restart of the server ends every session too.
 */
import { foldWorkerName } from "../../shared/workerContainer.ts";
import { guideNow } from "./browserGuide.ts";

export const GUIDE_GRANT_MS = 2 * 60 * 60 * 1000;
export const GUIDE_GRANTS_PLACE = "Settings ▸ Browser ▸ Worker verbs ▸ Guide grants";
/** The reads a worker may run on the person's tab under a grant, while its own guide runs there. */
export const GUIDE_READ_VERBS: readonly string[] = ["observe", "read", "tabs", "markdown", "links", "forms", "interactive", "attr", "shot"];

export interface GuideGrant { id: string; agent: string; site: string; since: number; until: number }

const grants = new Map<string, GuideGrant>();
let seq = 0;

function sweep(now: number): void {
  for (const [id, g] of grants) if (now >= g.until) grants.delete(id);
}

/** The origin of an http(s) URL, or null. */
export function siteOf(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch { return null; }
}

export function addGuideGrant(agent: unknown, site: unknown): { grant: GuideGrant } | { error: string } {
  const name = typeof agent === "string" ? foldWorkerName(agent) : "";
  if (!name || name.length > 64) return { error: "agent is the worker's name, the one its credential was minted for" };
  const origin = siteOf(site);
  if (!origin) return { error: "site is an http or https address, like https://example.com" };
  const now = guideNow();
  sweep(now);
  /* One grant per agent and site: granting again starts the two hours again. */
  for (const [id, g] of grants) if (g.agent === name && g.site === origin) grants.delete(id);
  const grant: GuideGrant = { id: `gg${++seq}`, agent: name, site: origin, since: now, until: now + GUIDE_GRANT_MS };
  grants.set(grant.id, grant);
  return { grant };
}

export function dropGuideGrant(id: unknown): boolean {
  return typeof id === "string" && grants.delete(id);
}

/** The agent's session ended: its grants end with it. */
export function dropGrantsOf(agent: string): void {
  const name = foldWorkerName(agent);
  for (const [id, g] of grants) if (g.agent === name) grants.delete(id);
}

export function listGuideGrants(): GuideGrant[] {
  sweep(guideNow());
  return [...grants.values()].sort((a, b) => a.since - b.since);
}

/** The live grant for this agent on the origin of `url`, if any. */
export function grantFor(agent: string, url: unknown): GuideGrant | undefined {
  const origin = siteOf(url);
  if (!origin) return undefined;
  const name = foldWorkerName(agent);
  sweep(guideNow());
  return [...grants.values()].find((g) => g.agent === name && g.site === origin);
}

export function hasAnyGrant(agent: string): boolean {
  const name = foldWorkerName(agent);
  sweep(guideNow());
  return [...grants.values()].some((g) => g.agent === name);
}

/** What a worker hears when it has no grant: who, where, and the one place that gives one. */
export function noGrantRefusal(agent: string, url?: unknown): string {
  const origin = url === undefined ? null : siteOf(url);
  const where = origin ? ` on ${origin}` : url === undefined ? "" : " on this page";
  return `this credential was minted for an agent, and there is no guide grant for ${foldWorkerName(agent)}${where}: ${GUIDE_GRANTS_PLACE}.`;
}

export function resetGuideGrants(): void { grants.clear(); }
