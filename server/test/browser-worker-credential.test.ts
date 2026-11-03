/*
 * A WORKER'S OWN CREDENTIAL IS WHAT THE RELAY REFUSES, NOT AN ENV VAR.
 *
 * The worker used to inherit the machine token, so at the relay it WAS the
 * person and no credential an agent carried ever reached the gate. These are the
 * real routes against a real server whose worker credential was minted by the
 * real function in this process; the CLI half proves the round-3 bypass
 * (`AGENTGLASS_ROLE` unset by the worker's own shell) no longer matters,
 * because the identity is the credential the server minted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { mintWorkerToken, callerFor, revokeWorkerTokens, workerTokenOf } from "../src/auth.ts";
import { agentAskRefusal, BROWSER_OPS, WORKER_OPS, WORKER_OP_FIELDS, noteWorkerPage, resetWorkerPages } from "../src/browserdrive.ts";

const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;
const HAVE_PY = !!Bun.which("python3");
const MACHINE = "mk_machine_for_the_test_only";

let dir = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
let worker = "";

/** The ask, as a worker's credential and as the machine token. */
const post = async (path: string, body: unknown, token: string) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: base, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-workertok-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const tokenFile = join(dir, "worker-token");
  /* Minted in the process that serves the routes: auth.ts keeps these in
     memory, so a test process cannot mint for another process. */
  const launcher = join(dir, "boot.ts");
  const auth = new URL("../src/auth.ts", import.meta.url).pathname;
  const index = new URL("../src/index.ts", import.meta.url).pathname;
  writeFileSync(launcher, [
    `import { writeFileSync } from "node:fs";`,
    `import { mintWorkerToken } from ${JSON.stringify(auth)};`,
    `writeFileSync(${JSON.stringify(tokenFile)}, mintWorkerToken("orbit-1"));`,
    `await import(${JSON.stringify(index)});`,
  ].join("\n"));
  proc = Bun.spawn(["bun", "run", launcher], {
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: MACHINE,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base + "/health")).ok) break;
    } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  worker = readFileSync(tokenFile, "utf8").trim();
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("the worker's credential at the relay", () => {
  const forms: Array<[string, string, unknown]> = [
    ["--shared read", "/browser/read", { how: "shared" }],
    ["open names the empty profile", "/browser/open", { as: "orbit-1", profile: "", url: "https://example.test" }],
    ["--as (default)", "/browser/read", { as: " (DEFAULT) " }],
    ["the tab in front", "/browser/read", { active: true }],
    ["a lane in the person's container", "/browser/lane", { action: "new", shared: true }],
    ["another agent's profile", "/browser/read", { as: "orbit-2" }],
    ["a step that opens the empty profile", "/browser/do", { steps: [{ op: "open", args: { url: "https://example.test", profile: "" } }] }],
    ["a step that makes a shared lane", "/browser/do", { steps: [{ op: "lane", args: { action: "new", shared: true } }] }],
    ["a lane whose steps name it", "/browser/do", { lanes: [{ page: "t9-ef01", steps: [{ op: "open", args: { profile: "" } }] }] }],
  ];
  for (const [why, path, body] of forms) {
    test(`${why} is refused`, async () => {
      const r = await post(path, body, worker);
      expect(r.status).toBe(403);
      expect(((await r.json()) as any).error).toContain("minted for an agent");
    });
  }

  test("its own identity alone is not a target: no implicit front tab", async () => {
    const r = await post("/browser/read", { as: "orbit-1", how: "own-container" }, worker);
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error).toContain("names no page of its own");
  });

  test("an empty profile is the container refusal, not the missing-identity one", async () => {
    /* This body carries `as`, so the route's "names no identity" answer cannot
       be what refuses it: the refusal has to be the gate's, about the
       container. Without that, the test above passed for the wrong reason and
       the empty profile reached the panel as the person's container. */
    const r = await post("/browser/open", { as: "orbit-1", profile: "", url: "https://example.test" }, worker);
    expect(r.status).toBe(403);
    const why = ((await r.json()) as any).error as string;
    expect(why).toContain("reaches only that agent's own container");
    expect(why).not.toContain("names no identity");
  });

  test("an ordinal is refused: the panel resolves `index` over the whole window (M1)", async () => {
    /* Round 7 measured `closetab {index:0}` reaching the panel, which closes
       `tabsRef.current[0]` — the person's first tab. `id` is the only form a
       worker may use, and the field schema refuses the rest by name. */
    for (const [path, body] of [
      ["/browser/tab", { as: "orbit-1", index: 0 }],
      ["/browser/closetab", { as: "orbit-1", index: 0 }],
      ["/browser/do", { steps: [{ op: "closetab", args: { index: 0 } }] }],
      ["/browser/do", { steps: [{ op: "tab", args: { index: 1 } }] }],
      ["/browser/do", { lanes: [{ steps: [{ op: "closetab", args: { index: 0 } }] }] }],
      ["/browser/click", { as: "orbit-1", nth: 0, selector: "#pay" }],
      ["/browser/click", { as: "orbit-1", position: 2, selector: "#pay" }],
      ["/browser/click", { as: "orbit-1", x: 10, y: 20, selector: "#pay" }],
      ["/browser/do", { steps: [{ op: "click", args: { selector: "#pay" }, position: 1 }] }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await post(path, body, worker);
      expect({ path, body, status: r.status }).toEqual({ path, body, status: 403 });
      expect(((await r.json()) as any).error).toContain("minted for an agent");
    }
  });

  test("the window's own routes refuse a principal before reading a body (M2)", async () => {
    /* `ready` would register this credential as the window that receives the
       person's asks; `result` would let it answer them. Both are refused
       before the body is parsed, so a forged shape cannot even be a 400. */
    const forged = await fetch(base + "/browser/ready", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base, authorization: `Bearer ${worker}` },
      body: "{not json",
    });
    expect(forged.status).toBe(403);
    for (const [path, body] of [
      ["/browser/ready", { client: "orbit-1-window", lanes: ["lane-1"] }],
      ["/browser/result", { id: "b1-forged", ok: true, value: { url: "https://example.test" } }],
    ] as Array<[string, unknown]>) {
      const r = await post(path, body, worker);
      expect({ path, status: r.status }).toEqual({ path, status: 403 });
    }
    /* The window's own credential still reaches both. */
    for (const [path, body] of [
      ["/browser/ready", { client: "win-test" }],
      ["/browser/result", { id: "b1-unknown", ok: true }],
    ] as Array<[string, unknown]>) {
      const r = await post(path, body, MACHINE);
      expect({ path, status: r.status }).not.toEqual({ path, status: 403 });
    }
  });

  test("the reads that answer before the POST gate refuse a principal too (S1)", async () => {
    /* The audit and the lane list name every caller. Round 7 measured the
       audit refusal with the check deleted and every suite still green. */
    for (const path of ["/browser/audit", "/browser/lanes"]) {
      const theirs = await fetch(base + path, { headers: { authorization: `Bearer ${worker}`, Origin: base } });
      expect({ path, status: theirs.status }).toEqual({ path, status: 403 });
    }
    for (const path of ["/browser/audit", "/browser/lanes"]) {
      const mine = await fetch(base + path, { headers: { authorization: `Bearer ${MACHINE}`, Origin: base } });
      expect({ path, status: mine.status }).toEqual({ path, status: 200 });
    }
    /* Installing the skill writes into this machine's tree. */
    const install = await post("/browser-use/install", {}, worker);
    expect(install.status).toBe(403);
  });

  test("page ids the worker did not open are refused, typed or explicit", async () => {
    /* Nothing here ever reached a window, so the registry of pages this
       worker opened is empty: every id is somebody else's, including the
       person's front tab. This is the shape round 6 measured as allowed. */
    for (const body of [
      { as: "orbit-1", page: "t9-ef01", how: "own-tab" },
      { as: "orbit-1", page: "t9-ef01", pageExplicit: true, how: "explicit-page" },
      { as: "orbit-1", steps: [{ op: "click", args: { selector: "#save" } }] },
      { as: "orbit-1", steps: [{ op: "click", args: { page: "t9-ef01", pageExplicit: true } }] },
      { as: "orbit-1", lanes: [{ page: "t9-ef01", steps: [{ op: "click", args: { selector: "#save" } }] }] },
      { name: "orbit-1", selector: "#pay" },
      { action: "new", selector: "#pay" },
      { container: "named", selector: "#pay" },
    ]) {
      const r = await post("/browser/click", body, worker);
      expect({ body, status: r.status }).toEqual({ body, status: 403 });
    }
  });

  test("a new tab is only minted under the worker's own name", async () => {
    for (const body of [
      { as: "orbit-1", action: "newtab", url: "https://example.test" },
      { as: "orbit-1", profile: "", url: "https://example.test" },
    ]) {
      const r = await post("/browser/newtab", body, worker);
      expect({ body, status: r.status }).toEqual({ body, status: 403 });
    }
    const own = await post("/browser/newtab", { as: "orbit-1", profile: "orbit-1", url: "https://example.test" }, worker);
    expect(own.status).not.toBe(403);
  });

  test("the data routes are behind the same gate (S1)", async () => {
    for (const path of ["/browser/places", "/browser/places/forget", "/browser/visit"]) {
      const r = await post(path, { places: [], url: "https://example.test" }, worker);
      expect({ path, status: r.status }).toEqual({ path, status: 403 });
    }
    /* The read of everything imported had no gate at all (M2): a worker could
       list the person's whole history. */
    const all = await fetch(base + "/browser/places/all", { headers: { authorization: `Bearer ${worker}`, Origin: base } });
    expect(all.status).toBe(403);
    /* The person's own credential still reaches them. */
    const theirs = await fetch(base + "/browser/places/all", { headers: { authorization: `Bearer ${MACHINE}`, Origin: base } });
    expect(theirs.status).toBe(200);
  });

  test("a private lane is its own, not the person's", async () => {
    const r = await post("/browser/lane", { as: "orbit-1", action: "new" }, worker);
    expect(r.status).not.toBe(403);
  });

  test("the person's machine token still reaches the shared container", async () => {
    for (const [path, body] of [
      ["/browser/read", { how: "shared" }],
      ["/browser/open", { profile: "" }],
      ["/browser/do", { steps: [{ op: "open", args: { url: "https://example.test", profile: "" } }] }],
    ] as Array<[string, unknown]>) {
      const r = await post(path, body, MACHINE);
      expect(r.status).not.toBe(403);
    }
  });

  test("the CLI never upgrades a worker to the person's token file (M1)", async () => {
    if (!HAVE_PY) return;
    // The file holds a token the server DOES accept. If the CLI fell back, the
    // read would be answered instead of refused.
    mkdirSync(join(dir, "agentglass"), { recursive: true });
    writeFileSync(join(dir, "agentglass", "token"), MACHINE);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir, AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_SERVER: base, AGENTGLASS_ROLE: "builder",
    };
    for (const withToken of [true, false]) {
      const e = { ...env, ...(withToken ? { AGENTGLASS_TOKEN: "wk_not_a_live_one" } : {}) };
      const r = Bun.spawnSync({ cmd: ["python3", CLI, "--as", "orbit-1", "whoami"], env: e });
      expect({ withToken, code: r.exitCode }).not.toEqual({ withToken, code: 0 });
      expect(r.stderr.toString()).toContain("does not fall back");
    }
  }, 30_000);

  test("the CLI's round-3 bypass is no longer the boundary", async () => {
    if (!HAVE_PY) return;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      AGENTGLASS_TOKEN: worker, AGENTGLASS_SERVER: base,
      XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir, AGENTGLASS_STATE_DIR: `${dir}/state`,
    };
    const run = (args: string[]) =>
      Bun.spawnSync({ cmd: ["python3", CLI, ...args], env });
    // No AGENTGLASS_ROLE at all: the CLI lets it through, and the relay refuses
    // it on the credential.
    const r = run(["--as", "(default)", "open", "https://example.test"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("minted for an agent");
  }, 30_000);
});

describe("the identity the credential carries", () => {
  test("a worker token is a principal, and revocation ends it", () => {
    const t = mintWorkerToken("orbit-1");
    expect(callerFor(new Request(`http://x/?token=${t}`, { headers: { authorization: `Bearer ${t}` } }), new URL("http://x/"), MACHINE))
      .toMatchObject({ kind: "machine", scope: "full", principal: "worker", worker: "orbit-1" });
    revokeWorkerTokens("orbit-1");
    expect(workerTokenOf("orbit-1")).toBeUndefined();
    expect(callerFor(new Request("http://x/", { headers: { authorization: `Bearer ${t}` } }), new URL("http://x/"), MACHINE)).toBeNull();
  });

  test("a follow-up turn replaces the credential it continues", () => {
    const first = mintWorkerToken("orbit-2");
    const second = mintWorkerToken("orbit-2");
    expect(second).not.toBe(first);
    expect(callerFor(new Request("http://x/", { headers: { authorization: `Bearer ${first}` } }), new URL("http://x/"), MACHINE)).toBeNull();
    revokeWorkerTokens("orbit-2");
  });

  test("the CLI's role ids do not drift from the shared table", async () => {
    const { WORKER_ROLES } = await import("../../shared/workerRoles.ts");
    const cli = readFileSync(CLI, "utf8");
    const line = cli.split("\n").find((l) => l.startsWith("WORKER_ROLE_IDS")) ?? "";
    for (const role of WORKER_ROLES) expect(line).toContain(`"${role.id}"`);
    expect(line.match(/"[a-z]+"/g)?.length).toBe(WORKER_ROLES.length);
  });

  test("every shared form is in the one refusal, steps included", () => {
    for (const body of [
      { how: "shared" }, { profile: "" }, { active: true }, { page: "t9-ef01" },
      { steps: [{ op: "open", args: { profile: "" } }] },
      { lanes: [{ page: "t9-ef01", steps: [{ op: "read", args: {} }] }] },
    ]) expect(agentAskRefusal(body)).not.toBeNull();
    expect(agentAskRefusal({ as: "orbit-1", how: "own-container" })).toBeNull();
    expect(agentAskRefusal({ as: "orbit-1", action: "new" })).toBeNull();
  });

  test("a plugin's credential does not mint, and says so in its own words", () => {
    /* A plugin has no worker name, so it took the `namesThePerson` branch: an
       `open` with a profile was allowed and minted a container, then every
       read of that container was refused as the person's. Refuse the mint too,
       with a sentence that names the plugin rather than an agent. */
    for (const [op, body] of [
      ["open", { as: "orbit-1", profile: "orbit-1", url: "https://example.test" }],
      ["newtab", { as: "orbit-1", profile: "orbit-1", url: "https://example.test" }],
      ["do", { as: "orbit-1", steps: [{ op: "newtab", args: { profile: "orbit-1" } }] }],
    ] as Array<[string, Record<string, unknown>]>) {
      const why = agentAskRefusal(body, undefined, op);
      expect({ op, why }).toMatchObject({ op, why: expect.stringContaining("minted for a plugin") });
    }
    /* A plain ask about a tab the person opened is still the person's business:
       refusing it is the existing rule, not this one. */
    expect(agentAskRefusal({ as: "orbit-1", page: "t9-ef01" }, undefined, "read")).toContain("minted for an agent");
  });
});

describe("a worker's body is a table, not a guess (the M1 class fix)", () => {
  /*
   * Every op the relay knows, and the fields a worker's body may carry for it.
   * This is the decision table: a new op, or a new field on an existing one,
   * fails here until somebody writes the decision down. `index`, `nth`,
   * `position` and coordinates are absent on purpose — the panel resolves an
   * ordinal over every tab in the window, not over this worker's own pages.
   */
  const ALLOWED: Record<string, string[]> = {
    open: ["url", "profile", "identity", "show", "ephemeral"],
    read: [],
    markdown: [],
    extract: ["fields"],
    links: [],
    count: ["selector"],
    search: ["query"],
    interactive: [],
    forms: [],
    attr: ["selector", "names"],
    click: ["selector"],
    type: ["selector", "text", "submit"],
    wait: ["selector"],
    shot: ["path", "fullPage", "withInspector", "selector", "clip", "highlight", "label", "marks", "omitBackground"],
    back: [],
    forward: [],
    scroll: ["selector", "by", "to"],
    press: ["key"],
    text: ["selector"],
    tabs: [],
    tab: ["id"],
    newtab: ["url", "profile", "identity", "show", "ephemeral"],
    closetab: ["id"],
    console: ["delta", "limit", "root", "shot", "since", "viewport"],
    network: ["delta", "limit", "root", "shot", "since", "viewport"],
    resize: ["width", "height"],
    zoom: ["factor"],
    html: ["clean", "max", "selector"],
    waitfor: ["js", "timeoutMs", "until"],
    observe: ["delta", "limit", "root", "shot", "since", "viewport"],
    select: ["selector", "value"],
    reload: ["bypassCache"],
    frames: [],
    dblclick: ["selector"],
    rightclick: ["selector"],
    hover: ["selector"],
    focus: ["selector"],
    blur: ["selector"],
    check: ["selector", "checked"],
    fill: ["fields", "submit"],
    events: ["kinds", "since", "wait", "timeoutMs"],
    whoami: ["identity", "tab"],
    health: [],
    lane: ["action", "id", "profile", "shared", "force", "ephemeral", "container"],
    a11y: [],
    inspect: ["action"],
    vitals: [],
  };
  /* Every other verb: refused to a credential that carries a principal, and a
     decision to move one into ALLOWED is its own commit. */
  const REFUSED = [
    "screencast", "eval", "cookies", "addInitScript", "expose", "exposed",
    "cdp", "listeners", "coverage", "profiles", "emulate", "record", "audit",
    "debug", "tools", "call-tool", "clock", "download", "settings", "drag",
    "upload", "storage", "permission", "pdf", "throttle", "har", "region",
    "clipboard", "save", "headers", "fake", "trace", "intercept", "checkup",
    "dialog", "handoff", "done",
  ];
  const PAGE = "t9-orbit-own";

  test("the table covers every op, and matches the server's own", () => {
    expect(Object.keys(ALLOWED).sort()).toEqual([...WORKER_OPS].sort());
    expect([...Object.keys(ALLOWED), ...REFUSED].sort()).toEqual([...BROWSER_OPS].sort());
    expect(REFUSED.filter((op) => op in ALLOWED)).toEqual([]);
    for (const [op, fields] of Object.entries(ALLOWED)) {
      expect({ op, fields: [...(WORKER_OP_FIELDS.get(op) ?? [])].sort() })
        .toEqual({ op, fields: [...fields].sort() });
    }
  });

  test("an undeclared field is refused for every allowed op, `index` included", () => {
    resetWorkerPages();
    noteWorkerPage("orbit-1", PAGE);
    for (const op of WORKER_OPS) {
      for (const extra of [{ index: 0 }, { nth: 1 }, { position: 2 }, { x: 3, y: 4 }]) {
        const refused = agentAskRefusal({ as: "orbit-1", page: PAGE, ...extra }, "orbit-1", op);
        expect({ op, extra, refused }).not.toEqual({ op, extra, refused: null });
      }
    }
  });

  test("every refused op stays refused whatever fields its body carries", () => {
    resetWorkerPages();
    noteWorkerPage("orbit-1", PAGE);
    for (const op of REFUSED) {
      const refused = agentAskRefusal(
        { as: "orbit-1", page: PAGE, profile: "orbit-1", action: "new", selector: "#x" }, "orbit-1", op,
      );
      expect({ op, refused }).not.toEqual({ op, refused: null });
    }
  });

  test("a step may not smuggle a field the step itself does not read", () => {
    resetWorkerPages();
    noteWorkerPage("orbit-1", PAGE);
    expect(agentAskRefusal(
      { as: "orbit-1", page: PAGE, steps: [{ op: "click", args: { selector: "#x" }, index: 0 }] }, "orbit-1", "do",
    )).not.toBeNull();
    expect(agentAskRefusal(
      { as: "orbit-1", page: PAGE, steps: [{ args: { selector: "#x" } }] }, "orbit-1", "do",
    )).not.toBeNull();
    expect(agentAskRefusal(
      { as: "orbit-1", page: PAGE, steps: [{ op: "do", args: { steps: [] } }] }, "orbit-1", "do",
    )).not.toBeNull();
  });
});
