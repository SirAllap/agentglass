/* The two calls envscope.ts wraps around each test file. See there. */
import { afterAll } from "bun:test";

export type EnvSnap = Record<string, string>;

/* AGENTGLASS_*, plus the two tmux variables. TMUX_TMPDIR names the one directory
   tmuxctl will act in (`tmuxSocketConfined`), so a file that leaves it set
   makes every later file's `-S` socket outside it a refusal: the tmux tests
   went red or green with the shuffled file order. */
const scoped = (k: string) => k.startsWith("AGENTGLASS_") || k === "TMUX_TMPDIR" || k === "TMUX";

export function snapshotEnv(): EnvSnap {
  const snap: EnvSnap = {};
  for (const [k, v] of Object.entries(process.env)) if (scoped(k) && v !== undefined) snap[k] = v;
  return snap;
}

export function restoreEnvAfterAll(snap: EnvSnap): void {
  afterAll(() => {
    for (const k of Object.keys(process.env)) if (scoped(k) && !(k in snap)) delete process.env[k];
    for (const [k, v] of Object.entries(snap)) if (process.env[k] !== v) process.env[k] = v;
  });
}
