import { describe, expect, test } from "bun:test";
import { withoutAuthor, authorLeftOutHint } from "../src/lib/reviewerPick.ts";

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

  test("the hint says why only when the person at the keys opened it and would have been listed", () => {
    expect(authorLeftOutHint("ada", true, ["ada", "sam"])).toContain("You opened this pull request");
    expect(authorLeftOutHint("ada", false, ["ada", "sam"])).toBeUndefined();
    expect(authorLeftOutHint("ada", true, ["sam"])).toBeUndefined();
  });

  test("the reviewers picker applies it", async () => {
    const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    expect(src).toContain("options={withFrequent(withoutAuthor([...reviewedOptions, ...rest], d.author), loadUse())}");
  });
});
