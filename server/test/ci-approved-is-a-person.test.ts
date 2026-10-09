/*
 * "APPROVED" ON A CI NOTIFICATION MEANS A PERSON APPROVED.
 *
 * The auto-review bot has write access, so a pull request nobody had read
 * reported reviewDecision APPROVED and "checks red" went out over it. The flag
 * now comes from `humanVerdict`, which leaves bots out.
 */
import { describe, expect, test } from "bun:test";
import { humanVerdict, noteCi, parseRemote, subscribeCi } from "../src/prs.ts";

const review = (login: string, state: string) => ({ state, author: { login }, submittedAt: "2026-01-01T00:00:00Z" });
const repo = parseRemote("https://github.com/acme/orbit")!;

// A suite seen running, then failing: the notification is real, only `approved` differs.
function verdictFor(number: number, reviews: ReturnType<typeof review>[]): boolean | undefined {
  const humanReview = humanVerdict(reviews, { author: "ada" });
  const base = { number, title: "ORBIT-1042 thing", url: "u", reviewDecision: "APPROVED", humanReview } as any;
  let got: boolean | undefined;
  const off = subscribeCi((v) => { got = v.approved; });
  noteCi(repo, { ...base, checks: { allDone: false, verdict: null, failing: [] } });
  noteCi(repo, { ...base, checks: { allDone: true, verdict: "red", failing: [{ name: "summary" }] } });
  off();
  return got;
}

describe("noteCi approved", () => {
  test("only a bot approved: not approved, though GitHub's reviewDecision says so", () => {
    expect(verdictFor(1042, [review("claude[bot]", "APPROVED")])).toBe(false);
  });
  test("a bot and a person approved: approved", () => {
    expect(verdictFor(1043, [review("claude[bot]", "APPROVED"), review("grace", "APPROVED")])).toBe(true);
  });
});
