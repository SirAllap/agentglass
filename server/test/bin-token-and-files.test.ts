/*
 * The three Python CLIs and what they do with a token and a file.
 *
 *   - a Bearer token went to whatever AGENTGLASS_SERVER named, plain http to a
 *     remote host included — every hop read it. Now: https anywhere, http only
 *     to this machine, one line on stderr and exit 2 otherwise;
 *   - `session save`, `har`, `save` and every `--out` wrote through
 *     `open(path, "w")` and took the umask — cookies readable by every account
 *     on the machine. Now created 0600;
 *   - the MCP docstring said there was no "run this JavaScript" tool while
 *     browser_eval, browser_cdp, browser_addInitScript and browser_expose sat
 *     in its tool list; and browser_settings let a model switch certificate
 *     checking off. The docstring names the four; the field is gone and refused.
 *
 * Nothing here talks to a server: the URL check runs before a request is built,
 * and the writers are exercised with `call` replaced in the loaded module.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HAVE_PY = !!Bun.which("python3");
const BIN = (name: string) => new URL(`../../bin/${name}`, import.meta.url).pathname;
const CLIS = ["agentglass-agent", "agentglass-browser", "agentglass-browser-mcp"];

/** Load a CLI as a module without running its main: the same trick the MCP
 *  suite uses, `__name__` set to something other than `__main__`. */
function probe(file: string, body: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const src = `
import json, os, sys
ns = {"__name__": "probe"}
exec(compile(open(${JSON.stringify(file)}).read(), ${JSON.stringify(file)}, "exec"), ns)
${body}
`;
  const p = Bun.spawnSync(["python3", "-c", src], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe.skipIf(!HAVE_PY)("where the token may go", () => {
  test("plain http to a remote host is refused by all three, in one line, before any request", () => {
    for (const cli of CLIS) {
      for (const url of ["http://10.0.0.5:4000", "http://agentglass.example.invalid", "http://192.168.1.20:4000"]) {
        const r = probe(BIN(cli), "print('loaded')", { AGENTGLASS_SERVER: url });
        expect(r.code, `${cli} ${url}`).toBe(2);
        expect(r.out, `${cli} ${url} must not get as far as loading`).not.toContain("loaded");
        expect(r.err.trim().split("\n"), `${cli} ${url}: one line`).toHaveLength(1);
        expect(r.err).toContain("in the clear");
      }
    }
  });

  test("http to this machine and https anywhere are fine", () => {
    for (const cli of CLIS) {
      for (const url of ["http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000", "http://127.0.0.2:4000", "https://agentglass.example.invalid", "https://10.0.0.5:4000"]) {
        const r = probe(BIN(cli), "print(ns['SERVER'])", { AGENTGLASS_SERVER: url });
        expect(r.code, `${cli} ${url}: ${r.err}`).toBe(0);
        expect(r.out.trim()).toBe(url);
      }
    }
  });

  test("a scheme that is neither is refused too — file:// or a bare host is not a server", () => {
    for (const url of ["ftp://localhost", "localhost:4000", "file:///etc/passwd"]) {
      const r = probe(BIN("agentglass-agent"), "print('loaded')", { AGENTGLASS_SERVER: url });
      expect(r.code, url).toBe(2);
      expect(r.err).toContain("AGENTGLASS_SERVER must be");
    }
  });
});

describe.skipIf(!HAVE_PY)("files that may hold session material", () => {
  test("session save writes cookies and storage 0600, even over a file that was wider", () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-bin-files-"));
    try {
      const out = join(dir, "state.json");
      const r = probe(BIN("agentglass-browser"), `
# A file that already exists, world-readable: O_CREAT's mode alone would leave it so.
open(${JSON.stringify(out)}, "w").write("old"); os.chmod(${JSON.stringify(out)}, 0o644)
# Cookies come back through CDP (Network.getCookies), storage through eval.
answers = {
  "cdp": {"ok": True, "value": {"result": {"cookies": [{"name": "sid", "value": "secret-cookie"}]}}},
  "eval": {"ok": True, "value": {"value": {"origin": "https://app.example.invalid", "localStorage": {"token": "secret-token"}, "sessionStorage": {}}}},
}
ns["call"] = lambda op, body=None, *a, **k: answers.get(op, {"ok": True, "value": {}})
code = ns["session_save"](${JSON.stringify(out)})
print(json.dumps({"code": code, "mode": oct(os.stat(${JSON.stringify(out)}).st_mode & 0o777)}))
`);
      expect(r.code, r.err).toBe(0);
      const last = JSON.parse(r.out.trim().split("\n").pop()!) as { code: number; mode: string };
      expect(last.code).toBe(0);
      expect(last.mode).toBe("0o600");
      expect((statSync(out).mode & 0o777).toString(8)).toBe("600");
      expect(readFileSync(out, "utf8")).toContain("secret-cookie");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the private writer is what har, save and --out go through — no plain open(path, 'w') is left on that material", () => {
    const cli = readFileSync(BIN("agentglass-browser"), "utf8");
    const har = cli.slice(cli.indexOf('if a.cmd == "har" and a.out:'), cli.indexOf('if a.cmd == "pdf":'));
    expect(har).toContain("_write_private(a.out");
    const save = cli.slice(cli.indexOf('if a.cmd == "save":'), cli.indexOf('if a.cmd == "har" and a.out:'));
    expect(save).toContain("_write_private(a.out");
    // Every `--out` dump of a verb's answer: `storage --out` and `cookies --out`
    // are session material by definition.
    expect(cli.match(/_write_private\(a\.outFile/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(cli).not.toMatch(/with open\(a\.outFile, "w"\)/);
    expect(cli).not.toMatch(/with open\(path, "w"\)/);
    const r = probe(BIN("agentglass-browser"), `
d = ${JSON.stringify(tmpdir())}
import tempfile
p = tempfile.mktemp(dir=d, prefix="agx-priv-")
ns["_write_private"](p, "x")
print(oct(os.stat(p).st_mode & 0o777)); os.unlink(p)
`);
    expect(r.out.trim()).toBe("0o600");
  });
});

describe.skipIf(!HAVE_PY)("what the MCP says about itself, and what it will not do", () => {
  const mcp = readFileSync(BIN("agentglass-browser-mcp"), "utf8");
  const docstring = mcp.slice(mcp.indexOf('"""') + 3, mcp.indexOf('"""', mcp.indexOf('"""') + 3));

  test("the docstring names the four acting tools and no longer denies them", () => {
    for (const tool of ["browser_eval", "browser_cdp", "browser_addInitScript", "browser_expose"]) {
      expect(docstring).toContain(tool);
    }
    expect(docstring).not.toMatch(/There is no "run this JavaScript" tool/);
  });

  test("ignoreCertErrors is out of the settings schema and refused by the handler", () => {
    const r = probe(BIN("agentglass-browser-mcp"), `
tools = {t["name"]: t for t in ns["TOOLS"]}
props = tools["browser_settings"]["inputSchema"]["properties"]
ns["call"] = lambda *a, **k: {"ok": True, "value": {}}
refused = ns["run"]("browser_settings", {"action": "set", "ignoreCertErrors": True})
allowed = ns["run"]("browser_settings", {"action": "get"})
print(json.dumps({"props": sorted(props), "refused": refused, "allowed_is_error": bool(allowed.get("isError"))}))
`);
    expect(r.code, r.err).toBe(0);
    const got = JSON.parse(r.out.trim().split("\n").pop()!) as { props: string[]; refused: { isError?: boolean; content: { text: string }[] }; allowed_is_error: boolean };
    expect(got.props).not.toContain("ignoreCertErrors");
    expect(got.refused.isError).toBe(true);
    expect(got.refused.content[0]!.text).toContain("ignoreCertErrors is not available");
    expect(got.allowed_is_error).toBe(false);
  });

  test("the CLI keeps the switch — it is a person's decision at a command line", () => {
    expect(readFileSync(BIN("agentglass-browser"), "utf8")).toContain("ignoreCertErrors");
  });
});
