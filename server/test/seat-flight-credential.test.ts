/*
 * A seat pane that holds only the machine token reaches the Flight plan verbs
 * as the seat, through the credential the seat-cred socket hands it. The kernel
 * names the caller (SO_PEERCRED); a bare `--as` name is never read. The
 * credential is short, in memory, and good for the plan verbs and nothing else.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setSeatCandidates, startSeatCredSocket, stopSeatCredSocket } from "../src/seatcred.ts";
import { createServer } from "node:net";
import { allowed, callerFor, mintSeatFlightToken } from "../src/auth.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-seatflight-"));
afterAll(() => { stopSeatCredSocket(); __setSeatCandidates(null); rmSync(dir, { recursive: true, force: true }); });

async function socket(): Promise<string> {
  stopSeatCredSocket();
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  startSeatCredSocket();
  if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
  const path = join(dir, "agentglass", "seat-cred", "seat-cred.sock");
  for (let i = 0; i < 50 && !existsSync(path); i++) await Bun.sleep(10);
  return path;
}
const ask = (path: string, line: string): Promise<{ ok: boolean; token?: string }> => new Promise((resolve, reject) => {
  const s = createConnection(path, () => s.write(`${line}\n`));
  const c: Buffer[] = [];
  s.on("data", (d) => c.push(Buffer.from(d)));
  s.on("end", () => { try { resolve(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch (e) { reject(e); } });
  s.on("error", reject);
});
const req = (token: string) => new Request("http://x/", { headers: { authorization: `Bearer ${token}` } });
const url = new URL("http://x/");
const canBind = await new Promise<boolean>((resolve) => {
  const p = join(dir, "probe.sock");
  const srv = createServer() as unknown as import("node:events").EventEmitter & { listen(p: string, cb: () => void): void; close(cb: () => void): void };
  srv.on("error", () => resolve(false));
  srv.listen(p, () => srv.close(() => resolve(true)));
});

describe("the seat's own plan credential", () => {
  test("the credential is the seat's, reaches no-go and nothing else, and ends", () => {
    const token = mintSeatFlightToken("/home/a/code/orbit", "assign", 60_000);
    const caller = callerFor(req(token), url, "machine-token")!;
    // One use: the same string, presented again, is nobody.
    expect(callerFor(req(token), url, "machine-token")).toBeNull();
    expect(caller.principal).toBe("seat");
    expect(caller.seat?.root).toBe("/home/a/code/orbit");
    const plan = "/flight-plan/plans/fp_0123456789abcdef";
    expect(allowed(caller, "POST", `${plan}/no-go`)).toBe(true);
    expect(allowed(caller, "POST", "/agents/named/prompt")).toBe(false);
    expect(allowed(caller, "PUT", "/flow")).toBe(false);
    expect(allowed(caller, "POST", "/settings/door")).toBe(false);
    expect(callerFor(req(mintSeatFlightToken("/r", "speak", -1)), url, "machine-token")).toBeNull();
  });

  test.skipIf(!canBind)("the socket hands the pane's seat that credential", async () => {
    __setSeatCandidates(async () => [{ root: "/home/a/code/orbit", name: "chair", livePid: process.pid }]);
    const res = await ask(await socket(), "seat-flight");
    expect(res.ok).toBe(true);
    expect(res.token).toMatch(/^sf_/);
    expect(callerFor(req(res.token!), url, "machine-token")?.principal).toBe("seat");
  });

  test.skipIf(!canBind)("a process that is not under the seat's pane gets none", async () => {
    __setSeatCandidates(async () => []);
    const res = await ask(await socket(), "seat-flight");
    expect(res.ok).toBe(false);
    expect(res.token).toBeUndefined();
  });

  test("a bare name is not a credential", () => {
    expect(callerFor(req("sf_notminted"), url, "machine-token")).toBeNull();
  });
});
