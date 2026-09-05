/*
 * Comparing two containers' environments.
 *
 * "It works on mine" is, on this machine, usually a difference of one variable
 * between two containers that look identical — the same image, the same compose
 * file, two worktrees. Finding it today means running `docker inspect` twice and
 * reading two eighty-line blocks side by side, which is why nobody does it and
 * the afternoon goes instead.
 *
 * The care here is entirely about secrets. An environment is the densest
 * concentration of credentials on a developer machine, and a diff view is
 * exactly the thing that would print them into a screenshot. So values that
 * look like credentials never leave this module: they are compared, and what
 * travels is "same" or "different".
 */

/** `KEY=value`, as docker hands it over, into a map. A value containing `=` is
 *  normal (URLs, JSON) and only the first one separates. */
export function envMap(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0) { out.set(line, ""); continue; }
    out.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return out;
}

/**
 * Does this variable hold a credential?
 *
 * Deliberately broad. A false positive costs one masked value in a diff nobody
 * needed; a false negative puts somebody's production token in a screenshot.
 * Matched on the NAME only — a heuristic on the value would leak exactly the
 * things whose shape is unusual.
 */
export function isSecret(name: string): boolean {
  return /(?:^|_)(?:KEY|TOKEN|SECRET|PASS|PASSWORD|PWD|AUTH|CREDENTIAL|CREDENTIALS|SIGNATURE|PRIVATE|SESSION|COOKIE|DSN|SALT|PEPPER)(?:_|$)/i.test(name)
    // Names that are one word and obviously a credential.
    || /^(?:password|secret|token|apikey|api_key|authorization)$/i.test(name);
}

export type EnvChange = "only-a" | "only-b" | "changed" | "same";

export interface EnvDiffRow {
  name: string;
  change: EnvChange;
  /** Absent for a secret, whatever the change. */
  a?: string;
  b?: string;
  /** True when the value was withheld on purpose, so the UI can say so rather
   *  than looking like it lost the data. */
  masked: boolean;
}

/**
 * The difference between two environments.
 *
 * Sorted by how interesting it is — what only one side has first, then what
 * changed, then the rest — because the answer to "why does yours work" is
 * nearly always in the first three rows and never in the eightieth.
 */
export function envDiff(aLines: string[], bLines: string[]): EnvDiffRow[] {
  const a = envMap(aLines);
  const b = envMap(bLines);
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  const rows: EnvDiffRow[] = [];

  for (const name of names) {
    const inA = a.has(name);
    const inB = b.has(name);
    const va = a.get(name) ?? "";
    const vb = b.get(name) ?? "";
    const change: EnvChange = !inB ? "only-a" : !inA ? "only-b" : va === vb ? "same" : "changed";
    const masked = isSecret(name);
    rows.push({
      name, change, masked,
      // Values only for what is not a credential. The comparison still happened
      // — `change` is computed above from the real values — so a rotated token
      // still shows up as "changed" without showing either token.
      ...(masked ? {} : { ...(inA ? { a: va } : {}), ...(inB ? { b: vb } : {}) }),
    });
  }

  const rank: Record<EnvChange, number> = { "only-b": 0, "only-a": 1, changed: 2, same: 3 };
  return rows.sort((x, y) => rank[x.change] - rank[y.change] || x.name.localeCompare(y.name));
}

/** The one-line summary the UI leads with: how many differ, of how many. */
export function diffSummary(rows: EnvDiffRow[]): { differ: number; total: number } {
  return { differ: rows.filter((r) => r.change !== "same").length, total: rows.length };
}
