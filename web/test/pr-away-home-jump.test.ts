// A jump to a pull request in the repository the "away" strip returns to was
// located as one more away: the strip read "Showing acme/orbit on top of
// acme/orbit". Going home has to clear the strip instead.
import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const at = src.indexOf("const home = away?.back;");

test("a jump to the strip's own home repository clears the strip before it locates", () => {
  expect(at).toBeGreaterThan(0);
  const guard = src.slice(at, src.indexOf("void api.prLocate(jump.repo)", at));
  expect(guard).toContain("home.repo.toLowerCase() === jump.repo.toLowerCase()");
  expect(guard).toContain("setAway(null)");
  expect(guard).toContain("setRoot(home.root)");
});

test("a located checkout that is one of the open projects is not a visit", () => {
  const i = src.indexOf("const open = projects.some((p) => p.root === r.root);");
  expect(i).toBeGreaterThan(0);
  expect(src.slice(i, i + 260)).toContain("setAway(open ? null :");
});

test("the visit strip names the folder it reads from, not a project it sits on top of", () => {
  expect(src).toContain("a checkout that is not one of your open projects");
  expect(src).not.toContain("on top of ${away.back.repo}");
});
