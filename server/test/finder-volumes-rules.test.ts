/*
 * Source rules for the server half of DEVICES. The passphrase is written to
 * a tool's stdin and nowhere else: not argv, not env, not a log, not the audit.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/volumes.ts", import.meta.url)).text();
const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const remotes = await Bun.file(new URL("../src/remotes.ts", import.meta.url)).text();
const route = index.slice(index.indexOf('if (pathname.startsWith("/finder/devices/")'), index.indexOf('if (pathname.startsWith("/disk/"))'));

describe("the passphrase on the server", () => {
  test("volumes.ts never prints, and hands the secret to run() only as stdin", () => {
    expect(code(src)).not.toMatch(/console\.|appendFile|writeFile|audit/);
    const unlock = src.slice(src.indexOf('if (act === "unlock")'), src.indexOf('if (act === "lock")'));
    expect(unlock).toContain('"--key-file", "/dev/stdin", ...quiet], passphrase)');
    expect(unlock).not.toMatch(/\["udisksctl"[^\]]*passphrase/);
  });
  test("the route reads it into the call and clears it, with no log or audit between", () => {
    expect(route).toContain("actOnDevice(act, b?.id, b?.passphrase)");
    expect(route).toContain("b = {};");
    expect(code(route)).not.toMatch(/console\.|audit|logLine|note\(/);
  });
  test("every write takes the page gate first and the policy second", () => {
    const i = route.indexOf("trustedCaller(req, from)"), j = route.indexOf("devicePolicy(act"), k = route.indexOf("actOnDevice(");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
    expect(j).toBeLessThan(k);
  });
  test("a tool is found with Bun.which and spawned by that path, never through a shell", () => {
    expect(src).toContain("Bun.which(argv[0]!)");
    expect(code(src)).not.toMatch(/\bsh -c|shell:|execSync|child_process/);
  });
});

describe("remotes", () => {
  test("remotes.ts prints and stores nothing, and a typed value reaches gio only through proc.write", () => {
    expect(code(remotes)).not.toMatch(/console\.|appendFile|writeFile|audit/);
    expect((code(remotes).match(/s\.proc\.write\(/g) ?? []).length).toBe(2); // the two writes in Sessions: a choice and an answer
    expect(code(remotes)).toContain('this.spawn(["gio", "mount", v.uri])');
  });
  test("the answer is never written for a question unless the request carried a choice", () => {
    const q = remotes.slice(remotes.indexOf('if (q?.kind === "question")'), remotes.indexOf('} else if (q?.kind === "prompt")'));
    expect(q).toContain("Number(a.choice)");
    expect(q).toContain("this.end(id); return");
  });
  test("every step of a connection takes the page gate and the policy before the sessions", () => {
    const r = index.slice(index.indexOf('pathname === "/finder/remotes/connect"'), index.indexOf('if (pathname.startsWith("/disk/"))'));
    const i = r.indexOf("trustedCaller(req, from)"), j = r.indexOf("remotePolicy("), k = r.indexOf("remoteSessions.start");
    expect(i).toBeGreaterThan(-1); expect(i).toBeLessThan(j); expect(j).toBeLessThan(k);
    expect(code(r)).not.toMatch(/console\.|audit|note\(/);
  });
});
