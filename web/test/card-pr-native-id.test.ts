/*
 * A card on a workspace with no custom ids still asks for its pull requests.
 *
 * `cardPrsOf` used to queue nothing for a card with an empty custom id and no
 * `github` field, which is every card on a free workspace, so none of them ever
 * showed a pull request. The task's own id is what the server searches now.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { api } from "../src/lib/api.ts";
import { cardPrsOf, forgetCardPrs } from "../src/lib/cardPrStore.ts";

const real = api.clickupPrs;
afterEach(() => { (api as { clickupPrs: typeof real }).clickupPrs = real; forgetCardPrs(); });

describe("asking for a card's pull requests", () => {
  it("hands the server the task id when there is no custom id", async () => {
    const asked: string[][] = [];
    (api as { clickupPrs: unknown }).clickupPrs = (...a: string[]) => { asked.push(a); return Promise.resolve({ ok: true, prs: [] }); };
    cardPrsOf("86abc123", "", "", "/work/orbit");
    await Promise.resolve();
    expect(asked).toEqual([["", "", "/work/orbit", "86abc123"]]);
  });

  it("asks once per card, however many rows draw it", async () => {
    let n = 0;
    (api as { clickupPrs: unknown }).clickupPrs = () => { n++; return new Promise(() => {}); };
    cardPrsOf("86abc123", "", "", "/work/orbit");
    cardPrsOf("86abc123", "", "", "/work/orbit");
    expect(n).toBe(1);
  });

  it("asks nothing for a row that has no id at all", () => {
    let n = 0;
    (api as { clickupPrs: unknown }).clickupPrs = () => { n++; return new Promise(() => {}); };
    expect(cardPrsOf("", "", "", "/work/orbit")).toBeNull();
    expect(n).toBe(0);
  });
});
