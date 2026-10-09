/*
 * Three source guards on the level model of /control (the server half is
 * server/test/control-levels.test.ts):
 *
 *  1. A level 3 entry only STAGES. Its handler may put a dialog in front of the
 *     person, prefilled, and may not call anything that writes: not an `api`
 *     member that posts, not a route on the MUTATING list, not `fetch`. The
 *     person's click is the effect, and the handler is not allowed to be the click.
 *  2. A name that smells of a credential or of consent is level 3 or not exposed:
 *     token, key, secret, password, credential, remote, trust, gate, consent.
 *  3. The settings an agent can write do not include the level, the switch or a
 *     grant: no def is about them.
 *
 * How the writers are enumerated, since handlers cannot be listed by grep and a
 * list written here would be the second copy that drifts: (a) every member of
 * realApi in web/src/lib/api.ts whose body posts (`post<`, `post(`, or a
 * `method:` that is not GET); (b) the MUTATING route list that
 * server/test/mutating-routes-guard.test.ts keeps for the server, read as text
 * from that file, so a route classified mutating there is a route a stage's
 * handler may not name. A handler is read as text, and so are the modules of the
 * seams it calls, one level deep, for fetch, post and the writers of (a).
 *
 * The ceiling, said out loud: a seam that calls a function that calls a writer
 * two modules away is not followed, and a writer reached through a computed name
 * is not seen. What the guard does hold is the shape a staging handler has today
 * (latch an intent, open a modal) and every import of a writer into the files it
 * leans on. There are no level 3 entries yet; the guard is built, and broken on
 * purpose below, before the first one is.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_ACTIONS, KINDS_AT_LEVEL, type UiActionDef } from "../../shared/uiActions.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("window", new EventTarget());
stubGlobal("document", { documentElement: { getAttribute: () => "graphite", setAttribute: () => {}, style: { setProperty: () => {}, getPropertyValue: () => "" } } });
const { SETTING_DEFS, NOT_EXPOSED_ON_PURPOSE } = await import("../src/lib/settingsRegistry.ts");

/** The registry as the wider type: it holds no stage entry yet, and the guards must read one when it does. */
const ENTRIES = Object.entries(UI_ACTIONS) as [string, UiActionDef][];

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// ── 1. staging ──────────────────────────────────────────────────────────────

/** The members of `realApi` that write: name -> true. */
export function apiWriters(apiSrc: string): Set<string> {
  const start = apiSrc.indexOf("const realApi = {");
  const end = apiSrc.indexOf("const demoApi", start);
  if (start < 0 || end < 0) throw new Error("api.ts no longer has realApi / demoApi where this guard looks");
  const lines = apiSrc.slice(start, end).split("\n");
  const out = new Set<string>();
  let name: string | null = null, body: string[] = [];
  const flush = () => {
    if (name && /\bpost\s*[<(]|method:\s*"(?!GET")[A-Z]+"/.test(body.join("\n"))) out.add(name);
  };
  for (const l of lines.slice(1)) {
    const m = l.match(/^  ([A-Za-z_]\w*)\s*[:(]/);
    if (m) { flush(); name = m[1]!; body = [l]; } else body.push(l);
  }
  flush();
  return out;
}

/** The routes the server guard classifies as mutating, as the strings it writes. */
export function mutatingRoutes(guardSrc: string): string[] {
  const at = guardSrc.indexOf("const MUTATING = [");
  if (at < 0) throw new Error("the mutating-routes guard no longer has a MUTATING list where this guard looks");
  const list = guardSrc.slice(at, guardSrc.indexOf("\n];", at));
  return [...list.matchAll(/pathname(?: ===|\.startsWith\()\s*"([^"]+)"/g)].map((m) => m[1]!);
}

/** The text of one handler of UI_HANDLERS, to the start of the next one. */
export function handlerText(uiSrc: string, id: string): string | null {
  const at = uiSrc.indexOf(`\n  "${id}":`);
  if (at < 0) return null;
  const rest = uiSrc.slice(at + 1);
  const next = rest.slice(1).search(/\n  "[a-z]|\n};/);
  return rest.slice(0, next < 0 ? undefined : next + 1);
}

export interface Seams {
  /** Source of the module a called name is imported from, or null for a local/unknown one. */
  moduleOf(name: string): string | null;
  /** Names of UiCtx methods a level 1 handler already calls: window state, not writers. */
  ctxOk: ReadonlySet<string>;
  writers: ReadonlySet<string>;
  routes: readonly string[];
}

const WRITES_IN_TEXT = /\bfetch\s*\(|\bpost\s*[<(]|method:\s*"|XMLHttpRequest|sendBeacon|new WebSocket|\.send\s*\(/;

/** What is wrong with a staging handler, as sentences. Empty is clean. */
export function stageViolations(handler: string, seams: Seams): string[] {
  const bad: string[] = [];
  const h = code(handler);
  if (WRITES_IN_TEXT.test(h)) bad.push("the handler itself fetches, posts or sends");
  for (const w of seams.writers) if (new RegExp(`\\bapi\\.${w}\\b|\\b${w}\\s*\\(`).test(h)) bad.push(`the handler calls the writer ${w}`);
  for (const r of seams.routes) if (h.includes(`"${r}`) || h.includes(`\`${r}`)) bad.push(`the handler names the mutating route ${r}`);
  for (const m of h.matchAll(/\bc\.([A-Za-z_]\w*)\s*\(/g)) if (!seams.ctxOk.has(m[1]!)) bad.push(`the handler calls ctx.${m[1]}, which no level 1 handler calls`);
  const called = new Set([...h.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]!));
  for (const fn of called) {
    if (["answered", "sourcesOf", "async", "if", "function", "Error", "throw"].includes(fn)) continue;
    const mod = seams.moduleOf(fn);
    if (mod === null) continue;
    const m = code(mod);
    if (WRITES_IN_TEXT.test(m)) bad.push(`the seam ${fn} lives in a module that fetches, posts or sends`);
    for (const w of seams.writers) if (new RegExp(`\\bapi\\.${w}\\b`).test(m)) bad.push(`the seam ${fn} lives in a module that calls the writer ${w}`);
    // Routes are not read in a seam's module: a string like "/workspace" there is a view
    // id as often as a route, and a module that reaches one does it through fetch or an
    // api writer, both of which are read above.
  }
  return [...new Set(bad)];
}

const apiSrc = read("web/src/lib/api.ts");
const uiSrc = read("web/src/lib/uiActions.ts");
const writers = apiWriters(apiSrc);
const routes = mutatingRoutes(read("server/test/mutating-routes-guard.test.ts"));

/** Resolve a called name to the module the handler file imports it from. */
function moduleOf(name: string): string | null {
  const imp = [...uiSrc.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.\/[^"]+)"/g)].find((m) => m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).includes(name));
  if (!imp) return null;
  try { return readFileSync(join(ROOT, "web/src/lib", imp[2]!), "utf8"); } catch { return null; }
}
const ctxOk = new Set(
  ENTRIES.filter(([, d]) => d.level === 1)
    .flatMap(([id]) => [...(handlerText(uiSrc, id) ?? "").matchAll(/\bc\.([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]!)),
);
const real: Seams = { moduleOf, ctxOk, writers, routes };

describe("the enumeration reads the code it thinks it does", () => {
  it("finds the api writers, among them the ones that merge and close", () => {
    expect(writers.size).toBeGreaterThan(80);
    for (const w of ["prMerge", "prClose"]) expect(writers.has(w), w).toBe(true);
  });
  it("leaves out an api member that only reads", () => {
    expect(apiSrc).toMatch(/^  recent: /m);
    expect(writers.has("recent")).toBe(false);
    expect(writers.has("agentPanes")).toBe(false);
  });
  it("finds the mutating routes the server guard keeps", () => {
    expect(routes.length).toBeGreaterThan(30);
    for (const r of ["/control", "/prs/", "/git/", "/gate/decide"]) expect(routes, r).toContain(r);
  });
  it("finds the handlers of the table", () => {
    for (const id of Object.keys(UI_ACTIONS)) expect(handlerText(uiSrc, id), id).not.toBeNull();
    expect(ctxOk.has("goView")).toBe(true);
  });
});

describe("a level 3 entry only stages", () => {
  const level3 = ENTRIES.filter(([, d]) => d.level === 3);

  it("every level 3 entry is a stage, and a stage is level 3 and nothing else", () => {
    for (const [id, d] of level3) expect(d.kind, id).toBe("stage");
    for (const [id, d] of ENTRIES) if (d.kind === "stage") expect(d.level, id).toBe(3);
    expect(KINDS_AT_LEVEL[3]).toEqual(["stage"]);
  });

  it("no level 3 handler writes, calls a writer, names a mutating route, or leans on a module that does", () => {
    for (const [id] of level3) {
      const h = handlerText(uiSrc, id);
      expect(h, `${id} has no handler`).not.toBeNull();
      expect(stageViolations(h!, real), id).toEqual([]);
    }
  });

  // Broken on purpose: each way a staging handler could become the click is seen.
  const bad = (h: string, seams: Partial<Seams> = {}) => stageViolations(h, { ...real, ...seams });
  it("goes red on a handler that calls a writer from api", () => {
    expect(bad(`\n  "merge.stage": (a) => { api.prMerge(a.root, a.n, "squash"); },\n`)).toContain("the handler calls the writer prMerge");
  });
  it("goes red on a handler that fetches, posts or sends", () => {
    expect(bad(`\n  "x": (a) => { fetch("/anything"); },\n`).length).toBeGreaterThan(0);
    expect(bad(`\n  "x": (a) => { post("/prs/comment", {}); },\n`).length).toBeGreaterThan(0);
  });
  it("goes red on a handler that names a mutating route", () => {
    expect(bad(`\n  "x": (a) => { go("/prs/merge"); },\n`)).toContain("the handler names the mutating route /prs/");
  });
  it("goes red on a handler that calls a ctx method no look has called", () => {
    expect(bad(`\n  "x": (a, c) => { c.mergeNow(a); },\n`)).toContain("the handler calls ctx.mergeNow, which no level 1 handler calls");
  });
  it("goes red on a seam whose module posts or calls a writer", () => {
    const m1 = bad(`\n  "x": (a) => latchComment(a.text),\n`, { moduleOf: () => "export function latchComment(t){ return fetch('/x', { method: 'POST' }); }" });
    expect(m1.join(" ")).toContain("the seam latchComment lives in a module that fetches, posts or sends");
    const m2 = bad(`\n  "x": (a) => openMerge(a.n),\n`, { moduleOf: () => "export const openMerge = (n) => api.prClose(n);" });
    expect(m2.join(" ")).toContain("calls the writer prClose");
  });
  it("stays green for what a stage is: latch an intent, open a view", () => {
    expect(bad(`\n  "x": (a, c) => { latchGitModal({ which: "insights" }); c.goView("git"); },\n`, { moduleOf: () => "export function latchGitModal(i){ pending = i; }" })).toEqual([]);
  });
  it("does not mistake a real level 1 handler for a writer (the guard is not trigger-happy)", () => {
    for (const [id, d] of ENTRIES) {
      if (d.level !== 1) continue;
      expect(stageViolations(handlerText(uiSrc, id)!, real), id).toEqual([]);
    }
  });
});

// ── 2. names that smell of a credential or of consent ───────────────────────

const SMELLS = /token|key|secret|password|credential|remote|trust|gate|consent/i;
/**
 * Shortcut bindings carry "key" in their id for that reason and no other, as in
 * settings-registry.test.ts. Only the exact prefix is let through, and the rest
 * of the id is still read, so `keys.binding.remote` would still be caught.
 */
const SHORTCUT = /^keys\.binding\./;
const smells = (id: string) => SMELLS.test(id.replace(SHORTCUT, ""));

describe("a name that smells of a credential or consent is level 3 or not exposed", () => {
  it("every registry entry that smells is a stage at level 3", () => {
    for (const [id, d] of ENTRIES) {
      for (const name of [id, ...Object.keys(d.args)]) if (smells(name)) expect({ name, level: d.level, kind: d.kind }, name).toEqual({ name, level: 3, kind: "stage" });
    }
  });

  it("every setting def that smells is level 3, hence never written by an agent", () => {
    const bad = SETTING_DEFS.filter((d) => smells(d.id) && d.level !== 3).map((d) => d.id);
    expect(bad).toEqual([]);
  });

  it("no def sits on a page recorded as not exposed on purpose", () => {
    const bad = SETTING_DEFS.filter((d) => d.page in NOT_EXPOSED_ON_PURPOSE).map((d) => d.id);
    expect(bad).toEqual([]);
  });

  it("the shortcut exemption is exactly that prefix", () => {
    expect(smells("keys.binding.palette")).toBe(false);
    for (const id of ["keys.apiKey", "keys.binding.remote", "keys.bindingToken", "terminal.sshKey", "plugins.trust", "hooks.gate", "x.consent"]) expect(smells(id), id).toBe(true);
  });

  // Broken on purpose, against the same predicates the real checks use.
  it("goes red on a level 2 def or entry with such a name", () => {
    const fakeDefs = [{ id: "connections.apiToken", level: 2 }, { id: "plugins.trustAll", level: 2 }, { id: "diff.wrap", level: 2 }, { id: "x.gate", level: 3 }];
    expect(fakeDefs.filter((d) => smells(d.id) && d.level !== 3).map((d) => d.id)).toEqual(["connections.apiToken", "plugins.trustAll"]);
  });
});

// ── 3. the level is not a setting ───────────────────────────────────────────

describe("no setting an agent can write is about the level, the switch or a grant", () => {
  const ABOUT = /control|level|readonly|read-only|\bswitch\b|grant|escalat|permission|allow/i;
  it("no def id or label is", () => {
    const bad = SETTING_DEFS.filter((d) => ABOUT.test(d.id.replace(/\./g, " ")) || ABOUT.test(d.label)).map((d) => `${d.id} (${d.label})`);
    expect(bad).toEqual([]);
  });
  it("goes red on a def that would be", () => {
    for (const id of ["agent.controlLevel", "control.level", "agent.readonly", "agent.grant", "agent.allowAll"]) expect(ABOUT.test(id.replace(/\./g, " ")), id).toBe(true);
  });
  it("the window caps an agent's write at level 2 whatever a def says", () => {
    expect(read("web/src/lib/settingsRegistry.ts")).toMatch(/export const AGENT_MAX_LEVEL = 2;/);
  });
});

// ── 4. the server's level reaches the window ────────────────────────────────

describe("the level the server holds travels with each command, so settings.list can say what is writable", () => {
  it("useLive hands the frame's level on, and App gives it to the handlers", () => {
    expect(code(read("web/src/lib/useLive.ts"))).toContain("level: frame.level");
    expect(code(read("web/src/App.tsx"))).toContain("serverLevel: meta?.level");
    expect(code(read("web/src/lib/uiActions.ts"))).toContain("settings.list(c.serverLevel)");
  });
  it("theme.set writes through the appearance.theme setting, never around it", () => {
    const h = handlerText(uiSrc, "theme.set")!;
    expect(h).toContain('settings.set("appearance.theme"');
    expect(h).not.toMatch(/\bc\.setTheme\b|localStorage/);
  });
});
