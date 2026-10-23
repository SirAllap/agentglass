/*
 * install-local.sh asks sudo for the chrome-sandbox helper only when Chromium
 * would need it.
 *
 * Where user namespaces work, Chromium sandboxes itself with them and never
 * runs the setuid helper, yet every install still ran `sudo -n true`. With a
 * password-protected sudo that fails, and each failure is an "a password is
 * required" line in the system journal: 49 of them in ten days of installs on
 * one machine.
 *
 * Driven for real: the script's own sandbox block runs under bash with `sudo`
 * and `unshare` stubbed on PATH, the sudo stub leaving a mark when called. The
 * AppArmor switch is pointed at a scratch file, so the case does not depend on
 * the machine the test runs on.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = await Bun.file(join(import.meta.dir, "..", "..", "electron", "install-local.sh")).text();
const RESTRICT = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

const root = mkdtempSync(join(tmpdir(), "agx-sandbox-probe-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The block from `sandbox_ok=false` to the end of the warning it may print. */
function block(): string {
  const start = SCRIPT.indexOf("\nsandbox_ok=false\n");
  const warn = SCRIPT.indexOf('if [ "$sandbox_ok" = false ]; then', start);
  const end = SCRIPT.indexOf("\nfi\n", warn);
  expect(start).toBeGreaterThan(-1);
  expect(warn).toBeGreaterThan(start);
  expect(end).toBeGreaterThan(warn);
  return SCRIPT.slice(start, end + 4);
}

let n = 0;
async function run(o: { unshare: boolean; restrict?: string }) {
  const d = join(root, String(n++));
  const bin = join(d, "bin");
  const app = join(d, "app");
  mkdirSync(bin, { recursive: true });
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "chrome-sandbox"), "");
  const mark = join(d, "sudo-called");
  writeFileSync(join(bin, "sudo"), `#!/bin/sh\necho "$*" >> '${mark}'\nexit 1\n`);
  writeFileSync(join(bin, "unshare"), `#!/bin/sh\nexit ${o.unshare ? 0 : 1}\n`);
  chmodSync(join(bin, "sudo"), 0o755);
  chmodSync(join(bin, "unshare"), 0o755);
  const restrict = join(d, "restrict");
  if (o.restrict !== undefined) writeFileSync(restrict, o.restrict + "\n");
  const body = block().split(RESTRICT).join(restrict);
  const p = Bun.spawn(["bash", "-c", `set -euo pipefail\nAPP='${app}'\n${body}\necho "sandbox_ok=$sandbox_ok"`], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code, sudo: existsSync(mark) ? readFileSync(mark, "utf8") : null };
}

describe("install-local.sh and the chrome-sandbox helper", () => {
  test("the block reads the real AppArmor switch", () => {
    expect(block()).toContain(RESTRICT);
  });

  test("never asks sudo where user namespaces work", async () => {
    const r = await run({ unshare: true });
    expect(r.code).toBe(0);
    expect(r.sudo).toBeNull();
    expect(r.out).toContain("sandbox_ok=true");
    expect(r.err).not.toContain("chrome-sandbox needs root");
  });

  test("still asks, and warns, where they do not", async () => {
    const r = await run({ unshare: false });
    expect(r.code).toBe(0);
    expect(r.sudo).toBe("-n true\n");
    expect(r.err).toContain("chrome-sandbox needs root");
  });

  test("treats Ubuntu's AppArmor restriction as namespaces not working", async () => {
    const r = await run({ unshare: true, restrict: "1" });
    expect(r.sudo).toBe("-n true\n");
    expect(r.err).toContain("chrome-sandbox needs root");
    expect((await run({ unshare: true, restrict: "0" })).sudo).toBeNull();
  });
});
