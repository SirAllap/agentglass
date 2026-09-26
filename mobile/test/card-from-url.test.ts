/*
 * A pull request's task chip opens the card inside the app when the app can
 * show it, and the browser only when it cannot.
 *
 * The chip carried a task URL and always handed it to the system, so a card
 * the Cards tab already knows how to draw was read in another app, with the
 * way back to the pull request left behind. What decides "the app can show
 * it" is the URL's shape and whether that tracker is the connected one.
 */
import { describe, expect, test } from "bun:test";
import { cardIdFromUrl } from "../src/model/cardFromUrl.ts";

describe("cardIdFromUrl", () => {
  test("a task link names the card", () => {
    expect(cardIdFromUrl("https://app.clickup.com/t/86abc12xy")).toBe("86abc12xy");
  });
  test("a trailing slash, query or fragment is not part of the id", () => {
    expect(cardIdFromUrl("https://app.clickup.com/t/86abc12xy/?a=1#b")).toBe("86abc12xy");
  });
  test("a team-qualified custom id is not a card id the phone can ask for", () => {
    expect(cardIdFromUrl("https://app.clickup.com/9012345/t/ORBIT-1042")).toBeNull();
    expect(cardIdFromUrl("https://app.clickup.com/t/9012345/ORBIT-1042")).toBeNull();
  });
  test("another host, another scheme or nothing at all is not one", () => {
    expect(cardIdFromUrl("https://example.com/t/86abc12xy")).toBeNull();
    expect(cardIdFromUrl("http://app.clickup.com/t/86abc12xy")).toBeNull();
    expect(cardIdFromUrl("")).toBeNull();
    expect(cardIdFromUrl(undefined)).toBeNull();
  });
});

describe("the chip", () => {
  const chip = Bun.file(new URL("../src/review/TaskChip.tsx", import.meta.url)).text();
  const pr = Bun.file(new URL("../app/pr/[number].tsx", import.meta.url)).text();
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  test("tries the in-app card before the system browser", async () => {
    const src = code(await chip);
    expect(src.includes("cardIdFromUrl(")).toBe(true);
    expect(src.indexOf("cardIdFromUrl(")).toBeLessThan(src.indexOf("Linking.openURL"));
  });
  test("says it opens a card, not that it finds one, when it goes to the card", async () => {
    expect((await chip).includes("Open card ${ref.label}")).toBe(true);
  });
  test("the pull request screen routes it to the card screen only for the connected board", async () => {
    const src = code(await pr);
    expect(src.includes('pathname: "/card/[id]"')).toBe(true);
    expect(src.includes('provider?.id === "clickup"')).toBe(true);
  });
});
