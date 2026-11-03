/*
 * A WORKER'S FIRST CALL, WITH NO `--as` AND NO PROFILE FLAG.
 *
 * The relay serves a worker only the container its own agent name opened, and
 * the CLI used to derive `<cwd>-<hash>` from the session — never that name — so
 * every default call was a 403 whose advice named a flag the worker had no
 * value for. The app now hands the name over with the credential
 * (AGENTGLASS_BROWSER_AS / AGENTGLASS_PROFILE), and the CLI acts as it.
 *
 * So this runs the real CLI, as the app starts a worker, against a real server
 * with a credential minted for one name, and a stub window that APPLIES THE
 * PANEL'S RULES rather than answering everything: which tab an ask resolves to,
 * the cross-container refusal, and a mint into a container that already exists.
 * They are imported from the modules the panel itself imports, so a relay that
 * sends a step to the wrong tab fails here instead of passing against a stub
 * that would say yes to anything. Nothing here types `as` on the wire: the body
 * under test is the one the CLI builds for itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { closedReply, openedReply, selectedReply, tabsReply, type TabRow } from "../../shared/browserTabReplies.ts";
import { crossContainerRefusal, resolveAskTab } from "../../shared/browserOwnership.ts";
import { agentContainerName, containerOwner, isAgentContainer } from "../../shared/workerContainer.ts";
import { mintAgentProfile, type BrowserProfile } from "../../web/src/lib/browserProfiles.ts";

const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;
const PY = Bun.which("python3");
const MACHINE = "mk_machine_for_the_flow_only";
const WORKER = "reviewer-row-89-worker-browser-that-needs-all-sixty-four-chars-x";

let dir = "", base = "", token = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
const sockets: WebSocket[] = [];
/** What the CLI actually put on each ask: the body the relay parsed. */
const asks: Array<{ op: string; args: Record<string, unknown> }> = [];
/** The ids the stub's mines returned, in order. */
const mintedIds: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-worker-flow-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const tokenFile = join(dir, "worker-token");
  const launcher = join(dir, "boot.ts");
  const auth = new URL("../src/auth.ts", import.meta.url).pathname;
  const index = new URL("../src/index.ts", import.meta.url).pathname;
  writeFileSync(launcher, [
    `import { writeFileSync } from "node:fs";`,
    `import { mintWorkerToken } from ${JSON.stringify(auth)};`,
    `writeFileSync(${JSON.stringify(tokenFile)}, mintWorkerToken(${JSON.stringify(WORKER)}));`,
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
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  token = readFileSync(tokenFile, "utf8").trim();

  /* The window: one socket that says hello, one registration, and an answer to
     every verb the flow runs. The tab answers are built by the panel's own
     reply builders, not typed here: the guard under test is only tested
     against the shape the panel really sends. */
  const rows: TabRow[] = [
    { id: "t7-orbit", profile: agentContainerName(WORKER), title: "Orbit", url: "https://example.test/", active: false },
    { id: "t1-personal", profile: "default", title: "Bank", url: "https://bank.example/", active: true },
    /* Another agent's container, beside the one under test: a relay that sent
       this worker's ask to it would be talking to somebody else's page. (The
       exact name collision — a person's profile named like the worker — is
       covered at the mint layer, web/test/browser-profiles.test.ts.) */
    { id: "t4-other", profile: "agent:orbit-two", title: "Other agent", url: "https://other.example/", active: false },
  ];
  const personContainers = new Set(["default", WORKER]);
  /* The panel's real profile list: a mint goes through `mintAgentProfile`, so a
     cap that the relay does not apply fails here instead of passing against a
     stub that copies the requested name into the row. */
  const knownProfiles: BrowserProfile[] = [];
  let mintCount = 0;
  /* The panel's per-ask decisions, as `BrowserPanel` makes them: a named tab
     that is not here fails, an ask naming no page goes to the tab in front, and
     acting across containers is refused. */
  const serve = (op: string, args: Record<string, unknown>): { error?: string } => {
    const listOnly = new Set(["tabs", "tab", "newtab", "open", "closetab", "profiles", "whoami", "health", "lane", "do"]);
    if (listOnly.has(op)) return {};
    const active = rows.find((r) => r.active)?.id ?? null;
    const picked = resolveAskTab({ page: args.page, active, present: rows.map((r) => r.id) });
    if ("error" in picked) return picked;
    const row = rows.find((r) => r.id === picked.tab);
    if (!row) return { error: "no tab to serve this from" };
    const refusal = crossContainerRefusal({
      tab: row.id,
      container: containerOwner(row.profile || "default"),
      as: typeof args.as === "string" ? args.as : "",
      pageExplicit: args.pageExplicit === true,
      acts: true,
    });
    return refusal ? { error: refusal } : {};
  };
  const ws = new WebSocket(base.replace("http", "ws") + `/stream?token=${encodeURIComponent(MACHINE)}`);
  sockets.push(ws);
  ws.addEventListener("message", (ev) => {
    let f: any;
    try { f = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
    if (f.type !== "browser") return;
    asks.push({ op: f.data.op, args: f.data.args ?? {} });
    const op = f.data.op as string;
    if (op === "lane" && typeof f.data.args?.make === "string") {
      /* A lane host registers for the id the manager was asked to make. */
      void fetch(base + "/browser/ready", {
        method: "POST",
        headers: { "content-type": "application/json", Origin: base, authorization: `Bearer ${MACHINE}` },
        body: JSON.stringify({ client: "lane-host", lanes: [f.data.args.make] }),
      });
    }
    const args = (f.data.args ?? {}) as Record<string, unknown>;
    /* An `open`/`newtab` carrying a container is a mint. A reserved name is
       always minted fresh; a person's container of the same name is what the
       panel would have lent the worker before the namespace. */
    let minted: { id: string } | null = null;
    let mintError = "";
    if (op === "open" || op === "newtab") {
      const wanted = typeof args.profile === "string" ? args.profile : "";
      let container = wanted;
      if (isAgentContainer(wanted)) {
        const made = mintAgentProfile(knownProfiles, wanted);
        if ("error" in made) mintError = made.error;
        else {
          knownProfiles.splice(0, knownProfiles.length, ...made.profiles);
          container = made.profile.name;
        }
      } else if (wanted && !personContainers.has(wanted)) {
        container = "default";
      }
      if (!mintError) {
        const id = `t8-minted${++mintCount}`;
        rows.push({ id, profile: container, title: "Mint", url: String(args.url ?? ""), active: false });
        minted = { id };
        mintedIds.push(id);
      }
    }
    const verdict = mintError ? { error: mintError } : serve(op, args);
    const value = verdict.error
      ? undefined
      : (op === "open" || op === "newtab") && minted
      ? openedReply(minted, rows).value
      : op === "tabs"
        ? tabsReply(rows).value
        : op === "tab"
          ? selectedReply(rows, rows.find((r) => r.id === "t7-orbit")).value
          : op === "closetab"
            ? closedReply(rows).value
            : op === "observe"
        ? { url: "https://example.test/", title: "Orbit", console: [], network: [] }
        : op === "shot"
          ? { png: "data:image/png;base64,AAAA", path: f.data.args?.path }
          : {};
    void fetch(base + "/browser/result", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base, authorization: `Bearer ${MACHINE}` },
      body: JSON.stringify(verdict.error
        ? { client: "desk-flow", id: f.data.id, ok: false, error: verdict.error }
        : { client: "desk-flow", id: f.data.id, ok: true, value }),
    });
  });
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(JSON.stringify({ type: "hello", clientId: "desk-flow", browser: true }));
  await Bun.sleep(100);
  const ready = await fetch(base + "/browser/ready", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: base, authorization: `Bearer ${MACHINE}` },
    body: JSON.stringify({ client: "desk-flow", on: true }),
  });
  if (!ready.ok) throw new Error(`the stub window did not register: ${ready.status}`);
}, SERVER_BOOT_MS);

afterAll(() => {
  for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
  try { proc?.kill(); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

/** The env the app starts one worker on, per engine. `opencode` gets only the
 *  browser identity (`AGENTGLASS_BROWSER_AS`); `claude` only the variable the
 *  CLI has always read (`AGENTGLASS_PROFILE`). Neither carries a --as or a
 *  profile flag. */
function workerEnv(engine: "opencode" | "claude"): Record<string, string> {
  const scratch = join(dir, engine);
  const shapes: Record<string, string> = engine === "opencode"
    ? { AGENTGLASS_BROWSER_AS: WORKER }
    : { AGENTGLASS_PROFILE: WORKER };
  return {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
    XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: scratch, XDG_CACHE_HOME: scratch,
    AGENTGLASS_STATE_DIR: join(scratch, "state"),
    AGENTGLASS_BROWSER_STATE_DIR: join(scratch, "bstate"),
    AGENTGLASS_SERVER: base,
    AGENTGLASS_TOKEN: token,
    AGENTGLASS_WORKER_TOKEN: token,
    AGENTGLASS_ROLE: "builder",
    AGENTGLASS_AGENT_NAME: WORKER,
    ...shapes,
  };
}

describe.skipIf(!PY)("a worker drives the browser with no --as at all", () => {
  for (const engine of ["opencode", "claude"] as const) {
    test(`${engine}: open, observe, click, fill, shot and close`, async () => {
      const env = workerEnv(engine);
      /* Async on purpose: `spawnSync` blocks this process's event loop, and the
         stub window lives on it — a synchronous run starved the socket and the
         ask was answered by nobody. */
      const run = async (...args: string[]) => {
        const p = Bun.spawn({ cmd: [PY!, CLI, ...args], env, stdout: "pipe", stderr: "pipe" });
        const [, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        return { code: await p.exited, err };
      };
      const first = await run("open", "https://example.test/");
      expect({ open: first.code, err: first.err }).toEqual({ open: 0, err: "" });
      /* The body the CLI built for itself: the name the credential carries,
         not the one derived from the directory. */
      const opened = asks.find((a) => a.op === "open")!;
      expect(opened.args.as).toBe(WORKER);
      /* NAMESPACED at the relay's door: the worker's own name would resolve to
         a person's profile of that name if the panel got to see it. */
      expect(opened.args.profile).toBe(agentContainerName(WORKER));

      for (const argv of [
        ["observe"],
        ["click", "e3"],
        ["fill", "--field", "#email=orbit@example.test"],
        ["shot", "--out", join(dir, `${engine}.png`)],
        ["closetab", "t7-orbit"],
      ]) {
        const r = await run(...argv);
        expect({ engine, argv, code: r.code, err: r.err })
          .toEqual({ engine, argv, code: 0, err: "" });
      }
    }, 90_000);
  }

  test("the name is the full 64 characters the credential carries", async () => {
    expect(WORKER.length).toBe(64);
    const p = Bun.spawn({
      cmd: [PY!, CLI, "whoami"], env: workerEnv("opencode"), stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect({ code: await p.exited, err }).toEqual({ code: 0, err: "" });
    expect(out).toContain(WORKER);
  }, 30_000);

  test("tabs names only the pages this worker opened (M2)", async () => {
    const run = async (...args: string[]) => {
      const p = Bun.spawn({ cmd: [PY!, CLI, ...args], env: workerEnv("opencode"), stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out, err };
    };
    await run("open", "https://example.test/");
    const r = await run("tabs");
    expect(r.code).toBe(0);
    expect(r.out).toContain("t7-orbit");
    expect(r.out).not.toContain("t1-personal");
    expect(r.out).not.toContain("t4-other");
  }, 30_000);

  test("whoami works after a remembered tab, and names only this worker's pages (M2)", async () => {
    const env = { ...workerEnv("opencode"), AGENTGLASS_BROWSER_STATE_DIR: join(dir, "m2-state") };
    const run = async (...args: string[]) => {
      const p = Bun.spawn({ cmd: [PY!, CLI, ...args], env, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out, err };
    };
    const opened = await run("open", "https://example.test/");
    expect({ opened: opened.code, err: opened.err }).toEqual({ opened: 0, err: "" });
    const r = await run("whoami");
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(r.out).toContain(WORKER);
    /* The tab it remembers is the one its own mint returned, which is a fresh
       id per mint — what matters is that no other container's tab is named. */
    expect(r.out).toContain("t8-minted");
    expect(r.out).not.toContain("t1-personal");
    expect(r.out).not.toContain("t4-other");
  }, 30_000);

  test("a do that opens its own page and then reads it runs (M3)", async () => {
    const env = { ...workerEnv("opencode"), AGENTGLASS_BROWSER_STATE_DIR: join(dir, "m3-state") };
    const stepsFile = join(dir, "m3-steps.json");
    writeFileSync(stepsFile, JSON.stringify([
      { op: "open", args: { url: "https://example.test/", profile: WORKER } },
      { op: "read", args: {} },
    ]));
    const p = Bun.spawn({
      cmd: [PY!, CLI, "do", "--steps-file", stepsFile], env, stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect({ code: await p.exited, err }).toEqual({ code: 0, err: "" });
    expect(out).toContain("1. open");
    expect(out).toContain("2. read");
    /* The second step is addressed to the tab the first one minted, not to the
       tab in front: an exit code alone would also be 0 from the person's tab. */
    expect(asks.at(-1)!.op).toBe("read");
    expect(asks.at(-1)!.args.page).toBe(mintedIds.at(-1)!);
  }, 30_000);

  test("a do with two mints reads the one it opened last (S3)", async () => {
    const env = { ...workerEnv("opencode"), AGENTGLASS_BROWSER_STATE_DIR: join(dir, "s3-state") };
    const stepsFile = join(dir, "s3-steps.json");
    writeFileSync(stepsFile, JSON.stringify([
      { op: "open", args: { url: "https://example.test/a", profile: WORKER } },
      { op: "open", args: { url: "https://example.test/b", profile: WORKER } },
      { op: "read", args: {} },
    ]));
    const p = Bun.spawn({
      cmd: [PY!, CLI, "do", "--steps-file", stepsFile], env, stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect({ code: await p.exited, err }).toEqual({ code: 0, err: "" });
    expect(out).toContain("3. read");
    expect(asks.at(-1)!.op).toBe("read");
    expect(asks.at(-1)!.args.page).toBe(mintedIds.at(-1)!);
  }, 30_000);

  test("a person's ownerless lane is not a worker's lane (M1)", async () => {
    const post = async (path: string, body: unknown, token: string) => {
      const r = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: base, authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() as any };
    };
    /* The app's own window makes lane hosts; a host registers for the id the
       manager was asked to make, and it needs a live socket of its own. */
    const hostSocket = new WebSocket(base.replace("http", "ws") + `/stream?token=${encodeURIComponent(MACHINE)}`);
    sockets.push(hostSocket);
    await new Promise((r) => hostSocket.addEventListener("open", r));
    hostSocket.send(JSON.stringify({ type: "hello", clientId: "lane-host", browser: true }));
    await Bun.sleep(50);
    const manager = await post("/browser/ready", { manager: true, client: "desk-flow" }, MACHINE);
    expect(manager.status).toBe(200);
    /* Created with no identity at all: the shape the MCP sends, and the
       person's side of the table. */
    const theirs = await post("/browser/lane", { action: "new" }, MACHINE);
    expect(theirs.status).toBe(200);
    const foreign = theirs.body?.value?.lane?.id;
    expect(typeof foreign).toBe("string");

    const list = await post("/browser/lane", { action: "list", as: WORKER }, token);
    expect(list.status).toBe(200);
    expect((list.body.value.lanes as any[]).map((l) => l.id)).not.toContain(foreign);

    const close = await post("/browser/lane", { action: "close", as: WORKER, id: foreign }, token);
    expect(close.body.ok).toBe(false);
    expect(String(close.body.error)).toContain("not opened by this credential");

    const shared = await post("/browser/lane", { action: "new", as: WORKER, shared: true }, token);
    expect(shared.status).toBe(403);

    /* A verb that names the lane is refused at the one door, by name. */
    for (const [path, body] of [
      ["/browser/read", { as: WORKER, lane: foreign, page: "t7-orbit" }],
      ["/browser/open", { as: WORKER, lane: foreign, profile: WORKER, url: "https://example.test/" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await post(path, body, token);
      expect({ path, refused: r.body.ok }).toEqual({ path, refused: false });
      expect(String(r.body.error)).toContain("not opened by this credential");
    }
    /* The person's lane is still there, and the app still sees it. */
    const still = await fetch(base + "/browser/lanes", { headers: { authorization: `Bearer ${MACHINE}`, Origin: base } });
    expect(((await still.json()) as any).lanes.map((l: any) => l.id)).toContain(foreign);

    /* The worker's own lane is listed and closable: ownership is recorded at
       creation from the credential, not from the body. */
    const own = await post("/browser/lane", { action: "new", as: WORKER }, token);
    expect(own.status).toBe(200);
    const mine = own.body?.value?.lane;
    expect(mine.as).toBe(WORKER);
    const mineList = await post("/browser/lane", { action: "list", as: WORKER }, token);
    expect((mineList.body.value.lanes as any[]).map((l) => l.id)).toEqual([mine.id]);
    expect((await post("/browser/lane", { action: "close", as: WORKER, id: mine.id }, token)).body.ok).toBe(true);
  }, 30_000);

  test("--page is allowed and the relay serves only this worker's own (S2)", async () => {
    const env = { ...workerEnv("opencode"), AGENTGLASS_BROWSER_STATE_DIR: join(dir, "m4-state") };
    const run = async (...args: string[]) => {
      const p = Bun.spawn({ cmd: [PY!, CLI, ...args], env, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out, err };
    };
    expect((await run("open", "https://example.test/")).code).toBe(0);
    const mine = await run("read", "--page", "t7-orbit");
    expect({ code: mine.code, err: mine.err }).toEqual({ code: 0, err: "" });
    const theirs = await run("read", "--page", "t1-personal");
    expect(theirs.code).not.toBe(0);
    expect(theirs.err).toContain("minted for an agent");
  }, 30_000);

  test("a worker's body with no identity is refused at the relay (S3)", async () => {
    const r = await fetch(base + "/browser/tabs", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base, authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(403);
    expect(String(((await r.json()) as any).error)).toContain("names no identity");
  }, 15_000);

  test("a worker socket cannot claim the person's window id (S4)", async () => {
    const peer = new WebSocket(base.replace("http", "ws") + `/stream?token=${encodeURIComponent(token)}`);
    sockets.push(peer);
    await new Promise((r) => peer.addEventListener("open", r));
    peer.send(JSON.stringify({ type: "hello", clientId: "desk-flow", browser: true }));
    await Bun.sleep(100);
    const before = asks.length;
    void fetch(base + "/browser/tabs", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base, authorization: `Bearer ${MACHINE}` },
      body: JSON.stringify({}),
    }).catch(() => undefined);
    for (let i = 0; i < 40 && !asks.slice(before).some((a) => a.op === "tabs"); i++) await Bun.sleep(50);
    expect(asks.slice(before).some((a) => a.op === "tabs")).toBe(true);
  }, 15_000);

  test("closetab of a foreign tab is refused before the window sees it (M1)", async () => {
    const before = asks.length;
    const p = Bun.spawn({
      cmd: [PY!, CLI, "closetab", "t1-personal"], env: workerEnv("opencode"), stdout: "pipe", stderr: "pipe",
    });
    const err = await new Response(p.stderr).text();
    expect(await p.exited).not.toBe(0);
    expect(err).toContain("minted for an agent");
    expect(asks.slice(before).filter((a) => a.op === "closetab")).toEqual([]);
  }, 30_000);

  test("a different --as is refused with the name the credential carries", () => {
    const r = Bun.spawnSync({
      cmd: [PY!, CLI, "--as", "orbit-two", "read"],
      env: { ...workerEnv("opencode"), AGENTGLASS_SERVER: "http://127.0.0.1:9" },
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain(WORKER);
    expect(r.stderr.toString()).toContain("Drop --as");
  });
});
