/*
 * The person's own actions in the finder's menu: scripts and commands they define,
 * run on the selection. They are programs with the person's own permissions, so
 * the rules here are about WHO may start one (only the desk key), that nothing is
 * ever handed to a shell, and that what they define is judged strictly before it
 * is stored or run. Every run is a stub script in a temporary HOME.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetJournalForTest, listJobs, settle } from "../src/fsops.ts";
import { actionsDir, deleteAction, listActions, matchesSelection, parseManifest, runAction, saveAction, type Selected } from "../src/finderactions.ts";

const saved = { HOME: process.env.HOME, C: process.env.XDG_CONFIG_HOME, R: process.env.AGENTGLASS_DISK_ROOTS, P: process.env.PATH };
const base = mkdtempSync(join(tmpdir(), "agx-actions-"));
const home = join(base, "home"), bin = join(base, "bin"), work = join(home, "work");
beforeAll(() => {
  for (const d of [home, bin, work]) mkdirSync(d, { recursive: true });
  process.env.HOME = home; process.env.XDG_CONFIG_HOME = join(base, "cfg"); process.env.AGENTGLASS_DISK_ROOTS = "";
  process.env.PATH = `${bin}:${saved.P}`;
  // A stub program that records its argv one per line, and its working directory.
  writeFileSync(join(bin, "recorder"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${base}/argv"\npwd > "${base}/cwd"\n`);
  chmodSync(join(bin, "recorder"), 0o755);
});
afterAll(() => {
  for (const [k, v] of [["HOME", saved.HOME], ["XDG_CONFIG_HOME", saved.C], ["AGENTGLASS_DISK_ROOTS", saved.R], ["PATH", saved.P]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(base, { recursive: true, force: true });
});
beforeEach(() => { rmSync(actionsDir(), { recursive: true, force: true }); rmSync(join(base, "argv"), { force: true }); __resetJournalForTest(); });

const file = (name: string, body = "x") => { const p = join(work, name); writeFileSync(p, body); return p; };
const cmd = (over: Record<string, unknown> = {}, run: Record<string, unknown> = {}) => ({
  schema_version: 1, id: "demo", name: "Demo", icon: "play", enabled: true, menu: "submenu",
  when: { kinds: ["file"], extensions: ["txt"] }, run: { runtime: "command", program: "recorder", args: ["--flag", "{paths}"], mode: "whole-selection", on_error: "continue", working_directory: "parent", confirm: false, ...run }, ...over,
});
const toml = (m: ReturnType<typeof cmd>) => {
  const q = (v: unknown): string => Array.isArray(v) ? `[${v.map(q).join(", ")}]` : typeof v === "string" ? JSON.stringify(v) : String(v);
  const top = Object.entries(m).filter(([, v]) => v !== undefined && (typeof v !== "object" || Array.isArray(v))).map(([k, v]) => `${k} = ${q(v)}`).join("\n");
  return `${top}\n[when]\n${Object.entries(m.when).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} = ${q(v)}`).join("\n")}\n[run]\n${Object.entries(m.run).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} = ${q(v)}`).join("\n")}\n`;
};
const waitJob = async (id: string) => { for (let i = 0; i < 200; i++) { const j = listJobs().find((x) => x.id === id); if (j && j.state !== "running") return j; await Bun.sleep(25); } throw new Error("the job did not finish"); };
const argv = () => readFileSync(join(base, "argv"), "utf8").split("\n").slice(0, -1);

describe("what a definition may say", () => {
  test("a good one is read back as written", () => {
    const r = parseManifest("demo", toml(cmd()));
    expect(r.ok && r.action).toMatchObject({ id: "demo", name: "Demo", menu: "submenu", run: { runtime: "command", program: "recorder", args: ["--flag", "{paths}"], mode: "whole-selection" } });
  });
  test("strict: an unknown key, a newer version, a bad id, a path in the entrypoint, a long name are all refused with a reason", () => {
    const bad = (m: unknown) => { const r = parseManifest("demo", typeof m === "string" ? m : toml(m as never)); expect(r.ok).toBe(false); return r.ok ? "" : r.error; };
    expect(bad(toml(cmd({ extra: 1 })))).toContain("extra");
    expect(bad(toml(cmd({ schema_version: 2 })))).toContain("version");
    expect(parseManifest("Bad Id", toml(cmd({ id: "Bad Id" }))).ok).toBe(false);
    expect(parseManifest("other", toml(cmd())).ok).toBe(false); // the id is the directory's name
    expect(bad(toml(cmd({}, { runtime: "bash", program: undefined, args: undefined, entrypoint: "../run.sh" } as never)))).toContain("entrypoint");
    expect(bad(toml(cmd({ name: "x".repeat(65) })))).toContain("name");
  });
  test("an argument token must be the whole argument and must fit the mode, so nothing is ever interpolated", () => {
    expect(parseManifest("demo", toml(cmd({}, { args: ["prefix-{path}"], mode: "per-item" }))).ok).toBe(false);
    expect(parseManifest("demo", toml(cmd({}, { args: ["{path}"], mode: "whole-selection" }))).ok).toBe(false);
    expect(parseManifest("demo", toml(cmd({}, { args: ["{paths}"], mode: "per-item" }))).ok).toBe(false);
    expect(parseManifest("demo", toml(cmd({}, { args: ["{path}"], mode: "per-item" }))).ok).toBe(true);
  });
});

describe("which selections it is offered for", () => {
  const a = parseManifest("demo", toml(cmd({ when: { kinds: ["file"], extensions: ["txt", "md"], min_items: 1, max_items: 2 } }))).ok ? (parseManifest("demo", toml(cmd({ when: { kinds: ["file"], extensions: ["txt", "md"], min_items: 1, max_items: 2 } }))) as { ok: true; action: never }).action : null!;
  const f = (name: string, kind: "file" | "folder" = "file"): Selected => ({ name, kind });
  test("every entry must satisfy it, and the count must be in range", () => {
    expect(matchesSelection(a, [f("a.txt"), f("b.MD")])).toBe(true);
    expect(matchesSelection(a, [f("a.txt"), f("b.png")])).toBe(false);
    expect(matchesSelection(a, [f("a.txt", "folder")])).toBe(false);
    expect(matchesSelection(a, [f("a.txt"), f("b.txt"), f("c.txt")])).toBe(false);
    expect(matchesSelection(a, [])).toBe(false);
  });
  test("a mime filter uses the guessed type of each entry", () => {
    const m = (parseManifest("demo", toml(cmd({ when: { mime_types: ["image/*"] } }))) as { ok: true; action: never }).action;
    expect(matchesSelection(m, [{ name: "p", kind: "file", mime: "image/png" }])).toBe(true);
    expect(matchesSelection(m, [{ name: "p", kind: "file", mime: "text/plain" }])).toBe(false);
  });
});

describe("storing them", () => {
  test("saved owner-only, listed, and a second create of the same id never replaces the first", () => {
    expect(saveAction({ manifest: toml(cmd()) }, { create: true }).ok).toBe(true);
    const dir = join(actionsDir(), "demo");
    expect(lstatSync(dir).mode & 0o077).toBe(0);
    expect(lstatSync(join(dir, "action.toml")).mode & 0o077).toBe(0);
    expect(listActions().actions.map((x) => x.id)).toEqual(["demo"]);
    const again = saveAction({ manifest: toml(cmd({ name: "Other" })) }, { create: true });
    expect(again.ok).toBe(false);
    expect(listActions().actions[0]!.name).toBe("Demo");
  });
  test("an edit keeps the id, and a script is written beside the manifest", () => {
    const m = cmd({ id: "sh" }, { runtime: "bash", program: undefined, args: undefined, entrypoint: "run.sh" } as never);
    expect(saveAction({ manifest: toml(m as never), script: "#!/bin/bash\necho hi\n" }, { create: true }).ok).toBe(true);
    expect(readFileSync(join(actionsDir(), "sh", "run.sh"), "utf8")).toContain("echo hi");
    expect(saveAction({ manifest: toml({ ...m, name: "Renamed" } as never), script: "#!/bin/bash\necho bye\n" }, { create: false }).ok).toBe(true);
    expect(listActions().actions[0]!.name).toBe("Renamed");
  });
  test("a broken definition shows up as a problem with its reason and never as an action; a linked folder is refused", () => {
    mkdirSync(join(actionsDir(), "broken"), { recursive: true });
    writeFileSync(join(actionsDir(), "broken", "action.toml"), 'schema_version = 1\nid = "broken"\nname = "B"\nbogus = 1\n');
    const real = join(base, "elsewhere"); mkdirSync(real);
    writeFileSync(join(real, "action.toml"), toml(cmd({ id: "linked" })));
    symlinkSync(real, join(actionsDir(), "linked"));
    const l = listActions();
    expect(l.actions).toEqual([]);
    expect(l.problems.map((p) => p.id).sort()).toEqual(["broken", "linked"]);
  });
  test("delete removes the folder and only a valid id is accepted", () => {
    saveAction({ manifest: toml(cmd()) }, { create: true });
    expect(deleteAction("../demo").ok).toBe(false);
    expect(deleteAction("demo").ok).toBe(true);
    expect(existsSync(join(actionsDir(), "demo"))).toBe(false);
  });
});

describe("running one", () => {
  const ready = () => saveAction({ manifest: toml(cmd()) }, { create: true });

  test("without the desk key nothing runs, whatever the action is", async () => {
    ready();
    const r = await runAction("demo", [file("a.txt")], "selection", { local: true, deskProven: false });
    expect(r.ok).toBe(false);
    await Bun.sleep(100);
    expect(existsSync(join(base, "argv"))).toBe(false);
    expect(listJobs()).toEqual([]);
  });

  test("a whole-selection command gets every path as its own argument, in place of the token", async () => {
    ready();
    const a = file("a b.txt"), b = file("-rf.txt");
    const r = await runAction("demo", [a, b], "selection", { local: true, deskProven: true });
    expect(r.ok).toBe(true);
    const j = await waitJob((r as { job: { id: string } }).job.id);
    expect(j.state).toBe("done");
    expect(argv()).toEqual(["--flag", a, b]);
  });

  test("a name made of shell syntax is one argument and nothing else happens", async () => {
    ready();
    const evil = file("$(touch pwned);x.txt");
    const r = await runAction("demo", [evil], "selection", { local: true, deskProven: true });
    await waitJob((r as { job: { id: string } }).job.id);
    expect(argv()).toEqual(["--flag", evil]);
    expect(existsSync(join(work, "pwned"))).toBe(false);
  });

  test("with no token in the arguments the selection follows `--`", async () => {
    saveAction({ manifest: toml(cmd({}, { args: ["--flag"] })) }, { create: true });
    const a = file("a.txt");
    const r = await runAction("demo", [a], "selection", { local: true, deskProven: true });
    await waitJob((r as { job: { id: string } }).job.id);
    expect(argv()).toEqual(["--flag", "--", a]);
  });

  test("per-item runs once per path in order and `stop` ends the job at the first failure", async () => {
    writeFileSync(join(bin, "flaky"), `#!/bin/sh\necho "$1" >> "${base}/seen"\n[ "$(basename "$1")" = "b.txt" ] && exit 3\nexit 0\n`); chmodSync(join(bin, "flaky"), 0o755);
    saveAction({ manifest: toml(cmd({}, { program: "flaky", args: ["{path}"], mode: "per-item", on_error: "stop" })) }, { create: true });
    const [a, b, c] = [file("a.txt"), file("b.txt"), file("c.txt")];
    rmSync(join(base, "seen"), { force: true });
    const r = await runAction("demo", [a, b, c], "selection", { local: true, deskProven: true });
    const j = await waitJob((r as { job: { id: string } }).job.id);
    expect(j.state).toBe("error");
    expect(readFileSync(join(base, "seen"), "utf8").trim().split("\n")).toEqual([a, b]);
  });

  test("an action that asks for confirmation does nothing until it is confirmed", async () => {
    saveAction({ manifest: toml(cmd({}, { confirm: true })) }, { create: true });
    const a = file("a.txt");
    const r = await runAction("demo", [a], "selection", { local: true, deskProven: true });
    expect(r).toMatchObject({ ok: false, confirm: true });
    expect(existsSync(join(base, "argv"))).toBe(false);
    const ok = await runAction("demo", [a], "selection", { local: true, deskProven: true, confirmed: true });
    expect(ok.ok).toBe(true);
    await waitJob((ok as { job: { id: string } }).job.id);
  });

  test("a disabled action, a selection it does not match, or a path outside the boundary does not run", async () => {
    saveAction({ manifest: toml(cmd({ enabled: false })) }, { create: true });
    expect((await runAction("demo", [file("a.txt")], "selection", { local: true, deskProven: true })).ok).toBe(false);
    saveAction({ manifest: toml(cmd()) }, { create: false });
    expect((await runAction("demo", [file("a.png")], "selection", { local: true, deskProven: true })).ok).toBe(false);
    expect((await runAction("demo", ["/etc/passwd"], "selection", { local: true, deskProven: true })).ok).toBe(false);
    expect((await runAction("nope", [file("a.txt")], "selection", { local: true, deskProven: true })).ok).toBe(false);
    await Bun.sleep(80);
    expect(existsSync(join(base, "argv"))).toBe(false);
  });

  test("a bash action reads its paths from the file in its environment, byte-exact, and reports progress and output", async () => {
    const m = cmd({ id: "sh", when: { kinds: ["file"] } }, { runtime: "bash", program: undefined, args: undefined, entrypoint: "run.sh" } as never);
    const script = `#!/bin/bash\ncp "$AGENTGLASS_ACTION_PATHS" "${base}/paths.bin"\necho "$AGENTGLASS_ACTION_COUNT $AGENTGLASS_ACTION_MODE $AGENTGLASS_ACTION_SOURCE"\nprintf '{"event":"progress","processed":1,"total":2}\\n' >> "$AGENTGLASS_ACTION_PROGRESS"\n`;
    expect(saveAction({ manifest: toml(m as never), script }, { create: true }).ok).toBe(true);
    const nl = file("two\nlines.txt");
    const r = await runAction("sh", [nl], "selection", { local: true, deskProven: true });
    const j = await waitJob((r as { job: { id: string } }).job.id);
    expect(j.state).toBe("done");
    expect(readFileSync(join(base, "paths.bin"))).toEqual(Buffer.from(nl + "\0"));
    expect(j.output).toContain("1 whole-selection selection");
  });

  test("the working folder is the parent of the first path by default", async () => {
    ready();
    const r = await runAction("demo", [file("a.txt")], "selection", { local: true, deskProven: true });
    await waitJob((r as { job: { id: string } }).job.id);
    expect(readFileSync(join(base, "cwd"), "utf8").trim()).toBe(work);
  });

  test("cancel stops the running process group", async () => {
    writeFileSync(join(bin, "slow"), `#!/bin/sh\necho started > "${base}/slow-started"\nsleep 30\n`); chmodSync(join(bin, "slow"), 0o755);
    saveAction({ manifest: toml(cmd({}, { program: "slow", args: ["{paths}"] })) }, { create: true });
    const r = await runAction("demo", [file("a.txt")], "selection", { local: true, deskProven: true });
    const id = (r as { job: { id: string } }).job.id;
    for (let i = 0; i < 100 && !existsSync(join(base, "slow-started")); i++) await Bun.sleep(20);
    const { cancelJob } = await import("../src/fsops.ts");
    expect(cancelJob(id)).toBe(true);
    const j = await waitJob(id);
    expect(j.state).toBe("cancelled");
  });
});
void settle;
