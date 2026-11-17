/*
 * Setting `flow.notifyPrReviews`: off by default, the project it is on, the
 * routing from a repository event to the right project, and the line the seat
 * is told. The bot-change detection itself is pr-bot-review.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-pr-notify-"));
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DOCTRINE = join(dir, "doctrine");
process.env.AGENTGLASS_DB = join(dir, "notify.db");

const { putSetting } = await import("../src/preflightStore.ts");
const { checkPrReviewNotify, checkPrReviewNotifyForRepo, prReviewNotifySetting } = await import("../src/agents/prReviewNotify.ts");

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const ROOT = join(dir, "orbit");

describe("the setting: off by default, the list this project typed", () => {
  test("off, no list", () => {
    expect(prReviewNotifySetting(ROOT)).toEqual({ on: false, extraBots: [] });
  });

  test("a comma- and newline-separated list, trimmed, empties dropped", () => {
    putSetting(ROOT, "flow.notifyPrReviews", true);
    putSetting(ROOT, "flow.notifyPrReviews.bots", " my-bot, , review-helper\nthird-one ");
    expect(prReviewNotifySetting(ROOT)).toEqual({ on: true, extraBots: ["my-bot", "review-helper", "third-one"] });
  });
});

describe("checkPrReviewNotify — off reads and asks nothing", () => {
  test("the setting off: no list is read", async () => {
    putSetting(ROOT, "flow.notifyPrReviews", false);
    let listed = false;
    await checkPrReviewNotify(ROOT, { list: async () => { listed = true; return { ok: true, repo: "o/r", prs: [], loading: false, total: 0, hasNext: false, cursor: null } as any; } });
    expect(listed).toBe(false);
  });

  test("no GitHub remote: no list is read", async () => {
    putSetting(ROOT, "flow.notifyPrReviews", true);
    let listed = false;
    await checkPrReviewNotify(ROOT, { repoOf: async () => null, list: async () => { listed = true; return {} as any; } });
    expect(listed).toBe(false);
  });
});

describe("checkPrReviewNotify — on, a bot review change", () => {
  const pr = (n: number, botReview: { nodeId: string } | null) => ({
    number: n, title: `pr ${n}`, author: "me", state: "OPEN", isDraft: false,
    headRefName: `h${n}`, baseRefName: "main", url: `https://github.com/o/r/pull/${n}`,
    updatedAt: "", reviewDecision: null, additions: 0, deletions: 0, changedFiles: 0,
    labels: [], assignees: [], milestone: null, botReview,
  } as any);

  test("the first sight of a standing verdict is not news; the project's own worktree is a fresh latch", async () => {
    putSetting(ROOT, "flow.notifyPrReviews", true);
    const sent: string[] = [];
    const repoOf = async () => ({ nameWithOwner: "o/r", key: "o/r" }) as any;
    const list = async () => ({ ok: true, repo: "o/r", prs: [pr(901, { nodeId: "R_1" })], loading: false, total: 1, hasNext: false, cursor: null }) as any;
    await checkPrReviewNotify(ROOT, { repoOf, list, send: async (_r, t) => { sent.push(t); } });
    expect(sent).toEqual([]);

    // A later poll: the same verdict read again says nothing more.
    await checkPrReviewNotify(ROOT, { repoOf, list, send: async (_r, t) => { sent.push(t); } });
    expect(sent).toEqual([]);

    // A new verdict IS news, once, and names the worker on its branch when the session is found.
    const list2 = async () => ({ ok: true, repo: "o/r", prs: [pr(901, { nodeId: "R_2" })], loading: false, total: 1, hasNext: false, cursor: null }) as any;
    await checkPrReviewNotify(ROOT, { repoOf, list: list2, session: async () => "%1", send: async (_r, t) => { sent.push(t); } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("#901");
    expect(sent[0]).toContain("a bot");
    expect(sent[0]).toContain("a worker is on its branch");
  });
});

describe("checkPrReviewNotifyForRepo — only the projects of that repository", () => {
  test("every open root is asked which repo it has; only a match is re-checked", async () => {
    const checked: string[] = [];
    await checkPrReviewNotifyForRepo("o/r", {
      roots: () => ["/code/orbit", "/code/acme", "/code/orbit-fork"],
      repoOf: async (root) => (root === "/code/orbit" ? { nameWithOwner: "o/r" } : root === "/code/acme" ? { nameWithOwner: "o/other" } : null),
      check: async (root) => { checked.push(root); },
    });
    expect(checked).toEqual(["/code/orbit"]);
  });

  test("one project's repoIdFor throwing does not stop the rest", async () => {
    const checked: string[] = [];
    await checkPrReviewNotifyForRepo("o/r", {
      roots: () => ["/code/broken", "/code/orbit"],
      repoOf: async (root) => { if (root === "/code/broken") throw new Error("no remote"); return { nameWithOwner: "o/r" }; },
      check: async (root) => { checked.push(root); },
    });
    expect(checked).toEqual(["/code/orbit"]);
  });
});
