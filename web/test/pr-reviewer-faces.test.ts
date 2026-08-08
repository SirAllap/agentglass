// A reviewer was drawn in four places, and they used to disagree about what a
// reviewer is. Only the list had a shape that could say "this one is a team",
// so only the list drew a team as initials; the sidebar and the overview asked
// the avatar proxy for a portrait of one and got a broken image back. The
// fourth was the browser companion, which had the opposite failure — it joined
// the objects and rendered "[object Object]" — and it is deleted.
//
// Components are pinned by reading their source here, as elsewhere in this
// suite — see budgets-pane.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const panel = read("src/components/PrPanel.tsx");

describe("a team is not drawn as a face", () => {
  test("all three reviewer surfaces go through the one component", () => {
    expect(panel).toContain("<ReviewerFace r={r} size={18} />"); // the list's stack
    expect(panel).toContain("<ReviewerFace r={p} size={16} />"); // the detail sidebar
    expect(panel).toContain("<ReviewerFace r={r} size={14} />"); // the overview field
  });

  test("the sidebar no longer hands a bare login to the avatar", () => {
    expect(panel).not.toContain("logins={d.reviewers}");
    expect(panel).toContain("people={d.reviewers}");
  });

  test("an assignee is a person with nothing to flag", () => {
    // The sidebar list is shared, and only a reviewer can be a team.
    expect(panel).toContain("people={d.assignees.map((login) => ({ login }))}");
  });
});
