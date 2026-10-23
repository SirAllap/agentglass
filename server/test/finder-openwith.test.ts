/*
 * Open With: the applications a file type has, found in desktop entries, and the
 * argv one of them is started with. Everything here runs in a temporary XDG tree
 * with stub programs; no real application is listed from or launched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appsFor, expandExec, launchApp, parseDesktop, setDefaultApp, splitExec } from "../src/openwith.ts";

const base = mkdtempSync(join(tmpdir(), "agx-openwith-"));
const data = join(base, "share"), cfg = join(base, "cfg"), bin = join(base, "bin"), home = join(base, "home");
const saved = { HOME: process.env.HOME, R: process.env.AGENTGLASS_DISK_ROOTS, D: process.env.XDG_DATA_DIRS, H: process.env.XDG_DATA_HOME, C: process.env.XDG_CONFIG_HOME, P: process.env.PATH };
const entry = (id: string, body: string) => { mkdirSync(join(data, "applications"), { recursive: true }); writeFileSync(join(data, "applications", id), `[Desktop Entry]\nType=Application\n${body}\n`); };

beforeAll(() => {
  for (const d of [data, cfg, bin, home]) mkdirSync(d, { recursive: true });
  process.env.HOME = home; process.env.AGENTGLASS_DISK_ROOTS = "";
  process.env.XDG_DATA_DIRS = data; process.env.XDG_DATA_HOME = join(base, "nodata"); process.env.XDG_CONFIG_HOME = cfg;
  process.env.PATH = `${bin}:${saved.P}`;
  const stub = (n: string) => { const p = join(bin, n); writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > "${base}/ran-${n}"\n`); chmodSync(p, 0o755); };
  stub("writer"); stub("viewer"); stub("pager");
  entry("writer.desktop", "Name=Orbit Writer\nComment=Write notes\nExec=writer --new-window %F\nMimeType=text/markdown;text/plain;");
  entry("viewer.desktop", "Name=Orbit Viewer\nExec=viewer %u\nMimeType=text/markdown;");
  entry("pager.desktop", "Name=Orbit Pager\nExec=pager %f\nMimeType=application/pdf;");
  entry("hidden.desktop", "Name=Hidden One\nExec=writer %f\nNoDisplay=true\nMimeType=text/markdown;");
  entry("gone.desktop", "Name=Gone\nExec=writer %f\nTryExec=/no/such/program\nMimeType=text/markdown;");
});
afterAll(() => {
  for (const [k, v] of [["HOME", saved.HOME], ["AGENTGLASS_DISK_ROOTS", saved.R], ["XDG_DATA_DIRS", saved.D], ["XDG_DATA_HOME", saved.H], ["XDG_CONFIG_HOME", saved.C], ["PATH", saved.P]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(base, { recursive: true, force: true });
});

describe("a desktop entry", () => {
  test("name, comment, exec and types are read from the Desktop Entry group only", () => {
    const e = parseDesktop("a.desktop", "[Desktop Entry]\nType=Application\nName=A\nName[es]=Ah\nExec=a %f\nMimeType=x/y;z/w;\n[Desktop Action new]\nName=Other\nExec=nope\n");
    expect(e).toMatchObject({ id: "a.desktop", name: "A", exec: "a %f", mimeTypes: ["x/y", "z/w"], shown: true });
  });
  test("NoDisplay, Hidden and a missing Exec are not offered", () => {
    expect(parseDesktop("a.desktop", "[Desktop Entry]\nType=Application\nName=A\nExec=a\nNoDisplay=true")!.shown).toBe(false);
    expect(parseDesktop("a.desktop", "[Desktop Entry]\nType=Application\nName=A\nExec=a\nHidden=true")!.shown).toBe(false);
    expect(parseDesktop("a.desktop", "[Desktop Entry]\nType=Application\nName=A")).toBeNull();
    expect(parseDesktop("a.desktop", "[Desktop Entry]\nType=Link\nName=A\nExec=a")).toBeNull();
  });
});

describe("the list for a file type", () => {
  test("those that handle the type come first as recommended, the rest as other; hidden and uninstalled never show", () => {
    const r = appsFor("text/markdown");
    expect(r.recommended.map((a) => a.id).sort()).toEqual(["viewer.desktop", "writer.desktop"]);
    expect(r.other.map((a) => a.id)).toEqual(["pager.desktop"]);
    expect([...r.recommended, ...r.other].some((a) => a.id === "hidden.desktop" || a.id === "gone.desktop")).toBe(false);
  });
  test("the default from mimeapps.list leads the recommended ones", () => {
    writeFileSync(join(cfg, "mimeapps.list"), "[Default Applications]\ntext/markdown=viewer.desktop;\n");
    expect(appsFor("text/markdown").recommended[0]!.id).toBe("viewer.desktop");
    expect(appsFor("text/markdown").defaultId).toBe("viewer.desktop");
    rmSync(join(cfg, "mimeapps.list"));
  });
  test("what is sent to the page carries no command line", () => {
    expect(JSON.stringify(appsFor("text/markdown"))).not.toContain("--new-window");
  });
});

describe("the command an entry becomes", () => {
  test("Exec is split by the desktop spec's quoting, never by a shell", () => {
    expect(splitExec(`a "b c" 'd' e\\\\f`)).toEqual(["a", "b c", "'d'", "e\\f"]);
  });
  test("%F is every file, %f the first, %u and %U are file:// addresses, %% is a percent, the rest vanish", () => {
    const files = ["/h/a b.md", "/h/-rf"];
    expect(expandExec(["w", "%F"], files, "Name", "i")).toEqual(["w", "/h/a b.md", "/h/-rf"]);
    expect(expandExec(["w", "%f"], files, "Name", "i")).toEqual(["w", "/h/a b.md"]);
    expect(expandExec(["w", "%U"], files, "Name", "i")).toEqual(["w", "file:///h/a%20b.md", "file:///h/-rf"]);
    expect(expandExec(["w", "100%%", "%i", "%c", "%k", "%d"], files, "Name", "icon")).toEqual(["w", "100%", "--icon", "icon", "Name"]);
  });
  test("an entry with no field code is started as written: the spec passes it no files", () => {
    expect(expandExec(["w", "--flag"], ["/h/a"], "N", "")).toEqual(["w", "--flag"]);
  });
});

describe("launching", () => {
  const file = () => { const p = join(home, "a b.md"); writeFileSync(p, "x"); return p; };
  const ranFile = (n: string) => join(base, `ran-${n}`);
  const waitFor = async (p: string) => { for (let i = 0; i < 100 && !existsSync(p); i++) await Bun.sleep(20); return existsSync(p) ? readFileSync(p, "utf8") : null; };

  test("the entry chosen by id starts with the files as separate arguments, after its own", async () => {
    const f = file();
    expect(await launchApp("writer.desktop", [f], { local: true }))
      .toEqual({ ok: true });
    expect(await waitFor(ranFile("writer"))).toBe(`--new-window\n${f}\n`);
  });
  test("a name that starts with a dash stays one argument and the program is not found by that name", async () => {
    const f = join(home, "-rf"); writeFileSync(f, "x");
    rmSync(ranFile("writer"), { force: true });
    await launchApp("writer.desktop", [f], { local: true });
    expect(await waitFor(ranFile("writer"))).toBe(`--new-window\n${f}\n`);
  });
  test("an id that is not an installed entry is refused and nothing starts; the caller never supplies a command", async () => {
    for (const bad of ["../../bin/sh", "nope.desktop", "writer", "", "a/b.desktop"]) expect((await launchApp(bad, [file()], { local: true })).ok).toBe(false);
  });
  test("a file is chosen by the same boundary as the rest of the finder", async () => {
    const r = await launchApp("writer.desktop", ["/etc/passwd"], { local: true });
    expect(r.ok).toBe(false);
  });
  test("always use writes the default through xdg-mime for that type and entry only", async () => {
    const calls: string[][] = [];
    expect(await setDefaultApp("viewer.desktop", "text/markdown", async (a) => { calls.push(a); return { code: 0, out: "", err: "" }; })).toEqual({ ok: true });
    expect(calls).toEqual([["xdg-mime", "default", "viewer.desktop", "text/markdown"]]);
    expect((await setDefaultApp("viewer.desktop", "not a type; rm", async () => ({ code: 0, out: "", err: "" }))).ok).toBe(false);
    expect((await setDefaultApp("nope.desktop", "text/markdown", async () => ({ code: 0, out: "", err: "" }))).ok).toBe(false);
  });
});
