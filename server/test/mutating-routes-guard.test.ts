/*
 * Which gate each route is behind, asserted against the source.
 *
 * The bug this pins is not a behaviour anybody can reach on a loopback install
 * — it is a CLASSIFICATION, and classifications drift one route at a time. #469
 * was 22 mutating routes on the permissive gate against 5 on the strict one,
 * and nothing had gone wrong: the split was where the code happened to land,
 * and every new route landed on whichever line was copied.
 *
 * So this reads `index.ts` and checks the pairing, which is the only form of
 * this test that fails when somebody adds a route rather than when somebody
 * breaks one. A running-server test would need `AGENTGLASS_BIND=0.0.0.0` to
 * show any difference at all, which is the one configuration a test must not
 * create on a developer's machine.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
const lines = src.split("\n");

/** The guard a route sits behind: the first one inside its block. */
function guardFor(route: string): "strict" | "permissive" | "none" {
  const at = lines.findIndex((l) => l.includes(route));
  expect(at, `no route matching ${route} — this test is reading the wrong code`).toBeGreaterThan(0);
  for (let i = at; i < Math.min(at + 6, lines.length); i++) {
    if (lines[i].includes("trustedCaller(req, from)")) return "strict";
    if (lines[i].includes("localOrigin(req)")) return "permissive";
  }
  return "none";
}

/*
 * Everything that executes or changes the machine. Named individually rather
 * than by prefix: the point is that a person had to decide about each one, and
 * a list that a prefix could satisfy would pass for a route nobody classified.
 */
const MUTATING = [
  `pathname === "/workspace"`,
  `pathname === "/projects/clone"`,
  `pathname === "/projects/hidden"`,
  `pathname === "/projects/new"`,
  `pathname === "/agents/connect"`,
  `pathname === "/budgets/set"`,
  `pathname === "/gate/decide"`,
  `pathname === "/control"`,
  `pathname === "/browser-use/install"`,
  `pathname === "/git/commit"`,
  `pathname === "/theme/sync"`,
  `pathname === "/editor/open"`,
  `pathname === "/browser/places"`,
  `pathname === "/browser/visit"`,
  `pathname === "/scratch/image"`,
  `pathname === "/machine/unlock"`,
  `pathname === "/machine/kill"`,
  `pathname === "/terminal/panes/focus"`,
  `pathname === "/chat/send"`,
  `pathname === "/chat/pane/close"`,
  `pathname === "/chat/pane/pin"`,
  `pathname === "/chat/pane/key"`,
  `pathname === "/codex/send"`,
  `pathname === "/antigravity/send"`,
  `pathname.startsWith("/git/")`,
  `pathname.startsWith("/docker/")`,
  `pathname.startsWith("/issues/")`,
  `pathname.startsWith("/prs/")`,
  `pathname.startsWith("/browser/")`,
];

describe("the gate a route sits behind", () => {
  for (const route of MUTATING) {
    test(`${route} executes or mutates, so it refuses a caller with no Origin`, () => {
      expect(guardFor(route)).toBe("strict");
    });
  }

  /*
   * The exception, and it is a read wearing a POST: `/git/status` takes a body
   * because the question needs one, not because it changes anything. Pinned so
   * that a later sweep does not "finish the job" and break the hooks.
   */
  test("/git/status is a read done over POST and stays permissive", () => {
    expect(guardFor(`pathname === "/git/status"`)).toBe("permissive");
  });

  /*
   * The surface-wide gate stays permissive on purpose: it is what lets the
   * hooks and the OTLP exporters reach the server at all, and every route that
   * matters has its own gate after it. If this ever reads `strict`, ingestion
   * is broken and no test of a mutating route would have noticed.
   */
  test("the one gate over the whole surface still admits a non-browser caller", () => {
    const at = lines.findIndex((l) => l.includes("One gate for the whole surface"));
    expect(at).toBeGreaterThan(0);
    const near = lines.slice(at, at + 8).join("\n");
    expect(near).toContain("localOrigin(req)");
    expect(near).not.toContain("trustedCaller");
  });

  /*
   * And the property the whole change rests on: on a loopback bind, an
   * Origin-less caller is still allowed, so nothing about a default install
   * changes. If this line ever stops reading `from === "loopback"`, every route
   * moved by #469 silently becomes stricter than it was meant to be.
   */
  test("the strict gate still allows a loopback caller with no Origin", () => {
    const at = lines.findIndex((l) => l.includes("function trustedCaller("));
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at, at + 14).join("\n")).toContain('if (!o) return from === "loopback"');
  });
});
