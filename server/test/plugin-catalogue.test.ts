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

  test("a catalogue longer than the cap says how long it really was", () => {
    /* A shelf that silently shows the first five hundred of three thousand is
       a shelf that lies about what is on it — and the window draws the
       difference rather than the count it received. */
    const many = Array.from({ length: 640 }, (_, i) => ({ ...okPlugin, id: `someone.w${i}` }));
    const c = validateCatalogue({ ...okCatalogue, plugins: many });
    if (typeof c === "string") throw new Error(c);
    expect(c.plugins.length).toBe(500);
    expect(c.total).toBe(640);
  });

  test("what a card needs rides along when the catalogue carries it, and its absence lists anyway", () => {
    const rich = { ...okPlugin, title: "Local review", publisher: "acme", draws: ["panel", "pr-button"], added: "2026-09-20" };
    const c = validateCatalogue({ ...okCatalogue, plugins: [rich, okPlugin] });
    if (typeof c === "string") throw new Error(c);
    expect(c.plugins[0]).toMatchObject({ title: "Local review", publisher: "acme", draws: ["panel", "pr-button"], added: "2026-09-20" });
    expect(c.plugins[1]!.title).toBeUndefined();
    expect(c.total).toBe(2);
  });

  test("not an object is refused", () => {
    expect(validateCatalogue(null)).toContain("object");
    expect(validateCatalogue([1, 2])).toContain("object");
  });

  test("a name with a space in it is a name — this project's own catalogue has one", () => {
    /* It was refused by the rule a PLUGIN name is held to, which exists
       because a plugin's name becomes a folder. A catalogue's name is a
       heading, and "agentglass plugins" was turned away by its own app. */
    const c = validateCatalogue({ ...okCatalogue, name: "agentglass plugins" });
    if (typeof c === "string") throw new Error(c);
    expect(c.name).toBe("agentglass plugins");
  });

  test("a name that could hide what it is, or is not a name at all, is still refused", () => {
    for (const name of ["", "   ", "x".repeat(61), "agentglass\u0000plugins", "two\nlines", 7]) {
      expect(validateCatalogue({ ...okCatalogue, name })).toContain("name");
    }
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

  test("a pinned entry keeps its commit and its content hash", () => {
    const pinned = { ...okPlugin, source: { kind: "git", url: okPlugin.source.url, ref: "0123456789abcdef0123456789abcdef01234567" }, sha256: "a".repeat(64) };
    const c = validateCatalogue({ ...okCatalogue, plugins: [pinned] });
    if (typeof c === "string") throw new Error(c);
    expect(c.plugins[0]!.source.ref).toBe(pinned.source.ref);
    expect(c.plugins[0]!.sha256).toBe("a".repeat(64));
  });

  test("a hash that is not a sha256 drops the entry rather than installing it unchecked", () => {
    /* Dropping it quietly would install the entry with no hash to compare,
       which is the unpinned install the hash exists to prevent. */
    for (const sha256 of ["a".repeat(63), "A".repeat(64), "z".repeat(64), 7, ""]) {
      const c = validateCatalogue({ ...okCatalogue, plugins: [{ ...okPlugin, sha256 }] });
      if (typeof c === "string") throw new Error(c);
      expect(c.plugins, String(sha256)).toHaveLength(0);
    }
  });

  /*
   * An id is compared with the ids already listed exactly as written, so
   * "local-review" with a newline on the end passed as a new one, and the
   * trim here then showed a second local-review card under somebody else's
   * byline. An id that is not already what it would be trimmed to is not
   * trimmed into one.
   */
  test("an id with space or a newline around it drops the entry instead of passing for another", () => {
    for (const id of ["local-review\n", " local-review", "local-review\t"]) {
      const c = validateCatalogue({ ...okCatalogue, plugins: [{ ...okPlugin, id }, { ...okPlugin, id: "local-review" }] });
      if (typeof c === "string") throw new Error(c);
      expect(c.plugins.map((p) => p.id), JSON.stringify(id)).toEqual(["local-review"]);
    }
  });
});
