import { describe, expect, it } from "bun:test";

/*
 * The ping frame on a pull request that has no card.
 *
 * The shipped `ready-for-review` frame lists the facts one per row, and one row
 * is `card   {card} {cardUrl}`. With no tracker id both placeholders are empty,
 * and what reached the agent was the word "card" and a gap, which it then had
 * to decide whether to mention. The row goes; a card keeps it byte for byte.
 */
const C = await import("../src/reviewRecipes.ts");

const base = {
  number: 17, repo: "acme/shop", head: "abc1234", branch: "fix/checkout-total",
  title: "Fix the total", author: "someone", url: "https://github.com/acme/shop/pull/17",
  who: "Ada", note: "",
};
const frame = () => C.BUILT_IN_RECIPES.find((r) => r.id === "ready-for-review")!.body;

describe("the chat ping with no card", () => {
  it("leaves no card row and no placeholder behind", () => {
    const out = C.expandRecipe(frame(), { ...base, card: "", cardUrl: "" });
    expect(out).not.toContain("{card");
    expect(out).not.toMatch(/^\s*card\s*$/m);
    expect(out).not.toMatch(/^\s*card\s{2,}/m);
    // The rest of the facts are still there, in order.
    expect(out).toContain("pull request  #17 — Fix the total");
    expect(out.indexOf("https://github.com/acme/shop/pull/17")).toBeLessThan(out.indexOf("branch        fix/checkout-total"));
  });

  it("keeps the row when there is a card", () => {
    const out = C.expandRecipe(frame(), { ...base, card: "ORBIT-1042", cardUrl: "https://tasks.example/t/ORBIT-1042" });
    expect(out).toContain("card          ORBIT-1042 https://tasks.example/t/ORBIT-1042");
  });

  it("drops only lines that are about nothing but the card", () => {
    const ctx = { ...base, card: "", cardUrl: "" };
    expect(C.expandRecipe("a\n  card  {card} {cardUrl}\nb", ctx)).toBe("a\nb");
    // A sentence of the person's own that also names the link stays as written.
    expect(C.expandRecipe("see {url} and {card}", ctx)).toBe(`see ${base.url} and `);
    // Another placeholder on the line keeps it, empty or not.
    expect(C.expandRecipe("x\n{note}\n{card}\ny", ctx)).toBe("x\n\ny");
  });
});
