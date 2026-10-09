/*
 * The one line the box card shows, decided from a plugin's box-related
 * fields alone — pulled into its own pure function so every state can be
 * pinned without a renderer.
 */
import { describe, expect, test } from "bun:test";
import { boxWording, envHatchNotice, neighbourKeyWording, unboxedControl, USERNS_FIX } from "../src/lib/pluginBoxState.ts";
import type { PublicPlugin } from "../../shared/types.ts";

const SANDBOX = { network: "agentglass" as const, read: [], write: [], programs: [] };

type Fields = Pick<PublicPlugin, "sandbox" | "running" | "boxState" | "sandboxProbe" | "boxPlan" | "lastBoxFailure">;

const plugin = (over: Partial<Fields> = {}): Fields => ({
  sandbox: SANDBOX,
  running: false,
  boxState: undefined,
  sandboxProbe: undefined,
  boxPlan: undefined,
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
    const w = boxWording(plugin({ running: false, boxPlan: "refuse", sandboxProbe: { ok: false, reason: "userns-blocked", detail: "bwrap: setting up uid map: Permission denied" } }));
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

/*
 * The sentence a person reads before switching a plugin on, for every host
 * the server can answer for. "Runs as you" is true when it starts unboxed and
 * false when the start is refused; "will not start" is false anywhere but a
 * Linux host with no box and no consent.
 */
describe("boxWording, platform x probe x plan x running", () => {
  const fails = (reason: "missing" | "userns-blocked" | "failed") => ({ ok: false as const, reason, detail: "bwrap: no" });
  const REASONS = ["missing", "userns-blocked", "failed"] as const;

  for (const reason of REASONS) {
    test(`Linux, no box (${reason}), no consent, not running: will not start, and does not say it runs as you`, () => {
      const w = boxWording(plugin({ boxPlan: "refuse", sandboxProbe: fails(reason) }))!;
      expect(w.tone).toBe("warning");
      expect(w.text).toMatch(/will not start until you allow it to run unboxed or fix the host/);
      expect(w.text).not.toMatch(/runs as you/);
      expect((w as { willNotStart?: boolean }).willNotStart).toBe(true);
    });

    test(`Linux, no box (${reason}), consent or env, not running: starts unboxed, runs as you is true`, () => {
      const w = boxWording(plugin({ boxPlan: "unboxed-consented", sandboxProbe: fails(reason) }))!;
      expect(w.tone).toBe("warning");
      expect(w.text).toMatch(/runs as you/);
      expect(w.text).not.toMatch(/will not start/);
      expect((w as { willNotStart?: boolean }).willNotStart).toBeUndefined();
    });

    test(`macOS or Windows (probe ${reason}), not running: unboxed by design, no refusal, no bubblewrap to install`, () => {
      const w = boxWording(plugin({ boxPlan: "unboxed-platform", sandboxProbe: fails(reason) }))!;
      expect(w.text).toMatch(/runs as you/);
      expect(w.text).not.toMatch(/will not start|bubblewrap|AppArmor/);
      expect((w as { fix?: string }).fix).toBeUndefined();
    });

    test(`macOS or Windows (boxState ${reason}), running: the same sentence, still no bubblewrap to install`, () => {
      const w = boxWording(plugin({ running: true, boxPlan: "unboxed-platform", sandboxProbe: fails(reason), boxState: { kind: "unboxed", reason, detail: "bwrap: no" } }))!;
      expect(w.text).toMatch(/runs as you/);
      expect(w.text).not.toMatch(/will not start|bubblewrap|AppArmor/);
    });

    test(`Linux, running unboxed (${reason}): keeps runs as you`, () => {
      const w = boxWording(plugin({ running: true, boxPlan: "unboxed-consented", sandboxProbe: fails(reason), boxState: { kind: "unboxed", reason, detail: "bwrap: no" } }))!;
      expect(w.text).toMatch(/runs as you/);
      expect(w.text).not.toMatch(/will not start/);
    });
  }

  test("a server that sends no plan is read as Linux's default, never as a promise that it runs", () => {
    const w = boxWording(plugin({ boxPlan: undefined, sandboxProbe: fails("missing") }))!;
    expect(w.text).toMatch(/will not start/);
  });

  test("the box can be built: neutral on any platform, whatever the consent", () => {
    for (const p of [undefined, "box"] as const) {
      expect(boxWording(plugin({ boxPlan: p, sandboxProbe: { ok: true } }))!.tone).toBe("neutral");
    }
  });

  test("a failure that stopped the last start says it did not start, not that it ran as you", () => {
    const w = boxWording(plugin({ boxPlan: "box", sandboxProbe: { ok: true }, lastBoxFailure: "bwrap: no" }))!;
    expect(w.text).toContain("bwrap: no");
    expect(w.text).not.toMatch(/ran as you|runs as you/);
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

describe("unboxedControl: the consent control on a plugin's card", () => {
  // [boxPlan, allowUnboxed, envAllowsAll] -> what the card carries
  const table: [string, Partial<Pick<PublicPlugin, "boxPlan" | "allowUnboxed" | "sandbox">>, boolean, "allow" | "revoke" | null][] = [
    ["refused, no consent: offer it", { boxPlan: "refuse" }, false, "allow"],
    ["refused, consent explicitly false: offer it", { boxPlan: "refuse", allowUnboxed: false }, false, "allow"],
    ["consented, running or not: a one-click revoke", { boxPlan: "unboxed-consented", allowUnboxed: true }, false, "revoke"],
    ["consented with the machine-wide hatch on too: revoke, and it says the hatch remains", { boxPlan: "unboxed-consented", allowUnboxed: true }, true, "revoke"],
    ["revoked: back to offering it", { boxPlan: "refuse", allowUnboxed: false }, false, "allow"],
    ["only the machine-wide hatch lets it run: nothing to decide here", { boxPlan: "unboxed-consented", allowUnboxed: false }, true, null],
    ["a box can be built: no control", { boxPlan: "box" }, false, null],
    ["macOS or Windows, unboxed by design: no control", { boxPlan: "unboxed-platform" }, false, null],
    ["a stray consent where a box can be built: no control", { boxPlan: "box", allowUnboxed: true }, false, null],
    ["no sandbox declared: no control", { sandbox: undefined, boxPlan: "refuse" }, false, null],
    ["plan not known: no control", { boxPlan: undefined }, false, null],
  ];
  for (const [name, over, env, want] of table) {
    test(name, () => {
      const c = unboxedControl({ sandbox: SANDBOX, boxPlan: undefined, allowUnboxed: undefined, ...over }, env);
      expect(c?.kind ?? null).toBe(want);
    });
  }

  test("the offer names what is given up; the revoke names what happens next", () => {
    const allow = unboxedControl({ sandbox: SANDBOX, boxPlan: "refuse" }, false)!;
    expect(allow.text).toMatch(/runs as you/);
    expect(allow.text).toMatch(/does not start/);
    const revoke = unboxedControl({ sandbox: SANDBOX, boxPlan: "unboxed-consented", allowUnboxed: true }, true)!;
    expect(revoke.text).toMatch(/machine-wide/);
  });
});

describe("envHatchNotice", () => {
  test("silent unless the machine-wide hatch is on", () => {
    expect(envHatchNotice(undefined)).toBeNull();
    expect(envHatchNotice(false)).toBeNull();
    expect(envHatchNotice(true)).toMatch(/AGENTGLASS_PLUGINS_UNBOXED=1/);
  });
});
