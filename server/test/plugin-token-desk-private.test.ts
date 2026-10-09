/*
 * A plugin's token cannot read what other plugins drew or were configured with.
 *
 * `/plugins/panels` and `/plugins/settings` are FULL_GET in auth.ts: a
 * read-scope phone and a read-scope plugin are turned away by SCOPE. A manifest
 * may declare `scope: "full"`, and `allowed()` grades a plugin caller by scope
 * everywhere but `/plugin/self`, so a full-scope plugin passed and got every
 * other plugin's panels, and could write their settings. The refusal has to be
 * by the caller's KIND, the way `answersFromADevice` already is for the gate.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowed, callerFor, mintPluginToken, revokePluginToken } from "../src/auth.ts";
import { __resetDevices, issueDevice } from "../src/devices.ts";

const caller = (token: string, path: string, method = "GET") => {
  const url = new URL(`http://x${path}`);
  return callerFor(new Request(url.toString(), { method, headers: { authorization: `Bearer ${token}` } }), url, "machine-token")!;
};

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-plugin-desk-"));
  __resetDevices();
});

const DESK_PRIVATE: [string, string][] = [
  ["GET", "/plugins/panels"],
  ["GET", "/plugins/panels?plugin=other&panel=main"],
  ["GET", "/plugins/settings"],
  ["POST", "/plugins/settings"],
];

describe("desk-private plugin routes", () => {
  test("no plugin token passes, whatever scope its manifest declared", () => {
    for (const scope of ["read", "answer", "full"] as const) {
      const t = mintPluginToken(scope, "watcher");
      for (const [m, p] of DESK_PRIVATE) {
        const path = p.split("?")[0]!;
        expect(allowed(caller(t, p, m), m, path), `${scope} plugin reached ${m} ${p}`).toBe(false);
      }
      revokePluginToken(t);
    }
  });

  test("a plugin still has its own channel, and full scope still reaches the rest of /plugins", () => {
    const t = mintPluginToken("full", "watcher");
    expect(allowed(caller(t, "/plugin/self"), "GET", "/plugin/self")).toBe(true);
    expect(allowed(caller(t, "/plugin/self/panel", "POST"), "POST", "/plugin/self/panel")).toBe(true);
    expect(allowed(caller(t, "/plugins", "GET"), "GET", "/plugins")).toBe(true);
    revokePluginToken(t);
  });

  test("a full-scope paired device (the desk's phone) still reads them", () => {
    const { token } = issueDevice("desk", "full");
    for (const [m, p] of DESK_PRIVATE) {
      const path = p.split("?")[0]!;
      expect(allowed(caller(token, p, m), m, path), `${m} ${p}`).toBe(true);
    }
  });
});
