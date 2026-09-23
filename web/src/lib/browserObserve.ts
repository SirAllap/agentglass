/*
 * ONE CALL THAT SAYS WHAT IS GOING ON.
 *
 * Reported by an agent driving this browser all day, and it is the right
 * complaint: "what I need is a call that returns the whole state, not six
 * verbs I poll in turn. Today every read/text/shot is a new process and I
 * write for i in $(seq 1 20) — that is where the time goes, not the network."
 *
 * So `observe` answers in one round trip what used to take six: where the page
 * is, whether it is even VISIBLE (a hidden panel changes how a page behaves,
 * which turns a capture into a false negative), what the console and the
 * network have said since last time, what the form currently holds, and a
 * tree of the page addressed the way a person addresses it — by role and
 * accessible name — rather than as a wall of text.
 *
 * `since` is the whole point of the console and network halves: a caller that
 * observed a second ago wants what happened SINCE, not the same fifty lines
 * again.
 *
 * This is the script that runs IN the page. It is a string rather than a
 * function so it can be handed to executeJavaScript without a bundler step,
 * and it is here rather than inline in the driver so it can be read and
 * changed as the one thing it is.
 */

/** Collect console and network into a buffer the page carries. Injected on
 *  every navigation — see the panel — because a log that starts when somebody
 *  asks for it has already missed the error they are asking about. */
export const COLLECTOR = `(() => {
  if (window.__agxLog) return 1;
  const cap = 300;
  /* inflight is what makes "wait until the network is quiet" a real thing
     rather than a guess at a duration. The log alone cannot answer it: it
     records requests that FINISHED, and the ones that matter for waiting are
     the ones that have not. (No backticks in this comment: it lives inside
     the template literal that builds the page script, and one would end it.) */
  const log = { console: [], network: [], startedAt: Date.now(), inflight: 0, lastSettled: Date.now() };
  window.__agxLog = log;
  const push = (arr, row) => { arr.push(row); if (arr.length > cap) arr.splice(0, arr.length - cap); };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const was = console[level];
    console[level] = function (...args) {
      try {
        push(log.console, {
          at: Date.now(), level,
          text: args.map((a) => {
            if (typeof a === "string") return a;
            if (a instanceof Error) return a.stack || a.message;
            try { return JSON.stringify(a); } catch { return String(a); }
          }).join(" ").slice(0, 2000),
        });
      } catch { /* never let logging break the page */ }
      return was.apply(this, args);
    };
  }
  /* An uncaught error never reaches console.error in every engine, and it is
     the one somebody is always looking for. */
  window.addEventListener("error", (e) => push(log.console, {
    at: Date.now(), level: "error",
    text: String(e.message || "error") + (e.filename ? " @ " + e.filename + ":" + e.lineno : ""),
    stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : undefined,
  }));
  window.addEventListener("unhandledrejection", (e) => push(log.console, {
    at: Date.now(), level: "error",
    text: "unhandled rejection: " + String((e.reason && (e.reason.stack || e.reason.message)) || e.reason).slice(0, 2000),
  }));
  /*
     DIALOGS, section 2. alert/confirm/prompt BLOCK the page: while one is up,
     nothing else answers, and every other verb times out with a message about
     the browser not responding — which is true and useless. Wrapping them lets
     an observation say what is actually going on, and answering rather than
     blocking means a page that pops a confirm on load is still drivable.
     The answer is recorded, so nobody has to guess what was clicked.
     The default answer is yes, and the dialog verb changes it: it arms
     window.__agxDialogPlan with {accept, text, always}, which answers the NEXT
     confirm or prompt (every one, with always) and is spent by it. A plan lives
     in the document, so a navigation drops it, as it drops everything else.
  */
  for (const kind of ["alert", "confirm", "prompt"]) {
    const was = window[kind];
    window[kind] = function (msg, def) {
      const plan = kind === "alert" ? null : window.__agxDialogPlan || null;
      const accept = plan ? plan.accept : true;
      window.__agxDialog = { kind, message: String(msg == null ? "" : msg).slice(0, 500), at: Date.now(), answered: kind === "alert" ? null : accept };
      if (plan && !plan.always) window.__agxDialogPlan = null;
      if (kind === "alert") return undefined;
      if (kind === "confirm") return accept;
      if (!accept) return null;
      return plan && plan.text != null ? plan.text : def == null ? "" : def;
    };
    window["__agx_" + kind] = was;
  }
  const t0 = (u) => { try { return String(u); } catch { return "?"; } };
  /* One sieve, used everywhere a body is kept — see section 16. The field
     names are the ones a login form actually uses; the shapes are the ones a
     token actually has. */
  const redact = (text) => String(text)
    .replace(/("(?:pass(?:word|wd)?|secret|token|otp|pin|authorization|cookie)"\\s*:\\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/\\b(pass(?:word|wd)?|secret|token|otp|pin)=[^&\\s]+/gi, '$1=[redacted]')
    .replace(/\\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|xox[baprs])[-_][A-Za-z0-9_-]{10,}\\b/g, "[redacted]")
    .replace(/\\bAKIA[A-Z0-9]{16}\\b/g, "[redacted]")
    .replace(/\\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\\b/g, "[redacted]");
  /* Section 6: fake rules an agent has registered with the fake verb, checked
     against every request before it reaches the network. A lie told to the
     page on purpose, so every faked row carries fake: true rather than
     looking like a real failure. */
  log.fakes = log.fakes || [];
  const matchFake = (url) => log.fakes.find((f) => url.indexOf(f.pattern) !== -1) || null;
  const wrapFetch = window.fetch;
  /* The counter comes down in a finally, never on the happy path alone: a
     request that throws is a request that finished, and a counter that only
     came down on success would leave "the network is quiet" permanently false
     after the first failed call. */
  const settled = () => { log.inflight = Math.max(0, log.inflight - 1); log.lastSettled = Date.now(); };
  window.fetch = async function (...args) {
    const started = Date.now();
    log.inflight++;
    const url = t0(args[0] && args[0].url ? args[0].url : args[0]);
    const method = (args[1] && args[1].method) || (args[0] && args[0].method) || "GET";
    const fake = matchFake(url);
    if (fake) {
      if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
      if (fake.timeout) {
        push(log.network, { at: started, method, url, status: 0, ms: Date.now() - started,
          fake: true, error: "faked: timed out (no response)" });
        return new Promise(() => {}); // never settles — that IS the fake
      }
      push(log.network, { at: started, method, url, status: fake.status, ms: Date.now() - started, fake: true });
      return new Response(fake.body || "", { status: fake.status, statusText: "" });
    }
    try {
      const r = await wrapFetch.apply(this, args);
      /*
         The bodies, section 6 — but through the same sieve section 16 applies
         to everything else. A request body is where a password is POSTed, and
         a log that keeps it is the exact failure that got another browser tool
         banned from this machine. Token shapes and the obvious field names go;
         the rest is kept, because a body with everything removed answers
         nothing.

         Capped hard: a JSON list of five hundred rows is not diagnosis, it is
         a page of the answer an agent pays for on every turn afterwards.
      */
      let sent = "";
      try {
        const raw = args[1] && args[1].body;
        if (typeof raw === "string") sent = redact(raw).slice(0, 2000);
      } catch (e) { sent = ""; }
      let got = "";
      try {
        const type = r.headers.get("content-type") || "";
        if (/json|text|xml/.test(type)) got = redact(await r.clone().text()).slice(0, 2000);
      } catch (e) { got = ""; }
      push(log.network, { at: started, method, url, status: r.status, ms: Date.now() - started,
        size: Number(r.headers.get("content-length")) || 0,
        sent: sent || undefined, got: got || undefined });
      return r;
    } catch (e) {
      push(log.network, { at: started, method, url, status: 0, ms: Date.now() - started, error: String(e).slice(0, 300) });
      throw e;
    } finally {
      settled();
    }
  };
  /*
     WebSockets and SSE, section 6. Neither goes through fetch or XHR, so a
     page whose whole story is a socket had an EMPTY network log — which reads
     as "nothing is happening" when the truth is "everything is happening
     somewhere you are not looking".

     Frames are counted and the last few kept, not all of them: a socket that
     ticks twice a second fills any buffer in a minute, and what a caller needs
     is almost always "is it still alive and what did it last say".
  */
  const WS = window.WebSocket;
  if (WS) {
    window.WebSocket = function (url, protocols) {
      const sock = protocols === undefined ? new WS(url) : new WS(url, protocols);
      const row = { at: Date.now(), method: "WS", url: t0(url), status: 0, ms: 0, frames: 0, last: "" };
      push(log.network, row);
      sock.addEventListener("open", () => { row.status = 101; row.ms = Date.now() - row.at; });
      sock.addEventListener("message", (ev) => {
        row.frames++;
        row.last = String(ev.data == null ? "" : ev.data).slice(0, 200);
      });
      sock.addEventListener("close", () => { row.status = row.status || 0; row.closed = true; });
      sock.addEventListener("error", () => { row.error = "socket error"; });
      return sock;
    };
    window.WebSocket.prototype = WS.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) window.WebSocket[k] = WS[k];
  }
  const ES = window.EventSource;
  if (ES) {
    window.EventSource = function (url, init) {
      const src = init === undefined ? new ES(url) : new ES(url, init);
      const row = { at: Date.now(), method: "SSE", url: t0(url), status: 0, ms: 0, frames: 0, last: "" };
      push(log.network, row);
      src.addEventListener("open", () => { row.status = 200; row.ms = Date.now() - row.at; });
      src.addEventListener("message", (ev) => {
        row.frames++;
        row.last = String(ev.data == null ? "" : ev.data).slice(0, 200);
      });
      src.addEventListener("error", () => { row.error = "stream error"; });
      return src;
    };
    window.EventSource.prototype = ES.prototype;
  }
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__agx = { method: m, url: t0(u) }; return XO.call(this, m, u, ...rest); };
  XMLHttpRequest.prototype.send = function (...a) {
    const started = Date.now();
    log.inflight++;
    /* loadend fires for success, error and abort alike — which is exactly the
       event a counter wants, and the reason it is that one and not load. */
    this.addEventListener("loadend", () => { settled(); });
    const w = this.__agx || {};
    const fake = matchFake(w.url || "");
    if (fake) {
      const settle = () => {
        push(log.network, { at: started, method: w.method || "GET", url: w.url || "?",
          status: fake.timeout ? 0 : fake.status, ms: Date.now() - started, fake: true,
          error: fake.timeout ? "faked: timed out (no response)" : undefined });
        if (fake.timeout) return; // never fires load/loadend — that IS the fake
        Object.defineProperty(this, "status", { value: fake.status, configurable: true });
        Object.defineProperty(this, "readyState", { value: 4, configurable: true });
        Object.defineProperty(this, "responseText", { value: fake.body || "", configurable: true });
        Object.defineProperty(this, "response", { value: fake.body || "", configurable: true });
        this.dispatchEvent(new Event("readystatechange"));
        this.dispatchEvent(new Event("load"));
        this.dispatchEvent(new Event("loadend"));
      };
      setTimeout(settle, fake.delayMs || 0);
      return;
    }
    this.addEventListener("loadend", () => {
      push(log.network, { at: started, method: w.method || "GET", url: w.url || "?", status: this.status, ms: Date.now() - started,
        size: Number(this.getResponseHeader && this.getResponseHeader("content-length")) || 0 });
    });
    return XS.apply(this, a);
  };
  return 1;
})()`;

/**
 * What a FAILURE attaches, unasked (§15).
 *
 * "A failure always attaches the last console errors, the last failed
 * requests, and a screenshot — the biggest time saver on the whole list,
 * because today a failure forces me to rebuild the state from outside: curl
 * the server, read the source, re-read the whole page." The buffer is the
 * same one `console`/`network`/`observe` already read; this just takes the
 * tail of it that explains why the verb that just failed, failed.
 */
export const diagnosisScript = (): string => `(() => {
  const log = window.__agxLog || { console: [], network: [] };
  return {
    consoleErrors: log.console.filter((r) => r.level === "error").slice(-5),
    failedRequests: log.network.filter((r) => r.status === 0 || r.status >= 400).slice(-5),
  };
})()`;

/**
 * Where an id came from, asked of the page that is being told to act on it.
 *
 * Three answers, and a verb that gets one of the first two must refuse: this
 * document has never been observed (`unobserved`), so every id the caller
 * holds describes some other document — the page before a navigation, or a
 * different tab; or it has, and this id is not in any range an observe of it
 * minted (`foreign`), which is the same fact told apart from the first only by
 * the sentence it earns. `minted` is the one that lets the verb go on to look
 * for the node, and a node not found THEN is one the page dropped since.
 *
 * Function source rather than a script, so a caller embeds it beside its own
 * lookup in one round trip: `(${ID_ORIGIN})("e17")`. Comparisons are written
 * with `>=` only — see `actionable` in browserDrive.ts for why a less-than in
 * generated code is refused by the tests.
 */
export const ID_ORIGIN = `(id) => {
  const n = Number(id.slice(1));
  if (window.__agxSeq === undefined) return "unobserved";
  const ranges = window.__agxRanges || [];
  return ranges.some((r) => n >= r[0] && r[1] >= n) ? "minted" : "foreign";
}`;

/*
 * Put an id on a node, once — shared by `observe` and `region`, so the two
 * cannot disagree about which node an id names.
 *
 * The attribute alone is not proof the node was stamped: `cloneNode` and
 * markup copied from outerHTML carry it too, and measured in the app a cloned
 * row put one id on two nodes — the tree listed it twice and a click on it was
 * refused as ambiguous. So the nodes this page stamped are remembered in a
 * WeakSet, and a node carrying an id it was never given gets its own. The
 * original keeps its id whichever of the two comes first in the document.
 */
export const STAMP = `(el) => {
    const mine = window.__agxStamped || (window.__agxStamped = new WeakSet());
    if (!el.dataset.agxE || !mine.has(el)) {
      window.__agxSeq = (window.__agxSeq || 0) + 1;
      el.dataset.agxE = "e" + window.__agxSeq;
      mine.add(el);
    }
    return el.dataset.agxE;
  }`;

/*
 * WHAT CHANGED SINCE THE LAST LOOK, computed in the page.
 *
 * Measured on the agx-bench suite: observe was 85 of 220 calls and three
 * quarters of every byte an agent read, because each step re-sent the whole
 * tree to report that one heading changed. The ids are stamped on the nodes
 * (see `stamp` below), so a node that survived a re-render has the same id in
 * both snapshots and the diff can be keyed on it.
 *
 * A string rather than a function for the same reason as the rest of this
 * file: it is pasted into executeJavaScript, and a bundled function's source
 * is whatever the minifier made of it. Tests evaluate it on its own.
 *
 * `at` is NOT compared: a banner inserted at the top moves every box below it,
 * and a diff that reports the whole page as changed because it shifted 40px
 * is the full tree again with worse labels. A node that only moved is `same`;
 * a caller that needs fresh boxes asks for a plain observe. A field that went
 * away is reported as null, so "no longer disabled" survives JSON.
 */
export const OBSERVE_DIFF = `(prev, cur) => {
  const FIELDS = ["role", "name", "testid", "id", "disabled", "hidden", "covered"];
  const FORM_FIELDS = ["name", "type", "value", "checked", "options"];
  const eq = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  const byE = (arr) => { const m = Object.create(null); for (const n of arr || []) if (n && n.e) m[n.e] = n; return m; };
  const before = byE(prev.tree);
  const now = Object.create(null);
  const added = [], changed = [];
  let same = 0;
  for (const n of cur.tree) {
    now[n.e] = true;
    const p = before[n.e];
    if (!p) { added.push(n); continue; }
    const c = { e: n.e };
    let moved = false;
    for (const f of FIELDS) if (!eq(p[f], n[f])) { c[f] = n[f] === undefined ? null : n[f]; moved = true; }
    if (moved) changed.push(c); else same++;
  }
  const removed = (prev.tree || []).filter((n) => !now[n.e]).map((n) => n.e);
  const formBefore = byE(prev.form);
  const formNow = Object.create(null);
  const form = [];
  for (const f of cur.form) {
    formNow[f.e] = true;
    const p = formBefore[f.e];
    if (!p || FORM_FIELDS.some((k) => !eq(p[k], f[k]))) form.push(f);
  }
  const formRemoved = (prev.form || []).filter((f) => !formNow[f.e]).map((f) => f.e);
  return { added, removed, changed, same, form, formRemoved };
}`;

export type ObserveOpts = {
  /** Answer with what changed since `base`, when `base` is this document's. */
  delta?: boolean;
  /** Whose snapshot this is: two callers looking at one tab each keep their own. */
  key?: string;
  /** The caller's last observation, as the relay recorded it — null for none. */
  base?: { doc: string; seq: number } | null;
  /** Where this document's id counter starts if it has not started yet — see
   *  the note beside `stamp` below for why it comes from outside the page. */
  idBase?: number;
};

/**
 * The name a node goes by in an observation: the same function wherever a node
 * is named or looked up by name, so a name read off the tree is a name a
 * locator finds (`role=button[name="Save"]`). Not Chromium's accessible name —
 * a page script cannot read that — but the parts of it a person points at.
 */
export const ACC_NAME = `(el) => (
    el.getAttribute("aria-label") ||
    (el.labels && el.labels[0] && el.labels[0].innerText) ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    (el.innerText || "").trim().slice(0, 80) || ""
  ).trim().slice(0, 80)`;

/** Role, accessible name and data-testid — what a person points at, and what
 *  survives a class name changing. Interactive things only: a tree of every
 *  div is the wall of text this was meant to replace. */
export const PICK = "a,button,input,select,textarea,[role],[data-testid],summary,h1,h2,h3";

/** Everything at once. `since` filters the two logs; 0 means "from the top". */
export const observeScript = (since: number, treeMax: number, opts: ObserveOpts = {}): string => `(() => {
  const log = window.__agxLog || { console: [], network: [] };
  window.__agxSeq = Math.max(window.__agxSeq || 0, ${Number(opts.idBase) || 0});
  const firstId = window.__agxSeq + 1;
  const seen = (arr) => arr.filter((r) => !${since} || r.at > ${since});
  const name = ${ACC_NAME};
  const PICK = ${JSON.stringify(PICK)};
  /*
     STABLE IDS, section 17: "do not force people to invent CSS selectors when
     stable ids can be given". The id is stamped ON the node as a data
     attribute the first time it is seen, so it survives a re-render that keeps
     the element, survives a class name changing, and is the same string on the
     next observation. A counter on the page keeps them unique within it.

     The counter STARTS where the driver says, not at one. It used to restart
     on every navigation, which was called correct — "the ids described a
     document that is gone" — and it is exactly wrong for the caller: the new
     page mints its own e17, and an agent still holding the old one clicks
     whatever that now is. So every document in a window counts on from the
     last, no two documents share an id, and the ranges this document minted
     are kept on it (window.__agxRanges) for ID_ORIGIN to tell "gone since the
     observe" from "never yours to begin with".
  */
  const stamp = ${STAMP};
  /*
     WHY A THING IS NOT VISIBLE, and WHAT COVERS IT — section 2. A zero-sized
     box was silently skipped before, so an element that is there and hidden
     looked exactly like an element that does not exist. Those are opposite
     findings: one is a bug in the page, the other is a wrong selector.
  */
  const why = (el, r) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none") return "display:none";
    if (cs.visibility === "hidden") return "visibility:hidden";
    if (Number(cs.opacity) === 0) return "opacity:0";
    if (!r.width || !r.height) return "zero size";
    return null;
  };
  const covering = (el, r) => {
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return "off screen";
    const top = document.elementFromPoint(x, y);
    if (!top || top === el || el.contains(top) || top.contains(el)) return null;
    return (top.dataset && top.dataset.agxE ? top.dataset.agxE + " " : "")
      + top.tagName.toLowerCase()
      + (top.id ? "#" + top.id : "")
      + (top.className && typeof top.className === "string" ? "." + top.className.trim().split(/\\s+/)[0] : "");
  };
  const tree = [];
  for (const el of document.querySelectorAll(PICK)) {
    if (tree.length >= ${treeMax}) break;
    const r = el.getBoundingClientRect();
    const hidden = why(el, r);
    /* Hidden things are REPORTED, not dropped — but only the ones that would
       otherwise be interesting, so a page of display:none templates does not
       drown the tree. */
    if (hidden && tree.filter((t) => t.hidden).length >= 20) continue;
    const covered = hidden ? null : covering(el, r);
    tree.push({
      e: stamp(el),
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      name: name(el),
      testid: el.getAttribute("data-testid") || undefined,
      id: el.id || undefined,
      disabled: el.disabled === true || undefined,
      hidden: hidden || undefined,
      covered: covered || undefined,
      at: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    });
  }
  const form = [];
  for (const el of document.querySelectorAll("input,select,textarea")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    form.push({
      /* The same id the tree gives the node, so a delta can say WHICH field
         changed, and the field can be acted on straight from this list. */
      e: stamp(el),
      name: el.name || name(el) || el.id || "",
      type: el.type || el.tagName.toLowerCase(),
      value: el.type === "password" ? "(hidden)" : String(el.value ?? "").slice(0, 200),
      checked: el.type === "checkbox" || el.type === "radio" ? !!el.checked : undefined,
      options: el.tagName === "SELECT" ? [...el.options].map((o) => o.value).slice(0, 40) : undefined,
    });
  }
  if (window.__agxSeq >= firstId) (window.__agxRanges = window.__agxRanges || []).push([firstId, window.__agxSeq]);
  const full = {
    url: location.href,
    title: document.title,
    /* The id counter after stamping, for the driver that hands out the next
       base. Stripped before the observation reaches a caller. Not "seq":
       that one numbers the observations, for the delta baseline below. */
    idSeq: window.__agxSeq,
    /* The one that turns a capture into a false negative when nobody checks
       it: a page in a panel that is off screen behaves like a background tab
       — no polling, no timers, no autoplay. */
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
    readyState: document.readyState,
    now: Date.now(),
    /* So a caller trimming this to a token budget can keep what is in the
       viewport first, rather than whatever querySelectorAll happened upon. */
    viewport: { width: window.innerWidth, height: window.innerHeight },
    console: seen(log.console).slice(-80),
    network: seen(log.network).slice(-80),
    /* Section 6, and the sentence that made a silent fake unacceptable: "an
       observation while a fake is active says so, or somebody will spend an
       afternoon on a 500 they installed themselves." Always present, even
       empty, so its absence never has to be read as "none active". */
    fakes: (log.fakes || []).map((f) => ({ pattern: f.pattern, status: f.status, timeout: f.timeout, delayMs: f.delayMs })),
    tree,
    form,
    /* Section 2 asks for storage in the observation. Keys and sizes rather
       than values: a token in localStorage is exactly the kind of thing
       section 16 exists to keep out of a log, and the key alone answers "is it
       logged in" without carrying the secret. */
    storage: (() => {
      const keys = (s2) => { try { return Object.keys(s2).slice(0, 40); } catch { return []; } };
      return {
        local: keys(localStorage),
        session: keys(sessionStorage),
        cookieNames: document.cookie ? document.cookie.split(";").map((c) => c.split("=")[0].trim()).slice(0, 40) : [],
      };
    })(),
    /* A pending dialog is why nothing else on the page answers, and it is
       invisible to every other verb. */
    dialog: window.__agxDialog || undefined,
  };
  /*
     THE BASELINE, per document and per caller. The window object IS the
     document's lifetime: a navigation brings a new one, and with it an empty
     store, which is what makes "the last observe of the same document" free
     to ask. The document gets a random name so the relay can tell whether the
     caller's last look was at THIS document — a page restored from the
     back/forward cache still holds the store from before the caller left it,
     and a diff against that would describe a page the caller has not seen
     since. Every observe records a snapshot, full or not, so a plain observe
     followed by a delta one works.
  */
  if (!window.__agxDoc) {
    const b = new Uint32Array(2);
    try { crypto.getRandomValues(b); } catch { b[0] = Math.random() * 4294967296; b[1] = Date.now(); }
    window.__agxDoc = b[0].toString(36) + b[1].toString(36);
  }
  window.__agxObs = (window.__agxObs || 0) + 1;
  full.doc = window.__agxDoc;
  full.seq = window.__agxObs;
  const key = ${JSON.stringify(opts.key ?? "")};
  const store = window.__agxLast || (window.__agxLast = Object.create(null));
  const prev = store[key];
  store[key] = {
    seq: full.seq, now: full.now, tree: full.tree, form: full.form,
    storage: JSON.stringify(full.storage), viewport: JSON.stringify(full.viewport),
  };
  if (!${opts.delta === true}) return full;
  const base = ${JSON.stringify(opts.base ?? null)};
  const reason = !base ? "no earlier observe to compare with"
    : base.doc !== full.doc ? "new document"
    : !prev || prev.seq !== base.seq ? "the last observe of this page was not yours"
    : null;
  if (reason) return Object.assign(full, { delta: false, reason });
  const d = (${OBSERVE_DIFF})(prev, full);
  /* The tree is capped (and so are the hidden nodes in it), so a node missing
     from this list may still be on the page — pushed past the cap by the ones
     before it. Only a node gone from the document is "removed"; the rest are
     "unlisted": there, not described this time. */
  const unlisted = [];
  if (document.querySelector) {
    /* The baseline sits on the page's window, where the page can write:
       an id that is not one of ours is dropped, never put in a selector. */
    d.removed = d.removed.filter((e) => {
      if (typeof e !== "string" || !/^e[0-9]+$/.test(e)) return false;
      let still = null;
      try { still = document.querySelector('[data-agx-e="' + e + '"]'); } catch { still = null; }
      if (still) unlisted.push(e);
      return !still;
    });
  }
  /* A diff that is not smaller than what it diffs is the full answer with
     worse labels — a route that re-renders the whole app, say. */
  const touched = d.added.length + d.removed.length + d.changed.length + d.form.length + d.formRemoved.length;
  if (touched && JSON.stringify(d).length >= JSON.stringify({ tree: full.tree, form: full.form }).length) {
    return Object.assign(full, { delta: false, reason: "most of the page changed" });
  }
  /* Console and network since THAT look, unless the caller named a time. A
     request row is stamped with when it STARTED and written when it ends, so
     one in flight during the last look is new by its end, not its start. */
  const cut = ${since} || prev.now;
  const out = {
    delta: true, base: prev.seq, seq: full.seq, doc: full.doc, idSeq: full.idSeq,
    url: full.url, title: full.title, visible: full.visible, focused: full.focused,
    readyState: full.readyState, now: full.now,
    added: d.added, removed: d.removed, changed: d.changed, same: d.same,
    console: full.console.filter((r) => r.at > cut),
    network: full.network.filter((r) => r.at + (r.ms || 0) > cut),
    fakes: full.fakes,
    dialog: full.dialog,
  };
  /* The rest only when it moved: in a delta, an absent section is an
     unchanged one — the skill says so, because it is the one rule a reader
     has to know. */
  if (unlisted.length) out.unlisted = unlisted;
  if (d.form.length) out.form = d.form;
  if (d.formRemoved.length) out.formRemoved = d.formRemoved;
  if (store[key].storage !== prev.storage) out.storage = full.storage;
  if (store[key].viewport !== prev.viewport) out.viewport = full.viewport;
  return out;
})()`;
