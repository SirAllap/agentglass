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

/**
 * The defects that are invisible in code and obvious on a phone.
 *
 * Every one of these was reported by hand at least once: a switch clipped by
 * its own hit area, a header sitting under another header, a control too small
 * to hit, a row wider than the screen. They are cheap to check and they are the
 * difference between "works" and "polished", so every screen gets swept rather
 * than only the ones someone thought to look at.
 */
const HYGIENE = `(() => {
  const bad = { overflow: [], tiny: [], clipped: [], covered: [] };
  const vw = innerWidth, vh = innerHeight;
  // A screen that is closed is still mounted, parked one viewport to the right.
  // Everything inside it "overflows" by exactly that much and none of it is on
  // screen, so the whole subtree is out of scope.
  const parked = (el) => !!el.closest('.mb-screen:not(.on), [aria-hidden="true"]');
  // Content inside a horizontal scroller is reachable by definition — a long
  // diff line in Scroll mode is the feature, not a defect.
  const scrollable = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === "auto" || o === "scroll") return true;
    }
    return false;
  };
  const visible = (el) => {
    if (parked(el)) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh;
  };
  const name = (el) => (el.tagName.toLowerCase() + (el.className && typeof el.className === "string"
    ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "")
    + (el.textContent ? " «" + el.textContent.trim().slice(0, 24) + "»" : "")).slice(0, 80);

  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();

    // Something reaching past the right edge: the page cannot scroll sideways,
    // so whatever is out there is simply gone.
    if (r.right > vw + 1.5 && getComputedStyle(el).position !== "fixed" && !scrollable(el)) {
      bad.overflow.push(name(el) + " right=" + Math.round(r.right));
    }

    // A tap target you have to aim at. 40px is the floor everyone agrees on.
    const tappable = el.tagName === "BUTTON" || el.getAttribute("role") === "switch"
      || el.getAttribute("role") === "tab" || el.tagName === "A";
    if (tappable && (r.height < 36 || r.width < 24)) bad.tiny.push(name(el) + " " + Math.round(r.width) + "x" + Math.round(r.height));

    // Text cut off with no ellipsis and no way to scroll to it.
    const s = getComputedStyle(el);
    if (el.children.length === 0 && el.textContent && el.textContent.trim()
        && el.scrollWidth > el.clientWidth + 2 && s.textOverflow !== "ellipsis" && s.overflowX === "hidden") {
      bad.clipped.push(name(el));
    }
  }
  return JSON.stringify(bad);
})()`;

const hygiene = async (cdp: CDP, screen: string) => {
  const raw = await cdp.ev(HYGIENE);
  const b = JSON.parse(raw || "{}") as Record<string, string[]>;
  note(screen, "nothing reaches past the right edge", !b.overflow?.length, b.overflow?.slice(0, 3).join(" | "));
  note(screen, "every control is big enough to hit", !b.tiny?.length, b.tiny?.slice(0, 3).join(" | "));
  note(screen, "no text is cut off without an ellipsis", !b.clipped?.length, b.clipped?.slice(0, 3).join(" | "));
};

const shot = async (cdp: CDP, name: string) => {
  const png = await cdp.shot();
  writeFileSync(join(SHOTS, `${name}.png`), png);
};

/** Text of everything matching a selector, for eyeballing a list in one read. */
const texts = (cdp: CDP, sel: string) =>
  cdp.ev(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.textContent.trim()).slice(0,40))`)
    .then((s: string) => JSON.parse(s || "[]") as string[]);

/**
 * The screen the user is looking at.
 *
 * Parent screens stay mounted and open underneath their children (that is what
 * stopped the diff closing itself), so "the screen that is on" is the LAST one
 * in the document, not the first. Reading the first is how this harness came to
 * compare a diff's title with the repository's and report a working Next button
 * as broken.
 */
const TOP = `[...document.querySelectorAll(".mb-screen.on")].pop()`;

/** Click inside the topmost screen only. */
const tapTop = async (cdp: CDP, sel: string, needle?: string) => {
  const hit = await cdp.ev(`(()=>{const s=${TOP}; if(!s) return false;
    const els=[...s.querySelectorAll(${JSON.stringify(sel)})];
    const el = ${needle ? `els.find(e=>e.textContent.includes(${JSON.stringify(needle)}))` : "els[0]"};
    if(!el) return false; el.click(); return true;})()`);
  await Bun.sleep(700);
  return !!hit;
};

const topTitle = (cdp: CDP) => cdp.ev(`(${TOP})?.querySelector(".hd .t b")?.textContent || ""`);

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

    // A token is only needed against a server that is exposed — the desktop
    // app's own sidecar mints one. The bundle takes it off the URL on first
    // load and keeps it, exactly as the QR link does.
    const token = process.env.AUDIT_TOKEN?.trim();
    await cdp.send("Page.navigate", { url: ORIGIN + "/" + (token ? `?token=${encodeURIComponent(token)}` : "") });
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
    await hygiene(cdp, "now");

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

    // Each scope has to actually change the list, and All has to be the widest.
    await tap(cdp, "main button", "All");
    await Bun.sleep(900);
    const allRows = await cdp.ev(`document.querySelectorAll("main button.w-full").length`);
    note("chats", "All widens the list", allRows >= rows, `${rows} → ${allRows}`);
    await tap(cdp, "main button", "Working");
    await Bun.sleep(900);
    const liveRows = await cdp.ev(`document.querySelectorAll("main button.w-full").length`);
    note("chats", "Working narrows it", liveRows <= allRows, `${allRows} → ${liveRows}`);
    note("chats", "an empty scope explains itself",
      liveRows > 0 || await cdp.ev(`document.body.textContent.includes("Try a wider range")`));
    await tap(cdp, "main button", "Today");
    await Bun.sleep(900);
    await drain(cdp, "chats");
    await hygiene(cdp, "chats");

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
      // Reading history must not be interrupted by a poll landing, and there
      // has to be a way back down again.
      await cdp.ev(`(()=>{const b=document.querySelector(".mb-chat .bd");if(b) b.scrollTop = 0;})()`);
      await Bun.sleep(400);
      note("conversation", "scrolling up stays where you put it",
        await cdp.ev(`(()=>{const b=document.querySelector(".mb-chat .bd");
          return !!b && b.scrollTop < 40;})()`));
      await Bun.sleep(6000);
      note("conversation", "a poll does not yank you back down",
        await cdp.ev(`(()=>{const b=document.querySelector(".mb-chat .bd");
          return !!b && b.scrollTop < 200;})()`));
      await shot(cdp, "03b-scrolled-up");
      await cdp.ev(`(()=>{const b=document.querySelector(".mb-chat .bd");if(b) b.scrollTop = b.scrollHeight;})()`);
      await Bun.sleep(500);
      note("conversation", "thread is scrolled to the newest turn",
        await cdp.ev(`(()=>{const b=document.querySelector(".mb-chat .bd");if(!b)return false;
          return b.scrollHeight - b.scrollTop - b.clientHeight < 80;})()`));
      await shot(cdp, "03-conversation");
      await drain(cdp, "conversation");
      await hygiene(cdp, "conversation");
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
      // A project can have several checkouts. Pick one with uncommitted work,
      // or the changes list below is legitimately empty and proves nothing.
      const switched = await cdp.ev(`(()=>{const s=${TOP}; if(!s) return "";
        const chip=[...s.querySelectorAll("button")].find(b=>/·\\s*\\d+$/.test(b.textContent.trim()));
        if(!chip) return ""; chip.click(); return chip.textContent.trim();})()`);
      if (switched) { note("repos", "worktrees are offered inside the project", true, switched); await Bun.sleep(1600); }
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
      await hygiene(cdp, "changes");

      // Open the first file's diff — the "it just won't load" report.
      // Scoped to the screen that is actually on: every other screen is still
      // in the DOM, parked off to the right, and clicking into one of those
      // looks exactly like a click that did nothing.
      if (files.length && await tap(cdp, ".mb-screen.on .mb-row button")) {
        await Bun.sleep(2200);
        note("diff", "the diff screen opens", (await topTitle(cdp)).includes("."), await topTitle(cdp));
        const lines = await cdp.ev(`document.querySelectorAll(".mb-dl, .mb-diff-line, .mb-hunk").length`);
        const said = await cdp.ev(`(document.querySelector(".mb-screen.on")?.textContent || "")
          .includes("Nothing to show") ? "empty" : ""`);
        note("diff", "the diff renders lines", lines > 0 && !said, `${lines} line nodes ${said}`);
        // Walking files from inside the diff, when there is more than one to
        // walk — with a single changed file the footer correctly has no
        // Prev/Next to press.
        if (files.length > 1) {
          const firstTitle = await topTitle(cdp);
          await tapTop(cdp, ".ft button", "Next");
          await Bun.sleep(1400);
          const secondTitle = await topTitle(cdp);
          note("diff", "Next moves to another file", !!secondTitle && secondTitle !== firstTitle,
            `${firstTitle} → ${secondTitle}`);
          note("diff", "the new file has content",
            await cdp.ev(`(${TOP})?.querySelectorAll(".bd *").length > 5`));
        } else {
          note("diff", "a single changed file offers no Prev/Next",
            await cdp.ev(`!(${TOP})?.querySelector(".ft")`), `${files.length} file`);
        }
        await tapTop(cdp, ".hd button", "Wrap");
        await Bun.sleep(600);
        note("diff", "the wrap toggle answers",
          await cdp.ev(`[...(${TOP})?.querySelectorAll(".hd button")]
            .some(b=>b.textContent.trim() === "Scroll")`));
        await tapTop(cdp, ".ft button", "Prev");
        await Bun.sleep(1200);
        await shot(cdp, "06-diff");
        await drain(cdp, "diff");
      await hygiene(cdp, "diff");

        // The phone's own back gesture, which is what the screen stack exists
        // for: it must close the diff and land back on the repo, not leave.
        await cdp.ev("history.back()");
        await Bun.sleep(900);
        note("back gesture", "closes the diff and keeps the repo",
          !(await topTitle(cdp)).includes("."), await topTitle(cdp));
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
      note("settings", "the sheet scrolls rather than running off the screen",
        await cdp.ev(`(()=>{const s=document.querySelector(".mb-sheet.on");if(!s)return false;
          const r=s.getBoundingClientRect();
          return r.bottom<=innerHeight+1 && r.top>=-1;})()`));
      await shot(cdp, "08-settings");
      await drain(cdp, "settings");
      await hygiene(cdp, "settings");
      // The scrim that is actually up: every sheet keeps one mounted, and the
      // first in the document belongs to a sheet that is closed.
      await cdp.ev(`document.querySelector(".mb-scrim.on")?.click()`);
      await Bun.sleep(700);
      note("settings", "tapping outside closes it",
        !(await cdp.ev(`!!document.querySelector(".mb-sheet.on")`)));
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
      await hygiene(cdp, "new chat");
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

    // ---- landscape ----------------------------------------------------
    // A phone turned sideways is 915x412: the same app, half the height, and
    // the composer still has to be reachable.
    await tap(cdp, "nav button", "Chats");
    await Bun.sleep(800);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 915, height: 412, deviceScaleFactor: PHONE.scale, mobile: true,
    });
    await Bun.sleep(900);
    note("landscape", "still the phone application",
      (await cdp.ev(`document.documentElement.dataset.layout`)) === "phone");
    note("landscape", "nothing spills off the side",
      await cdp.ev(`document.documentElement.scrollWidth <= innerWidth + 2`));
    await shot(cdp, "13-landscape");
    if (await tap(cdp, "main button.w-full")) {
      await Bun.sleep(1400);
      note("landscape", "the composer is still on screen",
        await cdp.ev(`(()=>{const f=document.querySelector(".mb-chat .ft");if(!f)return false;
          const r=f.getBoundingClientRect();return r.bottom<=innerHeight+1&&r.top>0;})()`));
      await shot(cdp, "14-landscape-chat");
      await cdp.ev("history.back()");
      await Bun.sleep(700);
    }
    await drain(cdp, "landscape");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: PHONE.w, height: PHONE.h, deviceScaleFactor: PHONE.scale, mobile: true,
    });
    await Bun.sleep(700);

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
