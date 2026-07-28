#!/usr/bin/env bun
/**
 * Drive the phone companion in a real browser, at a real phone viewport, and
 * report what breaks.
 *
 * The companion shipped with faults that no unit test could have caught and no
 * amount of reading did catch: a header pinned under another header, a composer
 * hidden behind the browser's own URL bar, file paths that came back with a
 * `w/` on the front and could not be staged. Every one of them needed the thing
 * to actually be opened and poked. This is that, written down and repeatable.
 *
 * It is deliberately READ-ONLY. It opens screens, reads what rendered, and
 * checks invariants; it never sends a message, stages a file, restarts a
 * container or touches a pull request, because it runs against the real server
 * on this machine with the real fleet in it.
 *
 *   bun scripts/phone-audit.ts                  # against a server on :4055
 *   AUDIT_ORIGIN=http://127.0.0.1:4001 bun scripts/phone-audit.ts
 *
 * Exit code is the number of failed checks, so it can gate a commit.
 */

import { spawn } from "bun";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, findChrome, until, type CDP } from "./cdp.ts";

const ORIGIN = process.env.AUDIT_ORIGIN || "http://127.0.0.1:4055";
const SHOTS = process.env.AUDIT_SHOTS || join(tmpdir(), "agentglass-phone-audit");
/** A Pixel-ish viewport: the layout switches itself below 768px. */
const PHONE = { w: 412, h: 915, scale: 2 };

type Check = { screen: string; what: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const note = (screen: string, what: string, ok: boolean, detail?: string) => {
  checks.push({ screen, what, ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${screen} · ${what}${ok || !detail ? "" : `\n        ${detail}`}`);
};

/** Injected before any app code: the page's own error channels, collected. */
const COLLECTOR = `
window.__audit = { errors: [], net: [] };
addEventListener("error", (e) => window.__audit.errors.push(String(e.message || e.error)));
addEventListener("unhandledrejection", (e) => window.__audit.errors.push("unhandled: " + String(e.reason)));
(() => {
  const ce = console.error;
  console.error = (...a) => { try { window.__audit.errors.push(a.map(String).join(" ")); } catch {} ce(...a); };
  const of = window.fetch;
  window.fetch = async (...a) => {
    const r = await of(...a);
    if (!r.ok) window.__audit.net.push(r.status + " " + (typeof a[0] === "string" ? a[0] : a[0].url));
    return r;
  };
})();
`;

const drain = async (cdp: CDP, screen: string) => {
  const a = await cdp.ev("JSON.stringify(window.__audit || {errors:[],net:[]})");
  const { errors, net } = JSON.parse(a || '{"errors":[],"net":[]}');
  note(screen, "no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  note(screen, "no failed requests", net.length === 0, net.slice(0, 3).join(" | "));
  await cdp.ev("window.__audit = { errors: [], net: [] }");
};

const shot = async (cdp: CDP, name: string) => {
  const png = await cdp.shot();
  writeFileSync(join(SHOTS, `${name}.png`), png);
};

/** Text of everything matching a selector, for eyeballing a list in one read. */
const texts = (cdp: CDP, sel: string) =>
  cdp.ev(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.textContent.trim()).slice(0,40))`)
    .then((s: string) => JSON.parse(s || "[]") as string[]);

const tap = async (cdp: CDP, sel: string, needle?: string) => {
  const hit = await cdp.ev(`(()=>{const els=[...document.querySelectorAll(${JSON.stringify(sel)})];
    const el = ${needle ? `els.find(e=>e.textContent.includes(${JSON.stringify(needle)}))` : "els[0]"};
    if(!el) return false; el.click(); return true;})()`);
  await Bun.sleep(700);
  return !!hit;
};

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "agx-audit-"));
  const port = 9333;
  const chrome = spawn([
    findChrome(),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--hide-scrollbars",
    "--no-first-run",
    `--window-size=${PHONE.w},${PHONE.h}`,
    "about:blank",
  ], { stdout: "ignore", stderr: "ignore" });

  const cdp = await connect(port);
  try {
    // A phone, not a narrow desktop: touch, coarse pointer, device pixels.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: PHONE.w, height: PHONE.h, deviceScaleFactor: PHONE.scale, mobile: true,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: COLLECTOR });

    await cdp.send("Page.navigate", { url: ORIGIN + "/" });
    await until(cdp, `document.querySelector(".mb")`, "the phone shell", 25_000);
    await Bun.sleep(1200);

    // ---- shell -------------------------------------------------------
    note("shell", "phone layout chosen",
      (await cdp.ev(`document.documentElement.dataset.layout`)) === "phone");
    note("shell", "tab bar is on screen",
      await cdp.ev(`(()=>{const n=document.querySelector("nav");if(!n)return false;
        const r=n.getBoundingClientRect();return r.bottom<=innerHeight+1&&r.top<innerHeight;})()`));
    await shot(cdp, "01-now");
    await drain(cdp, "shell");

    // ---- Now ---------------------------------------------------------
    const nowText = await cdp.ev(`document.querySelector("main")?.textContent?.trim()?.length || 0`);
    note("now", "renders something", nowText > 20, `main had ${nowText} chars`);

    // ---- Chats -------------------------------------------------------
    note("chats", "tab opens", await tap(cdp, "nav button", "Chats"));
    await Bun.sleep(900);
    const scopes = await texts(cdp, "main button");
    note("chats", "scope chips present",
      scopes.some((t) => t.startsWith("Working")) && scopes.includes("Today") && scopes.includes("All"),
      scopes.slice(0, 6).join(" / "));
    const rows = await cdp.ev(`document.querySelectorAll("main button.w-full").length`);
    note("chats", "list is not the whole archive", rows < 40, `${rows} rows on the opening scope`);
    await shot(cdp, "02-chats");
    await drain(cdp, "chats");

    // ---- a conversation ---------------------------------------------
    if (rows > 0) {
      await tap(cdp, "main button.w-full");
      await until(cdp, `document.querySelector(".mb-chat")`, "the conversation screen", 12_000);
      await Bun.sleep(1400);

      note("conversation", "one bar, no app header above it",
        await cdp.ev(`(()=>{const s=document.querySelector(".mb-chat");if(!s)return false;
          const hd=s.querySelector(".hd").getBoundingClientRect();
          const app=document.querySelector("header")?.getBoundingClientRect();
          return !app || app.bottom<=hd.top+1 || getComputedStyle(document.querySelector("header")).display==="none"
            || hd.top>=0 && s.getBoundingClientRect().top<=0;})()`));
      note("conversation", "composer is inside the viewport",
        await cdp.ev(`(()=>{const f=document.querySelector(".mb-chat .ft");if(!f)return false;
          const r=f.getBoundingClientRect();return r.bottom<=innerHeight+1&&r.top>0;})()`));
      note("conversation", "the thread is the scroller",
        await cdp.ev(`(()=>{const b=document.querySelector(".mb-chat .bd");if(!b)return false;
          return getComputedStyle(b).overflowY==="auto";})()`));
      note("conversation", "no tab bar over the chat",
        await cdp.ev(`(()=>{const n=document.querySelector("nav");if(!n)return true;
          const s=document.querySelector(".mb-chat").getBoundingClientRect();
          const r=n.getBoundingClientRect();return r.top>=s.bottom-1;})()`));
      // Scoped to the composer: the phrase can legitimately appear inside a
      // transcript that happens to be discussing it, which is exactly what a
      // body-wide search reported the first time this ran.
      note("conversation", "composer offers a way to reply",
        await cdp.ev(`(()=>{const f=document.querySelector(".mb-chat .ft");if(!f)return false;
          return !!f.querySelector("textarea") && !f.textContent.includes("did not record where it ran");})()`));
      note("conversation", "thread is scrolled to the newest turn",
        await cdp.ev(`(()=>{const b=document.querySelector(".mb-chat .bd");if(!b)return false;
          return b.scrollHeight - b.scrollTop - b.clientHeight < 80;})()`));
      await shot(cdp, "03-conversation");
      await drain(cdp, "conversation");
      await tap(cdp, ".mb-chat .hd .back");
      await Bun.sleep(700);
    }

    // ---- Repos, changes, and a diff ----------------------------------
    note("repos", "tab opens", await tap(cdp, "nav button", "Repos"));
    await Bun.sleep(1100);
    const repoRows = await cdp.ev(`document.querySelectorAll("main .mb-row, main button").length`);
    note("repos", "lists repositories", repoRows > 0, `${repoRows} rows`);
    await shot(cdp, "04-repos");

    // A repository with uncommitted work, so the changes list is not empty by
    // accident and the diff has something to draw. AUDIT_REPO names it.
    const repo = process.env.AUDIT_REPO || "";
    if (await tap(cdp, "main .mb-row, main button.w-full", repo || undefined)) {
      await until(cdp, `document.querySelector(".mb-screen.on")`, "the repo screen", 12_000);
      await Bun.sleep(1200);
      // The screen opens on whatever is wrong, which for a clean checkout is
      // the pull request list. Ask for Changes explicitly rather than reading
      // whichever facet happened to win.
      await tap(cdp, ".mb-screen.on button", "Changes");
      await Bun.sleep(1600);
      const files = await texts(cdp, ".mb-screen .mb-row b");
      note("changes", "lists the changed files", files.length > 0, `${files.length} rows`);
      note("changes", "file paths carry no diff prefix",
        files.length > 0 && !files.some((f) => /^[abciwo]\//.test(f)),
        files.filter((f) => /^[abciwo]\//.test(f)).join(", ") || "(list was empty)");
      await shot(cdp, "05-changes");
      await drain(cdp, "changes");

      // Open the first file's diff — the "it just won't load" report.
      // Scoped to the screen that is actually on: every other screen is still
      // in the DOM, parked off to the right, and clicking into one of those
      // looks exactly like a click that did nothing.
      if (files.length && await tap(cdp, ".mb-screen.on .mb-row button")) {
        await Bun.sleep(2200);
        note("diff", "the diff screen opens",
          await cdp.ev(`[...document.querySelectorAll(".mb-screen.on .hd .t b")]
            .some(b=>b.textContent.includes("."))`));
        const lines = await cdp.ev(`document.querySelectorAll(".mb-dl, .mb-diff-line, .mb-hunk").length`);
        const said = await cdp.ev(`(document.querySelector(".mb-screen.on")?.textContent || "")
          .includes("Nothing to show") ? "empty" : ""`);
        note("diff", "the diff renders lines", lines > 0 && !said, `${lines} line nodes ${said}`);
        await shot(cdp, "06-diff");
        await drain(cdp, "diff");

        // The phone's own back gesture, which is what the screen stack exists
        // for: it must close the diff and land back on the repo, not leave.
        await cdp.ev("history.back()");
        await Bun.sleep(900);
        note("back gesture", "closes the diff and keeps the repo",
          await cdp.ev(`[...document.querySelectorAll(".mb-screen.on .hd .t b")]
            .some(b=>b.textContent.trim() === ${JSON.stringify(process.env.AUDIT_REPO || "")} || !b.textContent.includes("."))`));
        await drain(cdp, "back gesture");
      }

      // Staging, the round trip. Off by default because it writes to the
      // repository under test; AUDIT_WRITE=1 opts in, and it puts the file
      // back the way it found it.
      if (process.env.AUDIT_WRITE === "1") {
        const before = await cdp.ev(`(document.querySelector(".mb-screen.on .bd")?.textContent||"").match(/(\\d+) of (\\d+) staged/)?.[1]`);
        await tap(cdp, ".mb-screen.on .mb-row .mb-sw");
        await Bun.sleep(1600);
        const after = await cdp.ev(`(document.querySelector(".mb-screen.on .bd")?.textContent||"").match(/(\\d+) of (\\d+) staged/)?.[1]`);
        note("staging", "staging a file counts it as staged",
          Number(after) === Number(before) + 1, `${before} → ${after}`);
        note("staging", "no error surfaced",
          !(await cdp.ev(`document.body.textContent.includes("did not match any files")`)));
        await shot(cdp, "10-staged");

        await tap(cdp, ".mb-screen.on .mb-row .mb-sw");
        await Bun.sleep(1600);
        const back = await cdp.ev(`(document.querySelector(".mb-screen.on .bd")?.textContent||"").match(/(\\d+) of (\\d+) staged/)?.[1]`);
        note("staging", "unstaging puts it back", Number(back) === Number(before), `${after} → ${back}`);
        await drain(cdp, "staging");
      }

      // Pull requests and containers, the other two facets of the same screen.
      for (const facet of ["Pull requests", "Containers"]) {
        if (await tap(cdp, ".mb-screen.on button", facet)) {
          await Bun.sleep(2000);
          const body = await cdp.ev(`(document.querySelector(".mb-screen.on .bd")?.textContent || "").trim().length`);
          note(facet.toLowerCase(), "renders", body > 0, `${body} chars`);
          await shot(cdp, `07-${facet.split(" ")[0]!.toLowerCase()}`);
          await drain(cdp, facet.toLowerCase());
        }
      }
      await tap(cdp, ".mb-screen.on .hd .back");
      await Bun.sleep(600);
    }

    // ---- settings ----------------------------------------------------
    if (await tap(cdp, "header button[aria-label='Settings']")) {
      await Bun.sleep(900);
      note("settings", "sheet opens", await cdp.ev(`!!document.querySelector(".mb-sheet.on")`));
      note("settings", "reports what this machine spent",
        await cdp.ev(`(document.querySelector(".mb-sheet.on")?.textContent || "").includes("Spend today")`));
      await shot(cdp, "08-settings");
      await drain(cdp, "settings");
      await cdp.ev(`document.querySelector(".mb-scrim")?.click()`);
      await Bun.sleep(600);
    }

    // ---- new chat form (opened, never sent) --------------------------
    await tap(cdp, "nav button", "Chats");
    await Bun.sleep(800);
    if (await tap(cdp, "main button", "New chat")) {
      await Bun.sleep(1500);
      const repos = await cdp.ev(`document.querySelectorAll("main select option").length`);
      note("new chat", "offers somewhere to run", repos > 0, `${repos} options`);
      note("new chat", "offers a model", await cdp.ev(`document.querySelectorAll("main button").length > 3`));
      await shot(cdp, "09-newchat");
      await drain(cdp, "new chat");
      await tap(cdp, "main button", "← Chats");
      await Bun.sleep(500);
    }

    // ---- the Now tab, and what it offers to do -----------------------
    await tap(cdp, "nav button", "Now");
    await Bun.sleep(1400);
    note("now", "the queue lists something or says it is empty",
      await cdp.ev(`(document.querySelector("main")?.textContent || "").trim().length > 40`));
    const actions = await texts(cdp, "main button");
    note("now", "offers an action per item, or none at all",
      !actions.some((a) => a === ""), `${actions.length} buttons`);
    await shot(cdp, "11-now-queue");
    await drain(cdp, "now");

    // ---- the server going away ---------------------------------------
    // A companion that silently shows stale numbers when the machine it is
    // watching has gone is worse than one that says so.
    await cdp.ev(`window.__origFetch = window.fetch; window.fetch = () => Promise.reject(new Error("offline"))`);
    await Bun.sleep(6000);
    note("offline", "says the connection is gone",
      await cdp.ev(`(document.querySelector("header")?.textContent || "").includes("Offline")`));
    await shot(cdp, "12-offline");
    await cdp.ev(`window.fetch = window.__origFetch; window.__audit = { errors: [], net: [] }`);
    await Bun.sleep(5000);
    note("offline", "comes back on its own",
      await cdp.ev(`(document.querySelector("header")?.textContent || "").includes("Live")`));
    await drain(cdp, "offline");

    console.log(`\nscreenshots → ${SHOTS}`);
  } finally {
    cdp.close();
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  for (const f of failed) console.log(`  FAIL ${f.screen} · ${f.what}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(failed.length);
}

main().catch((e) => { console.error(e); process.exit(99); });
