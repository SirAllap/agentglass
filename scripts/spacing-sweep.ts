#!/usr/bin/env bun
/**
 * Walk the running app and measure every gap that is too small for what it
 * separates.
 *
 * Why this exists: "the spacing between elements follows no rule, things are
 * stuck together and it looks ugly" is a true report that no grep can act on.
 * A value can be perfectly on the scale and still be 2px where it wanted 12 —
 * the grid says the number is legal, not that it is right. The only way to find
 * those is to look at the app, and the only way to look at 43 states without
 * missing half of them is to have something else do the looking.
 *
 * It found exactly one dominant defect on its first real run: `SettingRow` drew
 * a row's hint 2px under its label, on every settings pane there is.
 *
 *   bun scripts/spacing-sweep.ts                  # against http://localhost:4000
 *   bun scripts/spacing-sweep.ts --url http://localhost:5173
 *   bun scripts/spacing-sweep.ts --out /tmp/sweep # screenshots + findings.json
 *
 * NOT part of CI, deliberately. It needs a server with real projects behind it,
 * and it reports judgement calls rather than pass/fail — a number that moves
 * when somebody legitimately makes a list denser would be a test that gets
 * disabled. `web/test/spacing-scale.test.ts` is the part that belongs in CI;
 * this is the part you run when somebody says it looks wrong.
 *
 * ── On trusting it ──────────────────────────────────────────────────────────
 * The detector was wrong three times before it was right, and each wrongness is
 * now a rule in the code below. Read them before believing a number:
 *
 *   1. Measuring border-box gaps alone reported 737 "touching" pairs, nearly
 *      all of them padded lists that visibly breathe. The room a person sees is
 *      the box gap PLUS the padding each side holds in reserve.
 *   2. Judging that room against a constant is wrong: 4px under 10px type is
 *      not 4px under 15px type. It is judged against the type it separates.
 *   3. Left edges that differ inside a CENTRED container are the layout
 *      working, not failing. Both "misalignment" findings before this exclusion
 *      were exactly that.
 *
 * Anything it still reports in a diff view is very likely right and very likely
 * fine: source lines at 0px are what a code viewer is supposed to look like.
 */
import { spawn } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const URL_ = arg("url", "http://localhost:4000");
const OUT = arg("out", join(tmpdir(), "agentglass-spacing-sweep"));

/** Chrome, resolved the way scripts/smoke.ts resolves it. */
function findChrome(): string {
  const pinned = process.env.CHROME_PATH?.trim();
  if (pinned) {
    if (existsSync(pinned) || Bun.which(pinned)) return pinned;
    throw new Error(`CHROME_PATH is set to ${pinned}, which does not exist`);
  }
  for (const c of ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "google-chrome",
    "chromium", "chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
    if (existsSync(c) || Bun.which(c)) return c;
  }
  throw new Error("no Chrome found — set CHROME_PATH");
}

// ---------------------------------------------------------------------------
// the detector, evaluated inside the page
// ---------------------------------------------------------------------------

const PROBE = String.raw`
window.__agxProbe = (state) => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 3 && r.height > 3 && s.visibility !== "hidden" && s.opacity !== "0"; };
  const txt = (e) => (e.textContent || "").trim();
  const own = (e) => { const t = txt(e); return t.length > 0 && t.length < 200; };
  /* Something that draws its own edge separates without needing a gap. */
  const sep = (e) => { const s = getComputedStyle(e);
    return s.borderTopWidth !== "0px" || s.borderBottomWidth !== "0px" ||
      (s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent"); };
  /* Where a finding IS. The whole point of the path: a title computed at
     runtime cannot be grepped for, so the sweep has to hand back the route to
     it or the finding is unactionable. */
  const pathOf = (e) => {
    const out = [];
    for (let n = e; n && n.nodeType === 1 && out.length < 6; n = n.parentElement) {
      const cls = (n.className || "").toString().trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
      out.unshift(n.tagName.toLowerCase() + (cls ? "." + cls : ""));
    }
    return out.join(" > ");
  };
  const F = [];
  const push = (kind, d) => F.push({ state, kind, ...d });

  for (const el of document.querySelectorAll("*")) {
    if (!vis(el)) continue;
    const kids = [...el.children].filter(vis);
    if (kids.length < 2) continue;
    const boxes = kids.map((k) => ({ k, r: k.getBoundingClientRect() }));
    const stacked = boxes.every((b, i) => i === 0 || b.r.top >= boxes[i-1].r.bottom - 1);
    const es = getComputedStyle(el);

    /* A — left edges that do not line up. Centred containers excluded: there
       the edges differ BECAUSE the content is centred (rule 3). */
    if (stacked && es.alignItems !== "center" && es.textAlign !== "center") {
      const withText = boxes.filter((b) => own(b.k));
      const lefts = [...new Set(withText.map((b) => Math.round(b.r.left)))];
      if (lefts.length > 1) {
        const spread = Math.max(...lefts) - Math.min(...lefts);
        /* Under 1px is subpixel; over 10px reads as deliberate indentation. */
        if (spread >= 1 && spread <= 10) {
          push("edges", { spread, lefts: lefts.slice(0, 5), path: pathOf(el),
            who: withText.slice(0, 3).map((b) => txt(b.k).slice(0, 26)) });
        }
      }
    }

    /* B — a group heading with no more room above it than between its items,
       so it reads as belonging to what is above rather than to what it names. */
    for (let i = 0; i < boxes.length; i++) {
      const s = getComputedStyle(boxes[i].k);
      const heading = (s.textTransform === "uppercase" && parseFloat(s.fontSize) <= 13)
        || parseFloat(s.letterSpacing) >= 1.2;
      if (!heading || !own(boxes[i].k)) continue;
      const room = (a, b) => (b.r.top - a.r.bottom)
        + parseFloat(getComputedStyle(a.k).paddingBottom) + parseFloat(getComputedStyle(b.k).paddingTop);
      const above = i > 0 ? room(boxes[i-1], boxes[i]) : null;
      const below = i < boxes.length - 1 ? room(boxes[i], boxes[i+1]) : null;
      /* Negative means they overlap — a horizontal or grid layout this walk
         misread as stacked, not a defect. */
      if (above !== null && below !== null && above >= 0 && above <= below + 1 && above < 24) {
        push("heading", { label: txt(boxes[i].k).slice(0, 26), path: pathOf(boxes[i].k),
          above: Math.round(above), below: Math.round(below) });
      }
    }

    /* C — two blocks of text with no room between them and nothing drawing a
       line there either. Rules 1 and 2 both live in this one expression. */
    if (stacked) for (let i = 1; i < boxes.length; i++) {
      const a = boxes[i-1], b = boxes[i];
      if (!own(a.k) || !own(b.k)) continue;
      const sa = getComputedStyle(a.k), sb = getComputedStyle(b.k);
      const room = (b.r.top - a.r.bottom) + parseFloat(sa.paddingBottom) + parseFloat(sb.paddingTop);
      const fs = Math.max(parseFloat(sa.fontSize) || 12, parseFloat(sb.fontSize) || 12);
      if (room >= -0.5 && room < fs * 0.34 && !sep(a.k) && !sep(b.k) && a.r.height > 10 && b.r.height > 10) {
        push("touching", { room: Math.round(room), fs: Math.round(fs), path: pathOf(b.k),
          a: txt(a.k).slice(0, 24), b: txt(b.k).slice(0, 24) });
      }
    }
  }
  const seen = new Set(); const out = [];
  for (const f of F) { const k = JSON.stringify(f); if (!seen.has(k)) { seen.add(k); out.push(f); } }
  return out;
};`;

// ---------------------------------------------------------------------------
// driving
// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "agentglass-sweep-"));
const chrome = spawn({
  cmd: [findChrome(), "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--window-size=1600,1000", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  stdout: "ignore", stderr: "ignore",
});
const portFile = join(profile, "DevToolsActivePort");
let base = "";
for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
  if (existsSync(portFile)) { base = `http://127.0.0.1:${readFileSync(portFile, "utf8").split("\n")[0]!.trim()}`; break; }
  await Bun.sleep(120);
}
if (!base) { chrome.kill(); throw new Error("Chrome did not start"); }

const page = (await (await fetch(`${base}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[])
  .find((t) => t.type === "page")!;
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const waiting = new Map<number, (v: unknown) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data)) as { id?: number };
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
};
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((res) => { const n = ++seq; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression: string) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shoot = async (name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`), Buffer.from(r.result.data, "base64"));
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: URL_ });
await Bun.sleep(6000);
/* Open a project so the panels have something in them: an empty panel is a
   layout nobody ships and its spacing tells you nothing. */
await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/\\/home\\/|\\/Users\\//.test(x.textContent||''));if(b)b.click();})()`);
await Bun.sleep(3500);
const escape = async () => {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  }
  await Bun.sleep(700);
};
await escape();

const findings: Record<string, unknown>[] = [];
const states: string[] = [];
const scan = async (name: string, shot = false) => {
  await evaluate(PROBE);
  const rows = JSON.parse((await evaluate(`JSON.stringify(window.__agxProbe(${JSON.stringify(name)}))`)) || "[]");
  findings.push(...rows);
  states.push(name);
  if (shot || rows.length) await shoot(name);
  console.log(`· ${name.padEnd(34)} ${String(rows.length).padStart(3)}`);
};
/*
 * Read, then decide here, then click by INDEX.
 *
 * Both of these used to build the expression that runs in the page out of the
 * label or the pattern they were given — `…===${JSON.stringify(label)}` and
 * `new RegExp(${JSON.stringify(re)})`. The values are literals written a few
 * lines below, so nothing could ever have been injected through them, but the
 * shape is code assembled from data and a scanner is right to say so: change
 * one of these call sites to take a repository name, a branch or anything else
 * read off a machine, and the same two lines become an injection.
 *
 * So the page is only ever asked two fixed questions — "what are the labels"
 * and "what is the text" — the matching happens in this process, and the click
 * is sent as a number. No value from here reaches a string that is evaluated.
 */
const CLICKABLE = "button,[role=tab],a";
const clickNth = async (selector: string, i: number) =>
  (await evaluate(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})][${Number(i)}];if(!b)return false;b.click();return true;})()`)) === true;

const byLabel = async (label: string, wait = 2400) => {
  const labels: string[] = JSON.parse(
    (await evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(CLICKABLE)})].map(x=>x.getAttribute('aria-label')||''))`)) || "[]",
  );
  const i = labels.indexOf(label);
  if (i < 0) return false;
  const ok = await clickNth(CLICKABLE, i);
  await Bun.sleep(wait);
  return ok;
};
const byText = async (re: string, wait = 1800) => {
  const SEL = "button,[role=tab],summary,a";
  const texts: Array<{ t: string; shown: boolean }> = JSON.parse(
    (await evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(SEL)})].map(x=>({t:(x.textContent||'').trim(),shown:!!x.offsetParent})))`)) || "[]",
  );
  const rx = new RegExp(re);
  const i = texts.findIndex((x) => x.shown && rx.test(x.t));
  if (i < 0) return false;
  const ok = await clickNth(SEL, i);
  await Bun.sleep(wait);
  return ok;
};

for (const v of ["Git", "Diff", "Pull requests", "Tasks", "Docker", "Term", "Files", "Dashboard", "Chat", "Ports", "Resources"]) {
  if (await byLabel(v, 3000)) await scan(`view:${v}`, true);
}
await byLabel("Git", 2500);
for (let n = 2; n <= 9; n++) if (await byLabel(`${["", "", "Log", "Reflog", "Branches", "Remotes", "Tags", "Worktrees", "Stashes", "Tidy"][n]} — press ${n}`, 2000)) {
  await scan(`git:step${n}`);
}
await byLabel("Tasks", 3000);
for (const t of ["All", "GitHub", "Local", "ClickUp"]) if (await byText(`^${t}$`, 2400)) await scan(`tasks:${t}`);

await byLabel("Settings", 2500);
const panes: string[] = JSON.parse((await evaluate(
  `JSON.stringify([...document.querySelectorAll('button')].filter(b=>b.offsetParent&&(b.className||'').includes('w-full text-left px-2.5')).map(b=>(b.textContent||'').trim().slice(0,24)))`)) || "[]");
for (const p of panes) if (await byText(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, 1500)) await scan(`settings:${p}`);
await escape();

for (const [label, name] of [["Skills catalog", "Skills"], ["Notifications", "Notifications"],
  ["Search anything (⌘K)", "Search"], ["Find a file (Ctrl+Shift+P)", "FindFile"]] as const) {
  if (await byLabel(label, 2000)) { await scan(`modal:${name}`, true); await escape(); }
}
await byLabel("Git", 2400);
for (const d of ["Commands", "Worktree"]) if (await byText(d, 1600)) { await scan(`dropdown:${d}`, true); await escape(); }
/* A context menu is the one surface nothing else in this sweep reaches, and the
   one nobody remembers to look at. */
await evaluate(`(()=>{const r=[...document.querySelectorAll('[class*=agx],li,tr,button')].filter(x=>x.offsetParent&&x.getBoundingClientRect().height>16&&x.getBoundingClientRect().height<48)[8];
  if(r) r.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:200,clientY:300}));})()`);
await Bun.sleep(1200);
await scan("contextmenu:row", true);

writeFileSync(join(OUT, "findings.json"), JSON.stringify(findings, null, 1));
const byKind: Record<string, number> = {};
for (const f of findings) byKind[String(f.kind)] = (byKind[String(f.kind)] ?? 0) + 1;
console.log(`\n${states.length} states · ${findings.length} findings · ${JSON.stringify(byKind)}`);
console.log(`screenshots and findings.json → ${OUT}`);
ws.close();
chrome.kill();
