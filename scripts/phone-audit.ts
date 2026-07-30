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
import { connect, findChrome, lit, until, type CDP } from "./cdp.ts";

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
  const bad = { overflow: [], tiny: [], clipped: [], covered: [], inert: [] };
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
    // A diff line is the one control that cannot meet the floor: a phone-sized
    // diff at 44px a line shows eighteen of them, and reading a change is the
    // whole point of the screen. It is exempt because a mis-tap is *visible and
    // free* — the sheet opens naming the file, the line and the side before a
    // word is written, and Cancel costs nothing. Nothing else gets this.
    const dense = el.classList.contains("mb-dl");
    if (tappable && !dense && (r.height < 36 || r.width < 24)) bad.tiny.push(name(el) + " " + Math.round(r.width) + "x" + Math.round(r.height));
    // It is not exempt from being hittable at all, though.
    if (tappable && dense && (r.height < 18 || r.width < 24)) bad.tiny.push(name(el) + " (diff line) " + Math.round(r.width) + "x" + Math.round(r.height));

    // A control that will do nothing has to look like it will do nothing. The
    // costly version of this is a filled, primary-coloured button that is the
    // most prominent thing on the screen and is inert — "Finish the merge"
    // before the conflicts are resolved. \`.mb-press:disabled\` dims to .38 and
    // this is what stops a later rule from quietly out-specifying it.
    if (el.tagName === "BUTTON" && el.disabled && Number(getComputedStyle(el).opacity) > 0.75) {
      bad.inert.push(name(el) + " opacity=" + getComputedStyle(el).opacity);
    }

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
  note(screen, "a control that does nothing looks like it", !b.inert?.length, b.inert?.slice(0, 3).join(" | "));
};

const shot = async (cdp: CDP, name: string) => {
  const png = await cdp.shot();
  writeFileSync(join(SHOTS, `${name}.png`), png);
};

/** Text of everything matching a selector, for eyeballing a list in one read. */
const texts = (cdp: CDP, sel: string) =>
  cdp.ev(`JSON.stringify([...document.querySelectorAll(${lit(sel)})].map(e=>e.textContent.trim()).slice(0,40))`)
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

/** Close the screen that is actually on top. */
const closeTop = (cdp: CDP) => cdp.ev(`(()=>{const b=${TOP}?.querySelector(".hd .back");b?.click();return !!b})()`);

/** Click inside the topmost screen only. */
const tapTop = async (cdp: CDP, sel: string, needle?: string) => {
  const hit = await cdp.ev(`(()=>{const s=${TOP}; if(!s) return false;
    const els=[...s.querySelectorAll(${lit(sel)})];
    const el = ${needle ? `els.find(e=>e.textContent.includes(${lit(needle)}))` : "els[0]"};
    if(!el) return false; el.click(); return true;})()`);
  await Bun.sleep(700);
  return !!hit;
};

const topTitle = (cdp: CDP) => cdp.ev(`(${TOP})?.querySelector(".hd .t b")?.textContent || ""`);

const tap = async (cdp: CDP, sel: string, needle?: string) => {
  const hit = await cdp.ev(`(()=>{const els=[...document.querySelectorAll(${lit(sel)})];
    const el = ${needle ? `els.find(e=>e.textContent.includes(${lit(needle)}))` : "els[0]"};
    if(!el) return false; el.click(); return true;})()`);
  await Bun.sleep(700);
  return !!hit;
};

/**
 * Whether Chrome will refuse to start under its own sandbox.
 *
 * True for root, which is what CI and most containers run as. `AUDIT_NO_SANDBOX`
 * forces it for the cases uid does not describe — an unprivileged user in a
 * container without the right kernel namespaces.
 */
function needsNoSandbox(): boolean {
  if (process.env.AUDIT_NO_SANDBOX === "1") return true;
  if (process.env.AUDIT_NO_SANDBOX === "0") return false;
  return typeof process.getuid === "function" && process.getuid() === 0;
}

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
    // Chrome's sandbox needs privileges root does not have inside a container,
    // and refuses to start without them — so in CI or a devcontainer this
    // script died at "no page target" with nothing to say about why. Only
    // where it is actually required: on a normal machine the sandbox stays on.
    ...(needsNoSandbox() ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
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

    // Fifteen sheets are mounted on this tab and every one of them is closed.
    // A closed sheet is parked below the viewport, which hides the sheet and
    // not its shadow — that one points upward, so it landed back on the page
    // and fifteen of them stacked into a black band along the bottom edge.
    // Invisible for as long as the tab bar was docked over that strip, which is
    // exactly why it is worth asserting rather than looking for.
    note("now", "a closed sheet paints nothing",
      await cdp.ev(`[...document.querySelectorAll(".mb-sheet:not(.on)")].every(s=>{
        const c=getComputedStyle(s);
        return c.visibility === "hidden" && (c.boxShadow === "none" || c.boxShadow === "");
      })`),
      await cdp.ev(`(()=>{const b=[...document.querySelectorAll(".mb-sheet:not(.on)")]
        .filter(s=>{const c=getComputedStyle(s);
          return c.visibility!=="hidden" || (c.boxShadow!=="none" && c.boxShadow!=="")});
        return b.length + " of " + document.querySelectorAll(".mb-sheet:not(.on)").length
          + " closed sheets still paint";})()`));

    // The tab bar floats over the queue, so the queue has to end above it. A
    // last card parked permanently under the pill is the one way this shape is
    // worse than the bar it replaced, and it is invisible until you scroll to
    // the bottom of a list — so scroll to the bottom of the list.
    await cdp.ev(`scrollTo(0, document.body.scrollHeight)`);
    await Bun.sleep(900);
    note("now", "the last card ends above the tab bar",
      await cdp.ev(`(()=>{const c=[...document.querySelectorAll("main .mb-item")].pop();
        const n=document.querySelector("nav"); if(!c||!n) return true;
        return c.getBoundingClientRect().bottom <= n.getBoundingClientRect().top + 1;})()`),
      await cdp.ev(`(()=>{const c=[...document.querySelectorAll("main .mb-item")].pop();
        const n=document.querySelector("nav"); if(!c||!n) return "nothing to measure";
        return "card ends at " + Math.round(c.getBoundingClientRect().bottom)
          + ", bar starts at " + Math.round(n.getBoundingClientRect().top);})()`));
    await cdp.ev(`scrollTo(0, 0)`);
    await Bun.sleep(500);

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
    // Any sentence, not one particular sentence. "Try a wider range" is the
    // right words when other scopes have rows; a machine with no agents at all
    // says "No agents yet", which is better — and asserting the first wording
    // turned a correct cold-start screen red. An audit that fails on a
    // legitimate state teaches you to ignore it.
    note("chats", "an empty scope explains itself",
      liveRows > 0 || await cdp.ev(`(()=>{const m=document.querySelector("main");
        if(!m) return false; const t=m.textContent||"";
        return /Try a wider range|No agents yet|Nothing here/i.test(t)})()`),
      await cdp.ev(`(document.querySelector("main")?.textContent||"").trim().replace(/\s+/g," ").slice(-90)`));
    await tap(cdp, "main button", "Today");
    await Bun.sleep(900);
    await drain(cdp, "chats");
    await hygiene(cdp, "chats");

    // ---- a conversation ---------------------------------------------
    //
    // Opened from a scope that has rows *now*, not from whichever one the
    // scope exercise above happened to leave selected. It left "Today", and a
    // fixture seeded a day ago has nothing in Today — so this tapped an empty
    // list and then waited twelve seconds for a screen that was never going to
    // mount, taking the whole run down with it. The failure said "timed out
    // waiting for the conversation screen", which is true and points at
    // entirely the wrong thing: the conversation was fine, the list was empty.
    if (!(await cdp.ev(`!!document.querySelector("main button.w-full")`))) {
      await tap(cdp, "main button", "All");
      await Bun.sleep(1200);
    }
    const openable = await cdp.ev(`document.querySelectorAll("main button.w-full").length`);
    if (!openable) {
      console.log("  skip  conversation · no session on this machine to open");
    } else {
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

      // A checkout git stopped half-way through is a different repository to
      // check. `git diff` emits a combined diff for an unmerged path and the
      // tree parser does not turn that into a file row, so the one file you
      // have to act on is the one the changes list omits — which is why the
      // banner lists it itself. Assert what is true of the state the repo is
      // actually in rather than lowering the bar for every repo.
      const halted = await cdp.ev(`!!document.querySelector(".mb-screen.on .mb-halt")`);
      if (halted) {
        note("halt", "a stopped repository says so", true,
          await cdp.ev(`document.querySelector(".mb-screen.on .mb-halt .hh b")?.textContent`));
        note("halt", "and does not claim the tree is clean",
          !(await cdp.ev(`(document.querySelector(".mb-screen.on")?.textContent||"").includes("The working tree is clean")`)));
        note("halt", "lists what is in the way",
          await cdp.ev(`document.querySelectorAll(".mb-screen.on .mb-halt .cr").length > 0`),
          `${await cdp.ev(`document.querySelectorAll(".mb-screen.on .mb-halt .cr").length`)} conflicted`);
        note("halt", "offers a way out",
          await cdp.ev(`[...document.querySelectorAll(".mb-screen.on .mb-halt .ha button")]
            .some(b=>/abandon|end the/i.test(b.textContent))`));
        note("halt", "will not offer to finish while anything is conflicted",
          await cdp.ev(`[...document.querySelectorAll(".mb-screen.on .mb-halt .ha button")]
            .filter(b=>/finish|continue/i.test(b.textContent)).every(b=>b.disabled)`));
        // A long path must not push the verbs off the right edge.
        note("halt", "the path yields and the verbs do not",
          await cdp.ev(`[...document.querySelectorAll(".mb-screen.on .mb-halt .cr")].every(r=>{
            const rr=r.getBoundingClientRect();
            return [...r.children].every(c=>c.getBoundingClientRect().right<=rr.right+1);})`));
        await shot(cdp, "05b-halted");
        await hygiene(cdp, "halt");
        await drain(cdp, "halt");
      } else if (!files.length) {
        // A clean checkout is not a broken one. This asserted rows
        // unconditionally, so a brand-new machine — the state every user is in
        // once — came back red on a screen that was doing exactly its job.
        console.log("  skip  changes · this checkout has nothing uncommitted");
        note("changes", "a clean tree says so", await cdp.ev(`/Nothing to commit/.test(${TOP}.textContent)`));
      } else {
        note("changes", "lists the changed files", files.length > 0, `${files.length} rows`);
        note("changes", "file paths carry no diff prefix",
          !files.some((f) => /^[abciwo]\//.test(f)),
          files.filter((f) => /^[abciwo]\//.test(f)).join(", ") || "(none)");
      }
      await shot(cdp, "05-changes");
      await drain(cdp, "changes");
      await hygiene(cdp, "changes");

      // Open the first file's diff — the "it just won't load" report.
      // Scoped to the screen that is actually on: every other screen is still
      // in the DOM, parked off to the right, and clicking into one of those
      // looks exactly like a click that did nothing.
      if (files.length && await tap(cdp, ".mb-screen.on .mb-row button")) {
        await Bun.sleep(2200);
        // The title has to be the file that was tapped. This used to assert it
        // "contains a dot", which is a stand-in for "looks like a filename" and
        // is wrong about `Makefile`, `Dockerfile`, `LICENSE` and every other
        // extensionless file a repository has.
        const want = (files[0] || "").split("/").pop() || "";
        note("diff", "the diff screen opens on the file that was tapped",
          !!want && (await topTitle(cdp)).includes(want), `${await topTitle(cdp)} vs ${want}`);
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
      // ---- the project's own commands -------------------------------
      if (await tap(cdp, ".mb-screen.on .mb-seg button", "Commands")) {
        await Bun.sleep(2200);
        const rows = await cdp.ev(`${TOP}.querySelectorAll(".mb-row").length`);
        if (!rows) {
          console.log("  skip  commands · no Makefile or package.json in this checkout");
          note("commands", "an empty list says which kind of empty it is",
            await cdp.ev(`(${TOP}.querySelector(".mb-empty span")?.textContent || "").length > 12`),
            await cdp.ev(`${TOP}.querySelector(".mb-empty span")?.textContent`));
        } else {
          // The command itself, not a target name: `up` means nothing out of
          // context and is what you would be handing to an agent.
          note("commands", "each row shows the command that would run",
            await cdp.ev(`[...${TOP}.querySelectorAll(".mb-row .i b")].every(e=>/\\S/.test(e.textContent))`),
            await cdp.ev(`JSON.stringify([...${TOP}.querySelectorAll(".mb-row .i b")].map(e=>e.textContent).slice(0,4))`));
          note("commands", "a Makefile target is offered before a script",
            await cdp.ev(`(()=>{const k=[...${TOP}.querySelectorAll(".mb-row .r")].map(e=>e.textContent.trim());
              const i=k.indexOf("script"); return i === -1 || !k.slice(i).includes("make")})()`),
            await cdp.ev(`JSON.stringify([...${TOP}.querySelectorAll(".mb-row .r")].map(e=>e.textContent.trim()))`));
          note("commands", "and each one is a way to hand it over",
            await cdp.ev(`[...${TOP}.querySelectorAll(".mb-row")].every(e=>e.tagName === "BUTTON" || !!e.querySelector("button"))`));
        }
        await shot(cdp, "06b-commands");
        await hygiene(cdp, "commands");
        await drain(cdp, "commands");
      }

      // ---- reviewing a pull request --------------------------------
      //
      // Read-only, deliberately: everything up to and including the state of
      // the Submit button, and nothing that would post a review to GitHub. The
      // one thing this cannot check is the payload, which is checked by hand
      // against a stubbed `gh` — see the note on `onLine` in reviewDraft.ts.
      await tap(cdp, ".mb-screen.on button", "Pull requests");
      await Bun.sleep(2400);
      // A pull request row IS a button; a file row CONTAINS one. Reaching for
      // `.mb-row button` on the list found nothing and skipped this whole
      // section silently, which is the failure mode a conditional audit has.
      // A section that skips silently reads as a section that passed. This one
      // skipped for two full runs because of the selector above, and the only
      // sign was a check count nobody was watching.
      if (!(await cdp.ev(`!!${TOP}.querySelector("button.mb-row")`))) {
        console.log("  skip  review · no open pull request on this repository to review");
      } else {
        await cdp.ev(`${TOP}.querySelector("button.mb-row").click()`);
        await Bun.sleep(2600);
        // Every skip below says so out loud, including this one.
        //
        // The note above is about a selector that made this section vanish for
        // two runs. The same thing happened again, one level in: the pull
        // request opened, `Files` was not there to tap, and twenty-four checks
        // quietly stopped running — the count went from 170 to 134 and nothing
        // said why. A silent skip reads as a section that passed, so a skip
        // that prints nothing is the same bug as before wearing a different
        // condition.
        if (!(await tap(cdp, ".mb-screen.on .mb-seg button", "Files"))) {
          console.log("  skip  review · the pull request opened but has no Files tab to review");
        } else {
          await Bun.sleep(1500);
          if (!(await cdp.ev(`!!${TOP}.querySelector(".mb-row button")`))) {
            console.log("  skip  review · the pull request has no changed files listed");
          } else {
            await cdp.ev(`${TOP}.querySelector(".mb-row button").click()`);
            await Bun.sleep(1800);
            const taps = await cdp.ev(`${TOP}.querySelectorAll("button.mb-dl").length`);
            // `MobileDiff` has rendered every line as a button and printed "Tap
            // a line to comment on it" since it was written, and nothing ever
            // passed it an `onLine` — so the invitation was there and the
            // gesture did nothing.
            note("review", "diff lines can actually be tapped", taps > 0, `${taps} lines`);

            const del = await cdp.ev(`(()=>{const b=${TOP}.querySelector("button.mb-dl.del");
              if(!b) return null; b.click(); return b.querySelector(".g").textContent})()`);
            if (del) {
              // A deleted line is numbered in the OLD file. If the sheet claims
              // the new one, the remark is addressed to the wrong place and
              // nothing downstream can tell.
              note("review", "a deleted line is named as the old file",
                await cdp.ev(`/the old file/.test(document.querySelector(".mb-sheet.on")?.textContent || "")`),
                await cdp.ev(`document.querySelector(".mb-sheet.on .hd span")?.textContent`));
              await cdp.ev(`(()=>{const t=document.querySelector(".mb-sheet.on textarea");
                const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;
                set.call(t,"An audit remark, never sent.");
                t.dispatchEvent(new Event("input",{bubbles:true}));})()`);
              await Bun.sleep(300);
              await tap(cdp, ".mb-sheet.on button", "Save");
              await Bun.sleep(1000);
              note("review", "the annotated line is marked in the diff",
                await cdp.ev(`${TOP}.querySelectorAll("button.mb-dl.said").length > 0`));
              note("review", "and the way to finish appears",
                await cdp.ev(`[...${TOP}.querySelectorAll("button")].some(b=>/Finish review/.test(b.textContent))`));

              await cdp.ev(`[...${TOP}.querySelectorAll("button")].find(b=>/Finish review/.test(b.textContent))?.click()`);
              await Bun.sleep(900);
              const sheet = `document.querySelector(".mb-sheet.on")`;
              note("review", "all three verbs are offered",
                await cdp.ev(`[...${sheet}.querySelectorAll("button.mb-row")].length === 3`),
                await cdp.ev(`JSON.stringify([...${sheet}.querySelectorAll("button.mb-row b")].map(b=>b.textContent))`));
              note("review", "submitting is refused until a verb is chosen, with a reason",
                await cdp.ev(`[...${sheet}.querySelectorAll("button")].find(b=>/Submit review/.test(b.textContent))?.disabled === true`)
                && await cdp.ev(`[...${sheet}.querySelectorAll("p")].some(p=>p.textContent.length > 12)`));
              await cdp.ev(`[...${sheet}.querySelectorAll("button.mb-row")].find(b=>/Comment/.test(b.textContent))?.click()`);
              await Bun.sleep(500);
              note("review", "and allowed once one is",
                await cdp.ev(`[...${sheet}.querySelectorAll("button")].find(b=>/Submit review/.test(b.textContent))?.disabled === false`));
              await shot(cdp, "07b-review");
              await hygiene(cdp, "review");
              await drain(cdp, "review");
              // Leave without sending anything.
              await cdp.ev(`document.querySelector(".mb-scrim.on")?.click()`);
              await Bun.sleep(500);
            }
          }
          // The TOP screen's back, not the first one in the document. Screens
          // stay mounted under their children, so `.mb-screen.on .hd .back`
          // matches the repository's back button first and closes the wrong
          // thing — which is why the section below saw a diff where it expected
          // a pull request. Same trap the TOP helper exists for.
          await closeTop(cdp);
          await Bun.sleep(700);

          // ---- a failing check's log -----------------------------------
          //
          // The tab used to print "the phone does not download run logs" under
          // every failure, while the endpoint sat on the server. Reading a log
          // is a read, so this one presses the button.
          if (await tap(cdp, ".mb-screen.on .mb-seg button", "Checks")) {
            await Bun.sleep(2600);
            const failing = await cdp.ev(`(()=>{const b=[...${TOP}.querySelectorAll("button")]
              .find(b=>/FAILURE|failure/.test(b.textContent) && !b.disabled);
              if(!b) return null; b.click(); return b.textContent.trim().slice(0,40)})()`);
            if (!failing) {
              console.log("  skip  job log · no failing check on this pull request");
            } else {
              await Bun.sleep(900);
              note("job log", "the phone no longer sends you to a browser",
                !(await cdp.ev(`/does not download run logs/.test(${TOP}.textContent)`)));
              const opened = await cdp.ev(`(()=>{const b=[...${TOP}.querySelectorAll("button")]
                .find(b=>/Show the failure/.test(b.textContent)); if(!b||b.disabled) return false; b.click(); return true})()`);
              note("job log", "a failing check offers its log", opened, failing);
              if (opened) {
                await Bun.sleep(2600);
                note("job log", "the log arrives",
                  await cdp.ev(`(${TOP}.querySelector(".mb-log pre")?.textContent || "").trim().length > 40`));
                note("job log", "and says which part of it this is",
                  await cdp.ev(`(${TOP}.querySelector(".mb-log .lh")?.textContent || "").length > 8`),
                  await cdp.ev(`${TOP}.querySelector(".mb-log .lh")?.textContent`));
                note("job log", "the timestamps are gone",
                  !(await cdp.ev(`/\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d+Z/.test(${TOP}.querySelector(".mb-log pre")?.textContent || "")`)));
                // The whole point: you land on the failure. A window taller
                // than its box that opens at the top is a log you scroll.
                note("job log", "it opens at the failure, not at the top",
                  await cdp.ev(`(()=>{const p=${TOP}.querySelector(".mb-log pre");const e=p?.querySelector(".e");
                    if(!p) return false; if(!e) return true;
                    const pr=p.getBoundingClientRect(), er=e.getBoundingClientRect();
                    return er.top >= pr.top - 1 && er.bottom <= pr.bottom + 1})()`),
                  await cdp.ev(`(()=>{const p=${TOP}.querySelector(".mb-log pre");
                    return p ? p.clientHeight+"/"+p.scrollHeight+" at "+Math.round(p.scrollTop) : "?"})()`));
                await shot(cdp, "07d-joblog");
                await hygiene(cdp, "job log");
                await drain(cdp, "job log");
              }
            }
          }

          // ---- line threads --------------------------------------------
          //
          // Read-only again: what is drawn and in what order. Replying and
          // resolving are writes and are not pressed here.
          if (await tap(cdp, ".mb-screen.on .mb-seg button", "Talk")) {
            await Bun.sleep(1600);
            const threads = await cdp.ev(`${TOP}.querySelectorAll(".mb-thr").length`);
            if (!threads) {
              console.log("  skip  threads · no line threads on this pull request");
            } else {
              // Every reply, not a count. The old rendering folded a thread into
              // its opening sentence and dropped the answers — which is the part
              // that decides anything.
              note("threads", "every reply is on screen, not a count",
                await cdp.ev(`[...${TOP}.querySelectorAll(".mb-thr")].some(t=>t.querySelectorAll(".tc").length > 1)`),
                await cdp.ev(`JSON.stringify([...${TOP}.querySelectorAll(".mb-thr")].map(t=>t.querySelectorAll(".tc").length))`));
              note("threads", "what is still open is read first",
                await cdp.ev(`(()=>{const q=[...${TOP}.querySelectorAll(".mb-thr")].map(t=>t.classList.contains("quiet"));
                  return q.indexOf(false) === -1 || q.lastIndexOf(false) < (q.indexOf(true) === -1 ? q.length : q.indexOf(true));})()`),
                await cdp.ev(`JSON.stringify([...${TOP}.querySelectorAll(".mb-thr .th")].map(e=>e.textContent))`));
              note("threads", "a settled thread says which kind of settled",
                await cdp.ev(`[...${TOP}.querySelectorAll(".mb-thr.quiet")].every(t=>/resolved|outdated/.test(t.textContent))`));
              note("threads", "each one can be answered and closed",
                await cdp.ev(`[...${TOP}.querySelectorAll(".mb-thr")].every(t=>{
                  const v=[...t.querySelectorAll(".ta button")].map(b=>b.textContent.trim());
                  return v.includes("Reply") && (v.includes("Resolve") || v.includes("Reopen"));})`));
              note("threads", "a line with no current number does not print one",
                !(await cdp.ev(`/:(null|undefined|NaN)/.test(${TOP}.textContent)`)));
              await shot(cdp, "07c-threads");
              await hygiene(cdp, "threads");
              await drain(cdp, "threads");
            }
          }
          await tap(cdp, ".mb-screen.on .hd .back");
          await Bun.sleep(600);
        }
        await tap(cdp, ".mb-screen.on .hd .back");
        await Bun.sleep(600);
      }

      await tap(cdp, ".mb-screen.on .hd .back");
      await Bun.sleep(600);
    }

    // ---- settings ----------------------------------------------------
    // The way in is the key on the tab bar now, not a gear in a header. When
    // that entry point moves again, this has to fail rather than quietly skip
    // the thirteen checks behind it, which is what it did the first time.
    const intoSettings = await tap(cdp, "nav .mb-navkey");
    note("settings", "the way in is on the tab bar", intoSettings);
    if (intoSettings) {
      await Bun.sleep(900);
      note("settings", "sheet opens", await cdp.ev(`!!document.querySelector(".mb-sheet.on")`));
      note("settings", "reports what this machine spent",
        await cdp.ev(`(document.querySelector(".mb-sheet.on")?.textContent || "").includes("Spend today")`));
      note("settings", "the sheet scrolls rather than running off the screen",
        await cdp.ev(`(()=>{const s=document.querySelector(".mb-sheet.on");if(!s)return false;
          const r=s.getBoundingClientRect();
          return r.bottom<=innerHeight+1 && r.top>=-1;})()`));

      // Push is the only channel that reaches this device with its screen off,
      // and the row is the only way to turn it on. Checked here rather than
      // trusted: the state comes from three separate places — browser support,
      // notification permission, and whether a subscription exists — and the
      // wrong answer looks exactly like the right one.
      const pushRow = `[...document.querySelectorAll(".mb-sheet.on .mb-row")]
        .find(r => r.textContent.includes("Push to this phone"))`;
      note("settings", "offers push to this device",
        await cdp.ev(`!!(${pushRow})`));
      // Never "Checking…" by the time the sheet is up and painted: that is the
      // placeholder, and a row stuck on it says nothing and does nothing.
      const pushText = await cdp.ev(`(${pushRow})?.innerText?.replace(/\\n/g, " · ") || ""`);
      note("settings", "says where this device actually stands",
        !!pushText && !pushText.includes("Checking"), pushText);
      // A button exactly where pressing one could do something.
      //
      // Keyed on the two states that are actually actionable rather than on
      // the ones that are not: "blocked", "unsupported" and "add to Home
      // Screen" are three different dead ends and a fourth could be added, and
      // a rule written as "not those" would silently start demanding a button
      // for whatever came next. Chrome here has no reachable push service, so
      // "Turn on" is the honest state.
      const pushBtn = await cdp.ev(`(${pushRow})?.querySelector("button")?.innerText || ""`);
      const actionable = /Alerts reach|Get held gates/.test(pushText);
      note("settings", "the button matches what the row says",
        actionable ? /Turn on|Turn off/.test(pushBtn) : pushBtn === "",
        `row "${pushText}" / button "${pushBtn || "(none)"}"`);
      note("settings", "the worker that receives a push is registered",
        await cdp.ev(`navigator.serviceWorker.getRegistrations().then(r =>
          r.some(x => (x.active?.scriptURL || "").endsWith("/sw.js")))`));

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

    // Nothing in this list finishes work.
    //
    // The queue is a scrolling list where every card puts its buttons in the
    // same shape and the same place, and it carried "Squash & merge" for a
    // while — behind a confirm, which is the weakest control there is against
    // a mis-tap, because it appears under the thumb that just tapped. Checked
    // by label rather than by call site: the audit cannot see the handler, and
    // the label is what a thumb aims at.
    const verbs = await cdp.ev(`JSON.stringify(
      [...document.querySelectorAll("main .mb-item .acts button")].map(b => b.textContent.trim()))`);
    note("now", "offers nothing irreversible",
      !/merge|delete|remove|discard|close|force/i.test(verbs || ""), verbs);

    // The count is only ever what is stopped. A badge that adds a held gate to
    // five pull requests is never zero, and a number that is never zero stops
    // being read — which is most of what made this screen an inbox.
    // No regular expressions in here.
    //
    // This is a template literal, so `\b` and `\d` are string escapes long
    // before they are regex syntax — the backslash is eaten and `/^\d+$/`
    // arrives in the page as `/^d+$/`, which matches the letter d and nothing
    // else. It found no badge, reported 0, and failed a check about counting
    // for a reason that had nothing to do with counting.
    const counts = await cdp.ev(`JSON.stringify((() => {
      const digits = (t) => t.trim().length > 0 && [...t.trim()].every(ch => ch >= "0" && ch <= "9");
      const nowTab = [...document.querySelectorAll("nav button")]
        .find(b => (b.innerText || "").includes("Now"));
      const badge = nowTab && [...nowTab.querySelectorAll("span")]
        .find(sp => digits(sp.textContent || ""));
      const hero = document.querySelector(".mb-hero .mb-fig")?.textContent?.trim();
      const cards = document.querySelectorAll("main .mb-item").length;
      const quiet = document.querySelectorAll("main .mb-item.quiet").length;
      return { badge: badge ? Number(badge.textContent) : 0, hero, cards, quiet,
        screens: document.querySelectorAll(".mb-screen.on").length };
    })())`);
    const c = JSON.parse(counts || "{}") as {
      badge: number; hero: string; cards: number; quiet: number; screens: number;
    };
    note("now", "counts what is stopped, not what is merely true",
      c.badge === c.cards - c.quiet,
      `badge ${c.badge} · ${c.cards} cards, ${c.quiet} quiet · ${c.screens} screens open`);
    note("now", "the hero agrees with the badge",
      c.hero === (c.badge === 0 ? "✓" : String(c.badge)), `hero "${c.hero}" · badge ${c.badge}`);

    // And when both halves are present, the line between them is drawn — the
    // one thing that stops news and blockages reading as one undifferentiated
    // scroll.
    if (c.quiet > 0 && c.cards > c.quiet) {
      note("now", "says where the things waiting on you stop",
        await cdp.ev(`[...document.querySelectorAll("main .mb-eyebrow")]
          .some(e => /waiting on you/i.test(e.textContent || ""))`));
    } else {
      console.log("  skip  now · only one half of the queue is present, so there is no divider to draw");
    }

    await shot(cdp, "11-now-queue");
    await hygiene(cdp, "now");

    // "Later" has to mean what the Settings row says it means. This is the one
    // place the audit changes anything, and what it changes is localStorage in
    // a throwaway Chrome profile — nothing on the machine, nothing on GitHub,
    // no agent touched.
    if (await cdp.ev(`[...document.querySelectorAll("main .mb-item .acts button")].some(b=>b.textContent.trim()==="Later")`)) {
      const before = await cdp.ev(`document.querySelectorAll("main .mb-item").length`);
      const gone = await cdp.ev(`(()=>{const card=[...document.querySelectorAll("main .mb-item")]
        .find(c=>[...c.querySelectorAll(".acts button")].some(b=>b.textContent.trim()==="Later"));
        if(!card)return null;const t=card.querySelector(".t")?.textContent||"";
        [...card.querySelectorAll(".acts button")].find(b=>b.textContent.trim()==="Later").click();return t})()`);
      await Bun.sleep(700);
      const after = await cdp.ev(`document.querySelectorAll("main .mb-item").length`);
      note("later", "the card leaves the queue", after === before - 1, `${before} → ${after}`);

      // The failure this replaces: the list was component state, so the queue
      // you emptied was full again on the next load.
      await cdp.send("Page.reload");
      await until(cdp, `document.querySelector(".mb")`, "the shell after a reload", 25_000);
      await Bun.sleep(2200);
      await tap(cdp, "nav button", "Now");
      await Bun.sleep(1600);
      note("later", "and stays gone across a reload",
        !(await cdp.ev(`document.body.textContent.includes(${lit(String(gone).slice(0, 40))})`)),
        `card was: ${gone}`);

      // The count the Settings row shows has to be the store's, not a list in
      // memory that a reload has already thrown away.
      await tap(cdp, "nav .mb-navkey");
      await Bun.sleep(700);
      note("later", "Settings counts it as hidden",
        await cdp.ev(`/1 hidden until they change/.test(document.body.textContent)`),
        await cdp.ev(`(document.body.textContent.match(/Snoozed[^]{0,40}/)||[""])[0]`));
      const restored = await tap(cdp, "button", "Restore");
      note("later", "Restore is offered", restored);
      await Bun.sleep(600);
      await cdp.ev(`document.querySelector(".mb-scrim, [data-scrim]")?.click()`);
      await Bun.sleep(700);
      // The card itself, not the words in the sheet: "Nothing snoozed" is
      // trivially true on a device where nothing was ever hidden, so on its own
      // it cannot tell a working Restore from a Later that never took.
      note("later", "and Restore actually brings the card back",
        restored && await cdp.ev(`document.querySelectorAll("main .mb-item").length`) === before,
        `queue is ${await cdp.ev(`document.querySelectorAll("main .mb-item").length`)}, was ${before}`);
      await shot(cdp, "11b-later");
      await hygiene(cdp, "later");
      await drain(cdp, "later");
    }
    await drain(cdp, "now");

    // ---- the fleet ---------------------------------------------------
    await tap(cdp, "nav button", "Fleet");
    await Bun.sleep(1800);
    note("fleet", "the tab exists and renders",
      await cdp.ev(`(document.querySelector("main")?.textContent || "").trim().length > 60`));
    const cards = await cdp.ev(`document.querySelectorAll("main .mb-ins").length`);
    if (!cards) {
      console.log("  skip  fleet · nothing is misbehaving on this machine");
      note("fleet", "an empty fleet says so rather than showing nothing",
        await cdp.ev(`/Nothing is misbehaving/.test(document.body.textContent)`));
    } else {
      // Worst first, same as the Now queue and for the same reason.
      note("fleet", "the worst is at the top",
        await cdp.ev(`(()=>{const r=[...document.querySelectorAll("main .mb-ins")]
          .map(e=>e.classList.contains("bad")?0:e.classList.contains("warn")?1:2);
          return r.every((v,i)=>i===0||r[i-1]<=v)})()`),
        await cdp.ev(`JSON.stringify([...document.querySelectorAll("main .mb-ins")].map(e=>e.querySelector(".t").textContent))`));
      note("fleet", "an insight is a way in, not a headline",
        await cdp.ev(`[...document.querySelectorAll("main .mb-ins")].every(e=>e.tagName === "BUTTON")`));
    }
    // A bar you cannot see is not a comparison. These are spans, and an inline
    // element silently ignores a height — which drew every track 0px tall.
    note("fleet", "the bars are actually drawn",
      await cdp.ev(`[...document.querySelectorAll("main .mb-bar .g")].every(e=>e.getBoundingClientRect().height >= 4)`),
      await cdp.ev(`JSON.stringify([...document.querySelectorAll("main .mb-bar .g")].map(e=>Math.round(e.getBoundingClientRect().height)))`));
    note("fleet", "no figure renders as NaN or undefined",
      !(await cdp.ev(`/NaN|undefined|Infinity/.test(document.querySelector("main")?.textContent || "")`)));
    await shot(cdp, "14-fleet");
    await hygiene(cdp, "fleet");
    await drain(cdp, "fleet");
    await tap(cdp, "nav button", "Now");
    await Bun.sleep(900);

    // ---- the server going away ---------------------------------------
    // A companion that silently shows stale numbers when the machine it is
    // watching has gone is worse than one that says so.
    // The state of the link lives on the settings key: a coloured dot, and the
    // word in the key's own accessible name, which is what a screen reader
    // announces and what the sheet behind it prints. Reading the name rather
    // than a header's text is the stronger check of the two — a header can say
    // "Offline" while the control the person can actually reach says nothing.
    const linkName = `(document.querySelector("nav .mb-navkey")?.getAttribute("aria-label") || "").toLowerCase()`;
    const linkDot = `getComputedStyle(document.querySelector("nav .mb-navkey .lk") || document.body).backgroundColor`;
    // Read while the machine is still there, so the comparison below is against
    // a colour that actually meant "live".
    const liveDot = await cdp.ev(linkDot);

    await cdp.ev(`window.__origFetch = window.fetch; window.fetch = () => Promise.reject(new Error("offline"))`);
    await Bun.sleep(6000);
    note("offline", "says the connection is gone", await cdp.ev(`${linkName}.includes("offline")`),
      await cdp.ev(linkName));
    note("offline", "and the dot stops claiming otherwise",
      (await cdp.ev(linkDot)) !== liveDot
      && await cdp.ev(`getComputedStyle(document.querySelector("nav .mb-navkey .lk")).animationName === "none"`));
    await shot(cdp, "12-offline");
    await cdp.ev(`window.fetch = window.__origFetch; window.__audit = { errors: [], net: [] }`);
    await Bun.sleep(5000);
    note("offline", "comes back on its own", await cdp.ev(`${linkName}.includes("live")`),
      await cdp.ev(linkName));
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
