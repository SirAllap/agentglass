import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The gate hook has to find the token without being handed it.
 *
 * /gate is the control plane — a POST raises an operator-facing approval prompt
 * with caller-supplied text — so it authenticates whenever the server has a
 * token, and the desktop app now always gives it one (electron/main.js). The
 * hook, meanwhile, inherits the environment of whatever launched Claude Code:
 * a desktop icon, a login shell, a terminal opened anywhere but inside
 * agentglass. None of those carry AGENTGLASS_TOKEN.
 *
 * Read only the environment and the failure is invisible. /gate answers 401,
 * gate_event.py treats an HTTPError as "the server answered, just not with a
 * decision", cancels its retry loop, and falls into fail-open — every gated
 * tool call sails through, silently, exactly as if no one had gated it. The
 * gate's whole value is that it holds; this is what keeps it holding.
 *
 * The same file, order and reasoning as hooks/statusline.sh, which solved this
 * first.
 */
const HOOK = resolve(import.meta.dir, "..", "..", "hooks", "gate_event.py");
const PY = Bun.which("python3");

// Call the hook's own resolver in a subprocess: importing it by path is what
// keeps this a test of the shipped code rather than of a copy of its logic.
const PROBE = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("gate_event", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
sys.stdout.write(mod._shared_secret())
`;

let boxes: string[] = [];
afterEach(() => { for (const b of boxes) rmSync(b, { recursive: true, force: true }); boxes = []; });

/** A throwaway XDG config home, optionally holding a minted token. */
function configHome(token?: string): string {
  const box = mkdtempSync(join(tmpdir(), "agx-gate-"));
  boxes.push(box);
  if (token !== undefined) {
    mkdirSync(join(box, "agentglass"), { recursive: true });
    // Trailing newline on purpose: that is how both the shell and the server
    // write it, and an unstripped one makes every Authorization header wrong.
    writeFileSync(join(box, "agentglass", "token"), token + "\n", { mode: 0o600 });
  }
  return box;
}

function secret(env: Record<string, string>): string {
  const r = Bun.spawnSync([PY!, "-c", PROBE, HOOK], {
    // A bare environment, so nothing the developer happens to export decides it.
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", ...env },
  });
  expect(r.exitCode).toBe(0);
  return new TextDecoder().decode(r.stdout);
}

describe.skipIf(!PY)("gate hook token resolution", () => {
  test("reads the minted file when the environment has nothing", () => {
    expect(secret({ XDG_CONFIG_HOME: configHome("from-the-file") })).toBe("from-the-file");
  });

  test("an explicit environment token wins", () => {
    expect(secret({
      XDG_CONFIG_HOME: configHome("from-the-file"),
      AGENTGLASS_TOKEN: "from-the-env",
    })).toBe("from-the-env");
  });

  test("no token anywhere is empty, not an error", () => {
    // A server started without one wants no header at all. This has to stay a
    // quiet empty string: raising here would turn "agentglass isn't running
    // with auth" into a broken PreToolUse hook on every single tool call.
    expect(secret({ XDG_CONFIG_HOME: configHome() })).toBe("");
  });

  test("an unreadable config home is empty, not an error", () => {
    expect(secret({ XDG_CONFIG_HOME: "/nonexistent/nowhere" })).toBe("");
  });
});
