// The pure parts of the pull-request panel, pinned.
//
// Everything that talks to `gh` is left to manual QA — it needs a network and a
// login. What is tested here is the logic that decides what the panel *says*,
// and each of these encodes something learned from a real pull request rather
// than an invented case:
//
//  - eighteen worktrees of one clone must collapse to one repo, or the panel
//    fetches the same list eighteen times;
//  - skipped checks are not failures (a real PR: 43 success, 18 skipped, green);
//  - the CI notification fires once at the end, not once per check;
//  - the asset proxy is a URL taken from a pull request body, which is a string
//    a stranger wrote.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-prs-"));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "p.db");

const prs = await import("../src/prs.ts");

describe("repo identity", () => {
  test("ssh and https forms of one repo produce one key", () => {
    const a = prs.parseRemote("git@github.com:acme/orbit.git");
    const b = prs.parseRemote("https://github.com/acme/orbit.git");
    expect(a?.key).toBe("github.com/acme/orbit");
    expect(b?.key).toBe(a?.key);
    expect(a?.nameWithOwner).toBe("acme/orbit");
  });

  test("a trailing .git is optional, and ssh:// is understood", () => {
    expect(prs.parseRemote("https://github.com/SirAllap/agentglass")?.key).toBe("github.com/SirAllap/agentglass");
    expect(prs.parseRemote("ssh://git@github.com/SirAllap/agentglass.git")?.key).toBe("github.com/SirAllap/agentglass");
  });

  test("a self-hosted host keeps its own name", () => {
    expect(prs.parseRemote("git@git.example.com:team/app.git")?.host).toBe("git.example.com");
  });

  /** Guessing here would point `gh` at somebody else's repository. */
  test("anything that is not obviously a forge remote is refused", () => {
    expect(prs.parseRemote("/srv/mirrors/thing.git")).toBeNull();
    expect(prs.parseRemote("file:///srv/mirrors/thing.git")).toBeNull();
    expect(prs.parseRemote("")).toBeNull();
    expect(prs.parseRemote("git@github.com:noslash")).toBeNull();
  });
});

describe("check rollup", () => {
  const run = (status: string, conclusion: string, name = "c") =>
    ({ __typename: "CheckRun", name, status, conclusion });

  test("skipped is not failure — 43 green + 18 skipped is a green PR", () => {
    const raw = [
      ...Array.from({ length: 43 }, (_, i) => run("COMPLETED", "SUCCESS", `ok${i}`)),
      ...Array.from({ length: 18 }, (_, i) => run("COMPLETED", "SKIPPED", `skip${i}`)),
    ];
    const { rollup } = prs.rollupChecks(raw);
    expect(rollup.total).toBe(61);
    expect(rollup.success).toBe(43);
    expect(rollup.skipped).toBe(18);
    expect(rollup.failure).toBe(0);
    expect(rollup.allDone).toBe(true);
    expect(rollup.verdict).toBe("green");
  });

  test("one running check means no verdict at all, however many have passed", () => {
    const raw = [
      ...Array.from({ length: 60 }, (_, i) => run("COMPLETED", "SUCCESS", `ok${i}`)),
      run("IN_PROGRESS", "", "still-going"),
    ];
    const { rollup } = prs.rollupChecks(raw);
    expect(rollup.pending).toBe(1);
    expect(rollup.allDone).toBe(false);
    expect(rollup.verdict).toBeNull();
  });

  test("failures are named, because a count alone sends you to the browser", () => {
    const { rollup } = prs.rollupChecks([
      run("COMPLETED", "SUCCESS", "lint"),
      run("COMPLETED", "FAILURE", "pytest · vr/health"),
    ]);
    expect(rollup.verdict).toBe("red");
    expect(rollup.failing.map((f) => f.name)).toEqual(["pytest · vr/health"]);
  });

  test("the older StatusContext shape is understood too", () => {
    const { rollup } = prs.rollupChecks([
      { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
      { __typename: "StatusContext", context: "ci/other", state: "PENDING" },
    ]);
    expect(rollup.success).toBe(1);
    expect(rollup.pending).toBe(1);
    expect(rollup.allDone).toBe(false);
  });

  test("no checks at all is not a green PR", () => {
    const { rollup } = prs.rollupChecks([]);
    expect(rollup.allDone).toBe(false);
    expect(rollup.verdict).toBeNull();
  });
});

describe("bot digest", () => {
  /** The real one is 46,551 characters. Three numbers is what gets read. */
  test("pulls the figures out of a coverage table", () => {
    const body = [
      "<!-- Pytest Coverage Comment: django-tests | django -->",
      "| Name | Stmts | Miss | Cover |",
      "|------|-------|------|-------|",
      "| a.py | 412 | 31 | 92% |",
      "Total coverage: 87.4%",
      "Diff coverage: 100%",
    ].join("\n");
    const d = prs.digestBotComment(body);
    // A decimal must survive: "87.4%" digested as "4%" once, because the
    // percentage pattern only allowed whole numbers and matched the tail.
    expect(d).toContain("87.4%");
  });

  test("falls back to the first real line rather than to nothing", () => {
    const d = prs.digestBotComment("<!-- marker -->\n\n# Heading\n| table |\nDeployed to staging.");
    expect(d).toBe("Deployed to staging.");
  });

  test("a comment with nothing in it digests to nothing, not to a lie", () => {
    expect(prs.digestBotComment("")).toBeNull();
  });

  /** The real ones are HTML tables. Left as-is, the fallback reported
   *  `<a href=...><img alt="Coverage"` as though that were the summary. */
  test("HTML coverage tables reduce to the scope and the number", () => {
    const body = '<a href="x"><img alt="Coverage" src="y"></a><table>' +
      "<tr><td>Coverage (django)</td></tr><tr><td>TOTAL</td><td>1829</td><td>315</td><td>84%</td></tr></table>";
    expect(prs.digestBotComment(body)).toBe("django coverage 84%");
  });

  test("a patch-coverage comment says which files, or says there were none", () => {
    expect(prs.digestBotComment("## Patch coverage . exapi\n# Diff Coverage\nNo lines with coverage information in this diff."))
      .toContain("nothing measurable");
    const d = prs.digestBotComment("## Patch coverage . django\n- a&#46;py (100%)\n- b&#46;py (100%)");
    expect(d).toContain("django patch");
    expect(d).toContain("2 files");
  });

  test("tags never leak into the digest", () => {
    expect(prs.digestBotComment("<div><b>Deployed</b> to staging.</div>")).toBe("Deployed to staging.");
  });
});

describe("checklist", () => {
  test("counts what is still open in a real template", () => {
    const body = [
      "## Checklist",
      "- [x] I have followed the contributing document.",
      "- [x] I have added the necessary tests.",
      "- [ ] I have updated the documentation accordingly.",
      "- [ ] If there are changes in prompts, I have added the `Evals` label.",
      "",
      "## Context",
      "- a normal bullet, not a checkbox",
    ].join("\n");
    const items = prs.parseChecklist(body);
    expect(items).toHaveLength(4);
    expect(items.filter((i) => !i.checked)).toHaveLength(2);
    expect(items[0]!.text).toContain("contributing document");
  });

  test("a body with no checklist yields none", () => {
    expect(prs.parseChecklist("just prose\n\nand more prose")).toHaveLength(0);
  });

  /**
   * The bug this pins found nothing on a live pull request while every test
   * above passed.
   *
   * GitHub stores bodies with CRLF endings. In a JavaScript regex `.` matches
   * no line terminator, and `\r` is one — so `(.*)$` cannot match a line that
   * still carries its carriage return, and splitting on `\n` alone leaves one
   * on every line. Nine real checkboxes, zero found, and a fixture written with
   * `\n` would never have shown it.
   */
  test("CRLF bodies parse identically to LF ones", () => {
    const lf = [
      "## Checklist",
      "- [x] I have followed the contributing document.",
      "- [ ] I have updated the documentation accordingly.",
      "- [x] When ready for review, add the label.",
    ].join("\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(prs.parseChecklist(lf)).toHaveLength(3);
    expect(prs.parseChecklist(crlf)).toEqual(prs.parseChecklist(lf));
    expect(prs.parseChecklist(crlf).filter((c) => !c.checked)).toHaveLength(1);
  });
});

describe("asset proxy allowlist", () => {
  /**
   * These URLs come out of pull request bodies. Without the allowlist this
   * endpoint is a request forger with the server's network position — the
   * cloud metadata endpoint and the local disk both being one string away.
   */
  test("admits the hosts that actually serve PR images", () => {
    expect(prs.assetAllowed("https://github.com/user-attachments/assets/abc")).not.toBeNull();
    expect(prs.assetAllowed("https://user-images.githubusercontent.com/1/x.png")).not.toBeNull();
    expect(prs.assetAllowed("https://t14295188.p.clickup-attachments.com/t1/x.png")).not.toBeNull();
  });

  test("refuses anything else, and anything not https", () => {
    expect(prs.assetAllowed("http://github.com/user-attachments/assets/abc")).toBeNull();
    expect(prs.assetAllowed("file:///etc/passwd")).toBeNull();
    expect(prs.assetAllowed("https://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(prs.assetAllowed("https://evil.example.com/x.png")).toBeNull();
    expect(prs.assetAllowed("not a url")).toBeNull();
  });

  /** A suffix match written carelessly matches `evilgithubusercontent.com`. */
  test("the suffix match cannot be spoofed by a lookalike domain", () => {
    expect(prs.assetAllowed("https://evilgithubusercontent.com/x.png")).toBeNull();
    expect(prs.assetAllowed("https://github.com.evil.example/x.png")).toBeNull();
  });
});

describe("CI notification latch", () => {
  const rollup = (over: Record<string, unknown> = {}) =>
    ({ total: 61, success: 43, failure: 0, skipped: 18, pending: 0, allDone: true, verdict: "green", failing: [], ...over });

  const pr = (n: number, checks: Record<string, unknown> = rollup()) => ({
    number: n, title: `pr ${n}`, author: "x", state: "OPEN", isDraft: false,
    headRefName: "h", baseRefName: "main", url: "u", updatedAt: "", reviewDecision: null,
    additions: 0, deletions: 0, changedFiles: 0, labels: [], checks,
  }) as unknown as Parameters<typeof prs.noteCi>[1];

  const repo = prs.parseRemote("https://github.com/o/r")!;

  test("sixty-one checks produce one notification, not sixty-one", () => {
    const seen: string[] = [];
    const off = prs.subscribeCi((v) => seen.push(`${v.number}:${v.verdict}`));
    prs.noteCi(repo, pr(101));
    prs.noteCi(repo, pr(101)); // the next poll, same answer
    prs.noteCi(repo, pr(101));
    off();
    expect(seen).toEqual(["101:green"]);
  });

  test("a suite still running says nothing at all", () => {
    const seen: string[] = [];
    const off = prs.subscribeCi((v) => seen.push(String(v.number)));
    prs.noteCi(repo, pr(102, rollup({ pending: 3, allDone: false, verdict: null })));
    off();
    expect(seen).toEqual([]);
  });

  /** A re-run puts checks back to pending; the second real result must arrive. */
  test("a re-run clears the latch, so the next verdict is delivered", () => {
    const seen: string[] = [];
    const off = prs.subscribeCi((v) => seen.push(`${v.number}:${v.verdict}`));
    prs.noteCi(repo, pr(103, rollup({ failure: 1, success: 42, verdict: "red", failing: [{ name: "pytest" }] })));
    prs.noteCi(repo, pr(103, rollup({ pending: 5, allDone: false, verdict: null }))); // re-running
    prs.noteCi(repo, pr(103));                                                        // green this time
    off();
    expect(seen).toEqual(["103:red", "103:green"]);
  });

  test("the failing check names ride along, so the message can name them", () => {
    let got: string[] = [];
    const off = prs.subscribeCi((v) => { got = v.failing; });
    prs.noteCi(repo, pr(104, rollup({ failure: 1, verdict: "red", failing: [{ name: "pytest \u00b7 vr/health" }] })));
    off();
    expect(got).toEqual(["pytest \u00b7 vr/health"]);
  });
});

describe("CI notifications are scoped to your stake (#244)", () => {
  // The panel warms all three filters for the tab counts, so `all` is fetched
  // passively \u2014 hundreds of strangers' PRs on a busy repo. Only the filters that
  // encode a stake may push a notification; `all` renders check states without
  // notifying. Pinned so nobody flips `all` back on.
  test("mine and review notify, all does not", () => {
    expect(prs.ciNotifiesFor("mine")).toBe(true);
    expect(prs.ciNotifiesFor("review")).toBe(true);
    expect(prs.ciNotifiesFor("all")).toBe(false);
  });
});
