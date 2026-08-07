import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The desktop app must run its sidecar behind a token, loopback or not.
 *
 * The default used to be no authentication at all, on the reading that
 * "anything that can reach 127.0.0.1 is you". That holds for processes and
 * fails for people: loopback belongs to the machine, not to the account. On a
 * box with a second Unix user — or in a browser holding an extension with
 * `http://localhost/*` — opening the port was the whole of the check, and what
 * came back was the cockpit: a terminal, git write access, docker control. The
 * README named the risk and asked the operator to set AGENTGLASS_TOKEN by
 * hand, which is not a default anyone installing a .deb ever meets.
 *
 * Locked at this level because the property is decided in main.js and nowhere
 * else: the server's own contract (auth.ts, resolveToken) is deliberately
 * unchanged — a bare `bun run server` on loopback still needs no token — so
 * there is no server-side assertion that could catch a regression here. Driving
 * a real Electron launch from a test is a heavier harness than this repo has,
 * which is the same reason desktop-origin.test.ts reads this file.
 *
 * Rather than grep for the text, each case lifts the real function out of
 * main.js and runs it against stubs. A test that only looked for the string
 * would keep passing through a rename, a reordering, or a stray `if` wrapped
 * back around it — the three ways this actually regresses.
 *
 * If you are here because this failed, the question is not how to make it pass.
 * It is: can someone who can reach the port, but cannot read the 0600 token
 * file, get a shell?
 */
const MAIN = readFileSync(resolve(import.meta.dir, "..", "..", "electron", "main.js"), "utf8");

/**
 * Lift one top-level function out of main.js so it can be called.
 *
 * main.js is the Electron entry point — importing it takes the single-instance
 * lock and registers protocol schemes against an `electron` module that does
 * not exist under bun. Its declarations are all top-level and unindented, so a
 * closing brace in column zero ends the one we asked for.
 */
function lift(name: string, deps: string[]): (...args: unknown[]) => any {
  const open = MAIN.indexOf(`function ${name}(`);
  if (open < 0) throw new Error(`main.js no longer declares ${name}()`);
  const end = MAIN.indexOf("\n}\n", open);
  if (end < 0) throw new Error(`could not find the end of ${name}()`);
  const src = MAIN.slice(open, end + 3);
  return new Function(...deps, `${src}\nreturn ${name};`) as never;
}

/** A stub `process` whose env is ours alone — the real one carries whatever the
 *  developer running the suite happens to export. */
const proc = (env: Record<string, string> = {}) => ({ env });

describe("currentToken", () => {
  const build = (env: Record<string, string>, minted = "minted-from-file") =>
    lift("currentToken", ["process", "ensureToken"])(proc(env), () => minted)();

  it("never returns null — the loopback default is authenticated now", () => {
    expect(build({})).toBe("minted-from-file");
  });

  it("prefers an explicit environment token", () => {
    expect(build({ AGENTGLASS_TOKEN: "set-by-hand" })).toBe("set-by-hand");
  });

  it("falls back to the minted file when the env token is blank", () => {
    // An exported-but-empty AGENTGLASS_TOKEN is a shell accident, not a request
    // to run unauthenticated.
    expect(build({ AGENTGLASS_TOKEN: "   " })).toBe("minted-from-file");
  });
});

describe("sidecarEnv", () => {
  const build = (opts: { remote: boolean; env?: Record<string, string> }) =>
    lift("sidecarEnv", ["process", "remoteEnabled", "currentToken", "DIST"])(
      proc(opts.env ?? {}),
      () => opts.remote,
      () => "the-shared-secret",
      "/somewhere/web",
    )(4000);

  it("spawns the sidecar with a token when remote access is OFF", () => {
    // The case that was open: the ordinary install, nobody's phone involved.
    expect(build({ remote: false }).AGENTGLASS_TOKEN).toBe("the-shared-secret");
  });

  it("still spawns it with a token when remote access is ON", () => {
    expect(build({ remote: true }).AGENTGLASS_TOKEN).toBe("the-shared-secret");
  });

  it("hands the sidecar the same secret the renderer is given", () => {
    // Both sides read currentToken(). When they did not, an operator who set
    // AGENTGLASS_TOKEN by hand got a shell talking past its own server: the
    // sidecar minted from the file, the renderer sent the environment's, and
    // every route answered 401 with nothing on screen naming the reason.
    expect(MAIN).toMatch(/AGENTGLASS_TOKEN:\s*currentToken\(\)/);
  });

  it("leaves the bind alone unless remote access asked for it", () => {
    // The token is not a licence to widen the bind: closing reach-without-read
    // and opening the port to the network are separate decisions.
    expect(build({ remote: false }).AGENTGLASS_BIND).toBeUndefined();
    expect(build({ remote: false }).AGENTGLASS_TRUST_LAN).toBeUndefined();
    expect(build({ remote: true }).AGENTGLASS_BIND).toBe("0.0.0.0");
    expect(build({ remote: true }).AGENTGLASS_TRUST_LAN).toBe("1");
  });

  it("honours a hand-set bind over its own default", () => {
    const env = build({ remote: true, env: { AGENTGLASS_BIND: "10.0.0.5" } });
    expect(env.AGENTGLASS_BIND).toBe("10.0.0.5");
  });
});
