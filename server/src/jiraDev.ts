/*
 * What a Jira site knows about a card from the development tool connected to it
 * (GitHub for Jira, Bitbucket, GitLab): its pull requests, branches, commits and
 * builds. Read only, and an addition: agentglass finds a card's pull requests
 * itself (remote links, the card's own words, a search by key), so nothing here
 * is needed to work and a site with no tool connected shows nothing at all.
 *
 * The endpoints are Atlassian's own Development panel's and are not documented
 * (`/rest/dev-status/latest/issue/summary|detail`). They answer 200 with empty
 * counts on a site that has no tool connected, and on a connected one for every
 * card no pull request, branch or commit has named: measured on a Cloud site
 * where no card carried data, which is also what a connected app that has not
 * delivered anything yet looks like. The tool only links what carries the card's
 * key in a branch name, a commit message or a pull request title.
 *
 * Requests, counted: the summary is one request and needs the issue's numeric
 * id (the card read already holds it). Each kind the summary counted above zero
 * is one more request per connected tool, asked together, and a card that
 * counted nothing costs the summary alone. It is read when the card is opened
 * and held with it by the pane; never polled.
 *
 * Degrades to nothing: a 404, a 5xx, a body of another shape, or a summary of
 * zeros is `null`, and the pane draws no box. The shape here is read
 * defensively because it can change without notice.
 *
 * Ceiling: rows are cut at ROWS per kind (the count is the site's); avatars,
 * a pull request's file list and deployments are not read; the tool's name for
 * itself (`applicationType`) is taken from the summary, so a site that names it
 * differently in the summary and the detail reads as empty.
 */
import type { CardDev, CardDevBranch, CardDevBuild, CardDevCommit, CardDevPr } from "../../shared/providers.ts";
import { epoch, isObj, jiraCall, str, withStored, type JiraCreds, type JiraResult } from "./jira.ts";

export const DEV_ROWS = 20;
/** The most tools one card is read from: a card with five is not a list of its own. */
const TOOLS_MAX = 2;

const KINDS = ["pullrequest", "branch", "repository", "build"] as const;
type Kind = (typeof KINDS)[number];

const count = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const overall = (summary: Record<string, unknown>, kind: string): Record<string, unknown> =>
  isObj(summary[kind]) && isObj(summary[kind].overall) ? summary[kind].overall : {};
const https = (v: unknown): string => {
  const s = str(v).trim();
  try { return new URL(s).protocol === "https:" ? s : ""; } catch { return ""; }
};
const nameOf = (v: unknown): string => (isObj(v) ? str(v.name) || str(v.displayName) : "");

export interface DevSummary { counts: CardDev["counts"]; buildsPassed: number; buildsFailed: number; tools: Partial<Record<Kind, string[]>> }

/** The summary body to its counts, and the tools that hold each kind; null when it is not a summary or counts nothing. */
export function summaryOf(raw: unknown): DevSummary | null {
  if (!isObj(raw) || !isObj(raw.summary)) return null;
  const s = raw.summary;
  const counts = {
    pullRequests: count(overall(s, "pullrequest").count),
    branches: count(overall(s, "branch").count),
    commits: count(overall(s, "repository").count),
    builds: count(overall(s, "build").count),
  };
  if (!counts.pullRequests && !counts.branches && !counts.commits && !counts.builds) return null;
  const tools: DevSummary["tools"] = {};
  for (const kind of KINDS) {
    const by = isObj(s[kind]) && isObj(s[kind].byInstanceType) ? s[kind].byInstanceType : {};
    const names = Object.entries(by).filter(([, v]) => !isObj(v) || count(v.count) > 0).map(([k, v]) => (isObj(v) && /^[\w-]{1,40}$/.test(str(v.type)) ? str(v.type) : k)).filter((k) => /^[\w-]{1,40}$/.test(k));
    if (names.length) tools[kind] = names.slice(0, TOOLS_MAX);
  }
  const b = overall(s, "build");
  return { counts, buildsPassed: count(b.successfulBuildCount), buildsFailed: count(b.failedBuildCount), tools };
}

const stateOf = (v: unknown): CardDevPr["state"] => {
  switch (str(v).toUpperCase()) {
    case "OPEN": return "OPEN";
    case "MERGED": return "MERGED";
    case "DECLINED": case "CLOSED": case "SUPERSEDED": return "CLOSED";
    default: return "";
  }
};

/** Every `detail[]` entry's list under `field`, flattened: one entry per connected tool. */
const listsOf = (raw: unknown, field: string): Record<string, unknown>[] =>
  isObj(raw) && Array.isArray(raw.detail) ? raw.detail.flatMap((d) => (isObj(d) && Array.isArray(d[field]) ? d[field].filter(isObj) : [])) : [];

export function pullRequestsOf(raw: unknown): CardDevPr[] {
  const out: CardDevPr[] = [];
  const seen = new Set<string>();
  for (const p of listsOf(raw, "pullRequests")) {
    const url = https(p.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url, title: str(p.name), state: stateOf(p.status), author: nameOf(p.author) || undefined,
      reviewers: (Array.isArray(p.reviewers) ? p.reviewers : []).filter(isObj).flatMap((r) => (nameOf(r) ? [{ name: nameOf(r), approved: r.approved === true }] : [])).slice(0, 10),
      from: (isObj(p.source) ? str(p.source.branch) : "") || undefined,
      into: (isObj(p.destination) ? str(p.destination.branch) : "") || undefined,
      repo: str(p.repositoryName) || undefined,
      comments: count(p.commentCount), updated: epoch(p.lastUpdate),
    });
    if (out.length >= DEV_ROWS) break;
  }
  return out;
}

export function branchesOf(raw: unknown): CardDevBranch[] {
  return listsOf(raw, "branches").flatMap((b): CardDevBranch[] => {
    const name = str(b.name);
    return name ? [{ name, url: https(b.url), repo: isObj(b.repository) ? str(b.repository.name) : "" }] : [];
  }).slice(0, DEV_ROWS);
}

export function commitsOf(raw: unknown): CardDevCommit[] {
  const out: CardDevCommit[] = [];
  for (const r of listsOf(raw, "repositories")) {
    for (const c of Array.isArray(r.commits) ? r.commits : []) {
      if (!isObj(c) || !str(c.id)) continue;
      out.push({ id: str(c.displayId) || str(c.id).slice(0, 7), message: str(c.message).split("\n")[0]!.slice(0, 200), url: https(c.url), author: nameOf(c.author) || undefined, at: epoch(c.authorTimestamp) || epoch(c.timestamp) });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, DEV_ROWS);
}

const buildState = (v: unknown): CardDevBuild["state"] => {
  const s = str(v).toLowerCase();
  if (s === "successful" || s === "success" || s === "passed") return "passed";
  if (s === "failed" || s === "failure" || s === "error") return "failed";
  if (s === "in_progress" || s === "pending" || s === "running") return "running";
  return "";
};

export function buildsOf(raw: unknown): CardDevBuild[] {
  return listsOf(raw, "builds").flatMap((b): CardDevBuild[] => {
    const name = str(b.name) || str(b.description);
    return name ? [{ name, url: https(b.url), state: buildState(b.state), at: epoch(b.lastUpdated) }] : [];
  }).sort((a, b) => b.at - a.at).slice(0, DEV_ROWS);
}

const SUMMARY = (id: string) => `/rest/dev-status/latest/issue/summary?issueId=${id}`;
const DETAIL = (id: string, tool: string, kind: Kind) => `/rest/dev-status/latest/issue/detail?issueId=${id}&applicationType=${encodeURIComponent(tool)}&dataType=${kind}`;

/** What the site's development tool knows about a card, or null when there is nothing to show (never an error). */
export async function devOf(creds: JiraCreds, issueId: string): Promise<JiraResult<CardDev | null>> {
  if (!/^\d{1,12}$/.test(issueId)) return { ok: true, data: null };
  const first = await jiraCall<unknown>(creds, SUMMARY(issueId), { optional: true });
  // A site without the panel, a changed path, a hold: nothing to draw, and nothing to say about it.
  if (!first.ok) return { ok: true, data: null };
  const sum = summaryOf(first.data);
  if (!sum) return { ok: true, data: null };
  const read = async (kind: Kind): Promise<unknown[]> => {
    const tools = sum.tools[kind] ?? [];
    return Promise.all(tools.map(async (t) => { const r = await jiraCall<unknown>(creds, DETAIL(issueId, t, kind), { optional: true }); return r.ok ? r.data : null; }));
  };
  const [pr, br, repo, bu] = await Promise.all([
    sum.counts.pullRequests ? read("pullrequest") : [], sum.counts.branches ? read("branch") : [],
    sum.counts.commits ? read("repository") : [], sum.counts.builds ? read("build") : [],
  ]);
  // One list per tool, joined as the one `detail` array each of them answered with.
  const joined = (parts: unknown[]) => ({ detail: parts.flatMap((p) => (isObj(p) && Array.isArray(p.detail) ? p.detail : [])) });
  const dev: CardDev = {
    counts: sum.counts, buildsPassed: sum.buildsPassed, buildsFailed: sum.buildsFailed,
    prs: pullRequestsOf(joined(pr)), branches: branchesOf(joined(br)), commits: commitsOf(joined(repo)), builds: buildsOf(joined(bu)),
  };
  return { ok: true, data: dev };
}

export const devStored = (issueId: string): Promise<JiraResult<CardDev | null>> => withStored((c) => devOf(c, issueId));
