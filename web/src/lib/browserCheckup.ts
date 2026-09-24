/*
 * `checkup`'s two halves that do not need a guest: the page read, and the
 * reading of what the DevTools protocol said while the page loaded.
 *
 * The verb itself — enable, navigate, wait for quiet, drain, shoot on failure
 * — lives with the other verbs in browserDrive.ts; see `runCheckup` there for
 * why it listens through CDP rather than through the in-page collector.
 */
import { ACC_NAME, STAMP } from "./browserObserve.ts";
import { ON_SCREEN } from "./browserLocator.ts";

export type CdpEvent = { at: number; method: string; params: unknown };

export type CheckupIssue = { code: string; n: number; about?: string };

export type Classified = {
  errors: string[];
  failed: string[];
  issues: CheckupIssue[];
  dropped: { errors?: number; failed?: number; issues?: number };
};

const MAX_ROWS = 10;
const MAX_ISSUES = 5;
const URL_CUT = 160;

/** Repeats folded into one row with a count, ordered by when each was LAST
 *  seen (newest last), and cut to the newest `cap`. A page that throws the
 *  same thing on every animation frame is one problem, not sixty. */
function tally(texts: string[], cap: number): { rows: string[]; dropped: number } {
  const seen = new Map<string, number>();
  for (const t of texts) {
    const n = (seen.get(t) ?? 0) + 1;
    seen.delete(t); // re-inserted, so Map order is last-seen order
    seen.set(t, n);
  }
  const rows = [...seen].map(([t, n]) => (n > 1 ? `${t} (×${n})` : t));
  return { rows: rows.slice(-cap), dropped: Math.max(0, rows.length - cap) };
}

/* Spelled as constants so no line below pairs a single-backslash escape with
   split( or test( — the shape page-scripts-have-no-backticks.test.ts reads as
   a page script's escape collapsing. These lines are TypeScript, not page code. */
const NL = "\n";
const UNCAUGHT = /^Uncaught\b/i;
const ERROR_NAME = /^[A-Z]\w*(Error|Exception)\b/;

const cutUrl = (u: string) => (u.length > URL_CUT ? u.slice(0, URL_CUT) : u);

/** A url as it may be repeated in an answer: no query string and no fragment.
 *  A callback's query carries an OAuth code or a token as often as not, and an
 *  answer ends up in an agent's context and its transcript. The path is what
 *  finds the broken endpoint; "?..." says there was more. */
export function bareUrl(u: string): string {
  const cut = u.search(/[?#]/);
  if (cut === -1) return cutUrl(u);
  return cutUrl(u.slice(0, cut)) + (u[cut] === "?" ? "?..." : "");
}

function pathOf(url: string): string {
  try { return new URL(url).pathname || url; } catch { return url; }
}

type Exc = {
  text?: string; url?: string; lineNumber?: number;
  exception?: { description?: string; value?: unknown };
};

/** One line an agent can act on: the message, the first frame, and where. */
export function exceptionText(d: Exc): string {
  let text = "";
  const desc = d.exception?.description;
  if (typeof desc === "string" && desc.trim()) {
    const lines = desc.split(NL);
    const first = lines[0]!.trim();
    const frame = lines.find((l) => l.trimStart().startsWith("at "))?.trim();
    text = frame ? `${first} ${frame}` : first;
  } else {
    const v = d.exception?.value;
    text = [d.text ?? "", v === undefined ? "" : String(v)].filter(Boolean).join(" ") || "exception";
  }
  if (d.url) {
    const where = pathOf(d.url);
    if (!text.includes(where)) {
      text += ` @ ${where}${typeof d.lineNumber === "number" ? `:${d.lineNumber + 1}` : ""}`;
    }
  }
  if (!UNCAUGHT.test(text) && !ERROR_NAME.test(text)) text = `uncaught ${text}`;
  return text;
}

/** The first string at depth 3 or less that looks like a url. Generic on
 *  purpose: an issue's details differ per code, and a table of which field
 *  names the resource for which of Chromium's forty-odd codes would be out
 *  of date the day it was written. */
function firstUrl(v: unknown, depth = 0): string | undefined {
  if (typeof v === "string") return /^(https?|wss?):\/\//.test(v) ? bareUrl(v) : undefined;
  if (depth >= 3 || !v || typeof v !== "object") return undefined;
  for (const x of Object.values(v as Record<string, unknown>)) {
    const u = firstUrl(x, depth + 1);
    if (u) return u;
  }
  return undefined;
}

/**
 * The protocol's events, read into the three things a checkup reports.
 *
 * Only events at or after `since` (the panel's clock, less 50 ms for the hop
 * between processes). Every other method is left alone — but it was drained
 * all the same: the buffer is the tab's, not the checkup's, so a
 * `Debugger.paused` that arrives during a checkup is consumed by it.
 */
export function classifyEvents(all: CdpEvent[], since: number): Classified {
  const events = all.filter((e) => e.at >= since - 50);
  const sent = new Map<string, { method: string; url: string }>();
  const runtimeTexts: string[] = [];
  const errors: string[] = [];
  const failed: string[] = [];
  const issues = new Map<string, CheckupIssue>();
  type P = Record<string, any>;
  for (const e of events) {
    if (e.method === "Network.requestWillBeSent") {
      const p = e.params as P;
      sent.set(String(p.requestId), { method: String(p.request?.method ?? "GET"), url: String(p.request?.url ?? "") });
    }
    if (e.method === "Runtime.exceptionThrown") {
      // The message itself, not the "Uncaught" the protocol puts in `text`
      // beside it — that word alone would match every error Log repeats.
      const d = (e.params as P).exceptionDetails ?? {};
      const desc = String(d.exception?.description ?? "").split(NL)[0]!.trim();
      runtimeTexts.push(desc || [d.text, d.exception?.value].filter((x) => x !== undefined).join(" "));
    }
  }
  for (const e of events) {
    const p = (e.params ?? {}) as P;
    switch (e.method) {
      case "Runtime.exceptionThrown":
        errors.push(exceptionText(p.exceptionDetails ?? {}));
        break;
      case "Runtime.consoleAPICalled": {
        if (p.type !== "error" && p.type !== "assert") break;
        const text = (Array.isArray(p.args) ? p.args : [])
          .map((a: P) => String(a?.value ?? a?.description ?? "")).join(" ").trim().slice(0, 300);
        runtimeTexts.push(text);
        errors.push(text || (p.type === "assert" ? "console.assert failed" : "console.error()"));
        break;
      }
      case "Log.entryAdded": {
        const en = p.entry ?? {};
        // `network` entries are the failed requests again, said a second way.
        if (en.level !== "error" || en.source === "network") break;
        const text = String(en.text ?? "").slice(0, 300);
        // Nor an uncaught exception Runtime already reported: Log says it again as
        // "Uncaught TypeError: …", so it is matched by containment, not equality.
        if (!text || runtimeTexts.some((t) => t === text || (t.length >= 8 && (t.includes(text) || text.includes(t))))) break;
        errors.push(text);
        break;
      }
      case "Network.responseReceived": {
        const r = p.response ?? {};
        const url = String(r.url ?? "");
        if (!(Number(r.status) >= 400) || url.startsWith("data:")) break;
        failed.push(`${r.status} ${sent.get(String(p.requestId))?.method ?? "?"} ${bareUrl(url)}`);
        break;
      }
      case "Network.loadingFailed": {
        if (p.canceled === true) break;
        const req = sent.get(String(p.requestId));
        const url = req?.url ?? "";
        if (url.startsWith("data:")) break;
        failed.push(`failed ${req?.method ?? "?"} ${bareUrl(url) || "(unknown url)"}: ${p.errorText ?? "failed"}`
          + (p.blockedReason ? ` blocked:${p.blockedReason}` : "")
          + (p.corsErrorStatus?.corsError ? ` cors:${p.corsErrorStatus.corsError}` : ""));
        break;
      }
      case "Audits.issueAdded": {
        const code = String(p.issue?.code ?? "unknown");
        const g = issues.get(code) ?? { code, n: 0 };
        g.n++;
        if (!g.about) {
          const about = firstUrl(p.issue?.details);
          if (about) g.about = about;
        }
        issues.set(code, g);
        break;
      }
    }
  }
  return finish(errors, failed, [...issues.values()]);
}

function finish(errorTexts: string[], failedTexts: string[], issues: CheckupIssue[]): Classified {
  const e = tally(errorTexts, MAX_ROWS);
  const f = tally(failedTexts, MAX_ROWS);
  const dropped: Classified["dropped"] = {};
  if (e.dropped) dropped.errors = e.dropped;
  if (f.dropped) dropped.failed = f.dropped;
  if (issues.length > MAX_ISSUES) dropped.issues = issues.length - MAX_ISSUES;
  return { errors: e.rows, failed: f.rows, issues: issues.slice(0, MAX_ISSUES), dropped };
}

/** What the in-page collector saw after `since`, IN THE PAGE'S CLOCK — the
 *  clock its rows are stamped with, which is not the panel's once a page is
 *  under the clock verb (a window kept in the panel's time replayed old rows after
 *  an advance). `now` comes back so the next window starts where this one read. */
export const collectorSince = (since: number): string => `(() => {
  const l = window.__agxLog;
  if (!l) return null;
  return {
    now: Date.now(),
    console: l.console.filter((r) => r.level === "error" && r.at > ${since}).map((r) => String(r.text).split("\\n")[0].slice(0, 300)),
    network: l.network.filter((r) => r.at > ${since} && (r.status >= 400 || (r.status === 0 && r.error)))
      .map((r) => ({ method: r.method, url: String(r.url), status: r.status, error: r.error })),
  };
})()`;

export function classifyCollector(
  rows: { console?: string[]; network?: Array<{ method?: string; url?: string; status?: number; error?: string }> } | null,
): Classified {
  const failed = (rows?.network ?? [])
    .filter((r) => !String(r.url ?? "").startsWith("data:"))
    .map((r) => (Number(r.status) >= 400
      ? `${r.status} ${r.method ?? "?"} ${bareUrl(String(r.url ?? ""))}`
      : `failed ${r.method ?? "?"} ${bareUrl(String(r.url ?? ""))}: ${r.error ?? "failed"}`));
  return finish(rows?.console ?? [], failed, []);
}

/** Requests the protocol has seen start and not yet seen answered. A request
 *  seen only as finished started before the window and is not counted, either way.
 *
 *  The response arriving is the end, not loadingFinished: measured in the real
 *  guest, a fetch that got a 500 and whose body the page never read sent no
 *  loadingFinished at all, so every broken load ran into the cap. The ceiling:
 *  a large body still streaming counts as done once its headers are in. */
export function trackInflight(inflight: Set<string>, e: CdpEvent): void {
  const id = String((e.params as { requestId?: unknown } | null)?.requestId ?? "");
  if (!id) return;
  if (e.method === "Network.requestWillBeSent") inflight.add(id);
  else if (e.method === "Network.responseReceived" || e.method === "Network.loadingFinished"
    || e.method === "Network.loadingFailed") inflight.delete(id);
}

/**
 * The page half, one round trip: what it looks like to a person (visible
 * error text), how it loaded (perf) and what a screen reader would miss
 * (a11y). Advice apart from `visible` — see the verdict in browserDrive.ts.
 *
 * Page code: no less-than sign and no backticks anywhere inside it (see
 * page-scripts-have-no-backticks.test.ts), regex escapes doubled.
 *
 * `a11y` names a control the way observe does (ACC_NAME), so a sample it
 * reports is one a locator can find and an observation lists the same way.
 * The ceiling that comes with that: ACC_NAME does not read aria-labelledby or
 * the alt of an image inside a link, so a control named only those ways is
 * counted as unlabelled. It is advice, and it errs towards looking.
 */
export const CHECKUP_PAGE = `(async () => {
  const name = ${ACC_NAME};
  const stamp = ${STAMP};
  const onScreen = ${ON_SCREEN};
  const out = { url: location.href, title: document.title, docAt: Math.round(performance.timeOrigin || 0), now: Date.now() };

  /* Buffered entries arrive in a later task, not inside observe(), so each
     observer is read after one turn of the event loop. A tab in the
     background may never have painted: then there is simply no LCP. */
  const buffered = (type) => new Promise((resolve) => {
    let got = [];
    let po = null;
    try {
      po = new PerformanceObserver((list) => { got = got.concat(list.getEntries()); });
      po.observe({ type, buffered: true });
    } catch (err) { resolve(null); return; }
    setTimeout(() => {
      try { got = got.concat(po.takeRecords ? po.takeRecords() : []); po.disconnect(); } catch (err) {}
      resolve(got);
    }, 0);
  });
  const supported = (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes) || [];
  const perf = {};
  const [lcp, shifts] = await Promise.all([buffered("largest-contentful-paint"), buffered("layout-shift")]);
  if (lcp && lcp.length) perf.lcpMs = Math.round(lcp[lcp.length - 1].startTime);
  if (shifts && supported.indexOf("layout-shift") !== -1) {
    const cls = shifts.filter((s) => !s.hadRecentInput).reduce((a, s) => a + (s.value || 0), 0);
    perf.cls = Math.round(cls * 1000) / 1000;
  }
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    const load = nav ? Math.round(nav.loadEventEnd || 0) : 0;
    if (load) perf.loadMs = load;
  } catch (err) {}
  if (Object.keys(perf).length) out.perf = perf;

  const NAMED_BY_VALUE = { submit: 1, button: 1, reset: 1, image: 1 };
  const unlabelled = [];
  for (const el of document.querySelectorAll('input,select,textarea,button,[role="button"],a[href]')) {
    const t = el.tagName === "INPUT" ? String(el.type || "text").toLowerCase() : "";
    if (t === "hidden") continue;
    if (NAMED_BY_VALUE[t] && (el.value || el.getAttribute("alt"))) continue;
    if (!onScreen(el) || name(el)) continue;
    unlabelled.push(el);
  }
  const imgs = [...document.querySelectorAll("img")].filter((el) => !el.hasAttribute("alt") && onScreen(el));
  const a11y = {};
  if (unlabelled.length) a11y.unlabelled = unlabelled.length;
  if (imgs.length) a11y.imgNoAlt = imgs.length;
  const samples = unlabelled.concat(imgs).slice(0, 3).map((el) => stamp(el) + " " + el.tagName.toLowerCase());
  if (samples.length) { a11y.samples = samples; out.a11y = a11y; }

  const visible = [];
  /* One message, one problem: an alert inside a live region (or the other way
     round) matches twice, and the outer one's text already holds the inner's. */
  const matched = [];
  for (const el of document.querySelectorAll('[role="alert"],[aria-live="assertive"]')) {
    if (visible.length === 3) break;
    if (!onScreen(el)) continue;
    if (matched.some((m) => m.contains(el))) continue;
    matched.push(el);
    const text = String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200);
    if (text && visible.indexOf(text) === -1) visible.push(text);
  }
  if (visible.length) out.visible = visible;
  return out;
})()`;
