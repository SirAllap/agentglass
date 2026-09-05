/*
 * The catalogue is a JSON document anybody can host — validated the same
 * "shape-checked entry by entry" way plugins.ts validates a manifest: one
 * bad plugin entry loses that entry, not the whole catalogue.
 */
import { describe, expect, test } from "bun:test";
import { validateCatalogue } from "../src/plugin-catalogue.ts";

const okPlugin = {
  id: "someone.watcher",
  source: { kind: "git", url: "https://example.com/someone/watcher.git", ref: "v1.0.0" },
  description: "watches the gate",
  categories: ["monitoring"],
};

const okCatalogue = { name: "community-plugins", owner: "someone", plugins: [okPlugin] };

describe("validateCatalogue", () => {
  test("a well-formed catalogue passes with its plugin intact", () => {
    const c = validateCatalogue(okCatalogue);
    expect(typeof c).toBe("object");
    if (typeof c === "string") return;
    expect(c.plugins).toHaveLength(1);
    expect(c.plugins[0]!.id).toBe("someone.watcher");
  });

  test("not an object is refused", () => {
    expect(validateCatalogue(null)).toContain("object");
    expect(validateCatalogue([1, 2])).toContain("object");
  });

  test("a missing name is refused", () => {
    const { name: _drop, ...rest } = okCatalogue;
    expect(validateCatalogue(rest)).toContain("name");
  });

  test("one bad plugin entry is dropped, the rest of the catalogue survives", () => {
    const badUrl = { ...okPlugin, id: "someone.bad", source: { kind: "git", url: "http://example.com/x.git", ref: null } };
    const c = validateCatalogue({ ...okCatalogue, plugins: [okPlugin, badUrl] });
    if (typeof c === "string") throw new Error("catalogue itself should be valid");
    expect(c.plugins).toHaveLength(1);
    expect(c.plugins[0]!.id).toBe("someone.watcher");
  });

  test("credentials in a plugin's git URL drop that entry", () => {
    const withAuth = { ...okPlugin, source: { kind: "git", url: "https://u:p@example.com/x.git", ref: null } };
    const c = validateCatalogue({ ...okCatalogue, plugins: [withAuth] });
    if (typeof c === "string") throw new Error("catalogue itself should be valid");
    expect(c.plugins).toHaveLength(0);
  });

  test("a non-git source kind drops the entry", () => {
    const notGit = { ...okPlugin, source: { kind: "http", url: "https://example.com/x.zip" } };
    const c = validateCatalogue({ ...okCatalogue, plugins: [notGit] });
    if (typeof c === "string") throw new Error("catalogue itself should be valid");
    expect(c.plugins).toHaveLength(0);
  });
});
