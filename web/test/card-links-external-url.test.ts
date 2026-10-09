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

const read = (rel: string) => Bun.file(new URL(`../src/components/${rel}`, import.meta.url)).text();

describe("every other anchor that carries a provider's or a plugin's address", () => {
  it("the card's Open button and its Links list", () => {
    expect(src).toContain("<a href={externalUrl(t.url)} target=\"_blank\"");
    expect(src).toContain("<a key={u} href={externalUrl(u)}");
    expect(src).not.toContain("<a href={t.url}");
    expect(src).not.toContain("<a key={u} href={u}");
  });
  it("the file viewer's open-outside link", async () => {
    const files = await read("CardFiles.tsx");
    expect(files).toContain("<a href={externalUrl(open.url)}");
    expect(files).not.toContain("<a href={open.url}");
  });
  it("a plugin tree's link, so a middle click does not follow the raw value", async () => {
    const tree = await read("plugins/PluginTree.tsx");
    expect(tree).toContain("<a href={externalUrl(node.href)}");
    expect(tree).not.toContain("<a href={node.href}");
  });
  it("the scope chip's link", async () => {
    const chrome = await read("workspace/Chrome.tsx");
    expect(chrome).toContain("externalUrl(href)");
    expect(chrome).not.toContain("<a href={href}");
  });
});
