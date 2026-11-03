/*
 * A stand-in for `opencode run --format json`, run as `[process.execPath, thisFile]`.
 * It writes down the argv and the environment it was started with, to
 * STUB_RECORD, and answers with one invented turn: a preamble, the findings,
 * and a step that reports no cost (a subscription plan), so the certificate has
 * to say the cost was not reported.
 */
import { writeFileSync } from "node:fs";

if (process.env.STUB_RECORD) {
  writeFileSync(process.env.STUB_RECORD, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: {
      OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? null,
      OPENCODE_DISABLE_PROJECT_CONFIG: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null,
    },
  }));
}

const line = (o: unknown) => JSON.stringify(o);
console.log([
  line({ type: "step_start", timestamp: 1791655313013, sessionID: "ses_orbit01", part: { type: "step-start" } }),
  line({ type: "text", timestamp: 1791655313100, sessionID: "ses_orbit01", part: { type: "text", text: "Reading the material and the file it names." } }),
  line({ type: "text", timestamp: 1791655313900, sessionID: "ses_orbit01", part: { type: "text", text: "### F1 - Blocker - No way to check it\nQuote: Rename the flag.\nEvidence: files/src/orbit.ts:12 is the only reader" } }),
  line({ type: "step_finish", timestamp: 1791655314100, sessionID: "ses_orbit01", part: { type: "step-finish", modelID: "deepseek-v4.1-flash" } }),
].join("\n"));
