// Child of pr-read-cost.test.ts: asks the pull request reads a panel makes, in
// the order and overlap it makes them, and prints how many `gh` spawns each
// step cost (the stub logs one line per call).
import { existsSync, readFileSync } from "node:fs";

const [repo, log] = process.argv.slice(2) as [string, string];
const count = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
const prs = await import("../../src/prs.ts");
const inb = await import("../../src/ghinbox.ts");

const out: Record<string, number> = {};
async function step(name: string, fn: () => Promise<unknown>) {
  const before = count();
  await fn();
  out[name] = count() - before;
}
const n = 5;

await step("detailColdTwice", () => Promise.all([prs.prDetail(repo, n), prs.prDetail(repo, n)]));
await step("detailForcedTwice", () => Promise.all([prs.prDetail(repo, n, true), prs.prDetail(repo, n, true)]));
await step("detailReopen", () => prs.prDetail(repo, n));
await step("pendingReviewX3", async () => { for (let i = 0; i < 3; i++) await prs.pendingReviewFor(repo, n); });
await step("behindX3", async () => { for (let i = 0; i < 3; i++) await prs.branchBehind(repo, n); });
await step("behindFresh", () => prs.branchBehind(repo, n, true));
await step("rollupX3", async () => { for (let i = 0; i < 3; i++) await prs.prRollup(repo, n); });
await step("fileSliceX3", async () => {
  for (let i = 0; i < 3; i++) await prs.fileSlice(repo, n, { path: "src/a.ts", side: "RIGHT", from: 1, to: 2 });
});
// The Diff view: opening it, leaving and coming back is one `gh pr diff`.
await step("diffOpenedThrice", async () => { for (let i = 0; i < 3; i++) await prs.prDiff(repo, n); });
await step("facetsTwiceAtOnce", () => Promise.all([prs.facetOptions(repo), prs.facetOptions(repo)]));

const later = (ms: number) => { const real = Date.now; Date.now = () => real() + ms; return () => { Date.now = real; }; };
await step("inboxFirst", () => inb.inbox(true));
const back1 = later(50_000);
await step("inboxAt50s", () => inb.inbox(true));
back1();
const back2 = later(110_000);
await step("inboxAt110s", () => inb.inbox(true));
back2();

console.log(JSON.stringify(out));
process.exit(0);
