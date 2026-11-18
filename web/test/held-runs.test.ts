/*
 * A contributor's pull request whose workflows GitHub holds for a maintainer
 * (shared/heldRuns.ts). Invented: acme/orbit #322 by contributor-a, from a fork,
 * required checks `build` and `catalogue` never reported because both runs wait
 * with status action_required.
 */
import { describe, expect, test } from "bun:test";
import { heldRunsOf, heldRunsTitle, approveRunsError, APPROVE_RUNS_LABEL, APPROVE_ANYWAY_LABEL, ciTouchingFiles, ciChangeLine, heldRunsWarnings, WORKFLOW_RUN_FILES } from "../../shared/heldRuns.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeBlockers } from "../../shared/mergeBlockers.ts";
import { mergePath } from "../../shared/mergePath.ts";
import { overviewVerdict } from "../src/lib/prOverviewView.ts";
import { cardView } from "../src/lib/prCardView.ts";
import { cardMenu, type CardMenu, type MenuItem } from "../src/lib/prCardMenu.ts";
import { cardReviewers } from "../src/lib/cardReviewers.ts";
import type { PrCheckRollup } from "../../shared/types.ts";

const RUNS = [
  { id: 9101, name: "build", status: "action_required", conclusion: null },
  { id: 9102, name: "catalogue", status: "completed", conclusion: "action_required" },
  { id: 9103, name: "labeler", status: "completed", conclusion: "success" },
];
const gate: any = {
  permission: "ADMIN", canBypass: false, protectionVisible: true, locked: false, approvals: 1, codeOwners: false,
  lastPushApproval: false, dismissStale: false, conversationResolution: false, upToDate: false, signatures: false,
  deployments: [], requiredContexts: ["build", "catalogue"], mergeQueue: false, inQueue: false,
};
const pr322 = {
  state: "OPEN", mergeState: "BLOCKED", baseRefName: "main", gate, checksAll: [] as any[],
  author: "contributor-a", viewerDidAuthor: false, reviewDecision: "REVIEW_REQUIRED" as const,
  now: Date.parse("2026-11-13T12:00:00Z"),
};

describe("held runs: which ones", () => {
  test("action_required as status or conclusion is held; a finished run is not", () => {
    expect(heldRunsOf(RUNS)).toEqual([{ id: 9101, name: "build" }, { id: 9102, name: "catalogue" }]);
  });
  test("junk and repeats are dropped", () => {
    expect(heldRunsOf(null)).toEqual([]);
    expect(heldRunsOf([{ id: "x", status: "action_required" }, { id: 9101, status: "action_required", name: "build" }, { id: 9101, status: "action_required" }])).toEqual([{ id: 9101, name: "build" }]);
  });
});

describe("held runs: what the panel says", () => {
  test("without held runs it is the old 'never reported' row, the author's to move", () => {
    const b = mergeBlockers({ ...pr322 }).find((x) => x.kind === "required-missing")!;
    expect(b.title).toBe("build, catalogue never reported — required");
    const row = mergePath({ ...pr322 }).rows.find((r) => r.kind === "required-missing")!;
    expect(row.mover).toBe("author");
  });

  test("with 2 held runs the banner asks for your approval and you move it", () => {
    const blockers = mergeBlockers({ ...pr322, heldRuns: 2 });
    const b = blockers.find((x) => x.kind === "required-missing")!;
    expect(b).toMatchObject({ weight: "blocks", title: "Waiting for your approval to run 2 workflows (a contributor's pull request)" });
    expect(b.detail).not.toContain("push");

    const path = mergePath({ ...pr322, heldRuns: 2 });
    const rows = path.rows.filter((r) => r.kind === "required-missing");
    expect(rows.map((r) => r.title)).toEqual(["build", "catalogue"]);
    for (const r of rows) expect(r.mover).toBe("you");
    expect(path.hero.parts.map((p) => p.text).join("")).toBe("Waiting for your approval to run 2 workflows (a contributor's pull request).");
    expect(path.hero.primary).toEqual({ id: "approve-runs", label: "Approve workflows to run" });

    const v = overviewVerdict({ ready: false, why: b.title, conflicted: false, checksFailing: 0, checksPassed: 0, approvedBy: [] });
    expect(`${v.lead} ${v.text}`).toBe("Merging is blocked. Waiting for your approval to run 2 workflows (a contributor's pull request).");
  });

  test("one held run is said in the singular", () => {
    expect(heldRunsTitle(1)).toBe("Waiting for your approval to run 1 workflow (a contributor's pull request)");
  });

  test("GitHub's refusals in plain words", () => {
    expect(approveRunsError("gh: Must have admin rights to Repository. (HTTP 403)")).toBe("GitHub refused: only a maintainer of this repository can approve these workflows.");
    expect(approveRunsError("gh: This run is not waiting for approval (HTTP 422)")).toBe("Already approved: nothing is waiting for approval any more.");
  });
});

describe("held runs: the card's menu", () => {
  const roll: PrCheckRollup = { total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] };
  const pr = (o: Record<string, unknown> = {}) => ({
    number: 322, title: "Add a catalogue entry", author: "contributor-a", state: "OPEN" as const, isDraft: false,
    headRefName: "patch-1", baseRefName: "main", mergeable: "MERGEABLE" as const,
    reviewDecision: "REVIEW_REQUIRED" as const, checks: roll, humanReview: undefined, ...o,
  });
  const items = (m: CardMenu): MenuItem[] => [...m.rows.filter((r): r is MenuItem => r.kind === "item"), ...m.more, m.close];
  const menu = (p = pr()) => cardMenu({
    p, view: cardView({ p, filed: { lane: "land", reason: "x" }, reviewers: cardReviewers(undefined), tracker: "card", hasTaskProvider: true, mergeLock: null }),
    pinned: false, mode: "none", stacked: false,
  });
  test("a fork's open pull request offers Approve workflows to run", () => {
    expect(items(menu(pr({ isCrossRepository: true }))).find((i) => i.id === "approve")).toMatchObject({ label: APPROVE_RUNS_LABEL });
  });
  test("a branch of this repository, or a merged one, does not", () => {
    expect(items(menu()).some((i) => i.id === "approve")).toBe(false);
    expect(items(menu(pr({ isCrossRepository: true, state: "MERGED" }))).some((i) => i.id === "approve")).toBe(false);
  });
});

describe("held runs: only a person's click approves", () => {
  test("the route goes through the shared person-only gate, before the switch, with no check of its own", async () => {
    const src = await Bun.file(new URL("../../server/src/index.ts", import.meta.url)).text();
    const gateAt = src.indexOf("personOnlyPrRefusal(pathname, b, mayPublishReview(req, caller))");
    const caseAt = src.indexOf('case "/prs/approve-runs"');
    expect(gateAt).toBeGreaterThan(0);
    expect(caseAt).toBeGreaterThan(gateAt);
    expect(src).not.toContain('pathname === "/prs/approve-runs" && !mayPublishReview');
    expect(src).toContain("approveRuns(root, n, b.headSha)");
  });
});

describe("held runs: the files that change what CI runs", () => {
  const cases: [string, string][] = [
    ["workflow", ".github/workflows/ci.yml"],
    ["package.json, any depth", "web/package.json"],
    ["Makefile", "Makefile"],
    ["scripts/ at the root", "scripts/release.sh"],
    ["scripts/ below", "tools/scripts/lint.ts"],
    ["*.sh", "build.sh"],
    ["Dockerfile", "Dockerfile"],
    ["*.Dockerfile", "docker/api.Dockerfile"],
    ["bun.lock", "bun.lock"],
    ["bun.lockb", "web/bun.lockb"],
    ["bunfig.toml at the root", "bunfig.toml"],
    ["bunfig.toml below", "server/bunfig.toml"],
    ["package-lock.json", "web/package-lock.json"],
    ["yarn.lock", "yarn.lock"],
    ["pnpm-lock.yaml", "pnpm-lock.yaml"],
    ["action.yml anywhere", "tools/setup/action.yml"],
    ["action.yaml anywhere", "action.yaml"],
    ["*.gradle", "mobile/android/app/build.gradle"],
    ["*.gradle.kts", "settings.gradle.kts"],
    ["gradlew", "mobile/android/gradlew"],
    ["gradle/ at the root", "gradle/wrapper/gradle-wrapper.properties"],
    ["gradle/ below", "mobile/android/gradle/libs.versions.toml"],
    ["a file a workflow runs: electron/build.mjs", "electron/build.mjs"],
    ["a file a workflow runs: server/src/index.ts", "server/src/index.ts"],
  ];
  for (const [what, path] of cases) test(`flags ${what} (${path})`, () => expect(ciTouchingFiles([path])).toEqual([path]));

  test("the rest is not flagged, and the order is kept", () => {
    expect(ciTouchingFiles(["src/catalogue/entry.ts", "README.md", "docs/scripts.md", "electron/main.ts", "action.yml.md", "gradle.md"])).toEqual([]);
    expect(ciTouchingFiles(["yarn.lock", "README.md", ".github/workflows/ci.yml"])).toEqual(["yarn.lock", ".github/workflows/ci.yml"]);
  });

  test("every file this repository's workflows run by name is flagged", () => {
    const root = new URL("../../", import.meta.url).pathname;
    const named = new Set<string>();
    for (const f of readdirSync(join(root, ".github/workflows")).filter((x) => /\.ya?ml$/.test(x))) {
      const wf = Bun.YAML.parse(readFileSync(join(root, ".github/workflows", f), "utf8")) as any;
      for (const job of Object.values(wf?.jobs ?? {}) as any[]) {
        const jobDir = job?.defaults?.run?.["working-directory"] ?? wf?.defaults?.run?.["working-directory"] ?? "";
        for (const step of job?.steps ?? []) {
          if (typeof step?.run !== "string") continue;
          for (const m of step.run.matchAll(/(?:^|[\s"'=(])((?:\.\.?\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:mjs|cjs|js|ts|sh|py))\b/g)) {
            const p = join(step["working-directory"] ?? jobDir, m[1]!);
            if (existsSync(join(root, p))) named.add(p);
          }
        }
      }
    }
    expect(named.size).toBeGreaterThan(0);
    expect([...named].filter((p) => !ciTouchingFiles([p]).length)).toEqual([]);
    for (const p of WORKFLOW_RUN_FILES) expect(named.has(p)).toBe(true);
  });

  test("the warning line", () => {
    expect(ciChangeLine([".github/workflows/ci.yml"])).toBe("This pull request changes what CI runs: .github/workflows/ci.yml");
    expect(ciChangeLine(["a.sh", "b.sh", "c.sh", "d.sh", "e.sh", "f.sh"])).toBe("This pull request changes what CI runs: a.sh, b.sh, c.sh, d.sh +2 more");
    expect(ciChangeLine(ciTouchingFiles(["src/catalogue/entry.ts"]))).toBeNull();
  });
});

describe("held runs: one click, and the banner says what it skips", () => {
  test("full list, no CI file: no warning, the button approves at once", () => {
    expect(heldRunsWarnings(["src/catalogue/entry.ts"], 0)).toEqual([]);
    expect(mergePath({ ...pr322, heldRuns: 2, heldRunsWarn: [] }).hero).toMatchObject({ primary: { id: "approve-runs", label: APPROVE_RUNS_LABEL } });
    expect(mergePath({ ...pr322, heldRuns: 2, heldRunsWarn: [] }).hero.warnings).toBeUndefined();
  });
  test("a CI file changed: the warning names it and the button reads Approve anyway", () => {
    const warn = heldRunsWarnings(["src/catalogue/entry.ts", ".github/workflows/ci.yml"], 0);
    expect(warn).toEqual(["This pull request changes what CI runs: .github/workflows/ci.yml"]);
    const hero = mergePath({ ...pr322, heldRuns: 2, heldRunsWarn: warn }).hero;
    expect(hero.primary).toEqual({ id: "approve-runs", label: APPROVE_ANYWAY_LABEL });
    expect(hero.warnings).toEqual(warn);
  });
  test("GitHub cut the list short: never 'No CI files changed', and Approve anyway", () => {
    const warn = heldRunsWarnings(["src/catalogue/entry.ts"], 140);
    expect(warn).toEqual(["Could not check every file (GitHub listed 1 of 141)"]);
    expect(warn.join(" ")).not.toContain("No CI files changed");
    expect(mergePath({ ...pr322, heldRuns: 2, heldRunsWarn: warn }).hero.primary?.label).toBe("Approve anyway");
  });
  test("the panel opens no pop-up, sends the head it showed, and the card menu stops at the warning", async () => {
    const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    const fn = src.slice(src.indexOf("const doApproveRuns = async"), src.indexOf("const doClose = async"));
    expect(fn).not.toContain("ask(");
    expect(fn).toContain("api.prApproveRuns(root, detail.number, detail.headSha");
    expect(fn.indexOf("!anyway")).toBeLessThan(fn.indexOf("api.prApproveRuns"));
    expect(src).toContain("onApproveRuns={() => doApproveRuns(true)}");
  });
});
