/*
 * The settings door without a server: what an agent's change does to each
 * class, what a request holds, and that only the person answers one.
 *
 * The defs are in-memory stand-ins with the ids of real settings, so the class
 * table (shared/settingClass.ts) is the real one. The last block reads
 * serverSettings.ts as text and fails for a setting it defines without a class.
 */
import { describe, expect, test } from "bun:test";
import { makeDoor, leafDiff, MAX_PENDING, type ServerSettingDef } from "../src/settingsDoor.ts";
import { classOf, REQUEST_TTL_MS, SETTING_CLASSES } from "../../shared/settingClass.ts";

const SOURCE = await Bun.file(new URL("../src/serverSettings.ts", import.meta.url)).text();

function rig(start: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { "launch.mode": "default", "launch.deny": ["Bash(gh pr merge:*)"], "seat.wakeHours": 4, "lantern.cacheTtlMinutes": 5, "agents.changeWithoutAsking": false, "orchestration.policy": { limits: { maxWorkers: 2 } }, ...start };
  let clock = 1_000_000;
  let trusted = false;
  const applied: string[] = [];
  const windowApplied: [string, unknown, unknown][] = [];
  let changes = 0;
  const def = (id: string, type: ServerSettingDef["type"], ok: (v: unknown) => boolean): ServerSettingDef => ({
    id, label: `Label of ${id}`, page: "x", type,
    read: () => store[id],
    validate: (raw) => (ok(raw) ? { value: raw } : { error: "bad value" }),
    apply: (v) => { store[id] = v; applied.push(id); return { ok: true }; },
  });
  const defs = [
    def("launch.mode", "string", (v) => ["default", "acceptEdits", "auto", "bypassPermissions"].includes(String(v))),
    def("launch.deny", "json", Array.isArray),
    def("seat.wakeHours", "number", (v) => typeof v === "number"),
    def("lantern.cacheTtlMinutes", "number", (v) => typeof v === "number"),
    def("agents.changeWithoutAsking", "boolean", (v) => typeof v === "boolean"),
    def("orchestration.policy", "json", (v) => !!v && typeof v === "object"),
    def("jira.token", "string", () => true),
  ];
  const door = makeDoor({
    defs: () => defs, trusted: () => trusted,
    applyWindow: async (id, v, expect) => { windowApplied.push([id, v, expect]); return { ok: true }; },
    changed: () => { changes++; }, now: () => clock, later: () => {},
  });
  const agent = { person: false, who: "worker builder-1" };
  const person = { person: true, who: "the person" };
  return {
    door, store, applied, windowApplied, agent, person,
    tick: (ms: number) => { clock += ms; },
    trust: (on: boolean) => { trusted = on; },
    changes: () => changes,
  };
}

describe("an agent's change, by class", () => {
  test("low applies at once", async () => {
    const r = rig();
    const a = await r.door.change("lantern.cacheTtlMinutes", 60, r.agent);
    expect(a).toMatchObject({ ok: true, applied: true, prev: 5, value: 60 });
    expect(r.store["lantern.cacheTtlMinutes"]).toBe(60);
  });

  test("an escalation queues, applies nothing, and the diff is the server's", async () => {
    const r = rig();
    const a = await r.door.change("launch.mode", "bypassPermissions", r.agent);
    expect(a.ok && !a.applied).toBe(true);
    expect(r.store["launch.mode"]).toBe("default");
    expect(r.applied).toEqual([]);
    const p = r.door.pending();
    expect(p).toHaveLength(1);
    expect(p[0]!.diff).toEqual(["Label of launch.mode", 'value: "default" -> "bypassPermissions"']);
    expect(p[0]!.who).toBe("worker builder-1");
    expect(p[0]!.expires - p[0]!.at).toBe(REQUEST_TTL_MS);
    expect(r.changes()).toBe(1);
  });

  test("a narrowing applies at once even though the class is escalation", async () => {
    const r = rig({ "launch.mode": "bypassPermissions" });
    expect(await r.door.change("launch.mode", "acceptEdits", r.agent)).toMatchObject({ ok: true, applied: true });
    expect(await r.door.change("launch.deny", ["Bash(gh pr merge:*)", "Bash(curl:*)"], r.agent)).toMatchObject({ ok: true, applied: true });
    expect(await r.door.change("seat.wakeHours", 8, r.agent)).toMatchObject({ ok: true, applied: true });
    expect(r.door.pending()).toEqual([]);
  });

  test("a secret is refused and never queued", async () => {
    const r = rig();
    const a = await r.door.change("jira.token", "tok-example", r.agent);
    expect(a).toMatchObject({ ok: false, status: 403 });
    expect(r.door.pending()).toEqual([]);
    expect(r.door.value("jira.token")).toHaveProperty("error");
  });

  test("an invalid value is refused before anything is queued", async () => {
    const r = rig();
    expect(await r.door.change("launch.mode", "yolo", r.agent)).toMatchObject({ ok: false, status: 400 });
    expect(r.door.pending()).toEqual([]);
  });
});

describe("the person's switch", () => {
  test("an agent cannot turn it on, not even as a request", async () => {
    const r = rig();
    const a = await r.door.change("agents.changeWithoutAsking", true, r.agent);
    expect(a).toMatchObject({ ok: false, status: 403 });
    expect(r.door.pending()).toEqual([]);
    expect(r.store["agents.changeWithoutAsking"]).toBe(false);
  });

  test("not even while it is on", async () => {
    const r = rig({ "agents.changeWithoutAsking": true });
    r.trust(true);
    // Off and on again: off is a narrowing and applies, on is refused.
    expect(await r.door.change("agents.changeWithoutAsking", false, r.agent)).toMatchObject({ ok: true, applied: true });
    expect(await r.door.change("agents.changeWithoutAsking", true, r.agent)).toMatchObject({ ok: false, status: 403 });
    expect(r.store["agents.changeWithoutAsking"]).toBe(false);
  });

  test("the person turns it on; then an agent's escalation applies without a request", async () => {
    const r = rig();
    expect(await r.door.change("agents.changeWithoutAsking", true, r.person)).toMatchObject({ ok: true, applied: true });
    r.trust(true);
    expect(await r.door.change("launch.mode", "auto", r.agent)).toMatchObject({ ok: true, applied: true });
    expect(r.door.pending()).toEqual([]);
  });
});

describe("answering a request", () => {
  const ask = async (r: ReturnType<typeof rig>) => {
    const a = await r.door.change("launch.mode", "bypassPermissions", r.agent);
    if (!a.ok || a.applied) throw new Error("expected a request");
    return a.pending.id;
  };

  test("an agent cannot approve it, its own included, nor decline it", async () => {
    const r = rig();
    const id = await ask(r);
    expect(await r.door.decide(id, true, false)).toMatchObject({ ok: false, status: 403 });
    expect(await r.door.decide(id, false, false)).toMatchObject({ ok: false, status: 403 });
    expect(r.store["launch.mode"]).toBe("default");
    expect(r.door.pending()).toHaveLength(1);
  });

  test("approve applies exactly the diff, once, and grants nothing for next time", async () => {
    const r = rig();
    const id = await ask(r);
    expect(await r.door.decide(id, true, true)).toMatchObject({ ok: true, applied: true, setting: "launch.mode" });
    expect(r.store["launch.mode"]).toBe("bypassPermissions");
    expect(r.applied).toEqual(["launch.mode"]);
    expect(await r.door.decide(id, true, true)).toMatchObject({ ok: false, status: 404 });
    // The next widening asks again.
    const again = await r.door.change("launch.deny", [], r.agent);
    expect(again.ok && !again.applied).toBe(true);
  });

  test("decline applies nothing", async () => {
    const r = rig();
    const id = await ask(r);
    expect(await r.door.decide(id, false, true)).toMatchObject({ ok: true, applied: false });
    expect(r.store["launch.mode"]).toBe("default");
    expect(r.applied).toEqual([]);
    expect(r.door.pending()).toEqual([]);
  });

  test("an unanswered request expires as a decline", async () => {
    const r = rig();
    const id = await ask(r);
    r.tick(REQUEST_TTL_MS + 1);
    expect(r.door.pending()).toEqual([]);
    expect(await r.door.decide(id, true, true)).toMatchObject({ ok: false, status: 404 });
    expect(r.store["launch.mode"]).toBe("default");
  });

  test("a setting that moved since the request is not the diff the person saw: nothing applies", async () => {
    const r = rig();
    const id = await ask(r);
    r.store["launch.mode"] = "acceptEdits";
    expect(await r.door.decide(id, true, true)).toMatchObject({ ok: false, status: 409 });
    expect(r.store["launch.mode"]).toBe("acceptEdits");
  });

  test("a window request is applied by the window, with the value it asked for", async () => {
    const r = rig();
    const a = r.door.askForWindow("plugins.sessionReads.repos", "plugins.sessionReads.repos", "acme/orbit", "acme/orbit,acme/helm", "worker builder-1");
    if (!a.ok || a.applied) throw new Error("expected a request");
    expect(a.pending.diff).toEqual(["plugins.sessionReads.repos", 'value: "acme/orbit" -> "acme/orbit,acme/helm"']);
    expect(await r.door.decide(a.pending.id, true, true)).toMatchObject({ ok: true, applied: true });
    // Applied with the value the card was read against, which the window checks.
    expect(r.windowApplied).toEqual([["plugins.sessionReads.repos", "acme/orbit,acme/helm", "acme/orbit"]]);
    // A low window setting never becomes a request, and neither does a server one this way.
    expect(r.door.askForWindow("diff.wrap", "diff.wrap", false, true, "x")).toMatchObject({ ok: false });
    expect(r.door.askForWindow("launch.mode", "launch.mode", "default", "bypassPermissions", "x")).toMatchObject({ ok: false });
    expect(r.door.pending()).toEqual([]);
  });

  test("a newer ask replaces the older one, and the queue has a ceiling", async () => {
    const r = rig();
    await ask(r);
    await ask(r);
    expect(r.door.pending()).toHaveLength(1);
    for (let i = 0; i < MAX_PENDING + 3; i++) await r.door.change("launch.mode", "auto", { person: false, who: `agent-${i}` });
    expect(r.door.pending()).toHaveLength(MAX_PENDING);
  });
});

describe("a seat, held to its own project", () => {
  test("a change to the whole machine waits for the person, even a low one or a narrowing", async () => {
    const r = rig({ "launch.mode": "bypassPermissions" });
    const seat = { person: false, who: "the chair of orbit", confined: true };
    expect(await r.door.change("lantern.cacheTtlMinutes", 60, seat)).toMatchObject({ ok: true, applied: false });
    expect(await r.door.change("launch.mode", "default", seat)).toMatchObject({ ok: true, applied: false });
    expect(r.store["launch.mode"]).toBe("bypassPermissions");
    expect(r.applied).toEqual([]);
  });
});

describe("what a card shows is everything it applies", () => {
  test("a change too large to show whole is refused, not cut", async () => {
    const r = rig();
    const big = Array.from({ length: 80 }, (_, i) => `Bash(tool-${i}:*)`);
    expect(await r.door.change("launch.deny", big.slice(0, 1), r.agent)).toMatchObject({ ok: true, applied: false });
    expect(await r.door.change("orchestration.policy", { limits: { maxWorkers: 2 }, note: "x".repeat(400) }, r.agent)).toMatchObject({ ok: false, status: 413 });
    expect(await r.door.change("orchestration.policy", Object.fromEntries(big.map((k, i) => [k, i])), r.agent)).toMatchObject({ ok: false, status: 413 });
  });

  test("a reader of the list sees the card's words, not the stored values", async () => {
    const r = rig();
    await r.door.change("launch.mode", "bypassPermissions", r.agent);
    const [p] = r.door.pending();
    expect(p).not.toHaveProperty("value");
    expect(p).not.toHaveProperty("prev");
  });
});

describe("a request that also approves a declaration", () => {
  test("the card carries the server's lines, and a declaration that changed since applies nothing", async () => {
    const r = rig();
    let declared = ["scope: \"read\"", "fingerprint: \"f1\""];
    let on = false;
    const plugin: ServerSettingDef = {
      id: "plugin.acme-notes.enabled", label: "Plugin acme-notes", page: "plugins", type: "boolean",
      read: () => on, validate: (v) => ({ value: v }), apply: (v) => { on = v === true; return { ok: true }; },
      explain: (v) => (v ? declared : []),
    };
    const door = makeDoor({ defs: () => [plugin], trusted: () => false, applyWindow: async () => ({ ok: true }), changed: () => {}, later: () => {} });
    const a = await door.change(plugin.id, true, r.agent);
    if (!a.ok || a.applied) throw new Error("expected a request");
    expect(a.pending.diff).toEqual(["Plugin acme-notes", "value: false -> true", ...declared]);
    declared = ["scope: \"full\"", "fingerprint: \"f2\""];
    expect(await door.decide(a.pending.id, true, true)).toMatchObject({ ok: false, status: 409 });
    expect(on).toBe(false);
    // Asked again, against the declaration as it is now, it applies.
    const b = await door.change(plugin.id, true, r.agent);
    if (!b.ok || b.applied) throw new Error("expected a request");
    expect(await door.decide(b.pending.id, true, true)).toMatchObject({ ok: true, applied: true });
    expect(on).toBe(true);
    // Off narrows: at once.
    expect(await door.change(plugin.id, false, r.agent)).toMatchObject({ ok: true, applied: true });
  });
});

describe("the diff", () => {
  test("one line per leaf that differs, as JSON", () => {
    expect(leafDiff({ a: 1, b: { c: "x" }, d: [1, 2] }, { a: 1, b: { c: "y" }, d: [1] })).toEqual(['b.c: "x" -> "y"', "d[1]: 2 -> (unset)"]);
    // A new object is spelled out leaf by leaf, not folded into one cut line.
    expect(leafDiff({}, { r: { id: "nights", w: [1] } })).toEqual(['r.id: (unset) -> "nights"', "r.w[0]: (unset) -> 1"]);
    expect(leafDiff("x", "y".repeat(400))[0]).toContain("(102 more characters)");
  });
});

describe("every server setting has a class", () => {
  /* The ids serverSettings.ts defines, read as text: a literal id, or a template
     whose `${...}` part names a member of a list (a role, a plugin). */
  const ids = [...SOURCE.matchAll(/\bid: (?:"([^"]+)"|`([^`]+)`)/g)].map((m) => (m[1] ?? m[2]!).replace(/\$\{[^}]+\}/g, "acme"));

  test("the source defines the settings it is expected to", () => {
    expect(ids.length).toBeGreaterThan(20);
    expect(ids).toContain("orchestration.policy");
    expect(ids).toContain("plugin.acme.enabled");
  });

  test("none is without a class", () => {
    expect(ids.filter((id) => !classOf(id))).toEqual([]);
  });

  test("every server line in the table is a setting there, or one no agent reaches", () => {
    const windowish = /^(appearance|diff|terminal|rail|notifications|browser|tasks|keys|about)\.|^plugins\.sessionReads\.|^clickup\.statusSpaces\.|^jira\.statusUnits\./;
    const stale = Object.entries(SETTING_CLASSES)
      .filter(([k, row]) => !windowish.test(k) && row.class !== "secret" && !(row.class === "personOnly" && !ids.includes(k)))
      .filter(([k]) => !ids.some((id) => (k.includes("*") ? classOf(id) === SETTING_CLASSES[k] : id === k)))
      .map(([k]) => k);
    expect(stale).toEqual([]);
  });
});
