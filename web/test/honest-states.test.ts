/*
 * The app told you a calm, confident, false thing.
 *
 * `listPrs` answers with `needsAuth`, `error`, `loading`, `hasNext` and `total`.
 * The phone kept `.prs` and dropped the rest, so FOUR different situations all
 * rendered as "No open pull requests. Nothing is waiting to land":
 *
 *   - `gh` missing or logged out — whose own type calls it "a first-class
 *     state, not an error toast";
 *   - the request failed;
 *   - the cache had not warmed yet, and the one-shot fetch never asked again;
 *   - there genuinely are none.
 *
 * Same for docker: the server distinguishes "not installed" from "daemon down"
 * from "no answer yet", and the phone collapsed all three into an empty list
 * captioned "nothing from this repo is running under Docker".
 *
 * A wrong answer delivered in the voice reserved for right ones is worse than
 * an error, because there is nothing to react to. These are rules over the
 * source: the fields must be read, and the empty state must not be the only
 * thing that can be drawn.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { listState, dockerState } from "../src/mobile/listState.ts";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("which situation an empty list is in", () => {
  /*
   * Tested as data rather than by looking for the words in the markup. The
   * first version of this did the latter — and stayed green when the branch
   * that shows those words was disabled, because the strings were still in the
   * file. That is the whole reason the decision is a function now.
   */
  test("a signed-out gh outranks everything else it also reports", () => {
    // It reports zero rows and usually an error too, and neither of those
    // leads anywhere. The cause does.
    expect(listState({ prs: [], needsAuth: true, error: "gh: not found", loading: false }))
      .toEqual({ kind: "needs-auth" });
  });

  test("a failure is not an empty list", () => {
    expect(listState({ prs: [], error: "network is unreachable" }))
      .toEqual({ kind: "error", message: "network is unreachable" });
  });

  test("a cold cache is not an empty list either", () => {
    expect(listState({ prs: [], loading: true })).toEqual({ kind: "loading" });
  });

  test("nothing fetched yet is loading, not empty", () => {
    expect(listState(null)).toEqual({ kind: "loading" });
  });

  test("genuinely none is the only thing that reads as none", () => {
    expect(listState({ prs: [], loading: false })).toEqual({ kind: "empty" });
  });

  test("rows stay on screen through a background refresh", () => {
    // Once there is something to show, a refresh is not a reason to take it
    // away and replace it with a spinner.
    expect(listState({ prs: [{}], loading: true })).toEqual({ kind: "rows", truncated: false });
    expect(listState({ prs: [{}], error: "stale" })).toEqual({ kind: "rows", truncated: false });
  });

  test("a truncated list says so", () => {
    expect(listState({ prs: [{}], hasNext: true })).toEqual({ kind: "rows", truncated: true });
  });
});

describe("the pull request screen is wired to it", () => {
  const repo = read("mobile/MobileRepo.tsx");

  test("the whole response is kept, not just the rows", () => {
    expect(code(repo)).toContain("PrListResponse");
    expect(code(repo)).not.toContain("then((r) => setPrs(r.prs))");
  });

  test("every branch listState can return is drawn", () => {
    const src = code(repo);
    for (const kind of ["needs-auth", "error", "loading", "empty"]) {
      expect(src, `no branch for ${kind}`).toContain(`prList.kind === "${kind}"`);
    }
  });

  test("the signed-out state says what to do about it", () => {
    expect(repo).toContain("gh auth login");
  });

  test("a cold cache retries instead of reporting none", () => {
    const cold = code(repo).slice(code(repo).indexOf("prState?.loading"));
    expect(cold).toContain("setPrNonce");
  });
});

describe("docker", () => {
  test("a daemon that is down is not an empty project", () => {
    expect(dockerState({ available: false, error: "is the daemon running?" }, 0))
      .toEqual({ kind: "unavailable", message: "is the daemon running?" });
  });

  test("it says something even when the server did not", () => {
    const s = dockerState({ available: false, error: null }, 0);
    expect(s.kind).toBe("unavailable");
    expect((s as { message: string }).message).toContain("cannot reach the docker daemon");
  });

  test("available and empty really is empty", () => {
    expect(dockerState({ available: true, error: null }, 0)).toEqual({ kind: "empty" });
    expect(dockerState({ available: true, error: null }, 2)).toEqual({ kind: "rows" });
  });

  test("the phone keeps whether docker answered", () => {
    const app = code(read("mobile/MobileApp.tsx"));
    expect(app).toContain("setDocker(");
    expect(app).toContain("o.available");
  });

  test("the containers facet is wired to it", () => {
    const src = code(read("mobile/MobileRepo.tsx"));
    expect(src).toContain('ctrList.kind === "unavailable"');
    expect(src).toContain('ctrList.kind === "empty"');
  });
});

describe("the rule, over the tree", () => {
  test("no mobile screen throws away a response's own error state", () => {
    /*
     * Both faults were the same shape: a `.then` that reached past an outer
     * object for the array inside it. The rest of that object is how the server
     * says what went wrong, and dropping it is what leaves the UI with nothing
     * to draw but the empty case.
     *
     * The rule is narrow on purpose — it names the two response shapes that
     * carry a first-class error state, rather than banning destructuring.
     */
    const offenders: string[] = [];
    for (const file of walk(join(SRC, "mobile"))) {
      const src = code(readFileSync(file, "utf8"));
      if (/api\.prList\([^)]*\)[\s\S]{0,80}?\.then\(\s*\(\s*\w+\s*\)\s*=>\s*set\w+\(\s*\w+\.prs\s*\)/.test(src)
        || /api\.dockerOverview\(\)[\s\S]{0,80}?\.then\(\s*\(\s*\w+\s*\)\s*=>\s*set\w+\(\s*\w+\.containers\s*\)/.test(src)) {
        offenders.push(file.replace(SRC, ""));
      }
    }
    expect(offenders, "a response's error state is being discarded at the call site").toEqual([]);
  });
});
