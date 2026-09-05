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
  */
  for (const kind of ["alert", "confirm", "prompt"]) {
    const was = window[kind];
    window[kind] = function (msg, def) {
      window.__agxDialog = { kind, message: String(msg == null ? "" : msg).slice(0, 500), at: Date.now(), answered: kind === "alert" ? null : true };
      if (kind === "alert") return undefined;
      if (kind === "confirm") return true;
      return def == null ? "" : def;
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

/** Everything at once. `since` filters the two logs; 0 means "from the top". */
export const observeScript = (since: number, treeMax: number): string => `(() => {
  const log = window.__agxLog || { console: [], network: [] };
  const seen = (arr) => arr.filter((r) => !${since} || r.at > ${since});
  const name = (el) => (
    el.getAttribute("aria-label") ||
    (el.labels && el.labels[0] && el.labels[0].innerText) ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    (el.innerText || "").trim().slice(0, 80) || ""
  ).trim().slice(0, 80);
  /* Role, accessible name and data-testid — what a person points at, and what
     survives a class name changing. Interactive things only: a tree of every
     div is the wall of text this was meant to replace. */
  const PICK = "a,button,input,select,textarea,[role],[data-testid],summary,h1,h2,h3";
  /*
     STABLE IDS, section 17: "do not force people to invent CSS selectors when
     stable ids can be given". The id is stamped ON the node as a data
     attribute the first time it is seen, so it survives a re-render that keeps
     the element, survives a class name changing, and is the same string on the
     next observation. A counter on the page keeps them unique; a navigation
     starts a fresh page and a fresh counter, which is correct — the ids
     described a document that is gone.
  */
  const stamp = (el) => {
    if (!el.dataset.agxE) {
      window.__agxSeq = (window.__agxSeq || 0) + 1;
      el.dataset.agxE = "e" + window.__agxSeq;
    }
    return el.dataset.agxE;
  };
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
      name: el.name || name(el) || el.id || "",
      type: el.type || el.tagName.toLowerCase(),
      value: el.type === "password" ? "(hidden)" : String(el.value ?? "").slice(0, 200),
      checked: el.type === "checkbox" || el.type === "radio" ? !!el.checked : undefined,
      options: el.tagName === "SELECT" ? [...el.options].map((o) => o.value).slice(0, 40) : undefined,
    });
  }
  return {
    url: location.href,
    title: document.title,
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
})()`;
