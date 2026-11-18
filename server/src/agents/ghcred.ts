// The GitHub credential a worker's turn is started with.
//
// A worker does what its seat does, and the seat's `gh` works because the
// person is signed in to it. The server hands the worker the same credential
// for ONE turn: through the spawn environment only (GH_TOKEN), the way the
// browser credential travels. It is never written to the settings JSON, the
// argv, the brief or the run folder, and the process's environment dies with
// the turn.
//
// HONEST LIMIT (said in the start answer): this is the person's own token. A
// personal access token cannot be revoked by this app; dropping it from the
// environment at the end of the turn is all that is done.
//
// Only a turn that can reach GitHub gets it: the envelope's `network` is on.
// A sandboxed turn has no route to GitHub, so a token there would be a secret
// with no use.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Envelope } from "../../../shared/orchestration.ts";
import { ghEnv, runGh, scrubToken } from "../ghdoor.ts";
import { envelopeDir } from "./envelope.ts";

/** The env var that names the 0600 file holding the token. The wrapper reads and deletes it, so the token never rides in the window's command line. */
export const GH_TOKEN_FILE_VAR = "AGENTGLASS_GH_TOKEN_FILE";

export const GH_LIMIT = "gh works in this worker with your own GitHub token for this turn only. It is not in any command line or file the worker can read: the wrapper takes it from a private file and deletes it. It stays in the process environment (/proc/<pid>/environ) for the turn, so the worker can read it. A personal access token cannot be revoked from here; it is dropped when the turn ends.";

/** What the server's own `gh` would use, or null when nobody is signed in. */
export async function serverGhToken(run: typeof runGh = runGh): Promise<string | null> {
  try {
    const r = await run(["auth", "token"]);
    const t = r.stdout.trim();
    return r.code === 0 && /^[A-Za-z0-9_]{20,255}$/.test(t) ? t : null;
  } catch { return null; }
}

/** Puts the token into a private file named by one env var, when the envelope can reach GitHub. True when it did. The wrapper turns it into GH_TOKEN and deletes the file. */
export async function grantGh(env: Record<string, string>, envelope: Pick<Envelope, "network">, get: () => Promise<string | null> = serverGhToken): Promise<boolean> {
  if (!envelope.network) return false;
  const t = await get();
  if (!t) return false;
  const dir = envelopeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `gh-${randomBytes(12).toString("hex")}.tok`);
  writeFileSync(file, t, { mode: 0o600 });
  env[GH_TOKEN_FILE_VAR] = file;
  return true;
}

/** Takes the credential back: the file if the wrapper never read it, and any token in the environment. */
export function dropGh(env: Record<string, string>): void {
  const f = env[GH_TOKEN_FILE_VAR];
  if (f) { try { rmSync(f, { force: true }); } catch { /* gone already */ } }
  delete env[GH_TOKEN_FILE_VAR]; delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
}

/** Text that may leave the process (a log line, a history row) with any token cut out. */
export const scrubbed = scrubToken;
export { ghEnv };
