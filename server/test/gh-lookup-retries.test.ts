/*
 * Finding `gh` again after failing to find it once.
 *
 * Reported from the button that submits a review: "gh not found", while every
 * other thing the pull request panel does went on working from a shell. It could
 * not be reproduced by running the code from a terminal, and that is the clue —
 * a shell resolves the binary afresh on every command, and this process resolved
 * it once and remembered the answer.
 *
 * It remembered the WRONG kind of answer. A hit is worth caching: the path does
 * not move while the app runs. A miss is not: a PATH that was not ready yet, or
 * a lookup that lost a race at boot, would pin "gh not found" on every call for
 * the rest of the process's life — and the message points at gh, which is
 * installed and on the PATH, so there is nowhere to look.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/prs.ts", import.meta.url)).text();
const block = src.slice(src.indexOf("let ghPath"), src.indexOf("export interface GhResult"));

describe("looking up the gh binary", () => {
  it("cannot hold a remembered failure, by its type", () => {
    /* `string | null | undefined` had three states and used `undefined` to mean
       "not asked yet" — so `null` meant "asked, and there is none", which is
       exactly the answer that must not survive. Two states cannot express it. */
    expect(block).toContain("let ghPath: string | null = null;");
    expect(block).not.toContain("undefined");
  });

  it("returns the cached path without looking again", () => {
    // The hit is worth keeping: it does not move while the app runs, and this
    // is called on every request the panel makes.
    expect(block).toContain("if (ghPath) return ghPath;");
  });

  it("looks again when it has none", () => {
    expect(block).toContain('ghPath = Bun.which("gh") ?? null;');
  });

  it("still finds it on this machine, which is the case that must not regress", () => {
    // A cheap end-to-end: the lookup itself, through the same call the code
    // makes. If this fails the test is telling the truth about the machine.
    expect(Bun.which("gh")).toBeTruthy();
  });
});
