#!/usr/bin/env bun
/**
 * Drive the conflict screen against real stopped repositories, and fail if it
 * lies.
 *
 * Why this exists rather than more unit tests: every bug this screen has had
 * was invisible to `tsc`, to `bun test` and to a screenshot, and visible the
 * moment somebody actually used it. Two of them were found by this script's
 * ancestor —
 *
 *   - the review listed thirty files under "2 of these you decided" with
 *     neither of the two on it, because resolving in favour of the side you
 *     are already on produces no diff and so never reaches the staged list;
 *
 *   - continuing a rebase left the review of commit 1 on screen while commit 2
 *     was already conflicted underneath it, offering a commit button over a
 *     file marked "you decided this" that nobody had touched.
 *
 * Neither is expressible as a pure function; both are obvious in three
 * scripted clicks. So the clicks are the test.
 *
 *   bun scripts/conflict-drive.ts            # both scenarios, exits non-zero on failure
 *   bun scripts/conflict-drive.ts --shots /tmp/x   # and leave the pictures behind
 */
import { spawn } from "bun";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, findChrome, until } from "./cdp.ts";
import { jsLit } from "../shared/jsLit.ts";
import { privateTmuxDir } from "./tmuxTmp.ts";

const ROOT = resolve(import.meta.dir, "..");
const SHOTS = (() => {
  const i = Bun.argv.indexOf("--shots");
  return i > 0 ? Bun.argv[i + 1] ?? null : null;
})();
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (name: string, ok: boolean, saw?: unknown) => {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.log(`  ✗ ${name}${saw === undefined ? "" : `  — saw ${JSON.stringify(saw)}`}`);
};

/* ------------------------------------------------------------- the fixtures */

/** A lockfile shape: long, and conflicting in two hundred places. */
const lock = (v: string) =>
  Array.from({ length: 4000 }, (_, i) =>
    i % 20 === 3 ? `    "resolved-${i}": "${v}.${i}.0",` : `    "pkg-${i}": "1.${i}.0",`).join("\n") + "\n";

/** Long, with three conflicts far apart — so the folding has work to do. */
const long = (v: string) =>
  Array.from({ length: 900 }, (_, i) =>
    i === 100 || i === 450 || i === 800 ? `export const knob${i} = ${v};` : `export const stable${i} = ${i};`).join("\n") + "\n";

/**
 * A repository stopped mid-merge or mid-rebase.
 *
 * feat has three commits each touching a different file, and main has touched
 * all of them — so a rebase onto main stops three separate times. That
 * arrangement is load-bearing: with every commit editing one file, resolving
 * the first leaves the rest applying cleanly and "commit 2 of 3" is a state
 * you cannot reach.
 */
function build(repo: string, mode: "merge" | "rebase"): void {
  const G = (...a: string[]) =>
    Bun.spawnSync(["git", "-C", repo, "-c", "user.email=p@e.com", "-c", "user.name=P", "-c", "commit.gpgsign=false", ...a]);
  mkdirSync(repo, { recursive: true });
  G("init", "-q", "-b", "main", ".");
  // In the repo's own config, not per-command with -c: the server runs git
  // itself, under a temp HOME with no global identity, and `rebase --continue`
  // has to be able to MAKE a commit. Without this the drive failed with
  // "Committer identity unknown" and looked exactly like a stuck screen.
  G("config", "user.email", "p@e.com");
  G("config", "user.name", "P");
  G("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "bun.lock"), lock("0"));
  writeFileSync(join(repo, "knobs.ts"), long("0"));
  for (const f of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(repo, f), `export const ${f[0]} = 0;\n`);
  G("add", "-A"); G("commit", "-qm", "seed");

  G("checkout", "-q", "-b", "feat/bump");
  writeFileSync(join(repo, "bun.lock"), lock("2"));
  writeFileSync(join(repo, "knobs.ts"), long("2"));
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
  // Files that come in with the merge and conflict with nothing — the ones a
  // commit button would carry without ever showing them.
  for (let i = 0; i < 30; i++) writeFileSync(join(repo, `mod-${i}.ts`), `export const n = ${i};\n`);
  G("add", "-A"); G("commit", "-qm", "bump a");
  writeFileSync(join(repo, "b.ts"), "export const b = 2;\n"); G("add", "-A"); G("commit", "-qm", "bump b");
  writeFileSync(join(repo, "c.ts"), "export const c = 2;\n"); G("add", "-A"); G("commit", "-qm", "bump c");

  G("checkout", "-q", "main");
  writeFileSync(join(repo, "bun.lock"), lock("9"));
  writeFileSync(join(repo, "knobs.ts"), long("9"));
  for (const f of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(repo, f), `export const ${f[0]} = 9;\n`);
  G("add", "-A"); G("commit", "-qm", "main side");

  if (mode === "rebase") { G("checkout", "-q", "feat/bump"); G("rebase", "main"); }
  else G("merge", "feat/bump");
}

/* ------------------------------------------------------------------- driver */

async function drive(mode: "merge" | "rebase", body: (cdp: any, shot: (n: string) => Promise<void>, repo: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "agx-drive-home-"));
  const profile = mkdtempSync(join(tmpdir(), "agx-drive-chrome-"));
  const repo = join(home, "orbit");
  build(repo, mode);

  const port = 5100 + Math.floor(Math.random() * 200);
  const dport = 10_100 + Math.floor(Math.random() * 200);
  const server = spawn({
    cmd: ["bun", join(ROOT, "server", "src", "index.ts")],
    env: {
      ...process.env,
      AGENTGLASS_PORT: String(port), AGENTGLASS_ROOT: repo,
      // Pinned, never inherited: a AGENTGLASS_WEB_DIR from the surrounding
      // shell once served the INSTALLED app to a probe for three rounds, and
      // every conclusion drawn from those pictures was about a different build.
      AGENTGLASS_WEB_DIR: join(ROOT, "web", "dist"),
      AGENTGLASS_DB: join(home, "agentglass.db"),
      XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
      // The engine's generated tmux.conf lives in the STATE dir: isolate it too,
      // or a throwaway run rewrites the conf the real engine is running on.
      AGENTGLASS_STATE_DIR: join(home, "state"),
      // Its own tmux socket directory, beside the config/data/cache above and
      // for the same reason: this child is a SERVER, and a server with no
      // TMUX_TMPDIR sweeps and lists /tmp/tmux-<uid> — the sessions the user is
      // working in. See scripts/tmuxTmp.ts for what was measured reaching them.
      TMUX_TMPDIR: privateTmuxDir(home),
      AGENTGLASS_TOKEN: "drive-token", HOME: home, SHELL: "/bin/bash",
    },
    stdout: "ignore", stderr: "ignore",
  });

  let chrome: ReturnType<typeof spawn> | null = null;
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health?token=drive-token`)).ok) break; } catch { /* booting */ }
      await Bun.sleep(250);
    }
    chrome = spawn({
      cmd: [findChrome(), "--headless=new", `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`,
        "--window-size=1600,1000", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
        "--disable-gpu", "--no-sandbox", "--force-color-profile=srgb", "--force-prefers-reduced-motion",
        `http://127.0.0.1:${port}/?token=drive-token`],
      stdout: "ignore", stderr: "ignore",
    });
    const cdp = await connect(dport);
    await until(cdp, `document.querySelector('#root')?.children.length`, "the app to mount", 30_000);
    await Bun.sleep(3000);
    const shot = async (n: string) => { if (SHOTS) writeFileSync(join(SHOTS, `${n}.png`), await cdp.shot()); };
    await body(cdp, shot, repo);
    cdp.close();
  } finally {
    try { chrome?.kill(); } catch { /* gone */ }
    try { server.kill(); } catch { /* gone */ }
    rmSync(profile, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

const text = (cdp: any) => cdp.ev(`document.body.innerText`) as Promise<string>;
const clickText = (cdp: any, re: string) =>
  cdp.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>${re}.test(e.textContent));if(!b)return false;b.click();return true})()`);
const clickExact = (cdp: any, label: string) =>
  cdp.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${jsLit(label)});if(!b)return false;b.click();return true})()`);

/* ------------------------------------------------------------------ scenario */

console.log("merge: the screen, the big files, and the review");
await drive("merge", async (cdp, shot, repo) => {
  const t0 = await text(cdp);
  check("git's own tabs are gone", !/Reflog/.test(t0) && !/Stashes/.test(t0));
  // Named exactly. A looser "any textarea mentioning a message" also matched
  // the chat composer in another pane of the app, which has nothing to do with
  // this and is not hidden by anything.
  check("git's commit box is gone", await cdp.ev(`!document.querySelector('input[placeholder^="Commit message"]')`));
  check("so is stage/unstage/discard", !/\bUnstage all\b|\bStage all\b/.test(t0));
  check("names the operation", /Merging/.test(t0));
  check("counts the files from the record", /0 of 5 files resolved/.test(t0), (t0.match(/\d+ of \d+ files? resolved/) || [])[0]);
  await shot("merge-01");

  // A file with two hundred conflicts is not something to work through one at
  // a time, and the screen has to say so rather than render it.
  check("opens the lockfile", await clickExact(cdp, "bun.lock"));
  await Bun.sleep(2500);
  const lockT = await text(cdp);
  check("says why the lockfile is not per-conflict", /conflicts in one file/.test(lockT));
  check("offers the whole-file take instead", /all (ours|main)/.test(lockT));
  const lockNodes = await cdp.ev(`document.querySelectorAll('*').length`);
  check("keeps the DOM bounded on 4000 lines", Number(lockNodes) < 1200, lockNodes);
  await shot("merge-02-lockfile");

  // A long file with three conflicts folds the rest.
  check("opens the long file", await clickExact(cdp, "knobs.ts"));
  await Bun.sleep(2500);
  const longT = await text(cdp);
  check("folds the runs far from a conflict", (longT.match(/⋯ \d+ unchanged lines/g) || []).length >= 3);
  const longNodes = await cdp.ev(`document.querySelectorAll('*').length`);
  check("keeps the DOM bounded on 900 lines", Number(longNodes) < 1200, longNodes);
  check("a fold opens", await clickText(cdp, "/unchanged lines/"));
  await Bun.sleep(600);
  check("and shows more once opened", Number(await cdp.ev(`document.querySelectorAll('*').length`)) > Number(longNodes));
  await shot("merge-03-folds");

  // Settle everything, the quick way.
  for (const f of ["a.ts", "b.ts", "c.ts", "bun.lock", "knobs.ts"]) {
    await clickExact(cdp, f);
    await Bun.sleep(1200);
    await clickText(cdp, "/^all (ours|main)/");
    await Bun.sleep(1400);
    await clickText(cdp, "/^Take ours$/");
    await Bun.sleep(1600);
  }
  const doneT = await text(cdp);
  check("every file resolved", /5 of 5 files resolved/.test(doneT), (doneT.match(/\d+ of \d+ files? resolved/) || [])[0]);

  // The handoffs. Both of these reported as broken by somebody using them: the
  // terminal one did its whole job in silence, and the chat one opened a blank
  // chat because it set the stored id and stopped there — the chat panel keeps
  // its own selection and reads that id only at mount.
  check("the terminal handoff says it happened", await clickText(cdp, "/in a terminal/"));
  await Bun.sleep(900);
  const toastT = await text(cdp);
  check("and names where it went", /tmux window/.test(toastT), (toastT.match(/Claude is on it[^\n]*/) || [])[0]);

  check("the chat handoff is offered as the lesser option", await clickText(cdp, "/in the chat/"));
  await Bun.sleep(1600);
  const chatT = await text(cdp);
  check("the chat it opens is the seeded one", /Resolve merge conflicts/.test(chatT),
    (chatT.match(/new chat|Resolve merge conflicts/) || [])[0]);
  check("with the briefing already in the box", await cdp.ev(
    `!![...document.querySelectorAll('textarea')].find(e=>/conflicted|mid-merge/i.test(e.value||""))`));
  // Back to the conflict screen for the rest of the run. By the rail's own
  // aria-label: its buttons carry no text, and the `title` is a hint sentence
  // that has been reworded before.
  check("the rail can bring us back", await cdp.ev(
    `(()=>{const b=document.querySelector('button[aria-label="Git"]');if(!b)return false;b.click();return true})()`));
  await Bun.sleep(2500);

  if (process.env.AGX_DRIVE_DEBUG) console.log("    [debug] session after the round trip:", await cdp.ev(
    `fetch('/git/merge-session?root='+encodeURIComponent(${JSON.stringify(repo)})+'&token=drive-token').then(r=>r.text())`));
  check("the last button opens the review", await clickText(cdp, "/Review and/"));
  await Bun.sleep(1000);
  const revT = await text(cdp);
  if (process.env.AGX_DRIVE_DEBUG) console.log("    [debug] review:", JSON.stringify(revT.replace(/\s+/g," ").slice(0,220)));
  // The bug this whole screen exists to prevent, in miniature: a commit that
  // carries files it never showed you.
  check("the review lists the files you decided", (revT.match(/you decided this/g) || []).length === 5,
    (revT.match(/you decided this/g) || []).length);
  check("and the ones that merged themselves", /35 files/.test(revT), (revT.match(/\d+ files/) || [])[0]);
  check("and the footer agrees with the list", /5 of these you decided; the other 30/.test(revT));
  check("the commit is confirmed from here", await cdp.ev(`!![...document.querySelectorAll('button')].find(e=>/Commit the merge/.test(e.textContent))`));
  await shot("merge-04-review");
});

console.log("rebase: a loop, not one ending");
await drive("rebase", async (cdp, shot, repo) => {
  const t0 = await text(cdp);
  check("names it a rebase", /Rebasing/.test(t0));
  check("says which commit of how many", /commit 1 of 3/.test(t0), (t0.match(/commit \d+ of \d+/) || [])[0]);
  check("the primary action says continue, not commit", /Review and continue/.test(t0));
  await shot("rebase-01");

  for (const f of ["a.ts", "bun.lock", "knobs.ts"]) {
    await clickExact(cdp, f);
    await Bun.sleep(1200);
    await clickText(cdp, "/^all (ours|main)/");
    await Bun.sleep(1400);
    await clickText(cdp, "/^Take ours$/");
    await Bun.sleep(1600);
  }
  check("this stop is settled", /3 of 3 files resolved/.test(await text(cdp)));

  await clickText(cdp, "/Review and/");
  await Bun.sleep(1000);
  const revT = await text(cdp);
  check("the review says the rebase is not over", /commit 1 of 3 — the rebase continues after it/.test(revT));
  await shot("rebase-02-review");

  // Continuing is two clicks: the primary opens a confirmation, and the
  // confirmation is what actually runs it.
  check("the primary offers to continue", await clickText(cdp, "/Continue the rebase/"));
  await Bun.sleep(900);
  check("and asks first", await clickExact(cdp, "Continue"));
  await Bun.sleep(5000);
  if (process.env.AGX_DRIVE_DEBUG) {
    // Where the REPOSITORY ended up, so a stuck screen can be told apart from
    // a stuck repo — the distinction that took three rounds to establish the
    // first time, when the real answer turned out to be neither (the fixture
    // had no git identity, so the rebase could not make its commit).
    console.log("    [debug] server:", await cdp.ev(
      `fetch('/git/merge-info?root='+encodeURIComponent(${JSON.stringify(repo)})+'&token=drive-token').then(r=>r.text())`));
    console.log("    [debug] screen:", JSON.stringify((await text(cdp)).replace(/\s+/g, " ").slice(0, 200)));
  }

  const nextT = await text(cdp);
  // The second bug: the review of commit 1 stayed up while commit 2 was
  // already conflicted underneath it, marking its untouched file "you decided
  // this" and offering to commit.
  check("the next stop replaces the review", /Rebasing/.test(nextT));
  check("and it is the next commit", /commit 2 of 3/.test(nextT), (nextT.match(/commit \d+ of \d+/) || [])[0]);
  check("with its own file, undecided", /0 of 1 file resolved/.test(nextT), (nextT.match(/\d+ of \d+ files? resolved/) || [])[0]);
  check("and nothing claiming to be decided", !/you decided this/.test(nextT));
  await shot("rebase-03-next");
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
