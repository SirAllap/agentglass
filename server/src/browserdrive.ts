/**
 * Letting an agent drive the built-in browser.
 *
 * The point is the logins. An agent can already fetch a URL from its shell and
 * get the signed-out version of everything that matters — the dashboard, the
 * staging app, the ticket — because the session lives in a browser and not in
 * `curl`. This app has a browser with those sessions in it, sitting in a pane,
 * and until now nothing outside the window could reach it.
 *
 * Which makes this a relay, not a driver. The page lives in a guest process
 * inside the desktop shell; the only thing that can touch it is the panel it is
 * mounted in. So an agent's HTTP request is parked here, handed to that panel
 * over the socket every window already holds, and answered when the panel says
 * what happened. The alternative — a second browser, driven headlessly, holding
 * its own copy of somebody's cookies — is the thing this deliberately is not.
 *
 * Three consequences worth stating rather than discovering:
 *
 *   * **It needs the window open.** A request with nobody listening fails
 *     quickly and says so, rather than hanging until the agent's own timeout
 *     and reading as "the browser is broken".
 *   * **Every operation is a closed verb**, not a script. `click` takes a
 *     selector; there is no "run this JavaScript". The panel implements each
 *     one, so the set of things reachable through this door is the set someone
 *     wrote down here — which is the same rule the terminal's command paths and
 *     the tmux control surface already follow.
 *   * **Every request is bounded.** A page that never settles must not hold a
 *     socket, a pending map entry and an agent's turn open forever.
 */

/* Static rather than the `await import("node:fs")` the async helpers below
   use: `recordAudit` is synchronous and on the path of every verb, and a
   dynamic import there would make the log's write order depend on the
   microtask queue. */
import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { configPath, inScope, workspaceRoot, envLimit } from "./config.ts";
import { ORIGINS_ENV, PROFILES_ENV, originsAllow, profilesAllow, workerVerbGroups } from "./browserLimits.ts";
import { WORKER_VERB_GROUPS, groupOfVerb } from "../../shared/browserLimits.ts";
import { GUIDE_READ_VERBS, dropGrantsOf, grantFor, hasAnyGrant, noGrantRefusal, resetGuideGrants } from "./browserGuideGrants.ts";
import { robotsOn, robotsRefusal } from "./robots.ts";
import { blockedTarget } from "./net.ts";
import { agentContainerName, containerOwner, foldWorkerName, isAgentContainer } from "../../shared/workerContainer.ts";
import { HANDOFF_OPEN_VERBS } from "../../shared/browserHandoff.ts";
import {
  disownContainer, dropSignIns, forgetMadeContainer, forgetTab, madeByAgent, madeNamed, noteMadeContainer, noteTabContainer, recordSignIn,
  forgetVisitsOf, resetVaultContainers, signInsOf, signInsWhere, tabAgentMade, tabContainer, tryContainerSite, type ContainerSignIn,
} from "./vaultContainers.ts";
import { ACT_VERB_SET } from "../../shared/browserActVerbs.ts";
import { addStep, finishGuide, guideAudit, guideFor, guideLock, guideOf, noteEvent, othersRefusal, sameCaller, startGuide, takeEnded, touchGuide, resetGuides, GUIDE_EVENTS, type GuideEvent } from "./browserGuide.ts";
import { GUIDE_WAITS, SAY_NO_WORDS, SUMMARY_SAY, sayHasWords, regenerateNote, regenerateRun, currentVisit, endRun, lintPlan, parsePlan, resumeRun, runInput, sayCurrent, startRun, visitSeq, waitRunEvent, type Guide, type GuideWait, type PanelEvent, type PlanStep } from "./browserGuide.ts";
import type { GuideActivity, LaneRow } from "../../shared/types.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { closeLane, configureLanes, isLaneId, laneKnown, laneRecord, laneRefusal, listLanes, listOwnedLanes, markVisitSigned, noLaneError, openLane, resetLanes, showLane, touchLane, tryVisitSite } from "./lanes.ts";
import { siteOf } from "./cookieimport.ts";
import { diskAllows, diskEnabled } from "./disk.ts";
import { fsBrowseEnabled } from "./fsbrowse.ts";
import { VAULT_ASK_MS, takeVaultGrant } from "./vaultAsk.ts";
import { listVaults, readIndex, resolveVaultName, vaultChoiceNames } from "./loginvault.ts";

/** What the panel can be asked to do. Each one is implemented there; nothing
 *  here is interpreted, and there is deliberately no `eval`. */
/*
 * TABS, which the browser has had all along and the agents could not reach.
 *
 * The CLI only had open/read/click/type/wait/shot/text/back/forward/scroll/
 * press: no verb for switching tab, and `open` replaced the current view, so
 * an agent's side of the work had to move outside the browser.
 *
 * That is a real cost and it was ours: the panel has tabs, grouped into
 * folders, with profiles under them — and none of it was addressable. An
 * agent comparing two pages had to choose between losing the first one and
 * leaving the browser altogether.
 *
 *   tabs      what is open, with the active one marked
 *   tab       switch to one by index or by id
 *   newtab    open a URL in a NEW tab rather than over the current one
 *   closetab  close one
 *
 * `open` keeps replacing the current view, because that is what every
 * existing script expects it to do and changing it silently would be worse
 * than not having tabs at all.
 */
export type BrowserOp =
  | "open" | "read" | "markdown" | "extract" | "links" | "count" | "search"
  | "interactive" | "forms" | "attr" | "screencast"
  | "click" | "type" | "wait" | "shot"
  | "back" | "forward" | "scroll" | "press" | "text"
  | "tabs" | "tab" | "newtab" | "closetab"
  | "console" | "network" | "resize" | "zoom" | "html" | "waitfor" | "observe"
  | "eval" | "select" | "reload" | "cookies" | "frames"
  | "dblclick" | "rightclick" | "hover" | "focus" | "blur" | "check" | "fill"
  | "addInitScript" | "expose" | "exposed"
  | "cdp" | "listeners" | "coverage" | "profiles" | "emulate" | "events" | "record" | "audit"
  | "debug" | "clock" | "download" | "settings" | "drag" | "upload" | "storage" | "permission"
  | "pdf" | "throttle" | "har" | "region" | "clipboard" | "save" | "headers" | "fake"
  | "trace" | "intercept" | "checkup" | "dialog" | "handoff" | "vitals" | "a11y"
  | "guide" | "point"
  | "inspect"
  | "tools" | "call-tool"
  | "whoami"
  | "done"
  | "lane"
  | "health";
/** Every verb, exported so a test can hold the CLI and the MCP to it — see
 *  `browser-cli.test.ts`. Seven §3 verbs once shipped reachable by neither. */
export const BROWSER_OPS: readonly BrowserOp[] = [
  "open", "read", "markdown", "extract", "links", "count", "search",
  "interactive", "forms", "attr", "screencast",
  "click", "type", "wait", "shot",
  "back", "forward", "scroll", "press", "text",
  "tabs", "tab", "newtab", "closetab",
  "console", "network", "resize", "zoom", "html", "waitfor", "observe",
  "eval", "select", "reload", "cookies", "frames",
  "dblclick", "rightclick", "hover", "focus", "blur", "check", "fill",
  "addInitScript", "expose", "exposed",
  "cdp", "listeners", "coverage", "profiles", "emulate", "events", "record", "audit", "debug",
  "inspect",
  "tools", "call-tool",
  "clock", "download", "settings", "drag", "upload", "storage", "permission", "pdf",
  "throttle", "har", "region", "clipboard", "save", "headers", "fake", "trace", "intercept",
  "checkup", "dialog", "handoff", "vitals", "a11y",
  "guide", "point",
  "whoami",
  "done",
  "lane",
  "health",
];

/**
 * The keys that may be pressed.
 *
 * A closed set, and not because a letter would be dangerous — `type` already
 * puts letters in a field. These are the keys that are not text: the ones that
 * dismiss, submit, move a selection or page a list, which is the whole reason
 * an agent needs a key at all. Anything outside it is a request that would be
 * silently ignored by the page, and silence is the failure this whole surface
 * is written to avoid.
 */
const KEYS: readonly string[] = [
  "Enter", "Tab", "Escape", "Backspace", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown", "Home", "End",
];

export interface BrowserAsk {
  id: string;
  op: BrowserOp;
  /** Validated per-op below; the panel trusts what arrives here. */
  args: Record<string, unknown>;
}

export interface BrowserReply {
  ok: boolean;
  /** Shape depends on the op — see the panel. */
  value?: unknown;
  error?: string;
  /**
   * Attached automatically to a FAILURE, unasked — §15: "a failure always
   * attaches the last console errors, the last failed requests, and a
   * screenshot. This is the biggest time saver on the whole list, because
   * today a failure forces me to rebuild the state from outside." Built by
   * the panel (browserBus.ts) from the buffer `observe`/`console`/`network`
   * already read; absent on success and on a failure so early nothing had a
   * page to read it from.
   */
  diagnosis?: unknown;
  /**
   * That redaction FIRED, said out loud — §16.
   *
   * Present only when at least one span was masked, so an ordinary reply is
   * byte-for-byte what it always was. The failure this closes is the silent
   * one: a `read` came back with its `url` replaced by the literal
   * "[redacted]", `ok: true`, exit 0, and nothing anywhere for the caller to
   * notice. `fields` names the key each masked span sat under, `spans` is
   * their total, so a caller can decide whether to re-read with `shot` — which
   * is exempt from all of this — without diffing a page against itself.
   */
  redacted?: { spans: number; fields: Record<string, number> };
}

/** How long a request may wait for the window. Generous for a page load,
 *  short for the rest: the common failure is a selector that never appears,
 *  and an agent learns nothing from a minute of silence that it would not
 *  learn in fifteen seconds. */
const TIMEOUT_MS: Record<BrowserOp, number> = {
  open: 45_000, read: 15_000, markdown: 20_000, extract: 15_000, links: 15_000, count: 15_000, search: 15_000, interactive: 15_000, forms: 15_000, attr: 15_000, click: 15_000, type: 15_000, wait: 45_000, shot: 20_000,
  // Going back is a navigation and gets a navigation's patience; the rest are a
  // round trip to the page and nothing more.
  back: 45_000, forward: 45_000, scroll: 15_000, press: 15_000, text: 15_000,
  /* A new tab loads a page, so it gets a navigation's patience. Switching,
     closing and listing touch nothing on the network. */
  newtab: 45_000, tab: 15_000, closetab: 15_000, tabs: 15_000,
  /* `console` and `network` read a buffer the page has been filling; `html`
     and `resize` touch the page once. `waitfor` gets a navigation's patience
     because that is what people wait for. */
  console: 15_000, network: 15_000, html: 15_000, resize: 15_000, zoom: 15_000, waitfor: 45_000,
  /* One round trip that replaces six, so it is worth a page-load's patience. */
  observe: 30_000,
  /* `eval` may await a promise the page owns, so it gets a navigation's
     patience; a hard reload IS a navigation. */
  eval: 45_000, reload: 45_000, select: 15_000, cookies: 15_000, frames: 15_000,
  /* Same shape as `click`: a round trip that now includes polling the page for
     actionability (§3) before it acts, so it keeps click's patience rather
     than a plain round trip's. */
  dblclick: 15_000, rightclick: 15_000, hover: 15_000, focus: 15_000, blur: 15_000, check: 15_000,
  /* One call per field, so it gets a multiple of `type`'s patience rather than
     a single field's. */
  fill: 30_000,
  /* Registering a script with the shell's debugger session, not the page —
     no navigation to wait on. `exposed` reads a buffer, same patience as
     `console`/`network`. */
  addInitScript: 15_000, expose: 15_000, exposed: 15_000,
  /* A CDP command is usually instant, but `HeapProfiler.takeHeapSnapshot` and
     a profiler stop on a real page are not — this is the one verb whose upper
     bound is set by the slowest thing in the protocol, not the typical one. */
  cdp: 60_000, listeners: 15_000, coverage: 30_000, screencast: 20_000,
  /* A question the panel answers from memory. `whoami` is the same question
     with the caller's own identity folded in, and one extra `tabs` behind it. */
  profiles: 5_000, whoami: 5_000, done: 5_000, lane: 20_000,
  /* Several CDP overrides in one round trip, none of them slow. */
  emulate: 20_000,
  /* The one verb whose whole point is waiting. Its own `wait` bounds it; this
     is the ceiling above that, with room for the last poll to answer. */
  events: 130_000,
  /* Bounded by its own frames × interval, which parseAsk caps; this is the
     ceiling above that with room for the GIF to be assembled. */
  record: 200_000,
  /* Reading a list this process already holds. */
  audit: 5_000,
  /* A breakpoint that binds is instant; `where` walks a scope chain. Neither
     waits on the page, so this is a round trip's patience and not a pause's —
     the verb never blocks waiting for a pause to happen, `events` does that. */
  debug: 20_000,
  /* The whole point is that this does NOT cost wall-clock time proportional to
     the virtual ms advanced — a page's `Emulation.setVirtualTimePolicy` budget
     is drained by Chromium's own scheduler running the page's timers back to
     back, not by anyone waiting. This bound is for the JS the timers actually
     run, not for the jump itself. */
  clock: 30_000,
  /* A click plus however long the file takes to land on disk — generous
     because the thing being waited on is a network transfer, not a page. */
  download: 120_000,
  /* A CDP round trip or two, same shape as emulate. */
  settings: 15_000,
  /* A drag fires a sequence and then waits for whatever it dropped onto to
     settle; an upload is a debugger round trip plus the page's own reaction. */
  drag: 20_000, upload: 20_000,
  /* Reads and writes the page already holds; a PDF is Chromium laying the
     whole document out with its print stylesheet, which is slower. */
  storage: 15_000, permission: 15_000, pdf: 60_000,
  /* Both are settings changes, not waits. */
  throttle: 15_000, har: 15_000,
  /* One subtree read in the page — cheaper than `observe`, same patience. */
  region: 15_000,
  /* The sum, not a guess: a navigation's 40 s cap + the 15 s most a settle
     may be asked for, which its loop can overrun by a 2 s drain and a 1 s
     poll + the reads (7 s) + the 12 s the shell gets for a picture
     (SHELL_SHOT_MS) + four enables and four disables at 3 s each: about
     100 s. It was 75 s, and past that the relay answered "timeout" while the
     panel still held the domains on. Below the CLI's own 120 s. */
  checkup: 110_000,
  dialog: 15_000,
  /* One check waits up to 25 s inside the page; the CLI loops over checks. */
  handoff: 45_000,
  /* `guide next` waits up to 25 s in the panel for the person, like a handoff
     check; `point` resolves one element and starts its observer. */
  guide: 45_000, point: 20_000,
  vitals: 15_000, a11y: 15_000,
  /* Reading what a page offers is a round trip; running one of its tools is
     the page's own code, which may wait on a network of its own. The page-side
     race gives up at 25 s so this is never the first to say so. */
  tools: 15_000, "call-tool": 30_000,
  /* The clipboard is a round trip; a snapshot is Chromium serialising every
     subresource the page pulled in. */
  clipboard: 15_000, save: 60_000, headers: 15_000,
  /* A rule change, not a wait — the pausing happens to the page, not here. */
  intercept: 20_000,
  /* Registering, clearing or listing a rule — nothing on the page to wait
     on, the rule only acts on the NEXT request that matches it. */
  fake: 15_000,
  /* A yes/no about whether anything can answer at all — the one call that
     must never be the thing waiting on a hung page. */
  health: 5_000,
  /* Collecting and saving DevTools trace data — generous like record. */
  trace: 120_000,
  /* The inspector: opening one builds a whole DevTools front-end, and a shot
     of it may have to show the view off-window and wait a frame for it to be
     composited. Neither waits on the page, which is why this is nowhere near
     `record`'s budget. */
  inspect: 20_000,
};

/** Requests handed to the window and not yet answered. */
const pending = new Map<string, { resolve: (r: BrowserReply) => void; timer: ReturnType<typeof setTimeout>; target?: string }>();

/** How this reaches the window. Injected so the whole relay can be tested
 *  without a server, a socket or a browser. */
/**
 * The ops that actually cross the socket.
 *
 * `whoami` is not one of them. It is a question about the CALLER, and the
 * window has never met the caller — an identity is derived in the CLI's own
 * process from its environment — so the relay composes the answer out of a
 * `tabs` ask instead of forwarding a verb the panel has no case for. The wire
 * frame in `shared/types.ts` is therefore RIGHT to have no `whoami`, and
 * saying so in the type is what keeps the two lists honest: without this the
 * only way to make the compiler quiet would have been to widen the wire frame
 * with a verb nothing on the far side can answer.
 */
export type BrowserWireOp = Exclude<BrowserOp, "whoami">;
export interface BrowserWireAsk { id: string; op: BrowserWireOp; args: Record<string, unknown> }

/** `send` addresses ONE window. `false` says the address has no live socket (a
 *  registration that outlived its connection); anything else counts as sent. */
let sink: { send: (ask: BrowserWireAsk, clientId: string) => unknown; listeners: () => number; live?: (clientId: string) => boolean } | null = null;
export function setBrowserSink(s: typeof sink) { sink = s; }

/**
 * Which clients can actually drive a browser, and when they last said so.
 *
 * "Is anybody listening" was the wrong question and it produced a wrong answer
 * in an ordinary setup: the ask goes to every open client, and a dashboard
 * loaded in an ordinary browser tab is a client too. It has no `<webview>` —
 * that is an Electron thing — so it answered "the browser view is not open in
 * this window" and, being first, that became the agent's answer while the
 * desktop app sat there perfectly able to do the work.
 *
 * So a panel registers itself, and only a registered one replies. A stale
 * registration is worse than none — it turns a fast, honest "no window" into a
 * fifteen-second timeout — so it is a heartbeat with a TTL rather than a flag
 * somebody has to remember to clear on a crash.
 */
const ready = new Map<string, { at: number; since: number; lanes: string[] }>();
const READY_TTL_MS = 90_000;

/**
 * `lanes` are the lane names a window hosts; empty for the main window. An ask
 * goes to exactly one registered window: the host of `args.lane`, else the most
 * recently REGISTERED one with no lanes (not the latest heartbeat, which would swap the target every 30 s between two windows). The ask used to be broadcast to every open socket,
 * fill and type text included, so a phone or a dashboard tab read what an agent
 * typed into a page. Which callers may REGISTER is decided at the route, not
 * here (mayHostBrowser in index.ts: the desktop app's key). What is decided
 * here is only that the newest registration wins among those admitted.
 */
export function noteBrowserReady(client: unknown, on: boolean, lanes?: unknown): boolean {
  if (typeof client !== "string" || !client || client.length > 128) return false;
  if (!on) { ready.delete(client); return true; }
  const names = Array.isArray(lanes)
    ? lanes.filter((l): l is string => typeof l === "string" && l.length > 0 && l.length <= 64).slice(0, 16)
    : [];
  ready.set(client, { at: Date.now(), since: ready.get(client)?.since ?? Date.now(), lanes: names });
  return true;
}

/**
 * The window that makes lane hosts. Not the Browser panel and not a lane: the
 * app's own window, which registers for this alone, so lanes can be opened
 * while no panel is mounted — the whole point of a lane is that the agent does
 * not need the person's view. Its own map, because the same window is often
 * also a panel under the same client id and one registration must not shadow
 * the other.
 */
let leftoversDone = false;
let leftovers: ContainerSignIn[] | null = null;
const managers = new Map<string, { at: number; since: number }>();

export function noteBrowserManager(client: unknown, on: boolean): boolean {
  if (typeof client !== "string" || !client || client.length > 128) return false;
  if (!on) { managers.delete(client); return true; }
  managers.set(client, { at: Date.now(), since: managers.get(client)?.since ?? Date.now() });
  /* The first window that can answer after a start: what a crash left in an
     agent's container is removed now (decision B). */
  if (!leftoversDone) {
    leftoversDone = true;
    /* The ids in the book NOW are the crash's; a retry takes only those that
       are still there, never a sign-in a live agent made since. */
    leftovers ??= signInsWhere(() => true);
    const left = new Set(leftovers);
    const todo = signInsWhere((s) => left.has(s));
    void wipeSignIns(todo, "left from a crash").then((ok) => { if (!ok) leftoversDone = false; });
  }
  return true;
}

function pickManager(): string | null {
  const cutoff = Date.now() - READY_TTL_MS;
  let best: string | null = null;
  let bestSince = -1;
  for (const [id, r] of managers) {
    if (r.at < cutoff) { managers.delete(id); continue; }
    if (sink?.live && !sink.live(id)) continue;
    if (r.since >= bestSince) { best = id; bestSince = r.since; }
  }
  return best;
}

/** Whether a live window registered as the host of this lane. */
function laneHosted(lane: string): boolean {
  browserReadyCount();
  for (const [id, r] of ready) if (r.lanes.includes(lane) && (!sink?.live || sink.live(id))) return true;
  return false;
}

/** A closed lane's registration goes with it, and so does whatever it was asked. */
function forgetLaneHost(lane: string): void {
  for (const [id, r] of ready) {
    if (!r.lanes.includes(lane)) continue;
    ready.delete(id);
    dropBrowserTarget(id);
  }
}

/** How many windows could drive a browser right now. */
export function browserReadyCount(): number {
  const cutoff = Date.now() - READY_TTL_MS;
  for (const [id, r] of ready) if (r.at < cutoff) ready.delete(id);
  return ready.size;
}

/** The one window an ask is for, or null when nobody can take it. */
function pickTarget(lane: unknown): string | null {
  browserReadyCount();
  let best: string | null = null;
  let bestSince = -1;
  for (const [id, r] of ready) {
    const fits = typeof lane === "string" && lane ? r.lanes.includes(lane) : r.lanes.length === 0;
    /* A registration whose socket is gone is not a candidate: a closed window,
       or a bare POST /browser/ready with no socket, must not win the pick and
       blackhole every ask while a healthy window sits idle. */
    if (sink?.live && !sink.live(id)) continue;
    if (fits && r.since >= bestSince) { best = id; bestSince = r.since; }
  }
  return best;
}

/**
 * The lane a request named, for everything that request goes on to ask.
 *
 * `--lane` used to ride only on the ask the CLI sent, so a verb the relay
 * composes out of several (`do`, `record`, `download`, `events`, `scrape`,
 * `whoami`) sent its steps with no lane and they landed in the person's visible
 * tab. Carrying it on each of those hand-built asks is what went missing six
 * times; the request is the one place that knows it, so it is kept there.
 */
const laneScope = new AsyncLocalStorage<{ lane: string; as?: string; owner?: string; force: boolean }>();

/**
 * The door for a request that names a lane: refuses at once, by name, one that
 * is closed, unknown or somebody else's, and otherwise puts the lane in scope for
 * the rest of this request. Returns the refusal, or null.
 *
 * `principal` is the worker the credential was minted for. A lane it did not
 * make is refused here, before the id is put in scope, so no verb composed out
 * of this request can reach it afterwards.
 */
/*
 * Lanes signed in from the login vault (decision F7). In one, any verb that
 * could read the login back out is refused: the agent may use the session,
 * never export it. Acting on the page and reading what it says stay allowed.
 * The mark is a lane id and nothing else; the values are in Electron main.
 */
const vaultLanes = new Set<string>();
/* Pulls on their way into a lane (finding 1): the lane is guarded from the
   moment a pull is asked for, before main sets the first cookie, not after
   its answer comes back. A count, so two pulls into one lane cannot unguard
   each other. */
const vaultPulling = new Map<string, number>();
/* Lanes whose vault said "sign agents out when the task ends": `done` from
   the lane's agent closes them (finding 4). */
const vaultSignOut = new Set<string>();
export const VAULT_LANE_REFUSED: ReadonlySet<string> = new Set([
  "eval", "waitfor", "cookies", "storage", "har", "headers", "network", "cdp", "addInitScript", "debug", "trace", "save", "expose", "record",
]);
export function markVaultLane(lane: string, signOutAtEnd?: boolean): void {
  vaultLanes.add(lane);
  if (signOutAtEnd === true) vaultSignOut.add(lane);
  else if (signOutAtEnd === false) vaultSignOut.delete(lane);
}
export function forgetVaultLane(lane: string): void { vaultLanes.delete(lane); vaultPulling.delete(lane); vaultSignOut.delete(lane); }
export function isVaultLane(lane: string): boolean { return vaultLanes.has(lane) || (vaultPulling.get(lane) ?? 0) > 0; }
export function vaultLaneRefusal(op: string, lane: unknown): string | null {
  if (typeof lane !== "string" || !isVaultLane(lane) || !VAULT_LANE_REFUSED.has(op)) return null;
  return `${op} is refused in a lane signed in from the login vault: it could read the login back out. Act on the page instead`;
}

export function gateLane(op: string, body: unknown, principal?: string): string | null {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (b.lane === undefined || op === "lane") return null;
  const owner = typeof principal === "string" && principal.trim() ? foldWorkerName(principal) : undefined;
  const as = owner ?? (typeof b.as === "string" ? b.as : undefined);
  const msg = !isLaneId(b.lane) ? "lane must be the id `lane new` printed"
    : laneRefusal(b.lane, as, b.force === true, !!owner) ?? vaultLaneRefusal(op, b.lane);
  if (msg) {
    recordAudit(op as BrowserOp, { lane: b.lane }, false, msg, false, undefined, as ? { as } : undefined);
    return msg;
  }
  laneScope.enterWith({ lane: b.lane as string, ...(as ? { as } : {}), ...(owner ? { owner } : {}), force: b.force === true });
  return null;
}

/** The CLI's identity key for the person's own container (`--shared`, and
 *  `--as "(default)"`, which it maps onto the same value). */
const SHARED_KEY = "(default)";

/**
 * The person's own browser, in every spelling that reaches this relay.
 *
 * `bin/agentglass-browser` writes the identity as `as`, and `--shared` sends
 * none at all; the MCP sends `shared: true`; `open` names the empty profile;
 * a lane names the container. One container, five fields — a refusal that names
 * one of them is a refusal somebody walks around with the next flag.
 */
export function namesThePerson(body: unknown): boolean {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (
    b.shared === true
    || b.active === true
    || b.container === "shared"
    || b.how === "shared"
    || b.profile === ""
  ) return true;
  /* A page id addresses a tab this gate cannot place: the tab may live in the
     person's container, and asking the window which lane it belongs to is a
     round trip a refusal cannot make. Agents address tabs through their lane. */
  if (typeof b.page === "string" && b.page.trim()) return true;
  if (typeof b.as === "string" && b.as.trim()) return b.as.trim().toLowerCase() === SHARED_KEY;
  /* A lane being created is a container of its own: `new` defaults to
     `private`, which names nobody. Every other fall-through is the person's. */
  if (b.action === "new" && b.container !== "shared") return false;
  /* No identity at all is the person's container — the CLI sends no `as` for
     `--shared` — unless the request named a container of its own. */
  const named = typeof b.profile === "string" && !!b.profile.trim();
  return !named && b.container !== "named";
}

/**
 * Whether a body sent under a WORKER's credential addresses something that is
 * the worker's own: `as` its name, its own profile, its own page, a lane of its
 * own. Anything else is refused — a body with no identity is the person's tab
 * in front, and this gate cannot place a page it was not told the owner of.
 */
/* Every verb the CLI parser or the panel's op switch exposes, and what a
   worker's credential may do with it. `target` is the request field that
   addresses a tab: `page` is inherited from the call, `id` is the field
   `tab`/`closetab` carry. An empty list means the verb addresses no tab (it
   mints one, or answers about the caller). `index` is absent everywhere on
   purpose — the panel resolves an ordinal against every tab in the window,
   not against this worker's own pages. */
export type WorkerVerbPolicy = "own" | "refused";
export interface WorkerVerbRow {
  policy: WorkerVerbPolicy;
  target: readonly ("page" | "id")[];
  fields: readonly string[];
}
const workerPage = (...fields: string[]): WorkerVerbRow => ({ policy: "own", target: ["page"], fields });
const workerId = (...fields: string[]): WorkerVerbRow => ({ policy: "own", target: ["id"], fields });
const workerNoTarget = (...fields: string[]): WorkerVerbRow => ({ policy: "own", target: [], fields });
const WORKER_REFUSED: WorkerVerbRow = { policy: "refused", target: [], fields: [] };
const refusedVerb = () => WORKER_REFUSED;

const LIST_FIELDS = ["url", "profile", "identity", "show", "ephemeral"];
const TRACE_FIELDS = ["delta", "limit", "root", "shot", "since", "viewport"];

export const WORKER_VERBS: Readonly<Record<string, WorkerVerbRow>> = {
  open: workerNoTarget(...LIST_FIELDS, "vault"),
  read: workerPage(),
  markdown: workerPage(),
  extract: workerPage("fields"),
  links: workerPage(),
  count: workerPage("selector"),
  search: workerPage("query"),
  interactive: workerPage(),
  forms: workerPage(),
  attr: workerPage("selector", "names"),
  click: workerPage("selector"),
  type: workerPage("selector", "text", "submit"),
  wait: workerPage("selector"),
  shot: workerPage("path", "fullPage", "withInspector", "selector", "clip", "highlight", "label", "marks", "omitBackground"),
  back: workerPage(),
  forward: workerPage(),
  scroll: workerPage("selector", "by", "to"),
  press: workerPage("key"),
  text: workerPage("selector"),
  tabs: workerNoTarget(),
  tab: workerId("id"),
  newtab: workerNoTarget(...LIST_FIELDS),
  closetab: workerId("id"),
  console: workerPage(...TRACE_FIELDS),
  network: workerPage(...TRACE_FIELDS),
  resize: workerPage("width", "height"),
  zoom: workerPage("factor"),
  html: workerPage("clean", "max", "selector"),
  waitfor: workerPage("js", "timeoutMs", "until"),
  observe: workerPage(...TRACE_FIELDS),
  select: workerPage("selector", "value"),
  reload: workerPage("bypassCache"),
  frames: workerPage(),
  dblclick: workerPage("selector"),
  rightclick: workerPage("selector"),
  hover: workerPage("selector"),
  focus: workerPage("selector"),
  blur: workerPage("selector"),
  check: workerPage("selector", "checked"),
  fill: workerPage("fields", "submit"),
  events: workerPage("kinds", "since", "wait", "timeoutMs"),
  whoami: workerNoTarget("identity", "tab"),
  health: workerNoTarget(),
  lane: workerNoTarget("action", "id", "profile", "shared", "force", "ephemeral", "container", "site", "vault"),
  /* The CLI's `vault LANE --site S` is `lane vault` under another name: it is
     sent as the `lane` op, so it is decided the same way. */
  vault: workerNoTarget("id", "site", "vault"),
  a11y: workerPage(),
  inspect: workerPage("action"),
  vitals: workerPage(),
  /* A step list carries its own verbs and pages; each step is gated below. */
  do: workerNoTarget("steps", "lanes", "observe"),
  addInitScript: refusedVerb(), audit: refusedVerb(), "call-tool": refusedVerb(),
  cdp: refusedVerb(), checkup: refusedVerb(), clipboard: refusedVerb(),
  clock: refusedVerb(), cookies: refusedVerb(), coverage: refusedVerb(),
  debug: refusedVerb(), dialog: refusedVerb(), done: refusedVerb(),
  download: refusedVerb(), drag: refusedVerb(), emulate: refusedVerb(),
  eval: refusedVerb(), expose: refusedVerb(), exposed: refusedVerb(),
  fake: refusedVerb(), handoff: refusedVerb(), har: refusedVerb(),
  /* A guide is an agent talking the PERSON through their own page: a worker's
     credential works in its own container, where there is nobody to guide. */
  guide: refusedVerb(), point: refusedVerb(),
  headers: refusedVerb(), intercept: refusedVerb(), listeners: refusedVerb(),
  pdf: refusedVerb(), permission: refusedVerb(), permissions: refusedVerb(),
  profiles: refusedVerb(), record: refusedVerb(), region: refusedVerb(),
  save: refusedVerb(), scrape: refusedVerb(), screencast: refusedVerb(),
  script: refusedVerb(), session: refusedVerb(), settings: refusedVerb(),
  storage: refusedVerb(), template: refusedVerb(), throttle: refusedVerb(),
  tools: refusedVerb(), trace: refusedVerb(), upload: refusedVerb(),
};
/* The row a verb has NOW: the table above is the default, and Settings ▸
   Browser ▸ Worker verbs turns a whole group on or off. A lifted verb is
   addressed like any page verb (its page must be the worker's own, and the
   identity checks above it still hold); it has no per-field list, so its
   fields are not narrowed: "*". Ceiling: a lifted group is the worker's own
   container's, never the person's, because the credential cannot name that. */
const LIFTED_ROW: WorkerVerbRow = { policy: "own", target: ["page"], fields: ["*"] };
function workerVerbRow(op: string): WorkerVerbRow | undefined {
  const base = WORKER_VERBS[op];
  if (!base) return undefined;
  const group = groupOfVerb(op);
  if (!group) return base;
  const on = workerVerbGroups().includes(group);
  if (!on) return WORKER_REFUSED;
  return base.policy === "own" ? base : LIFTED_ROW;
}
export const WORKER_OPS: ReadonlySet<string> = new Set(
  Object.entries(WORKER_VERBS)
    .filter(([op, r]) => r.policy === "own" && op !== "do")
    .map(([op]) => op),
);
/* Deny-by-default: a worker's body may carry only these fields for its op.
   `observe` and `partial` are request options the CLI writes on any verb
   (`--observe`, `--max-tokens`), not fields of one verb: refusing them refused
   the act they rode on. `roots` is the same kind: the MCP writes the turn's
   writable roots on every body when `AGX_TURN_WRITE_ROOTS` is set, and the
   route only ever narrows with it (no roots = no check), so refusing it
   refused every call a sandboxed worker made, `health` included. */
const WORKER_COMMON_FIELDS: ReadonlySet<string> = new Set([
  "as", "how", "lane", "page", "pageExplicit", "observe", "partial", "roots",
]);
export const WORKER_OP_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(WORKER_VERBS)
    .filter(([, r]) => r.policy === "own")
    .map(([op, r]) => [op, new Set(r.fields)]),
);
const WORKER_LIST_OPS: ReadonlySet<string> = new Set(
  Object.entries(WORKER_VERBS).filter(([, r]) => !r.target.includes("page")).map(([op]) => op),
);
const WORKER_DO_FIELDS: ReadonlySet<string> = new Set(["steps", "lanes", "observe"]);
const WORKER_LANE_FIELDS: ReadonlySet<string> = new Set(["steps"]);
const WORKER_STEP_FIELDS: ReadonlySet<string> = new Set(["op", "args"]);
const WORKER_PAGES = new Map<string, Set<string>>();
const ASK_WORKER = new Map<string, { worker: string; op: string; target?: string }>();

export function noteWorkerAsk(id: string, worker: string, op: string, target?: string): void {
  ASK_WORKER.set(id, { worker: foldWorkerName(worker), op, ...(target ? { target } : {}) });
}
export function workerOwnsPage(worker: string, page: string): boolean {
  return WORKER_PAGES.get(foldWorkerName(worker))?.has(page) === true;
}
/* A reply that names a page. The walk below is shape-agnostic on purpose: the
   panel answers `tabs` with a BARE ARRAY (`tabs.list()`), and a filter written
   against `{tabs: [...]}` never fired on it — a worker read every tab title and
   URL in the window. So the rule is the field, not the container. */
const PAGE_FIELDS = ["id", "url", "title"] as const;
/* The keys a tab or identity answer carries. Anything else at the top level is
   a shape this cannot attribute, and an unattributable answer is an empty
   list, never the value itself. */
const REPLY_KEYS: ReadonlySet<string> = new Set(["tabs", "tab", "activeTab", "you"]);

type Kept = { keep: true; value: unknown } | { keep: false };
const DROP: Kept = { keep: false };

function namesPage(o: Record<string, unknown>): boolean {
  return PAGE_FIELDS.some((f) => f in o);
}

/** A value with every page entry that is not the worker's own removed. An
 *  entry carrying a page field and no own id is dropped, whatever its shape. */
function scopeValue(own: (id: string) => boolean, v: unknown): Kept {
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const e of v) {
      const s = scopeValue(own, e);
      if (s.keep) out.push(s.value);
    }
    return { keep: true, value: out };
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (namesPage(o)) return typeof o.id === "string" && own(o.id) ? { keep: true, value: o } : DROP;
    return scopeObject(own, o);
  }
  return { keep: true, value: v };
}

function scopeObject(own: (id: string) => boolean, o: Record<string, unknown>): Kept {
  const out: Record<string, unknown> = {};
  let droppedActive = false;
  let droppedTab = false;
  for (const [k, val] of Object.entries(o)) {
    if (k === "tab") {
      droppedTab = typeof val === "string" && !own(val);
      out[k] = droppedTab ? null : val;
      continue;
    }
    if (k === "activeTab") {
      const s = val === null || val === undefined ? DROP : scopeValue(own, val);
      droppedActive = !s.keep;
      out[k] = s.keep ? s.value : null;
      continue;
    }
    const s = scopeValue(own, val);
    if (s.keep) out[k] = s.value;
  }
  if (droppedTab) out.tabLive = false;
  const you = out.you;
  if (droppedActive && you && typeof you === "object" && !Array.isArray(you)) {
    out.you = { ...(you as Record<string, unknown>), tabLive: false };
  }
  return { keep: true, value: out };
}

/* The verbs whose answer carries the window's list. One set, read at the one
   door a reply passes through (`askBrowser`), so a route added later — `do`,
   `lanes`, whatever comes next — cannot hand a worker the window's list by
   forgetting to name its verb here. */
const WORKER_PAGE_REPLY_OPS: ReadonlySet<string> = new Set(["tabs", "tab", "open", "newtab", "closetab", "whoami"]);

/** A worker sees only the tabs it opened. The request gate stops an act on a
 *  foreign id; this stops a reply from naming one, whatever shape the panel
 *  answered in — the array `tabs` really sends, the object `open` folds the
 *  list into, or a nested one. Fail closed: a value it cannot attribute is
 *  replaced by an empty list. */
export function workerReply(worker: string, reply: BrowserReply): BrowserReply {
  if (!reply.ok) return reply;
  const own = (id: string) => workerSees(worker, id);
  const v = reply.value;
  if (Array.isArray(v)) {
    const s = scopeValue(own, v);
    return { ...reply, value: s.keep ? s.value : [] };
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (!Object.keys(o).some((k) => REPLY_KEYS.has(k))) {
      return namesPage(o) && typeof o.id === "string" && own(o.id)
        ? reply
        : { ...reply, value: [] };
    }
    const s = scopeObject(own, o);
    return { ...reply, value: s.keep ? s.value : [] };
  }
  return { ...reply, value: [] };
}
/* What a worker's `health` may report: whether each layer is up, never the
   page itself. The panel's own summary carries `url=<getURL()>`, which is the
   person's active tab, so the summary is rebuilt from these booleans. */
const WORKER_HEALTH_FIELDS = ["window", "panel", "ready", "mounted", "hasPage"] as const;
export function workerHealth(reply: BrowserReply): BrowserReply {
  if (!reply.ok) return reply;
  const v = reply.value && typeof reply.value === "object" && !Array.isArray(reply.value)
    ? reply.value as Record<string, unknown>
    : {};
  const value: Record<string, unknown> = {};
  for (const k of WORKER_HEALTH_FIELDS) if (k in v) value[k] = v[k];
  const windowOpen = v.window === true || v.panel === true || v.mounted === true || v.hasPage === true;
  const panelOn = v.panel === true || v.mounted === true;
  value.summary = `window ${windowOpen ? "open" : "closed"} · panel ${panelOn ? "mounted" : "not mounted"}`
    + ` · ${v.hasPage === true ? "a page is mounted" : "no page open"}`;
  return { ...reply, value };
}
/** The registry's own door: a test seeds a page the way a reply would. */
export function noteWorkerPage(worker: string, page: string): void {
  const w = foldWorkerName(worker);
  let s = WORKER_PAGES.get(w);
  if (!s) { s = new Set(); WORKER_PAGES.set(w, s); }
  s.add(page);
}
export function resetWorkerPages(): void {
  WORKER_PAGES.clear();
  ASK_WORKER.clear();
}
/** Drop a name's pages when its credential is revoked: the next turn under the
 *  same name must not inherit ids the previous one opened. Its vault lanes
 *  with sign-out on are closed here too. */
export function forgetWorkerPages(worker: string): void {
  const w = foldWorkerName(worker);
  WORKER_PAGES.delete(w);
  for (const [id, ask] of ASK_WORKER) if (ask.worker === w) ASK_WORKER.delete(id);
  /* Its session ended: its guide grants end with it. */
  dropGrantsOf(worker);
  /* The turn ended (stopped, crashed, or simply finished) without `done`:
     "sign agents out when the task ends" still holds (finding 4). */
  void signOutVaultLanes(worker, true, true).catch(() => []);
}
/** How many asks are still waiting for a window, so a test can prove they do
 *  not accumulate. */
export function workerAskCount(): number { return ASK_WORKER.size; }
/** File the page id a reply names under the worker that asked. An
 *  `open`/`newtab` names its own page; every other reply only when it says the
 *  container is the worker's. */
function recordWorkerReply(id: string, reply: BrowserReply): void {
  const ask = ASK_WORKER.get(id);
  if (!ask) return;
  ASK_WORKER.delete(id);
  if (!reply.ok) return;
  const v = reply.value as Record<string, unknown> | undefined;
  /* `closetab` answers with the whole window's list (a bare array), so the id
     it closed is the one the ask carried. */
  if (ask.op === "closetab" && ask.target) {
    WORKER_PAGES.get(ask.worker)?.delete(ask.target);
    return;
  }
  if (!v || typeof v !== "object") return;
  if (ask.op === "closetab" && typeof v.tab === "string") {
    WORKER_PAGES.get(ask.worker)?.delete(v.tab);
    return;
  }
  /* A mint is filed only when the panel says the tab is in the worker's own
     container, and that container is the RESERVED one the relay asked for. The
     reply's top-level `profile` is only used when the list has no row for the
     tab; the row is keyed by the id the mint returned, so the confirmation is
     about that tab rather than about a name appearing somewhere in the answer.
     A person's profile cannot take the reserved name (`addProfile` refuses it)
     and the panel mints it rather than resolving it. */
  const want = agentContainerName(ask.worker);
  const minted = typeof v.tab === "string" ? v.tab : typeof v.id === "string" ? v.id : "";
  const rows = Array.isArray(v.tabs) ? v.tabs : [];
  const rowOf = minted ? rows.find((t) => (t as Record<string, unknown>)?.id === minted) as Record<string, unknown> | undefined : undefined;
  const said = rowOf && typeof rowOf.profile === "string"
    ? foldWorkerName(rowOf.profile)
    : typeof v.profile === "string" ? foldWorkerName(v.profile) : "";
  if (minted && said === want && isAgentContainer(want)) noteWorkerPage(ask.worker, minted);
  for (const t of rows) {
    const tab = t as Record<string, unknown>;
    const p = typeof tab.profile === "string" ? foldWorkerName(tab.profile) : "";
    if (p === want && typeof tab.id === "string" && tab.id) noteWorkerPage(ask.worker, tab.id);
  }
}
export function workerOpRefusal(op: string): string {
  const group = groupOfVerb(op);
  const lift = group
    ? ` Settings ▸ Browser ▸ Worker verbs lifts it: turn on ${WORKER_VERB_GROUPS[group]!.title}.`
    : " No setting lifts it: the verb reaches past the worker's own container.";
  return "this credential was minted for an agent, and the browser relay runs only the verbs an agent's own "
    + `container can do: "${op}" is not one of them.${lift}`;
}
/* Guide grants (browserGuideGrants.ts, Settings ▸ Browser ▸ Worker verbs ▸
   Guide grants). A worker with a live grant for its own name may talk the
   person through THEIR OWN tab on the granted site: guide start/point/next/end,
   and the reads in GUIDE_READ_VERBS on that one tab while its own guide runs
   there. This sync gate checks the name; the site is checked where the tab's
   URL is known (composeGuide, guideReadRefusal). Nothing in the person's
   container acts for it — no click, fill, open, eval, cookies, vault — with or
   without a guide running. */
const GUIDE_VERBS: ReadonlySet<string> = new Set(["guide", "point"]);
const GUIDE_READS: ReadonlySet<string> = new Set(GUIDE_READ_VERBS);
const GUIDE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  guide: new Set(["action", "why", "waitMs", "plan", "say"]),
  point: new Set(["selector", "say", "waitClick", "wait", "text", "copy", "expect", "step"]),
};
/** The live guide on `tab` when this worker runs it. */
function ownGuideOn(own: string, tab: string | undefined): boolean {
  const g = tab ? guideOf(tab) : undefined;
  return !!g && sameCaller(g.as, own);
}
/** A tab this worker may see in a tab list: its own, or the one its guide runs on (switch on). */
function workerSees(worker: string, id: string): boolean {
  return workerOwnsPage(worker, id) || (hasAnyGrant(worker) && ownGuideOn(foldWorkerName(worker), id));
}
/**
 * The guide door. `undefined`: not a guide ask, the usual worker rules decide.
 * `null`: allowed. A string: refused, and with the switch off it names the switch.
 */
function workerGuideAsk(
  b: Record<string, unknown>, own: string, op: string | undefined, page: string | undefined, step: boolean,
): string | null | undefined {
  if (!op) return undefined;
  const named = typeof b.page === "string" && b.page.trim() ? b.page.trim() : page;
  const sharedAsk = b.shared === true || b.how === "shared";
  const isGuide = GUIDE_VERBS.has(op);
  const guided = ownGuideOn(own, named);
  /* A plain `--page <tab>` of the tab this worker guides is the same ask as `--shared --page <tab>`. */
  const onPerson = sharedAsk || (guided && !!named && !workerOwnsPage(own, named));
  if (!isGuide && !onPerson) return undefined;
  if (!hasAnyGrant(own)) return isGuide || GUIDE_READS.has(op) ? noGrantRefusal(own) : undefined;
  if (!isGuide && !GUIDE_READS.has(op)) {
    return `this credential was minted for an agent, and on the person's own tab a worker only guides and reads: "${op}" is refused there, during a guide too. `
      + "Point at it instead (point <selector> --say \"<what to do>\") and the person does it.";
  }
  if (step) {
    return `this credential was minted for an agent, and "${op}" on the person's tab is one ask at a time, never a step of a \`do\`.`;
  }
  for (const key of ["profile", "container", "lane", "force", "ephemeral", "name", "active"]) {
    if (b[key] !== undefined) {
      return `this credential was minted for an agent, and "${key}" does not go with a guide of the person's tab: send only --shared (guide start), or --shared --page <tab>.`;
    }
  }
  if (typeof b.as === "string" && b.as.trim() && foldWorkerName(b.as) !== own) return AGENT_SHARED_REFUSAL;
  const fields = isGuide ? GUIDE_FIELDS[op]! : new Set(WORKER_VERBS[op]?.fields ?? []);
  for (const key of Object.keys(b)) {
    if (key === "shared" || WORKER_COMMON_FIELDS.has(key) || fields.has(key)) continue;
    return `this credential was minted for an agent, and the ask carries "${key}", which "${op}" does not read: refused rather than guessed at.`;
  }
  if (isGuide) {
    /* `guide start` with no tab is the tab in front; the relay checks it is the person's. */
    if (op === "guide" && (b.action === "start" || b.action === "run")) return null;
    if (named && !guided) return `this credential was minted for an agent, and no guide of yours runs on ${named}: guide start "<why>" --shared first.`;
    return null;
  }
  if (op === "tabs") return null;
  if (!named) return "this credential was minted for an agent, and a read of the person's tab names the tab: --shared --page <tab>, the tab guide start answered with.";
  if (!guided) {
    return `this credential was minted for an agent, and it reads the person's tab only while its own guide runs there: `
      + `guide start "<why>" --shared first.`;
  }
  return null;
}
function workerSchemaRefusal(b: Record<string, unknown>, op: string | undefined): string | null {
  const row = op !== undefined && op !== "do" ? workerVerbRow(op) : undefined;
  if (row?.policy === "own" && row.fields.includes("*")) return null;
  const fields = op === undefined ? WORKER_LANE_FIELDS : op === "do" ? WORKER_DO_FIELDS : row?.policy === "own" ? new Set(row.fields) : undefined;
  if (!fields) {
    return `this credential was minted for an agent, and "${op}" has no declared fields here: the ask is refused rather than read as some other verb.`;
  }
  for (const key of Object.keys(b)) {
    if (WORKER_COMMON_FIELDS.has(key) || fields.has(key)) continue;
    return "this credential was minted for an agent, and the ask carries "
      + `"${key}", which ${op ? `"${op}"` : "a lane"} does not read: refused rather than guessed at, `
      + "and nothing is addressed by position in the window's list.";
  }
  return null;
}
/** A URL that logs the page into the app (`/?token=…`). A worker that learned
 *  the machine token must not be able to spend it through its browser. */
export const WORKER_TOKEN_URL_REFUSAL = "this credential was minted for an agent, and a URL that carries `token=` "
  + "would sign the page in to the app as the person: the app's own credential is not something a worker's page may use.";
export const WORKER_AUTH_HEADER_REFUSAL = "this credential was minted for an agent, and an `Authorization` header would "
  + "sign its page in to the app as the person: the app's own credential is not something a worker's page may use.";
export function urlCarriesToken(raw: string): boolean {
  /* Absolute or relative alike: a relative string is read against a dummy base,
     so `/?%74oken=X` is decoded exactly as `http://h/?%74oken=X` is. */
  let u: URL;
  try { u = new URL(raw, "http://x/"); } catch { return false; }
  const has = (params: URLSearchParams) => [...params.keys()].some((k) => k.toLowerCase() === "token");
  if (has(u.searchParams)) return true;
  /* The hash is where a single-page app reads its own query (`#/p?token=X`):
     the part after its `?` is decoded the same way. */
  const h = u.hash.slice(1);
  const q = h.indexOf("?");
  return has(new URLSearchParams(q >= 0 ? h.slice(q + 1) : h));
}
/** Every string anywhere in a request body, at any depth and under any key,
 *  that reads as a URL carrying a token. `cdp` `Page.navigate` params, a step's
 *  args and whatever shape the executor learns next are all covered without
 *  naming them. Walked with a stack, and capped by node count, not depth. */
export function bodyCarriesToken(body: unknown): boolean {
  const stack: unknown[] = [body];
  for (let seen = 0; stack.length && seen < 20_000; seen++) {
    const v = stack.pop();
    if (typeof v === "string") { if (urlCarriesToken(v)) return true; }
    else if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === "object") stack.push(...Object.values(v));
  }
  return false;
}
function workerAskRefused(
  b: Record<string, unknown>, own: string, op: string | undefined, page: string | undefined,
  afterOwnOpen = false, deferAddress = false, laneAddressed = false,
): string | null {
  const guide = workerGuideAsk(b, own, op, page, deferAddress);
  if (guide !== undefined) return guide;
  if (b.shared === true || b.active === true) return AGENT_SHARED_REFUSAL;
  if (b.how === "shared") return AGENT_SHARED_REFUSAL;
  /* `force` is a lever over somebody else's lane — it lists every caller's
     lanes and closes one that is not the asker's. A worker already holds every
     lane it may use, so there is nothing to insist past. */
  if (b.force === true) {
    return "this credential was minted for an agent, and `force` is not one of its levers: it overrides "
      + "the owner of a lane, and the lanes this agent may use are already its own.";
  }
  if (typeof b.url === "string" && urlCarriesToken(b.url)) return WORKER_TOKEN_URL_REFUSAL;
  /* `scrape` takes a list. Every entry is looked at, a non-string one too. */
  if (Array.isArray(b.urls) && b.urls.some((u) => typeof u === "string" && urlCarriesToken(u))) return WORKER_TOKEN_URL_REFUSAL;
  /* The server takes the token as `Authorization: Bearer` or `?token=` only
     (auth.ts `presented`), never as a cookie. A group of verbs the person lifted
     in Settings may set headers, so that one header stays refused whatever is
     lifted. */
  if (op === "headers" && b.headers && typeof b.headers === "object"
      && Object.keys(b.headers).some((k) => k.toLowerCase() === "authorization")) {
    return WORKER_AUTH_HEADER_REFUSAL;
  }
  for (const key of ["as", "profile", "name"] as const) {
    const v = b[key];
    if (typeof v === "string" && v.trim() && foldWorkerName(v) !== own) return AGENT_SHARED_REFUSAL;
  }
  if (typeof b.container === "string" && b.container.trim()) {
    const c = foldWorkerName(b.container);
    if (c !== own && c !== "private") return AGENT_SHARED_REFUSAL;
  }
  if (op && op !== "do" && workerVerbRow(op)?.policy !== "own") return workerOpRefusal(op);
  const unknown = workerSchemaRefusal(b, op);
  if (unknown) return unknown;
  const target = op ? workerVerbRow(op)?.target ?? [] : [];
  const named = typeof b.page === "string" && b.page.trim() ? b.page.trim() : page;
  if (target.includes("page") && !deferAddress && named && !workerOwnsPage(own, named)) {
    return "this credential was minted for an agent, and that page is not one it opened: a page id is "
      + "served only from the pages this agent opened in its own container.";
  }
  if (target.includes("id")) {
    const id = typeof b.id === "string" ? b.id.trim() : "";
    if (!deferAddress && (!id || !workerOwnsPage(own, id))) {
      return "this credential was minted for an agent, and that tab is not one it opened: a tab id is "
        + "served only from the pages this agent opened in its own container.";
    }
  }
  /* A template tab is a tab with somebody's saved cookies in it: minting one is
     reaching a container this credential was not minted for. */
  if ((op === "open" || op === "newtab") && b.ephemeral === true) {
    return "this credential was minted for an agent, and a tab from a template carries the cookies and storage "
      + "saved from another container: open a plain page of your own instead.";
  }
  /* Folded like `as`: an agent name may carry capitals, and comparing `profile`
     raw left a worker named `Alba` able to `read --as Alba` but never to mint
     its own page (`profile "Alba" !== own "alba"`).
     A MINT MUST NAME THE WORKER'S OWN CONTAINER. `newtab` always mints, and an
     `open` that carries a `profile` string is routed to the mint; both go to
     whatever container the profile names, and the panel reads `""`/absent as
     the person's. A page of the worker's own does not stand in for the
     profile there: the page is only where a plain `open` navigates. */
  const byLane = laneAddressed || (typeof b.lane === "string" && !!b.lane.trim());
  const asksContainer = typeof b.profile === "string" ? foldWorkerName(b.profile) : "";
  const mints = op === "newtab" || (op === "open" && typeof b.profile === "string");
  if (mints) {
    /* A lane addressed here is the worker's own (the lane gate refuses anybody
       else's and any lane with no owner), and its window mints into the lane's
       partition; there is no person's container behind that door. */
    if (asksContainer !== own && !byLane) return AGENT_SHARED_REFUSAL;
  } else if (op === "open"
      && asksContainer !== own
      && !byLane
      && !(named && workerOwnsPage(own, named))) {
    return AGENT_SHARED_REFUSAL;
  }
  /* `show` from a worker is not refused here: the relay drops it and says so
     (workerShowNote), so the page still opens, in the background. */
  /* A template lane is the lane twin of a template tab: the saved cookies and
     storage of whichever container the template came from. The one ephemeral
     lane a worker may open is the vault plan's: `lane new --ephemeral --vault
     NAME`, which a first visit signs in from that vault. */
  if (op === "lane" && b.ephemeral === true && !(typeof b.vault === "string" && b.vault.trim())) {
    return "this credential was minted for an agent, and a lane from a template carries the cookies and storage "
      + "saved from another container: ask for a plain private lane instead, or `lane new --ephemeral --vault NAME`.";
  }
  if (op && op !== "do" && workerVerbRow(op)?.target.includes("page") && !(op === "open" && typeof b.profile === "string")) {
    if (!named && !afterOwnOpen && !byLane) {
      return "this credential was minted for an agent, and the ask names no page of its own: "
        + "open your own page first and address it, so the ask cannot fall through to the tab in front.";
    }
  }
  return null;
}

/** Whether this ask would have the panel mint a container. ONE rule: the
 *  route's walk, `runSteps` and the send door all read it. */
function mintsInAContainer(op: string | undefined, args: Record<string, unknown>): boolean {
  return op === "newtab" || (op === "open" && typeof args.profile === "string");
}

/** Whether this ask mints a page in the worker's own container. ONE rule: the
 *  route's walk and `runSteps` both ask it, so a `do` whose first step opens
 *  its own page reads the same here and there. */
function opensOwnPage(op: string | undefined, args: Record<string, unknown>, own: string | null): boolean {
  if (own === null || (op !== "open" && op !== "newtab")) return false;
  return typeof args.profile === "string" && foldWorkerName(args.profile) === own;
}

export function agentAskRefusal(body: unknown, worker?: string, op?: string, afterOwnOpen = false): string | null {
  const own = typeof worker === "string" && worker.trim() ? foldWorkerName(worker) : null;
  /* The ask is not only the top-level body: `do` carries `steps` and
     `lanes[].steps`, each parsed as a legitimate verb of its own, so a nested
     `open` with `profile: ""` is the same ask two fields down. Walked with a
     queue rather than recursion: a shape that could nest forever must not.
     A step INHERITS the identity and page of the `do`/lane that carries it.
     A step's ADDRESS is checked when it runs, not here: it is a page the
     earlier steps have not minted yet. `runSteps` gates every step again with
     the registry as it stands, so nothing skips the check. */
  if (own && bodyCarriesToken(body)) return WORKER_TOKEN_URL_REFUSAL;
  let level: Array<{ item: unknown; page?: string; op?: string; step?: boolean; ownedOpen?: boolean; lane?: boolean }> =
    [{ item: body, op, ownedOpen: afterOwnOpen }];
  for (let depth = 0; depth < 3 && level.length; depth++) {
    const next: Array<{ item: unknown; page?: string; op?: string; step?: boolean; ownedOpen?: boolean; lane?: boolean }> = [];
    for (const { item, page, op: inheritedOp, step, ownedOpen, lane } of level) {
      const b = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const stepOp = typeof b.op === "string" ? b.op : inheritedOp;
      /* A lane's page is put in scope by `gateLane`, so a step under a lane is
         addressed without naming one. */
      const laneHere = lane === true || (typeof b.lane === "string" && !!b.lane.trim());
      const refused = own
        ? workerAskRefused(b, own, stepOp, page, ownedOpen === true, step === true, laneHere)
        : (mintsInAContainer(stepOp, b)
          ? PLUGIN_MINT_REFUSAL
          : (namesThePerson(item) ? AGENT_SHARED_REFUSAL : null));
      if (refused) return refused;
      const carryPage = typeof b.page === "string" && b.page.trim() ? b.page.trim() : page;
      /* An `open` of the worker's own container makes that container's tab the
         one the panel acts on, so the steps after it may leave the page out. */
      const openedOwn = ownedOpen === true || opensOwnPage(stepOp, b, own);
      if (Array.isArray(b.lanes)) for (const l of b.lanes) next.push({ item: l, page: carryPage, ownedOpen: openedOwn, lane: laneHere });
      if (Array.isArray(b.steps)) {
        /* Each step's own args decide the one after it: a `do` that opens its
           own page and then reads it is one request, and reading the parent's
           `profile` refused it because the `do` body carries none. */
        let stepOwn = openedOwn;
        for (const s of b.steps) {
          const st = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
          if (own) {
            for (const key of Object.keys(st)) {
              if (!WORKER_STEP_FIELDS.has(key)) {
                return `this credential was minted for an agent, and a step carries "${key}", which a step does not read.`;
              }
            }
            if (typeof st.op !== "string") {
              return "this credential was minted for an agent, and a step names no verb: refused rather than inherited from the call around it.";
            }
            if (st.op === "do") {
              return "this credential was minted for an agent, and a step cannot be another `do`: refused.";
            }
          }
          const stArgs = (st.args && typeof st.args === "object" ? st.args : {}) as Record<string, unknown>;
          next.push({
            item: stArgs, page: carryPage,
            op: typeof st.op === "string" ? st.op : undefined, step: true, ownedOpen: stepOwn, lane: laneHere,
          });
          if (opensOwnPage(typeof st.op === "string" ? st.op : undefined, stArgs, own)) stepOwn = true;
        }
      }
    }
    level = next;
  }
  return null;
}

/* Said to a worker that reached for the person's own tab. Mirrored in the CLI
   (bin/agentglass-browser, WORKER_PERSON_TAB_HINT): never point a worker at
   `--shared`, which is the call it is refused. */
export const WORKER_PERSON_TAB_HINT = "The person's own tab is out of reach for a worker by design: ask the "
  + "orchestrator (seat) to run a guide there, or open your own container with `--as <name>`.";

const AGENT_SHARED_REFUSAL = "this credential was minted for an agent, and it reaches only that agent's own container, "
  + "page and lanes: the person's container, and another agent's profile, are not something it reaches. Name "
  + "your own identity (`--as <name>`, which opens its own container) or your own lane. The shared container "
  + "holds the person's logins.";

const PLUGIN_MINT_REFUSAL = "this credential was minted for a plugin, and a plugin does not mint a browser container: "
  + "it drives the person's own tabs, and an ask that names a page is refused like every other ask that "
  + "names the person's window.";


let seq = 0;
/* Unguessable: a caller that can POST /browser/result must not be able to
   answer an ask it was never sent by counting. */
const nextId = () => `b${++seq}-${crypto.randomUUID()}`;

/** The URLs the browser may be sent to. Same rule as the address bar: a page,
 *  not a `file://` read of somebody's keys and not a `javascript:` that would
 *  make `open` the `eval` this deliberately does not have — plus a refusal of the
 *  internal addresses no page navigation has a reason to reach (see blockedTarget). */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4096) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (blockedTarget(u.hostname)) return null;
  return u.toString();
}

/** A CSS selector, held to something that cannot carry a newline or run off
 *  into a page's own quoting. Length-capped because it ends up in a string
 *  literal the panel builds. */
/* A CSS selector, or one of the stable ids an observation hands back (`e17`).
   Both are accepted everywhere, because handing an agent an id and then
   refusing it as a selector is section 17's anti-feature with extra steps. */
/** When each of observe/console/network last ran with `--since-last`. One
 *  cursor per verb, because there is one browser panel: a second caller
 *  sharing it is looking at the same page. */
const LAST_SEEN: Record<string, number> = {};

const okSelector = (s: unknown): s is string =>
  typeof s === "string" && !!s.trim() && s.length <= 512 && !/[\n\r\u0000]/.test(s);

/**
 * §16 of the spec: the guardrail `eval` was let in without. Four things, all
 * checkable rather than promised — see the note beside `case "eval"` above
 * for why the fence had to move here instead of staying "no such verb".
 */

/** The origins the browser may be pointed at, as `host` or `host:port`
 *  entries — `AGENTGLASS_BROWSER_ORIGINS=localhost:8001,localhost:8002`. An
 *  entry with no `:` matches the hostname on any port.
 *
 *  Unset is `*` — every origin reachable — and that default is written down
 *  here as a decision made on purpose, not the absence of one: this relay
 *  drives a browser that already holds real logins, and "open reaches
 *  anywhere" is the shape that let an agent's `eval` wander into whatever
 *  the tab happened to be on. Read on every call rather than cached at
 *  import, so a server whose operator changes the env sees it take effect
 *  without a restart, and so tests can set it per case. */
function allowedOrigins(): string[] {
  return originsAllow();
}

/** What a refusal by the origin or profile list ends with: the row that lifts it, and the variable when the operator's environment holds the list. */
const originsLift = (): string => ` Lift it in Settings ▸ Browser ▸ Allowed origins${process.env[ORIGINS_ENV]?.trim() ? ` (locked: ${ORIGINS_ENV} was set when the server started)` : ""}.`;
const profilesLift = (): string => ` Lift it in Settings ▸ Browser ▸ Allowed profiles${process.env[PROFILES_ENV]?.trim() ? ` (locked: ${PROFILES_ENV} was set when the server started)` : ""}.`;

function originAllowed(host: string, list: readonly string[]): boolean {
  if (list.includes("*")) return true;
  const bare = host.split(":")[0];
  return list.some((entry) => (entry.includes(":") ? entry === host : entry === bare));
}

/** §16's own wording for this one: "which profiles an agent may use, and
 *  which it may never." Same shape as `allowedOrigins` on purpose — unset is
 *  `*`, set is an allow-list — `AGENTGLASS_BROWSER_PROFILES=support,agent`.
 *  Read on every call for the same reason as the other two: an operator's
 *  change takes effect without a restart, and tests can set it per case. */
function allowedProfiles(): string[] {
  return profilesAllow();
}

/** The unprofiled default (no `--as` at all) is always allowed — this list is
 *  about named identities, and refusing an agent's ordinary `open` because of
 *  a list meant for `--as` would be a surprise nothing here documents. */
function profileAllowed(name: string, list: readonly string[]): boolean {
  if (!name) return true;
  return list.includes("*") || list.includes(name);
}

/* -- who made this container, and when was it last used ----------------------
 *
 * §13. MINTING A CONTAINER AND JOINING ONE SOMEBODY ELSE MADE ARE THE SAME
 * GESTURE, with no signal on either side.
 *
 * `profiles` answered a flat list of bare names, so an agent following this
 * tool's own etiquette — "drop yours when the work is done" — could destroy a
 * live peer's container by name collision and be told `ok: true`. The panel
 * resolves a container by NAME against a machine-wide list and mints only when
 * the name is absent, so `open --as pol` is "make me one" or "join theirs"
 * depending on a fact the caller cannot see.
 *
 * A profile record in the panel is `{id, name}`: ownership is not modelled
 * anywhere, and modelling it there would put it behind React state this relay
 * cannot read. So it is modelled HERE, at the one seam every agent's request
 * already passes through, and keyed exactly the way the container namespace is
 * keyed: by bare name, machine-wide. Deliberately NOT namespaced per session —
 * §13's own reasoning: the containers themselves are machine-global, so
 * per-session keys would hand out separate TABS inside a container two sessions
 * still share, which is isolation in the answer and none in the cookie jar.
 *
 * FIRST WRITER WINS. Whoever names a container while it does not yet exist is
 * its creator; later users only move `lastSeenMs`. A container that predates
 * this ledger has `creator: null`, which reads as "unknown" and is allowed with
 * a warning rather than refused — otherwise shipping this strands every
 * container already on disk, which §13 rules out by name.
 */
interface ContainerRecord {
  /** The identity that first named it. `null` for anything already on disk
   *  when this shipped, and for a container minted by a caller that sent no
   *  identity at all. */
  creator: string | null;
  /** Wall clock of the last request that named it. What the collision notice
   *  puts in front of an agent: "somebody was using this eleven seconds ago"
   *  is a different sentence from "in March". */
  lastSeenMs: number;
}

/* Resolved on every call, never captured at import — the same reason
 * `allowedOrigins` is a function. A module-level const would freeze whichever
 * HOME/XDG_CONFIG_HOME happened to be set when this file was first imported,
 * and a test that redirects the environment afterwards would then write its
 * fixtures into the operator's REAL config directory. That has happened in
 * this repository before, with a tmux config, and it took a day to find. */
/*
 * `AGENTGLASS_STATE_DIR` IS the directory, and does not get "agentglass"
 * appended to it.
 *
 * It used to, because the variable sat inside the same `||` as the XDG
 * fallbacks and inherited their suffix — which those need and it does not: a
 * directory named on purpose for one server's state is already dedicated. The
 * refutation is four hundred lines down this same file. `auditLogPath()` writes
 * `$AGENTGLASS_STATE_DIR/browser-audit.log`, so with the variable set, the two
 * halves of this browser's state landed in different places:
 *
 *     ledger   $STATE/agentglass/browser-containers.json
 *     audit    $STATE/browser-audit.log
 *
 * and a probe or a second server pointed at a scratch directory found one of
 * them and not the other. Four other readers of this variable already treat it
 * this way — `auditLogPath`, `cloneClaudeHome`, and `db.ts`, which gives it a
 * branch of its own; `tasks.ts` and `tmuxbin.ts` append a name of their own
 * (`task`, `tmux`) rather than the app's. This was the only one that did not.
 *
 * AND THE FALLBACK IS THE STATE DIRECTORY, not the config one.
 *
 * Fixing the variable left the two files still apart on a machine that does not
 * set it: this read `XDG_CONFIG_HOME` while `auditLogPath` reads
 * `XDG_STATE_HOME`, so the pair landed in `~/.config/agentglass/` and
 * `~/.local/state/agentglass/`. The ledger is not configuration — nobody edits
 * it, nothing reads it to decide behaviour, and it is rewritten by the app every
 * time a container is made. It is a record of what happened, which is what a
 * state directory is for, and `~/.local/state/agentglass/` on this machine
 * already holds `browser-audit.log`, `clone-claude/`, `tmux/` and `tmux.conf`.
 *
 * Measured before moving it: `~/.config/agentglass/` holds no browser file at
 * all here, so on this machine there is nothing to move. `legacyLedgerFile`
 * covers the machines where there is.
 */
function ledgerDir(): string {
  return process.env.AGENTGLASS_STATE_DIR
    || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
}
function ledgerFile(): string { return join(ledgerDir(), "browser-containers.json"); }

/*
 * The two places this file has previously been written, read ONLY when nothing
 * is at the current path and never written back.
 *
 * The failure being avoided is a quiet one. An unknown creator is the ALLOWED
 * branch of the `--drop` guard, so a reader that missed an old file would
 * report "nobody owns anything" and switch the guard off on exactly the
 * machines that had been using it — every existing container silently losing
 * its owner, and the first `--drop` after an upgrade taking a peer's live work
 * with it.
 *
 * Ordered newest-first, which is the order they stopped being written in.
 */
function legacyLedgerFiles(): string[] {
  const out: string[] = [];
  const state = process.env.AGENTGLASS_STATE_DIR;
  // When the variable was set, it took the app's name as a suffix.
  if (state) out.push(join(state, "agentglass", "browser-containers.json"));
  // And before that the whole thing lived under the CONFIG directory.
  if (!state) {
    out.push(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "agentglass", "browser-containers.json"));
  }
  return out;
}

/* Read through to disk on every call rather than cached in this process.
 * The alternative was an in-memory map, and it fails the one case the drop
 * guard exists for: the app restarts far more often than the containers do
 * (every install), and a restart would reset every creator to `null` — which
 * is the fail-open branch, so the guard would be off exactly when somebody
 * comes back to a machine with a peer's container still on it. The file is a
 * few hundred bytes and only `profiles` reads it in bulk. */
function readLedger(): Record<string, ContainerRecord> {
  const at = (file: string): Record<string, ContainerRecord> | null => {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return raw && typeof raw === "object" ? raw as Record<string, ContainerRecord> : null;
    } catch { return null; }
  };
  /* The old path only when the new one has nothing — read, never written back,
     so this costs one failed `readFileSync` on a machine that never had it and
     nothing at all once the first write lands at the new path. */
  const now = at(ledgerFile());
  if (now) return now;
  for (const old of legacyLedgerFiles()) {
    const was = at(old);
    if (was) return was;
  }
  return {};
}

function writeLedger(l: Record<string, ContainerRecord>): void {
  try {
    const file = ledgerFile();
    mkdirSync(dirname(file), { recursive: true });
    /* Whole file, then moved into place: two agents opening at once is the
       ordinary case here, and a half-written ledger reads as an empty one —
       which silently forgets every creator. */
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(l, null, 2) + "\n");
    renameSync(tmp, file);
  } catch { /* remembering is a nicety; refusing to drive a browser over it is not */ }
}

/** What the ledger knows about one container, or `null` for one it has never
 *  seen — which every container that predates this file is. */
export function containerRecord(name: string): ContainerRecord | null {
  return readLedger()[name] ?? null;
}

/** Stamp a container as used, and — only if nobody has claimed it yet — as
 *  created by `identity`. Called from the ops that NAME a container, which is
 *  the only moment this relay learns a name is in play. */
function noteContainer(name: string, identity: string | null): void {
  if (!name) return;
  const l = readLedger();
  const had = l[name];
  l[name] = { creator: had?.creator ?? (identity || null), lastSeenMs: Date.now() };
  writeLedger(l);
}

/** Forget a container that has just been thrown away, so the next agent to
 *  mint the same name is its creator rather than inheriting a stranger's claim
 *  over a container that no longer exists. */
function forgetContainer(name: string): void {
  const l = readLedger();
  if (!(name in l)) return;
  delete l[name];
  writeLedger(l);
}

/** Tests only: the ledger is a file on the operator's machine, and a test that
 *  leaves entries in it changes the next one's answer. */
export function resetContainerLedger(): void {
  try { rmSync(ledgerFile(), { force: true }); } catch { /* never existed */ }
}

/** What an agent may answer for its own tab — guest-guard.js's AGENT_ANSWERABLE. */
const AGENT_PERMISSIONS: ReadonlySet<string> = new Set(["microphone", "camera", "notifications"]);

/** `AGENTGLASS_BROWSER_READONLY=1` — observing stays open, acting is refused.
 *  Read on every call for the same reason as `allowedOrigins`. */
function readonlyMode(): boolean {
  return envLimit("AGENTGLASS_BROWSER_READONLY") === "1";
}

/** `AGENTGLASS_BROWSER_WEBMCP=1` — `tools` and `call-tool` exist. Off by
 *  default because a page's tool descriptions are text somebody else wrote and
 *  a model will read; turning them on is the operator's decision, not an
 *  agent's. Only the exact value `1`, read on every call like the rest. */
function webmcpOn(): boolean {
  return envLimit("AGENTGLASS_BROWSER_WEBMCP") === "1";
}

/** Every verb, named. This list is read-only mode's whole enforcement, so a
 *  verb that is not in it is acting by default — see `isActing` — rather than
 *  quietly falling on the safe-to-run side because nobody classified it. */
const OBSERVE_OPS: ReadonlySet<BrowserOp> = new Set([
  "read", "markdown", "extract", "links", "count", "search",
  "interactive", "forms", "attr", "screencast",
  "shot", "text", "html", "console", "network", "observe",
  "tabs", "frames", "health", "waitfor", "wait", "vitals", "a11y",
  /* `listeners` and a coverage READ only look. `cdp` is deliberately NOT
     here: the protocol can navigate, click, set a breakpoint and evaluate, so
     classifying it as observing would be a hole shaped exactly like the one
     §16 exists to close. A verb this powerful defaults to acting. */
  "listeners", "profiles", "events", "record", "audit", "pdf", "har", "region", "save",
  /* §11's whole point is a pre-flight that touches no page. If read-only mode
     refused it, the one call an agent should make BEFORE deciding whether it
     may act would be the first thing refused. */
  "whoami",
  /* `done` only tells the person's overview the agent has finished: it touches
     no page, so read-only mode has nothing to refuse. */
  "done",
  /* Reading what a page offers looks and runs nothing; `call-tool` is not
     here, so it acts by default like every verb with no class of its own. */
  "tools",
  /* Opening a lane touches no page and no person's window: it makes a room for
     an agent to work in, which read-only mode has no reason to refuse. */
  "lane",
  /* Guide mode draws over the page and waits for the person; it never touches
     the page itself, which is the whole reason it exists. */
  "guide", "point",
]);

/** `cookies` is the one verb that is sometimes each: reading the jar is an
 *  observation, `cookies --set` writes into it. Everything else is a fixed
 *  verdict per op, and anything this switch has never heard of falls through
 *  to `true` — acting — on purpose. */
function isActing(op: BrowserOp, args: Record<string, unknown>): boolean {
  /* Making a lane touches nothing of anybody's; closing one ends another's work. */
  if (op === "lane") return args.action === "close" || args.action === "vault";
  if (op === "cookies") return args.set !== undefined;
  /* `debug` is two verbs wearing one name: asking where it is paused only
     looks, while setting a breakpoint or stepping changes what the page does
     next. Deciding by verb would have to pick one, and picking "observes"
     would let read-only mode step a live page. */
  if (op === "debug") return args.action !== "where";
  /* Reading storage looks; writing it changes what the page believes on its
     next load, which is as much an action as a click. */
  if (op === "storage") return args.set === true || args.remove === true;
  /* Same shape again: `settings get` reads what is already in effect,
     `settings set` changes it — read-only mode has to tell those apart the
     same way it tells `cookies --set` from a plain read of the jar. */
  if (op === "settings") return args.action === "set";
  /* Listing what a tab holds only looks; answering it acts. */
  if (op === "permission") return args.list !== true;
  /* `profiles` lists, and listing observes. `--make` writes a container and
     `--drop` closes every tab in one and clears its login — the verb this
     file builds an ownership guard around, and it sat in the observing set
     whole, so read-only mode let it through. */
  if (op === "profiles") return args.make !== undefined || args.drop !== undefined;
  /* `checkup` with a url or `--reload` navigates; without either it only
     reads what the page already did. */
  if (op === "checkup") return args.url !== undefined || args.reload === true;
  return !OBSERVE_OPS.has(op);
}

/** A value the browser touched, with anything secret-shaped taken out before
 *  it reaches the audit log or an agent's own context. Not a promise: the
 *  exact failure that got another browser MCP banned here was a real
 *  password autofilled into a transcript, so this runs on every reply and
 *  every logged argument, not just the ones somebody remembered to mark. */
/* Keys whose VALUE is a credential whatever shape it has. `cookie` and
   `authorization` were the whole list, which is right for the two header names
   an RFC actually spells and lets every other one through: measured against
   the names `headers --set` accepts, `X-Api-Key: <32 chars of base62>` was
   stored intact, because base62 is not 32 hex and matches no token shape. The
   added names only ever carry a secret, so widening cannot mask honest text. */
const SECRET_KEY_RE =
  /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token)$/i;

/*
 * Values that are a credential by SHAPE. One line rebuilt into four branches,
 * with a reason for each.
 *
 * The prefixed-key branch used to be `(?:sk|pk|ghp|…)[A-Za-z0-9_-]{10,}` with
 * no separator required, and `sk`/`pk` are two of the commonest letter pairs
 * in English. Measured against ordinary page text: `skateboarding` and
 * `pkg_resources` both matched — and before the reply side was scoped to the
 * span (below), either one blanked an entire page read. Requiring the `-`/`_`
 * that every real key of this family carries (`sk-proj-…`, `ghp_…`, `xoxb-…`)
 * drops both false positives without losing one true one.
 *
 * `AKIA` is the exception that same rule would have silently killed: an AWS
 * access key id is `AKIA` and sixteen characters, no separator anywhere. It
 * gets its own branch rather than sharing the prefixed one, because tightening
 * without splitting it stops detecting AWS keys and says nothing.
 *
 * GLOBAL on purpose — the reply side replaces spans and counts them. A global
 * regex carries `lastIndex` between calls, so `.test()` on this one alternates
 * true/false on the same input. Use `.replace()`, never `.test()`.
 */
const TOKEN_SHAPE_RE = new RegExp([
  String.raw`[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,  // a JWT
  String.raw`\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b`,  // a prefixed API key
  String.raw`\bAKIA[A-Z0-9]{16}\b`,  // an AWS access key id — nothing to separate on
  String.raw`\b[A-Fa-f0-9]{32,}\b`,  // a hex digest: a session id, an md5, a commit SHA
].join("|"), "g");

/** What replaces a secret. One string everywhere: it is what the replay script
 *  greps for and what a reader is meant to recognise on sight. */
const REDACTED = "[redacted]";

/* Fields that are BINARY, not text, and can never be a secret: a PNG, a PDF,
   an MHTML archive. They are base64, so a long enough run of it matches a
   token shape by accident — and the redaction then replaces a screenshot with
   the word "[redacted]", which the CLI decodes to zero bytes and writes as a
   capture. Measured today: every `shot` above about 84KB came back destroyed
   by its own guardrail, and the failure looked exactly like the capture bug it
   was sitting next to. The screencast's frames are the same thing under `jpeg`:
   2 runs in 20 came back with a token-shaped stretch replaced inside the
   base64, and the CLI died decoding it. */
const BINARY_FIELDS: ReadonlySet<string> = new Set(["png", "jpeg", "pdf", "mhtml", "data", "script"]);

/** How many spans were masked, and under which key, so a caller can be TOLD
 *  rather than left to notice. */
type RedactionTally = Map<string, number>;

function tallyUp(tally: RedactionTally | undefined, key: string, n: number): void {
  if (!tally || n <= 0) return;
  tally.set(key, (tally.get(key) ?? 0) + n);
}

/*
 * THE POLICY DECISION, made on purpose and written down because it trades one
 * failure for another (§16).
 *
 * This used to replace the WHOLE string when a token shape matched anywhere in
 * it, on both sides of the wire. It is span-scoped on both sides now — this
 * function is shared, and an earlier version of this comment claimed the ask
 * side kept whole-value replacement when it did not. A `type` whose text
 * carries a token keeps the words around it, the same as a reply does; what
 * goes whole is a value under a secret KEY, below. On what a page RETURNS the
 * whole-value rule was a defect with a measurement behind it — `read`, `text`, `html`, `region` and `eval` hand the page back
 * as one string, so a single 40-character commit SHA anywhere in it replaced
 * the entire body with "[redacted]" while the call reported `ok: true` and
 * exit 0. Observed once on real data: a `read` whose `url` came back as the
 * literal "[redacted]" beside 20 KB of intact `text`, and nothing in the CLI
 * ever mentioning that redaction had fired.
 *
 * So: replace the SPAN, not the value. The cost is real and is accepted here —
 * it hands back the text surrounding a token the regex may only have partially
 * spanned, which whole-value replacement did not. It is accepted because the
 * alternative destroys honest reads SILENTLY, and because a masked span is now
 * counted and reported (`BrowserReply.redacted`) instead of being invisible.
 */
function redactValue(v: unknown, keyHint?: string, tally?: RedactionTally): unknown {
  if (keyHint && BINARY_FIELDS.has(keyHint)) return v;
  if (typeof v === "string") {
    /* By KEY the whole value still goes: an `Authorization` header is a
       credential end to end, so there is no surrounding text to preserve. */
    if (keyHint && SECRET_KEY_RE.test(keyHint)) { tallyUp(tally, keyHint, 1); return REDACTED; }
    let spans = 0;
    const out = v.replace(TOKEN_SHAPE_RE, () => { spans++; return REDACTED; });
    tallyUp(tally, keyHint ?? "value", spans);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, undefined, tally));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = redactValue(val, k, tally);
    return out;
  }
  return v;
}

/** Words that name a secret field, for the case where nothing ever reached a
 *  node. Wider than "password" because the field on a real login form is as
 *  often `#pwd`, `#pass`, an OTP box or a CVV. */
const SECRET_FIELD_RE = /pass(word|wd)?|\bpwd\b|secret|token|otp|one-?time|cvv|cvc|pin\b/i;

/**
 * What the PAGE said about the fields a verb just wrote to.
 *
 * The panel is the only side that can see a DOM node, so it is the only side
 * that can answer "is this a password box" about a field whose id a framework
 * generated. `field` is the single-field answer (`type` reaches exactly one
 * node); `fields` names the selectors a multi-field verb (`fill`) was told
 * hold a secret. A bare boolean is still accepted, because the call site that
 * only ever had one field should keep reading the way it always did.
 */
export interface PageSecrets {
  field?: boolean;
  fields?: readonly string[];
}

/**
 * Where a verb carries a value its CALLER supplied, and how that value is
 * blanked. A table, not a chain of `if (op === ...)`.
 *
 * The defect this closes was exactly one verb wide: the whole secret path
 * gated on `op === "type"`, so `fill` — the documented one-call login verb,
 * the one whose entire point is a username and a password in a single call —
 * wrote `hunter2` verbatim into a machine-global audit log any concurrent
 * agent can export in one command, under a `--help` promising "with secrets
 * already taken out". A table makes the omission visible: a new value-carrying
 * verb gets a row here, or it inherits nothing and somebody can see that.
 *
 * Deliberately NOT rows, and a test holds this list against the parser so a
 * new value-carrying verb has to land in one place or the other:
 * - `clipboard --write`: the audit line is often the only record of what an
 *   agent put on the clipboard, and nothing measured says a password went
 *   through it. The shareable script export withholds it instead.
 * - `select --value`: an option's value is markup, not a secret.
 * - `extract --fields`: names and selectors, the shape of a dataset, not
 *   credentials — the same reason `select --value` is exempt.
 * - `fake --body` and `intercept --body`: a response the agent wrote itself,
 *   to a page it is testing.
 * - `settings set`: a preference, and `settings get` prints it back anyway.
 * - `point --text`: the visible label that picks one of several matches,
 *   read off the page like a selector, never typed into it.
 */
export const valueCarryingExemptForTest: readonly string[] = ["clipboard", "select", "extract", "fake", "intercept", "settings", "point"];
const VALUE_CARRYING: Record<string, (
  out: Record<string, unknown>,
  args: Record<string, unknown>,
  secret: (selector: unknown) => boolean,
) => void> = {
  type(out, args, secret) {
    if (secret(args.selector)) out.text = REDACTED;
  },
  /* One row for a whole form. Each value is judged by ITS OWN selector, so
     `fill --field '#user=alice' --field '#password=hunter2'` keeps the name
     and loses the password — a log that blanked both would tell a reader
     nothing about what the agent actually did. */
  fill(out, args, secret) {
    const fields = args.fields as Record<string, unknown> | undefined;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) return;
    const masked: Record<string, unknown> =
      { ...(out.fields && typeof out.fields === "object" ? out.fields as Record<string, unknown> : {}) };
    for (const selector of Object.keys(fields)) if (secret(selector)) masked[selector] = REDACTED;
    out.fields = masked;
  },
  /* A cookie value is a credential BY POSITION — that is what a cookie is —
     and it arrives under the key `value`, which names nothing, so neither the
     key list nor the shape list saw it. Measured in this incident's own log: a
     32-character ALPHANUMERIC `sessionid` sat in the shared audit unredacted,
     because it is not 32 hex. Replay of a `cookies --set` is lossy now; a live
     session credential in a global log costs more. */
  cookies(out, args) {
    const set = args.set;
    if (!set || typeof set !== "object" || Array.isArray(set)) return;
    if (typeof (set as Record<string, unknown>).value !== "string") return;
    out.set = {
      ...(out.set && typeof out.set === "object" ? out.set as Record<string, unknown> : {}),
      value: REDACTED,
    };
  },
  /* The same position rule for the same reason: `storage --set authToken
     <opaque>` is the other half of a session, and no key name a page invents
     (`authToken`, `access_token`, `sid`) is on any header list. A benign
     `--set theme dark` is blanked along with it; losing that from a replay
     costs less than leaking the other, and the replay already emits storage as
     a comment rather than a command. */
  storage(out, args) {
    if (args.set === true && typeof args.value === "string") out.value = REDACTED;
  },
  /* The same two positions, reached through the raw protocol: an agent can
     write a whole session with `cdp`, and the rows above never see a single
     value of it. Only the methods that WRITE a cookie or a stored item — a
     `value` anywhere else in the protocol is not a credential by position.
     `session load` and the MCP's `browser_set_storage_state` restore cookies
     through `Network.setCookie` here; `session import` uses `cookies --set`,
     and all three write storage with `storage --set`, one key at a time.
     `eval` is the one door no row can cover — a script has no value position
     — which is why none of them writes storage with one. */
  cdp(out, args) {
    const params = args.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) return;
    const p = params as Record<string, unknown>;
    const blank = (o: unknown) =>
      o && typeof o === "object" && typeof (o as Record<string, unknown>).value === "string"
        ? { ...(o as Record<string, unknown>), value: REDACTED } : o;
    if (args.method === "Network.setCookie" || args.method === "DOMStorage.setDOMStorageItem"
      || args.method === "Storage.setSharedStorageEntry") {
      out.params = blank({ ...(out.params as Record<string, unknown>), value: p.value });
    } else if ((args.method === "Network.setCookies" || args.method === "Storage.setCookies") && Array.isArray(p.cookies)) {
      out.params = { ...(out.params as Record<string, unknown>), cookies: p.cookies.map(blank) };
    }
  },
  /* Every value of a page tool's arguments, by position: the page chose the
     argument names (`password`, `cvv`, `otp`, or anything), so no key list can
     say which are secret. Only the keys survive in the log. */
  "call-tool"(out, args) {
    const given = args.args;
    if (!given || typeof given !== "object" || Array.isArray(given)) return;
    out.args = Object.fromEntries(Object.keys(given).map((k) => [k, REDACTED]));
  },
  /* What a prompt() is answered with is typed into a box the page chose, and
     no selector says whether that box asked for a passcode. Position rule
     again: the audit line says an answer was armed, never what it was. */
  dialog(out, args) {
    if (typeof args.text === "string") out.text = REDACTED;
  },
};

/** The ops the table covers, for a lock that notices when a value-carrying
 *  verb is added and this table is not. */
export const valueCarryingOpsForTest: readonly string[] = Object.keys(VALUE_CARRYING);

/**
 * An ask, as the audit log will hold it.
 *
 * Three signals decide whether a field's value is a secret, and they are not
 * redundant:
 *
 *   * the PANEL'S VERDICT, the only one that can be right, because it looked
 *     at the node. Measured against the other two: `type "#pwd" "hunter2"` has
 *     a selector with no telltale word and a value with no token shape, so
 *     both heuristics wave it through and a real password lands in the log.
 *     That is the incident that got another browser MCP banned from this
 *     machine.
 *   * the SELECTOR HEURISTIC, which is the answer for a call that never
 *     reached a node — a refusal is logged too, and a wrong selector on a
 *     login form is still a password somebody typed.
 *   * `redactValue`, above, for token-shaped text sent anywhere at all.
 */
function redactAsk(op: BrowserOp, args: Record<string, unknown>,
  secrets: PageSecrets | boolean = {}): Record<string, unknown> {
  const said: PageSecrets = typeof secrets === "boolean" ? { field: secrets } : secrets;
  const out = redactValue(args) as Record<string, unknown>;
  const named = new Set<string>(said.fields ?? []);
  /* The single-field verdict is the same verdict said about the one selector
     the call carried — fold it in, so there is one rule below and not two.
     Empty string when there was no selector: a panel that says "the node I
     reached is a password" is believed whether or not the ask named it. */
  if (said.field === true) named.add(typeof args.selector === "string" ? args.selector : "");
  const secret = (selector: unknown): boolean => {
    const s = String(selector ?? "");
    return named.has(s) || SECRET_FIELD_RE.test(s);
  };
  VALUE_CARRYING[op]?.(out, args, secret);
  return out;
}

/**
 * HOW A REQUEST GOT TO THE TAB IT GOT TO — §9's `how`.
 *
 * The whole reason the incident took a replay to attribute: a hijacking bare
 * call and a legitimate bare call by the tab's own owner are byte-identical in
 * the log. `{"op":"open","args":{"url":"…"},"ok":true}` says nothing about who
 * asked or what they meant, and a person clicking a tab in the UI emits no
 * entry at all, so "which tab was in front at 14:02" is a MODEL and the log
 * cannot check it. These five values are the caller's own statement of intent,
 * which is the fact the log was missing.
 *
 *   explicit-page   — `--page <id>`: a tab named on purpose, possibly not ours
 *   own-tab         — the identity's remembered tab, stamped by the CLI
 *   own-container   — addressed by container (`open --as NAME`), no tab yet
 *   active-explicit — `--active`: whatever is in front, asked for by name
 *   shared          — `--shared`: the front tab, deliberately shared
 */
export type AuditHow = "explicit-page" | "own-tab" | "own-container" | "active-explicit" | "shared";
const HOWS: readonly AuditHow[] = ["explicit-page", "own-tab", "own-container", "active-explicit", "shared"];

export interface AuditEntry {
  id: string; ts: number; op: BrowserOp; args: Record<string, unknown>; ok: boolean; error?: string;
  /**
   * WHO SAID THEY WERE CALLING — and that is all it is.
   *
   * Self-asserted by a local CLI, over a loopback endpoint whose only
   * credential is one machine-wide bearer token that every agent shell on this
   * machine already holds. Anything with the token can write any name here.
   * This is forensics for accidents between cooperating agents, which is the
   * actual threat model; it is NOT authentication and must never be described
   * as one.
   */
  as?: string;
  /** The tab this call resolved to. From the panel's reply when it says (§8),
   *  otherwise the tab the request addressed. Absent means nothing named one,
   *  which is the case worth grepping for. */
  tab?: string;
  /** That tab's container, when the reply or the request named it. */
  owner?: string;
  /** The lane this call was addressed to, when it was: which of an agent's
   *  private windows acted, and not the person's. */
  lane?: string;
  how: AuditHow;
}
const AUDIT: AuditEntry[] = [];
const AUDIT_MAX = 2000;
let auditSeq = 0;
const nextAuditId = () => `a${++auditSeq}`;

/**
 * Where the log survives a restart.
 *
 * `AGENTGLASS_BROWSER_AUDIT_LOG` names the file outright; otherwise it lives
 * beside the rest of this app's state, which honours `AGENTGLASS_STATE_DIR`
 * for the same reason `db.ts` does — a probe with a scratch state directory
 * must not write into the real record.
 *
 * `null` under `bun test` unless the file is named explicitly: the suite must
 * not read or grow a developer's own log, and a lock that wants the real disk
 * path points the variable at a tmpdir.
 */
function auditLogPath(): string | null {
  const named = process.env.AGENTGLASS_BROWSER_AUDIT_LOG;
  if (named) return named;
  if (process.env.NODE_ENV === "test") return null;
  const state = process.env.AGENTGLASS_STATE_DIR;
  const dir = state || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, "browser-audit.log");
  } catch { return null; } // unwritable: the in-memory log is still the fast path
}

/** One rotation, at 4 MB. A browser session is a few hundred entries of a few
 *  hundred bytes, so this is months of them — and two files is the whole
 *  policy, because a log that needs a rotation *scheme* is a log nobody reads. */
const AUDIT_FILE_MAX = 4 * 1024 * 1024;

/** Append one entry, and never let the logging break the verb: an unwritable
 *  disk is a worse audit trail, not a failed click. */
function persistAudit(entry: AuditEntry): void {
  const path = auditLogPath();
  if (!path) return;
  try {
    try {
      if (statSync(path).size > AUDIT_FILE_MAX) renameSync(path, `${path}.1`);
    } catch { /* no file yet, or it cannot be rotated — either way, append */ }
    appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch { /* said above */ }
}

/**
 * The durable log, newest AUDIT_MAX entries.
 *
 * The file is a superset of memory — every `recordAudit` writes both, in that
 * order — so after a restart this is the only one with yesterday in it, and
 * during a run the two agree. A line that will not parse is skipped rather
 * than thrown: half a line at the end of a file is what a kill -9 leaves.
 */
function readAuditFile(): AuditEntry[] | null {
  const path = auditLogPath();
  if (!path) return null;
  /*
   * THE ROTATED HALF COUNTS. `persistAudit` renames the file to `.1` at 4 MB
   * and starts a fresh one, so one verb past the cap took the visible log
   * from 2000 entries to 1 — measured — with the rest sitting on disk where
   * no read path reached. The evidence this log exists to keep is exactly the
   * evidence that was oldest, so `.1` is read first and the live file after.
   */
  let raw = "";
  let found = false;
  for (const candidate of [`${path}.1`, path]) {
    try { raw += readFileSync(candidate, "utf8") + "\n"; found = true; } catch { /* absent, or not yet rotated */ }
  }
  if (!found) return null;
  const lines = raw.split("\n").filter((l) => l.trim());
  const out: AuditEntry[] = [];
  for (const line of lines.slice(-AUDIT_MAX)) {
    try { out.push(JSON.parse(line) as AuditEntry); } catch { /* torn line */ }
  }
  return out;
}

/**
 * An error is text the panel wrote, and a refusal that quotes the page can
 * quote a field's value: one listed the candidates of an ambiguous `fill` by
 * their values, a password that had just been filled among them, while the
 * args beside it were masked. So every value the ask's own redaction masked
 * is cut out of the error as well, and token shapes go as they do anywhere.
 * Values shorter than three characters are left: cutting "x" out of a
 * sentence destroys the sentence and hides nothing.
 */
function scrubError(error: string, args: unknown, masked: unknown): string {
  const hidden: string[] = [];
  const walk = (a: unknown, m: unknown): void => {
    if (typeof a === "string") { if (m === REDACTED && a !== REDACTED && a.length >= 3) hidden.push(a); return; }
    if (a && typeof a === "object" && m && typeof m === "object") {
      for (const [k, v] of Object.entries(a as Record<string, unknown>)) walk(v, (m as Record<string, unknown>)[k]);
    }
  };
  walk(args, masked);
  let out = redactValue(error) as string;
  for (const h of hidden.sort((x, y) => y.length - x.length)) out = out.split(h).join(REDACTED);
  return out;
}

/** What the caller said about itself, lifted off the body once so every
 *  refusal inside `parseAsk` carries it too — a refused call is exactly the
 *  one somebody will want attributed. */
export interface AuditCaller { as?: string; how?: AuditHow }

function recordAudit(op: BrowserOp, args: Record<string, unknown>, ok: boolean, error?: string,
  /** The panel's verdict on which of the fields it reached hold a secret — the
   *  only one of the three signals that actually looked at a node. A boolean
   *  for the verbs that touch exactly one field, a list of selectors for the
   *  ones that touch several. */
  secrets: PageSecrets | boolean = false,
  /** What the panel said it acted on (§8), when it says. */
  resolved?: { tab?: string; owner?: string },
  /** The caller, for the refusals that never get as far as an `args` blob. */
  caller?: AuditCaller): void {
  /* `as` and `how` ride in `args` from the wire to here — adding them to the
     ask frame would change a type shared with the panel for two fields the
     panel has no use for — and come straight back out again, so the recorded
     args stay the verb's own arguments and `auditAsScript` keeps working on
     them unchanged. */
  const clean = { ...args };
  const declaredAs = caller?.as ?? (typeof clean.as === "string" ? clean.as : undefined);
  const declaredHow = caller?.how ?? (HOWS.includes(clean.how as AuditHow) ? clean.how as AuditHow : undefined);
  delete clean.as;
  delete clean.how;
  const page = typeof clean.page === "string" ? clean.page : undefined;
  const profile = typeof clean.profile === "string" ? clean.profile : undefined;
  /*
   * DERIVED ONLY WHEN THE CALLER DID NOT SAY, and derived from the WIRE.
   *
   * A request carrying a `page` was addressed at a tab; one carrying only a
   * `profile` was addressed at a container; one carrying neither is going to
   * whatever is in front, which is what `shared` means. What the wire cannot
   * tell apart is `--page t7` from the CLI stamping the identity's own t7 —
   * both arrive as `page: "t7"` — which is precisely why the CLI states `how`
   * and this is only the fallback for a caller speaking raw HTTP.
   *
   * `active-explicit` is never derived. It appears only when somebody typed
   * `--active`, which is what makes "zero of them in a two-agent session"
   * a check worth running.
   */
  const how: AuditHow = declaredHow ?? (page ? "explicit-page" : profile ? "own-container" : "shared");
  const tab = resolved?.tab ?? page;
  const owner = resolved?.owner ?? profile;
  const masked = redactAsk(op, clean, secrets);
  const entry: AuditEntry = {
    /* The redaction lane's richer signal, kept: `secrets` is a list of
       selectors for the verbs that touch several fields (`fill`), where a
       single boolean could only ever say "one of them". */
    id: nextAuditId(), ts: Date.now(), op, args: masked, ok,
    ...(error === undefined ? {} : { error: scrubError(error, clean, masked) }),
    ...(declaredAs ? { as: declaredAs } : {}),
    ...(tab ? { tab } : {}),
    ...(owner ? { owner } : {}),
    ...(typeof clean.lane === "string" ? { lane: clean.lane } : {}),
    how,
  };
  AUDIT.push(entry);
  if (AUDIT.length > AUDIT_MAX) AUDIT.splice(0, AUDIT.length - AUDIT_MAX);
  persistAudit(entry);
}

/** Narrow a log to one caller or one tab. Both optional, both exact: a
 *  substring match on a container name would fold `orbit` and `orbit-qa`
 *  together, and the whole point of the filter is telling two agents apart. */
export interface AuditFilter { as?: string; tab?: string }
function matches(e: AuditEntry, f?: AuditFilter): boolean {
  if (!f) return true;
  if (f.as !== undefined && e.as !== f.as) return false;
  if (f.tab !== undefined && e.tab !== f.tab) return false;
  return true;
}

/**
 * "I only touched the local one", checkable rather than promised — every op
 * that reached this relay, refused or carried out, oldest first.
 *
 * NOT SCOPED PER CONTAINER, and that is deliberate: the global view is what
 * made the incident's root cause findable at all, and it is what the person
 * who owns the machine needs. A per-container view is this filter, supplied by
 * whoever is asking.
 */
export function exportAudit(filter?: AuditFilter): AuditEntry[] {
  const durable = readAuditFile();
  return (durable ?? AUDIT).filter((e) => matches(e, filter));
}
/**
 * The session, as a script somebody can run again — spec §12.
 *
 * "Export the session as an executable script: the reproduction stops being a
 * conversation and becomes an artefact QA can re-run." Everything it needs is
 * already in the audit log §16 built, which is the nice part: the log exists
 * to prove what was touched, and proving what was touched and replaying it are
 * the same list read twice.
 *
 * What it deliberately does NOT do:
 *
 *   - Include reads. `observe`, `read`, `shot` and the rest changed nothing, so
 *     replaying them proves nothing and only makes the script longer. What a
 *     re-run should reproduce is the ACTIONS.
 *   - Un-redact. The log holds `[redacted]` where a password was, and this
 *     leaves it there — with a comment saying so, on the line, so somebody
 *     re-running it finds out at the line that needs their attention rather
 *     than when it silently types the word "[redacted]" into a login form.
 *   - Guess. A verb it has no shape for is emitted as a comment with its JSON,
 *     rather than as a plausible command that does something else.
 */
export function auditAsScript(entries: AuditEntry[]): string {
  const q = (v: unknown) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# A browser session, replayed. Generated from the audit log.",
    "#",
    "# Only the steps that CHANGED something are here: reads proved nothing and",
    "# replaying them would only make this longer.",
    "set -euo pipefail",
    "",
  ];
  let acted = 0;
  let redacted = 0;
  for (const e of entries) {
    if (!e.ok) {
      lines.push(`# refused at the time: ${e.op} ${JSON.stringify(e.args)} — ${e.error ?? ""}`);
      continue;
    }
    if (OBSERVE_OPS.has(e.op)) continue;
    const a = e.args as Record<string, unknown>;
    const has = (k: string) => typeof a[k] === "string" && a[k] !== "";
    let line: string | null = null;
    switch (e.op) {
      case "open": line = has("url") ? `agentglass-browser open ${q(a.url)}` : null; break;
      case "click": case "dblclick": case "rightclick": case "hover":
      case "focus": case "blur": case "select":
        line = has("selector") ? `agentglass-browser ${e.op} ${q(a.selector)}` : null; break;
      case "type": {
        if (!has("selector")) break;
        const secret = a.text === "[redacted]";
        if (secret) redacted++;
        line = `agentglass-browser type ${q(a.selector)} ${q(a.text)}${a.submit ? " --submit" : ""}`
          + (secret ? "   # ← a secret was redacted from the log: put the real value here" : "");
        break;
      }
      /*
       * `fill` had no case at all, so it fell to `default` and its plaintext
       * was written into the shareable replay script as a JSON comment — the
       * one verb whose whole job is a login form, emitted as the one shape
       * that carries its argument verbatim. It is `type`'s rule, once per
       * field, with `type`'s marker.
       *
       * No `--submit`: the CLI accepts the flag and `parseAsk` drops it, so
       * the log has never held the fact. Emitting it would be inventing one.
       */
      case "fill": {
        const f = a.fields;
        if (!f || typeof f !== "object" || Array.isArray(f)) break;
        const pairs = Object.entries(f as Record<string, unknown>);
        if (pairs.length === 0) break;
        const secret = pairs.some(([, v]) => v === REDACTED);
        if (secret) redacted++;
        line = `agentglass-browser fill `
          + pairs.map(([k, v]) => `--field ${q(`${k}=${String(v)}`)}`).join(" ")
          + (secret ? "   # ← a secret was redacted from the log: put the real value here" : "");
        break;
      }
      case "check":
        line = has("selector") ? `agentglass-browser check ${q(a.selector)}${a.checked === false ? " --off" : ""}` : null;
        break;
      case "press": line = has("key") ? `agentglass-browser press ${q(a.key)}` : null; break;
      case "reload": line = "agentglass-browser reload"; break;
      case "checkup": line = has("url") ? `agentglass-browser checkup ${q(a.url)}` : a.reload === true ? "agentglass-browser checkup --reload" : null; break;
      case "back": case "forward": line = `agentglass-browser ${e.op}`; break;
      case "dialog":
        line = a.accept === true || a.dismiss === true
          ? `agentglass-browser dialog --${a.accept === true ? "accept" : "dismiss"}${a.always === true ? " --always" : ""}${typeof a.text === "string" ? " --text '<withheld>'" : ""}` : null;
        break;
      default: line = null;
    }
    if (line) { lines.push(line); acted++; }
    else if (e.op === "clipboard" && typeof e.args.write === "string") {
      /* The audit line keeps the text — it is often the only record of what an
         agent put on the clipboard — but this file is the SHAREABLE one, the
         sink that made `fill` matter, and a clipboard write is a paste of
         something. The length tells a reader it happened; the value stays in
         the log. */
      lines.push(`# clipboard --write <${e.args.write.length} characters, withheld here: read the audit log>   # no shell form for this one — do it by hand`);
    }
    else lines.push(`# ${e.op} ${JSON.stringify(e.args)}   # no shell form for this one — do it by hand`);
  }
  if (acted === 0) lines.push("# nothing in this session changed anything.");
  if (redacted > 0) {
    lines.splice(6, 0,
      `# ${redacted} value${redacted === 1 ? " was" : "s were"} redacted from the log and cannot be recovered.`,
      "# The lines that need them are marked. This is on purpose: the log is what",
      "# gets shared, and a password in it is the failure that banned another tool here.",
      "");
  }
  return lines.join("\n") + "\n";
}

/** A fresh log, memory AND disk. The file half matters for a test: the
 *  durable log is now what `exportAudit` reads when there is one, so leaving
 *  yesterday's file behind would leak entries into the next case. */
export function resetAudit(): void {
  AUDIT.length = 0;
  auditSeq = 0;
  const path = auditLogPath();
  if (path) { try { rmSync(path, { force: true }); rmSync(`${path}.1`, { force: true }); } catch { /* nothing to clear */ } }
}

/** Turn an untrusted body into an ask, or say why not. The message is shown to
 *  whoever typed the command, so it names the field. */
/** A name for `addInitScript`/`expose`: a plain JS identifier, because it is
 *  either a key the shell uses to find-and-replace a registration by name, or
 *  a property `expose` hangs off `window` — and an identifier is the one
 *  shape that can never be read as anything but a name, whichever of those
 *  two jobs it ends up doing. */
const okName = (s: unknown): s is string =>
  typeof s === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(s);


/** The home the operator's shell means by `~` — the same choice disk.ts makes,
 *  and for the same reason: a test that moves HOME must move the boundary. */
const uploadHome = (): string => process.env.HOME || homedir();

/** Where nothing may ever be attached from, whatever the scope says: the
 *  app's own configuration (the token lives there) and the three directories
 *  that hold keys for everything else. Named on purpose rather than left to
 *  the hidden-path rule — a workspace rooted at `~` would make `~/.ssh` "in
 *  scope", and that is the one answer this must never give. */
function uploadDenied(): string[] {
  const h = uploadHome();
  return [
    dirname(configPath()), join(h, ".config", "agentglass"), join(h, ".ssh"), join(h, ".gnupg"), join(h, ".aws"),
    // A template (S6) is a signed-in page's cookies and storage, same weight
    // as the four above — named explicitly rather than left to the
    // hidden-segment rule below, which a non-default `XDG_DATA_HOME` inside
    // the workspace or an AGENTGLASS_DISK_ROOTS entry would step around.
    join(process.env.XDG_DATA_HOME || join(h, ".local", "share"), "agentglass", "browser-templates"),
  ];
}

function underDir(p: string, dir: string): boolean {
  const back = relative(dir, p);
  return back === "" || (!back.startsWith("..") && !back.startsWith(sep) && !/^[A-Za-z]:/.test(back));
}

/**
 * The same roots check `bin/agentglass-browser-mcp` makes, made again where the
 * write lands.
 *
 * The door resolves the directory in its own process, and the directory is
 * inside the work tree: the turn's own shell can replace it with a link between
 * that check and this one. So the roots ride on the body and both sides are
 * resolved again here. Empty when the body names no roots — a person's own call,
 * not a turn's.
 */
export function turnWriteRefusal(p: string, roots: unknown): string {
  if (!Array.isArray(roots) || !roots.length) return "";
  const real = (x: string): string => {
    let at = resolve(x);
    const rest: string[] = [];
    for (;;) {
      try { return rest.length ? join(realpathSync(at), ...rest) : realpathSync(at); } catch { /* climb */ }
      const up = dirname(at);
      if (up === at) return resolve(x);
      rest.unshift(basename(at));
      at = up;
    }
  };
  const want = real(p);
  for (const r of roots) {
    if (typeof r !== "string" || !r) continue;
    const root = real(r);
    if (!underDir(want, root)) continue;
    const first = relative(root, want).split(sep)[0];
    if (want !== root && (first === ".git" || first === ".claude")) {
      return `refused: ${want} is inside ${first} of a writable root, and that is what runs next`;
    }
    return "";
  }
  return `refused: ${want} is outside this turn's writable roots (${roots.filter((r) => typeof r === "string").join(", ")})`;
}

/** The two protocol methods that decide where a page's next file lands. */
const DOWNLOAD_METHODS: ReadonlySet<string> = new Set(["Browser.setDownloadBehavior", "Page.setDownloadBehavior"]);

/**
 * The refusal for a `cdp` ask or a `do` step that arms a download, or "".
 *
 * `Page.setDownloadBehavior` and its browser-wide twin reach the same power as
 * `download` without going through it: no selector, no click, just where the
 * next file a page offers lands. `behavior: "default"` and `"deny"` name no
 * directory and write nothing; an `allow` with no `downloadPath` puts the file
 * in the browser's own download folder, which is nobody's turn root either.
 */
export function downloadPathRefusal(args: Record<string, unknown>, roots: unknown): string {
  if (!DOWNLOAD_METHODS.has(String(args.method ?? ""))) return "";
  const params = (args.params && typeof args.params === "object" ? args.params : {}) as Record<string, unknown>;
  const path = params.downloadPath;
  if (typeof path === "string" && path) {
    // Chromium resolves a relative directory against the browser process, not
    // this one: "assets" would be checked here as `<cwd>/assets` and land in the
    // app's own working directory.
    if (!isAbsolute(path)) {
      return "refused: the downloadPath must be an absolute path, because Chromium resolves a relative "
        + "one against the browser's own working directory, not this process's";
    }
    return turnWriteRefusal(path, roots);
  }
  const behavior = String(params.behavior ?? "allow");
  if (behavior === "default" || behavior === "deny") return "";
  if (!Array.isArray(roots) || !roots.length) return "";
  return "refused: arming a download with no downloadPath puts the next file in the browser's own "
    + "download folder, outside this turn's writable roots. Name a directory inside the turn's "
    + "worktree or its own run folder.";
}

/**
 * May this file be attached to a page's file input?
 *
 * Before this, the only check was `startsWith("/")`, and the audit's example
 * was `~/.ssh/id_rsa`: an agent — or a page that talked one into it — could
 * name any absolute path and the panel would attach it through the
 * debugger. Now the path is resolved through its symlinks and the REAL file
 * has to pass, in order:
 *
 *   - the two kill switches an operator uses to keep the UI off the disk,
 *     read at call time the way `diskEnabled()` is — a switch that only
 *     counts at boot is a switch nobody can trust;
 *   - the explicit deny list above, checked on the spelling AND the real
 *     path, against the real path of each denied directory too (a `~/.ssh`
 *     that is itself a link elsewhere still counts as `~/.ssh`);
 *   - the workspace scope, or failing that the machine-search roots with
 *     their hidden-segment rule. `inScope` says yes to everything when no
 *     workspace root is set — "whole machine, nothing to enforce" — which
 *     is the right answer for looking and the wrong one for shipping a
 *     hidden file under `~` to a web page, so in that mode a hidden path
 *     under the home directory needs `diskAllows` to agree, and it never does.
 *
 * The message names the rule and the path, never the file's contents.
 */
export function uploadPathError(p: string): { error: string; real?: undefined } | { error?: undefined; real: string } {
  if (!fsBrowseEnabled()) return { error: "attaching files is disabled (AGENTGLASS_FS_BROWSE_DISABLED=1)" };
  if (!diskEnabled()) return { error: "attaching files is disabled (AGENTGLASS_DISK_DISABLED=1)" };
  if (p.includes("\0")) return { error: "path contains a NUL byte" };
  const spelled = resolve(p);
  let real: string;
  try { real = realpathSync(spelled); } catch { return { error: `${p}: does not exist or cannot be resolved` }; }
  for (const dir of uploadDenied()) {
    let realDir = dir;
    try { realDir = realpathSync(dir); } catch { /* absent: the spelling is all there is */ }
    if (underDir(spelled, dir) || underDir(real, dir) || underDir(real, realDir)) {
      return { error: `${p}: files under ${dir} are never attached to a page` };
    }
  }
  const scoped = workspaceRoot() ? inScope(real) : !isHiddenUnderHome(real);
  if (scoped || diskAllows(real)) return { real };
  return { error: `${p}: outside the workspace and outside the machine-search roots (AGENTGLASS_DISK_ROOTS)` };
}

/** A dotted segment anywhere below `~` — the rule diskAllows applies from its
 *  roots, applied from the home directory for the case where there is no
 *  workspace root to measure from. */
function isHiddenUnderHome(real: string): boolean {
  const h = uploadHome();
  if (!underDir(real, h)) return false;
  return relative(h, real).split(sep).some((seg) => seg.startsWith("."));
}

/** Who is asking, as the caller says it. Looser than `okName` on purpose — a
 *  derived identity is `<project stem>-<session tail>` and an explicit one is
 *  whatever a person typed after `--as`, so dashes and dots belong. What it
 *  refuses is the two shapes that would make the audit unreadable: a newline,
 *  and something long enough to be a payload rather than a name. */
const okIdentity = (s: unknown): s is string =>
  typeof s === "string" && s.trim().length > 0 && s.length <= 64 && !/[\r\n]/.test(s);

/*
 * The last tab each identity NAMED out loud, and nothing else.
 *
 * One entry per caller, because that is exactly what the CLI remembers: `tab
 * <id>` rewrites the single tab `my-tabs.json` holds for that name. Keeping a
 * set instead would outlive the statement it records — an id named an hour ago
 * and long since switched away from would still buy an exemption from the
 * cross-container check.
 *
 * Capped and evicted oldest-first: this is reachable from an unauthenticated
 * local caller, and an unbounded map keyed by a caller-supplied string is a
 * slow leak with a name on it.
 */
const NAMED_TABS = new Map<string, string>();
const NAMED_TABS_MAX = 64;

function rememberNamedTab(as: string, tab: string): void {
  /* Re-insert rather than update, so the eviction order is "least recently
     said" and not "first ever said" — a long-lived agent that keeps switching
     tabs must not be the first one thrown out. Keyed under the one fold:
     `tab t7` as `Alba` and a verb as `alba` are one identity. */
  as = foldWorkerName(as);
  NAMED_TABS.delete(as);
  NAMED_TABS.set(as, tab);
  while (NAMED_TABS.size > NAMED_TABS_MAX) {
    const oldest = NAMED_TABS.keys().next();
    if (oldest.done) break;
    NAMED_TABS.delete(oldest.value);
  }
}

function namedTabOf(as: string): string | undefined { return NAMED_TABS.get(foldWorkerName(as)); }

/** The allow-list refusal, worded for who is asking. A worker is refused
 *  `--shared` (see AGENT_SHARED_REFUSAL), so pointing it there is a loop: its
 *  only way through is somebody who can change the setting. */
export function profileRefusal(profile: string, list: string[], worker: boolean): string {
  const head = `profile refused: "${profile}" is not in the allow-list (${list.join(", ")}).`;
  if (worker) {
    return `${head} Ask the orchestrator or the person to add "${profile}" to Settings ▸ Browser ▸ Allowed profiles.`;
  }
  return `${head}${profilesLift()} Pass --shared (\`shared: true\` on the MCP) to work in the person's own container instead.`;
}

/** `worker`: the ask comes on an agent's credential, which changes the way
 *  through a refusal names (see `profileRefusal`). */
export function parseAsk(op: unknown, body: unknown, opts: { worker?: boolean } = {}): { ask: BrowserAsk } | { error: string } {
  if (!BROWSER_OPS.includes(op as BrowserOp)) return { error: `unknown browser operation` };
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  /* A container this ask would claim in the ledger. Claimed at the END, once
     every refusal has had its say: a `javascript:` url, an origin off the
     list, read-only mode — each used to leave the record written anyway, so
     a container that was never made had a creator, and read-only mode wrote
     a file to disk, the one thing it says it does not do. */
  let claim: { name: string; identity: string | null } | null = null;
  /* §9's two attribution fields, read FIRST so the refusals below — an origin
     outside the allow-list, a container that is not in it, read-only mode —
     are attributed too. A refused call is the one somebody most wants a name
     against: it is the record that an agent tried. */
  const caller: AuditCaller = {};
  if (b.as !== undefined) {
    if (typeof b.as !== "string" || !b.as.trim() || b.as.length > 128 || /[\r\n]/.test(b.as)) {
      return { error: "as must be the short name of the caller" };
    }
    caller.as = b.as.trim();
  }
  if (b.how !== undefined) {
    if (!HOWS.includes(b.how as AuditHow)) return { error: `how must be one of: ${HOWS.join(", ")}` };
    caller.how = b.how as AuditHow;
  }
  /* Any verb may be addressed to a lane. Named, not fallen through: see askOnce. */
  if (b.lane !== undefined && op !== "lane") {
    if (!isLaneId(b.lane)) return { error: "lane must be the id `lane new` printed" };
    args.lane = b.lane;
  }
  switch (op as BrowserOp) {
    case "lane": {
      const action = String(b.action ?? "");
      if (action === "new") {
        args.action = "new";
        if (b.shared === true) {
          args.container = "shared";
        } else if (b.profile !== undefined) {
          if (typeof b.profile !== "string" || !b.profile.trim() || b.profile.length > 64 || /[\r\n]/.test(b.profile)) {
            return { error: "profile must be the name of a container" };
          }
          args.container = "named";
          args.name = b.profile.trim();
        } else if (b.ephemeral === true) {
          // S6: `lane new --from-template` — the CLI, never the server, reads
          // the template file and seeds the lane's tab afterwards with the
          // same `session load` calls a person's own file would go through.
          // The server only knows this jar is in-memory, never persisted.
          args.container = "ephemeral";
        } else {
          args.container = "private";
        }
        /* `lane new --ephemeral --vault NAME`: which vault a first visit of
           this lane signs in from. Only an ephemeral lane is ever filled. */
        if (b.vault !== undefined) {
          if (typeof b.vault !== "string" || !b.vault.trim() || b.vault.length > 128) return { error: "vault must be the name of a vault" };
          if (args.container !== "ephemeral") return { error: "vault only applies to an ephemeral lane (lane new --ephemeral --vault NAME)" };
          args.vault = b.vault.trim();
        }
      } else if (action === "list") {
        args.action = "list";
        if (b.force === true) args.force = true;
      } else if (action === "close") {
        if (!isLaneId(b.id)) return { error: "close needs the lane id" };
        args.action = "close";
        args.id = b.id;
        if (b.force === true) args.force = true;
      } else if (action === "vault") {
        /* Sign this lane in to one site from the login vault. Only the
           site's name crosses here; the values stay in Electron main. */
        if (!isLaneId(b.id)) return { error: "vault needs the lane id" };
        const site = typeof b.site === "string" ? b.site.trim().toLowerCase() : "";
        if (!/^[a-z0-9.-]{1,253}$/.test(site)) return { error: "vault needs one site, like acme.test" };
        if (b.vault !== undefined && (typeof b.vault !== "string" || !b.vault.trim() || b.vault.length > 128)) {
          return { error: "vault must be a vault name the ambiguous answer listed" };
        }
        args.action = "vault";
        args.id = b.id;
        args.site = site;
        if (typeof b.vault === "string") args.vault = b.vault.trim();
      } else if (action === "vaults") {
        /* The vault names and their site counts, from the index alone. */
        args.action = "vaults";
      } else {
        return { error: "lane action must be one of: new, list, close, vault, vaults" };
      }
      break;
    }
    case "open":
    case "newtab": {
      /* S6's visible-tab twin: `newtab --from-template` mints a blank
         ephemeral tab first (the CLI reads the template and seeds it
         afterwards, the same as `lane new --from-template` — see that
         branch's comment). Checked FIRST, before the profile branch below
         claims anything: `open` never mints a partition (it navigates a tab
         whose partition is already fixed when it attached), and a NAMED
         profile is a persisted container — the opposite of this one-shot,
         in-memory jar — so the two together would file the tab under a
         container it does not actually use. */
      if (b.ephemeral === true) {
        if (op !== "newtab") return { error: "ephemeral only applies to newtab — open acts on a tab whose partition is already fixed" };
        if (b.profile !== undefined) return { error: "ephemeral and profile are two different jars — pick one" };
        args.ephemeral = true;
      }
      if (b.profile !== undefined) {
        /*
         * THE EMPTY STRING IS THE PERSON'S OWN CONTAINER, and it is a legal
         * value here — the only one that is not a name.
         *
         * `--shared` means "the container the person is signed into", which is
         * the empty partition. It has to travel as a string, because that is
         * what routes an `open` to the minting path (`browserBus.ts`,
         * `typeof ask.args.profile === "string"`); sending nothing instead
         * lands on the mounted webview, which is whichever tab is in front —
         * the hijack this whole change is about. Rejecting `""` here would put
         * that back, one layer down.
         */
        if (typeof b.profile !== "string") {
          return { error: "profile must be the name of one — call `profiles` for what exists" };
        }
        if (b.profile !== "" && !b.profile.trim()) {
          return { error: "profile must be the name of one — call `profiles` for what exists" };
        }
        const list = allowedProfiles();
        /* `profileAllowed("")` is already true — the unprofiled default has
           always been allowed, and this list is about NAMED identities. Said
           here so nobody re-derives it from the call below. */
        if (!profileAllowed(b.profile, list)) {
          /* Every identity now sends a derived profile, so with an allow-list
             configured this is the refusal an agent meets on its FIRST call —
             and a refusal that says no way through gets worked around. The way
             through is the person's own container, which the list never
             covers. */
          const msg = profileRefusal(b.profile, list, opts.worker === true);
          recordAudit(op as BrowserOp, { profile: b.profile }, false, msg, false, undefined, caller);
          return { error: msg };
        }
        args.profile = b.profile;
        /* §13: the moment a name is in play is the only moment this relay can
           learn who is behind it. First writer wins, so the agent whose `open`
           MINTS the container is recorded as its creator and every later user
           only moves the clock. */
        claim = { name: b.profile, identity: okIdentity(b.identity) ? b.identity : null };
      }
      if (okIdentity(b.identity)) args.identity = b.identity;
      /*
       * §12: a tab an agent mints does not take the pane unless it says so.
       *
       * `--show` used to be a CLI-only retry flag — it never crossed the wire,
       * because there was nothing on this side that could act on it: minting
       * ALWAYS moved the pointer. Now the panel decides, so the intent has to
       * travel. Absent means background, which is the default the person asked
       * for: "you have to work in the background, in your own container."
       */
      if (b.show === true) args.show = true;
      /* Which vault a first visit in the agent's own container signs in from. */
      if (typeof b.vault === "string" && b.vault.trim()) args.vault = b.vault.trim().slice(0, 128);
      /* An ephemeral mint is deliberately blank: the CLI writes the
         template's cookies via CDP onto this tab BEFORE its own follow-up
         `open` navigates it to the real (fully validated) origin, and
         `Network.setCookie` needs no page loaded at all. Minting at the real
         URL directly would navigate before the cookies land — precisely the
         redirect-race `lane new --from-template` was built to avoid — so
         `about:blank` is the one URL this flag accepts unchecked: it reaches
         no origin at all, allow-listed or not. */
      const rawUrl = typeof b.url === "string" ? b.url.trim() : "";
      if (args.ephemeral === true && rawUrl === "about:blank") {
        args.url = "about:blank";
        break;
      }
      /* Same validation for both `open` and an ordinary `newtab`: the only
         difference is whether the page lands over the current view or
         beside it. */
      const url = safeUrl(b.url);
      if (!url) return { error: "url must be an http(s) address" };
      const list = allowedOrigins();
      const host = new URL(url).host;
      if (!originAllowed(host, list)) {
        const msg = `origin refused: ${host} is not in the allow-list (${list.join(", ")}).${originsLift()}`;
        recordAudit(op as BrowserOp, { url }, false, msg, false, undefined, caller);
        return { error: msg };
      }
      args.url = url;
      break;
    }
    case "cdp": {
      /* `events: true` drains the buffer and takes no method; anything else
         must name one. Both shapes validated here rather than in the panel,
         because this is where §16's guardrails read the verb. */
      if (b.events === true) { args.events = true; break; }
      if (typeof b.method !== "string" || !b.method.includes(".")) {
        return { error: 'cdp needs a method like "Debugger.enable", or events: true' };
      }
      args.method = b.method;
      if (b.params !== undefined) {
        if (typeof b.params !== "object" || b.params === null || Array.isArray(b.params)) {
          return { error: "cdp params must be an object" };
        }
        args.params = b.params;
      }
      break;
    }
    case "debug": {
      const ACTIONS = ["on", "off", "break", "dom", "where", "resume", "into", "over", "out"];
      const action = String(b.action ?? "");
      if (!ACTIONS.includes(action)) {
        return { error: `debug action must be one of: ${ACTIONS.join(", ")}` };
      }
      args.action = action;
      if (action === "break") {
        if (typeof b.url !== "string" || !b.url.trim()) return { error: "break needs the url of the script" };
        const line = Number(b.line);
        if (!Number.isInteger(line) || line < 1) return { error: "line is 1-based and must be a whole number" };
        args.url = b.url; args.line = line;
        if (b.condition !== undefined) {
          if (typeof b.condition !== "string") return { error: "condition must be a JavaScript expression" };
          args.condition = b.condition;
        }
      }
      if (action === "dom") {
        if (!okSelector(b.selector)) return { error: "dom needs a selector for the node to watch" };
        args.selector = b.selector;
        const KINDS = ["subtree-modified", "attribute-modified", "node-removed"];
        const on = b.on === undefined ? "subtree-modified" : String(b.on);
        if (!KINDS.includes(on)) return { error: `on must be one of: ${KINDS.join(", ")}` };
        args.on = on;
      }
      break;
    }
    case "audit": {
      if (b.script !== undefined) {
        if (typeof b.script !== "boolean") return { error: "script must be true or false" };
        args.script = b.script;
      }
      /*
       * `--tab <id>` narrows to one tab, from every caller — the question the
       * incident actually needed answered, and the one the log could not
       * answer at all before §9 recorded a resolved tab.
       *
       * `--by NAME` narrows to one caller. It is a SEPARATE field from `as`
       * on purpose: `as` says who is asking and the CLI now stamps it on
       * every request, `audit` included — so the day it doubled as the filter,
       * every `audit` silently returned the caller's own entries and nothing
       * else. The global view is what made the incident's root cause findable
       * and it is what the machine's owner needs; a per-caller view is an
       * optional filter layered on top of it, never the default.
       */
      if (b.tab !== undefined) {
        if (typeof b.tab !== "string" || !b.tab.trim() || b.tab.length > 128) {
          return { error: "tab must be a tab id" };
        }
        args.tab = b.tab.trim();
      }
      if (b.by !== undefined) {
        if (typeof b.by !== "string" || !b.by.trim() || b.by.length > 128 || /[\r\n]/.test(b.by)) {
          return { error: "by must be the short name of a caller" };
        }
        args.by = b.by.trim();
      }
      break;
    }
    case "record": {
      const frames = b.frames === undefined ? 10 : Number(b.frames);
      if (!Number.isInteger(frames) || frames < 1 || frames > 120) {
        return { error: "frames must be a whole number from 1 to 120" };
      }
      const every = b.every === undefined ? 500 : Number(b.every);
      if (!Number.isFinite(every) || every < 50 || every > 10_000) {
        return { error: "every is the gap in ms, from 50 to 10000" };
      }
      /* A recording that would take longer than the verb is allowed to live
         is refused UP FRONT, rather than dying half way and leaving the caller
         to work out how much of the timeline they are missing. */
      if (frames * every > 150_000) {
        return { error: `${frames} frames every ${every}ms is ${Math.round(frames * every / 1000)}s — the ceiling is 150s` };
      }
      if (typeof b.dir !== "string" || !b.dir.startsWith("/")) {
        return { error: "dir must be an absolute path to write the frames into" };
      }
      args.frames = frames;
      args.every = every;
      args.dir = b.dir;
      if (b.gif !== undefined) {
        if (typeof b.gif !== "string" || !b.gif.startsWith("/") || !b.gif.endsWith(".gif")) {
          return { error: "gif must be an absolute path ending in .gif" };
        }
        args.gif = b.gif;
      }
      /* What each frame CONTAINS is `shot`'s question, so it is `shot`'s
         arguments — same names, same rules, validated by the same code when
         each frame is taken. A second vocabulary for the same thing is how the
         two drift. */
      for (const k of ["selector", "clip"]) {
        if (b[k] !== undefined) args[k] = b[k];
      }
      break;
    }
    case "download": {
      /* §11: a download that vanishes into a directory with no name reported
         back is the same as no download — this returns the path a caller can
         open, so both ends are validated the same as `click`/`record`. */
      if (typeof b.selector !== "string" || !b.selector.trim()) {
        return { error: "download needs a selector — the link or button that starts it" };
      }
      if (typeof b.dir !== "string" || !b.dir.startsWith("/")) {
        return { error: "dir must be an absolute path to save the file into" };
      }
      args.selector = b.selector;
      args.dir = b.dir;
      if (b.timeoutMs !== undefined) {
        const n = Number(b.timeoutMs);
        if (!Number.isFinite(n) || n < 1_000 || n > 110_000) {
          return { error: "timeoutMs must be from 1000 to 110000" };
        }
        args.timeoutMs = n;
      }
      break;
    }
    case "events": {
      if (b.since !== undefined) {
        const n = Number(b.since);
        if (!Number.isFinite(n) || n < 0) return { error: "since must be an epoch in ms" };
        args.since = n;
      }
      if (b.wait !== undefined) {
        const n = Number(b.wait);
        if (!Number.isFinite(n) || n < 0 || n > 120) return { error: "wait is in seconds, 0 to 120" };
        args.wait = n;
      }
      if (b.kinds !== undefined) {
        const KINDS = ["console", "network", "cdp"];
        if (!Array.isArray(b.kinds) || b.kinds.some((k) => !KINDS.includes(String(k)))) {
          return { error: `kinds must be a list of: ${KINDS.join(", ")}` };
        }
        args.kinds = b.kinds;
      }
      break;
    }
    case "emulate": {
      /*
       * Every key optional and every key checked, because a typo here is
       * silent: `colorScheme: "darc"` that reaches Chromium unvalidated sets
       * nothing, reports success, and the run that trusted it proves the
       * wrong thing. The allowed values are the protocol's own.
       */
      const num = (k: string) => {
        const v = (b as Record<string, unknown>)[k];
        if (v === undefined) return true;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return false;
        args[k] = v; return true;
      };
      for (const k of ["width", "height", "scale"]) {
        if (!num(k)) return { error: `${k} must be a non-negative number` };
      }
      if (b.mobile !== undefined) {
        if (typeof b.mobile !== "boolean") return { error: "mobile must be true or false" };
        args.mobile = b.mobile;
      }
      for (const k of ["userAgent", "language", "timezone", "locale"]) {
        const v = (b as Record<string, unknown>)[k];
        if (v === undefined) continue;
        if (typeof v !== "string" || !v.trim()) return { error: `${k} must be a non-empty string` };
        args[k] = v;
      }
      if (b.colorScheme !== undefined) {
        if (!["light", "dark", "no-preference"].includes(String(b.colorScheme))) {
          return { error: 'colorScheme must be light, dark or no-preference' };
        }
        args.colorScheme = b.colorScheme;
      }
      if (b.reducedMotion !== undefined) {
        if (!["reduce", "no-preference"].includes(String(b.reducedMotion))) {
          return { error: 'reducedMotion must be reduce or no-preference' };
        }
        args.reducedMotion = b.reducedMotion;
      }
      if (b.vision !== undefined) {
        const KINDS = ["none", "achromatopsia", "blurredVision", "deuteranopia", "protanopia", "tritanopia", "reducedContrast"];
        if (!KINDS.includes(String(b.vision))) {
          return { error: `vision must be one of: ${KINDS.join(", ")}` };
        }
        args.vision = b.vision;
      }
      if (b.geolocation !== undefined) {
        const g = b.geolocation as { lat?: unknown; lon?: unknown };
        if (typeof g !== "object" || g === null || typeof g.lat !== "number" || typeof g.lon !== "number") {
          return { error: "geolocation needs { lat, lon } as numbers" };
        }
        args.geolocation = b.geolocation;
      }
      if (b.reset !== undefined) {
        if (typeof b.reset !== "boolean") return { error: "reset must be true or false" };
        args.reset = b.reset;
      }
      if (Object.keys(args).length === 0) {
        return { error: "emulate needs something to emulate — width/height/scale, mobile, userAgent, language, timezone, locale, colorScheme, reducedMotion, vision, geolocation, or reset" };
      }
      break;
    }
    case "clock": {
      /*
       * §8: the wait an agent should never have to sit through. A capture of a
       * thirty-second timer cost three minutes of real waiting — the fix is
       * not a faster timer, it is a clock the page cannot tell apart from the
       * real one moving without anyone actually waiting for it.
       *
       * `advanceMs` alone is `Emulation.setVirtualTimePolicy`. `seal` and
       * `freezeAnimations` are the other two things the spec asks for in the
       * same breath, because a capture taken after a clock jump is only
       * repeatable if nothing ELSE on the page is still free to vary —
       * `Math.random()`, a CSS transition still running, a still-ticking
       * animation frame. `advanceMs: 0` is a legal call: seal or freeze
       * without moving the clock at all.
       */
      if (b.advanceMs !== undefined) {
        const n = Number(b.advanceMs);
        // A day of virtual time is already an absurd ask; the cap exists so a
        // typo (5e9 instead of 5000) fails here rather than pinning the page's
        // scheduler running timers for however long that turns out to take.
        if (!Number.isInteger(n) || n < 0 || n > 3_600_000) return { error: "advanceMs must be 0..3600000" };
        args.advanceMs = n;
      }
      if (b.waitFor !== undefined) {
        if (b.waitFor !== "networkIdle" && b.waitFor !== "noTimers") {
          return { error: "waitFor must be networkIdle or noTimers" };
        }
        args.waitFor = b.waitFor;
      }
      if (b.seal !== undefined) {
        if (typeof b.seal !== "boolean") return { error: "seal must be true or false" };
        args.seal = b.seal;
      }
      if (b.freezeAnimations !== undefined) {
        if (typeof b.freezeAnimations !== "boolean") return { error: "freezeAnimations must be true or false" };
        args.freezeAnimations = b.freezeAnimations;
      }
      if (!args.advanceMs && !args.seal && !args.freezeAnimations) {
        return { error: "clock needs something to do — advanceMs (> 0), seal, or freezeAnimations" };
      }
      break;
    }
    case "settings": {
      /*
       * §13: the browser's settings, as an API. What is here is split into
       * two parts: page-level (cache, certificate errors, blocking) which
       * Chromium exposes to one page's own DevTools session via CDP, and
       * session-level (proxy, extensions, third-party cookies, DNS) which are
       * process-level settings reached through the Electron main process.
       *
       * Page-level: cache, certificate errors, and blocking a request type per
       * origin have a real, stable CDP command behind them. `page` reaches
       * `about:blank`, which is the one internal page a bare Electron
       * `<webview>` renders at all — it does not ship the rest of Chromium's
       * `chrome://` UI, so pointing this at `about:version` would be a verb
       * that always fails.
       *
       * Session-level (proxy, DNS, extensions, third-party cookies): these are
       * process-level and reached through `session.setProxy`,
       * `session.loadExtension`/`getAllExtensions`/`removeExtension`, etc.
       * reaching them means new wiring into the Electron main process, through
       * the boundary guest-guard.js exists to hold. Chromium flags are read at
       * process launch, so nothing after that point can change them — only
       * report them. Where a proxy target or a DNS remap becomes a *new* origin
       * the browser will actually talk to — §16's allow-list gate belongs on
       * that door, the same way `open`'s `url` already goes through it.
       */
      const action = b.action;
      if (action !== "get" && action !== "set") return { error: 'settings needs action: "get" or "set"' };
      args.action = action;
      if (action === "get") break;
      if (b.cache !== undefined) {
        if (b.cache !== "normal" && b.cache !== "bypass") return { error: 'cache must be "normal" or "bypass"' };
        args.cache = b.cache;
      }
      if (b.ignoreCertErrors !== undefined) {
        if (typeof b.ignoreCertErrors !== "boolean") return { error: "ignoreCertErrors must be true or false" };
        args.ignoreCertErrors = b.ignoreCertErrors;
      }
      if (b.block !== undefined) {
        const blk = b.block as Record<string, unknown>;
        if (!blk || typeof blk !== "object" || typeof blk.origin !== "string" || !blk.origin.trim()) {
          return { error: "block needs { origin, images? and/or js? }" };
        }
        if (/[\s/]/.test(blk.origin) || blk.origin.includes("://")) {
          return { error: "origin must be host or host:port, with no scheme and no path" };
        }
        if (blk.images === undefined && blk.js === undefined) {
          return { error: "block needs images and/or js — otherwise there is nothing to change" };
        }
        const clean: Record<string, unknown> = { origin: blk.origin };
        if (blk.images !== undefined) {
          if (typeof blk.images !== "boolean") return { error: "images must be true or false" };
          clean.images = blk.images;
        }
        if (blk.js !== undefined) {
          if (typeof blk.js !== "boolean") return { error: "js must be true or false" };
          clean.js = blk.js;
        }
        args.block = clean;
      }
      /*
       * `--internal-page`, AND WHY IT WAS RENAMED.
       *
       * This argument used to be called `page`, and it is the only reason
       * `settings` was the one verb denied a tab id: the CLI refused to stamp
       * `--page <tab>` here because it would land in this slot, and
       * `settings set --page t17-… --cache bypass` answered `page must be
       * "blank"` — a sentence about an argument the caller never passed. The
       * collision was the whole blocker, so the collision is what got fixed:
       * `page` now means what it means on every other verb (WHICH TAB), and
       * the internal page a webview may render has its own name — the one the
       * CLI's parser already spells.
       *
       * `page: "blank"` is still accepted, exactly and only that literal,
       * because the CLI on disk today still sends it under the old name and a
       * rename that breaks `--internal-page blank` for one release is a
       * regression the caller cannot see coming. "blank" is not a tab id.
       */
      let internalPage: unknown;
      if (b.internalPage !== undefined) internalPage = b.internalPage;
      else if (b.page === "blank") internalPage = b.page;
      if (internalPage !== undefined) {
        if (internalPage !== "blank") {
          return { error: 'internalPage must be "blank" — the only internal page this webview renders' };
        }
        args.internalPage = "blank";
      }
      /*
       * PARTITION-WIDE, AND NOT "WINDOW-WIDE" — SAY WHICH.
       *
       * These four reach `session.fromPartition(BROWSER_PARTITION)`, and that
       * constant is the DEFAULT partition `persist:agentglass-browser` while a
       * container is `persist:agentglass-browser-<suffix>`. So they land on the
       * person's own browsing session and on no container at all — a smaller
       * and stranger blast radius than the phrase "window-wide" suggests, and
       * one nobody could have guessed from the flag.
       *
       * They are unreachable from the CLI's current flags and reachable over
       * raw HTTP, so requiring `window: true` breaks nothing that works today
       * and makes the one caller who can reach them say what they mean.
       */
      const wide = b.proxy !== undefined || b.cookies !== undefined
        || b.extensions !== undefined || b.dns !== undefined;
      if (wide && b.window !== true) {
        return {
          error: "proxy, cookies, extensions and dns are not per-tab: they change one Electron "
            + "session — the default browser partition, which is the person's own browsing and NOT "
            + 'the containers. Pass window: true to say you mean that.',
        };
      }
      if (b.window !== undefined) {
        if (typeof b.window !== "boolean") return { error: "window must be true or false" };
        args.window = b.window;
      }
      /* Session-level settings. All go through the origin allow-list if they
         widen what the browser can talk to. */
      if (b.proxy !== undefined) {
        const px = b.proxy as Record<string, unknown>;
        if (!px || typeof px !== "object") return { error: "proxy must be an object" };
        const rules = String(px.rules ?? "");
        if (!rules) return { error: "proxy needs { rules } with a proxy URL" };
        if (px.bypass !== undefined && typeof px.bypass !== "string") {
          return { error: "proxy bypass must be a string (comma-separated hosts)" };
        }
        const clean: Record<string, unknown> = { rules };
        if (px.bypass) clean.bypass = px.bypass;
        args.proxy = clean;
      }
      if (b.cookies !== undefined) {
        const c = b.cookies as Record<string, unknown>;
        if (!c || typeof c !== "object") return { error: "cookies must be an object" };
        const policy = String(c.thirdParty ?? "");
        if (policy && !["allow", "block", "block-third-party"].includes(policy)) {
          return { error: 'cookies.thirdParty must be "allow", "block", or "block-third-party"' };
        }
        if (policy) args.cookies = { thirdParty: policy };
      }
      if (b.extensions !== undefined) {
        const ext = b.extensions as Record<string, unknown>;
        if (!ext || typeof ext !== "object") return { error: "extensions must be an object" };
        const action = String(ext.action ?? "");
        if (!["load", "list", "remove"].includes(action)) {
          return { error: 'extensions.action must be "load", "list", or "remove"' };
        }
        if (action === "load") {
          const path = String(ext.path ?? "");
          if (!path) return { error: "extensions load needs { path } to the extension directory" };
          args.extensions = { action: "load", path };
        } else if (action === "remove") {
          const id = String(ext.id ?? "");
          if (!id) return { error: "extensions remove needs { id } of the extension to remove" };
          args.extensions = { action: "remove", id };
        } else {
          args.extensions = { action: "list" };
        }
      }
      if (b.dns !== undefined) {
        const d = b.dns as Record<string, unknown>;
        if (!d || typeof d !== "object") return { error: "dns must be an object" };
        if (typeof d.rules !== "string") return { error: "dns needs { rules } with remapping rules" };
        args.dns = { rules: d.rules };
      }
      const pageSettings = args.cache !== undefined || args.ignoreCertErrors !== undefined || args.block !== undefined || args.internalPage !== undefined;
      const sessionSettings = args.proxy !== undefined || args.cookies !== undefined || args.extensions !== undefined || args.dns !== undefined;
      if (!pageSettings && !sessionSettings) {
        return { error: "settings set needs something to change — cache, ignoreCertErrors, block, internalPage, proxy, cookies, extensions, or dns" };
      }
      break;
    }
    case "throttle": {
      if (b.off === true) { args.off = true; break; }
      if (b.offline === true) { args.offline = true; break; }
      if (b.network !== undefined) {
        const NETS = ["slow-3g", "fast-3g", "4g"];
        if (!NETS.includes(String(b.network))) return { error: `network must be one of: ${NETS.join(", ")}` };
        args.network = b.network;
      }
      if (b.cpu !== undefined) {
        const n = Number(b.cpu);
        /* A rate, not a percentage: 4 means "four times slower". 1 is normal,
           and anything under it would be a machine that does not exist. */
        if (!Number.isFinite(n) || n < 1 || n > 20) return { error: "cpu is a slowdown rate from 1 to 20" };
        args.cpu = n;
      }
      if (Object.keys(args).length === 0) {
        return { error: "throttle needs network, cpu, offline: true, or off: true" };
      }
      break;
    }
    case "har":
      /* Nothing to validate — it reads a buffer this page has been filling. */
      break;
    case "storage": {
      const where = b.where === undefined ? "local" : String(b.where);
      if (where !== "local" && where !== "session" && where !== "idb") {
        return { error: 'where must be "local", "session" or "idb"' };
      }
      if (where === "idb" && (b.set === true || b.remove === true)) {
        /* Reading the names is useful and writing one is not: a structured
           clone written blind into a page's own database is a corruption
           somebody debugs for a day. */
        return { error: "idb can be listed, not written" };
      }
      args.where = where;
      if (b.set === true || b.remove === true) {
        if (typeof b.key !== "string" || !b.key) return { error: "set and remove need a key" };
        args.key = b.key;
        if (b.set === true) {
          if (typeof b.value !== "string") return { error: "set needs a value (a string)" };
          args.set = true; args.value = b.value;
        } else args.remove = true;
      }
      break;
    }
    case "permission": {
      /* The agent's answer to a request its own tab is holding (`grant` /
         `deny`), or the list of what is held and answered. Main decides
         whether the tab is the agent's; this only checks the shape. */
      if (b.list === true) { args.list = true; break; }
      if (b.answer !== undefined) {
        if (b.answer !== "grant" && b.answer !== "deny") return { error: "answer must be grant or deny" };
        const what = b.permissions;
        if (!Array.isArray(what) || what.length === 0 || what.some((x) => typeof x !== "string" || !AGENT_PERMISSIONS.has(x))) {
          return { error: "answer names microphone, camera or notifications — nothing else is an agent's to grant" };
        }
        if (b.origin !== undefined) {
          let host = "";
          try { const u = new URL(String(b.origin)); if (/^https?:$/.test(u.protocol)) host = u.port ? `${u.hostname}:${u.port}` : u.hostname; } catch { /* checked below */ }
          const list = allowedOrigins();
          if (!host || !originAllowed(host, list)) return { error: `origin ${String(b.origin)} must be a full http(s) origin in the allow-list (${list.join(", ")}).${originsLift()}` };
          args.origin = b.origin;
        }
        args.answer = b.answer; args.permissions = what;
        break;
      }
      if (typeof b.origin !== "string" || !/^https?:\/\//.test(b.origin)) {
        return { error: "origin must be a full http(s) origin" };
      }
      const perms = b.permissions;
      if (!Array.isArray(perms) || perms.length === 0 || perms.some((x) => typeof x !== "string")) {
        return { error: "permissions must be a non-empty list, e.g. [\"clipboardReadWrite\", \"geolocation\"]" };
      }
      /* Through the SAME origin allow-list as everything else. Granting the
         camera to a site the browser is not allowed to visit would be a fence
         with a gate beside it. */
      /*
       * THROUGH `originAllowed`, which is the rule — not through
       * `list.includes`, which is a different and much narrower one.
       *
       * Measured: with the default list, which is `*`, this refused every
       * origin there is. The message even printed the list it was checking
       * against — "origin http://127.0.0.1:8899 is not in
       * AGENTGLASS_BROWSER_ORIGINS (*)" — and nothing is not in `*`. So
       * `permission` could not grant anything on a default install, and
       * `clipboard`, whose own refusal says "grant clipboardReadWrite with
       * `permission` first", was unreachable behind it.
       *
       * A bare hostname entry was the second casualty: the list is documented
       * as "an entry with no `:` matches the hostname on any port", and a raw
       * `includes` refuses `localhost:8001` for a list holding `localhost`.
       * Both rules live in `originAllowed`; there is no second copy now.
       */
      const list = allowedOrigins();
      let host = "";
      try { const u = new URL(b.origin); host = u.port ? `${u.hostname}:${u.port}` : u.hostname; } catch { /* checked below */ }
      if (!host || !originAllowed(host, list)) {
        return { error: `origin ${b.origin} is not in the allow-list (${list.join(", ")}).${originsLift()}` };
      }
      args.origin = b.origin; args.permissions = perms;
      break;
    }
    case "pdf": {
      if (b.landscape !== undefined) {
        if (typeof b.landscape !== "boolean") return { error: "landscape must be true or false" };
        args.landscape = b.landscape;
      }
      if (b.background !== undefined) {
        if (typeof b.background !== "boolean") return { error: "background must be true or false" };
        args.background = b.background;
      }
      break;
    }
    case "drag": {
      if (!okSelector(b.selector)) return { error: "drag needs a selector for what to drag" };
      if (!okSelector(b.to)) return { error: "drag needs `to`: a selector for where to drop it" };
      args.selector = b.selector; args.to = b.to;
      break;
    }
    case "upload": {
      if (!okSelector(b.selector)) return { error: "upload needs a selector for the file input" };
      const paths = b.paths;
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > 20) {
        return { error: "paths must be a list of 1 to 20 absolute file paths" };
      }
      /* Absolute, because a relative path is resolved against whatever the
         SHELL's working directory happens to be — which is not the caller's,
         and the failure is a file that silently is not there. */
      if (paths.some((f) => typeof f !== "string" || !f.startsWith("/"))) {
        return { error: "every path must be absolute" };
      }
      /* And allowed: this verb reads a file off the disk and hands it to a
         web page, so it answers to the same boundary the machine search and
         the workspace do — see `uploadPathError`. The path the panel gets is
         the REAL one, so what was judged is what gets attached. */
      const real: string[] = [];
      for (const f of paths as string[]) {
        const judged = uploadPathError(f);
        if (judged.error !== undefined) return { error: judged.error };
        real.push(judged.real);
      }
      args.selector = b.selector; args.paths = real;
      break;
    }
    case "fake": {
      /*
       * §6: force a 404, a 500 or a hang on requests whose URL contains
       * `pattern` — "the board freezes when the API is down" could until now
       * only be proved in a unit test, never against the real app.
       *
       * `clear` removes a rule by pattern and needs nothing else; otherwise
       * exactly one of `status`/`timeout` is required, same shape as
       * `scroll`'s "exactly one of three" — a rule that both fails fast AND
       * hangs forever has no single answer.
       */
      if (typeof b.pattern !== "string" || !b.pattern.trim() || b.pattern.length > 200 || /[\n\r]/.test(b.pattern)) {
        return { error: "pattern must be a short, single-line piece of the URL to match" };
      }
      args.pattern = b.pattern;
      if (b.clear === true) { args.clear = true; break; }
      const hasStatus = b.status !== undefined;
      const hasTimeout = b.timeout === true;
      if (hasStatus === hasTimeout) {
        return { error: "fake needs exactly one of: status (e.g. 500), or timeout: true" };
      }
      if (hasStatus) {
        const n = Number(b.status);
        if (!Number.isInteger(n) || n < 100 || n > 599) return { error: "status must be 100..599" };
        args.status = n;
      } else {
        args.timeout = true;
      }
      if (b.body !== undefined) {
        if (typeof b.body !== "string" || b.body.length > 10_000) return { error: "body must be a string under 10k" };
        args.body = b.body;
      }
      if (b.delayMs !== undefined) {
        const n = Number(b.delayMs);
        if (!Number.isInteger(n) || n < 0 || n > 120_000) return { error: "delayMs must be 0..120000" };
        args.delayMs = n;
      }
      break;
    }
    case "headers": {
      const h = b.headers;
      if (h === undefined) { args.headers = {}; break; }
      if (typeof h !== "object" || h === null || Array.isArray(h)) {
        return { error: "headers must be an object of name -> value, or nothing to clear them" };
      }
      const entries = Object.entries(h as Record<string, unknown>);
      if (entries.length > 20) return { error: "at most 20 headers" };
      for (const [k, v] of entries) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) return { error: `not a header name: ${k}` };
        if (typeof v !== "string" || /[\r\n]/.test(v)) {
          return { error: `${k} must be a string with no newline in it` };
        }
      }
      args.headers = h;
      break;
    }
    case "clipboard": {
      if (b.write !== undefined) {
        if (typeof b.write !== "string" || b.write.length > 100_000) {
          return { error: "write must be a string under 100k" };
        }
        args.write = b.write;
      }
      break;
    }
    case "save":
      /* Nothing to validate — it snapshots whatever is loaded. */
      break;
    case "intercept": {
      /* §6: intercept and handle requests matching a pattern via CDP's Fetch
       * domain. Unlike fake (which patches fetch/XHR in the page), this catches
       * all requests at the network level, including those that don't go through
       * the page's fetch/XHR.
       *
       * A rule must specify exactly one action: fulfill (send a response), or
       * abort (fail the request). clear removes a rule by pattern and needs
       * nothing else.
       */
      if (typeof b.pattern !== "string" || !b.pattern.trim() || b.pattern.length > 200 || /[\n\r]/.test(b.pattern)) {
        return { error: "pattern must be a short, single-line piece of the URL to match" };
      }
      args.pattern = b.pattern;
      if (b.clear === true) { args.clear = true; break; }
      const hasFulfill = b.fulfill === true;
      const hasAbort = b.abort === true;
      if (hasFulfill === hasAbort) {
        return { error: "intercept needs exactly one of: fulfill, or abort: true" };
      }
      if (hasFulfill) {
        args.fulfill = true;
        const n = Number(b.status ?? 200);
        if (!Number.isInteger(n) || n < 100 || n > 599) return { error: "status must be 100..599" };
        args.status = n;
        if (b.body !== undefined) {
          if (typeof b.body !== "string" || b.body.length > 10_000) return { error: "body must be a string under 10k" };
          args.body = b.body;
        }
      } else {
        args.abort = true;
        if (b.reason !== undefined) {
          if (typeof b.reason !== "string" || !b.reason.trim()) return { error: "reason must be a non-empty string" };
          args.reason = b.reason;
        }
      }
      break;
    }
    case "checkup": {
      /* The url goes through exactly what `open` checks — the scheme and the
         origin allow-list — because it is an `open`. */
      if (b.url !== undefined) {
        const url = safeUrl(b.url);
        if (!url) return { error: "url must be an http(s) address" };
        const list = allowedOrigins();
        const host = new URL(url).host;
        if (!originAllowed(host, list)) {
          const msg = `origin refused: ${host} is not in the allow-list (${list.join(", ")}).${originsLift()}`;
          recordAudit(op as BrowserOp, { url }, false, msg, false, undefined, caller);
          return { error: msg };
        }
        args.url = url;
      }
      for (const k of ["reload", "noShot"] as const) {
        if (b[k] === undefined) continue;
        if (typeof b[k] !== "boolean") return { error: `${k} is a flag` };
        args[k] = b[k];
      }
      if (args.url !== undefined && args.reload === true) return { error: "checkup takes a url or reload, not both" };
      if (b.settleMs !== undefined) {
        const n = Number(b.settleMs);
        if (typeof b.settleMs !== "number" || !Number.isFinite(n)) return { error: "settleMs must be a number of milliseconds" };
        args.settleMs = Math.min(15_000, Math.max(0, Math.round(n)));
      }
      break;
    }
    case "handoff": {
      /* Three shapes: arm (reason, optional until), check (waitMs), cancel. */
      const shapes = ["reason", "check", "cancel"].filter((k) => b[k] !== undefined);
      if (shapes.length !== 1) return { error: "handoff takes exactly one of reason (arm), check or cancel" };
      if (b.reason !== undefined) {
        if (typeof b.reason !== "string" || !b.reason.trim() || b.reason.length > 200 || /[\r\n]/.test(b.reason)) {
          return { error: "reason must be one short line saying what the person is needed for (at most 200 characters)" };
        }
        args.reason = b.reason.trim();
        if (b.until !== undefined) {
          if (typeof b.until !== "string" || !b.until.trim() || b.until.length > 300 || /[\r\n]/.test(b.until)) {
            return { error: "until must be a short CSS selector, or a url fragment starting with / or http" };
          }
          args.until = b.until.trim();
        }
        /* The handoff's deadline, kept by the panel: a caller that dies (killed,
           crashed, its socket timed out) must not leave the banner up and the
           glass lifted for good. Seconds, 1 to 3600, the CLI's own bounds. */
        if (b.timeoutMs !== undefined) {
          const n = Number(b.timeoutMs);
          if (typeof b.timeoutMs !== "number" || !Number.isFinite(n)) return { error: "timeoutMs must be a number of milliseconds" };
          args.timeoutMs = Math.min(3_600_000, Math.max(1000, Math.round(n)));
        }
      } else {
        if (b.until !== undefined) return { error: "until goes with the reason that arms the handoff" };
        if (b.timeoutMs !== undefined) return { error: "timeoutMs goes with the reason that arms the handoff" };
        if (b.check !== undefined) {
          if (b.check !== true) return { error: "check is a flag" };
          args.check = true;
          if (b.waitMs !== undefined) {
            const n = Number(b.waitMs);
            if (typeof b.waitMs !== "number" || !Number.isFinite(n)) return { error: "waitMs must be a number of milliseconds" };
            args.waitMs = Math.min(25_000, Math.max(0, Math.round(n)));
          }
        } else {
          if (b.cancel !== true) return { error: "cancel is a flag" };
          args.cancel = true;
        }
      }
      break;
    }
    case "guide": {
      /* Guide mode: start "<why>", run (a plan the server walks), say (new
         words on the card), next (wait for the person), end (the audit). */
      const action = b.action;
      if (action !== "start" && action !== "run" && action !== "say" && action !== "next" && action !== "end") {
        return { error: 'guide takes action: "start" (with why), "run" (with why, page and plan), "say", "next" or "end"' };
      }
      args.action = action;
      if (action === "run") {
        if (typeof b.page !== "string" || !b.page) return { error: "guide run needs page: the tab the person is guided on (--page <tab>)" };
        const plan = parsePlan(b.plan);
        if ("error" in plan) return { error: plan.error };
        args.plan = plan.steps;
      } else if (b.plan !== undefined) {
        return { error: "plan goes with guide run" };
      }
      if (action === "say") {
        /* A new draft for the card's field (the answer to the person's "Suggest another"), new words, or both. */
        if (b.suggest !== undefined) {
          if (typeof b.suggest !== "string" || !b.suggest.trim()) return { error: "suggest is the new draft for the card's field: a non-empty string" };
          if (b.suggest.length > 2000) return { error: `suggest is ${b.suggest.length} characters; at most 2000 fit on a guide card. Shorten the draft` };
          args.suggest = b.suggest;
        }
        if (b.say !== undefined || args.suggest === undefined) {
          if (typeof b.say !== "string" || !b.say.trim() || b.say.length > 2000) return { error: "guide say needs say: the card's new words (at most 2000 characters)" };
          if (!sayHasWords(b.say)) return { error: `guide say ${SAY_NO_WORDS}` };
          args.say = b.say.trim();
        }
      } else if (b.say !== undefined) {
        return { error: "say goes with guide say (a step's words go with point)" };
      } else if (b.suggest !== undefined) {
        return { error: "suggest goes with guide say (a step's first draft goes with point --suggest)" };
      }
      if (action === "start" || action === "run") {
        if (typeof b.why !== "string" || !b.why.trim() || b.why.length > 200 || /[\r\n]/.test(b.why)) {
          return { error: `guide ${action} needs why: one short line saying what the person is being walked through (at most 200 characters)` };
        }
        args.why = b.why.trim();
      } else if (b.why !== undefined) {
        return { error: "why goes with guide start or guide run" };
      }
      if (b.waitMs !== undefined) {
        if (action !== "next") return { error: "waitMs goes with guide next" };
        const n = Number(b.waitMs);
        if (typeof b.waitMs !== "number" || !Number.isFinite(n)) return { error: "waitMs must be a number of milliseconds" };
        args.waitMs = Math.min(25_000, Math.max(0, Math.round(n)));
      }
      break;
    }
    case "point": {
      /* One step of a guide: where to look, what to do there, and whether the
         person's click on it is the answer. Only a locator travels, never a value. */
      if (!okSelector(b.selector)) return { error: "point needs a selector, or an id from an observation" };
      args.selector = b.selector;
      /* What the page is about, shown before the person acts (the agent writes
         it from a read of the page). Data, never markup; it ends on OK. */
      if (b.summary !== undefined) {
        if (typeof b.summary !== "string" || !b.summary.trim() || !sayHasWords(b.summary)) return { error: "summary is what the page is about, in words: a non-empty string" };
        if (b.summary.length > 2000) return { error: `summary is ${b.summary.length} characters; at most 2000 fit on a guide card. Shorten it` };
        if (b.waitClick === true || (b.wait !== undefined && b.wait !== "ok")) return { error: "a summary step ends on the person's OK, once they have read it: drop --wait-click / --wait-*" };
        args.summary = b.summary.trim();
      }
      const say = b.say === undefined && args.summary ? SUMMARY_SAY : b.say;
      if (typeof say !== "string" || !say.trim() || say.length > 2000) {
        return { error: "point needs say: what the person should do there (at most 2000 characters)" };
      }
      if (!sayHasWords(say)) return { error: `point: say ${SAY_NO_WORDS}` };
      args.say = say.trim();
      /* The exact words the person will paste, shown on the card with a Copy
         button. Data, never markup; the panel writes it to the clipboard only
         on the person's own click. Kept as given: a command's lines matter. */
      if (b.copy !== undefined) {
        if (typeof b.copy !== "string" || !b.copy.trim()) return { error: "copy is the text the person will paste: a non-empty string" };
        if (b.copy.length > 2000) return { error: `copy is ${b.copy.length} characters; at most 2000 fit on a guide card. Shorten it, or split it over two steps` };
        args.copy = b.copy;
      }
      /* A draft for a text field, which the card puts in the field only on the
         person's own click on "Use suggestion". Data, never markup; kept as
         given so its lines survive. The panel refuses a target that is not a
         text field. */
      if (b.suggest !== undefined) {
        if (typeof b.suggest !== "string" || !b.suggest.trim()) return { error: "suggest is the draft the person may put in the field: a non-empty string" };
        if (b.suggest.length > 2000) return { error: `suggest is ${b.suggest.length} characters; at most 2000 fit on a guide card. Shorten the draft` };
        args.suggest = b.suggest;
      }
      /* Several nodes match: the one whose text holds this label is pointed. */
      if (b.text !== undefined) {
        if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 200) return { error: "text is the label that picks one of several matches (at most 200 characters)" };
        args.text = b.text.trim();
      }
      if (b.waitClick !== undefined) {
        if (typeof b.waitClick !== "boolean") return { error: "waitClick is a flag" };
        args.waitClick = b.waitClick;
      }
      /* What ends the step: --wait-ok, --wait-click, --wait-nav, --wait-input, --wait-submit. */
      if (b.wait !== undefined) {
        if (!GUIDE_WAITS.includes(b.wait as GuideWait)) return { error: `wait is one of ${GUIDE_WAITS.join(", ")}` };
        if (b.waitClick !== undefined && (b.waitClick === true) !== (b.wait === "click")) return { error: "waitClick and wait disagree: send one" };
        args.wait = b.wait;
        args.waitClick = b.wait === "click";
      }
      /* What should be true after the person's click: `guide next` answers
         expected true|false by whether this CSS matches then. Read only. */
      if (b.expect !== undefined) {
        if (!okSelector(b.expect)) return { error: "expect is a CSS selector that should match after the click" };
        args.expect = b.expect;
      }
      if (b.step !== undefined) {
        if (typeof b.step !== "string" || !/^\d{1,3}\/\d{1,3}$/.test(b.step.trim())) return { error: "step is N/M, like 2/4" };
        const [n, m] = b.step.trim().split("/").map(Number);
        if (!n || !m || n > m) return { error: "step is N/M with 1 <= N <= M, like 2/4" };
        args.step = `${n}/${m}`;
      }
      break;
    }
    case "dialog": {
      /* Arms the answer to the next confirm/prompt of this page. With neither
         flag it only reports: what was asked last, and what is armed. */
      for (const k of ["accept", "dismiss", "always"] as const) {
        if (b[k] === undefined) continue;
        if (typeof b[k] !== "boolean") return { error: `${k} is a flag` };
        args[k] = b[k];
      }
      if (args.accept === true && args.dismiss === true) return { error: "dialog takes accept or dismiss, not both" };
      if (b.text !== undefined) {
        if (typeof b.text !== "string" || b.text.length > 2000) return { error: "text must be a string of at most 2000 characters" };
        if (args.dismiss === true) return { error: "text answers a prompt that is accepted; a dismissed one has none" };
        args.text = b.text;
        /* A text answers a prompt that is accepted: naming it arms an accept, not nothing. */
        if (args.accept !== true) args.accept = true;
      }
      if (args.always === true && args.accept !== true && args.dismiss !== true) return { error: "always needs accept or dismiss" };
      break;
    }
    case "region": {
      if (!okSelector(b.selector)) return { error: "region needs a selector, or an id from an observation" };
      args.selector = b.selector;
      break;
    }
    case "listeners": {
      if (typeof b.selector !== "string" || !b.selector.trim()) {
        return { error: "listeners needs a selector" };
      }
      args.selector = b.selector;
      break;
    }
    case "coverage": {
      const action = b.action === undefined ? "start" : b.action;
      if (action !== "start" && action !== "stop") {
        return { error: 'coverage takes action: "start" or "stop"' };
      }
      args.action = action;
      break;
    }
    case "screencast": {
      const action = b.action === undefined ? "start" : b.action;
      if (action !== "start" && action !== "frames" && action !== "stop") {
        return { error: 'screencast takes action: "start", "frames" or "stop"' };
      }
      args.action = action;
      /* The caps are the point: a screencast is the one verb that can fill
         the shell with pictures on its own, and each frame is a picture an
         agent pays for. Small by default, bounded always. */
      const num = (key: string, lo: number, hi: number, dflt: number): number | { error: string } => {
        if (b[key] === undefined) return dflt;
        const n = Number(b[key]);
        if (!Number.isInteger(n) || n < lo || n > hi) return { error: `${key} must be a whole number from ${lo} to ${hi}` };
        return n;
      };
      for (const [key, lo, hi, dflt] of [["quality", 1, 100, 60], ["maxWidth", 100, 4096, 1024], ["maxHeight", 100, 4096, 768], ["everyNth", 1, 60, 1]] as const) {
        const v = num(key, lo, hi, dflt);
        if (typeof v !== "number") return v;
        args[key] = v;
      }
      break;
    }
    case "inspect": {
      /*
       * THE INSPECTOR, which until now only a person could reach.
       *
       * `console` and `network` already answer as data, through CDP. Elements,
       * Sources, Performance, Memory and Application answer as nothing: there
       * is no protocol for "what does the Styles pane say", because that pane
       * is the DevTools front-end's own reading of the page. The pixels are the
       * only honest answer for those, which is why `shot` is here.
       *
       * A closed set of actions rather than a passthrough. `panel` runs script
       * in the front-end, and the only thing standing between that and running
       * anything is that the name is checked here and again in the shell.
       */
      const action = b.action === undefined ? "open" : b.action;
      const known = ["open", "close", "panel", "zoom", "shot"];
      if (typeof action !== "string" || !known.includes(action)) {
        return { error: `inspect takes action: ${known.join(", ")}` };
      }
      args.action = action;
      if (action === "panel") {
        /* The panel ids DevTools itself uses. Spelled out rather than passed
           through: this ends up inside `executeJavaScript` on the front-end. */
        if (typeof b.panel !== "string" || !/^[a-z0-9_-]{1,40}$/.test(b.panel)) {
          return { error: "panel needs a DevTools panel id — elements, console, sources, network, timeline, heap-profiler, resources, security, lighthouse" };
        }
        args.panel = b.panel;
      }
      if (action === "zoom") {
        /*
         * The LEVEL, the same unit Chromium uses and the same one the panel's
         * own +/− step through — not a percentage. 0 is 100%, each step is
         * about 20%, and the sign is what a reader gets wrong: NEGATIVE is
         * smaller. A capture that has to be readable usually wants a positive
         * level, which is why the CLI says so where somebody will read it.
         */
        if (typeof b.level !== "number" || !Number.isFinite(b.level)) {
          return { error: "zoom needs level: a number, 0 is 100% and each step is about 20% (negative is smaller)" };
        }
        args.level = b.level;
      }
      if (action === "shot" && b.path !== undefined) {
        if (typeof b.path !== "string" || !b.path.startsWith("/")) {
          return { error: "path must be an absolute path to write the png to" };
        }
        args.path = b.path;
      }
      break;
    }
    case "trace": {
      const action = b.action === undefined ? "start" : b.action;
      if (action !== "start" && action !== "stop") {
        return { error: 'trace takes action: "start" or "stop"' };
      }
      args.action = action;
      if (action === "stop") {
        if (typeof b.path !== "string" || !b.path.startsWith("/")) {
          return { error: "path must be an absolute path to save the trace to" };
        }
        args.path = b.path;
      }
      break;
    }
    case "profiles": {
      /*
       * A container per agent, made and thrown away by that agent.
       *
       * Two agents sharing one share a login, and the second to act changes
       * what the first is looking at — silently, because nothing about a
       * cookie says who set it. So an agent makes its OWN, names it after
       * itself and the task, and drops it when the work is done. A container
       * left behind is a login somebody did not mean to keep.
       */
      if (b.make !== undefined) {
        if (typeof b.make !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{1,39}$/.test(b.make)) {
          return { error: "make needs a name: letters, digits, spaces, dot, dash or underscore, 2 to 40 characters. Say which agent and which task it is for — `review-pr-540` beats `test`." };
        }
        args.make = b.make;
      }
      if (b.drop !== undefined) {
        if (typeof b.drop !== "string" || !b.drop.trim()) return { error: "drop needs the name of a container" };
        args.drop = b.drop;
      }
      if (args.make !== undefined && args.drop !== undefined) {
        return { error: "make or drop, not both" };
      }
      if (okIdentity(b.identity)) args.identity = b.identity;
      if (typeof b.tab === "string" && b.tab.trim()) args.tab = b.tab.trim().slice(0, 128);
      if (b.force === true || b.force === "true") args.force = true;
      if (typeof args.make === "string") {
        claim = { name: args.make, identity: typeof args.identity === "string" ? args.identity : null };
      }
      if (typeof args.drop === "string") {
        /*
         * §13(c). `--drop` REMOVES THE CONTAINER, clears its persisted
         * session, deletes every webview in it and closes every tab — with no
         * ownership check of any kind, because a profile record is `{id,
         * name}` and ownership was not modelled anywhere. That is how an agent
         * following the "drop yours when you are done" etiquette destroys a
         * live peer's work by name collision.
         *
         * Refused BEFORE the ask is built, so a refusal costs no round trip
         * and lands in the audit next to the allow-list refusals above, which
         * are the other two things this relay says no to.
         *
         * A container with no creator on record is UNKNOWN, not foreign: every
         * container that predates the ledger is in that state, and refusing
         * those would strand them. Unknown is allowed; the CLI prints the
         * warning that goes with it.
         *
         * WHAT THIS CATCHES, and it is worth being exact because the wording
         * used to promise more. The identity compared here is the one the
         * CALLER stated — derived from its session, or whatever it passed to
         * `--as`. Nothing authenticates it, and nothing could: every one of
         * these processes is the same user on the same machine, so a shell that
         * says `--as owner-aaa` IS owner-aaa as far as anything here can tell.
         *
         * This is a guard against COLLISION, which is the failure that actually
         * happens: two agents pick `review-pr-540`, one finishes and drops "its"
         * container, and the other loses a live session it was working in. It
         * is not a permission boundary and must not be described as one — the
         * refusal text says so in its own words, and so does the skill.
         */
        const rec = containerRecord(args.drop);
        const mine = typeof args.identity === "string" ? args.identity : null;
        if (rec?.creator && mine !== rec.creator && args.force !== true) {
          const when = new Date(rec.lastSeenMs).toISOString();
          const msg = `drop refused: "${args.drop}" was created by ${rec.creator}`
            + `${mine ? `, not by ${mine}` : ""} and was last used ${when}. `
            + "Dropping it closes every tab in it and clears its login. "
            + "This compares the name you gave, which anyone can give, so it catches a "
            + "collision rather than a stranger. "
            + "Call `profiles` to see who holds what, or pass `force` (`--force` on the CLI) if you really mean it.";
          recordAudit(op as BrowserOp, { drop: args.drop, identity: mine }, false, msg);
          return { error: msg };
        }
        /* The ledger entry is NOT cleared here. A `drop` the window refuses —
           "no container called X" — would otherwise have already erased who
           owned X, so a second, correct attempt would find the container
           unclaimed and destroy it. It is cleared on a SUCCESSFUL drop, in
           `composeDrop`. */
      }
      break;
    }
    case "whoami": {
      /*
       * §11. The pre-flight, in one call that touches no page: who this
       * identity is, whether it still holds a live tab, and which container
       * owns the pane that is actually on screen.
       *
       * The identity comes FROM THE CALLER and cannot come from anywhere else:
       * it is derived in the CLI's own process from its environment (project
       * stem + a tail of the session id), and this relay has never seen that
       * environment. So it is an assertion, and it is treated as one — what
       * the relay verifies is the half it can: whether the tab that identity
       * claims is still in the window's list. `tabLive: false` is exactly the
       * state REQ-2's refusal points at.
       */
      if (b.identity !== undefined) {
        if (!okIdentity(b.identity)) {
          return { error: "identity must be a short single-line name under 64 characters" };
        }
        args.identity = b.identity;
      }
      if (b.tab !== undefined) {
        if (typeof b.tab !== "string" || !b.tab.trim() || b.tab.length > 128) {
          return { error: "tab must be a tab id" };
        }
        args.tab = b.tab.trim();
      }
      break;
    }
    case "tabs":
    case "health":
      /* Nothing to validate — both are questions. */
      break;
    case "eval": {
      /*
       * ARBITRARY JAVASCRIPT, which the skill's own documentation used to
       * forbid: "Nothing here runs arbitrary JavaScript, by design."
       *
       * For an agent that is not a guardrail, it is half the browser
       * amputated — its words, and it is right. Without it there is no way to
       * reach the app's own runtime, and today somebody had to WRITE UNIT
       * TESTS to find out what a component was holding.
       *
       * The guardrail that matters is not "no JS", it is which origins the
       * browser may be pointed at and what is written down afterwards. That
       * is §16 of the spec and it is not built yet — so this is here, and the
       * fence it needs is named in the note beside it.
       */
      const js = typeof b.js === "string" ? b.js : "";
      if (!js.trim() || js.length > 20_000) return { error: "js must be a non-empty expression under 20k" };
      args.js = js;
      if (b.await !== undefined) args.await = b.await === true || b.await === "true";
      if (b.max !== undefined) {
        const n = Number(b.max);
        if (!Number.isInteger(n) || n < 100 || n > 200_000) return { error: "max must be 100..200000" };
        args.max = n;
      }
      /* How long the script gets before the call stops waiting for it (10 s
         when absent). Under the 45 s the relay itself waits for an eval, so
         the answer that names the timeout is the one that arrives. */
      if (b.timeoutMs !== undefined) {
        const n = Number(b.timeoutMs);
        if (!Number.isInteger(n) || n < 100 || n > 40_000) return { error: "timeoutMs must be 100..40000" };
        args.timeoutMs = n;
      }
      break;
    }
    case "addInitScript": {
      /* §4: JavaScript that runs before any of the page's OWN scripts, on
         every navigation — the thing `eval` cannot do, because `eval` only
         reaches a page already running. Registered by NAME so a caller can
         come back and change its mind: a second `addInitScript` with a name
         already in use REPLACES the one before it, rather than stacking two
         copies that both wrap the same thing. Torn down when the tab closes
         — there is no page left for it to run on. */
      if (!okName(b.name)) return { error: "name must be a JS identifier, at most 64 characters" };
      const js = typeof b.js === "string" ? b.js : "";
      if (!js.trim() || js.length > 20_000) return { error: "js must be a non-empty script under 20k" };
      args.name = b.name; args.js = js;
      break;
    }
    case "expose": {
      /* A function the page can call back into, by NAME. Its calls are not
         returned synchronously — there is no Node function on the other end
         here, only the shell — they are recorded and read back with
         `exposed`, the same shape `console`/`network` already use for
         "something happened on the page, come read it when you're ready". */
      if (!okName(b.name)) return { error: "name must be a JS identifier, at most 64 characters" };
      args.name = b.name;
      break;
    }
    case "exposed": {
      if (b.limit !== undefined) {
        const n = Number(b.limit);
        if (!Number.isInteger(n) || n < 1 || n > 500) return { error: "limit must be 1..500" };
        args.limit = n;
      }
      /* `sinceLast` is the diff §14 asks for as the other half of max-tokens.
         The cursor lives HERE rather than in the caller: a caller that has to
         carry it is a caller that will forget, and re-read the whole log every
         turn — which is the cost §14 is about. */
      if (b.sinceLast === true) {
        args.since = LAST_SEEN[String(op)] ?? 0;
        LAST_SEEN[String(op)] = Date.now();
      }
      if (b.since !== undefined) {
        const n = Number(b.since);
        if (!Number.isFinite(n) || n < 0) return { error: "since must be a timestamp" };
        args.since = n;
      }
      break;
    }
    case "select": {
      /* A real select for a native <select>. `click` then `press` is what an
         agent does without this, and it is fragile — the control that broke a
         reproduction today was exactly one of these. */
      if (!okSelector(b.selector)) return { error: "selector must be a short, single-line CSS selector" };
      const value = typeof b.value === "string" ? b.value : "";
      if (!value || value.length > 500) return { error: "value must be the option's value or its visible text" };
      args.selector = b.selector; args.value = value;
      break;
    }
    case "reload": {
      /* A HARD reload. With assets versioned by query string there is no way
         to force a new bundle otherwise, which is what blocked a verification
         today. */
      if (b.bypassCache !== undefined) args.bypassCache = b.bypassCache !== false;
      break;
    }
    case "cookies": {
      /* Read, or set one. Reusing the session the browser already has beats
         repeating a magic-link by hand — measured at forty minutes. */
      if (b.set !== undefined) {
        const c = b.set as Record<string, unknown>;
        if (!c || typeof c !== "object" || typeof c.name !== "string" || typeof c.value !== "string") {
          return { error: "set must be { name, value, domain?, path?, secure?, httpOnly?, sameSite?, expires?, partitionKey? }" };
        }
        if (c.secure !== undefined && typeof c.secure !== "boolean") {
          return { error: "secure must be a boolean" };
        }
        if (c.httpOnly !== undefined && typeof c.httpOnly !== "boolean") {
          return { error: "httpOnly must be a boolean" };
        }
        if (c.sameSite !== undefined && typeof c.sameSite !== "string") {
          return { error: "sameSite must be a string" };
        }
        args.set = c;
      }
      break;
    }
    case "frames":
      /* iframes and workers, so a page made of them stops being opaque. */
      break;
    case "observe":
    case "console":
    case "network": {
      /* A window into a buffer the page has been filling since it loaded.
         `limit` so a chatty page cannot answer with a megabyte, and `since`
         so a caller polling twice does not re-read what it already has. */
      if (b.limit !== undefined) {
        const n = Number(b.limit);
        if (!Number.isInteger(n) || n < 1 || n > 500) return { error: "limit must be 1..500" };
        args.limit = n;
      }
      if (b.since !== undefined) {
        const n = Number(b.since);
        if (!Number.isFinite(n) || n < 0) return { error: "since must be a timestamp" };
        args.since = n;
      }
      /* `observe` can bring the picture back in the same answer, which is the
         difference between one call and two for "show me what happened". */
      if (b.shot !== undefined) args.shot = b.shot === true || b.shot === "true";
      /* Only what changed since this caller's last observe of the same
         document. The baseline it is measured against is NOT read from the
         body: it is the relay's record of what it last handed this caller
         (`observeTracked`), because a caller asserting its own baseline can
         only be wrong in ways nothing here could see. */
      if (op === "observe" && (b.delta === true || b.delta === "true")) args.delta = true;
      /* A look at part of the page: the viewport, or the subtree of one
         element. Neither is a baseline (the page stores no snapshot for it), so
         neither can be a delta: a diff against a part would call the rest of
         the page removed. */
      if (op === "observe") {
        if (b.viewport === true || b.viewport === "true") args.viewport = true;
        if (b.root !== undefined) {
          if (typeof b.root !== "string" || !/^e[0-9]+$/.test(b.root)) return { error: "root must be an id from an observation, like e12" };
          args.root = b.root;
        }
        if (args.delta === true && (args.viewport === true || args.root !== undefined)) {
          return { error: "delta compares whole pages: leave out viewport and root, or leave out delta" };
        }
      }
      break;
    }
    case "resize": {
      /* A viewport of your own, so a modal cannot hide the column you came to
         look at and two captures of the same page are the same size. */
      const w = Number(b.width), h = Number(b.height);
      if (!Number.isInteger(w) || w < 320 || w > 4096) return { error: "width must be 320..4096" };
      if (!Number.isInteger(h) || h < 240 || h > 4096) return { error: "height must be 240..4096" };
      args.width = w; args.height = h;
      break;
    }
    case "zoom": {
      /*
       * A PAGE LAID OUT AS A SMALLER SCREEN WOULD LAY IT OUT.
       *
       * Asked for after an agent was told to match a page at 158% and could
       * only reach `document.documentElement.style.zoom`, which is a different
       * thing again: a CSS property that reflows the page, breaks layouts that
       * were never written for it, and MULTIPLIES with whatever the person has
       * set — so a screenshot taken that way is of a page nobody is looking at.
       *
       * NOT the same mechanism as the person's Ctrl+ and Ctrl-, and this
       * comment used to say it was. This is a device metrics override: it
       * narrows the layout VIEWPORT, and the pane keeps the box it always had,
       * so a page comes out laid out for a narrower window. That is what an
       * agent asking "show me this at phone width" wants, and it is precisely
       * NOT what a person leaning in wants — reported with four screenshots of
       * a page shrinking into the corner of its own pane. The person's zoom
       * now goes through `webContents.setZoomFactor` in the shell, which
       * scales the page inside the box; see `ag:browserZoom`.
       *
       * No argument reads it back, which is how an agent matches what is on
       * screen rather than guessing at it.
       */
      if (b.factor === undefined) break;
      const f = Number(b.factor);
      /* Chromium's own range. Outside it the call is ignored rather than
         refused, which would be a zoom that silently did not happen. */
      if (!Number.isFinite(f) || f < 0.25 || f > 5) return { error: "factor must be 0.25..5 (1 is 100%)" };
      args.factor = f;
      break;
    }
    case "html": {
      /* The markup of one element. Choosing a selector by reading a .vue file
         over curl is what this replaces. */
      if (!okSelector(b.selector)) return { error: "selector must be a short, single-line CSS selector" };
      args.selector = b.selector;
      if (b.max !== undefined) {
        const n = Number(b.max);
        if (!Number.isInteger(n) || n < 100 || n > 200_000) return { error: "max must be 100..200000" };
        args.max = n;
      }
      /* Markup a model can read: scripts, styles, svg paths and noise attributes out. */
      if (b.clean !== undefined) {
        if (typeof b.clean !== "boolean") return { error: "clean is a flag" };
        args.clean = b.clean;
      }
      break;
    }
    case "waitfor": {
      /* Wait on a CONDITION rather than on an element appearing: "until this
         text changes", "until the spinner is gone". The expression is
         evaluated in the page, which is the same trust boundary every other
         verb here already sits on. */
      /*
       * The two conditions everybody writes by hand, by name — §8 asks for
       * "network idle" and "no timers pending" as WAIT MODES, and both are
       * awkward to express from outside: the page is the only place that knows
       * how many requests are in flight, and the log cannot say, because it
       * records the ones that FINISHED.
       *
       * They compile to the same expression the verb already evaluates, so
       * there is one mechanism and two ways of naming it rather than two
       * mechanisms.
       */
      const UNTIL: Record<string, string> = {
        /* Quiet for 500ms, not merely zero right now: between two requests of
           a chain there is an instant where nothing is in flight, and a check
           that fires there reports a page as settled in the middle of loading
           — the exact false positive this is asked to avoid. */
        "network-idle": "(() => { const l = window.__agxLog; return !l || (l.inflight === 0 && Date.now() - l.lastSettled > 500); })()",
        /* Nothing scheduled to run soon. rAF resolves after the next paint, so
           this also means the page has drawn whatever it just changed. */
        "no-timers": "(() => new Promise((r) => requestAnimationFrame(() => setTimeout(() => r(true), 0))))()",
      };
      let js = typeof b.js === "string" ? b.js.trim() : "";
      if (b.until !== undefined) {
        const named = UNTIL[String(b.until)];
        if (!named) return { error: `until must be one of: ${Object.keys(UNTIL).join(", ")}` };
        if (js) return { error: "pass js or until, not both — each says on its own what to wait for" };
        js = named;
      }
      if (!js || js.length > 2000) return { error: "waitfor needs js, or until: network-idle | no-timers" };
      args.js = js;
      if (b.timeoutMs !== undefined) {
        const n = Number(b.timeoutMs);
        if (!Number.isInteger(n) || n < 100 || n > 120_000) return { error: "timeoutMs must be 100..120000" };
        args.timeoutMs = n;
      }
      break;
    }
    case "tab":
    case "closetab": {
      /* By INDEX or by id, and index is what a listing gives you. A caller
         that read `tabs` has both; one that guessed has neither, and an
         unknown id is refused by the panel rather than silently acting on
         whatever happens to be first. */
      const hasIndex = typeof b.index === "number" && Number.isInteger(b.index) && b.index >= 0 && b.index < 200;
      const hasId = typeof b.id === "string" && b.id.length > 0 && b.id.length < 200;
      if (!hasIndex && !hasId) return { error: "pass index (from `tabs`) or id" };
      if (hasIndex) args.index = b.index;
      if (hasId) args.id = b.id;
      break;
    }
    case "click":
    case "wait":
    case "dblclick":
    case "rightclick":
    case "hover":
    case "focus":
    case "blur": {
      if (!okSelector(b.selector)) return { error: "selector must be a short, single-line CSS selector" };
      args.selector = b.selector;
      break;
    }
    case "check": {
      /* A checkbox or radio, set THROUGH the actionability gate rather than
         `click` on a guess that the target really is one — `check --off` is
         what unchecking looks like, since `click` toggles blind. */
      if (!okSelector(b.selector)) return { error: "selector must be a short, single-line CSS selector" };
      args.selector = b.selector;
      args.checked = b.checked !== false;
      break;
    }
    case "fill": {
      /* A whole form in one call — §3's other ask. Each value goes through the
         same native-setter path `type` uses, one selector at a time, so a
         partial failure says which field rather than leaving the caller to
         guess which of N calls was the one that didn't take. */
      const fields = b.fields as Record<string, unknown>;
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        return { error: "fields must be an object of selector -> text" };
      }
      const entries = Object.entries(fields);
      if (entries.length === 0 || entries.length > 50) return { error: "fields must have 1..50 entries" };
      const clean: Record<string, string> = {};
      for (const [selector, value] of entries) {
        if (!okSelector(selector)) return { error: `selector must be a short, single-line CSS selector: ${selector}` };
        if (typeof value !== "string" || value.length > 10_000) return { error: `value for ${selector} must be a string` };
        clean[selector] = value;
      }
      args.fields = clean;
      break;
    }
    case "type": {
      if (!okSelector(b.selector)) return { error: "selector must be a short, single-line CSS selector" };
      if (typeof b.text !== "string" || b.text.length > 10_000) return { error: "text must be a string" };
      args.selector = b.selector;
      args.text = b.text;
      args.submit = b.submit === true;
      break;
    }
    case "text": {
      if (!okSelector(b.selector)) return { error: "selector must be a short, single-line CSS selector" };
      args.selector = b.selector;
      break;
    }
    case "scroll": {
      // Exactly one of the three, because "scroll down AND to this element" has
      // no single answer and picking one silently is how an agent ends up
      // describing a part of the page it never reached.
      const given = [b.selector !== undefined, b.by !== undefined, b.to !== undefined].filter(Boolean).length;
      if (given !== 1) return { error: "scroll takes exactly one of: selector, by (pixels), to (top|bottom)" };
      if (b.selector !== undefined) {
        if (!okSelector(b.selector)) return { error: "selector must be a short, single-line CSS selector" };
        args.selector = b.selector;
      } else if (b.by !== undefined) {
        const by = typeof b.by === "number" ? b.by : Number(b.by);
        // Capped rather than unbounded: a page cannot be scrolled by a number
        // it cannot hold, and an agent that meant 500 and typed 5e9 should be
        // told, not obeyed.
        if (!Number.isFinite(by) || Math.abs(by) > 1_000_000) return { error: "by must be a number of pixels" };
        args.by = by;
      } else {
        if (b.to !== "top" && b.to !== "bottom") return { error: "to must be top or bottom" };
        args.to = b.to;
      }
      break;
    }
    case "press": {
      if (typeof b.key !== "string" || !KEYS.includes(b.key)) {
        return { error: `key must be one of: ${KEYS.join(", ")}` };
      }
      args.key = b.key;
      break;
    }
    case "shot": {
      /* The inspector beside the page. A flag and nothing else — where the
         picture comes from and how it is joined is the renderer's problem. */
      if (b.withInspector !== undefined) {
        if (typeof b.withInspector !== "boolean") return { error: "withInspector is a flag" };
        args.withInspector = b.withInspector;
      }
      /* Three ways to say what the picture should CONTAIN — the house rule on
         evidence is that a capture which does not show the number it claims to
         show is worthless, so cropping is not an afterthought done to the file
         with ImageMagick, it is an argument to the verb itself. Only one at a
         time: each already answers "what's in the frame" on its own, and a
         caller passing two is more likely confused than layering them. */
      /* `fullPage` is GONE, and refused by name rather than ignored: a caller
         that passes it and gets a viewport shot back would think it had the
         whole page. `captureBeyondViewport` repaints every `position: fixed`
         element once per strip, so a page with a sticky header came back with
         the navigation bar duplicated down the middle — four attempts at
         correcting that failed, and a picture that repeats content is evidence
         that is simply wrong.

         The replacement is better than what it replaces: make the viewport
         bigger with `resize` or `emulate` and take an ordinary shot. It is
         correct at any size and the caller chooses the framing. */
      if (b.fullPage !== undefined) {
        return { error: "fullPage is gone — it repeated any sticky header once per screen. Make the viewport bigger with `resize` or `emulate` and take an ordinary shot: correct at any size, and you choose the framing." };
      }
      const modes = ["selector", "clip"].filter((k) => b[k] !== undefined);
      if (modes.length > 1) return { error: `selector and clip each choose what the picture contains — pass only one (got ${modes.join(", ")})` };
      if (b.selector !== undefined) {
        if (!okSelector(b.selector)) return { error: "selector must be a short, single-line CSS selector" };
        args.selector = b.selector;
      }
      if (b.clip !== undefined) {
        const c = (b.clip && typeof b.clip === "object" ? b.clip : {}) as Record<string, unknown>;
        const x = Number(c.x), y = Number(c.y), w = Number(c.width), h = Number(c.height);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return { error: "clip.x and clip.y must be 0 or more" };
        // Tall enough for a real long page (§14's full-page shot), not so tall
        // that a typo turns into a request Chromium will spend a minute on.
        if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 20_000 || h > 20_000) {
          return { error: "clip.width and clip.height must be whole numbers, 1..20000" };
        }
        args.clip = { x, y, width: w, height: h };
      }
      /* NO `scale`. It shipped for an hour and produced four copies of the
         same page in one PNG — a rectangle bigger than the viewport is filled
         by repeating the page, however the magnification is asked for. Refused
         by name so a caller who read an older doc gets told, rather than
         getting a duplicated picture they cannot see is wrong. */
      if (b.scale !== undefined) {
        return { error: "scale is gone — it tiled the page into copies of itself. A shot is already one pixel per css pixel, which is exactly what the page lays out." };
      }
      /* `--highlight e17 --label "still Online"` — a box and a caption drawn
         ON the image, so proof points at the thing it proves instead of
         needing a second tool and a second step afterwards. Independent of the
         three modes above: a highlight can sit inside a selector crop, a clip,
         a full page, or a plain viewport shot. */
      if (b.highlight !== undefined) {
        if (!okSelector(b.highlight)) return { error: "highlight must be a short, single-line CSS selector" };
        args.highlight = b.highlight;
      }
      if (b.label !== undefined) {
        if (b.highlight === undefined) return { error: "label needs --highlight — it captions the box, not the whole picture" };
        const label = typeof b.label === "string" ? b.label : "";
        if (!label || label.length > 200 || /[\r\n]/.test(label)) return { error: "label must be a short, single-line caption under 200 chars" };
        args.label = label;
      }
      /* Numbered `eN` labels on everything interactive in view (set-of-mark). */
      if (b.marks !== undefined) {
        if (typeof b.marks !== "boolean") return { error: "marks is a flag" };
        args.marks = b.marks;
      }
      if (b.omitBackground !== undefined) {
        args.omitBackground = b.omitBackground === true || b.omitBackground === "true";
      }
      break;
    }
    case "read":
    case "markdown":
    case "links":
    case "interactive":
    case "forms":
    case "back":
    case "forward":
    case "done":
      break;
    case "tools":
      break;
    case "call-tool": {
      /* The name is what the page called the tool, so it is held to what a
         name can plausibly be; the args are the caller's and go to the page as
         JSON, bounded so one call cannot ship a document. */
      if (typeof b.name !== "string" || !b.name || b.name.length > 100 || /[\r\n]/.test(b.name)) {
        return { error: "call-tool needs the tool's name: one line, up to 100 characters (`tools` lists them)" };
      }
      args.name = b.name;
      const given = b.args === undefined ? {} : b.args;
      if (!given || typeof given !== "object" || Array.isArray(given)) return { error: "args must be a JSON object" };
      if (JSON.stringify(given).length > 20_000) return { error: "args are over 20 KB" };
      args.args = given;
      break;
    }
    case "attr": {
      /* One element, some of its attributes. The names become page JS, so
         they are held to what an attribute name can be; the count is capped
         for the same reason `extract` caps its fields. */
      if (!okSelector(b.selector)) return { error: "attr needs a selector, or an id from an observation" };
      args.selector = b.selector;
      if (b.names !== undefined) {
        if (!Array.isArray(b.names) || b.names.length > 20) return { error: "names must be a list of up to 20 attribute names" };
        for (const n of b.names) {
          if (typeof n !== "string" || !/^[A-Za-z_:][\w:.-]{0,63}$/.test(n)) return { error: `${String(n)} is not an attribute name` };
        }
        args.names = b.names;
      }
      break;
    }
    case "extract": {
      /* A field→selector map, validated here on purpose: the values become
         page JS (via `jsLit` on the other side of the wire), so a value that
         is not a selector or a name that is not a clean key is refused rather
         than pasted. The count is capped so one ask cannot mine a whole page
         into an agent's context field by field. */
      if (typeof b.fields !== "object" || b.fields === null || Array.isArray(b.fields)) {
        return { error: "extract needs a fields object: { name: selector, ... }" };
      }
      const entries = Object.entries(b.fields as Record<string, unknown>);
      if (entries.length === 0) return { error: "extract needs at least one field: { name: selector }" };
      if (entries.length > 30) return { error: "extract caps at 30 fields in one call" };
      const fields: Record<string, string> = {};
      for (const [name, sel] of entries) {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
          return { error: `field ${name}: name must be letters, digits, . _ - up to 64 chars` };
        }
        if (!okSelector(sel)) return { error: `field ${name}: selector must be a short, single-line CSS selector` };
        fields[name] = sel;
      }
      args.fields = fields;
      break;
    }
    case "count": {
      if (b.selector !== undefined) {
        if (!okSelector(b.selector)) return { error: "selector must be a short, single-line CSS selector" };
        args.selector = b.selector;
      }
      break;
    }
    case "search": {
      /* A bare text search, not a selector: the longest thing a caller should
         mean by "search" is a short phrase. A paste is a search engine's job. */
      const q = typeof b.query === "string" ? b.query.trim() : "";
      if (!q || q.length > 200 || /[\r\n]/.test(q)) {
        return { error: "query must be a phrase up to 200 chars, on one line" };
      }
      args.query = q;
      break;
    }
  }
  /* §9: `--page` addresses a specific tab instead of the active one. Tab
     operations work on the tab list itself rather than a page inside a tab, so
     they do not accept this parameter. Same for health, which is a yes/no
     about whether anything can answer at all. */
  /* `whoami` and `profiles` are §11's pre-flight: they are about the LIST of
     containers and who holds the visible pane, never about a page inside a
     tab, so `--page` on them is a caller that has misunderstood the verb. */
  const pageOps = new Set(["tabs", "tab", "newtab", "closetab", "profiles", "whoami", "health"]);
  /* `settings` is NO LONGER among them — it was, and that was the defect §14
     closed: an agent could not point a settings change at its own tab, so
     `--ignore-cert-errors true` turned certificate validation off on whoever's
     page happened to be in front. The one thing to step around is the legacy
     spelling of its internal page, which the case above has already read. */
  const legacyInternalPage = op === "settings" && b.internalPage === undefined && b.page === "blank";
  if (!pageOps.has(op as string) && !legacyInternalPage) {
    if (b.page !== undefined) {
      if (typeof b.page !== "string" || !b.page.trim() || b.page.length > 128) {
        return { error: "page must be a tab id" };
      }
      args.page = b.page.trim();
    }
  }
  /*
   * WHO IS ASKING — on every op, not just the two that mint a container.
   *
   * `profile` says which cookie jar to OPEN a tab in, and it was the only
   * caller-shaped field on the wire. So the panel, resolving a bare `read` to
   * "the tab in front", had nothing to compare it against: an ask carries an
   * op and its arguments and, until this line, nothing at all about who sent
   * it. That is the whole reason the incident was invisible from inside —
   * every party was behaving correctly against a protocol that could not
   * express the question.
   *
   * Unverifiable is NOT a mismatch. The MCP surface and any hand-written
   * client send no identity, and `--shared` deliberately sends none either;
   * both must keep working, so an absent `as` means "cannot tell" and the
   * panel allows it. The nameless-caller hole is closed at the CLI (its
   * `addressed()`) and at the MCP surface, not here.
   */
  if (b.as !== undefined) {
    if (typeof b.as !== "string" || !b.as.trim() || b.as.length > 128) {
      return { error: "as must be the caller's container name" };
    }
    const who = b.as.trim();
    args.as = who;
    /*
     * AND WHICH KIND OF VERB THIS IS, said once, here.
     *
     * The panel writes the refusal and needs a different prefix for a read
     * than for a write — a read can be retried mechanically with `--page`,
     * a write is worth a human's attention. It cannot import `OBSERVE_OPS`:
     * nothing under web/ imports from server/ (checked: zero matches), so the
     * alternative was a second copy of an eighteen-verb list in the panel,
     * which is the drift this file already warns about beside `isActing`.
     * Only stamped alongside `as`, so an ordinary call's audit line and wire
     * shape are exactly what they were.
     */
    args.acts = isActing(op as BrowserOp, args);
    /* And whether this ask is aimed at a page inside a tab at all. `tabs`,
       `newtab`, `profiles` and the rest work on the LIST, so "which container
       is the tab in front in" is not a question about them — running the
       ownership check over `newtab --as A` would refuse an agent for the crime
       of asking for its own tab while somebody else's was up. Same set the
       `page` parameter is refused for, three lines above, read once.

       AND AN `open` THAT NAMES A CONTAINER IS ONE OF THEM. It mints its own
       tab — the panel routes exactly this shape to the tab verbs, on exactly
       this condition — so it is not about the tab in front either. Without
       this line, an identity with no tab yet is refused for trying to get one,
       which is a refusal nobody can answer; the same trap cost the CLI's own
       identity fix a first version, and the way it gets worked around is
       `--shared` on everything, which is this hole reopened by hand. */
    args.pageBound = !pageOps.has(op as string)
      && !(op === "open" && typeof args.profile === "string");
    /*
     * `tab <id>` IS THE OPERATOR NAMING A TAB, and the panel has to keep
     * treating it that way afterwards.
     *
     * The CLI rebinds ownership on `tab <id>` — after it, `my-tabs.json` maps
     * the caller to that tab and every later verb ships the id INJECTED. So
     * without this, the sequence that was the measured fix for "`tab A; shot`
     * returned B's picture" becomes a sequence where every verb after the
     * switch is refused as a cross-container act. Recorded here rather than in
     * the CLI because the same trap catches the MCP surface, which has its own
     * remembered tab and no way to set `pageExplicit`.
     */
    if (op === "tab" && typeof args.id === "string") rememberNamedTab(who, args.id);
  }
  /*
   * The operator TYPED `--page`, as opposed to the CLI filling it in.
   *
   * These are the same field on the wire and mean opposite things: an injected
   * page is "route me to my own tab", a typed one is "I mean somebody else's,
   * on purpose". Without the distinction the cross-container check has no
   * exemption it can honour, because every acting verb arrives carrying a page.
   */
  if (b.pageExplicit === true && typeof args.page === "string") args.pageExplicit = true;
  /* The caller will not see this observation whole (the CLI trims it, or
     prints one line of it): it must not become the baseline of a delta. */
  if (b.partial === true) args.partial = true;
  /* Or the caller named that exact tab with `tab <id>` earlier, which is the
     same statement made one call sooner. */
  if (typeof args.page === "string" && typeof args.as === "string"
      && namedTabOf(args.as) === args.page) {
    args.pageExplicit = true;
  }
  /* And HOW it was addressed, which the panel has no use for but the audit
     does: `--page t7` and the CLI stamping the identity's own t7 arrive as the
     same field, and only the caller can tell them apart. `recordAudit` lifts
     both straight back off, so the recorded args stay the verb's own. */
  if (caller.as && args.as === undefined) args.as = caller.as;
  if (caller.how) args.how = caller.how;
  if ((op === "tools" || op === "call-tool") && !webmcpOn()) {
    const msg = `"${op}" is off: set AGENTGLASS_BROWSER_WEBMCP=1 on the server to read and run the tools a page offers. The DOM verbs (interactive, click, fill) work without it.`;
    recordAudit(op as BrowserOp, args, false, msg, false, undefined, caller);
    return { error: msg };
  }
  if (readonlyMode() && isActing(op as BrowserOp, args)) {
    const msg = `read-only mode: "${op}" acts on the page and is refused (observing only: ${[...OBSERVE_OPS].join(", ")})`;
    recordAudit(op as BrowserOp, args, false, msg, false, undefined, caller);
    return { error: msg };
  }
  /* Guide mode's lock: an act on a tab the person is being guided through is
     refused for everyone, whatever read-only mode says. See browserGuide.ts.
     It reads the handoff's list of open verbs (shared/browserHandoff.ts): what
     may run on a tab handed to the person may run on a guided one, plus the
     guide's own verbs, which the guide checks by name below. Anything else,
     a new verb included, is an act. */
  {
    const target = typeof args.page === "string" ? args.page
      : (op === "tab" || op === "closetab") && typeof args.id === "string" ? args.id : undefined;
    /* `tab <id>` only brings that tab to the front: switching TO a guided tab
       shows the person the page they are being guided through, and acts on
       nothing. Closing it is still an act. */
    const acting = op !== "guide" && op !== "point" && !(op === "tab" && target !== undefined)
      && (ACT_VERB_SET.has(op as string) || !HANDOFF_OPEN_VERBS.has(op as string) || isActing(op as BrowserOp, args));
    /* Same "aimed at the tab in front" test as `pageBound` above: an `open`
       that names a container mints a tab of its own, and a lane's ask goes to
       the lane's hidden tab, so neither can land on the guided page. `lane`
       itself (new, list, close, vault, `vault --list`) works on the lane list
       and the lanes' own hidden tabs, never on a tab of the person's, so a
       guide on one tab must not refuse it. */
    const aimedInFront = !pageOps.has(op as string) && args.lane === undefined && op !== "lane"
      && !(op === "open" && typeof args.profile === "string");
    const why = guideLock(op as string, acting, target, aimedInFront, caller.as);
    if (why) {
      recordAudit(op as BrowserOp, args, false, why, false, undefined, caller);
      return { error: why };
    }
  }
  if (claim) noteContainer(claim.name, claim.identity);
  return { ask: { id: nextId(), op: op as BrowserOp, args } };
}

/**
 * Ask the window, and wait for its answer.
 *
 * The "no window" case is checked before parking anything: a request that will
 * never be answered should fail in milliseconds with a sentence somebody can
 * act on, not time out. It is also the commonest failure by far — an agent
 * driving a browser in an app nobody has opened.
 */
/*
 * WHY THERE IS NO PERSISTENT DUPLEX TRANSPORT, measured rather than argued.
 *
 * §1 asks for a socket that stays open, and it is the first item on the list
 * by return. Before building it, the two costs it would remove were measured
 * on this machine:
 *
 *     starting the CLI process   68.7 ms
 *     one HTTP call inside it    11.0 ms
 *
 * A persistent transport removes the second one and not the first — an agent
 * runs one process per verb, so it pays the 68.7 ms whatever the transport is.
 * `do` removes the first, for every verb after the first in a batch: six verbs
 * went from 618 ms to 94 ms, which is 86% of what was there to take.
 *
 * What would remain is 11 ms per verb, for a caller that keeps a process
 * alive, in exchange for a daemon, a reconnect story, and a second code path
 * for every verb. That is not worth it today. If an agent ever holds a process
 * open across many verbs, the number changes and so should this decision — the
 * measurement is here so it can be re-taken rather than re-argued.
 */

/**
 * Several verbs, one call — spec §1.
 *
 * MEASURED, which is the only reason this shape and not another: starting the
 * CLI process costs 104 ms before it has said a word, and the round trip to
 * the panel is on top of that. The interaction the spec describes — click,
 * wait for the network to go quiet, look at what changed — is three of those,
 * and a real repro is six or more. That is most of a second spent on process
 * startup, per interaction, all day.
 *
 * The steps run in order and stop at the first failure, because a sequence is
 * a sequence: `type` into a field that `click` never opened is not a second
 * result, it is noise on top of the first error. The failed step keeps its own
 * §15 diagnosis, so the answer to "why did this stop" arrives with it rather
 * than needing another call — which would put back exactly what this removes.
 *
 * EVERY STEP GOES THROUGH `parseAsk`, and that is not an implementation
 * detail: the origin allow-list and read-only mode from §16 live in there. A
 * batch verb that validated once and then ran freely would be a way to ask the
 * browser for things the guardrails refuse — the guardrail would still be
 * there, and there would be a door beside it.
 */
/**
 * WAIT for something to happen, instead of asking twenty times — spec §1.
 *
 * The complaint the spec opens with is a shell loop: `for i in $(seq 1 20); do
 * ... done`. Every turn of that loop is a process start (104ms measured), an
 * HTTP round trip, and — the part that actually costs — another answer parked
 * in the agent's context for the rest of the session, which §14 measures at
 * 82.7% of what an agent spends.
 *
 * A true duplex transport would have the browser push. Short of rebuilding
 * the transport, this moves the polling to the side where it is nearly free:
 * the server already holds the connection to the panel, so it can ask every
 * 250ms for as long as the caller is willing to wait and answer the moment
 * something is there. One call, one answer, one entry in the context — and
 * from where the agent stands it is indistinguishable from being pushed to.
 *
 * It answers with an empty list rather than an error when the wait runs out.
 * "Nothing happened in 30 seconds" is an ANSWER — often the answer being
 * looked for — and dressing it as a failure would send a caller retrying
 * something that worked.
 */
/**
 * N frames at an interval, and a GIF if one is wanted — spec §12.
 *
 * "Video, and N-frame capture at an interval, straight to a GIF. It is exactly
 * what gets assembled by hand with ffmpeg/convert today." The assembling is
 * the small half; the expensive half is that every frame is a separate CLI
 * call, so ten frames at half a second apart is ten process starts, ten round
 * trips and ten base64 images in the agent's context — for a thing whose whole
 * output is one file.
 *
 * So the loop runs here and the frames go to DISK, not into the answer. What
 * comes back is a list of paths and, when asked, one GIF. §14 in one sentence:
 * never return a payload when a path will do.
 *
 * The interval is honoured from the START of each frame rather than after it,
 * so a slow capture does not stretch the timeline — a recording meant to show
 * a thirty-second timer has to still be about thirty seconds when it is played
 * back.
 */
export async function recordFrames(p: {
  frames: number;
  everyMs: number;
  dir: string;
  gif?: string;
  shotArgs: Record<string, unknown>;
}): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  try {
    mkdirSync(p.dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `could not make ${p.dir}: ${e instanceof Error ? e.message : e}` };
  }
  const paths: string[] = [];
  for (let i = 0; i < p.frames; i++) {
    const due = Date.now() + p.everyMs;
    const parsed = parseAsk("shot", p.shotArgs);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    const r = await askBrowser(parsed.ask);
    if (!r.ok) {
      /* Stop at the first failure, and keep what was captured: half a
         recording is evidence of what happened up to the moment it broke, and
         throwing it away leaves the caller with the failure and nothing else. */
      return { ok: false, error: `frame ${i + 1} of ${p.frames}: ${r.error}`, value: { frames: paths } };
    }
    const png = String((r.value as { png?: string } | undefined)?.png ?? "");
    const b64 = png.includes(",") ? png.slice(png.indexOf(",") + 1) : "";
    if (!b64) return { ok: false, error: `frame ${i + 1} came back empty`, value: { frames: paths } };
    const at = join(p.dir, `frame-${String(i + 1).padStart(3, "0")}.png`);
    writeFileSync(at, Buffer.from(b64, "base64"));
    paths.push(at);
    if (i < p.frames - 1) {
      const left = due - Date.now();
      if (left > 0) await new Promise((r2) => setTimeout(r2, left));
    }
  }
  let gif: string | undefined;
  let gifWhy: string | undefined;
  if (p.gif) {
    /* Whichever of the two is installed, and an honest sentence when neither
       is: the frames are on disk either way, so a missing tool costs the GIF
       and not the recording. */
    const delay = Math.max(2, Math.round(p.everyMs / 10)); // ImageMagick counts in 1/100s
    const tries: Array<[string, string[]]> = [
      ["convert", ["-delay", String(delay), "-loop", "0", ...paths, p.gif]],
      ["ffmpeg", ["-y", "-framerate", String(Math.max(1, Math.round(1000 / p.everyMs))),
        "-i", join(p.dir, "frame-%03d.png"), p.gif]],
    ];
    for (const [bin, argv] of tries) {
      try {
        const proc = Bun.spawn([bin, ...argv], { stdout: "ignore", stderr: "ignore" });
        if (await proc.exited === 0 && existsSync(p.gif)) { gif = p.gif; break; }
      } catch { /* not installed — try the next one */ }
    }
    if (!gif) gifWhy = "neither convert nor ffmpeg could make it — the frames are still on disk";
  }
  return { ok: true, value: { frames: paths, count: paths.length, gif, gifWhy, dir: p.dir } };
}

/**
 * DevTools trace recording — spec §12.
 *
 * "Record DOM, network and console against one timeline" is the whole ask.
 * The trace data is collected via CDP's Tracing protocol on the window side
 * and saved to disk here, returning the path rather than the data.
 */
/**
 * Stop a trace and write it where the caller asked.
 *
 * THIS USED TO BE A `mkdir` AND A RETURNED PATH. It made the parent directory,
 * answered `{"path": "/…/trace.json"}`, and never asked the browser for
 * anything at all — the comment at its call site even said "the window will
 * have already collected and saved the trace data", about work nothing did.
 * Measured: `trace start`, a busy loop, `trace stop /tmp/x.json` → the answer
 * named the file and `ls` could not find it.
 *
 * What a trace actually needs: `Tracing.end`, then the `Tracing.tracingComplete`
 * event, which carries a STREAM handle (the recording is started with
 * `transferMode: "ReturnAsStream"` for this), then `IO.read` until eof. The
 * stream is closed whether or not the write works — a handle left open holds
 * the whole trace in the browser's memory.
 */
export async function traceRecording(p: {
  path: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  try {
    mkdirSync(dirname(p.path), { recursive: true });
  } catch (e) {
    return { ok: false, error: `could not make directory for ${p.path}: ${e instanceof Error ? e.message : e}` };
  }

  const cdp = async (method: string, params?: unknown) => {
    /* `events: true` is the drain and takes no method — see the `cdp` case. */
    const body = method === "" ? { events: true } : params === undefined ? { method } : { method, params };
    const parsed = parseAsk("cdp", body);
    if ("error" in parsed) return { ok: false, error: parsed.error, value: undefined as unknown };
    const r = await askBrowser(parsed.ask);
    return { ok: r.ok, error: r.error, value: r.value };
  };

  const ended = await cdp("Tracing.end");
  if (!ended.ok) return { ok: false, error: `could not end the trace: ${ended.error || "the browser refused"}` };

  /* The handle arrives on an event, so the buffer is drained until it shows up
     or the clock runs out. Draining is destructive for every other reader, so
     anything that is not ours is not consumed silently — it is simply not what
     we are looking for, and the cap is the shell's business. */
  const deadline = Date.now() + (p.timeoutMs ?? 60_000);
  let handle = "";
  for (;;) {
    const drain = await cdp("");
    const events = (drain.value as { events?: Array<{ method: string; params: Record<string, unknown> }> } | undefined)?.events ?? [];
    for (const e of events) {
      if (e.method === "Tracing.tracingComplete") handle = String(e.params?.stream ?? "");
    }
    if (handle) break;
    if (Date.now() >= deadline) {
      return { ok: false, error: `the trace did not finish within ${p.timeoutMs ?? 60_000}ms — nothing was written to ${p.path}` };
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  const chunks: string[] = [];
  try {
    for (;;) {
      const r = await cdp("IO.read", { handle, size: 1 << 20 });
      if (!r.ok) return { ok: false, error: `could not read the trace back: ${r.error || "the browser refused"}` };
      const got = (r.value as { result?: { data?: string; eof?: boolean; base64Encoded?: boolean } } | undefined)?.result;
      const data = String(got?.data ?? "");
      chunks.push(got?.base64Encoded ? Buffer.from(data, "base64").toString("utf8") : data);
      if (got?.eof) break;
      if (Date.now() >= deadline) {
        return { ok: false, error: `the trace was still arriving after ${p.timeoutMs ?? 60_000}ms — nothing was written to ${p.path}` };
      }
    }
  } finally {
    /* Always, including on the error paths above: an open handle holds the
       whole trace in the browser's memory for as long as the tab lives. */
    await cdp("IO.close", { handle }).catch(() => ({ ok: false }));
  }

  const text = chunks.join("");
  if (!text) return { ok: false, error: `the trace came back empty — nothing was written to ${p.path}` };
  try {
    writeFileSync(p.path, text);
  } catch (e) {
    return { ok: false, error: `could not write ${p.path}: ${e instanceof Error ? e.message : e}` };
  }
  return { ok: true, value: { path: p.path, bytes: Buffer.byteLength(text) } };
}

/**
 * A download, followed to the file it left on disk — spec §11.
 *
 * "Return the resulting local path, do not just let it vanish into a
 * directory" is the whole ask. Chromium already reports every step of a
 * download over CDP (`Page.downloadWillBegin` names the file before a byte
 * arrives, `Page.downloadProgress` says when it is done) — the same relay
 * §5 built for DevTools generally and §12 built the event buffer for. So
 * this is not a new subsystem, it is `cdp` and `click` run in the sequence a
 * download needs, with the directory it lands in pointed at from here.
 *
 * `dir` is asked for fresh, never reused across calls: Chromium appends
 * " (1)" to a colliding name, and guessing whether that happened is exactly
 * the ambiguity a returned path is supposed to remove. A caller wanting several
 * downloads calls this once per file, each with its own directory.
 */
export async function downloadFile(p: {
  selector: string;
  dir: string;
  timeoutMs?: number;
  /** Who is asking and which tab: `page`, `as`, `how`, `pageExplicit`, as the
   *  `record` route forwards them. Absent means the active tab. */
  via?: Record<string, unknown>;
}): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const { mkdirSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  try {
    mkdirSync(p.dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `could not make ${p.dir}: ${e instanceof Error ? e.message : e}` };
  }

  // Every ask carries the tab: arming one tab and clicking in another is a
  // download that never arrives, or one that lands in the wrong place.
  const at = (body: Record<string, unknown>) => ({ ...body, ...p.via });
  const behavior = parseAsk("cdp", at({
    method: "Browser.setDownloadBehavior",
    params: { behavior: "allow", downloadPath: p.dir, eventsEnabled: true },
  }));
  if ("error" in behavior) return { ok: false, error: behavior.error };
  const behaviorReply = await askBrowser(behavior.ask);
  if (!behaviorReply.ok) return { ok: false, error: `could not arm the download: ${behaviorReply.error}` };

  // Armed for this one click. A click that fails or a wait that runs out must
  // not leave the tab armed for whatever the page downloads next.
  try {
    const clickParsed = parseAsk("click", at({ selector: p.selector }));
    if ("error" in clickParsed) return { ok: false, error: clickParsed.error };
    const clickReply = await askBrowser(clickParsed.ask);
    if (!clickReply.ok) {
      return { ok: false, error: `could not click ${p.selector} to start the download: ${clickReply.error}` };
    }

    const deadline = Date.now() + (p.timeoutMs ?? 60_000);
    let guid: string | undefined;
    let filename: string | undefined;
    for (;;) {
      const drain = parseAsk("cdp", at({ events: true }));
      if (!("error" in drain)) {
        const r = await askBrowser(drain.ask);
        const events = (r.value as { events?: Array<{ method: string; params: Record<string, unknown> }> } | undefined)?.events ?? [];
        for (const e of events) {
          if (e.method === "Page.downloadWillBegin" && (!guid || e.params.guid === guid)) {
            guid = String(e.params.guid ?? guid ?? "");
            filename = String(e.params.suggestedFilename ?? filename ?? "");
          }
          if (e.method === "Page.downloadProgress" && (!guid || e.params.guid === guid)) {
            const state = String(e.params.state ?? "");
            if (state === "canceled") return { ok: false, error: "the download was canceled" };
            if (state === "completed") {
              if (!filename) return { ok: false, error: "the download finished but named no file" };
              const at = join(p.dir, filename);
              if (!existsSync(at)) return { ok: false, error: `the download reported complete but ${at} is missing` };
              return { ok: true, value: { path: at, dir: p.dir, filename } };
            }
          }
        }
      }
      if (Date.now() >= deadline) {
        return { ok: false, error: `no download finished within ${p.timeoutMs ?? 60_000}ms of clicking ${p.selector}` };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    const off = parseAsk("cdp", at({ method: "Browser.setDownloadBehavior", params: { behavior: "default" } }));
    if (!("error" in off)) await askBrowser(off.ask).catch(() => undefined);
  }
}

/**
 * Wait until something happens on ONE tab — and the tab is the caller's.
 *
 * This used to be handed `{since, waitMs, kinds}` and rebuild its three inner
 * asks with no page on any of them, so every kind read whatever was in front
 * even though `events` is not a tab op and the CLI had correctly attached the
 * caller's tab id. Two of the three were merely wrong; the `cdp` one was
 * DESTRUCTIVE. That buffer is per-guest and draining it empties it, so an
 * agent waiting on its own tab consumed the `Debugger.paused` that another
 * agent's tab was holding for its owner — a failure the victim sees as its
 * debugger simply never firing.
 */
export async function waitForEvents(p: {
  since: number;
  waitMs: number;
  kinds: string[];
  /** The tab to watch. Absent means the active one, which is now only ever a
   *  caller that said so — see the CLI's `--shared`. */
  page?: string;
}): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const started = Date.now();
  const deadline = started + Math.min(Math.max(p.waitMs, 0), 120_000);
  const want = (k: string) => p.kinds.length === 0 || p.kinds.includes(k);
  const at = (body: Record<string, unknown>) => (p.page ? { ...body, page: p.page } : body);
  let cursor = p.since;

  for (;;) {
    const found: Record<string, unknown[]> = {};
    for (const [kind, op] of [["console", "console"], ["network", "network"]] as const) {
      if (!want(kind)) continue;
      const parsed = parseAsk(op, at({ since: cursor }));
      if ("error" in parsed) continue;
      const r = await askBrowser(parsed.ask);
      if (!r.ok) return { ok: false, error: r.error };
      const rows = (r.value as { rows?: unknown[]; entries?: unknown[] } | undefined);
      const list = rows?.rows ?? rows?.entries ?? [];
      if (Array.isArray(list) && list.length) found[kind] = list;
    }
    if (want("cdp")) {
      const parsed = parseAsk("cdp", at({ events: true }));
      if (!("error" in parsed)) {
        const r = await askBrowser(parsed.ask);
        const evs = (r.value as { events?: unknown[] } | undefined)?.events;
        if (Array.isArray(evs) && evs.length) found.cdp = evs;
      }
    }
    if (Object.keys(found).length) {
      return { ok: true, value: { ...found, waitedMs: Date.now() - started, now: Date.now() } };
    }
    if (Date.now() >= deadline) {
      /* The honest empty answer, with the cursor to carry into the next wait
         so a caller that loops does not re-read what it has already seen. */
      return { ok: true, value: { waitedMs: Date.now() - started, now: Date.now(), nothing: true } };
    }
    await new Promise((r) => setTimeout(r, 250));
    cursor = Math.max(cursor, Date.now() - 1_000);
  }
}

/**
 * Several PAGES at once — §9, and the case the spec calls what a pure
 * reproduction actually needs: "Support watching a panel while an agent
 * changes its state".
 *
 * `runSteps` runs one sequence. This runs several, each against its own page,
 * genuinely concurrently — the relay already keys pending asks by id, so two
 * pages in flight do not collide. Sequencing them instead would make the
 * watcher see the change ALREADY MADE, which is precisely the thing being
 * tested and precisely what would be missed.
 *
 * One lane failing does not cancel the others. In a two-actor reproduction the
 * other lane's answer is half the evidence, and throwing it away because this
 * one broke leaves nobody able to say which of the two went wrong.
 */
export async function runLanes(
  lanes: Array<{ page?: string; steps: Array<{ op: unknown; args: unknown }> }>,
  /** `caller` is who asked, threaded down to every step of every lane —
   *  without it a lane is anonymous and the panel's ownership check, which
   *  reads an absent `as` as "cannot tell", allows it. `worker` files each
   *  reply's page id under the worker that opened it. */
  opts: { observe?: boolean; caller?: Record<string, unknown>; worker?: string; roots?: unknown } = {},
): Promise<{ ok: boolean; lanes: Array<Record<string, unknown>> }> {
  const out = await Promise.all(lanes.map(async (lane, i) => {
    /* The page id rides on every step of its lane, so a caller writes it once
       rather than on each verb — and cannot half-forget it, which would send
       two of five steps to the wrong page and produce a result that looks
       almost right. */
    const steps = lane.steps.map((st) => ({
      op: st.op,
      args: lane.page ? { ...(st.args as object ?? {}), page: lane.page } : st.args,
    }));
    const r = await runSteps(steps, { ...opts, page: lane.page });
    return { lane: i, page: lane.page, ...r };
  }));
  return { ok: out.every((l) => l.ok), lanes: out };
}

/**
 * What the page looks like after an action — §3: "every action returns the
 * observation after it, not `{clicked: true}`".
 *
 * Opt-in rather than always, and the reason is §14. An observation is not
 * free: it is the tree, the console and the network, and attaching one to
 * every click would put six of them in an agent's context for a five-step
 * sequence — where it needed the last one. `do --observe` already does this
 * for a batch; this is the same thing for a single verb, for the caller that
 * is not batching.
 *
 * Only for verbs that ACT. Asking what the page looks like after asking what
 * the page looks like is a round trip for a fact already in hand.
 */
export async function withObservation(
  ask: BrowserAsk, reply: BrowserReply,
): Promise<BrowserReply> {
  if (!reply.ok || OBSERVE_OPS.has(ask.op)) return reply;
  /*
   * THE SAME TAB THE VERB ACTED ON, not whichever is in front.
   *
   * This built its observation from an EMPTY body while the caller's `page`
   * sat unused two properties away in `ask.args`, so `--as B --page <B's tab>
   * click #x --observe` clicked B's page and then described A's. The `after`
   * block is evidence — it is what a proof-of-life run pastes — and evidence
   * of the wrong page is worse than none, because it reads as proof.
   */
  /* The caller rides on the observation too: an unattributed sub-ask is one
     the panel's ownership check cannot see, and therefore allows. */
  const inherited: Record<string, unknown> = {};
  for (const k of ["page", "as", "how", "pageExplicit", "partial"]) if (ask.args[k] !== undefined) inherited[k] = ask.args[k];
  /* A DELTA, when there is something to diff against. The caller that asks
     for the page after an action has, nearly always, just looked at it — and
     re-sending the whole tree to report that one heading changed is where an
     act-then-look loop spent its tokens. With no earlier look, or after a
     navigation, the page answers in full and says why (`delta: false`), so
     nothing is ever left out; a plain `observe` stays the full answer. */
  const parsed = parseAsk("observe", { ...inherited, delta: true });
  if ("error" in parsed) return reply;
  const seen = await askBrowser(parsed.ask);
  return seen.ok
    ? { ...reply, value: { ...(reply.value as object ?? {}), after: seen.value } }
    /* The action SUCCEEDED. A failure to look afterwards is worth a sentence,
       never a reversal of the answer — reporting a completed click as failed
       because the observation timed out is the worst possible trade. */
    : { ...reply, value: { ...(reply.value as object ?? {}), afterFailed: seen.error } };
}

/** What `scrape` may read from each page: the verbs that answer with the
 *  whole page in a shape, and take no selector. `text` is not here because it
 *  needs one, and `read` is the fallback for a caller that wants plain text. */
export const SCRAPE_READS: ReadonlySet<string> = new Set(["read", "markdown", "links", "extract", "interactive", "forms"]);
const SCRAPE_MAX_URLS = 40;
const SCRAPE_MAX_CONCURRENCY = 4;

export interface ScrapeSpec {
  urls: string[];
  read: string;
  fields?: Record<string, string>;
  concurrency: number;
  profile: string;
}

/**
 * The body of a `scrape`, validated the way a single `open` and a single read
 * would be — every URL through `safeUrl` and the origin allow-list, the read
 * through its own `parseAsk` — so a list of forty pages cannot reach further
 * than one page could. The concurrency cap is small on purpose: these are
 * tabs in a person's window, not workers in a pool.
 */
export function parseScrape(b: Record<string, unknown>, caller?: Record<string, unknown>): { error: string } | ScrapeSpec {
  if (!Array.isArray(b.urls) || b.urls.length === 0) return { error: "scrape needs urls: [\"https://...\", ...]" };
  if (b.urls.length > SCRAPE_MAX_URLS) return { error: `scrape takes at most ${SCRAPE_MAX_URLS} urls, got ${b.urls.length}` };
  const urls: string[] = [];
  const list = allowedOrigins();
  for (const raw of b.urls) {
    const url = safeUrl(raw);
    if (!url) return { error: `${String(raw).slice(0, 200)}: url must be an http(s) address` };
    const host = new URL(url).host;
    if (!originAllowed(host, list)) {
      const msg = `origin refused: ${host} is not in the allow-list (${list.join(", ")}).${originsLift()}`;
      recordAudit("newtab", { url }, false, msg, false, undefined, caller);
      return { error: msg };
    }
    urls.push(url);
  }
  const read = typeof b.read === "string" && b.read ? b.read : "markdown";
  if (!SCRAPE_READS.has(read)) return { error: `read must be one of ${[...SCRAPE_READS].join(", ")}` };
  let fields: Record<string, string> | undefined;
  if (read === "extract") {
    const parsed = parseAsk("extract", { fields: b.fields });
    if ("error" in parsed) return { error: parsed.error };
    fields = parsed.ask.args.fields as Record<string, string>;
  }
  let concurrency = 2;
  if (b.concurrency !== undefined) {
    if (typeof b.concurrency !== "number" || !Number.isInteger(b.concurrency) || b.concurrency < 1 || b.concurrency > SCRAPE_MAX_CONCURRENCY) {
      return { error: `concurrency must be a whole number from 1 to ${SCRAPE_MAX_CONCURRENCY}` };
    }
    concurrency = b.concurrency;
  }
  const profile = typeof b.profile === "string" ? b.profile : "";
  return { urls, read, fields, concurrency, profile };
}

export interface ScrapedPage { url: string; ok: boolean; tab?: string; value?: unknown; error?: string; ms: number }

/**
 * Several pages, read in parallel, each in a tab of its own that is closed
 * again whatever happened in it.
 *
 * Not `lanes`: a lane is several verbs on a page that already exists, and
 * this is the same read on pages that do not exist yet. Each URL is a
 * `newtab` in the caller's container, the read addressed to that tab, and a
 * `closetab` in a `finally` — a failed read is a row with an error, not a tab
 * left open in somebody's window. At most `concurrency` tabs are open at once;
 * rows come back in the order the URLs were given, whatever order they
 * finished in. Every ask goes through `askBrowser`, so each is audited and
 * each is held to the owner check like a hand-typed one.
 */
export async function runScrape(spec: ScrapeSpec, caller: Record<string, unknown> = {}): Promise<{ ok: boolean; value: { pages: ScrapedPage[]; failed: number } }> {
  const rows: ScrapedPage[] = new Array(spec.urls.length);
  let next = 0;
  const one = async (url: string): Promise<ScrapedPage> => {
    const started = Date.now();
    const minted = parseAsk("newtab", { ...caller, url, profile: spec.profile });
    if ("error" in minted) return { url, ok: false, error: minted.error, ms: Date.now() - started };
    const tab = await askBrowser(minted.ask);
    const id = tab.ok && tab.value && typeof tab.value === "object" ? (tab.value as { id?: unknown }).id : undefined;
    if (!tab.ok || typeof id !== "string" || !id) {
      return { url, ok: false, error: tab.error || "the window did not say which tab it opened", ms: Date.now() - started };
    }
    try {
      const read = parseAsk(spec.read as BrowserOp, { ...caller, page: id, ...(spec.fields ? { fields: spec.fields } : {}) });
      if ("error" in read) return { url, ok: false, tab: id, error: read.error, ms: Date.now() - started };
      const reply = await askBrowser(read.ask);
      return reply.ok
        ? { url, ok: true, tab: id, value: reply.value, ms: Date.now() - started }
        : { url, ok: false, tab: id, error: reply.error || "the read failed", ms: Date.now() - started };
    } finally {
      const close = parseAsk("closetab", { ...caller, id });
      if (!("error" in close)) await askBrowser(close.ask).catch(() => undefined);
    }
  };
  const worker = async () => {
    while (next < spec.urls.length) {
      const i = next++;
      rows[i] = await one(spec.urls[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(spec.concurrency, spec.urls.length) }, worker));
  const failed = rows.filter((r) => !r.ok).length;
  return { ok: true, value: { pages: rows, failed } };
}

export async function runSteps(
  steps: Array<{ op: unknown; args: unknown }>,
  /** `page` is the tab the trailing observation must describe. A lane passes
   *  its own; a single `do` passes the one its steps carry.
   *
   *  `as`, `how` and `pageExplicit` are the CALLER, and they have to reach
   *  every sub-ask or the batch is anonymous — see the note in the loop.
   *
   *  `roots` are the turn's writable roots, when a turn asked: a `do` is where
   *  a `cdp` step skips the door's own `cdp` branch, so the rule is made again
   *  here, where the step becomes an ask. */
  opts: { observe?: boolean; page?: string; caller?: Record<string, unknown>; worker?: string; roots?: unknown } = {},
): Promise<{ ok: boolean; steps: Array<Record<string, unknown>>; stoppedAt?: number }> {
  const out: Array<Record<string, unknown>> = [];
  /* Whether an earlier step opened a tab in the worker's own container: the
     steps after it may leave the page out. */
  let openedOwn = false;
  /* The page the worker's own mint in this `do` returned. The waiver above is
     only half of it: the panel acts on the tab IN FRONT when an ask names no
     page, and a mint is born in the background, so without this the next step
     went to the person's tab and the panel refused it — measured with a `do`
     of one `open` and one `read`. */
  let ownPage: string | undefined;
  for (const [i, step] of steps.entries()) {
    /*
     * THE CALLER RIDES INTO EVERY STEP, and the address with it.
     *
     * `do` is the incident's own vector: a read-only batch has no leading
     * `open` to overwrite the page, so a misrouted one returns the other
     * container's page verbatim. And it was misrouted twice over — the steps
     * carried no `as`, which the panel reads as "cannot tell" and allows, and
     * they carried no `page` either, because the CLI puts the address at the
     * TOP level of the `do` body and this loop only ever read `step.args`. So
     * every step of every batch went to the active tab, unattributable.
     *
     * The step's own arguments win: a step that names its own page is a caller
     * saying something deliberate about that one step.
     */
    const args = (step.args as Record<string, unknown> | undefined) ?? {};
    /* The step's own page is a caller saying something about that one step;
       after that, the page this `do` minted; then the caller's (a lane's). */
    const basePage = typeof args.page === "string" && args.page ? args.page : ownPage ?? opts.page;
    const addressed = { ...(opts.caller ?? {}), ...(basePage ? { page: basePage } : {}), ...args };
    const parsed = parseAsk(step.op, addressed, { worker: !!opts.worker });
    if ("error" in parsed) {
      out.push({ op: step.op, ok: false, error: parsed.error });
      return { ok: false, steps: out, stoppedAt: i };
    }
    /* A step is a verb of its own: a `cdp` here never met the door's `cdp`
       branch, so the download rule is made where the step becomes an ask. */
    const refusedPath = downloadPathRefusal(parsed.ask.args as Record<string, unknown>, opts.roots);
    if (refusedPath) {
      out.push({ op: step.op, ok: false, error: refusedPath });
      return { ok: false, steps: out, stoppedAt: i };
    }
    /* The registry as it stands NOW: a page an earlier step opened is the
       worker's own by the time this one runs, and a step that names somebody
       else's is still refused before it is sent. */
    if (opts.worker) {
      const refused = agentAskRefusal(addressed, opts.worker, parsed.ask.op, openedOwn);
      if (refused) {
        out.push({ op: step.op, ok: false, error: refused });
        return { ok: false, steps: out, stoppedAt: i };
      }
      /* The same rule the route's walk reads, on the step's own args. */
      if (opensOwnPage(parsed.ask.op, addressed, foldWorkerName(opts.worker))) openedOwn = true;
    }
    if (opts.worker) noteWorkerAsk(parsed.ask.id, opts.worker, parsed.ask.op,
      typeof (parsed.ask.args as { id?: unknown }).id === "string" ? (parsed.ask.args as { id: string }).id : undefined);
    const reply = await askBrowser(parsed.ask);
    out.push({ op: step.op, ok: reply.ok, value: reply.value, error: reply.error, diagnosis: reply.diagnosis });
    if (!reply.ok) return { ok: false, steps: out, stoppedAt: i };
    /* The LAST mint wins: a `do` that opens two pages and then reads one
       without naming it means the one it opened most recently, which is the
       tab the window has in front. */
    if (opts.worker && opensOwnPage(parsed.ask.op, args, foldWorkerName(opts.worker))) {
      const v = reply.value as { tab?: unknown; id?: unknown } | undefined;
      const id = typeof v?.tab === "string" ? v.tab : typeof v?.id === "string" ? v.id : undefined;
      if (id) ownPage = id;
    }
  }
  /* And what the page looks like now, when asked for. "Every action returns
     the observation after it, not {clicked: true}" is §3's wording; doing it
     once at the end of a batch is the same fact for a fraction of the tokens
     §14 just started counting. */
  if (opts.observe) {
    /* ADDRESSED, for the same reason as `withObservation` — and here it was
       measurably worse: `runLanes` pins every STEP to its lane's page and then
       handed `opts` to this, whose trailing observation had no page at all. So
       a two-lane `do --observe` came back with the same active-tab observation
       twice, and at least one lane's evidence was wrong deterministically,
       with a single agent and entirely correct usage. */
    const observePage = ownPage ?? opts.page;
    const parsed = parseAsk("observe", { ...(opts.caller ?? {}), ...(observePage ? { page: observePage } : {}), delta: true });
    if (!("error" in parsed)) {
      const reply = await askBrowser(parsed.ask);
      out.push({ op: "observe", ok: reply.ok, value: reply.value, error: reply.error });
    }
  }
  return { ok: true, steps: out };
}

/** Verbs that can be retried without doing anything twice. Reading a page,
 *  taking a picture, asking what is open: if the answer never came, asking
 *  again costs a round trip. A click is NOT here, and neither is anything that
 *  writes — a retried click on "Pay" is the reason retry-everything is a bad
 *  default. */
const IDEMPOTENT: ReadonlySet<string> = new Set([
  "read", "text", "html", "shot", "observe", "console", "network", "tabs",
  "profiles", "frames", "cookies", "listeners", "health", "har", "audit", "pdf",
  "whoami",
]);

/** Failures worth asking again about: the panel was between states, or nothing
 *  answered in time. A refusal with a REASON — no such element, read-only mode,
 *  an origin outside the list — is an answer, and repeating it just spends the
 *  clock arriving at the same sentence. */
const WORTH_RETRY = /did not answer in time|view is not open|not ready/i;

/**
 * One ask, with a retry on the failures a retry can fix — §15.
 *
 * Two backed-off attempts, and only for verbs that do nothing twice when asked
 * twice. The panel de-registers itself for a moment when its tab changes, and
 * a call landing in that gap is told the view is not open when it is; that is
 * a real, measured, self-healing failure, and making a caller handle it is
 * making every caller handle it.
 *
 * A refusal with a REASON is never retried. "Nothing matches #save",
 * "read-only mode", "not in the allow-list" — asking again spends the clock to
 * arrive at the same sentence, and the sentence was already the answer.
 */
/*
 * A STAND-IN, FOR THE VERBS THAT ORCHESTRATE OTHER VERBS.
 *
 * `traceRecording` and `downloadFile` are sequences: end the trace, wait for
 * the handle, read it, write the file. What can be wrong with them is the
 * SEQUENCE and what it leaves on disk, and neither is reachable from a test
 * that needs a real Chromium — which is why `trace stop` shipped answering
 * with a path to a file it never wrote.
 *
 * Null in every ordinary run, so nothing about the real path changes.
 */
let asker: ((ask: BrowserAsk) => Promise<BrowserReply>) | null = null;
/** For a test. Passing `null` puts the real browser back. */
export function __setBrowserAsker(fn: ((ask: BrowserAsk) => Promise<BrowserReply>) | null): void {
  asker = fn;
}

/** One tab row as the panel reports it — id, title, url, `active`, and the
 *  container NAME (`"default"` said out loud for the shared one). */
interface TabRow { id: string; title?: string; url?: string; active?: boolean; profile?: string }

function tabRows(v: unknown): TabRow[] {
  return Array.isArray(v) ? v.filter((r): r is TabRow => !!r && typeof r === "object") : [];
}

/** The `you` block §11 asks for: the identity as asserted, the tab it claims,
 *  and whether that tab is still in the window's list. */
function youBlock(args: Record<string, unknown>, rows: readonly TabRow[]):
  { identity: string | null; tab: string | null; tabLive: boolean } {
  const identity = typeof args.identity === "string" ? args.identity : null;
  const tab = typeof args.tab === "string" ? args.tab : null;
  return { identity, tab, tabLive: !!tab && rows.some((r) => r.id === tab) };
}

function activeBlock(rows: readonly TabRow[]): TabRow | null {
  const a = rows.find((r) => r.active);
  return a ? { id: a.id, profile: a.profile ?? "default", url: a.url, title: a.title } : null;
}

/**
 * What each caller last saw: the document and the observation number the page
 * stamped on the last answer this relay delivered to it. Keyed by who asked
 * and which tab they named, so a delta is always against the caller's OWN
 * last look — including the look it took at another page in between, which is
 * how a page restored from the back/forward cache is told apart from the one
 * the caller saw last. Bounded: callers are few, and a map nobody prunes
 * grows for the life of the server.
 */
const LAST_OBSERVED = new Map<string, { doc: string; seq: number }>();
const LAST_OBSERVED_MAX = 256;
const observedKey = (args: Record<string, unknown>) =>
  `${foldWorkerName(typeof args.as === "string" ? args.as : "")}\u0000${typeof args.page === "string" ? args.page : ""}`;

async function observeTracked(ask: BrowserAsk, send: (a: BrowserAsk) => Promise<BrowserReply>): Promise<BrowserReply> {
  const key = observedKey(ask.args);
  const sent = ask.args.delta === true
    ? { ...ask, args: { ...ask.args, base: LAST_OBSERVED.get(key) ?? null } }
    : ask;
  const reply = await send(sent);
  /* A look the caller will only see part of: forget the baseline, so the next
     delta answers in full rather than against nodes it never read. */
  if (ask.args.partial === true) { LAST_OBSERVED.delete(key); return reply; }
  const v = reply.value as { doc?: unknown; seq?: unknown } | undefined;
  if (reply.ok && v && typeof v.doc === "string" && Number.isInteger(v.seq)) {
    LAST_OBSERVED.delete(key);
    LAST_OBSERVED.set(key, { doc: v.doc, seq: v.seq as number });
    if (LAST_OBSERVED.size > LAST_OBSERVED_MAX) LAST_OBSERVED.delete(LAST_OBSERVED.keys().next().value!);
  }
  return reply;
}

/* The one door a worker's reply comes through: every route returns what this
   returns, so scoping lives here rather than in each route's verb list. The
   worker is read before the wait — that map entry is consumed on the answer. */
/**
 * "Sign agents out when the task ends" (finding 4): the agent said `done`, so
 * every lane it owns that was signed in from a vault with that setting on is
 * closed. Closing is the sign-out: main wipes the jar and logs it. Returns the
 * lanes closed.
 */
export async function signOutVaultLanes(as: string, worker: boolean, windowOver = false): Promise<string[]> {
  const mine = worker ? listOwnedLanes(as) : listLanes(as);
  const closed: string[] = [];
  for (const l of mine) {
    /* A pull still waiting on the person's OK when the worker's window ends:
       nobody is left to use the login, so the lane closes and main's
       laneGone() check after the yes fills nothing (sec 4). */
    const pending = windowOver && (vaultPulling.get(l.id) ?? 0) > 0;
    if (!pending && (!vaultSignOut.has(l.id) || !vaultLanes.has(l.id))) continue;
    const r = await closeLane(l.id, as, false, worker).catch(() => ({ ok: false }));
    if (!r.ok) continue;
    forgetVaultLane(l.id);
    closed.push(l.id);
    recordAudit("lane", { action: "signout", id: l.id }, true, undefined, false, undefined, { as });
  }
  /* The task is over (done, or the agent's session ended): the vault's
     cookies come out of the agent's own containers too, exactly those. */
  await wipeSignIns(signInsOf(as), windowOver ? "session ended" : "done").catch(() => false);
  /* Whatever the wipe said, the next task starts over: a visit is tried again. */
  forgetVisitsOf(as);
  return closed;
}

/* The lane rule, for an agent's own `--as` container: while the vault's
   sign-ins are in it, a verb that could read them back out is refused. Raw JS
   there can read and act as the person. Never for the person's Default. */
function containerVaultRefusal(ask: BrowserAsk, worker: string | undefined): string | null {
  const as = worker ?? (typeof ask.args.as === "string" && ask.args.as.trim() ? ask.args.as : undefined);
  if (!as || as.trim().toLowerCase() === SHARED_KEY) return null;
  /* `do` needs no case of its own: each step reaches askBrowser as its own verb. */
  const a = ask.args;
  if (!VAULT_LANE_REFUSED.has(ask.op) || (typeof a.lane === "string" && a.lane) || a.active === true) return null;
  const page = typeof a.page === "string" && a.page ? a.page : undefined;
  /* The person's own tab (shared) is fine, but only when no tab is named:
     a named tab is judged by its container. */
  if (!page && (a.shared === true || a.how === "shared")) return null;
  /* A known tab is judged by its own container; with no tab named, or one
     the server never saw, the agent's sign-ins anywhere count. */
  const box = tabContainer(page);
  const held = box ? signInsWhere((s) => s.container === box).length > 0 : signInsOf(as).length > 0;
  if (!held) return null;
  return `${ask.op} is refused while this container holds sign-ins from the login vault: it could read the login back out. Use the reading verbs (read, text, markdown, interactive) and act on the page instead; the sign-ins go when you say done`;
}

export async function askBrowser(ask: BrowserAsk): Promise<BrowserReply> {
  const worker = ASK_WORKER.get(ask.id)?.worker;
  const refused = containerVaultRefusal(ask, worker);
  if (refused) {
    recordAudit(ask.op, ask.args, false, refused);
    return { ok: false, error: refused };
  }
  if (ask.op === "done") {
    const reply = await askBrowserInner(ask, worker);
    const as = worker ?? (typeof ask.args.as === "string" && ask.args.as ? ask.args.as : undefined);
    if (as) await signOutVaultLanes(as, !!worker).catch(() => []);
    return reply;
  }
  return askBrowserInner(ask, worker);
}

async function askBrowserInner(ask: BrowserAsk, worker: string | undefined): Promise<BrowserReply> {
  /* The container a worker's mint is sent to, written down here rather than
     trusted from the body: the panel reads an absent or empty profile as the
     person's container, so neither may cross this door from a worker. The gate
     already refuses them; this is the second layer, on the one path every ask
     takes. */
  const laneAddressed = typeof ask.args.lane === "string" && !!ask.args.lane.trim();
  /* A worker's `show` never takes the person's view: dropped before anything
     acts on it, and said in the answer. An agent's container once replaced
     the person's pane; lanes are seen beside, in the overview, never instead. */
  const workerShow = worker ? workerShowNote(ask) : null;
  const unshown = workerShow ? { ...ask, args: Object.fromEntries(Object.entries(ask.args).filter(([k]) => k !== "show")) } : ask;
  const sent = worker && !laneAddressed && mintsInAContainer(unshown.op, unshown.args)
    ? { ...unshown, args: { ...unshown.args, profile: agentContainerName(worker) } }
    : unshown;
  try {
    const checking = worker ? guideReadRefusal(worker, sent, (a) => (asker ? asker(a) : askWithRetry(a))) : null;
    if (checking) {
      const why = await checking;
      if (why) return { ok: false, error: why };
    }
    const reply = await askPanel(sent);
    if (!worker) return reply;
    if (ask.op === "health") return workerHealth(reply);
    const scoped = WORKER_PAGE_REPLY_OPS.has(ask.op) ? workerReply(worker, reply) : reply;
    if (!workerShow || !scoped.ok) return scoped;
    /* An answer scoped down to nothing still says why nothing came forward. */
    if (Array.isArray(scoped.value) && scoped.value.length === 0) return { ...scoped, value: { ...workerShow } };
    return scoped.value && typeof scoped.value === "object" && !Array.isArray(scoped.value)
      ? { ...scoped, value: { ...(scoped.value as Record<string, unknown>), ...workerShow } }
      : scoped;
  } finally {
    /* No window, a composed answer, a timeout before parking: an ask that never
       reached `settleBrowser` must not stay in the map. */
    if (worker) ASK_WORKER.delete(ask.id);
  }
}

async function askPanel(ask: BrowserAsk): Promise<BrowserReply> {
  if (ask.op === "observe") return observeTracked(ask, (a) => (asker ? asker(a) : askWithRetry(a)));
  /* Before the stand-in, like `observe`: the guide's state lives here, and a
     test of it is a test of this composition against a fake panel. */
  if (ask.op === "guide" || ask.op === "point") return composeGuide(ask, (a) => (asker ? asker(a) : askWithRetry(a)));
  if (asker) return asker(ask);
  /* robots.txt, when the operator asked for it — see robots.ts for why it is
     off by default. Here rather than in `parseAsk` because it is a fetch, and
     here rather than in the route because `do` steps arrive through this door
     too. The refusal is audited like any other. */
  if ((ask.op === "open" || ask.op === "newtab") && typeof ask.args.url === "string" && robotsOn()) {
    const why = await robotsRefusal(ask.args.url);
    if (why) {
      recordAudit(ask.op, ask.args, false, why);
      return { ok: false, error: why };
    }
  }
  /*
   * §11: two verbs the window cannot answer on its own.
   *
   * `whoami` is a question about the CALLER, and the window has never met the
   * caller — identity is derived in the CLI's process from its environment.
   * `profiles` is a question the window answers with bare names, and the
   * detail that makes it a pre-flight (who owns the pane on screen, how many
   * tabs each container holds) lives in the TAB list, which is a second ask.
   *
   * So both are composed here, at the relay, out of what the window can
   * answer. They go through `askBrowser` rather than `askOnce` so the retry
   * and the two "nothing is listening" sentences come for free — and the audit
   * therefore shows both lines, the inner `tabs`/`profiles` and the outer verb.
   * That is on purpose: hiding the inner ask would make the audit lie about
   * what actually crossed the wire, and §9's audit is evidence.
   */
  if (ask.op === "whoami") return composeWhoami(ask);
  if (ask.op === "lane") return composeLane(ask);
  if (ask.op === "profiles" && ask.args.make === undefined && ask.args.drop === undefined) {
    return composeProfiles(ask);
  }
  if (ask.op === "profiles" && typeof ask.args.drop === "string") return composeDrop(ask);
  /* Sign-in on a first visit: awaited BEFORE the navigation is sent, so the
     first request already carries the login. With the setting off main
     answers `off` and the reply is exactly a plain `open`'s. */
  const visiting = visitSignIn(ask);
  const visit = visiting ? await visiting : null;
  if (visit?.fail) {
    recordAudit(ask.op, ask.args, false, visit.fail.error);
    return visit.fail;
  }
  const reply = await askWithRetry(ask);
  if (ask.op === "closetab" && reply.ok) await afterTabClose(ask, reply).catch(() => undefined);
  if (!reply.ok || !reply.value || typeof reply.value !== "object" || Array.isArray(reply.value)) return reply;
  /* The panel's record of the container (id, minted, agentMade) is the relay's, never the agent's. */
  const { container: _c, minted: _m, agentMade: _a, ...value } = reply.value as Record<string, unknown>;
  const rv = reply.value as object;
  const plain = "container" in rv || "minted" in rv || "agentMade" in rv ? { ...reply, value } : reply;
  /* A lane's own outcome; or, in a container, its own sign-in or the sentence why not. */
  const page: { title?: string } = {};
  const said = visit?.vault ?? (visiting ? undefined : await containerVisit(ask, reply.value as Record<string, unknown>, page));
  const shown = laneShowNote(ask);
  /* The tab list is the panel's, read before the page had a title: its row for
     this tab carries the host. Once the loaded page's title is known the row says it too. */
  const rows = page.title && Array.isArray(value.tabs) ? (value.tabs as unknown[]).map((r) => {
    const row = r && typeof r === "object" ? r as Record<string, unknown> : null;
    return row && row.id === value.id ? { ...row, title: page.title } : r;
  }) : undefined;
  return said || shown || page.title
    ? { ...plain, value: { ...value, ...(page.title ? { title: page.title } : {}), ...(rows ? { tabs: rows } : {}), ...(said ? { vault: said } : {}), ...shown } }
    : plain;
}

/** `open|newtab --show` from a worker's credential: a no-op, said in one sentence. */
function workerShowNote(ask: BrowserAsk): { shown: false; why: string } | null {
  if ((ask.op !== "open" && ask.op !== "newtab") || ask.args.show !== true) return null;
  return { shown: false, why: "an agent's page never takes the person's view; it stays in the background, and the person sees it in the Browser overview" };
}

/* The person's own Browser panels: a registration that hosts no lane. */
function personPanels(): number {
  browserReadyCount();
  return [...ready.values()].filter((r) => r.lanes.length === 0).length;
}

/**
 * `open --lane L --show`: a lane's tab lives in a window of its own, so the
 * panel that honours `show` on a mint never sees this ask. The relay tells the
 * person's pane instead, and says in the answer whether there was a pane to
 * tell: the CLI used to print "brought forward" before it had asked anybody.
 */
function laneShowNote(ask: BrowserAsk): { shown: boolean; marked?: boolean; why?: string } | null {
  if ((ask.op !== "open" && ask.op !== "newtab") || ask.args.show !== true || typeof ask.args.lane !== "string") return null;
  if (personPanels() === 0) {
    return { shown: false, why: "the Browser pane is not open in the agentglass window, so nothing could bring this lane forward" };
  }
  /* Never over the person's page, and never "shown": the pane may be hidden
     behind another view, and the watch opens only from the person's click.
     The lane is marked in the Browser overview for them to open. */
  return showLane(ask.args.lane)
    ? { shown: false, marked: true, why: "an agent's page never takes the person's view; this lane is marked in the Browser overview for them to open" }
    : { shown: false, why: noLaneError(ask.args.lane) };
}

/** The name the person knows a vault by ("Zen — Ubuntu"), from its id or the
 *  name an agent typed; the name itself when the index has nothing better. */
export function vaultDisplayName(nameOrId: string): string {
  let vaults: Record<string, { label: string }>;
  try { vaults = readIndex().vaults; } catch { return nameOrId; }
  const id = vaults[nameOrId] ? nameOrId : resolveVaultName(nameOrId, vaults);
  return (id && vaults[id]?.label) || nameOrId;
}

/** The lanes as the person's Browser pane shows them: a vault lane carries its
 *  box's display name, and its id beside it. */
export function paneLaneRows(): LaneRow[] {
  return listLanes().map((l) => {
    if (!l.vault) return l;
    let id: string | undefined;
    try { const v = readIndex().vaults; id = v[l.vault] ? l.vault : resolveVaultName(l.vault, v); } catch { /* no vault yet */ }
    return { ...l, vault: vaultDisplayName(l.vault), ...(id ? { vaultId: id } : {}) };
  });
}

/**
 * Decision B: the first `open`/`newtab` of a site in a container the agent's
 * own ask made (the panel's `minted`, by id) signs it in from the vault, after
 * the page is there, then reloads it. Never the person's Default, never a
 * container the person made or named. The cookies set are written down (name,
 * domain, path) and removed when the task ends. Undefined = nothing to say.
 */
async function containerVisit(ask: BrowserAsk, v: Record<string, unknown>, page?: { title?: string }): Promise<Record<string, unknown> | undefined> {
  if (ask.op !== "open" && ask.op !== "newtab") return undefined;
  const a = ask.args as Record<string, unknown>;
  if ((typeof a.lane === "string" && a.lane) || laneScope.getStore()?.lane) return undefined;
  if (a.shared === true || a.active === true || a.how === "shared") return undefined;
  const worker = ASK_WORKER.get(ask.id)?.worker;
  const as = worker ?? (typeof a.as === "string" && a.as.trim() ? a.as : undefined);
  const tab = typeof v.id === "string" ? v.id : typeof v.tab === "string" ? v.tab : typeof a.page === "string" ? a.page : "";
  const fromReply = typeof v.container === "string";
  const container = fromReply ? v.container as string : tabContainer(tab);
  const name = typeof v.profile === "string" ? v.profile : typeof a.profile === "string" ? a.profile : "";
  /* The flag lives on the profile itself: an id is a slug of a name, so a
     container the person makes after an agent's was removed can get the same
     id. Without the flag it is the person's: never signed in, never wiped. A
     navigation in a known tab carries no container: the tab's open said it. */
  const agentMade = fromReply ? v.agentMade === true : tabAgentMade(tab);
  if (tab && container) noteTabContainer(tab, container, agentMade);
  if (container && fromReply && !agentMade) disownContainer(container);
  if (container && agentMade && as && as.toLowerCase() !== SHARED_KEY) {
    if (v.minted === true) noteMadeContainer(container, name, foldWorkerName(as), true);
    /* A worker's reserved container is its own by name: nobody else can make one. */
    else if (worker && isAgentContainer(a.profile) && containerOwner(String(a.profile)) === foldWorkerName(worker)) {
      noteMadeContainer(container, name || String(a.profile), foldWorkerName(worker));
    }
  }
  if (!agentMade || !madeByAgent(container, as)) return containerVaultNote(ask);
  if (typeof a.url !== "string") return undefined;
  let site = "";
  try {
    const u = new URL(a.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    site = siteOf(u.hostname);
  } catch { return undefined; }
  if (!/^[a-z0-9.-]{1,253}$/.test(site) || !tryContainerSite(container!, site)) return undefined;
  const vault = typeof a.vault === "string" && a.vault ? a.vault : undefined;
  const r = await askOnce({
    id: nextId(), op: "lane",
    args: {
      vaultPull: {
        container, site, agent: as ?? "", ...(vault ? { vault } : {}),
        /* Signed in = the vault's sign-in is still on this book, not "the jar has a cookie". */
        held: signInsWhere((s) => s.container === container && s.site === site).length > 0,
        onVisit: true, budgetMs: VAULT_VISIT_BUDGET_MS, deadlineAt: Date.now() + VAULT_VISIT_BUDGET_MS,
      },
    },
  }, VAULT_VISIT_MS);
  const got = r.ok && r.value && typeof r.value === "object" ? r.value as Record<string, unknown> : null;
  if (!got) return { signedIn: false, site, why: "the sign-in did not finish in time; the page is signed out; ask with browser_vault" };
  if (got.ok === true) {
    const cookies = Array.isArray(got.cookies) ? got.cookies as ContainerSignIn["cookies"] : [];
    if (cookies.length) recordSignIn({ container: container!, name, owner: foldWorkerName(as!), site, cookies });
    if (!cookies.length) return { signedIn: false, site, why: "the vault had no cookie for this site that could go in; ask with browser_vault" };
    /* The page loaded before the cookies went in: once more, signed in. */
    const again = await askWithRetry({ id: nextId(), op: "reload", args: { page: tab, ...(as ? { as } : {}) } }).catch(() => undefined);
    /* The open's own answer was read before the login went in: the page's title is the reloaded one's. */
    const t = again?.ok && again.value && typeof again.value === "object" ? (again.value as { title?: unknown }).title : undefined;
    if (page && typeof t === "string" && t.trim()) page.title = t;
    const label = typeof got.label === "string" && got.label ? got.label : typeof got.vault === "string" ? vaultDisplayName(got.vault) : undefined;
    /* The same field a lane's sign-in carries: the name the person knows, and the id beside it. */
    const vid = typeof got.vault === "string" && got.vault ? got.vault : undefined;
    return { signedIn: true, site, ...(label ? { vault: label } : {}), ...(vid ? { vaultId: vid } : {}) };
  }
  const code = typeof got.code === "string" ? got.code : "";
  if (VISIT_QUIET.has(code)) return undefined;
  /* Never silent when a pull was asked: the sign-in is already on record. */
  if (code === "has-login") {
    const label = typeof got.label === "string" && got.label ? got.label : typeof got.vault === "string" && got.vault ? vaultDisplayName(got.vault) : undefined;
    const vid = typeof got.vault === "string" && got.vault ? got.vault : undefined;
    return { signedIn: true, site, already: true, ...(label ? { vault: label } : {}), ...(vid ? { vaultId: vid } : {}) };
  }
  if (code === "ambiguous") {
    const names = (Array.isArray(got.vaults) ? got.vaults : []).map((x) => {
      const o = x && typeof x === "object" ? x as Record<string, unknown> : null;
      return typeof x === "string" ? x : o && typeof o.label === "string" && o.label ? o.label : o && typeof o.id === "string" ? o.id : "";
    }).filter(Boolean);
    return {
      signedIn: false, site,
      why: `${site} is in more than one vault and none is the default: ask the person which, then open it again with --vault NAME`
        + `${names.length ? `, one of: ${names.map((x) => JSON.stringify(x)).join(", ")}` : ""}; or the person sets a default vault in Settings ▸ Browser ▸ Login vault`,
    };
  }
  return { signedIn: false, site, why: typeof got.error === "string" && got.error ? got.error : "the sign-in failed; ask with browser_vault" };
}

/**
 * Remove exactly the cookies these sign-ins put in, one ask per sign-in. A
 * sign-in the window could not clean stays in the book for the next try (the
 * next task end, or the next start). True when every one went.
 */
async function wipeSignIns(list: readonly ContainerSignIn[], why: string): Promise<boolean> {
  let all = true;
  for (const s of list) {
    const r = await askOnce({
      id: nextId(), op: "lane",
      /* `sweep`: the site's other cookies in this agent's own container go too
         (the page rotates the login, so the listed names alone left it signed in). */
      args: { vaultWipe: { container: s.container, cookies: s.cookies, site: s.site, agent: s.owner, why, sweep: true } },
    }, VAULT_VISIT_MS).catch(() => ({ ok: false } as BrowserReply));
    const v = r.ok && r.value && typeof r.value === "object" ? r.value as { ok?: unknown; code?: unknown; vaultLeft?: unknown } : null;
    /* The window re-read the jar and counted the cookies the vault put in (same name, domain, path and value) that are still there: any means the wipe did not hold; keep the record for a retry. A page's own cookie of the same name does not count. */
    const stillIn = typeof v?.vaultLeft === "number" && v.vaultLeft > 0;
    /* `vaultLeft: null` = the window had no book to check against: it cannot prove the cookies are gone, so the record stays and the next task end retries. */
    const unknown = v?.ok === true && v.vaultLeft === null;
    if (v?.ok === true && !stillIn && !unknown) dropSignIns([s]);
    else if (v?.ok === true) all = false;
    /* The window holds a person's container under that id now: the record
       goes, the person's cookies stay. */
    else if (v?.code === "not-agent") disownContainer(s.container);
    else all = false;
  }
  return all;
}


/** An agent's last tab in a container closed: that container's sign-ins come out. */
async function afterTabClose(ask: BrowserAsk, reply: BrowserReply): Promise<void> {
  const closed = typeof ask.args.page === "string" ? ask.args.page : typeof ask.args.id === "string" ? ask.args.id : "";
  const gone = tabContainer(closed);
  if (closed) forgetTab(closed);
  /* A tab this server never saw (closed by --index) names no container: wipe nothing. */
  if (!gone) return;
  const mine = signInsWhere((s) => s.container === gone);
  if (!mine.length || !Array.isArray(reply.value)) return;
  /* A row names its container by name or id; either one still open keeps it. */
  const open = new Set((reply.value as TabRow[]).flatMap((r) => {
    const t = r as unknown as Record<string, unknown>;
    const ids = [typeof t.profile === "string" ? t.profile.toLowerCase() : "", typeof t.id === "string" ? tabContainer(t.id) ?? "" : ""];
    return ids.filter(Boolean);
  }));
  const left = mine.filter((s) => !open.has(s.container) && !open.has(s.name.toLowerCase()));
  if (left.length) await wipeSignIns(left, "last tab closed");
}

/* Main's answers a sign-in on visit says nothing about: the setting is off,
   the vault has no login for the site, or the lane already holds one. */
const VISIT_QUIET: ReadonlySet<string> = new Set(["off", "none"]);

/**
 * The first `open`/`newtab` of a site in an EPHEMERAL lane asks main to sign
 * the lane in from the vault (main decides whether the setting is on; the
 * server cannot read it). Once per lane per site, whatever the outcome. Null
 * when there is nothing to do; `vault` is the field the reply gains; `fail`
 * means the lane is gone and nothing is navigated.
 */
/* Not `async`: an ask with nothing to sign in must reach `askOnce` in the same
   tick, parked before its caller's next line runs. An `await` of a null here
   let a window drop, or a second ask, land before the first was parked. */
function visitSignIn(ask: BrowserAsk): Promise<VisitResult> | null {
  if (ask.op !== "open" && ask.op !== "newtab") return null;
  const scoped = laneScope.getStore();
  const lane = typeof ask.args.lane === "string" && ask.args.lane ? ask.args.lane : scoped?.lane;
  if (!lane) return null;
  /* Only `ephemeral`: in memory, wiped at close. Named, private and the
     person's own container are never filled. */
  const rec = laneRecord(lane);
  if (!rec || rec.container !== "ephemeral") return null;
  if (typeof ask.args.url !== "string") return null;
  let host = "";
  try {
    const u = new URL(ask.args.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    host = u.hostname;
  } catch { return null; }
  const site = siteOf(host);
  if (!/^[a-z0-9.-]{1,253}$/.test(site)) return null;
  /* The caller askOnce will place: a lane this caller may not drive is
     refused there, with its own sentence, and nothing is pulled into it. */
  const owner = ASK_WORKER.get(ask.id)?.worker ?? scoped?.owner;
  const as = owner ?? (typeof ask.args.as === "string" && ask.args.as ? ask.args.as : undefined) ?? scoped?.as;
  if (laneRefusal(lane, as, false, typeof owner === "string" && !!owner.trim())) return null;
  /* Two first opens of one lane+site at once: the second waits for the
     sign-in the first started, so neither navigates before it is done. */
  const key = `${lane}\n${site}`;
  const running = VISIT_RUNNING.get(key);
  if (running) return running;
  /* A vault the open names wins over the lane's own, and lets a re-open
     after an ambiguous (or failed) first visit pull again. */
  const named = typeof ask.args.vault === "string" && ask.args.vault.trim() ? ask.args.vault.trim() : undefined;
  if (!tryVisitSite(lane, site, !!named)) return null;
  const p = visitPull(lane, site, named ?? rec.vault, as, owner).finally(() => VISIT_RUNNING.delete(key));
  VISIT_RUNNING.set(key, p);
  return p;
}

/* Container + site pairs already told they are not signed in, so the note is said once each. */
const CONTAINER_NOTED = new Set<string>();

/**
 * An `open`/`newtab` in an agent's own `--as` container (not a lane): that
 * container is a `persist:` partition on disk, and task-end sign-out closes
 * only lanes, so it is NEVER signed in from the vault. The first visit of each
 * site says so, with the command that gives a signed-in lane. The person's
 * Default container (no identity, `--shared`) gets nothing.
 */
function containerVaultNote(ask: BrowserAsk): Record<string, unknown> | undefined {
  if (ask.op !== "open" && ask.op !== "newtab") return undefined;
  const a = ask.args as Record<string, unknown>;
  if ((typeof a.lane === "string" && a.lane) || laneScope.getStore()?.lane) return undefined;
  if (a.shared === true || a.active === true || a.how === "shared") return undefined;
  const named = (v: unknown) => typeof v === "string" && !!v.trim() && v.trim().toLowerCase() !== SHARED_KEY;
  const box = named(a.profile) ? String(a.profile) : named(a.as) && a.profile === undefined ? String(a.as) : "";
  if (!box || typeof a.url !== "string") return undefined;
  let site = "";
  try {
    const u = new URL(a.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    site = siteOf(u.hostname);
  } catch { return undefined; }
  const key = `${containerOwner(box).toLowerCase()}\n${site}`;
  if (CONTAINER_NOTED.has(key)) return undefined;
  if (CONTAINER_NOTED.size >= 5000) CONTAINER_NOTED.clear();
  CONTAINER_NOTED.add(key);
  return {
    signedIn: false, site,
    why: "this container was not made by your own open (it is the person's, or was made before this server started), so it is not signed in from the vault; "
      + `for a signed-in one open it in a new container of your own (--as <new-name>), or run lane new --ephemeral --vault "<name>", then open ${a.url} --lane <id>`,
  };
}

type VisitResult = { vault?: Record<string, unknown>; fail?: BrowserReply };
/* The on-visit sign-in running now, by lane and site. */
const VISIT_RUNNING = new Map<string, Promise<VisitResult>>();

async function visitPull(lane: string, site: string, vault: string | undefined, as: string | undefined, owner: string | undefined): Promise<VisitResult> {
  const r = await composeVaultPull({
    id: nextId(), op: "lane", args: { action: "vault", id: lane, site, ...(vault ? { vault } : {}) },
  }, as, typeof owner === "string" && !!owner.trim(), true);
  if (r.ok) {
    markVisitSigned(lane, site);
    const v = r.value && typeof r.value === "object" ? r.value as Record<string, unknown> : {};
    /* The box as the person named it, not main's internal id; the id stays beside it. */
    return { vault: { signedIn: true, site, ...(typeof v.vault === "string" ? { vault: vaultDisplayName(v.vault), vaultId: v.vault } : {}) } };
  }
  /* The lane is gone (main answered `closed`, or a sensitive answer with no
     grant closed it): the `open` fails as one on a closed lane does. */
  const code = (r.value as { code?: unknown } | undefined)?.code;
  if (code === "closed") return { fail: { ok: false, error: noLaneError(lane) } };
  if (!laneKnown(lane)) return { fail: { ok: false, error: r.error ?? noLaneError(lane) } };
  if (typeof code === "string" && VISIT_QUIET.has(code)) return {};
  return { vault: { signedIn: false, site, why: r.error ?? "the sign-in failed; ask with browser_vault" } };
}

/**
 * Guide mode, composed here because the guide's state is the relay's: the
 * lock in `parseAsk` reads it, and the audit `guide end` returns is built from
 * what crossed this door. The panel draws the bubble and waits for the
 * person; it is told which tab, and which step, every time.
 */
async function composeGuide(ask: BrowserAsk, send: (a: BrowserAsk) => Promise<BrowserReply>): Promise<BrowserReply> {
  const as = typeof ask.args.as === "string" ? ask.args.as : "";
  const page = typeof ask.args.page === "string" ? ask.args.page : undefined;
  const verb = ask.op === "point" ? "point" : `guide ${String(ask.args.action)}`;
  const on = (tab: string, extra: Record<string, unknown> = {}) => send({ ...ask, args: { ...ask.args, page: tab, ...extra } });
  if (ask.op === "guide" && (ask.args.action === "start" || ask.args.action === "run")) {
    const isRun = ask.args.action === "run";
    let tab = page;
    /* A worker guides only the PERSON's tab (Settings ▸ Browser ▸ Worker verbs ▸
       Guide the person): the tab's row must say the default container. */
    const worker = ASK_WORKER.get(ask.id)?.worker;
    let rows: TabRow[] | undefined;
    if (!tab || worker) {
      const t = await send({ id: nextId(), op: "tabs", args: {} });
      if (!t.ok) return t;
      rows = tabRows(t.value);
    }
    if (!tab) {
      /* No tab named: the one in front, which is the one the person is looking at. */
      tab = activeBlock(rows ?? [])?.id;
      if (!tab) return { ok: false, error: "there is no tab to guide: open the page first (open <url>), then guide start" };
    }
    if (worker) {
      const why = personTabRefusal(worker, tab, rows ?? []);
      if (why) return { ok: false, error: why };
    }
    const st = startGuide(tab, as, String(ask.args.why));
    if ("error" in st) return { ok: false, error: st.error };
    /* The person is shown the guided page: a guide on a tab behind another one
       points at nothing they can see, and they cannot click what they cannot see. */
    const front = await toFront(tab, send);
    /* `agent` names who guides: the panel shows it, so the person sees which worker is talking. */
    const r = front.ok ? await on(tab, { action: "start", activity: guideActivity(tab, "start", { say: st.guide.why, ...(as ? { agent: as } : {}), ...(isRun ? { run: true } : {}) }) }) : front;
    if (!r.ok) {
      /* Never shown, so never a guide: the lock comes off at once. */
      finishGuide(st.guide, "agent");
      return r;
    }
    if (isRun) {
      const steps = ask.args.plan as PlanStep[];
      const run = startRun(st.guide, steps, worker);
      const d = await drawRunStep(st.guide, send);
      if (!d.ok) { finishGuide(st.guide, "agent"); return d; }
      const lint = lintPlan(steps);
      return { ok: true, value: {
        tab, why: st.guide.why, guiding: true, running: true, steps: run.steps.length,
        startedAt: new Date(st.guide.startedAt).toISOString(),
        ...(lint.length ? { warnings: lint } : {}),
        next: "guide next, again and again: each call returns the run's next event in order (step, back, navigated, input, submit, lost, resumed, run-done). guide end returns the audit. Acts on this tab are refused until guide end.",
      } };
    }
    return { ok: true, value: {
      tab, why: st.guide.why, guiding: true, startedAt: new Date(st.guide.startedAt).toISOString(),
      next: 'point <selector> --say "<what to do there>" [--wait-click], then guide next. Acts on this tab are refused until guide end.',
    } };
  }
  const g = guideFor(as, page);
  if (!g) {
    const gone = takeEnded(as, ask.args.action !== "end");
    if (gone && ask.args.action === "end") return { ok: true, value: guideAudit(gone) };
    if (gone) return { ok: false, error: `the guide has ended (${gone.endedBy === "stop" ? "the person pressed Stop" : gone.endedBy === "takeover" ? "the person took the tab over" : gone.endedBy === "closed" ? "the tab was closed" : gone.endedBy === "site" ? "the tab left the granted site, or the grant ended" : "it was idle too long"}): guide end returns the audit` };
    return { ok: false, error: `no guide is on${page ? ` in ${page}` : ""}: guide start "<why>" first` };
  }
  if (!sameCaller(g.as, as)) return { ok: false, error: othersRefusal(g, verb) };
  /* A worker's grant is for one site: a tab that moved off it, or a grant that
     ran out, ends the guide. `guide end` still collects the audit. */
  const worker = ASK_WORKER.get(ask.id)?.worker;
  if (worker && ask.args.action !== "end") {
    const t = await send({ id: nextId(), op: "tabs", args: {} });
    if (!t.ok) return t;
    const why = personTabRefusal(worker, g.tab, tabRows(t.value));
    if (why) return { ok: false, error: await endForSite(g, why, send) };
  }
  if (ask.op === "guide" && ask.args.action === "say") {
    const say = typeof ask.args.say === "string" ? ask.args.say : undefined;
    const suggest = typeof ask.args.suggest === "string" ? ask.args.suggest : undefined;
    const n = sayCurrent(g, say, suggest);
    if (n === undefined) return { ok: false, error: "there is no card to change yet: point first" };
    const r = await on(g.tab, { activity: guideActivity(g.tab, "say", { ...(say !== undefined ? { say } : {}), ...(suggest !== undefined ? { suggest } : {}) }) });
    if (!r.ok) { endIfGone(g, r.error); return r; }
    return { ok: true, value: { step: n, ...(say !== undefined ? { say } : {}), ...(suggest !== undefined ? { suggest: "on the card, in place of the old draft" } : {}) } };
  }
  if (g.run && ask.op === "point") {
    return { ok: false, error: "a plan is running on this tab: the server points each step. Change the words with guide say, or guide end first" };
  }
  if (g.run && ask.args.action === "next") {
    const ms = typeof ask.args.waitMs === "number" ? ask.args.waitMs : 25_000;
    const ev = await waitRunEvent(g, Math.min(25_000, ms));
    touchGuide(g);
    if (!ev) return { ok: true, value: { pending: true, step: g.run.index + 1, of: g.run.steps.length } };
    return { ok: true, value: ev };
  }
  if (ask.op === "point") {
    touchGuide(g);
    const label = typeof ask.args.step === "string" ? ask.args.step : undefined;
    const nm = label ? /^(\d+)\/(\d+)$/.exec(label.trim()) : null;
    const waitClick = ask.args.waitClick === true;
    const front = await toFront(g.tab, send);
    if (!front.ok) { endIfGone(g, front.error); return front; }
    const r = await on(g.tab, { n: g.steps.length + 1, activity: guideActivity(g.tab, waitClick ? "wait" : "point", {
      ...(nm ? { step: { n: Number(nm[1]), m: Number(nm[2]) } } : {}),
      say: String(ask.args.say), waitClick,
      ...(typeof ask.args.copy === "string" ? { copy: ask.args.copy } : {}),
      ...(typeof ask.args.suggest === "string" ? { suggest: ask.args.suggest } : {}),
      ...(typeof ask.args.summary === "string" ? { summary: ask.args.summary } : {}),
    }) });
    if (!r.ok) { endIfGone(g, r.error); return r; }
    const v = (r.value ?? {}) as { name?: unknown; role?: unknown; followed?: unknown; matched?: unknown };
    const step = addStep(g, {
      target: String(ask.args.selector), say: String(ask.args.say), waitClick: ask.args.waitClick === true,
      ...(label ? { label } : {}),
      ...(typeof ask.args.copy === "string" ? { copy: ask.args.copy } : {}),
      ...(typeof ask.args.suggest === "string" ? { suggest: ask.args.suggest } : {}),
      ...(typeof ask.args.summary === "string" ? { summary: ask.args.summary } : {}),
      ...(typeof v.name === "string" && v.name ? { name: v.name } : {}),
      ...(typeof v.role === "string" && v.role ? { role: v.role } : {}),
      followed: v.followed !== false,
    });
    return { ok: true, value: {
      step: step.n, ...(label ? { label } : {}), target: step.target,
      ...(step.name ? { name: step.name } : {}), ...(step.role ? { role: step.role } : {}),
      followed: step.followed,
      /* Several nodes matched: the panel ringed the first one on screen. */
      ...(typeof v.matched === "number" && v.matched > 1 ? { matched: v.matched, note: `${v.matched} nodes match; the first visible one is highlighted` } : {}),
      waiting: step.waitClick ? "the person's click on the target (or Back / Stop)" : "OK, Back or Stop",
    } };
  }
  if (ask.args.action === "next") {
    const r = await on(g.tab);
    if (!r.ok) { endIfGone(g, r.error); return r; }
    const v = (r.value ?? {}) as { event?: unknown; url?: unknown; expected?: unknown };
    touchGuide(g);
    if (v.event === undefined || v.event === null) {
      return { ok: true, value: { pending: true, step: g.steps.length || undefined } };
    }
    /* The person put the card's draft in the field. News for the agent, not
       the step's answer: the step stays open for OK, the click or Back. */
    /* The person asked for another draft: news, not the answer. Write one and send it with guide say --suggest. */
    if (v.event === "regenerate") {
      const cur = g.steps[g.steps.length - 1];
      const note = regenerateNote((r.value as { note?: unknown }).note);
      return { ok: true, value: { event: "regenerate", ...(cur ? { step: cur.n } : {}), ...(note ? { note } : {}), next: "write another draft and send it with guide say --suggest" } };
    }
    if (v.event === "suggest-inserted") {
      const cur = g.steps[g.steps.length - 1];
      if (cur) cur.suggestInsertedAt = g.lastAt;
      return { ok: true, value: { event: "suggest-inserted", ...(cur ? { step: cur.n } : {}) } };
    }
    if (!GUIDE_EVENTS.includes(v.event as GuideEvent)) return { ok: false, error: `the panel answered an event this server does not know: ${String(v.event)}` };
    const ev = v.event as GuideEvent;
    const url = typeof v.url === "string" ? v.url : undefined;
    const step = noteEvent(g, ev, url);
    if (worker && ev === "navigated" && url && !grantFor(worker, url)) {
      return { ok: false, error: await endForSite(g, noGrantRefusal(worker, url), send) };
    }
    const over = ev === "stop" || ev === "takeover" || ev === "closed";
    return { ok: true, value: {
      event: ev, ...(step ? { step: step.n } : {}),
      ...(typeof v.expected === "boolean" ? { expected: v.expected } : {}),
      ...(ev === "navigated" ? { navigated: true, ...(url ? { url } : {}) } : {}),
      ...(over ? { ended: true, next: "the person ended the guide: guide end returns the audit" } : {}),
    } };
  }
  /* end: the bubble comes down if the panel can still hear; the lock comes off either way. */
  if (g.run) endRun(g, "agent");
  await on(g.tab, { activity: guideActivity(g.tab, "end") }).catch(() => undefined);
  finishGuide(g, "agent");
  return { ok: true, value: guideAudit(g) };
}

/** Why a worker may not guide or read `tab`: not in the window, not the
 *  person's own container, or no live grant for this worker on its site. */
function personTabRefusal(worker: string, tab: string, rows: readonly TabRow[]): string | null {
  const row = rows.find((r) => r.id === tab);
  const box = row ? foldWorkerName(row.profile ?? "") : "";
  if (!row || (box && box !== "default") || isAgentContainer(box)) {
    return `this credential was minted for an agent, and ${tab} is not a tab of the person's own container: a worker guides the person on their own tab only.`;
  }
  return grantFor(worker, row.url) ? null : noGrantRefusal(worker, row.url ?? "");
}

/** The guided tab left the granted site: the guide ends, and the bubble comes down. */
async function endForSite(g: Parameters<typeof noteEvent>[0], why: string, send: (a: BrowserAsk) => Promise<BrowserReply>): Promise<string> {
  finishGuide(g, "site");
  await send({ id: nextId(), op: "guide", args: { action: "end", page: g.tab, activity: guideActivity(g.tab, "end") } }).catch(() => undefined);
  return `${why} The guide has ended: guide end returns the audit.`;
}

/** A worker's read of the person's tab, checked against the tab's site now:
 *  null when it is the worker's own page or a guided tab on a granted site.
 *  Fails closed: the gate ran before this, and the person may have pressed
 *  Stop since, so a tab that is not the worker's own is served only while
 *  its own guide runs there at this moment, checked again after the tab list. */
/* Null, not a promise of null, when the ask is not a read of somebody else's
   page: like `visitSignIn`, nothing may be awaited before an ask is parked. */
function guideReadRefusal(worker: string, ask: BrowserAsk, send: (a: BrowserAsk) => Promise<BrowserReply>): Promise<string | null> | null {
  if (!GUIDE_READS.has(ask.op) || ask.op === "tabs") return null;
  const page = typeof ask.args.page === "string" ? ask.args.page : "";
  if (!page || workerOwnsPage(worker, page)) return null;
  return guidedReadRefusal(worker, page, send);
}

async function guidedReadRefusal(worker: string, page: string, send: (a: BrowserAsk) => Promise<BrowserReply>): Promise<string | null> {
  const notGuiding = `this credential was minted for an agent, and it reads the person's tab only while its own guide runs there: `
    + `no guide of yours runs on ${page} now. guide start "<why>" --shared first.`;
  const g = guideOf(page);
  if (!g || !sameCaller(g.as, worker)) return notGuiding;
  const t = await send({ id: nextId(), op: "tabs", args: {} });
  if (!t.ok) return t.error ?? "the tab list did not answer";
  if (guideOf(page) !== g) return notGuiding;
  const why = personTabRefusal(worker, page, tabRows(t.value));
  return why ? endForSite(g, why, send) : null;
}

/**
 * Draws the run's current step on the person's card: a `point` the relay
 * composes from the plan (a selector, the words, the wait), tagged with the
 * visit the panel echoes on every event it posts back. It only points: the
 * panel's `point` reads the page and rings the target, it never acts.
 */
async function drawRunStep(g: Guide, send: (a: BrowserAsk) => Promise<BrowserReply>): Promise<BrowserReply> {
  const run = g.run!;
  const s = run.steps[run.index]!;
  const visit = visitSeq(run);
  const activity = guideActivity(g.tab, s.wait === "click" ? "wait" : "point", {
    step: { n: run.index + 1, m: run.steps.length }, say: s.say, waitClick: s.wait === "click",
    ...(s.copy ? { copy: s.copy } : {}),
    ...(s.summary ? { summary: s.summary } : {}),
    ...(s.suggest ? { suggest: s.suggest } : {}),
  });
  const r = await send({ id: nextId(), op: "point", args: {
    page: g.tab, ...(s.target ? { selector: s.target } : {}), ...(s.text ? { text: s.text } : {}), ...(s.suggest ? { suggest: s.suggest } : {}),
    say: s.say, wait: s.wait, waitClick: s.wait === "click", run: { visit }, activity,
  } });
  /* A target not on the page yet is not lost here: the panel's watcher
     waits for it and posts lost only after 2 s with none. */
  return r;
}

/** The card's sentence when the step's target is not on the page. The person
 *  never wrote the selector, so it is said in words: the step's text, else the
 *  name or words inside a locator (role=link[name="History"] is "History"),
 *  else "it". Never the raw selector. Plan text, kept as text. */
export function lostSay(s: Pick<PlanStep, "text" | "target">): string {
  const words = (s.text ?? "").trim() || targetWords(s.target ?? "");
  return words ? `Can't find "${words}" on this page. Back?` : "Can't find it on this page. Back?";
}

/** The words a locator names a thing by, or "" for CSS, an id or a test id. */
function targetWords(raw: string): string {
  const role = /^role=[^\[]*\[\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\]]*))/.exec(raw);
  const plain = /^(?:text|label|placeholder)=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(.*))$/.exec(raw);
  const m = role ?? plain;
  if (!m) return "";
  return String(m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1").replace(/\s+/g, " ").trim();
}

/**
 * POST /browser/guide/event: the panel's report of the person's hand (a click
 * on the target, typing, a submit, a navigation, the target lost) or of the
 * card's buttons, for a running plan. The server moves the plan on here, with
 * no agent call. Window-only: the route refuses an agent's credential.
 */
export async function guidePanelEvent(body: unknown, sendTo?: (a: BrowserAsk) => Promise<BrowserReply>): Promise<{ ok: boolean; error?: string; value?: Record<string, unknown> }> {
  const send = sendTo ?? ((a: BrowserAsk) => (asker ? asker(a) : askWithRetry(a)));
  const b = (body ?? {}) as Record<string, unknown>;
  const tab = typeof b.tab === "string" ? b.tab : "";
  const event = typeof b.event === "string" ? b.event : "";
  if (!tab) return { ok: false, error: "tab is the guided tab's id" };
  const KNOWN = ["ok", "back", "stop", "click", "navigated", "input", "submit", "lost", "found", "done", "resume", "regenerate"];
  if (!KNOWN.includes(event)) return { ok: false, error: `event is one of ${KNOWN.join(", ")}` };
  const url = typeof b.url === "string" && b.url.length <= 4000 ? b.url : undefined;
  const visit = typeof b.visit === "number" ? b.visit : undefined;
  /* "Suggest another" on a run's card: news for the agent's guide next; the step stays on. */
  if (event === "regenerate") {
    const rg = guideOf(tab);
    if (!rg?.run || rg.run.endedAt) return { ok: true, value: { known: false } };
    if (visit !== undefined && visit !== visitSeq(rg.run)) return { ok: true, value: { known: false } };
    regenerateRun(rg, regenerateNote(b.note));
    return { ok: true, value: { regenerate: true } };
  }
  if (event === "resume") {
    const r = resumeRun(tab);
    if ("error" in r) return { ok: false, error: r.error };
    const g = r.guide;
    await send({ id: nextId(), op: "guide", args: { action: "start", page: tab, activity: guideActivity(tab, "start", { say: g.why, ...(g.as ? { agent: g.as } : {}), run: true }) } }).catch(() => undefined);
    const d = await drawRunStep(g, send);
    return d.ok ? { ok: true, value: { resumed: true, step: g.run!.index + 1 } } : { ok: false, error: d.error };
  }
  const g = guideOf(tab);
  /* Stop first, ended run or not: after done, overflow or a restart the
     guide still holds the tab, and the person's Stop is what frees it. */
  if (event === "stop" && g?.run) {
    runInput(g, { event: "stop", ...(url ? { url } : {}) });
    finishGuide(g, "stop");
    return { ok: true, value: { ended: true, resumable: g.run.endedBy !== "done" && g.run.endedBy !== "overflow" } };
  }
  if (!g?.run || g.run.endedAt) return { ok: true, value: { known: false } };
  const change = runInput(g, { event: event as PanelEvent["event"], ...(visit !== undefined ? { visit } : {}), ...(url ? { url } : {}) });
  const run = g.run;
  /* A worker's grant is for one site: the person following a link off it ends the guide. */
  if (event === "navigated" && run.worker && url && !grantFor(run.worker, url)) {
    await endForSite(g, noGrantRefusal(run.worker, url), send);
    return { ok: true, value: { ended: true } };
  }
  if (change === "step" && !run.endedAt) {
    const d = await drawRunStep(g, send);
    if (!d.ok) return { ok: false, error: d.error };
  } else if (change === "lost") {
    const v = currentVisit(run);
    if (v) await send({ id: nextId(), op: "guide", args: { action: "say", page: tab, activity: guideActivity(tab, "say", { say: lostSay(run.steps[run.index]!), lost: true, ...(run.steps[run.index]!.wait === "ok" ? { skip: true } : {}) }) } }).catch(() => undefined);
  } else if (change === "found") {
    await send({ id: nextId(), op: "guide", args: { action: "say", page: tab, activity: guideActivity(tab, "say", { say: run.steps[run.index]!.say }) } }).catch(() => undefined);
  }
  return { ok: true, value: { change, step: run.index + 1, of: run.steps.length, ...(run.endedAt ? { ended: true, endedBy: run.endedBy } : {}) } };
}

/** Brings the guided tab to the front. Selecting a tab is not an act on its page. */
function toFront(tab: string, send: (a: BrowserAsk) => Promise<BrowserReply>): Promise<BrowserReply> {
  return send({ id: nextId(), op: "tab", args: { id: tab } });
}

/* What the panel draws for this guide verb; the observer in Electron main adds the live rect. */
function guideActivity(tab: string, phase: GuideActivity["phase"], extra: Omit<GuideActivity, "kind" | "tab" | "phase"> = {}): GuideActivity {
  return { kind: "guide", tab, phase, ...extra };
}

/* A guide whose tab the panel no longer has, or the person took over, is over. */
function endIfGone(g: Parameters<typeof noteEvent>[0], error: string | undefined): void {
  const e = error ?? "";
  if (/^no tab called|no tab is open/.test(e)) noteEvent(g, "closed");
  else if (/took this tab over/.test(e)) noteEvent(g, "takeover");
}

/** The retry loop, on its own so a composed verb reaches it too. `profiles`
 *  called `askOnce` for its name list and so never retried — measured, a
 *  "view is not open" cost `tabs` nine asks and `profiles` three, while
 *  `profiles` still sat in IDEMPOTENT claiming otherwise. */
async function askWithRetry(ask: BrowserAsk): Promise<BrowserReply> {
  let last = await askOnce(ask);
  if (last.ok || !IDEMPOTENT.has(ask.op) || !WORTH_RETRY.test(last.error ?? "")) return last;
  /*
   * And only while there IS a window. A closed window is not a gap to wait
   * out — nothing is going to open it in the next second — so retrying there
   * spends the clock to arrive at the same sentence, which is what the "fails
   * at once, and says why" lock is about. What is worth waiting for is the
   * PANEL, which de-registers for a moment when its tab changes.
   */
  if (!sink || sink.listeners() === 0) return last;
  /*
   * And only when a panel IS registered and did not answer. With none
   * registered the failure is "there is no browser pane", which the CLI fixes
   * by opening one — it cannot be waited out here, and retrying first means
   * the caller's own retry starts a second and a half late and runs past its
   * timeout. Eight CLI tests found that within the minute.
   *
   * What is left is the case this exists for: a panel that IS there and was
   * between states, which is the gap a tab change opens.
   */
  if (browserReadyCount() === 0) return last;
  for (const wait of [250, 1000]) {
    await new Promise((r) => setTimeout(r, wait));
    /* A fresh id: the old one may still be pending on the panel's side, and
       two answers arriving for one id is how a reply lands on the wrong ask. */
    last = await askOnce({ ...ask, id: nextId() });
    if (last.ok || !WORTH_RETRY.test(last.error ?? "")) return last;
  }
  return last;
}

/** The relay's `whoami` value from a window's tab list. Exported so a test's
 *  fixture is the real composition rather than a hand-typed shape. */
export function whoamiValue(args: Record<string, unknown>, tabs: unknown):
  { you: ReturnType<typeof youBlock>; activeTab: ReturnType<typeof activeBlock> } {
  const rows = tabRows(tabs);
  return { you: youBlock(args, rows), activeTab: activeBlock(rows) };
}

async function composeWhoami(ask: BrowserAsk): Promise<BrowserReply> {
  const tabs = await askBrowser({ id: nextId(), op: "tabs", args: {} });
  if (!tabs.ok) {
    recordAudit("whoami", ask.args, false, tabs.error);
    return tabs;
  }
  const value = whoamiValue(ask.args, tabs.value);
  recordAudit("whoami", ask.args, true, undefined);
  return { ok: true, value };
}

/**
 * `profiles --drop`, with the ledger kept honest around it.
 *
 * The refusal itself is in `parseAsk`, above the wire, so a caller aiming at
 * somebody else's container pays no round trip and the refusal lands in the
 * audit next to the allow-list ones. What is left for here is the two things
 * that can only be said once the window has answered:
 *
 *   - a container nobody is on record as creating was allowed through, and the
 *     caller should be told that is what happened rather than reading silence
 *     as "it was mine". Every container that predates the ledger is in this
 *     state, which is why it is a warning and not a refusal.
 *   - a container that is genuinely gone stops being claimed, so the next
 *     agent to mint the name is its creator instead of inheriting a stranger's.
 */
async function composeDrop(ask: BrowserAsk): Promise<BrowserReply> {
  const name = String(ask.args.drop);
  const rec = containerRecord(name);
  const made = madeNamed(name);
  const reply = await askOnce(ask);
  if (!reply.ok) return reply;
  forgetContainer(name);
  /* Dropped: the vault's cookies are removed by the book (the jar goes too),
     and the id is nobody's any more. */
  for (const id of made) {
    await wipeSignIns(signInsWhere((s) => s.container === id), "container dropped").catch(() => false);
    forgetMadeContainer(id);
  }
  const v = (reply.value && typeof reply.value === "object" ? reply.value : {}) as Record<string, unknown>;
  const unclaimed = !rec?.creator;
  return {
    ok: true,
    value: {
      ...v,
      creator: rec?.creator ?? null,
      ...(unclaimed
        ? { warning: `nobody was on record as creating "${name}" — it predates the ownership ledger, or was made by a caller that sent no identity. It was dropped with everything in it: tabs, cookies, storage.` }
        : {}),
    },
  };
}

/**
 * `lane new | list | close`, answered by the relay's own table; only making and
 * destroying a host reaches a window (askOnce, `managing`). Audited like every
 * other verb, so "which lanes did that agent open" is in the same log.
 */
const wireLanes = (): void => configureLanes({
  manage: (args) => askOnce({ id: nextId(), op: "lane", args }),
  hosted: laneHosted,
  forget: forgetLaneHost,
});
wireLanes();

async function composeLane(ask: BrowserAsk): Promise<BrowserReply> {
  /* A worker's lane list is its own even when the ask names nobody: the list
     without `as` names every caller's lane, and the credential already says
     whose it is. And "its own" is strict — a lane made by a caller with no
     identity, or with `shared: true`, belongs to the person's side, and the
     fact that the worker can read the list was the hole. */
  const principal = ASK_WORKER.get(ask.id)?.worker;
  const as = principal ?? (typeof ask.args.as === "string" ? ask.args.as : undefined);
  let reply: BrowserReply;
  if (ask.args.action === "list") {
    reply = {
      ok: true,
      value: {
        lanes: principal
          ? listOwnedLanes(principal)
          : listLanes(ask.args.force === true ? undefined : as),
      },
    };
  } else if (ask.args.action === "vault") {
    reply = await composeVaultPull(ask, as, !!principal);
    /* The box as the person named it; the id stays beside it. */
    if (reply.ok && reply.value && typeof (reply.value as { vault?: unknown }).vault === "string") {
      const v = reply.value as Record<string, unknown> & { vault: string };
      reply = { ...reply, value: { ...v, vault: vaultDisplayName(v.vault), vaultId: v.vault } };
    }
  } else if (ask.args.action === "vaults") {
    reply = { ok: true, value: { vaults: vaultNames() } };
  } else if (ask.args.action === "close") {
    const r = await closeLane(String(ask.args.id), as, ask.args.force === true, !!principal);
    if (r.ok) forgetVaultLane(String(ask.args.id));
    reply = r.ok ? { ok: true, value: { closed: ask.args.id } } : { ok: false, error: r.error };
  } else {
    const r = await openLane(as, ask.args.container as "private" | "shared" | "named" | "ephemeral", typeof ask.args.name === "string" ? ask.args.name : undefined,
      typeof ask.args.vault === "string" && ask.args.vault ? ask.args.vault : undefined);
    reply = r.ok ? { ok: true, value: { lane: r.lane } } : { ok: false, error: r.error };
  }
  recordAudit("lane", ask.args, reply.ok, reply.error);
  return reply;
}

/*
 * `lane vault ID --site S` (and `browser_vault`): sign one ephemeral lane in
 * to one site from the login vault (plan parts C and D). The server never
 * holds a value: it asks the app window, which asks Electron main, which
 * spawns the vault helper and answers with counts. Read-only mode is refused
 * before any of that (isActing).
 *
 * A sensitive site is OKed by Electron main itself: a native dialog (Deny by
 * default, five minutes then Deny), and main's report of the yes on its own
 * key (POST /vault/ok), which mints the grant checked here. A yes the window
 * makes up finds no grant. On
 * success the lane is marked, so verbs that could read the login back out are
 * refused there from now on (F7).
 */
/* The vault helper's read, plus main's own dialog for a sensitive site: the
   person has five minutes there, then it is a no. */
const VAULT_PULL_MS = VAULT_ASK_MS + 30_000;
/* A sign-in on a first visit asks nobody: the helper's read alone. Main is
   given 5 s less as its own deadline, so it always gives up first and wipes
   what it set (it cannot be cancelled from here). */
export const VAULT_VISIT_MS = 30_000;
const VAULT_VISIT_BUDGET_MS = VAULT_VISIT_MS - 5_000;

/* Each vault as `--vault` takes it, with how many sites it holds. Read from
   the index only: no key is opened and no site, cookie or value is in it. */
function vaultNames(): { name: string; id: string; sites: number }[] {
  let all: ReturnType<typeof listVaults> = [];
  try { all = listVaults(); } catch { /* no vault yet */ }
  all.sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id));
  const names = vaultChoiceNames(all);
  return all.map((v, i) => ({ name: names[i]!, id: v.id, sites: v.sites }));
}

async function composeVaultPull(ask: BrowserAsk, as: string | undefined, worker: boolean, onVisit = false): Promise<BrowserReply> {
  const lane = String(ask.args.id);
  const site = String(ask.args.site);
  const mine = laneRefusal(lane, as, false, worker);
  if (mine) return { ok: false, error: mine };
  const vault = ask.args.vault;
  /* Guarded before the ask goes out (finding 1): main sets cookies before it
     answers, so a mark put on after the answer left a gap a read could use. */
  vaultPulling.set(lane, (vaultPulling.get(lane) ?? 0) + 1);
  let r: BrowserReply;
  try {
    r = await askOnce({
      id: nextId(), op: "lane",
      args: {
        vaultPull: {
          lane, site, agent: as ?? "", ...(typeof vault === "string" && vault ? { vault } : {}),
          /* deadlineAt is fixed HERE, when the server starts waiting: a window
             that is busy and reads the ask late still stops in time. */
          ...(onVisit ? { onVisit: true, budgetMs: VAULT_VISIT_BUDGET_MS, deadlineAt: Date.now() + VAULT_VISIT_BUDGET_MS } : {}),
        },
      },
    }, onVisit ? VAULT_VISIT_MS : VAULT_PULL_MS);
  } finally {
    const left = (vaultPulling.get(lane) ?? 1) - 1;
    if (left > 0) vaultPulling.set(lane, left); else vaultPulling.delete(lane);
  }
  const got = r.ok && r.value && typeof r.value === "object" ? r.value as Record<string, unknown> : null;
  if (!got && onVisit) {
    /* No answer to a sign-in on visit: main stops itself at its own deadline
       and wipes what it set, so the lane is not closed. It is marked, so the
       task-end sign-out covers it, and the site stays tried: no second pull. */
    markVaultLane(lane);
    return { ok: false, error: "the sign-in did not finish in time; the page is signed out; ask with browser_vault", value: { code: "no-answer" } };
  }
  if (!got) {
    /* No answer: main may have set some cookies before it went quiet. The
       lane is closed, never left open and unguarded. */
    markVaultLane(lane);
    await closeLane(lane, as, false, worker).catch(() => null);
    forgetVaultLane(lane);
    return r.ok ? { ok: false, error: "the window did not answer the pull: the lane was closed" } : { ...r, error: `${r.error ?? "the pull failed"}: the lane was closed` };
  }
  if (got.ok !== true) {
    /* Main answers no before it sets anything, except three codes: `closed`
       (the lane is gone and main wiped its jar), `no-guard` (no cookie was set
       yet; the guard the server took sits on an empty jar) and `late` (a
       sign-in on visit past main's deadline: main wiped what it set). In each
       the lane holds no vault login. */
    /* Main sends `{ id, label }` for each vault (pullSite). Shown as the name
       `--vault` takes back: the label, or the id when two share a label. */
    const rows = Array.isArray(got.vaults)
      ? got.vaults.flatMap((v): { id: string; label: string }[] => {
        if (typeof v === "string") return [{ id: v, label: v }];
        const o = v && typeof v === "object" ? v as Record<string, unknown> : null;
        return o && typeof o.id === "string" ? [{ id: o.id, label: typeof o.label === "string" ? o.label : "" }] : [];
      })
      : undefined;
    let known: { id: string; label: string }[] = [];
    try { known = listVaults(); } catch { /* the index is unreadable: use the answer's own */ }
    const vaults = rows ? vaultChoiceNames(rows, [...rows, ...known.filter((k) => !rows.some((r) => r.id === k.id))]) : undefined;
    return {
      ok: false,
      error: got.code === "ambiguous"
        ? `${site} is in more than one vault: ask the person which, then pass --vault NAME, one of: ${(vaults ?? []).map((v) => JSON.stringify(v)).join(", ") || "(none listed: run `agentglass-browser vault --list`)"}`
        : String(got.error ?? "the pull failed"),
      ...(vaults ? { value: { code: "ambiguous", vaults } } : {}),
      ...(got.code === "expired" ? { value: { code: "expired", reason: "expired", site, asked: "person" } } : {}),
      /* On visit the caller reads main's code (off, none, closed...). */
      ...(onVisit && got.code !== "ambiguous" && got.code !== "expired" ? { value: { code: typeof got.code === "string" ? got.code : "" } } : {}),
    };
  }
  /* A sensitive site is granted here only on main's own report of the
     person's yes (POST /vault/ok, main key). The answer came back through the
     window, so a yes the window made up finds no grant: the lane is closed. */
  if (got.sensitive === true && !takeVaultGrant(lane, site)) {
    markVaultLane(lane);
    await closeLane(lane, as, false, worker).catch(() => null);
    forgetVaultLane(lane);
    return { ok: false, error: `${site} is marked sensitive and Electron main did not report the person's OK: the lane was closed` };
  }
  /* No sign-out setting from this answer: it came back through the window,
     and the window must not mark or unmark a lane (New 1). Main's own
     /vault/lane report, before the first cookie, is the only source. */
  markVaultLane(lane);
  /* Counts and labels only: main sent nothing else, and nothing else goes on. */
  const keep = ["site", "vault", "label", "sensitive", "set", "failed", "partitioned", "session", "storage"];
  return { ok: true, value: Object.fromEntries(keep.filter((k) => got![k] !== undefined).map((k) => [k, got![k]])) };
}

async function composeProfiles(ask: BrowserAsk): Promise<BrowserReply> {
  const names = await askWithRetry(ask);
  if (!names.ok) return names;
  const tabs = await askBrowser({ id: nextId(), op: "tabs", args: {} });
  const rows = tabs.ok ? tabRows(tabs.value) : [];
  const listed = (names.value as { profiles?: unknown } | undefined)?.profiles;
  const bare = Array.isArray(listed) ? listed.filter((n): n is string => typeof n === "string") : [];
  const you = youBlock(ask.args, rows);
  const active = activeBlock(rows);

  /*
   * `names` IS RETAINED VERBATIM. Every existing reader — the MCP tool, the
   * skill's examples, a shell script somebody wrote once — reads the old flat
   * list, and the detail arrives in new keys beside it rather than in place of
   * it. §11's own compatibility note: a caller reading `value.profiles[0]` as
   * a string moves to `value.names[0]`, and that is the whole migration.
   *
   * `id` is NOT here. The panel exposes containers as bare names
   * (`BrowserPanel.tsx`, `profiles: () => profilesRef.current.map(p => p.name)`)
   * and the id never crosses the wire, so emitting the key would mean emitting
   * `null` for every row — a field that looks like data and never is.
   */
  const detail = bare.map((name) => {
    const rec = containerRecord(name);
    const owned = rows.filter((r) => (r.profile ?? "default") === name);
    return {
      name,
      /* "mine" is the caller's assertion checked against the ledger, not a
         guess from the tab list: an identity that made a container and has not
         opened a tab in it yet still owns it. */
      mine: !!you.identity && rec?.creator === you.identity,
      creator: rec?.creator ?? null,
      tabs: owned.length,
      ownsActive: !!active && (active.profile ?? "default") === name,
      lastActivityMs: rec?.lastSeenMs ?? null,
    };
  });
  return { ok: true, value: { you, activeTab: active, profiles: detail, names: bare } };
}

function askOnce(ask: BrowserAsk, timeoutMs?: number): Promise<BrowserReply> {
  // Two different absences, said differently, because only one of them can be
  // fixed by the caller. Collapsing them cost a working feature for one build:
  // with the pane simply not opened yet, the answer said the window was shut,
  // so the CLI — which knows how to open a pane and not how to open a window —
  // stopped instead of retrying.
  /*
   * `health` ANSWERS these two questions instead of failing them.
   *
   * Found by using it: `health` refused with "the browser view is not open in
   * this window", which is exactly the fact it exists to report. A diagnostic
   * verb that fails on the condition it diagnoses tells a caller nothing it
   * did not already know from the failure, and sends it looking for a second
   * way to ask — which is the shape §15 was written against.
   *
   * So it short-circuits here, above the two gates, and always succeeds. What
   * it returns is the truth about each layer, named, so the next move is
   * obvious from the answer rather than from a guess.
   */
  const windowOpen = !!sink && sink.listeners() > 0;
  const panelMounted = browserReadyCount() > 0;
  /* `whoami` short-circuits in `askBrowser`, above this. Reaching here means a
     caller went round that door, and forwarding it would ask the window a
     question about a process it has never seen. Refused by name rather than
     cast into a wire op — and this is also what narrows `op` for the send. */
  const op = ask.op;
  if (op === "whoami") {
    return Promise.resolve({ ok: false, error: "whoami is answered by the relay, not by the window" });
  }
  if (ask.op === "health") {
    const summary = !windowOpen
      ? "window: closed — the browser lives inside the agentglass window, so nothing can answer"
      : !panelMounted
        ? "window: open · panel: not mounted — open the browser view, or call `open <url>` which mounts one"
        : "window: open · panel: mounted · ready";
    return Promise.resolve({
      ok: true,
      value: { window: windowOpen, panel: panelMounted, ready: windowOpen && panelMounted, summary },
    });
  }
  if (!windowOpen) {
    return Promise.resolve({ ok: false, error: "the agentglass window is not open — the browser lives in it" });
  }
  /* A lane-management ask goes to the window that makes hosts, and needs no
     panel: an agent that has no Browser view is exactly who opens a lane. */
  const managing = ask.op === "lane";
  if (!panelMounted && !managing) {
    return Promise.resolve({ ok: false, error: "the browser view is not open in this window" });
  }
  /* The lane the REQUEST named, even for an ask this relay composed itself (a
     `do` step, a recording's frame, a download's click): they inherit it from
     the request scope, so no verb has to remember to carry it. */
  const scoped = laneScope.getStore();
  if (scoped && ask.op !== "lane" && ask.args.lane === undefined) ask = { ...ask, args: { ...ask.args, lane: scoped.lane } };
  const lane = ask.args.lane;
  if (typeof lane === "string") {
    /* Never a fallback to the visible tab: an agent that lost its lane must
       not start clicking in the person's window. A credential's principal is
       stricter than the self-asserted `as`: only a lane it made qualifies. */
    const owner = ASK_WORKER.get(ask.id)?.worker ?? scoped?.owner;
    const msg = laneRefusal(
      lane,
      owner ?? ask.args.as ?? scoped?.as,
      scoped?.force === true,
      typeof owner === "string" && !!owner.trim(),
    ) ?? vaultLaneRefusal(ask.op, lane);
    if (msg) {
      recordAudit(ask.op, ask.args, false, msg);
      return Promise.resolve({ ok: false, error: msg });
    }
  }
  touchLane(lane);
  const target = managing ? pickManager() : pickTarget(lane);
  if (!target && managing) {
    return Promise.resolve({ ok: false, error: "the agentglass window is not open — it is what makes a lane's window" });
  }
  if (!target) {
    return Promise.resolve({
      ok: false,
      error: typeof ask.args.lane === "string" && ask.args.lane
        ? `no window hosts lane "${ask.args.lane}"`
        : "the browser view is not open in this window",
    });
  }
  return new Promise<BrowserReply>((resolve) => {
    /* Redaction and the audit line happen here, at the one seam every op
     * passes through on its way back to a caller — not in the panel, which
     * this relay cannot trust to have done it, and not per-verb, which is
     * exactly the "somebody forgot to mark this one" shape §16 is about. */
    const settle = (r: BrowserReply): void => {
      /* One tally for the REPLY only. The audit line runs its own redaction
         over the ask below, and counting both here would report spans the
         caller never saw. */
      const tally: RedactionTally = new Map();
      const redacted: BrowserReply = {
        ok: r.ok,
        value: redactValue(r.value, undefined, tally),
        error: r.error,
        diagnosis: r.diagnosis === undefined ? undefined : redactValue(r.diagnosis, "diagnosis", tally),
      };
      /* The panel's verdict travels one way: it decides what the log keeps,
         and is then dropped rather than handed to the caller, who has no use
         for being told the field it just typed into was a password. */
      const v = r.value as { secretField?: boolean; secretFields?: unknown } | undefined;
      const wasSecret = v?.secretField === true;
      /* The multi-field form of the same verdict: `fill` names the fields the
         panel saw were secret, on a refusal too — the fields before the one
         that failed were filled. The selector heuristic still covers a field
         the panel could not judge. */
      const namedSecret = Array.isArray(v?.secretFields)
        ? (v!.secretFields as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined;
      /* A lane's page reports visibilityState "hidden" after it navigates though
         it paints (measured, electron/main.js above createLaneHost). An
         observation says `visible: false` and means "behaves like a background
         tab", which sends a reader to open the pane: so it says which lane it
         came from, and the CLI does not raise the alarm for one. The page's own
         answer is left alone. */
      if (typeof ask.args.lane === "string" && redacted.value && typeof redacted.value === "object" && "visible" in redacted.value) {
        (redacted.value as Record<string, unknown>).lane = ask.args.lane;
      }
      if (redacted.value && typeof redacted.value === "object") {
        if (wasSecret) delete (redacted.value as Record<string, unknown>).secretField;
        if (namedSecret) delete (redacted.value as Record<string, unknown>).secretFields;
      }
      if (tally.size > 0) {
        let spans = 0;
        const fields: Record<string, number> = {};
        for (const [key, n] of tally) { spans += n; fields[key] = n; }
        redacted.redacted = { spans, fields };
      }
      /* WHERE IT ACTUALLY LANDED, when the panel says so (§8). The request's
         own `page` is what was ASKED for; this is what answered, and on a
         plain `open` those were not always the same tab. When the reply names
         neither, `recordAudit` falls back to the address on the request —
         which is still better than the nothing this line used to record. */
      const named = r.value as { tab?: unknown; profile?: unknown } | undefined;
      recordAudit(ask.op, ask.args, redacted.ok, redacted.error,
        { field: wasSecret, fields: namedSecret }, {
          tab: typeof named?.tab === "string" ? named.tab : undefined,
          owner: typeof named?.profile === "string" ? named.profile : undefined,
        });
      /* Every ask is forgotten when it settles, timeout and closed socket
         included: only a reply used to clear it, so a worker could grow the
         map with asks no window ever answered. */
      ASK_WORKER.delete(ask.id);
      resolve(redacted);
    };
    const timer = setTimeout(() => { // loop-ok: rejects one pending ask
      pending.delete(ask.id);
      settle({ ok: false, error: `the browser did not answer in time (${ask.op})` });
    }, timeoutMs ?? TIMEOUT_MS[ask.op]);
    pending.set(ask.id, { resolve: settle, timer, target });
    /* Re-built rather than cast, so the narrowing above is what proves the op
       is sendable. A cast here would pass a verb the panel cannot answer and
       the caller would get "not a tab operation" from three layers down. */
    if (sink!.send({ id: ask.id, op, args: ask.args }, target) === false) {
      /* Registered, but its socket is gone (a reload between heartbeats). Said
         now instead of after the timeout. Kept registered: its new hello lands
         within a retry, and dropping it here made the caller open a second view. */
      settle({ ok: false, error: "the browser view is not open in this window" });
    }
  });
}

/** The panel reporting back. Unknown ids are dropped rather than logged loudly:
 *  a reply arriving after its timeout is ordinary, not an error. */
export function settleBrowser(id: unknown, reply: BrowserReply, from?: string): boolean {
  if (typeof id !== "string") return false;
  const p = pending.get(id);
  if (!p) return false;
  /* Only the window the ask was addressed to may answer it. `from` undefined is
     the in-process caller (tests); the HTTP route always passes one. */
  if (from !== undefined && p.target !== undefined && p.target !== from) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  recordWorkerReply(id, reply);
  p.resolve(reply);
  return true;
}

/** A window's socket closed: the asks it already sent will never be answered. Said
 *  now, because a click or a fill may have run before it went and the caller
 *  cannot tell from a timeout. */
export function dropBrowserTarget(clientId: string): void {
  for (const [id, p] of pending) {
    if (p.target === clientId) { pending.delete(id); clearTimeout(p.timer); p.resolve({ ok: false, error: "the window closed before answering" }); }
  }
}

/** For tests, and for a shutdown that should not leave timers behind. */
export function resetBrowserDrive(): void {
  NAMED_TABS.clear();
  LAST_OBSERVED.clear();
  ready.clear();
  managers.clear();
  resetLanes();
  VISIT_RUNNING.clear();
  CONTAINER_NOTED.clear();
  resetVaultContainers();
  leftoversDone = false;
  leftovers = null;
  resetWorkerPages();
  resetGuides();
  resetGuideGrants();
  wireLanes();
  for (const [, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: "cancelled" }); }
  pending.clear();
  sink = null;
  seq = 0;
}

/** How many requests are in flight — the panel's own health readout, and a
 *  guard in tests against a leak that only shows up as a slow suite. */
export const pendingBrowserCount = () => pending.size;

/** The redaction rule, reachable from a test. Exported rather than re-derived
 *  in the test file: a copy of a security rule drifts from the original, and
 *  the copy is the one that stays green. */
export const redactAskForTest = redactAsk;
