import type { BrowserAskFrame } from "../../../shared/types.ts";
import { api } from "./api.ts";
import { captureBrowser, registerBrowserInitScript, browserCdp, browserCdpEvents, applySessionSettings} from "./desktop.ts";
import { runBrowserAsk, type DrivableWebview } from "./browserDrive.ts";
import { whilePainting } from "./panePainting.ts";
import { diagnosisScript } from "./browserObserve.ts";

/**
 * Where an agent's browser ask goes when it arrives.
 *
 * A bus rather than a direct call, for one reason: the panel that can answer is
 * mounted or it is not, and the socket does not know which. The panel registers
 * itself while it is up; when nothing has, the ask is still answered — with the
 * truth — so the agent gets a sentence instead of the server's timeout.
 *
 * One handler, not a set. Two browser panels answering the same ask would race
 * to report two different results for one request, and the second would be
 * dropped by the server as an unknown id — a bug that would only ever show up
 * on somebody's second window.
 */
let handler: ((ask: BrowserAskFrame) => void) | null = null;

/**
 * This window's name for itself, for the whole time it is up.
 *
 * Per window and not per machine: two windows are two answers to "can you drive
 * a browser", and a shared id would have one of them cancelling the other's
 * registration on the way out. Not persisted for the same reason — a new window
 * is a new registration, and yesterday's is not evidence of anything.
 */
let id = "";
export function clientId(): string {
  if (!id) id = `w${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return id;
}

/**
 * Run an ask and tell the server, which is holding an agent's HTTP request
 * open until this lands.
 *
 * Lives here rather than beside the page logic so that logic imports nothing:
 * what each verb does to a page is the part worth testing, and a test of it
 * should not need an origin, a token or a fetch — which is exactly what pulling
 * in the API client demanded.
 *
 * A failure to report is swallowed. There is nowhere better for it to go, and
 * the request times out on the other side with a sentence of its own.
 */
/*
 * THE TAB VERBS, answered by whoever owns the tabs.
 *
 * An agent said it plainly: "tabs belong to the browser's UI; the CLI I drive
 * has no verb for switching tab, and `open` replaces the current view — so I
 * move the agent's side outside the browser." The panel has had tabs, folders
 * and profiles the whole time; none of it was addressable.
 *
 * These cannot live in `browserDrive.ts`, which is handed ONE webview and
 * deliberately knows nothing else — that is what keeps its tests free of an
 * origin and a token. And this file must not import the panel, or the bus
 * starts depending on the UI it serves. So the panel registers, the same
 * one-slot idiom `onOpenSettings` uses, and a verb with nobody listening says
 * so rather than failing silently.
 */
export interface TabOps {
  /** `profile` is §9's isolated context, under the name the panel already
   *  gives it: two tabs in different profiles are two different people, with
   *  their own cookies and storage. It was there the whole time and only the
   *  human could reach it. */
  list(): { id: string; title: string; url: string; active: boolean; profile?: string }[];
  select(which: { index?: number; id?: string }): boolean;
  /* `{ error }` rather than null: the panel knows WHY — "twelve pages awake at
     once is the limit", "that name is taken" — and a caller told only that it
     "could not open a tab" has nothing to act on. Measured on the running app
     with 64 tabs open: the limit was hit and the message named nothing. */
  open(url: string, profile?: string): { id: string } | { error: string } | null;
  close(which: { index?: number; id?: string }): boolean;
  /** Every container the panel knows about, so an agent can pick one by name
   *  instead of guessing at a string the panel would silently reject. */
  profiles?(): string[];
  /** Make one. An agent gets its OWN — never a container a person is using,
   *  and never one another agent made. Returns null if the name is taken or
   *  there is no room, rather than handing back somebody else's. */
  /* `{ error }` for the same reason `open` carries one: "the name may be
     taken, or there is no room" is a guess written by the side that does not
     know, and the side that does knows exactly which. */
  makeProfile?(name: string): { id: string; name: string } | { error: string } | null;
  /** And throw it away when the work is done, with everything in it: cookies,
   *  storage, cache. A container left behind is a login somebody did not mean
   *  to keep. */
  dropProfile?(name: string): boolean;
}

let tabs: TabOps | null = null;
/** The browser panel installs this while it is mounted. */
export function onBrowserTabs(ops: TabOps | null): () => void {
  tabs = ops;
  return () => { if (tabs === ops) tabs = null; };
}

const TAB_OPS = new Set(["tabs", "tab", "newtab", "closetab", "profiles"]);

function serveTabs(ask: BrowserAskFrame): { ok: boolean; value?: unknown; error?: string } {
  if (!tabs) return { ok: false, error: "the browser view is not open in this window" };
  const which = {
    ...(typeof ask.args.index === "number" ? { index: ask.args.index } : {}),
    ...(typeof ask.args.id === "string" ? { id: ask.args.id } : {}),
  };
  switch (ask.op) {
    case "tabs":
      return { ok: true, value: tabs.list() };
    case "tab":
      /* A refusal names what it could not find, because the alternative — a
         silent no-op — reads as "the switch worked and the page is the same". */
      /*
       * AND THE LIST SAYS WHICH ONE IS ACTIVE NOW, not a moment ago.
       *
       * `select` sets React state; `list()` reads the ref behind it, which has
       * not been updated by the time this line runs. So a successful `tab t37`
       * answered with a list where t38 was still marked active — the tab being
       * LEFT. Anything reading the answer to learn where it landed learned the
       * opposite, and one caller did exactly that.
       */
      if (!tabs.select(which)) {
        return { ok: false, error: "no tab with that index or id — call `tabs` for what is open" };
      }
      const rows = tabs.list();
      const picked = typeof which.id === "string"
        ? rows.find((t) => t.id === which.id)
        : rows[which.index ?? -1];
      return {
        ok: true,
        value: picked ? rows.map((t) => ({ ...t, active: t.id === picked.id })) : rows,
      };
    case "profiles": {
      const a = ask.args as Record<string, unknown>;
      if (typeof a.make === "string") {
        /* Made, never borrowed. Two agents sharing a container share a login,
           and the second one to act changes what the first one is looking at. */
        const made = tabs.makeProfile?.(a.make);
        if (made && "error" in made) return { ok: false, error: made.error };
        return made
          ? { ok: true, value: { made: made.name, id: made.id } }
          : { ok: false, error: `could not make a container called ${a.make}, and the panel gave no reason` };
      }
      if (typeof a.drop === "string") {
        return tabs.dropProfile?.(a.drop)
          ? { ok: true, value: { dropped: a.drop } }
          : { ok: false, error: `no container called ${a.drop} — call \`profiles\` for what exists. The default one cannot be dropped.` };
      }
      return { ok: true, value: { profiles: tabs.profiles?.() ?? [] } };
    }
    case "newtab":
    case "open": {
      /* `open --as NAME` (spec §7) reaches here too, not `runBrowserAsk` —
       * only THIS side knows about profiles at all, and the point of `--as`
       * is that it is a different cookie jar, not a replaced view in the
       * current one. Landing it on the currently-mounted webview would have
       * silently ignored the identity the caller asked for, which is exactly
       * the 40-minute magic-link cost the spec measured. `serveBrowserAsk`
       * only routes an `open` here when it carries a `profile`; a plain
       * `open` still replaces the current view, unchanged. */
      const made = tabs.open(String(ask.args.url ?? ""),
        typeof ask.args.profile === "string" ? ask.args.profile : undefined);
      if (made && "error" in made) return { ok: false, error: made.error };
      return made
        ? { ok: true, value: { ...made, tabs: tabs.list() } }
        : { ok: false, error: "could not open a tab, and the panel gave no reason" };
    }
    case "closetab":
      return tabs.close(which)
        ? { ok: true, value: tabs.list() }
        : { ok: false, error: "no tab with that index or id — call `tabs` for what is open" };
    default:
      return { ok: false, error: "not a tab operation" };
  }
}

/**
 * "Is anything even there" — one line, before an agent spends a verb finding
 * out the hard way (§15). Answered here rather than in `browserDrive.ts`
 * because the three things it reports — the window, the panel, the page —
 * are three different objects and only this file can see all of them; the
 * window itself is already known by the time this runs, because the server
 * only sends an ask when some window has registered as able to answer one.
 */
async function serveHealth(el: DrivableWebview | null): Promise<{ ok: true; value: unknown }> {
  const mounted = !!tabs;
  let page = "no page open";
  if (el) {
    try {
      const rs = await el.executeJavaScript("document.readyState");
      page = `page alive (readyState=${rs}, url=${el.getURL()})`;
    } catch {
      page = "a page is mounted but did not answer";
    }
  }
  const summary = `window open, panel ${mounted ? "mounted" : "not mounted"}, ${page}`;
  return { ok: true, value: { summary, mounted, hasPage: !!el } };
}

/**
 * What a failing ask carries out with it, unasked (§15).
 *
 * "The biggest time saver on the whole list, because today a failure forces
 * me to rebuild the state from outside." Skipped for the ops that already ARE
 * the diagnosis — asking `console` a second time because `console` failed
 * teaches nothing — and for anything answered before a page was ever reached.
 */
const SELF_DIAGNOSING = new Set(["observe", "console", "network", "shot", "health", ...TAB_OPS]);
async function attachDiagnosis(
  el: DrivableWebview | null, op: string, reply: { ok: boolean; value?: unknown; error?: string },
): Promise<{ ok: boolean; value?: unknown; error?: string; diagnosis?: unknown }> {
  if (reply.ok || !el || SELF_DIAGNOSING.has(op)) return reply;
  const diagnosis: Record<string, unknown> = {};
  try {
    const d = await el.executeJavaScript(diagnosisScript()) as { consoleErrors: unknown[]; failedRequests: unknown[] };
    diagnosis.consoleErrors = d.consoleErrors;
    diagnosis.failedRequests = d.failedRequests;
  } catch { /* the page could not even answer that; the error above still stands */ }
  try {
    // Bounded well under the shell's own budget: this is evidence for a
    // failure that already happened, not a verb an agent is waiting on —
    // taking twelve seconds to attach a picture to a click failure would cost
    // more than the click did.
    const shot = await Promise.race([
      captureBrowser(),
      new Promise<{ png: string | null; why: string }>((r) => setTimeout(() => r({ png: null, why: "" }), 3000)),
    ]);
    if (shot.png) diagnosis.shot = shot.png;
  } catch { /* no picture; the text above is still worth having */ }
  return Object.keys(diagnosis).length ? { ...reply, diagnosis } : reply;
}

/** A webview's webContents id, or undefined while it is still attaching. The
 *  shell refuses an id it does not recognise rather than falling back to the
 *  active tab, so undefined here means "the active one" and a WRONG id means
 *  a refusal — which is the safe way round. */
/**
 * WHICH GUEST, and never "whichever is in front".
 *
 * `undefined` used to mean both "no tab was asked for" and "we could not work
 * out which one this is", and the shell reads the second as the first: it
 * captures the guest at the front. `getWebContentsId()` throws on a webview
 * whose guest has not attached yet — a background tab, which is exactly what
 * an agent's tab is — so the throw was swallowed and the capture came back as
 * a picture of somebody else's page.
 *
 * MEASURED: two `shot --page` calls naming two different tabs produced
 * byte-identical PNGs, 245881 bytes each, of the tab that happened to be on
 * screen. Right dimensions, plausible content, wrong page, and nothing in the
 * answer saying so.
 *
 * So this returns `null` for "asked for a tab and could not identify it",
 * which the caller refuses, and `undefined` only for "nobody named a tab".
 */
function guestIdOf(el: DrivableWebview | null): number | undefined | null {
  if (!el) return undefined;
  try {
    const id = (el as unknown as { getWebContentsId?: () => number })?.getWebContentsId?.();
    return typeof id === "number" && id > 0 ? id : null;
  } catch { return null; }
}

export async function serveBrowserAsk(el: DrivableWebview | null, ask: BrowserAskFrame): Promise<void> {
  /* Tabs are answered before the webview is consulted: they are about WHICH
     page, not about the page. `open --as NAME` joins them here too — see the
     note beside `case "open"` in serveTabs for why a plain `open` must NOT
     take this branch. */
  if (TAB_OPS.has(ask.op) || (ask.op === "open" && typeof ask.args.profile === "string")) {
    const reply = serveTabs(ask);
    try { await api.browserResult({ id: ask.id, ...reply }); } catch { /* already timed out */ }
    return;
  }
  if (ask.op === "health") {
    const reply = await serveHealth(el);
    try { await api.browserResult({ id: ask.id, ...reply }); } catch { /* already timed out */ }
    return;
  }
  /* A screenshot is the one verb that needs the pane to be PAINTING, not just
     mounted — everything else talks to the page and does not care whether
     anybody can see it. So only that one pays the warm-up, and it pays it here
     rather than inside the shell, which cannot reach the element's pane. */
  const paint = <T,>(run: () => Promise<T>) =>
    ask.op === "shot" ? whilePainting(el as unknown as Element, run) : run();
  const reply = el
    /* The capture is told WHICH guest, because the shell would otherwise take
       whichever tab is in front — and with two agents that is not the same
       tab. See `captureBrowser`. */
    ? await paint(() => runBrowserAsk(
        el, ask,
        (opts) => {
          const guest = guestIdOf(el);
          /* A capture we cannot address is a refusal, not a capture of
             whatever is in front. The message names the fix, because the
             usual cause is a tab that has not been looked at yet. */
          if (guest === null) {
            return Promise.resolve({
              png: null,
              why: "could not work out which tab this is — it may not have finished attaching. "
                + "Try again, or `tab <id>` to bring it up first.",
            });
          }
          /*
           * AND THE PICTURE HAS TO BE OF THE PAGE WE ASKED FOR.
           *
           * The shell now says which guest it photographed. Compared here
           * against the tab we addressed, because a capture of the wrong page
           * is indistinguishable from a right one — right dimensions,
           * plausible content, and an agent puts it in a report. Measured on
           * the running app: a `shot` of a background tab came back as a
           * picture of a page that was not in the tab list at all.
           */
          let want = "";
          try { want = (el as unknown as { getURL?: () => string })?.getURL?.() ?? ""; } catch { /* not attached */ }
          return captureBrowser(opts, guest ?? undefined).then((r) => {
            const got = r.url ?? "";
            /* Only when both are known: about:blank and a page mid-navigation
               are not a mismatch, they are a page that has not settled. */
            if (r.png && want && got && got !== want) {
              return {
                png: null,
                why: `that capture came back from a different page (asked for ${want}, got ${got}) — `
                  + "refused rather than handed over, because a picture of the wrong page looks "
                  + "exactly like a picture of the right one",
              };
            }
            return r;
          });
        },
        () => reviveSurface(el),
        /* AND THE INIT SCRIPT GOES TO THE TAB THAT ASKED. It was handed the
           bare function, which registered against whichever guest was in
           front — the same bug the capture and the DevTools relay each had.
           Measured: `addInitScript` on a background tab answered
           {"registered": ...} and, after a reload, the attribute it sets on
           <html> was not there. It had been registered on somebody else's
           page. */
        (name, source) => {
          const guest = guestIdOf(el);
          if (guest === null) {
            return Promise.resolve({
              ok: false,
              error: "could not work out which tab this is — it may not have finished attaching. "
                + "Try again, or `tab <id>` to bring it up first.",
            });
          }
          return registerBrowserInitScript(name, source, guest ?? undefined);
        },
        /* Bound to the addressed tab. Unbound, every DevTools call went to
           whichever guest was in front — and the screenshot route is a
           DevTools call, which is how `read` answered from the agent's page
           and `shot`, one command later, returned another tab. */
        (method, params) => {
          const guest = guestIdOf(el);
          if (guest === null) {
            return Promise.resolve({
              ok: false,
              error: "could not work out which tab this is — it may not have finished attaching. "
                + "Try again, or `tab <id>` to bring it up first.",
            });
          }
          return browserCdp(method, params, guest ?? undefined);
        },
        browserCdpEvents, applySessionSettings))
    : { ok: false, error: "the browser view is not open in this window" };
  const withDiagnosis = await attachDiagnosis(el, ask.op, reply);
  try { await api.browserResult({ id: ask.id, ...withDiagnosis }); } catch { /* the ask has already timed out */ }
}

/**
 * Make Chromium hand this guest a new surface, by changing its size and putting
 * it back.
 *
 * Only ever called after a capture has already failed for the reason this
 * fixes. A guest whose frame sink is gone answers `UnknownVizError` to the
 * compositor and nothing at all to the debugger, on every page from then on,
 * because a navigation reuses the same view — measured. A resize is the cheapest
 * thing that forces a new one, and it is invisible: the pane doing this is the
 * one nobody is looking at.
 */
async function reviveSurface(el: DrivableWebview): Promise<void> {
  const node = el as unknown as HTMLElement;
  if (!node || typeof node.getBoundingClientRect !== "function" || !node.style) return;
  const was = node.style.width;
  const wide = node.getBoundingClientRect().width;
  if (wide < 2) return;
  node.style.width = `${Math.round(wide) - 1}px`;
  await new Promise((r) => setTimeout(r, 80));
  node.style.width = was;
  // Long enough for the new sink to be registered; a capture asked for sooner
  // gets the same error and the retry is wasted.
  await new Promise((r) => setTimeout(r, 200));
}

export function setBrowserAskHandler(fn: ((ask: BrowserAskFrame) => void) | null): void {
  handler = fn;
}

/**
 * Hand an ask to the panel, if this window has one.
 *
 * Silence when it does not, and that is the fix rather than an oversight: the
 * ask is broadcast to every open client, and a dashboard in an ordinary browser
 * tab is a client with no `<webview>` in it. Answering "the browser view is not
 * open in this window" from there was answering for everybody — first reply
 * wins — while the desktop app sat there able to do the work.
 *
 * Nothing is lost by staying quiet: the server only sends an ask when some
 * window has registered as able to answer it (POST /browser/ready), and fails
 * fast with a sentence when none has.
 */
export function emitBrowserAsk(ask: BrowserAskFrame): void {
  if (handler) handler(ask);
}

/** The tab and profile verbs, reachable from a test. `serveBrowserAsk` reports
 *  its answer rather than returning it, so testing through it would mean
 *  standing up the API client too — and what these verbs decide is the part
 *  worth pinning. */
export const serveTabsForTest = serveTabs;
