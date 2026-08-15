/*
 * A review you started on the GitHub website, seen from here.
 *
 * GitHub lets you leave line comments from its own UI and never submit them.
 * They are real — the next verdict you send from this app finishes THAT review
 * and posts them — and until this change the app said the opposite twice: the
 * file tree marked nothing, and the Review tab printed "No line comments queued
 * here" over three of them.
 *
 * Reported as: a button to go straight to the pending comment on GitHub, a mark
 * in the file list saying which files carry one, and something in the rail that
 * says one exists without reprinting the whole message.
 *
 * The Edit link is the load-bearing part and the one worth explaining: no API
 * edits a comment inside a pending review without submitting the review, so the
 * only honest affordance is a way OUT to the page where it can be changed. If
 * `url` ever stops being fetched, the button disappears silently — hence the
 * assertion on the query itself.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { heldOn, type RailHeld } from "../src/lib/fileRail.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("which pending comments belong to the file on screen", () => {
  const held: RailHeld[] = [
    { path: "src/pay.ts", line: 40, body: "second" },
    { path: "src/other.ts", line: 1, body: "elsewhere" },
    { path: "src/pay.ts", line: null, body: "outdated" },
    { path: "src/pay.ts", line: 12, body: "first" },
  ];

  it("keeps this file's, in line order", () => {
    expect(heldOn(held, "src/pay.ts").map((h) => h.body)).toEqual(["first", "second", "outdated"]);
  });

  it("puts the outdated ones last, because they have no row to sit beside", () => {
    expect(heldOn(held, "src/pay.ts").at(-1)?.line).toBeNull();
  });

  it("says nothing when nothing is selected, and nothing when the caller cannot know", () => {
    expect(heldOn(held, null)).toEqual([]);
    expect(heldOn(undefined, "src/pay.ts")).toEqual([]);
  });
});

describe("the address of a pending comment", () => {
  it("is asked for from GitHub", () => {
    // The whole feature hangs off this field being in the selection set.
    const s = read("server/src/prs.ts");
    expect(s).toContain("comments(first:100){nodes{url path line");
    expect(s).toContain('url: typeof c.url === "string" ? c.url : ""');
  });

  it("survives the wire type, which is where it would be dropped in silence", () => {
    const s = read("web/src/lib/api.ts");
    expect(s).toContain('body: string; url: string }[] }>("/prs/pending-review"');
  });
});

describe("the four places it now shows", () => {
  it("offers a way to GitHub from the comment drawn on the line", () => {
    const s = read("web/src/components/PrPanel.tsx");
    // Both blocks: the one under its line, and the one under the file when the
    // diff does not reach the line it was left on.
    expect((s.match(/title="Edit this pending comment on GitHub"/g) ?? []).length).toBe(2);
  });

  it("marks the files that carry one in the tree", () => {
    const s = read("web/src/components/PrPanel.tsx");
    expect(s).toContain("const heldFor = (p: string) => held.filter((x) => x.path === p).length;");
    expect(s).toContain("drafts={draftsFor} pending={heldFor}");
    expect(s).toContain("drafted on GitHub in your unsubmitted review");
  });

  it("tells the rail, short, with the way out", () => {
    const s = read("web/src/components/FileRail.tsx");
    expect(s).toContain('<Sec title="Drafted on GitHub"');
    expect(s).toContain('title="Edit this comment on GitHub"');
    // Short: a preview, not the message. The Review tab is where they print whole.
    expect(s).toContain("<Quote body={h.body} max={90} />");
  });

  it("stops the review box claiming nothing will be sent", () => {
    const rail = read("web/src/components/FileRail.tsx");
    /* The count the verdict line quotes has to include them, because submitting
       from here finishes the review holding them. */
    expect(rail).toContain("+ (held?.length ?? 0)");
    const panel = read("web/src/components/PrPanel.tsx");
    expect(panel).toContain("already drafted on GitHub, below.");
  });
});
