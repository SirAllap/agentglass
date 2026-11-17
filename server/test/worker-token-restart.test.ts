// A worker's `wk_` credential used to live only in memory: an app restart or
// install between two browser calls of one turn answered `unauthorized` and the
// worker stopped. It now survives as a hash. Two child processes stand in for
// the two server lives; revocation must still cut it in the second.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-wkcred-"));
const env = {
  ...process.env, NODE_ENV: "test", XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
  AGENTGLASS_STATE_DIR: dir, AGENTGLASS_DB: join(dir, "t.db"), TMUX_TMPDIR: dir,
};
const authPath = join(import.meta.dir, "../src/auth.ts");
async function life(code: string): Promise<string> {
  const p = Bun.spawn([process.execPath, "-e", `const a = await import(${JSON.stringify(authPath)});\n${code}`], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  if (p.exitCode !== 0) throw new Error(err);
  return out.trim();
}
const alive = `a.setWorkerAliveCheck((n) => n !== "gone-builder");`;
const who = `const r = (t) => { const c = a.callerFor(new Request("http://127.0.0.1/x", { headers: { authorization: "Bearer " + t } }), new URL("http://127.0.0.1/x"), "machine-token-x"); return c ? c.principal + ":" + c.worker : "null"; };`;

const q = (t: string) => JSON.stringify(t);
const SERVER_BOOT = 60_000;

describe("worker token across a restart", () => {
  test("live after restart, refused once revoked, and a stranger stays refused", async () => {
    try {
      const tok = await life(`console.log(a.mintWorkerToken("orbit-builder", 60000, true, "/tmp/acme-orbit"))`);
      expect(await life(`${alive} ${who} console.log(r(${q(tok)}), r("wk_nope"))`)).toBe("worker:orbit-builder null");
      await life(`a.revokeWorkerTokens("orbit-builder")`);
      expect(await life(`${alive} ${who} console.log(r(${q(tok)}))`)).toBe("null");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, SERVER_BOOT);

  test("expiry, single revoke, replace, dead worker and fail-closed all hold across a restart", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "agx-wkcred2-"));
    Object.assign(env, { XDG_CONFIG_HOME: d2, XDG_DATA_HOME: d2, XDG_CACHE_HOME: d2, AGENTGLASS_STATE_DIR: d2, AGENTGLASS_DB: join(d2, "t.db"), TMUX_TMPDIR: d2 });
    try {
      const out = JSON.parse(await life(`const m = ({
        old: a.mintWorkerToken("short-builder", 1, true), one: a.mintWorkerToken("one-builder", 60000, true),
        r1: a.mintWorkerToken("repl-builder", 60000, true), gone: a.mintWorkerToken("gone-builder", 60000, true),
        keep: a.mintWorkerToken("keep-builder", 60000, true) });
        a.revokeWorkerToken(a.workerTokenOf("one-builder"));
        a.mintWorkerToken("repl-builder", 60000, true);
        console.log(JSON.stringify(m));`));
      await Bun.sleep(20);
      const res = await life(`${alive} ${who} console.log([${["old", "one", "r1", "gone", "keep"].map((k) => `r(${q(out[k])})`).join(",")}].join("|"))`);
      // expired, revoked, replaced, dead worker: all refused; a live one still works.
      expect(res).toBe("null|null|null|null|worker:keep-builder");
      // no live-check installed (boot not finished): fail closed.
      expect(await life(`${who} console.log(r(${q(out.keep)}))`)).toBe("null");
      // the revoke of the live one by name also persists, and the file holds no raw token.
      const bytes = readdirSync(d2).filter((f) => f.startsWith("t.db")).map((f) => readFileSync(join(d2, f)).toString("latin1")).join("");
      for (const k of Object.keys(out)) expect(bytes.includes(out[k])).toBe(false);
    } finally { rmSync(d2, { recursive: true, force: true }); }
  }, SERVER_BOOT);
});
