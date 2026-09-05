/*
 * A plugin's token is not a person's hand on a gate.
 *
 * `/gate/decide` is the one act auth.ts reserves for "a credential an agent on
 * this machine cannot mint": a paired phone, minted at the desk while somebody
 * looked at the request. A plugin's token is the opposite of that — minted by
 * this server, handed to a child process of this server, sitting in that
 * process's environment. Yet it came back from `callerFor` as `kind: "device"`,
 * and a manifest may declare `scope: "answer"` or `"full"`, so the plugin
 * cleared `answersFromADevice` and could release a hold on its own.
 *
 * Pure: the tokens are minted straight through auth.ts, no plugin is installed
 * and no directory outside the scratch XDG home is touched.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowed, answersFromADevice, callerFor, mintPluginToken, revokePluginToken } from "../src/auth.ts";
import { __resetDevices, issueDevice } from "../src/devices.ts";

const at = (token: string) => {
  const url = new URL("http://x/gate/decide");
  return [new Request(url.toString(), { method: "POST", headers: { authorization: `Bearer ${token}` } }), url] as const;
};

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-plugin-hand-"));
  __resetDevices();
});

describe("who a plugin token is", () => {
  test("it is a plugin, not a device, whatever scope the manifest declared", () => {
    for (const scope of ["read", "answer", "full"] as const) {
      const t = mintPluginToken(scope, "watcher");
      const c = callerFor(...at(t), "machine-token");
      expect(c, scope).toMatchObject({ kind: "plugin", scope, plugin: "watcher" });
      expect(c!.device).toBeUndefined();
      revokePluginToken(t);
    }
  });

  test("and it never answers a gate, however wide its scope", () => {
    for (const scope of ["read", "answer", "full"] as const) {
      const t = mintPluginToken(scope, "watcher");
      const c = callerFor(...at(t), "machine-token");
      expect(answersFromADevice(c), `a ${scope} plugin released a hold`).toBe(false);
      revokePluginToken(t);
    }
  });

  test("a paired phone with the same scope still does — the rule narrowed the plugin, not the phone", () => {
    const { token } = issueDevice("phone", "answer");
    const c = callerFor(...at(token), "machine-token");
    expect(c).toMatchObject({ kind: "device", scope: "answer" });
    expect(answersFromADevice(c)).toBe(true);
  });

  test("the scope grant itself is untouched: an answer-scoped plugin still passes `allowed` for its routes", () => {
    /* The fix is at the gate's second door, not in the scope table. A plugin
       that was approved for `answer` keeps every route that grant names; what
       it lost is the claim to be a person. */
    const t = mintPluginToken("answer", "watcher");
    const c = callerFor(...at(t), "machine-token")!;
    expect(allowed(c, "GET", "/sessions")).toBe(true);
    expect(allowed(c, "POST", "/chat/send")).toBe(true);
    expect(allowed(c, "POST", "/terminal/tmux/windows")).toBe(false);
    revokePluginToken(t);
  });
});
