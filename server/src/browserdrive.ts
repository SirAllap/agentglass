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

import { isIP } from "node:net";
/* Static rather than the `await import("node:fs")` the async helpers below
   use: `recordAudit` is synchronous and on the path of every verb, and a
   dynamic import there would make the log's write order depend on the
   microtask queue. */
import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { configPath, inScope, workspaceRoot } from "./config.ts";
import { diskAllows, diskEnabled } from "./disk.ts";

/** What the panel can be asked to do. Each one is implemented there; nothing
 *  here is interpreted, and there is deliberately no `eval`. */
/*
 * TABS, which the browser has had all along and the agents could not reach.
 *
 * Reported by an agent, in its own words: "tabs belong to the browser's UI;
 * the CLI I drive only has open/read/click/type/wait/shot/text/back/forward/
 * scroll/press — there is no verb for switching tab, and `open` replaces the
 * current view. So I move the agent's side outside the browser."
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
  | "open" | "read" | "click" | "type" | "wait" | "shot"
  | "back" | "forward" | "scroll" | "press" | "text"
  | "tabs" | "tab" | "newtab" | "closetab"
  | "console" | "network" | "resize" | "zoom" | "html" | "waitfor" | "observe"
  | "eval" | "select" | "reload" | "cookies" | "frames"
  | "dblclick" | "rightclick" | "hover" | "focus" | "blur" | "check" | "fill"
  | "addInitScript" | "expose" | "exposed"
  | "cdp" | "listeners" | "coverage" | "profiles" | "emulate" | "events" | "record" | "audit"
  | "debug" | "clock" | "download" | "settings" | "drag" | "upload" | "storage" | "permission"
  | "pdf" | "throttle" | "har" | "region" | "clipboard" | "save" | "headers" | "fake"
  | "trace" | "intercept"
  | "whoami"
  | "health";
/** Every verb, exported so a test can hold the CLI and the MCP to it — see
 *  `browser-cli.test.ts`. Seven §3 verbs once shipped reachable by neither. */
export const BROWSER_OPS: readonly BrowserOp[] = [
  "open", "read", "click", "type", "wait", "shot",
  "back", "forward", "scroll", "press", "text",
  "tabs", "tab", "newtab", "closetab",
  "console", "network", "resize", "zoom", "html", "waitfor", "observe",
  "eval", "select", "reload", "cookies", "frames",
  "dblclick", "rightclick", "hover", "focus", "blur", "check", "fill",
  "addInitScript", "expose", "exposed",
  "cdp", "listeners", "coverage", "profiles", "emulate", "events", "record", "audit", "debug",
  "clock", "download", "settings", "drag", "upload", "storage", "permission", "pdf",
  "throttle", "har", "region", "clipboard", "save", "headers", "fake", "trace", "intercept",
  "whoami",
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
  open: 45_000, read: 15_000, click: 15_000, type: 15_000, wait: 45_000, shot: 20_000,
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
  cdp: 60_000, listeners: 15_000, coverage: 30_000,
  /* A question the panel answers from memory. `whoami` is the same question
     with the caller's own identity folded in, and one extra `tabs` behind it. */
  profiles: 5_000, whoami: 5_000,
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
};

/** Requests handed to the window and not yet answered. */
const pending = new Map<string, { resolve: (r: BrowserReply) => void; timer: ReturnType<typeof setTimeout> }>();

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

let sink: { send: (ask: BrowserWireAsk) => void; listeners: () => number } | null = null;
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
const ready = new Map<string, number>();
const READY_TTL_MS = 90_000;

export function noteBrowserReady(client: unknown, on: boolean): boolean {
  if (typeof client !== "string" || !client || client.length > 128) return false;
  if (on) ready.set(client, Date.now());
  else ready.delete(client);
  return true;
}

/** How many windows could drive a browser right now. */
export function browserReadyCount(): number {
  const cutoff = Date.now() - READY_TTL_MS;
  for (const [id, at] of ready) if (at < cutoff) ready.delete(id);
  return ready.size;
}

let seq = 0;
const nextId = () => `b${++seq}`;

/** Addresses the browser relay refuses even over http(s): link-local — which is
 *  where the cloud metadata endpoint 169.254.169.254 lives — and the unspecified
 *  address. `open` drives a real, logged-in browser and `read` hands back the
 *  page, so without this the relay is an SSRF probe with a credentialed response
 *  channel. Loopback and RFC1918 are deliberately NOT blocked: pointing the
 *  browser at a local dev server or a box on your own LAN is ordinary use here.
 *  A bare hostname passes — re-resolving to pin the IP is a TOCTOU we don't win,
 *  and a redirect can still land somewhere internal; the guest's own network
 *  stack is the backstop for those. */
function blockedV4(h: string): boolean {
  return h.startsWith("169.254.") || h === "0.0.0.0";
}

/** The eight 16-bit groups of a valid IPv6 address (isIP has already said v6),
 *  with `::` expanded and any trailing dotted-quad (`::ffff:1.2.3.4`) folded
 *  into its two hex groups. Given a valid address this always yields eight. */
function ipv6Groups(h: string): number[] {
  let s = h;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) { // embedded IPv4 dotted-quad → two hex groups
    const q = tail.split(".").map((n) => parseInt(n, 10) & 0xff);
    s = s.slice(0, lastColon + 1) +
      ((q[0]! << 8) | q[1]!).toString(16) + ":" + ((q[2]! << 8) | q[3]!).toString(16);
  }
  const [left, right] = s.split("::");
  const head = left ? left.split(":") : [];
  const rear = right !== undefined ? (right ? right.split(":") : []) : [];
  const gap = right !== undefined ? 8 - head.length - rear.length : 0;
  return [...head, ...Array(Math.max(gap, 0)).fill("0"), ...rear].map((g) => parseInt(g, 16));
}

function blockedTarget(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase(); // URL keeps IPv6 brackets
  const v = isIP(h);
  if (v === 4) return blockedV4(h);
  if (v === 6) {
    if (/^fe[89ab]/.test(h) || h === "::") return true; // fe80::/10 link-local, unspecified
    // IPv4-mapped (::ffff:0:0/96) and the deprecated IPv4-compatible (::/96) forms
    // carry a v4 address in the low 32 bits — so `[::ffff:169.254.169.254]` (which
    // the URL parser folds to `::ffff:a9fe:a9fe`) is the metadata endpoint wearing
    // a v6 hat. Re-run the v4 rules on the embedded address; loopback/LAN mapped
    // in this way (e.g. `::ffff:127.0.0.1`) stays allowed, same as its v4 self.
    const g = ipv6Groups(h);
    const embedded =
      g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 &&
      (g[5] === 0xffff || g[5] === 0);
    if (embedded) {
      const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
      return blockedV4(v4);
    }
    // NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) embed a v4 address the same
    // way, just under a non-zero prefix — `[64:ff9b::a9fe:a9fe]` and
    // `[2002:a9fe:a9fe::]` are 169.254.169.254 wearing a routable-looking hat.
    // Fold each ONLY when its prefix actually matches, so a global v6 whose low
    // bits merely resemble 169.254.x.x is not over-blocked.
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
      return blockedV4(v4);
    }
    if (g[0] === 0x2002) {
      const v4 = `${g[1]! >> 8}.${g[1]! & 0xff}.${g[2]! >> 8}.${g[2]! & 0xff}`;
      return blockedV4(v4);
    }
    return false;
  }
  return false;
}

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
  const raw = process.env.AGENTGLASS_BROWSER_ORIGINS;
  if (!raw || !raw.trim()) return ["*"];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

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
  const raw = process.env.AGENTGLASS_BROWSER_PROFILES;
  if (!raw || !raw.trim()) return ["*"];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
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

/** `AGENTGLASS_BROWSER_READONLY=1` — observing stays open, acting is refused.
 *  Read on every call for the same reason as `allowedOrigins`. */
function readonlyMode(): boolean {
  return process.env.AGENTGLASS_BROWSER_READONLY === "1";
}

/** Every verb, named. This list is read-only mode's whole enforcement, so a
 *  verb that is not in it is acting by default — see `isActing` — rather than
 *  quietly falling on the safe-to-run side because nobody classified it. */
const OBSERVE_OPS: ReadonlySet<BrowserOp> = new Set([
  "read", "shot", "text", "html", "console", "network", "observe",
  "tabs", "frames", "health", "waitfor", "wait",
  /* `listeners` and a coverage READ only look. `cdp` is deliberately NOT
     here: the protocol can navigate, click, set a breakpoint and evaluate, so
     classifying it as observing would be a hole shaped exactly like the one
     §16 exists to close. A verb this powerful defaults to acting. */
  "listeners", "profiles", "events", "record", "audit", "pdf", "har", "region", "save",
  /* §11's whole point is a pre-flight that touches no page. If read-only mode
     refused it, the one call an agent should make BEFORE deciding whether it
     may act would be the first thing refused. */
  "whoami",
]);

/** `cookies` is the one verb that is sometimes each: reading the jar is an
 *  observation, `cookies --set` writes into it. Everything else is a fixed
 *  verdict per op, and anything this switch has never heard of falls through
 *  to `true` — acting — on purpose. */
function isActing(op: BrowserOp, args: Record<string, unknown>): boolean {
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
  /* `profiles` lists, and listing observes. `--make` writes a container and
     `--drop` closes every tab in one and clears its login — the verb this
     file builds an ownership guard around, and it sat in the observing set
     whole, so read-only mode let it through. */
  if (op === "profiles") return args.make !== undefined || args.drop !== undefined;
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
   was sitting next to. */
const BINARY_FIELDS: ReadonlySet<string> = new Set(["png", "pdf", "mhtml", "data", "script"]);

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
 * - `fake --body` and `intercept --body`: a response the agent wrote itself,
 *   to a page it is testing.
 * - `settings set`: a preference, and `settings get` prints it back anyway.
 */
export const valueCarryingExemptForTest: readonly string[] = ["clipboard", "select", "fake", "intercept", "settings"];
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
  const entry: AuditEntry = {
    /* The redaction lane's richer signal, kept: `secrets` is a list of
       selectors for the verbs that touch several fields (`fill`), where a
       single boolean could only ever say "one of them". */
    id: nextAuditId(), ts: Date.now(), op, args: redactAsk(op, clean, secrets), ok, error,
    ...(declaredAs ? { as: declaredAs } : {}),
    ...(tab ? { tab } : {}),
    ...(owner ? { owner } : {}),
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
      case "back": case "forward": line = `agentglass-browser ${e.op}`; break;
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
  return [dirname(configPath()), join(h, ".config", "agentglass"), join(h, ".ssh"), join(h, ".gnupg"), join(h, ".aws")];
}

function underDir(p: string, dir: string): boolean {
  const back = relative(dir, p);
  return back === "" || (!back.startsWith("..") && !back.startsWith(sep) && !/^[A-Za-z]:/.test(back));
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
  if (process.env.AGENTGLASS_FS_BROWSE_DISABLED === "1") return { error: "attaching files is disabled (AGENTGLASS_FS_BROWSE_DISABLED=1)" };
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
     tabs must not be the first one thrown out. */
  NAMED_TABS.delete(as);
  NAMED_TABS.set(as, tab);
  while (NAMED_TABS.size > NAMED_TABS_MAX) {
    const oldest = NAMED_TABS.keys().next();
    if (oldest.done) break;
    NAMED_TABS.delete(oldest.value);
  }
}

function namedTabOf(as: string): string | undefined { return NAMED_TABS.get(as); }

export function parseAsk(op: unknown, body: unknown): { ask: BrowserAsk } | { error: string } {
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
  switch (op as BrowserOp) {
    case "open":
    case "newtab": {
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
          const msg = `profile refused: "${b.profile}" is not in the allow-list (${list.join(", ")}). `
            + "Pass --shared (`shared: true` on the MCP) to work in the person's own container instead.";
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
      /* Same validation for both: the only difference is whether the page
         lands over the current view or beside it. */
      const url = safeUrl(b.url);
      if (!url) return { error: "url must be an http(s) address" };
      const list = allowedOrigins();
      const host = new URL(url).host;
      if (!originAllowed(host, list)) {
        const msg = `origin refused: ${host} is not in the allow-list (${list.join(", ")})`;
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
       * `Math.random()`, an in-flight CSS transition, a still-ticking
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
        return { error: `origin ${b.origin} is not in AGENTGLASS_BROWSER_ORIGINS (${list.join(", ")})` };
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
          return { error: "set must be { name, value, domain?, path? }" };
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
      if (b.omitBackground !== undefined) {
        args.omitBackground = b.omitBackground === true || b.omitBackground === "true";
      }
      break;
    }
    case "read":
    case "back":
    case "forward":
      break;
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
  if (readonlyMode() && isActing(op as BrowserOp, args)) {
    const msg = `read-only mode: "${op}" acts on the page and is refused (observing only: ${[...OBSERVE_OPS].join(", ")})`;
    recordAudit(op as BrowserOp, args, false, msg, false, undefined, caller);
    return { error: msg };
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
 * Several verbs, one call — spec §1, the first item on his own list by return.
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
}): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const { mkdirSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  try {
    mkdirSync(p.dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `could not make ${p.dir}: ${e instanceof Error ? e.message : e}` };
  }

  const behavior = parseAsk("cdp", {
    method: "Browser.setDownloadBehavior",
    params: { behavior: "allow", downloadPath: p.dir, eventsEnabled: true },
  });
  if ("error" in behavior) return { ok: false, error: behavior.error };
  const behaviorReply = await askBrowser(behavior.ask);
  if (!behaviorReply.ok) return { ok: false, error: `could not arm the download: ${behaviorReply.error}` };

  const clickParsed = parseAsk("click", { selector: p.selector });
  if ("error" in clickParsed) return { ok: false, error: clickParsed.error };
  const clickReply = await askBrowser(clickParsed.ask);
  if (!clickReply.ok) {
    return { ok: false, error: `could not click ${p.selector} to start the download: ${clickReply.error}` };
  }

  const deadline = Date.now() + (p.timeoutMs ?? 60_000);
  let guid: string | undefined;
  let filename: string | undefined;
  for (;;) {
    const drain = parseAsk("cdp", { events: true });
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
   *  reads an absent `as` as "cannot tell", allows it. */
  opts: { observe?: boolean; caller?: Record<string, unknown> } = {},
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
  for (const k of ["page", "as", "how", "pageExplicit"]) if (ask.args[k] !== undefined) inherited[k] = ask.args[k];
  const parsed = parseAsk("observe", inherited);
  if ("error" in parsed) return reply;
  const seen = await askBrowser(parsed.ask);
  return seen.ok
    ? { ...reply, value: { ...(reply.value as object ?? {}), after: seen.value } }
    /* The action SUCCEEDED. A failure to look afterwards is worth a sentence,
       never a reversal of the answer — reporting a completed click as failed
       because the observation timed out is the worst possible trade. */
    : { ...reply, value: { ...(reply.value as object ?? {}), afterFailed: seen.error } };
}

export async function runSteps(
  steps: Array<{ op: unknown; args: unknown }>,
  /** `page` is the tab the trailing observation must describe. A lane passes
   *  its own; a single `do` passes the one its steps carry.
   *
   *  `as`, `how` and `pageExplicit` are the CALLER, and they have to reach
   *  every sub-ask or the batch is anonymous — see the note in the loop. */
  opts: { observe?: boolean; page?: string; caller?: Record<string, unknown> } = {},
): Promise<{ ok: boolean; steps: Array<Record<string, unknown>>; stoppedAt?: number }> {
  const out: Array<Record<string, unknown>> = [];
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
    const addressed = { ...(opts.caller ?? {}), ...(opts.page ? { page: opts.page } : {}), ...(step.args as Record<string, unknown> ?? {}) };
    const parsed = parseAsk(step.op, addressed);
    if ("error" in parsed) {
      out.push({ op: step.op, ok: false, error: parsed.error });
      return { ok: false, steps: out, stoppedAt: i };
    }
    const reply = await askBrowser(parsed.ask);
    out.push({ op: step.op, ok: reply.ok, value: reply.value, error: reply.error, diagnosis: reply.diagnosis });
    if (!reply.ok) return { ok: false, steps: out, stoppedAt: i };
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
    const parsed = parseAsk("observe", { ...(opts.caller ?? {}), ...(opts.page ? { page: opts.page } : {}) });
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

export async function askBrowser(ask: BrowserAsk): Promise<BrowserReply> {
  if (asker) return asker(ask);
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
  if (ask.op === "profiles" && ask.args.make === undefined && ask.args.drop === undefined) {
    return composeProfiles(ask);
  }
  if (ask.op === "profiles" && typeof ask.args.drop === "string") return composeDrop(ask);
  return askWithRetry(ask);
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

async function composeWhoami(ask: BrowserAsk): Promise<BrowserReply> {
  const tabs = await askBrowser({ id: nextId(), op: "tabs", args: {} });
  if (!tabs.ok) {
    recordAudit("whoami", ask.args, false, tabs.error);
    return tabs;
  }
  const rows = tabRows(tabs.value);
  const value = { you: youBlock(ask.args, rows), activeTab: activeBlock(rows) };
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
  const reply = await askOnce(ask);
  if (!reply.ok) return reply;
  forgetContainer(name);
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

function askOnce(ask: BrowserAsk): Promise<BrowserReply> {
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
  if (!panelMounted) {
    return Promise.resolve({ ok: false, error: "the browser view is not open in this window" });
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
      /* The multi-field form of the same verdict. `fill` does not send it yet
         — the page-side test lives in the panel's `type` handler and has never
         been wired to its `fill` handler — so today the selector heuristic is
         what catches a `fill` password. This reads the list the moment the
         panel starts sending one, rather than needing a second change here. */
      const namedSecret = Array.isArray(v?.secretFields)
        ? (v!.secretFields as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined;
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
      resolve(redacted);
    };
    const timer = setTimeout(() => {
      pending.delete(ask.id);
      settle({ ok: false, error: `the browser did not answer in time (${ask.op})` });
    }, TIMEOUT_MS[ask.op]);
    pending.set(ask.id, { resolve: settle, timer });
    /* Re-built rather than cast, so the narrowing above is what proves the op
       is sendable. A cast here would pass a verb the panel cannot answer and
       the caller would get "not a tab operation" from three layers down. */
    sink!.send({ id: ask.id, op, args: ask.args });
  });
}

/** The panel reporting back. Unknown ids are dropped rather than logged loudly:
 *  a reply arriving after its timeout is ordinary, not an error. */
export function settleBrowser(id: unknown, reply: BrowserReply): boolean {
  if (typeof id !== "string") return false;
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(reply);
  return true;
}

/** For tests, and for a shutdown that should not leave timers behind. */
export function resetBrowserDrive(): void {
  NAMED_TABS.clear();
  ready.clear();
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
