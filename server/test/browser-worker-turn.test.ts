/*
 * The worker's credential ACROSS A TURN: what the wrapper hands the engine,
 * what the gate lets the worker drive, and the order in which a turn mints and
 * revokes. Each test here fails if its fix is reverted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerFor, mintWorkerToken, revokeWorkerToken, revokeWorkerTokens, revokeWorkerTokensExcept, workerTokenOf } from "../src/auth.ts";
import { agentAskRefusal, askBrowser, dropBrowserTarget, noteBrowserReady, noteWorkerAsk, noteWorkerPage, parseAsk, resetBrowserDrive, resetWorkerPages, setBrowserSink, workerAskCount } from "../src/browserdrive.ts";
import { prepareRun, wrapped } from "../src/agents/headless.ts";
import { guardTurn } from "../src/agents/opencodeserve.ts";

const MACHINE = "mk_the_person_for_this_test";
const scratch = mkdtempSync(join(tmpdir(), "agx-worker-turn-"));
/* Set only around the synchronous call below, and put back: every test file
   shares one process, and a leaked AGENTGLASS_STATE_DIR is another file's
   failure (AGENTS.md). */
const withStateDir = <T>(f: () => T): T => {
  const was = process.env.AGENTGLASS_STATE_DIR;
  process.env.AGENTGLASS_STATE_DIR = join(scratch, "state");
  try { return f(); } finally {
    if (was === undefined) delete process.env.AGENTGLASS_STATE_DIR;
    else process.env.AGENTGLASS_STATE_DIR = was;
  }
};
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the wrapper keeps the worker's credential (M1)", () => {
  /* The stub prints which KIND of credential it saw, never the value. Every
     engine runs through this one wrapper, so the loop is the engine paths. */
  const stub = join(scratch, "stub.sh");
  writeFileSync(stub, [
    "#!/bin/sh",
    'case "$AGENTGLASS_TOKEN" in',
    '  wk_*) echo "kind=worker" ;;',
    '  mk_*) echo "kind=machine" ;;',
    '  "") echo "kind=none" ;;',
    '  *) echo "kind=other" ;;',
    "esac",
    '[ -n "$AGENTGLASS_WORKER_TOKEN" ] && echo "own-name=leaked"',
    "exit 0",
  ].join("\n"));
  chmodSync(stub, 0o755);

  for (const engine of ["opencode", "claude", "qwen", "codex", "hermes"]) {
    test(`${engine}: the engine starts with the minted credential, not the person's`, () => {
      const files = withStateDir(() => prepareRun(`orbit-${engine}`, "", "none"));
      const minted = mintWorkerToken(`orbit-${engine}`);
      const r = Bun.spawnSync({
        cmd: wrapped(files, [stub], engine),
        env: {
          PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
          AGENTGLASS_TOKEN: MACHINE, AGENTGLASS_WORKER_TOKEN: minted,
        },
      });
      const printed = readFileSync(files.out, "utf8");
      expect({ engine, seen: printed.trim().split("\n").sort() })
        .toEqual({ engine, seen: ["kind=worker"] });
      expect({ engine, code: r.exitCode }).toEqual({ engine, code: 0 });
      revokeWorkerTokens(`orbit-${engine}`);
    });
  }
});

describe("the private OpenCode serve receives the worker's credential (stub serve)", () => {
  /* Measured, not read off the order of two lines: a stub `serve` is started
     by the real guard and writes down which KIND of credential it was given.
     It writes the kind, never the value. */
  test("a stub serve records a worker credential, not the machine one", async () => {
    const bin = join(scratch, "opencode-stub.sh");
    const record = join(scratch, "serve-credential.txt");
    writeFileSync(bin, [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "2.1.4"; exit 0 ;;',
      "esac",
      'case "$AGENTGLASS_TOKEN" in',
      '  wk_*) echo "kind=worker" ;;',
      '  mk_*) echo "kind=machine" ;;',
      '  "") echo "kind=none" ;;',
      '  *) echo "kind=other" ;;',
      "esac > \"$AGX_TEST_SERVE_RECORD\"",
      'echo "listening on http://127.0.0.1:1"',
      "exit 0",
    ].join("\n"));
    chmodSync(bin, 0o755);
    const name = "orbit-serve";
    const minted = mintWorkerToken(name);
    const turn = {
      argv: [bin, "run", "hi"],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ default_agent: "build" }),
        AGENTGLASS_TOKEN: minted, AGX_TEST_SERVE_RECORD: record,
      },
    } as unknown as Parameters<typeof guardTurn>[3];
    const r = await guardTurn("opencode", bin, scratch, turn);
    /* A stub cannot vouch for a lock, so the guard refuses. What it measured
       is the process's environment: the credential it was started with. */
    expect(r.ok).toBe(false);
    expect(readFileSync(record, "utf8").trim()).toBe("kind=worker");
    revokeWorkerTokens(name);
  }, 20_000);
});

describe("the gate canonicalises to the worker's own page (M2)", () => {
  const own = "orbit-1";
  const PAGE = "t9-orbit-own";
  test("a page this worker opened is its own", () => {
    resetWorkerPages();
    noteWorkerPage(own, PAGE);
    expect(agentAskRefusal({ as: own, page: PAGE, how: "own-tab" }, own)).toBeNull();
    expect(agentAskRefusal({ as: own, page: PAGE, pageExplicit: true }, own, "click")).toBeNull();
  });

  test("a page id this worker did not open is refused, whatever `as` it rides with", () => {
    resetWorkerPages();
    noteWorkerPage(own, PAGE);
    expect(agentAskRefusal({ as: own, page: "t9-person" }, own, "read")).not.toBeNull();
    expect(agentAskRefusal({ as: own, page: "t9-person", pageExplicit: true }, own, "click")).not.toBeNull();
    expect(agentAskRefusal({ as: own, page: "t9-person", how: "own-tab" }, own, "read")).not.toBeNull();
    expect(agentAskRefusal({ page: "t9-not-mine" }, own, "read")).not.toBeNull(); // no identity, and not its page
    expect(agentAskRefusal({ as: "(default)" }, own)).not.toBeNull();
  });

  test("no implicit front tab: a page-bound verb with no page of its own is refused", () => {
    resetWorkerPages();
    expect(agentAskRefusal({ as: own, selector: "#save" }, own, "click")).not.toBeNull();
    expect(agentAskRefusal({ as: own, steps: [{ op: "click", args: { selector: "#save" } }] }, own, "do")).not.toBeNull();
  });

  test("a do call inherits its own page into every step", () => {
    resetWorkerPages();
    noteWorkerPage(own, PAGE);
    expect(agentAskRefusal({ as: own, page: PAGE, steps: [{ op: "click", args: { selector: "#save" } }] }, own, "do")).toBeNull();
    expect(agentAskRefusal({ as: own, lanes: [{ page: PAGE, steps: [{ op: "click", args: { selector: "#save" } }] }] }, own, "do")).toBeNull();
    // A step's own address is checked when it runs, so it is not refused here;
    // `runSteps` refuses it before that step is sent (browser-worker-own-pages
    // covers the runtime half).
    expect(agentAskRefusal({ as: own, steps: [{ op: "click", args: { selector: "#save" } }] }, own, "do")).not.toBeNull();
  });

  test("a step that opens the empty profile is still the person's", () => {
    resetWorkerPages();
    expect(agentAskRefusal({ as: own, steps: [{ op: "open", args: { profile: "" } }] }, own, "do")).not.toBeNull();
    expect(agentAskRefusal({ as: own, steps: [{ op: "open", args: { as: "orbit-2" } }] }, own, "do")).not.toBeNull();
    expect(agentAskRefusal({ as: own, steps: [{ op: "newtab", args: { url: "https://example.test" } }] }, own, "do")).not.toBeNull();
  });

  test("fields the ops never read are not identity: name, action, container, how", () => {
    resetWorkerPages();
    expect(agentAskRefusal({ name: own, selector: "#pay" }, own, "click")).not.toBeNull();
    expect(agentAskRefusal({ action: "new", selector: "#pay" }, own, "click")).not.toBeNull();
    expect(agentAskRefusal({ container: "named", selector: "#pay" }, own, "click")).not.toBeNull();
    expect(agentAskRefusal({ how: "own-container", selector: "#pay" }, own, "click")).not.toBeNull();
  });

  test("a verb outside the own-profile allowlist is refused deny-by-default", () => {
    resetWorkerPages();
    noteWorkerPage(own, PAGE);
    for (const op of ["cookies", "storage", "eval", "cdp", "addInitScript", "fake", "handoff", "record", "download"]) {
      expect({ op, refused: agentAskRefusal({ as: own, page: PAGE }, own, op) }).not.toEqual({ op, refused: null });
    }
  });
});

describe("round 8: the identity gate is the CLI's, folded, and force is not a lever", () => {
  const own = "alba";
  test("the profile is folded like `as`: a capitalised worker mints its own page", () => {
    resetWorkerPages();
    expect(agentAskRefusal({ as: "Alba", profile: "Alba", identity: "Alba" }, own, "open")).toBeNull();
    expect(agentAskRefusal({ profile: " ALBA " }, own, "newtab")).toBeNull();
    expect(agentAskRefusal({ profile: "orbit-2" }, own, "open")).not.toBeNull();
    expect(agentAskRefusal({ profile: "alba-2" }, own, "open")).not.toBeNull();
  });

  test("--force is refused: it is a lever over somebody else's lane", () => {
    expect(agentAskRefusal({ action: "list", force: true }, own, "lane")).not.toBeNull();
    expect(agentAskRefusal({ action: "close", id: "l1", force: true }, own, "lane")).not.toBeNull();
    // A plain list or close of its own is still a lane verb.
    expect(agentAskRefusal({ action: "list" }, own, "lane")).toBeNull();
  });

  test("a mint cannot take the pane, and a template lane is a template tab", () => {
    /* `show` is consent, not data: a worker's mint bringing the view forward
       pulls it off whoever is typing. A template lane is the lane twin of a
       template tab, and both carry another container's saved cookies. */
    expect(agentAskRefusal({ profile: own, url: "https://example.test", show: true }, own, "open")).not.toBeNull();
    expect(agentAskRefusal({ profile: own, url: "https://example.test", show: true }, own, "newtab")).not.toBeNull();
    expect(agentAskRefusal({ profile: own, url: "https://example.test" }, own, "open")).toBeNull();
    expect(agentAskRefusal({ action: "new", ephemeral: true }, own, "lane")).not.toBeNull();
    expect(agentAskRefusal({ action: "new" }, own, "lane")).toBeNull();
  });

  test("a mint requires the worker's own profile, and an own page does not stand in for it", () => {
    /* The round-13 exemption let a body naming its own page skip the profile
       check, and the panel reads the missing profile as the person's container.
       Measured as a tab minted in the person's partition and then read. */
    resetWorkerPages();
    noteWorkerPage(own, "t9-own");
    for (const [op, body] of [
      ["newtab", { page: "t9-own", url: "https://example.test" }],
      ["newtab", { page: "t9-own", url: "https://example.test", profile: "" }],
      ["open", { page: "t9-own", url: "https://example.test", profile: "" }],
      ["open", { url: "https://example.test", profile: " " }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect({ op, body, refused: !!agentAskRefusal(body, own, op) }).toEqual({ op, body, refused: true });
    }
    /* A plain open with an own page and no profile only navigates it. */
    expect(agentAskRefusal({ page: "t9-own", url: "https://example.test" }, own, "open")).toBeNull();
  });

  test("`tab` is not a worker field, and the schema says so rather than a dead check", () => {
    const why = agentAskRefusal({ as: own, tab: "t9-person" }, own, "read");
    expect(why).toContain('carries "tab"');
  });

  test("fill is allowed to carry `submit`: the CLI sends it on every call", () => {
    resetWorkerPages();
    noteWorkerPage(own, "t9-own");
    expect(agentAskRefusal({ page: "t9-own", fields: [{ selector: "#a", value: "b" }], submit: false }, own, "fill")).toBeNull();
  });

  test("a second start of a live name keeps its credential instead of leaving two", () => {
    const live = mintWorkerToken("orbit-live");
    const second = mintWorkerToken("orbit-live", undefined, false);
    revokeWorkerToken(second);
    expect(workerTokenOf("orbit-live")).toBe(live);
    // Once a start wins, its own token is the only one left.
    const winner = mintWorkerToken("orbit-live", undefined, false);
    revokeWorkerTokensExcept("orbit-live", winner);
    expect(workerTokenOf("orbit-live")).toBe(winner);
    expect(workerTokenOf("orbit-live")).toBeDefined();
    revokeWorkerTokens("orbit-live");
    expect(workerTokenOf("orbit-live")).toBeUndefined();
  });
  test("both start paths hand the worker its own name, and the route revokes only what it minted", () => {
    const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    // The identity is stamped once, in the helper both start paths mint through.
    const access = src("../src/browseraccess.ts");
    expect(access).toContain("env.AGENTGLASS_PROFILE = name");
    expect(access).toContain("env.AGENTGLASS_BROWSER_AS = name");
    const policy = src("../src/agents/policystart.ts");
    expect(policy).toContain("mintBrowserCredential(turn.env");
    const route = src("../src/index.ts");
    expect(route).toContain("mintBrowserCredential(role.env, name, wanted, role.id");
    // The resolved role id, not a second reading of the body.
    expect(route).not.toContain("mintBrowserCredential(role.env, name, wanted, String(b.role)");
    // Never by name: that cut the live worker's credential on an `exists`.
    expect(route).toContain("revokeWorkerToken(mintedTo)");
    expect(route).not.toContain("revokeWorkerTokens(name)");
    expect(route).toContain("revokeWorkerTokensExcept(name, mintedTo)");
  });

  test("an ask no window answers does not stay in the map", async () => {
    resetWorkerPages();
    setBrowserSink({ send: () => true, listeners: () => 1 });
    noteBrowserReady("w-leak", true);
    const parsed = parseAsk("open", { profile: "orbit-one", url: "https://example.test" });
    if ("error" in parsed) throw new Error(parsed.error);
    const pending = askBrowser(parsed.ask);
    noteWorkerAsk(parsed.ask.id, "orbit-one", "open");
    expect(workerAskCount()).toBe(1);
    dropBrowserTarget("w-leak");
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(workerAskCount()).toBe(0);
    resetBrowserDrive();
  });
});

describe("a credential ends when its turn does (M3, M4, S5)", () => {
  const caller = (t: string) =>
    callerFor(new Request("http://x/", { headers: { authorization: `Bearer ${t}` } }), new URL("http://x/"), MACHINE);

  test("a token minted AFTER the previous turn's revocation still resolves", () => {
    // The order policystart must keep: stopAgent revokes by name, so a token
    // minted before it is dead on arrival.
    mintWorkerToken("orbit-3");
    revokeWorkerTokens("orbit-3");
    const fresh = mintWorkerToken("orbit-3");
    expect(caller(fresh)).toMatchObject({ principal: "worker", worker: "orbit-3" });
    revokeWorkerTokens("orbit-3");
  });

  test("a credential expires at the worker's own turn limit", async () => {
    const t = mintWorkerToken("orbit-4", 20);
    expect(caller(t)).not.toBeNull();
    await Bun.sleep(40);
    expect(caller(t)).toBeNull();
    expect(workerTokenOf("orbit-4")).toBeUndefined();
  });

  const source = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  test("policystart mints before the serve that runs the shell, after every refusal", () => {
    const s = source("../src/agents/policystart.ts");
    const at = (needle: string, from = 0) => s.indexOf(needle, from);
    // startNow: the 409 for a live name comes before the mint.
    expect(at("an agent by that name is still running")).toBeLessThan(at("mintBrowserCredential(turn.env, p.name"));
    // M3: the private serve freezes the env it is started with, so the mint
    // must come BEFORE guardTurn; minting after it leaves the shell's process
    // tree with no token on OpenCode 2.x.
    expect(at("mintBrowserCredential(turn.env, p.name")).toBeLessThan(at("await guardTurn("));
    expect(s).not.toContain("mintBrowserCredential(g.turn.env");
    // resumeTurn: stopAgent revokes the name, so the mint follows it, and it
    // comes before the serve for the same reason as startNow.
    const resume = at("async function resumeTurn");
    expect(at("stopAgent(a, Date.now(), true)", resume)).toBeLessThan(at("mintBrowserCredential(turn.env, a.name", resume));
    expect(at("mintBrowserCredential(turn.env, a.name", resume)).toBeLessThan(at("await guardTurn(by.engine", resume));
    // switchEngine: same order.
    const swap = at("function switchEngine");
    expect(at("stopAgent(a, Date.now(), true)", swap)).toBeLessThan(at("mintBrowserCredential(turn.env, a.name", swap));
    expect(at("mintBrowserCredential(turn.env, a.name", swap)).toBeLessThan(at("await guardTurn(next.choice.engine", swap));
  });

  test("the start route mints after the checks that can refuse", () => {
    const s = source("../src/index.ts");
    const at = (needle: string) => s.indexOf(needle);
    expect(at("this role runs on ${role.kind}")).toBeLessThan(at("mintBrowserCredential(role.env, name,"));
  });
});
