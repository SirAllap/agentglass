/*
 * THE CONTRACT BETWEEN THE CLI'S PARSER AND THE WORKER'S GATE.
 *
 * Rounds 12-13 found the same defect twice: the gate's closed field list was
 * written from a reading of the CLI, so a flag the CLI really sends (`--observe`
 * on an act verb, the page on a worker's second `open`) was refused as an
 * unknown field, and the act never happened.
 *
 * So nothing here types a request shape. The CLI's own argparse is introspected
 * (`browser-cli-verbs.py`), each verb is run against a stub relay that records
 * the body the CLI built, and that body is pushed through the real gate as a
 * worker on its own page. A flag added to the CLI appears in the body and this
 * file goes red until the gate declares it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentAskRefusal, noteWorkerPage, resetWorkerPages, WORKER_VERBS } from "../src/browserdrive.ts";
import { agentContainerName } from "../../shared/workerContainer.ts";

const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;
const INTROSPECT = new URL("./browser-cli-verbs.py", import.meta.url).pathname;
const PY = Bun.which("python3");

const WORKER = "orbit-worker-a";
const OWN_PAGE = "t7-orbit";
const PERSON = "t1-personal";
const OTHER = "t4-other";
const MISSING = "t0-missing";
/** Flags that name the person's side on purpose: the gate refusing them is the
 *  policy, not a drift, and browser-relay-agent-shared.test.ts holds it. */
const BY_POLICY = new Set(["asProfile", "shared", "active", "force", "fromTemplate"]);
/** The parser hands these to every verb as well; the request options are put in
 *  front of the verb by `argvFor`, and the rest never reach a body. */
const GLOBAL_DESTS = new Set(["asProfile", "shared", "active", "page", "maxTokens", "outFile", "observe", "summary", "show"]);

interface Spec {
  options: Array<{
    flags: string[]; dest: string; kind: "flag" | "append" | "value";
    nargs: number | string | null; type: string | null; choices: string[] | null; group: number | null; required: boolean;
  }>;
  positionals: Array<{ dest: string; nargs: unknown; type: string | null; choices: string[] | null }>;
  groups: Array<{ required: boolean; dests: string[] }>;
}
interface Table { globals: Spec; verbs: Record<string, Spec> }

let dir = "", base = "", table: Table;
let relay: ReturnType<typeof Bun.serve> | null = null;
const sent: Array<{ op: string; body: Record<string, unknown> }> = [];
const bodies = new Map<string, Record<string, unknown>>();

const rep = (dest: string, type: string | null, choices: string[] | null): string[] => {
  const known: Record<string, string[]> = {
    url: ["https://example.test/"],
    which: [OWN_PAGE],
    selector: ["#go"],
    query: ["orbit"],
    text: ["orbit"],
    key: ["Enter"],
    value: ["orbit"],
    js: ["1"],
    name: ["orbit"],
    pattern: ["/api/board"],
    width: ["800"], height: ["600"], factor: ["1"],
    dir: [dir],
    out: [join(dir, "shot.png")], shotOut: [join(dir, "shot.png")], path: [join(dir, "shot.png")],
    field: ["#email=orbit@example.test"],
    fieldsFile: [join(dir, "fields.json")],
    file: [join(dir, "script.js")],
    steps_file: [join(dir, "steps.json")],
    clip: ["0,0,10,10"],
    highlight: ["#go"],
    root: ["e12"],
    label: ["orbit"],
    set: ["orbit", "1"],
    container: ["private"],
    fromTemplate: ["orbit"],
  };
  if (known[dest]) return known[dest];
  /* Anything the CLI turns into a file goes under the test's own directory, so
     a run cannot leave litter in the tree. */
  if (/(File|Path|Dir|Out)$/.test(dest) || dest === "dir" || dest === "file" || dest === "path") {
    return [join(dir, "orbit-out")];
  }
  if (choices?.length) return [String(choices[0])];
  if (type === "int" || type === "float") return ["1"];
  return ["orbit"];
}

/** A verb the CLI refuses to send without something else on the command line. */
const baseFor = (verb: string): string[] => {
  const steps = join(dir, "steps.json");
  return verb === "do" ? ["--steps-file", steps]
    : verb === "extract" || verb === "fill" ? ["--field", "#email=orbit@example.test"]
      : [];
};
/** A flag that is only legal beside another one. */
const PAIRS: Record<string, string[]> = { label: ["--highlight", "#go"] };
/** Flags the CLI itself refuses beside each other at runtime. */
const EXCLUSIVE: Record<string, string[]> = { observe: ["root", "viewport"] };

function argvFor(verb: string, spec: Spec, opts: { globals?: boolean; only?: Spec["options"][number] } = {}): string[] {
  const head: string[] = [];
  const globals = table.globals.options.filter((o) => o.dest === "observe" || o.dest === "page" || o.dest === "maxTokens");
  if (opts.globals) {
    for (const g of globals) {
      if (g.dest === "page") head.push("--page", OWN_PAGE);
      else if (g.dest === "observe") head.push("--observe");
      else head.push("--max-tokens", "500");
    }
  }
  const argv = [...head, verb];
  for (const p of spec.positionals) {
    if (p.nargs === "*") continue;
    argv.push(...rep(p.dest, p.type, p.choices));
  }
  const skip = new Set(opts.only ? [] : (EXCLUSIVE[verb] ?? []));
  if (opts.only && PAIRS[opts.only.dest]) argv.push(...PAIRS[opts.only.dest]);
  const chosen = (opts.only ? [opts.only] : spec.options.filter((o) => !GLOBAL_DESTS.has(o.dest) && !BY_POLICY.has(o.dest)))
    .filter((o) => !skip.has(o.dest));
  /* A prerequisite the verb will not send without — unless this very run is
     exercising that flag, which would then appear twice. */
  const named = new Set(chosen.map((o) => o.flags[0]));
  /* A group the CLI marks required must still be satisfied when one flag of the
     verb is being run alone. */
  for (const g of spec.groups) {
    if (!g.required || g.dests.some((d) => chosen.some((o) => o.dest === d))) continue;
    const first = spec.options.find((o) => o.dest === g.dests[0]);
    if (first) {
      argv.push(first.flags[0]);
      if (first.kind !== "flag") argv.push(rep(first.dest, first.type, first.choices)[0]);
    }
  }
  const base = baseFor(verb);
  for (let i = 0; i < base.length; i += 2) if (!named.has(base[i])) argv.push(base[i], base[i + 1]);
  const seenGroup = new Set<number>();
  for (const o of chosen) {
    if (o.dest === "asProfile") continue;
    if (!opts.only && o.group !== null) {
      if (seenGroup.has(o.group)) continue;
      seenGroup.add(o.group);
    }
    argv.push(o.flags[0]);
    if (o.kind !== "flag") {
      const v = rep(o.dest, o.type, o.choices);
      argv.push(...(o.nargs === 2 ? v.slice(0, 2) : [v[0]]));
      if (o.nargs === 2 && v.length < 2) argv.push("orbit");
    }
  }
  return argv;
}

async function runCli(argv: string[]): Promise<{ code: number; err: string; out: string }> {
  const p = Bun.spawn({
    cmd: [PY!, CLI, ...argv],
    env: {
      PATH: process.env.PATH ?? "", HOME: dir,
      XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_BROWSER_STATE_DIR: join(dir, "bstate"),
      AGENTGLASS_SERVER: base,
      AGENTGLASS_TOKEN: "orbit-token", AGENTGLASS_WORKER_TOKEN: "orbit-token",
      AGENTGLASS_BROWSER_AS: WORKER, AGENTGLASS_AGENT_NAME: WORKER, AGENTGLASS_ROLE: "builder",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

/** The gate's answer for a recorded body, as the route calls it. */
const gate = (body: Record<string, unknown>, op: string) => agentAskRefusal(body, WORKER, op);

function judge(argv: string[], from: number): void {
  const got = sent.slice(from);
  expect({ argv, sent: got.length > 0 }).toEqual({ argv, sent: true });
  for (const a of got) {
    const row = WORKER_VERBS[a.op];
    const refusal = gate(a.body, a.op);
    if (!row) throw new Error(`${argv.join(" ")} -> the CLI sends "${a.op}", which the gate has no row for`);
    if (row.policy === "refused") {
      expect({ op: a.op, why: "refused as a verb", got: refusal?.includes(`"${a.op}" is not one of them`) })
        .toEqual({ op: a.op, why: "refused as a verb", got: true });
    } else {
      if (refusal) throw new Error(`${a.op} body ${JSON.stringify(a.body)}: ${refusal}`);
      expect({ argv, op: a.op, refusal }).toEqual({ argv, op: a.op, refusal: null });
      if (!bodies.has(a.op)) bodies.set(a.op, a.body);
    }
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-cli-contract-"));
  writeFileSync(join(dir, "fields.json"), JSON.stringify({ email: "#email" }));
  writeFileSync(join(dir, "script.js"), "1");
  writeFileSync(join(dir, "steps.json"), JSON.stringify([{ op: "read", args: {} }]));
  mkdirSync(join(dir, "agentglass", "browser-templates"), { recursive: true });
  writeFileSync(join(dir, "agentglass", "browser-templates", "orbit.json"),
    JSON.stringify({ origins: [{ origin: "https://example.test/" }] }));
  const probe = Bun.spawn({ cmd: [PY!, INTROSPECT, CLI], stdout: "pipe", stderr: "pipe" });
  const [json, err] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text()]);
  if ((await probe.exited) !== 0) throw new Error(`the parser could not be introspected: ${err}`);
  table = JSON.parse(json) as Table;

  const rows = [
    { id: OWN_PAGE, profile: agentContainerName(WORKER), title: "Orbit", url: "https://example.test/", active: false },
    { id: PERSON, profile: "default", title: "Bank", url: "https://bank.example/", active: true },
    { id: OTHER, profile: "orbit-two", title: "Other", url: "https://other.example/", active: false },
  ];
  relay = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const op = new URL(req.url).pathname.split("/").pop() ?? "";
      let body: Record<string, unknown> = {};
      try { body = (await req.json()) as Record<string, unknown>; } catch { /* none */ }
      sent.push({ op, body });
      const value = op === "open" || op === "newtab"
        ? { id: OWN_PAGE, tab: OWN_PAGE, profile: agentContainerName(WORKER), tabs: rows }
        : op === "tabs" ? rows
          : op === "tab" ? { tab: OWN_PAGE, tabs: rows }
            : op === "closetab" ? rows
              : op === "whoami" ? { you: { identity: WORKER, tab: OWN_PAGE, tabLive: true }, activeTab: null, tabs: rows }
                : op === "lane" ? { lane: { id: "l0-own", as: WORKER, container: "private" }, lanes: [{ id: "l0-own" }] }
                  : op === "observe" ? { url: "https://example.test/", title: "Orbit", console: [], network: [] }
                    : op === "shot" ? { png: "data:image/png;base64,AAAA", path: join(dir, "shot.png") }
                      : {};
      return Response.json({ ok: true, value });
    },
  });
  base = `http://127.0.0.1:${relay.port}`;
  resetWorkerPages();
  noteWorkerPage(WORKER, OWN_PAGE);
  /* The first open mints the worker's own page; every verb after it carries the
     page the CLI remembered, which is the shape the gate must accept. */
  const first = await runCli(["open", "https://example.test/"]);
  if (first.code !== 0) throw new Error(`the first open did not run: ${first.err}`);
}, 60_000);

afterAll(() => {
  relay?.stop(true);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe.skipIf(!PY)("every verb the CLI declares, through the real gate", () => {
  test("each verb with all its own flags and the request options is allowed on its own page", async () => {
    const failures: string[] = [];
    for (const [verb, spec] of Object.entries(table.verbs)) {
      if (WORKER_VERBS[verb]?.policy !== "own") continue;
      const argv = argvFor(verb, spec, { globals: true });
      const from = sent.length;
      const r = await runCli(argv);
      /* The loop closes the worker's own tab on purpose; the verbs after it need
         one again, so the state the CLI remembers is restored. */
      if (verb === "closetab") await runCli(["open", "https://example.test/"]);
      try {
        expect({ argv, code: r.code }).toEqual({ argv, code: 0 });
        judge(argv, from);
      } catch (e) {
        failures.push(`${argv.join(" ")}: ${r.err.trim().slice(0, 200)} ${(e as Error).message.split("\n").slice(0, 6).join(" | ")}`);
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  test("each flag alone builds a body the gate allows", async () => {
    const failures: string[] = [];
    for (const [verb, spec] of Object.entries(table.verbs)) {
      if (WORKER_VERBS[verb]?.policy !== "own") continue;
      for (const o of spec.options) {
        if (BY_POLICY.has(o.dest) || GLOBAL_DESTS.has(o.dest)) continue;        const argv = argvFor(verb, spec, { only: o });
        const from = sent.length;
        const r = await runCli(argv);
        if (verb === "closetab") await runCli(["open", "https://example.test/"]);
        try {
          expect({ argv, code: r.code }).toEqual({ argv, code: 0 });
          judge(argv, from);
        } catch (e) {
          failures.push(`${argv.join(" ")}: ${r.err.trim().slice(0, 200)} ${(e as Error).message.split("\n").slice(0, 6).join(" | ")}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  test("the same body aimed at the person's page, another agent's or a missing id is refused", () => {
    const cases: Array<[string, string]> = [["the person's page", PERSON], ["another agent's page", OTHER], ["a page that does not exist", MISSING]];
    for (const [op, body] of bodies) {
      const row = WORKER_VERBS[op];
      if (!row || row.target.length === 0) continue;
      const field = row.target[0];
      for (const [why, id] of cases) {
        const refusal = gate({ ...body, [field]: id }, op);
        expect({ op, why, refused: !!refusal }).toEqual({ op, why, refused: true });
      }
      expect({ op, own: gate(body, op) }).toEqual({ op, own: null });
    }
  });

  test("a tab from a template is refused by name, not as an unknown field", () => {
    const refusal = gate({ as: WORKER, url: "about:blank", ephemeral: true }, "newtab");
    expect(String(refusal)).toContain("from a template");
  });

  test("a mint without the worker's own profile is refused, own page or not", () => {
    /* The CLI sends `profile: <own>` for `newtab`; a hand-built POST that sends
       nothing (or `""`) had the panel mint in the person's container, and the
       own-page exemption made it look like a plain navigation. A page of the
       worker's own is not a container. */
    for (const [op, body] of [
      ["newtab", { as: WORKER, page: OWN_PAGE, url: "https://example.test/" }],
      ["newtab", { as: WORKER, page: OWN_PAGE, url: "https://example.test/", profile: "" }],
      ["newtab", { as: WORKER, url: "https://example.test/" }],
      ["open", { as: WORKER, page: OWN_PAGE, url: "https://example.test/", profile: "" }],
      ["open", { as: WORKER, page: OWN_PAGE, url: "https://example.test/", profile: "orbit-two" }],
      ["do", { as: WORKER, page: OWN_PAGE, steps: [{ op: "newtab", args: { url: "https://example.test/" } }] }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect({ op, body, refused: !!gate(body, op) }).toEqual({ op, body, refused: true });
    }
    /* The CLI's own shapes still pass: a mint under the worker's name, and a
       plain `open` that navigates the page it already owns. */
    expect(gate({ as: WORKER, profile: WORKER, url: "https://example.test/" }, "newtab")).toBeNull();
    expect(gate({ as: WORKER, page: OWN_PAGE, url: "https://example.test/" }, "open")).toBeNull();
  });

  test("a worker's turn: two opens, a click that observes, and whoami", async () => {
    const from = sent.length;
    const second = await runCli(["open", "https://b.example.test/"]);
    expect({ code: second.code, err: second.err }).toEqual({ code: 0, err: "" });
    const clicked = await runCli(["click", "e4", "--observe"]);
    expect({ code: clicked.code, err: clicked.err }).toEqual({ code: 0, err: "" });
    const who = await runCli(["whoami"]);
    expect({ code: who.code, err: who.err }).toEqual({ code: 0, err: "" });
    judge(["open", "click", "whoami"], from);
    const click = sent.slice(from).find((a) => a.op === "click")!;
    expect(click.body.observe).toBe(true);
    expect(click.body.page).toBe(OWN_PAGE);
  }, 60_000);
});
