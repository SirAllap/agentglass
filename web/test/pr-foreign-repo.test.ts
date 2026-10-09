/*
 * A pull request in a repository with no checkout must open, read-only.
 *
 * An Inbox row for an upstream project answered with a red sentence in the
 * header — "#6436 is in acme/orbit, and there is no checko…" — cut at 380px, so
 * neither the problem nor the way out could be read, and the row went nowhere.
 * There is no renderer in this project, so the rule is asserted against source:
 * the shape of the fix, and the three things that must not come back.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

/** The body of `locateFailed` handling: from the locate call to its `.catch`. */
const locate = code.slice(code.indexOf("api.prLocate(jump.repo)"), code.indexOf("}).catch(() => { clearPrJump(); });"));

describe("a checkout-less pull request", () => {
  it("borrows a root named by the repository instead of answering with a search", () => {
    expect(locate).not.toBe("");
    expect(locate).toContain("const ghRoot = `gh:${jump.repo}`;");
    // The pending jump is what opens the pull request once the list has named the repo.
    const before = locate.slice(0, locate.indexOf("const ghRoot"));
    expect(before).not.toContain("clearPrJump()");
  });

  it("switches every write off for the whole visit, and keeps refresh working", () => {
    expect(code).toContain('const readOnly = away?.root.startsWith("gh:") === true;');
    expect(code).toContain("const busy = running || readOnly;");
    expect(code).toMatch(/busy=\{running\} spinning=\{refreshing\}/);
  });

  it("says why in the strip, in full", () => {
    expect(code).toContain("read-only: there is no checkout of ${away.repo} on this machine");
  });

  it("never puts a failure where it is cut off", () => {
    // Only a success may go in the truncated header span.
    expect(code).toContain("{toast?.ok && <span");
    expect(code).toMatch(/toast && !toast\.ok && \(\s*<div role="alert"/);
    expect(code).not.toMatch(/max-w-\[380px\] truncate"[^>]*var\(--error\)/);
  });

  it("draws the Inbox count in the warning ink, not the bare tint on its own wash", () => {
    expect(code).toContain("`var(--${countTint}-ink)`");
    expect(code).toContain('countTint="warning"');
    expect(code).not.toContain('countTint="var(--warning)"');
  });
});
