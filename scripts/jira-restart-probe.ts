/**
 * A TRUE restart of the Jira board, in the real Electron shell: Assigned to me, one filter on, the app quit, the app started
 * again on the same profile, the same view opened. Prints before/after (chips, the Jira keys of localStorage) and exits 1
 * when the filter is gone after the restart.
 *
 *   bun run scripts/jira-restart-probe.ts            (builds web/dist when it is missing; needs an Electron binary)
 *   ELECTRON_PATH=/path/to/electron bun run scripts/jira-restart-probe.ts
 *
 * Everything is isolated: the server runs from this worktree on a free port with its own XDG_*, state dir, database and
 * tmux dir, against the fake Jira of the server tests (POST /jira/connect); Electron gets its own --user-data-dir and is
 * pointed at that server through AGENTGLASS_PORT, as scripts/loadwindow.ts does. Nothing of the person's own is read or written.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, until, type CDP } from "./cdp.ts";
import { privateTmuxDir } from "./tmuxTmp.ts";
import { findElectron, launchElectronShell } from "./loadwindow.ts";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira } from "../server/test/fixtures/fakeJira.ts";

const ROOT = resolve(import.meta.dir, "..");
/** --one: the old single-filter case (one status row). Default: the person's set, one Space + one Status + Show done. */
const ONE = process.argv.includes("--one");
/** Ways to lose the filter on quit, tried one at a time (default: none, the plain slow window.close quit):
 *  --fast    (a) quit ~200 ms after the last tick, no settle time, so a debounced save is still pending
 *  --sigterm (b) quit by SIGTERM to the electron pid, not window.close
 *  --two     (c) a second Tasks panel (the bench, "+" > Tasks) is opened in the same window and then hidden before the filter is set
 *  --team    (d) the Team view tab is the active one at quit; run 2 reads Mine again after it opens */
const FAST = process.argv.includes("--fast"), SIGTERM = process.argv.includes("--sigterm"), TWO = process.argv.includes("--two"), TEAM = process.argv.includes("--team");
const say = (s: string) => console.log(`[probe] ${s}`);

function freePort(): number {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = l.port;
  l.stop(true);
  return p;
}

const home = mkdtempSync(join(tmpdir(), "agx-jira-restart-"));
for (const d of ["config", "data", "cache", "user-data", "state", "project"]) mkdirSync(join(home, d), { recursive: true });
const project = join(home, "project");
spawnSync("git", ["init", "-q", project]);
writeFileSync(join(project, "README.md"), "# orbit\n");

const fake = startFakeJira();
// The person's Assigned to me spans several spaces: the fake's open ACME card (ACME-7; ACME-8 is Done and Mine hides it) goes to the fake account, so the Spaces facet lists ORBIT and ACME.
fake.state.issues["ACME-7"]!.assignee = "acc-0001";
const port = freePort();
const url = `http://127.0.0.1:${port}`;
let server: ChildProcess | null = null;
let shellPid = 0;
let serverLog = "";

async function startServer(): Promise<void> {
  if (!existsSync(join(ROOT, "web", "dist", "index.html"))) {
    say("web/dist is missing: bun run build");
    const b = spawnSync("bun", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 580_000 });
    if (b.status !== 0 || !existsSync(join(ROOT, "web", "dist", "index.html"))) throw new Error("the web build failed: " + (b.stderr || b.stdout || "").slice(-400));
  }
  server = spawn("bun", ["run", join(ROOT, "server", "src", "index.ts")], {
    env: {
      PATH: process.env.PATH ?? "", HOME: home,
      XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
      AGENTGLASS_STATE_DIR: join(home, "state"), AGENTGLASS_ROOT: home, AGENTGLASS_DB: join(home, "agentglass.db"),
      AGENTGLASS_WEB_DIR: join(ROOT, "web", "dist"), AGENTGLASS_PORT: String(port), AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_JIRA_BASE: fake.base, TMUX_TMPDIR: privateTmuxDir(home),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const s of [server.stdout!, server.stderr!]) s.on("data", (c) => { serverLog += String(c); });
  for (let i = 0; i < 150; i++) {
    if (await fetch(url + "/health").then((r) => r.ok).catch(() => false)) break;
    await Bun.sleep(100);
  }
  if (!(await fetch(url + "/health").then((r) => r.ok).catch(() => false))) throw new Error("server did not come up: " + serverLog.slice(0, 400));
  const post = (path: string, body: unknown) => fetch(url + path, { method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify(body) });
  const c = await post("/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
  if (!c.ok) throw new Error(`POST /jira/connect refused: ${c.status} ${(await c.text()).slice(0, 200)}`);
  const w = await post("/workspace", { roots: [project] });
  if (!w.ok) throw new Error(`POST /workspace refused: ${w.status} ${(await w.text()).slice(0, 200)}`);
}

/** Launch the real shell the way scripts/loadwindow.ts does (Hyprland: silent workspace, no focus); resolves with a CDP handle on its agentglass://app page. */
let lastDport = 0;
async function launch(): Promise<CDP> {
  const dport = freePort();
  const r = await launchElectronShell({ root: ROOT, url, dport, profile: home, step: say });
  shellPid = r.pid;
  lastDport = dport;
  const cdp = await connect(dport, 120, (t) => t.type === "page" && String(t.url).startsWith("agentglass://app"));
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem('agentglass.projectChosen','1')}catch(e){}` });
  await cdp.send("Page.reload");
  await until(cdp, `document.querySelector('#root')?.children.length && !document.documentElement.classList.contains('ag-covering')`, "the window to draw", 30_000);
  return cdp;
}

const clickText = (cdp: CDP, sel: string, re: string) =>
  cdp.ev(`(()=>{const r=new RegExp(${JSON.stringify(re)},'i');const el=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>r.test((e.getAttribute('aria-label')||e.textContent||'').trim())).sort((a,b)=>a.textContent.length-b.textContent.length)[0];el?.click();return !!el})()`);

/** Tasks > Jira > Assigned to me. */
async function openAssigned(cdp: CDP): Promise<void> {
  await Bun.sleep(1500);
  if (!(await cdp.ev(`!!document.querySelector('[role="tablist"][aria-label="Workspace views"]')`))) {
    await cdp.ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'\\\\',ctrlKey:true,bubbles:true}))`);
  }
  await until(cdp, `document.querySelector('[data-view="tasks"]')`, "the Tasks view button", 25_000);
  await cdp.ev(`document.querySelector('[data-view="tasks"]').click()`);
  await Bun.sleep(800);
  // The tracker switch: Jira, when the Tasks view opens on another source.
  await clickText(cdp, "button,[role=tab],[role=menuitem]", "^jira$");
  await until(cdp, `[...document.querySelectorAll('*')].some(e=>e.children.length===0&&/^assigned to me/i.test((e.textContent||'').trim()))`, "the Assigned to me row", 30_000);
  await cdp.ev(`(()=>{const el=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&/^assigned to me/i.test((e.textContent||'').trim()))[0];(el.closest('button,[role=treeitem],[role=button],a')||el).click();return 1})()`);
  await until(cdp, `document.querySelector('.agx-jf-row, [role="tablist"]')`, "the board to draw", 30_000);
  await Bun.sleep(2000);
}

/** Open the Filters menu and tick the first unticked row of each named facet (Status, Spaces) and each quick chip (Show done), as a person clicks; then close the popover the way a person does (Escape). */
async function applyFilter(cdp: CDP, one: boolean): Promise<string> {
  if (!(await clickText(cdp, "button", "^filters"))) throw new Error("no Filters button on the board");
  await until(cdp, `document.querySelector('[role="menuitemcheckbox"]')`, "a facet row", 10_000);
  const tick = async (facet: string): Promise<string> => {
    const label = await cdp.ev(`(()=>{const sec=document.querySelector('section[aria-label=${JSON.stringify(facet)}]');const r=[...(sec?.querySelectorAll('[role="menuitemcheckbox"]')??[])].find(e=>e.getAttribute('aria-checked')==='false');if(!r) return '';const t=(r.textContent||'').trim();r.click();return t})()`);
    if (!label) {
      const dump = await cdp.ev(`(()=>[...document.querySelectorAll('section[aria-label]')].map(s=>({facet:s.getAttribute('aria-label'),rows:[...s.querySelectorAll('[role="menuitemcheckbox"]')].map(r=>(r.getAttribute('aria-checked')==='true'?'[x] ':'[ ] ')+(r.textContent||'').trim())})))()`);
      console.error(`[probe] facets in the Filters menu: ${JSON.stringify(dump)}`);
      throw new Error(`no unticked row in the ${facet} facet`);
    }
    await Bun.sleep(600);
    return `${facet}: ${label}`;
  };
  const picked: string[] = [];
  if (one) {
    // The old one-filter case: the first row of the first facet that has one.
    const label = await cdp.ev(`(()=>{const r=[...document.querySelectorAll('[role="menuitemcheckbox"]')].find(e=>e.getAttribute('aria-checked')==='false');if(!r) return '';const t=(r.textContent||'').trim();r.click();return t})()`);
    if (!label) throw new Error("no unticked facet row to apply");
    picked.push(String(label));
    await Bun.sleep(600);
  } else {
    // Count the spaces BEFORE ticking one: a ticked space narrows the search to it, one space is left and the facet hides itself.
    const spaceRows = await cdp.ev(`[...document.querySelectorAll('section[aria-label="Spaces"] [role="menuitemcheckbox"]')].map(r=>(r.textContent||'').trim())`);
    const keys = await cdp.ev(`[...new Set((document.body.innerText.match(/\\b(?:ORBIT|ACME)-\\d+\\b/g)||[]))]`);
    say(`loaded card keys: ${JSON.stringify(keys)}; Spaces facet rows: ${JSON.stringify(spaceRows)}`);
    if (!Array.isArray(spaceRows) || spaceRows.length < 2) throw new Error(`the Spaces facet lists ${JSON.stringify(spaceRows)}, wanted ORBIT and ACME`);
    picked.push(await tick("Spaces")); // ORBIT sorts first
    picked.push(await tick("Status"));
    if (!(await clickText(cdp, "button,[role=checkbox],[role=menuitemcheckbox]", "^show done$"))) throw new Error("no Show done chip in the Quick facet");
    picked.push("Show done");
    await Bun.sleep(600);
  }
  // Close the popover without its Done button, then leave the tab and come back, as a person looks around before quitting.
  await cdp.ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await Bun.sleep(800);
  if (!one) {
    await cdp.ev(`document.querySelector('[data-view="git"],[data-view="files"],[data-view="terminal"]')?.click()`);
    await Bun.sleep(1500);
    await cdp.ev(`document.querySelector('[data-view="tasks"]')?.click()`);
    await Bun.sleep(2000);
  }
  return picked.join(" + ");
}

interface Snap { chips: string[]; storage: Record<string, string>; tabLit: string }
async function snap(cdp: CDP): Promise<Snap> {
  return (await cdp.ev(`(()=>{
    const chips=[...document.querySelectorAll('button[aria-label^="Remove "]')].map(b=>b.getAttribute('aria-label').slice(7));
    const storage={};
    try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(/jira/i.test(k)) storage[k]=localStorage.getItem(k)}}catch(e){}
    const lit=document.querySelector('[role="tab"][aria-selected="true"]');
    return {chips,storage,tabLit:lit?(lit.textContent||'').trim():''}})()`)) as Snap;
}

/** (c) A second Tasks panel in the SAME window, the way a person gets one: open the bench (Ctrl+Alt+A), "+" > Tasks, so the bench holds a Tasks board too; then close the bench, so one panel is hidden and the view's is the visible one. */
async function openSecondPanel(cdp: CDP): Promise<void> {
  const count = () => cdp.ev(`document.querySelectorAll('button').length && [...document.querySelectorAll('button')].filter(b=>/^filters/i.test((b.textContent||'').trim())).length`);
  say(`Filters buttons before the bench: ${await count()}`);
  const toggle = () => cdp.ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'a',code:'KeyA',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}))`);
  await toggle();
  await until(cdp, `document.querySelector('[data-bench-plus]')`, "the bench to open", 10_000);
  await cdp.ev(`document.querySelector('[data-bench-plus]').click()`);
  await Bun.sleep(500);
  if (!(await clickText(cdp, "button,[role=menuitem]", "^tasks$"))) throw new Error("no Tasks row in the bench's + menu");
  await Bun.sleep(2500);
  say(`Filters buttons with the bench open on Tasks: ${await count()}`);
  await toggle(); // the bench closes: its Tasks panel is hidden, the view's is the visible one
  await Bun.sleep(1500);
  say(`Filters buttons after the bench closed: ${await count()}`);
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitGone(pid: number, ms: number): Promise<boolean> {
  for (let t = 0; t < ms && alive(pid); t += 200) await Bun.sleep(200);
  return !alive(pid);
}
async function quit(cdp: CDP): Promise<void> {
  const pid = shellPid;
  if (SIGTERM) { say("quit by SIGTERM to the electron pid"); cdp.close(); try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } if (!(await waitGone(pid, 15_000))) { say("SIGTERM did not quit the shell: SIGKILL"); try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } shellPid = 0; return; }
  await cdp.ev(`setTimeout(()=>window.close(),50)`).catch(() => {});
  cdp.close();
  if (pid && !(await waitGone(pid, 15_000))) { say("window.close did not quit the shell: SIGTERM"); try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } await waitGone(pid, 10_000); }
  shellPid = 0;
}

let code = 0;
try {
  say(`home ${home}  server ${url}  electron ${findElectron(ROOT)}`);
  await startServer();

  let cdp = await launch();
  say("run 1: Tasks > Jira > Assigned to me");
  await openAssigned(cdp);
  if (TWO) { say("second Tasks panel in the same window (the bench), then hidden"); await openSecondPanel(cdp); }
  const picked = await applyFilter(cdp, ONE);
  const before = await snap(cdp);
  say(`filter applied: ${picked}`);
  console.log("BEFORE", JSON.stringify(before, null, 2));
  if (TEAM) {
    if (!(await clickText(cdp, "[role=tab]", "^team$"))) throw new Error("no Team tab to leave active at quit");
    await Bun.sleep(800);
    say(`Team tab lit at quit: ${JSON.stringify((await snap(cdp)).tabLit)}`);
  }
  if (FAST) await Bun.sleep(200); else await Bun.sleep(1500); // let the store flush what was written
  say(`quitting (${[FAST && "fast", SIGTERM && "sigterm", TWO && "second panel", TEAM && "team tab"].filter(Boolean).join(", ") || "plain"})`);
  await quit(cdp);

  say("run 2: same profile, started again");
  cdp = await launch();
  const early = await snap(cdp);
  console.log("AFTER BOOT (before opening the view)", JSON.stringify(early, null, 2));
  await openAssigned(cdp);
  await Bun.sleep(2500);
  if (TEAM) { await clickText(cdp, "[role=tab]", "^mine$"); await Bun.sleep(1500); }
  const after = await snap(cdp);
  console.log("AFTER", JSON.stringify(after, null, 2));
  await quit(cdp);

  if (!ONE && !["Spaces:", "Show done"].every((w) => before.chips.some((c) => c.startsWith(w)))) throw new Error(`the person's filters did not show before the restart: ${JSON.stringify(before.chips)}`);
  const kept = after.chips.length > 0 && before.chips.every((c) => after.chips.includes(c));
  say(kept ? "PASS: the filter is back after the restart" : `FAIL: the filter is gone after the restart (before ${JSON.stringify(before.chips)}, after ${JSON.stringify(after.chips)})`);
  if (!kept) code = 1;
} catch (e) {
  console.error(`[probe] ERROR ${e instanceof Error ? e.stack ?? e.message : e}`);
  if (serverLog) console.error("[probe] server log tail:\n" + serverLog.slice(-1200));
  code = 2;
} finally {
  if (shellPid) try { process.kill(shellPid, "SIGKILL"); } catch { /* gone */ }
  server?.kill("SIGTERM");
  fake.stop?.();
  if (!process.env.AGX_PROBE_KEEP) rmSync(home, { recursive: true, force: true }); else say(`kept ${home}`);
}
process.exit(code);
