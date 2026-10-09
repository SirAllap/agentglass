/*
 * The one line the box card shows, decided from a plugin's box-related
 * fields alone — pulled into its own pure function so every state can be
 * pinned without a renderer.
 */
import { describe, expect, test } from "bun:test";
import { boxWording, neighbourKeyWording, USERNS_FIX } from "../src/lib/pluginBoxState.ts";
import type { PublicPlugin } from "../../shared/types.ts";

const SANDBOX = { network: "agentglass" as const, read: [], write: [], programs: [] };

type Fields = Pick<PublicPlugin, "sandbox" | "running" | "boxState" | "sandboxProbe" | "lastBoxFailure">;

const plugin = (over: Partial<Fields> = {}): Fields => ({
  sandbox: SANDBOX,
  running: false,
  boxState: undefined,
  sandboxProbe: undefined,
  lastBoxFailure: undefined,
  ...over,
});

describe("boxWording", () => {
  test("no sandbox block: nothing to say", () => {
    expect(boxWording(plugin({ sandbox: undefined }))).toBeNull();
  });

  test("declared, not running, no probe yet: neutral, no red", () => {
    const w = boxWording(plugin({ running: false }));
    expect(w).not.toBeNull();
    expect(w!.tone).toBe("neutral");
    expect(w!.text).toMatch(/will run in a box/i);
  });

  test("not running, but the probe already says this host cannot build one: red, before a start is ever tried", () => {
    const w = boxWording(plugin({ running: false, sandboxProbe: { ok: false, reason: "userns-blocked", detail: "bwrap: setting up uid map: Permission denied" } }));
    expect(w!.tone).toBe("warning");
    expect(w!.text).toMatch(/AppArmor/);
    expect((w as { fix?: string }).fix).toBe(USERNS_FIX);
  });

  test("not running, host probe is fine, but the last attempt died early: red, with the captured detail", () => {
    const w = boxWording(plugin({ running: false, sandboxProbe: { ok: true }, lastBoxFailure: "bwrap: setting up mount namespace: Permission denied" }));
    expect(w!.tone).toBe("warning");
    expect(w!.text).toContain("bwrap: setting up mount namespace: Permission denied");
  });

  test("not running, host probe ok, no past failure: neutral", () => {
    const w = boxWording(plugin({ running: false, sandboxProbe: { ok: true } }));
    expect(w!.tone).toBe("neutral");
  });

  test("running and boxed, nothing refused", () => {
    const w = boxWording(plugin({ running: true, boxState: { kind: "boxed" } }));
    expect(w!.tone).toBe("boxed");
    expect((w as { refused?: unknown[] }).refused).toBeUndefined();
  });

  test("running and boxed, with a refused grant: carried through, not silently dropped", () => {
    const w = boxWording(plugin({ running: true, boxState: { kind: "boxed", refused: [{ path: "~/.config/orbit", why: "resolves to ~/.ssh, which no plugin can be given" }] } }));
    expect(w!.tone).toBe("boxed");
    expect((w as { refused?: { path: string; why: string }[] }).refused).toEqual([{ path: "~/.config/orbit", why: "resolves to ~/.ssh, which no plugin can be given" }]);
  });

  test("running unboxed: userns-blocked carries the fix, verbatim", () => {
    const w = boxWording(plugin({ running: true, boxState: { kind: "unboxed", reason: "userns-blocked", detail: "bwrap: setting up uid map: Permission denied" } }));
    expect(w!.tone).toBe("warning");
    expect(w!.text).toMatch(/AppArmor/);
    expect((w as { fix?: string }).fix).toBe(USERNS_FIX);
    expect(USERNS_FIX).toContain("sudo tee /etc/apparmor.d/bwrap");
    expect(USERNS_FIX).toContain("sudo systemctl reload apparmor");
  });

  test("running unboxed: missing names the package", () => {
    const w = boxWording(plugin({ running: true, boxState: { kind: "unboxed", reason: "missing" } }));
    expect(w!.tone).toBe("warning");
    expect(w!.text).toMatch(/bubblewrap/);
    expect((w as { fix?: string }).fix).toBeUndefined();
  });

  test("running unboxed: failed carries the detail line", () => {
    const w = boxWording(plugin({ running: true, boxState: { kind: "unboxed", reason: "failed", detail: "no such file or directory" } }));
    expect(w!.tone).toBe("warning");
    expect(w!.text).toContain("no such file or directory");
  });

  test("running unboxed: no-block reads neutral, not red — a declared sandbox never actually reaches this reason", () => {
    const w = boxWording(plugin({ running: true, boxState: { kind: "unboxed", reason: "no-block" } }));
    expect(w!.tone).toBe("neutral");
  });
});

describe("neighbourKeyWording", () => {
  test("says whose key an unboxed plugin could read, and says nothing when there is none", () => {
    expect(neighbourKeyWording({ name: "orbit-peer", canReadKeysOf: ["orbit-scorer"] }))
      .toBe("orbit-peer runs outside its box and can read orbit-scorer's key.");
    expect(neighbourKeyWording({ name: "orbit-peer", canReadKeysOf: ["orbit-scorer", "orbit-trace"] })).toContain("orbit-scorer, orbit-trace's key");
    expect(neighbourKeyWording({ name: "orbit-peer" })).toBeNull();
    expect(neighbourKeyWording({ name: "orbit-peer", canReadKeysOf: [] })).toBeNull();
  });
});
