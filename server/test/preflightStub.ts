/*
 * A stand-in for `claude -p` that tests run as `[process.execPath, thisFile]`
 * (a bun binary renamed `claude` would run `bun -p`). It writes down what it was
 * started with, to STUB_RECORD, and answers with STUB_REPLY or the contents of
 * STUB_REPLY_FILE (a booted server's reply changes between requests); STUB_JSON
 * replaces the whole result line, for the shapes claude ends a failed run with.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const walk = (d: string, base = d): { path: string; mode: number }[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n), st = statSync(p);
    return st.isDirectory() ? walk(p, base) : [{ path: p.slice(base.length + 1), mode: st.mode & 0o777 }];
  });

const cwd = process.cwd();
if (process.env.STUB_RECORD) {
  writeFileSync(process.env.STUB_RECORD, JSON.stringify({
    argv: process.argv.slice(2), cwd, tree: walk(cwd).sort((a, b) => (a.path < b.path ? -1 : 1)),
    // what the reviewer could read, by name, so a test can assert the material is there
    contents: Object.fromEntries(walk(cwd).filter((f) => /\.(md|diff)$/.test(f.path)).map((f) => [f.path, readFileSync(join(cwd, f.path), "utf8")])),
    env: { memoryOff: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null, claudecode: process.env.CLAUDECODE ?? null, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null, extra: process.env.STUB_EXTRA ?? null, secret: process.env.SECRET_X ?? null, anthropic: process.env.ANTHROPIC_API_KEY ?? null, path: process.env.PATH ?? null },
  }));
}
const reply = process.env.STUB_REPLY_FILE ? readFileSync(process.env.STUB_REPLY_FILE, "utf8") : process.env.STUB_REPLY ?? "No findings";
console.log(process.env.STUB_JSON ?? JSON.stringify({ result: reply, total_cost_usd: 0.0123 }));
