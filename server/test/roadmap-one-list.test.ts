/*
 * The roadmap is one list, in the README, and the CHANGELOG points at it.
 *
 * Both files used to carry the list, and the two drifted apart: each gained
 * items the other never did, and open work fell off whichever one a reader
 * happened to open. The pointer only helps while its anchor lands on the
 * heading, and the list only stays one while the CHANGELOG does not grow a copy
 * back.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

// GitHub's anchor for a heading: lowercase, punctuation and emoji dropped,
// spaces to hyphens. "## 🗺 Roadmap" becomes "-roadmap".
const anchor = (heading: string) =>
  heading.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");

describe("the roadmap", () => {
  const pointer = changelog.match(/## Where this is going\n([\s\S]*?)\n## /);

  test("the CHANGELOG points at the README's heading, and that anchor exists", () => {
    expect(pointer).not.toBeNull();
    const link = pointer![1].match(/README\.md#([\w-]+)/);
    expect(link).not.toBeNull();
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => anchor(m[1]));
    expect(headings).toContain(link![1]);
  });

  test("the CHANGELOG carries no copy of the list", () => {
    expect(pointer![1]).not.toMatch(/^- /m);
  });
});
