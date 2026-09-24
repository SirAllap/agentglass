/**
 * How a change's risk flags read on screen. Which flags exist is decided once,
 * on the server, by `shared/riskFlags.ts`; this only orders them, colours them
 * and words the tooltip, for the diff panel and the fleet card alike.
 *
 * No flags draws nothing. There is deliberately no "clean" state: the rules
 * cover a handful of shapes, and a green tick next to a change they did not
 * understand would claim a review that never happened.
 */
import type { RiskFlag, RiskKind } from "../../../shared/types.ts";

/** Worst first — the order a reviewer should read them in. */
const ORDER: RiskKind[] = ["secret", "ci", "auth", "migration", "deps", "deletion"];
const LABEL: Record<RiskKind, string> = {
  secret: "secret", ci: "CI", auth: "auth", migration: "migration", deps: "deps", deletion: "deletion",
};
const SHOWN = 3;

export function riskLabel(kind: RiskKind): string {
  return LABEL[kind] ?? kind;
}

/** A secret is the one that is already a leak the moment it is written; the
 *  rest are "read this first", not "this is wrong". */
export function riskColor(kinds: RiskKind[]): string {
  return kinds.includes("secret") ? "var(--error)" : "var(--warning)";
}

/** The chip: each kind once, worst first, the tail counted. Null when there is
 *  nothing to say. */
export function riskChip(risks: readonly RiskFlag[] | undefined): { text: string; tone: string } | null {
  if (!risks?.length) return null;
  const kinds = ORDER.filter((k) => risks.some((r) => r.kind === k));
  const head = kinds.slice(0, SHOWN).map(riskLabel).join(" · ");
  const more = kinds.length - SHOWN;
  return { text: more > 0 ? `${head} +${more}` : head, tone: riskColor(kinds) };
}

/** One line per flag: `file:line — reason`, the file by its name only. */
export function riskTitle(risks: readonly (RiskFlag & { file?: string })[]): string {
  return risks.map((r) => {
    const name = r.file ? r.file.slice(r.file.lastIndexOf("/") + 1) : "";
    const where = name ? `${name}${r.line ? `:${r.line}` : ""} — ` : r.line ? `line ${r.line} — ` : "";
    return `${riskLabel(r.kind)}: ${where}${r.reason}`;
  }).join("\n");
}
