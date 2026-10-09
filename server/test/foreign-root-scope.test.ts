/*
 * A `gh:owner/name` root reads a pull request with the person's gh token, which
 * sees every repository they can; the scopes are written against the open
 * project. So only a caller that could already do anything here may use one:
 * a read-only phone asking for another repository's diff is refused.
 */
import { describe, expect, test } from "bun:test";
import { mayReadForeignRoot, type Caller } from "../src/auth.ts";

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

describe("mayReadForeignRoot", () => {
  test("this machine and a full-scope device may", () => {
    expect(mayReadForeignRoot(null)).toBe(true);
    expect(mayReadForeignRoot({ kind: "machine", scope: "full" })).toBe(true);
    expect(mayReadForeignRoot({ kind: "device", scope: "full" } as Caller)).toBe(true);
  });
  test("a narrower device, any plugin, the understudy and a seat may not", () => {
    for (const c of [
      { kind: "device", scope: "read" },
      { kind: "device", scope: "answer" },
      { kind: "plugin", scope: "full", plugin: "orbit-panel" },
      { kind: "plugin", scope: "read", plugin: "orbit-panel" },
      { kind: "machine", scope: "full", principal: "understudy" },
      { kind: "machine", scope: "full", principal: "seat" },
    ] as Caller[]) expect(mayReadForeignRoot(c), JSON.stringify(c)).toBe(false);
  });
});

describe("the request path", () => {
  test("every authenticated request with a gh: root is judged right after the scope check", () => {
    const start = src.indexOf('caller = callerFor(req, url, AUTH_TOKEN ?? "");');
    const end = src.indexOf("THE UNIVERSAL NET", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(block).toContain('if (isForeignRoot(url.searchParams.get("root") ?? "") && !mayReadForeignRoot(caller)) return foreignRefused();');
  });
  test("every pull request POST that reads a root from its body asks the same question first", () => {
    // Split at each top-level route of the dispatcher; a block that names a
    // /prs/ POST and reads `b.root` must refuse a gh: root before it uses one.
    const guard = "if (isForeignRoot(b.root) && !mayReadForeignRoot(caller)) return foreignRefused();";
    const blocks = src.split("\n    if (").filter((b) => {
      const head = b.split("\n", 1)[0]!;
      return head.includes('"/prs/') && head.includes('"POST"') && b.includes("b.root");
    });
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (const b of blocks) {
      const head = b.split("\n", 1)[0]!;
      const at = b.indexOf(guard);
      expect(at, head).toBeGreaterThan(0);
      expect(b.slice(0, at).includes("b.root"), `${head}: b.root is used before the guard`).toBe(false);
    }
  });
});
