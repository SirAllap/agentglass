// Child of behind-pages.test.ts: reads "what main brings" for a branch that is
// 250 commits behind, then 102 behind, against a stub `gh`; prints the result.
import { writeFileSync } from "node:fs";

const [repo, behindFile] = process.argv.slice(2) as [string, string];
const prs = await import("../../src/prs.ts");
const out: Record<string, unknown> = {};
writeFileSync(behindFile, "250");
out.far = (await prs.branchBehind(repo, 5, true)).incoming;
writeFileSync(behindFile, "102");
out.topUp = (await prs.branchBehind(repo, 5, true)).incoming;
console.log(JSON.stringify(out));
process.exit(0);
