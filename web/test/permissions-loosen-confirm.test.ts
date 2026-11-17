import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_CEILING, DEFAULT_WORKER_ENVELOPE } from "../../shared/orchestration.ts";
import { addedGrants, askText, createLoosenGate, envLoosens, droppedRefusals, switchedOn, widenedPowers, POWER_WORDS, type Pending } from "../src/components/settings/save/loosen.ts";

const src = (f: string) => readFileSync(new URL(`../src/components/settings/${f}`, import.meta.url), "utf8");
const level = src("pages/WorkerLevel.tsx");
const perms = src("pages/PermissionsPage.tsx");
const editor = src("save/ListEditor.tsx");

describe("what loosens", () => {
  test("a power turned on loosens; the same power turned off tightens", () => {
    const off = { ...DEFAULT_WORKER_ENVELOPE, network: false };
    const on = { ...off, network: true };
    expect(widenedPowers(off, on)).toEqual(["network"]);
    expect(widenedPowers(on, off)).toEqual([]);
    expect(switchedOn(false, true)).toBe(true);
    expect(switchedOn(true, false)).toBe(false);
  });
  test("write: nothing to its own copy loosens, the way back tightens", () => {
    const none = { ...DEFAULT_CEILING, write: "none" as const };
    expect(widenedPowers(none, DEFAULT_CEILING)).toEqual(["write"]);
    expect(widenedPowers(DEFAULT_CEILING, none)).toEqual([]);
  });
  test("a refusal dropped loosens, one added tightens", () => {
    expect(droppedRefusals("git push\nrm", "rm")).toEqual(["git push"]);
    expect(droppedRefusals("rm", "rm\ngit push")).toEqual([]);
  });
  test("a grant added loosens, one removed tightens", () => {
    expect(addedGrants(["a"], ["a", "b"])).toEqual(["b"]);
    expect(addedGrants(["a", "b"], ["a"])).toEqual([]);
  });
  test("the question is one sentence in the decided words", () => {
    expect(askText(POWER_WORDS.network)).toBe("Workers can reach the internet from now on. Allow?");
  });
});

describe("the gate, in both directions", () => {
  const make = () => { const ran: string[] = []; const seen: (Pending | null)[] = []; const g = createLoosenGate((p) => seen.push(p)); return { g, ran, seen }; };
  test("a tightening change saves at once and asks nothing", () => {
    const { g, ran } = make();
    g.gate("network", null, () => ran.push("saved"));
    expect(ran).toEqual(["saved"]);
    expect(g.pending).toBeNull();
  });
  test("a loosening change waits: nothing is saved until Allow", () => {
    const { g, ran } = make();
    g.gate("network", "reach the internet", () => ran.push("saved"));
    expect(ran).toEqual([]);
    expect(g.pending?.what).toBe("reach the internet");
    g.allow();
    expect(ran).toEqual(["saved"]);
    expect(g.pending).toBeNull();
  });
  test("Cancel saves nothing and clears the question", () => {
    const { g, ran } = make();
    g.gate("network", "reach the internet", () => ran.push("saved"));
    g.cancel();
    g.allow();
    expect(ran).toEqual([]);
    expect(g.pending).toBeNull();
  });
  test("a tightening change made while a question is open clears it", () => {
    const { g, ran } = make();
    g.gate("docker", "use Docker", () => ran.push("docker"));
    g.gate("commit", null, () => ran.push("commit"));
    expect(ran).toEqual(["commit"]);
    expect(g.pending).toBeNull();
  });
});

describe("every loosening path on Permissions goes through the gate", () => {
  test("worker level, powers and both refuse lists", () => {
    expect(level).toContain("g.gate(row, whatLoosens(patch)");
    expect(level.match(/loosens=\{refusalsDropped\}/g)).toHaveLength(2);
    for (const row of ["level", "write", "commit", "network", "docker", "worktreeOps"]) expect(level).toContain(`g.at("${row}")`);
  });
  test("closed-command list, tool list, browser grants, verbs and the two agent switches", () => {
    expect(perms).toContain("droppedRefusals(before, next)");
    expect(perms).toContain("addedGrants(before, next)");
    expect(perms).toContain("g.gate(row, opens(old, next)");
    expect(perms).toContain('gate.gate("verbs"');
    expect(perms.match(/allows="/g)).toHaveLength(2);
  });
  test("a list editor asks before it saves or toasts", () => {
    expect(editor.indexOf("loosens?.(value, to)")).toBeLessThan(editor.indexOf("listSave(value, to, (v, before)"));
    expect(editor).toContain("<LoosenConfirm");
  });
});

describe("Undo is judged like any change", () => {
  const was = { ceiling: DEFAULT_CEILING, workerDefault: DEFAULT_WORKER_ENVELOPE };
  test("undoing a tightening loosens, so it asks; undoing a loosening does not", () => {
    const tight = { ...was, workerDefault: { ...DEFAULT_WORKER_ENVELOPE, network: false, deny: [...DEFAULT_WORKER_ENVELOPE.deny, "git push"] } };
    const open = { ...was, workerDefault: { ...DEFAULT_WORKER_ENVELOPE, network: true } };
    expect(envLoosens(open, { workerDefault: tight.workerDefault })).toBeNull();
    expect(envLoosens(tight, { workerDefault: open.workerDefault })).toContain("reach the internet");
    const withDeny = { ...DEFAULT_WORKER_ENVELOPE, deny: ["git push"] };
    expect(envLoosens({ ...was, workerDefault: withDeny }, { workerDefault: { ...withDeny, deny: [] } })).toBe("run git push");
  });
  test("a second question on another row says the first was cancelled", () => {
    const seen: (Pending | null)[] = []; const g = createLoosenGate((p) => seen.push(p));
    g.gate("engines", "use the browser from x", () => undefined);
    expect(g.pending?.replaced).toBe(false);
    g.gate("roles", "drive the browser as y", () => undefined);
    expect(g.pending?.replaced).toBe(true);
  });
  test("worker level, door switches, browser grants and the pane route Undo and presets through the gate", () => {
    expect(level).toContain('g.gate("level", back');
    expect(level).toContain("g.cancel()");
    expect(level).toContain("resetKey=");
    expect(editor).toContain("undo: true");
    expect(perms).toContain("guard(v, () => void write(v))");
    expect(perms).toContain("allows && on === false");
    expect(perms).toContain("g.gate(row, opens(next, v)");
    expect(perms).toContain('gate.gate("verbs", say(next, v)');
    const pane = readFileSync(new URL("../src/components/orchestration/OrchestrationPane.tsx", import.meta.url), "utf8");
    expect(pane).toContain('gate.gate("env", envLoosens(back, next)');
    expect(pane).toContain('gate.gate("preset", what');
    expect(pane).toContain("gate.gate(row, envLoosens(to, was)");
    const cleanup = src("pages/CleanupRows.tsx");
    expect(cleanup).toContain("queued(");
    expect(cleanup).toContain("withKind(cur, k, !on)");
  });
});
