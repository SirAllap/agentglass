/*
 * What a credential short of `full` may no longer reach, decision by decision.
 *
 * Four holes, each measured with a device token against an isolated server
 * before it was closed: the notification mirror answered a read-only phone with
 * a live socket; an `answer` phone could wake any finished session by id and
 * then approve the tool call it had asked for; the pull-request image proxy
 * lent the user's GitHub token to any github.com URL a read caller named; and
 * the docker slow lane started as many processes as a read caller asked for.
 * The route-level half, with real sockets and a real gate, is in
 * read-scope-live.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeNeeded } from "../src/auth.ts";
import { scopedTurn, noteTurnSender, sentTurnTo, turnSenderKey } from "../src/chat.ts";
import { takeSpawnSlot } from "../src/spawncap.ts";

// prs.ts reads its pull-request cache when it loads; point it at an empty one
// before it does, never at the developer's own.
const savedCache = process.env.AGENTGLASS_CACHE_DIR;
const cacheDir = mkdtempSync(join(tmpdir(), "agx-readscope-"));
process.env.AGENTGLASS_CACHE_DIR = cacheDir;
const { assetReferenced, __seedDetail } = await import("../src/prs.ts");
afterAll(() => {
  if (savedCache === undefined) delete process.env.AGENTGLASS_CACHE_DIR; else process.env.AGENTGLASS_CACHE_DIR = savedCache;
  rmSync(cacheDir, { recursive: true, force: true });
});

const SESSION = "11111111-2222-3333-4444-555555555555";

describe("the notification mirror is the desk's", () => {
  test("the socket and the probe both need full", () => {
    expect(scopeNeeded("GET", "/notifications")).toBe("full");
    expect(scopeNeeded("GET", "/notifications/capability")).toBe("full");
  });
});

describe("answer means a session that is running now", () => {
  test("an idle session is refused, whatever the id looks like", () => {
    const s = scopedTurn("answer", "default", undefined, SESSION, false);
    expect(s.ok).toBe(false);
    expect(s.ok ? "" : s.error).toContain("idle");
  });

  test("a live one still gets its reply", () => {
    expect(scopedTurn("answer", "default", undefined, SESSION, true)).toEqual({ ok: true, mode: "default", allow: [] });
  });

  test("the desk is not asked", () => {
    expect(scopedTurn("full", "default", undefined, SESSION, false).ok).toBe(true);
  });
});

describe("the device that sent a turn", () => {
  test("is remembered against that session and nobody else's", () => {
    noteTurnSender("aaaaaaaa-0000-4000-8000-000000000001", "device-a");
    expect(sentTurnTo("aaaaaaaa-0000-4000-8000-000000000001", "device-a")).toBe(true);
    expect(sentTurnTo("aaaaaaaa-0000-4000-8000-000000000001", "device-b")).toBe(false);
    expect(sentTurnTo("aaaaaaaa-0000-4000-8000-000000000002", "device-a")).toBe(false);
  });

  test("no device, no record — the desk is never held by this", () => {
    noteTurnSender("aaaaaaaa-0000-4000-8000-000000000003", null);
    expect(sentTurnTo("aaaaaaaa-0000-4000-8000-000000000003", null)).toBe(false);
    expect(sentTurnTo("aaaaaaaa-0000-4000-8000-000000000003", undefined)).toBe(false);
  });

  test("a plugin is remembered by name, the machine not at all", () => {
    expect(turnSenderKey({ device: { id: "device-a" } })).toBe("device-a");
    expect(turnSenderKey({ plugin: "orbit-notes" })).toBe("plugin:orbit-notes");
    expect(turnSenderKey({})).toBeNull();
    expect(turnSenderKey(null)).toBeNull();
  });

  test("the latest sender is the one held", () => {
    noteTurnSender("aaaaaaaa-0000-4000-8000-000000000004", "device-a");
    noteTurnSender("aaaaaaaa-0000-4000-8000-000000000004", "device-b");
    expect(sentTurnTo("aaaaaaaa-0000-4000-8000-000000000004", "device-a")).toBe(false);
    expect(sentTurnTo("aaaaaaaa-0000-4000-8000-000000000004", "device-b")).toBe(true);
  });
});

describe("the image proxy lends the token only to what a pull request carries", () => {
  const SHOT = "https://github.com/user-attachments/assets/0f0e0d0c-1111-4222-8333-944445555666";
  __seedDetail("acme/orbit#1042", {
    number: 1042,
    body: `Before and after:\n\n![before](${SHOT})\n<img src="https://private-user-images.githubusercontent.com/1/after.png?jwt=x" />\n`
      + "Mirror: https://img.example/?u=https://github.com/acme/orbit-private/raw/main/a.png and a literal \\n\\\\ https://github.com/acme/orbit/x.png",
  } as never);

  test("a URL in a body is referenced, markdown or html", () => {
    expect(assetReferenced(SHOT)).toBe(true);
    expect(assetReferenced("https://private-user-images.githubusercontent.com/1/after.png?jwt=x")).toBe(true);
  });

  test("a URL nobody linked is not, however it is spelled", () => {
    expect(assetReferenced("https://github.com/acme/orbit-private/raw/main/diagram.png")).toBe(false);
    expect(assetReferenced("")).toBe(false);
  });

  test("a URL inside another URL, or cut out of escaped text, is not linked", () => {
    expect(assetReferenced("https://github.com/acme/orbit-private/raw/main/a.png")).toBe(false);
    expect(assetReferenced("https://github.com/acme/orbit/x.png")).toBe(true);
  });

  test("a prefix of a linked URL is not the linked URL", () => {
    // `https://github.com/` is inside every body that links GitHub at all.
    expect(assetReferenced("https://github.com/")).toBe(false);
    expect(assetReferenced(SHOT.slice(0, -4))).toBe(false);
  });
});

describe("docker spawns are counted per credential", () => {
  test("the cap holds, and a release gives a slot back exactly once", () => {
    const got = [1, 2, 3].map(() => takeSpawnSlot("phone-x", 3));
    expect(got.every(Boolean)).toBe(true);
    expect(takeSpawnSlot("phone-x", 3)).toBeNull();
    // Another credential is not starved by the first.
    const other = takeSpawnSlot("phone-y", 3);
    expect(other).not.toBeNull();
    got[0]!();
    got[0]!();
    const again = takeSpawnSlot("phone-x", 3);
    expect(again).not.toBeNull();
    expect(takeSpawnSlot("phone-x", 3)).toBeNull();
    for (const r of [again, got[1], got[2], other]) r!();
  });
});

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

describe("the routes ask the rules above", () => {
  // No renderer and no docker or gh in a test run, so the wiring is asserted
  // against source: a route that stopped passing the caller would be green in
  // every behavioural test here.

  test("the image proxy is told when the caller is short of full", () => {
    expect(src).toContain('prAsset(url.searchParams.get("url") || "", !!caller && caller.scope !== "full")');
  });

  test("every docker spawn route sits behind the cap", () => {
    const set = src.match(/const DOCKER_SPAWNS = new Set\(\[([^\]]*)\]/);
    expect(set).not.toBeNull();
    for (const r of ["/docker/disk", "/docker/volume", "/docker/volume/peek", "/docker/env-diff", "/docker/inspect", "/docker/top", "/docker/logs"]) {
      expect(set![1]).toContain(`"${r}"`);
    }
    const block = src.slice(src.indexOf("if (DOCKER_SPAWNS.has(pathname)) {"));
    expect(block.indexOf("takeSpawnSlot(")).toBeGreaterThan(0);
    expect(block.indexOf("takeSpawnSlot(")).toBeLessThan(block.indexOf('pathname === "/docker/disk"'));
  });
});
