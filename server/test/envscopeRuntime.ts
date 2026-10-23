/* The two calls envscope.ts wraps around each test file. See there. */
import { afterAll } from "bun:test";

export type EnvSnap = Record<string, string>;

export function snapshotEnv(): EnvSnap {
  const snap: EnvSnap = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("AGENTGLASS_") && v !== undefined) snap[k] = v;
  return snap;
}

export function restoreEnvAfterAll(snap: EnvSnap): void {
  afterAll(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("AGENTGLASS_") && !(k in snap)) delete process.env[k];
    for (const [k, v] of Object.entries(snap)) if (process.env[k] !== v) process.env[k] = v;
  });
}
