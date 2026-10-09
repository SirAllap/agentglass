/*
 * A link on a card is text somebody typed into a ClickUp field. Every anchor
 * the card draws for one has to go through `externalUrl` (http and https only),
 * so a value that is not a web address is never drawn as a link. A rule about
 * source is asserted against source: there is no renderer here.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const fn = (name: string) => {
  const a = src.indexOf(`function ${name}(`);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf("\n}\n", a);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe("the card's link squares", () => {
  it("write an href only after externalUrl has passed it, and draw nothing when it has not", () => {
    const row = fn("RowSquare");
    expect(row).toContain("externalUrl(href)");
    expect(row).toContain("return null");
    expect(row).toContain("<a href={safe}");
    expect(row).not.toContain("<a href={href}");
  });
});
