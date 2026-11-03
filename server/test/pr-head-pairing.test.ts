/*
 * Checks are only ever written next to the head they ran on. A rollup read of a
 * newer commit used to be filed on the cached detail of the previous head, and
 * a detail whose rollup trailed its head handed both to the board's row, so a
 * card paired the new head with the old green. Invented repo (acme/orbit #478).
 */
import { describe, expect, it } from "bun:test";
const { projectDetailOnRow, projectRowOnDetail, projectChecks, __seedDetail, __peekDetail } = await import("../src/prs.ts");

const OLD = "1".repeat(40), NEW = "2".repeat(40);
const rollup = (pending: number) => ({ total: 3, success: 3 - pending, failure: 0, skipped: 0, pending, allDone: !pending, verdict: pending ? null : "green", failing: [] }) as never;
const repo = { key: "github.com/acme/orbit", host: "github.com", owner: "acme", name: "orbit", nameWithOwner: "acme/orbit" };
const row = (o: object) => ({ number: 478, updatedAt: "2026-10-27T10:00:00Z", checks: rollup(0), headSha: OLD, labels: [], ...o }) as never;
const det = (o: object) => ({ number: 478, updatedAt: "2026-10-27T10:05:00Z", checks: rollup(0), headSha: NEW, checksSha: OLD, labels: [], checksAll: [], ...o }) as never;

describe("a detail whose checks trail its head", () => {
  it("does not hand the new head or the old checks to the board's row", () => {
    const out = projectDetailOnRow(row({}), det({ checks: rollup(2) })) as { headSha: string; checks: { pending: number } };
    expect([out.headSha, out.checks.pending]).toEqual([OLD, 0]);
  });
  it("hands both when they belong together", () => {
    const out = projectDetailOnRow(row({}), det({ checksSha: NEW, checks: rollup(1) })) as { headSha: string };
    expect(out.headSha).toBe(NEW);
  });
});

describe("a row never moves a detail's head or checks", () => {
  it("even when the row is newer", () => {
    const d = det({ checksSha: NEW, checks: rollup(1), updatedAt: "2026-10-27T09:00:00Z" });
    const out = projectRowOnDetail(d, row({ updatedAt: "2026-10-27T11:00:00Z", headSha: OLD, checks: rollup(0), title: "t" })) as { headSha: string; checks: { pending: number }; title: string };
    expect([out.headSha, out.checks.pending, out.title]).toEqual([NEW, 1, "t"]);
  });
});

describe("a rollup read lands on the cached detail", () => {
  it("of its own commit: written with its sha", () => {
    __seedDetail(`${repo.key}#478`, det({ checksSha: NEW, checks: rollup(2) }));
    projectChecks(repo, 478, rollup(0), [], Date.now() + 1, NEW);
    const got = __peekDetail(`${repo.key}#478`) as { checks: { pending: number }; checksSha: string };
    expect([got.checks.pending, got.checksSha]).toEqual([0, NEW]);
  });
  it("of another commit: the head moved, the cached detail goes", () => {
    __seedDetail(`${repo.key}#478`, det({ checksSha: OLD }));
    projectChecks(repo, 478, rollup(2), [], Date.now() + 1, "3".repeat(40));
    expect(__peekDetail(`${repo.key}#478`)).toBeUndefined();
  });
});
