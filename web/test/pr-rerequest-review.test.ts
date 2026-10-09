import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

// The reviewer list used to show who had answered with no way to ask them to
// look again: that took a trip to GitHub's own sidebar. The ↻ beside each
// answered reviewer re-requests through the same /prs/reviewers call the
// Reviewers picker uses.
describe("re-request review from the sidebar", () => {
  const start = src.indexOf("function ReviewerList(");
  const body = src.slice(start, src.indexOf("\n}\n", start));

  test("is offered only where GitHub offers it", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('r.state !== "awaiting"');
    expect(body).toContain("!r.again");
    expect(body).toContain("!r.isBot");
    expect(body).toContain("!r.isTeam");
    expect(body).toContain("r.login !== author");
    expect(body).toContain('title={ask && ask !== "busy" ? `Could not ask again: ${ask}` : "Re-request review"}');
  });

  test("asks through the reviewers endpoint, adding that one login, behind the layer", () => {
    expect(src).toContain("onAsk={onRerequest}");
    expect(src).toContain("field(reviewersPatch(d.number, [login], []), () => api.prReviewers(root, d.number, [login], [])");
  });

  test("is not offered beside a tick — an approver reads confusing with a ↻ next to it", () => {
    expect(body).toContain('r.state !== "approved"');
  });
});

describe("a reviewer asked again", () => {
  const start = src.indexOf("function ReviewerList(");
  const body = src.slice(start, src.indexOf("\n}\n", start));

  test("reads as pending, the way GitHub shows it, not as an arrow beside the old verdict", () => {
    expect(body).toContain("const pending = !!r.again || ask === \"done\";");
    expect(body).toContain("`Awaiting requested review from ${r.login}`");
    expect(body).toContain('background: "var(--warning)"');
    expect(body).not.toContain('title="Asked to look again"');
  });
});
