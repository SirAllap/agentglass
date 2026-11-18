// "Report a problem" (#208): pure decisions only. The server hands over raw
// pieces, the web builds the text here, and every free-text piece goes through
// the scrubber from #207 before it can be shown, copied or linked.
import { dropHeadlessKeyBody, redactText } from "./scrub.ts";

export interface BundleInput {
  version?: string;
  commit?: string;
  os?: string;
  arch?: string;
  bun?: string;
  electron?: string;
  stallLog?: string;
  errorLog?: string;
  /** Names of settings that are switched on. Never values. */
  enabledSettings?: string[];
}

export const LOG_LINES = 50;
export const ISSUE_URL_MAX = 2000;
const NAME_MAX = 60;

/** The only settings the report may name: switch-style prefs whose key holds no
 *  user text. Nothing is matched by prefix, so a key that embeds a repo name
 *  can never be listed. */
export const KNOWN_SETTING_KEYS: readonly string[] = [
  "agentglass.ci.onlyApproved",
  "agentglass.notes.dnd",
  "agentglass.notes.breakThrough",
  "agentglass.diff.split",
  "agentglass.diff.wrap",
  "agentglass.diff.noWhitespace",
  "agentglass.diff.v3.showIgnored",
  "agentglass.diff.v3.showOutside",
  "agentglass.jira.confirmBoardMoves",
];

/** The last `n` non-empty lines. The whole text is scrubbed BEFORE it is split,
 *  so a secret that spans lines (a key body, wrapped JSON) is seen whole. */
export function tailScrubbed(text: string | undefined, n = LOG_LINES): string {
  if (!text) return "(empty)";
  const lines = redactText(dropHeadlessKeyBody(text)).split("\n").filter((l) => l.trim());
  return lines.slice(-n).join("\n") || "(empty)";
}

/** A setting name is kept only if it is on the allowlist; anything else is dropped. */
export function safeSettingNames(names: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const n of names ?? []) {
    if (typeof n === "string" && n.length <= NAME_MAX && KNOWN_SETTING_KEYS.includes(n)) out.add(n);
  }
  return [...out].sort();
}

const field = (v: string | undefined) => redactText(v ?? "") || "unknown";

export function buildBundle(i: BundleInput): string {
  return [
    "## Build",
    `version: ${field(i.version)}`,
    `commit: ${field(i.commit)}`,
    `os: ${field(i.os)} ${field(i.arch)}`,
    `bun: ${field(i.bun)}`,
    `electron: ${field(i.electron)}`,
    "",
    "## Settings switched on (names only)",
    safeSettingNames(i.enabledSettings).join(", ") || "(none)",
    "",
    `## Server stall log (last ${LOG_LINES} lines)`,
    tailScrubbed(i.stallLog),
    "",
    `## Server error log (last ${LOG_LINES} lines)`,
    tailScrubbed(i.errorLog),
    "",
  ].join("\n");
}

/** New-issue URL: title and a short body only. The long text stays on the clipboard. */
export function issueUrl(repo: string, i: Pick<BundleInput, "version" | "commit" | "os">): string {
  const title = "Problem report";
  const bodyFor = (v: string) =>
    `What happened:\n\n\nBuild ${v}\n\nThe diagnostic text is on my clipboard; I will paste it below.`;
  const build = [i.version, i.commit, i.os].map((x) => redactText(x ?? "")).filter(Boolean).join(" ");
  const make = (v: string) => `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(bodyFor(v))}`;
  let v = build;
  while (make(v).length > ISSUE_URL_MAX && v) v = v.slice(0, -10);
  return make(v);
}
