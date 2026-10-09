/*
 * What the Checks tab says about a failed check's failures: the decisions, with
 * no React in them, so they are tested as functions (there is no renderer here).
 */
import type { CheckFailures, CiFailure, PrCheck, PrCheckJob } from "../../../shared/types.ts";

type Read = Extract<CheckFailures, { ok: true }>;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Decimal, as GitHub and a Content-Length speak: 64,000,000 bytes is "64 MB", not "61". */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} KB`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`;
}

/** The count a row can state: tests when the log named them, errors when GitHub's annotations did, nothing for a step's tail. */
export function failureRowText(s: { source: Read["source"]; framework?: CiFailure["kind"] | null; count: number; more: number }): string | null {
  const n = s.count + s.more;
  if (n === 0) return null;
  if (s.source === "log") return plural(n, "failing test");
  if (s.source === "annotations") return plural(n, "error");
  return null;
}

/** The first thing a failure says, short enough for a chip beside its title. */
export function failureGist(f: CiFailure, max = 44): string {
  const line = f.excerpt.split("\n").map((l) => l.trim()).find((l) => l && !/^[\^\d|\s]+$/.test(l) && !/^\d+ \|/.test(l)) ?? "";
  const bare = line.replace(/^(error|E|AssertionError):?\s+/i, "");
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}

/** What the copy button puts on the clipboard: the name, then exactly what the panel shows. */
export function failureCopyText(f: CiFailure): string {
  return `${f.title}\n\n${f.excerpt}`.trimEnd();
}

/** Footer of the excerpt card: what was read and what was kept of it. */
export function readLine(r: Read): string {
  const kept = r.failures.reduce((n, f) => n + f.excerpt.length, 0);
  if (r.source === "annotations") return "From GitHub's annotations";
  if (r.readBytes > 0) return `Read ${formatBytes(r.readBytes)} of log, kept ${formatBytes(kept)}`;
  return `Kept ${formatBytes(kept)}`;
}

export function logAgeDays(completedAt: string | null | undefined, now = Date.now()): number | null {
  const t = Date.parse(completedAt || "");
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null;
}

/** "14:20", in the viewer's own clock: when GitHub's hourly budget comes back. */
export function resetClock(resetAt: number | null): string | null {
  if (!resetAt) return null;
  const d = new Date(resetAt);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The biggest log "Read it anyway" can take: the server's own ceiling. Over it the button is not offered. */
export const FORCE_CAP = 150_000_000;

export type FailureView =
  | { kind: "loading" }
  | { kind: "failures"; read: Read; notice: "expired" | "toolarge" | null }
  | { kind: "no-test"; read: Read }
  | { kind: "expired"; read: Read }
  | { kind: "toolarge"; read: Read; size: number; canForce: boolean }
  | { kind: "unparsed"; read: Read }
  | { kind: "budget"; resetAt: number | null }
  | { kind: "error"; error: string };

/** One answer, one screen. The order is the honesty: a failure list always wins over the reason the log could not be read. */
export function failureView(r: CheckFailures | undefined): FailureView {
  if (!r) return { kind: "loading" };
  if (!r.ok) return r.kind === "budget" ? { kind: "budget", resetAt: r.resetAt } : { kind: "error", error: r.error };
  if (r.state === "read" && r.source === "step") return { kind: "no-test", read: r };
  if (r.failures.length) return { kind: "failures", read: r, notice: r.state === "expired" || r.state === "toolarge" ? r.state : null };
  if (r.state === "expired") return { kind: "expired", read: r };
  if (r.state === "toolarge") return { kind: "toolarge", read: r, size: r.sizeBytes ?? 0, canForce: (r.sizeBytes ?? 0) <= FORCE_CAP };
  return { kind: "unparsed", read: r };
}

/** The job behind a check row. GitHub names a check after its job, so the names match; a matrix job's check name only contains it. */
export function jobFor(check: Pick<PrCheck, "name">, jobs: PrCheckJob[]): PrCheckJob | undefined {
  return jobs.find((j) => j.name === check.name) ?? jobs.find((j) => check.name.includes(j.name));
}
