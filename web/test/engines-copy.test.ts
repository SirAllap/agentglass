/*
 * The Agent engines page, held without a renderer: the sentences are pure
 * functions of what the server measured, so the table below IS the contract
 * (docs of the page: eight states, one badge, one action, one first row each),
 * and the layout rules are asserted against the component's source.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { EngineReadiness } from "../../shared/types.ts";
import { accountText, actionOf, agoWords, badgeOf, engineState, firstRow, versionText } from "../src/components/engines/enginesCopy.ts";

const NOW = 1_800_000_000_000;

// The shape the server returns for a ready engine; each case changes what it must.
const ready = (over: Partial<EngineReadiness> = {}): EngineReadiness => ({
  id: "orbit", title: "Orbit", found: true, path: "/usr/bin/orbit", version: "2.1.296", min: null, versionOk: true,
  account: { signedIn: true, provider: "Nous Portal" },
  answers: { state: "never" },
  roles: { worker: { ok: true }, orchestrator: { ok: false, why: "Cannot orchestrate yet: agentglass does not know how to read Orbit's screen." } },
  missing: [], envelope: { via: "own-config", enforced: "partly", note: "Refuses git push: yes." },
  ...over,
});

const CASES: { name: string; e: EngineReadiness | null; badge: [string, string]; action: [string, boolean]; first: string; command?: string }[] = [
  { name: "checking", e: null, badge: ["checking", "Checking"], action: ["Recheck", true], first: "Looking for it on this machine." },
  {
    name: "not on this machine",
    e: ready({ found: false, path: null, version: null, versionOk: null, missing: [{ kind: "command", what: "Install Orbit.", command: "npm i -g orbit-cli" }] }),
    badge: ["off", "Not installed"], action: ["Recheck", false], first: "Not on this machine.", command: "npm i -g orbit-cli",
  },
  {
    name: "installed, too old",
    e: ready({ version: "0.21.0", min: "0.21.4", versionOk: false, missing: [{ kind: "command", command: "orbit update", what: "0.21.0 is installed. agentglass needs 0.21.4 or later: it is the first with the output format agentglass reads." }] }),
    badge: ["warn", "Needs update"], action: ["Recheck", false],
    first: "0.21.0 is installed. agentglass needs 0.21.4 or later: it is the first with the output format agentglass reads.", command: "orbit update",
  },
  {
    name: "version fails to run",
    e: ready({ version: null, versionOk: null, missing: [{ kind: "manual", what: "Orbit does not run: ModuleNotFoundError: No module named 'orbit_cli'. Try `orbit --version` in a terminal." }] }),
    badge: ["err", "Not working"], action: ["Recheck", false],
    first: "Orbit does not run: ModuleNotFoundError: No module named 'orbit_cli'. Try `orbit --version` in a terminal.",
  },
  {
    name: "no account",
    e: ready({ account: { signedIn: false }, missing: [{ kind: "login", what: "Not signed in to Orbit.", command: "orbit login" }] }),
    badge: ["warn", "Needs sign-in"], action: ["Recheck", false], first: "Not signed in.", command: "orbit login",
  },
  { name: "ready, never tested", e: ready(), badge: ["ok", "Ready"], action: ["Test", false], first: "Not tested yet. Test sends one word and costs one small turn." },
  {
    name: "ready, tested",
    e: ready({ answers: { state: "ok", at: NOW - 2 * 3_600_000, ms: 3100 } }),
    badge: ["ok", "Ready"], action: ["Test", false], first: "Answered in 3 s, 2 hours ago.",
  },
  {
    name: "test failed",
    e: ready({ answers: { state: "failed", at: NOW - 60_000, ms: 800, error: "Error: rate limit reached, try again later" } }),
    badge: ["err", "Not answering"], action: ["Test", false], first: "Error: rate limit reached, try again later",
  },
];

describe("the eight states of an engine card", () => {
  for (const c of CASES) {
    test(c.name, () => {
      expect(badgeOf(c.e)).toEqual({ tone: c.badge[0] as never, text: c.badge[1] });
      expect(actionOf(c.e)).toEqual({ label: c.action[0] as never, disabled: c.action[1] });
      const r = firstRow(c.e, NOW);
      expect(r.text).toBe(c.first);
      expect(r.command).toBe(c.command);
    });
  }

  test("a sign-in row says the password is never seen", () => {
    expect(firstRow(CASES[4]!.e, NOW).hint).toBe("Run it in a terminal; agentglass does not see the password.");
  });

  test("a test in flight is Testing, with the action held", () => {
    const e = ready({ answers: { state: "running" } });
    expect(engineState(e)).toBe("testing");
    expect(actionOf(e)).toEqual({ label: "Test", disabled: true });
  });

  test("an optional sign-in that is absent is still Ready", () => {
    // OpenCode's free catalogue needs none: the probe adds no login fix.
    expect(engineState(ready({ account: { signedIn: false } }))).toBe("ready");
  });
});

describe("the rows", () => {
  test("version says what is needed only when it is old", () => {
    expect(versionText(ready())).toBe("2.1.296");
    expect(versionText(ready({ version: "0.21.0", min: "0.21.4", versionOk: false }))).toBe("0.21.0 · needs 0.21.4");
    expect(versionText(ready({ found: false, version: null }))).toBe("Not installed");
  });

  test("account and model name providers and models, never more", () => {
    expect(accountText(ready({ account: { signedIn: true, provider: "Nous Portal", model: "nous/space-bunny-alpha" } }))).toBe("Nous Portal · nous/space-bunny-alpha");
    expect(accountText(ready({ account: { signedIn: true, provider: "firstParty", account: "claude.ai" } }))).toBe("Signed in with claude.ai");
    expect(accountText(ready({ account: { signedIn: false } }))).toBe("Not signed in");
    expect(accountText(ready({ account: { signedIn: null } }))).toBe("Sign-in is not checked");
  });

  test("time reads in words", () => {
    expect(agoWords(NOW - 5_000, NOW)).toBe("just now");
    expect(agoWords(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(agoWords(NOW - 3 * 3_600_000, NOW)).toBe("3 hours ago");
    expect(agoWords(NOW - 2 * 86_400_000, NOW)).toBe("2 days ago");
  });
});

describe("the component", () => {
  const pane = readFileSync(new URL("../src/components/engines/EnginesPane.tsx", import.meta.url), "utf8");
  const code = pane.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  test("the badge and the action are in the card header, whatever the state", () => {
    // One SettingsCard per engine, built with both slots from the same
    // functions that the table above holds; there is no branch that omits them.
    const card = code.slice(code.indexOf("function EngineCard("), code.indexOf("export function EnginesPane("));
    expect(card).toMatch(/<SettingsCard title=\{p\.title\} desc=\{p\.what\}\s+status=\{<StatusBadge tone=\{badge\.tone\}>/);
    expect(card).toMatch(/actions=\{<Button disabled=\{act\.disabled\}/);
    expect(card).toContain("badgeOf(e)");
    expect(card).toContain("actionOf(e)");
  });

  test("while checking every row is there at its final height", () => {
    // The card is built from `e === null` exactly as from an answer: same rows,
    // same count, `…` where a value goes, so nothing jumps when it arrives.
    const card = code.slice(code.indexOf("function EngineCard("), code.indexOf("export function EnginesPane("));
    expect(card).toContain('e ? versionText(e) : "…"');
    expect(code).toContain("minHeight={56}");
    expect(card).toContain("reportingLoaded");
    expect(card.match(/<SettingRow label=/g)!.length).toBeGreaterThanOrEqual(6);
  });

  test("no page polls: it loads on open and on Recheck", () => {
    for (const f of ["EnginesPane.tsx", "ReportingRow.tsx", "enginesCopy.ts"]) {
      const src = readFileSync(new URL(`../src/components/engines/${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/usePoll|setInterval|setTimeout/);
    }
    expect(code).toContain("useEffect(() => { load(); }, [load]);");
  });

  test("the one-line test runs only from a press", () => {
    // `test(` is called from the Button's handler and from nowhere else.
    expect(code.match(/void test\(/g)!.length).toBe(1);
    expect(code).toContain("onClick={act.label === \"Test\" ? onTest : onRecheck}");
  });

  test("engines that are not installed fold into one card", () => {
    expect(code).toContain("`${absent.length} not installed`");
    expect(code).toContain("fold={{ open: absentOpen ?? present.length === 0, onToggle: setAbsentOpen }}");
  });

  test("the old Agents list is a link to this page, not a second list", () => {
    const modal = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");
    const section = modal.slice(modal.indexOf("function AgentsSection("), modal.indexOf("function AgentsSection(") + 700);
    expect(section).toContain('onClick={() => openSettings("engines")}');
    expect(modal).not.toContain("Other agents on this machine");
  });
});
