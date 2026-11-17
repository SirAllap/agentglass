import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle, issueUrl, safeSettingNames, tailScrubbed, ISSUE_URL_MAX, KNOWN_SETTING_KEYS } from "../../shared/reportBundle.ts";
import { redactText } from "../../shared/scrub.ts";
import { readTail } from "../src/tailRead.ts";

const TOKEN = "ghp_" + "AbCdEf0123456789AbCdEf01";
describe("report bundle", () => {
  const text = buildBundle({
    version: "1.2.3", commit: "abc1234", os: "linux", arch: "x64", bun: "1.3.0", electron: "33.0.0",
    stallLog: `x\n2026 stall in /home/ada/code/orbit/a.ts token=${TOKEN}\n`,
    errorLog: "boom at /Users/ada/secret/file.ts",
    enabledSettings: ["reduceMotion", "has space", "x".repeat(200), "apiKey"],
  });
  test("fake home path and token are gone", () => {
    expect(text).not.toContain("/home/ada");
    expect(text).not.toContain("/Users/ada");
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("version: 1.2.3");
  });
  test("keeps only the last 50 lines", () => {
    const log = Array.from({ length: 80 }, (_, i) => `line${i}`).join("\n");
    const out = tailScrubbed(log).split("\n");
    expect(out.length).toBe(50);
    expect(out[0]).toBe("line30");
  });
  test("setting names are filtered to plain identifiers", () => {
    const [a, b] = KNOWN_SETTING_KEYS;
    expect(safeSettingNames([b!, a!, a!, "no way", "k=v"])).toEqual([a!, b!].sort());
  });
  test("a key not on the allowlist is dropped, even a plain identifier or an agx- prefix", () => {
    expect(safeSettingNames(["agx.collapsed.my-private-repo", "reduceMotion", "agentglass.collapsed.orbit"])).toEqual([]);
  });
  test("issue url stays under 2000 chars even with huge input", () => {
    const u = issueUrl("acme/orbit", { version: "v".repeat(5000), commit: "c".repeat(5000), os: "linux" });
    expect(u.length).toBeLessThan(ISSUE_URL_MAX);
    expect(u.startsWith("https://github.com/acme/orbit/issues/new?title=")).toBe(true);
    expect(u).not.toContain("stall");
  });

  test("home paths with spaces, bare home dirs and ~/ are scrubbed", () => {
    const out = redactText("open /home/ada/My Project/a.ts failed; also /home/ada and ~/code/orbit and /Users/bob/Odd Dir/x");
    expect(out).not.toContain("Project");
    expect(out).not.toContain("ada");
    expect(out).not.toContain("orbit");
    expect(out).not.toContain("bob");
    expect(out).not.toContain("Odd");
  });
  test("a home path stops at the next quote", () => {
    expect(redactText(`cwd "/home/ada/My Project" ok`)).toContain(`" ok`);
  });
  test("emails, IPv4, IPv6 and query-string URLs are scrubbed", () => {
    const out = redactText("ada@example.org from 10.1.2.3 and fe80::1ff:fe23:4567:890a and 2001:db8::7 via https://example.org/p?user=ada&x=1");
    for (const bad of ["ada@", "10.1.2.3", "fe80", "2001:db8", "user=ada"]) expect(out).not.toContain(bad);
  });
  test("a bare ghp_ token is caught by its own rule", () => {
    expect(redactText(`leaked ${TOKEN} here`)).not.toContain(TOKEN);
  });
  test("a keyword rule catches a non-ghp secret", () => {
    expect(redactText("password=hunter2hunter2hunter2")).not.toContain("hunter2");
  });
  // Keys are assembled at runtime so a secret scanner on the public repo does not flag them.
  test("a multi-line private key is scrubbed across lines", () => {
    const pem = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ") + "\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf\nshort/body+line\n" + ["-----END", "RSA PRIVATE KEY-----"].join(" ");
    const out = tailScrubbed(`before\n${pem}\nafter`);
    expect(out).not.toContain("MIIB");
    expect(out).not.toContain("short/body");
    expect(out).toContain("after");
  });
  test("a secret wrapped over two lines is scrubbed before the split", () => {
    const out = tailScrubbed(`password:\n  ${"Zq9".repeat(6)}\nnext`);
    expect(out).not.toContain("Zq9Zq9");
  });
  test("readTail reads only the last 64 KB and drops the cut line", () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-"));
    const f = join(dir, "big.log");
    writeFileSync(f, "HEAD-MARKER\n" + "x".repeat(10) + "\n" + "y".repeat(200_000) + "\nlast line\n");
    const t = readTail(f);
    expect(t.length).toBeLessThanOrEqual(64 * 1024);
    expect(t).not.toContain("HEAD-MARKER");
    expect(t.endsWith("last line\n")).toBe(true);
    expect(readTail(join(dir, "missing"))).toBe("");
  });
  const body = (n: number) => Array.from({ length: n }, (_, k) => `${"Qk3x9/Lm+".repeat(7).slice(0, 63)}${"abcdefgh"[k % 8]}`);
  test("a key body whose BEGIN line fell outside the window is dropped", () => {
    const out = tailScrubbed([...body(20), "-----END PRIVATE KEY-----", "server ready"].join("\n"));
    expect(out).not.toContain("Qk3x9");
    expect(out).toContain("server ready");
  });
  test("a key longer than 200 lines is scrubbed before the 200-line slice", () => {
    const text = [["-----BEGIN", "PRIVATE KEY-----"].join(" "), ...body(300), ["-----END", "PRIVATE KEY-----"].join(" "), "after"].join("\n");
    const out = tailScrubbed(text, 200);
    expect(out).not.toContain("Qk3x9");
    expect(out).toContain("after");
  });
  test("readTail then tailScrubbed: a key cut by the 64 KB window leaks nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-"));
    const f = join(dir, "k.log");
    writeFileSync(f, "x".repeat(70_000) + "\n-----BEGIN PRIVATE KEY-----\n" + body(2000).join("\n") + "\n-----END PRIVATE KEY-----\nok\n");
    const out = tailScrubbed(readTail(f), 200);
    expect(out).not.toContain("Qk3x9");
  });
});
