import { describe, expect, test } from "bun:test";
import { withoutAuthor } from "../src/lib/reviewerPick.ts";

const opt = (value: string) => ({ value, label: value });

describe("who a pull request can ask for a review", () => {
  test("the author is not offered, whatever the case of their login", () => {
    const out = withoutAuthor([opt("orbit-dev"), opt("Ada"), opt("sam")], "ada");
    expect(out.map((o) => o.value)).toEqual(["orbit-dev", "sam"]);
  });

  test("nobody is dropped when the author is unknown", () => {
    expect(withoutAuthor([opt("ada"), opt("sam")], undefined).length).toBe(2);
    expect(withoutAuthor([opt("ada"), opt("sam")], "").length).toBe(2);
  });

  test("the reviewers picker applies it", async () => {
    const src = await Bun.file(new URL("../src/components/PrAskPicker.tsx", import.meta.url)).text();
    expect(src).toContain("mode, author: d.author, roster,");
    /* The author's own row says why it is greyed (askView), so the header line that said it again is gone. */
    expect(src).not.toContain("authorLeftOutHint(");
    const who = await Bun.file(new URL("../src/lib/prAskWho.ts", import.meta.url)).text();
    expect(who).toContain("withoutAuthor(i.people.map((p) => ({ value: p.login })), reviewing ? i.author : undefined)");
  });
});
