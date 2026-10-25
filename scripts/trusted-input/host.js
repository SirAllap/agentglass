/* Drives the fixture through the real verbs (runBrowserAsk from
   web/src/lib/browserDrive.ts, bundled) and prints one JSON line per check. */
const { ipcRenderer } = require("electron");
const wv = document.getElementById("wv");
const mine = document.getElementById("mine");
const out = (o) => ipcRenderer.send("line", JSON.stringify(o));
const off = new URLSearchParams(location.search).has("off");

wv.addEventListener("dom-ready", async () => {
  if (wv.dataset.ran) return;
  wv.dataset.ran = "1";
  try {
    const { runBrowserAsk } = await import("./drive.js");
    const gid = wv.getWebContentsId();
    const cdp = (method, params) => ipcRenderer.invoke("cdp", { gid, method, params });
    /* `off` forces the script path: the check must go red with it. */
    const input = off ? async () => ({ ok: false, error: "forced off" })
      : (req) => ipcRenderer.invoke("input", { ...req, guestId: gid });
    const none = async () => ({ ok: false, error: "not here" });
    let n = 0;
    const ask = (op, args) => runBrowserAsk(wv, { id: String(++n), op, args }, undefined, undefined, none, cdp, async () => [], none, none, input);
    const page = (js) => wv.executeJavaScript(js);
    const check = async (name, run, verify) => {
      mine.focus();
      let reply;
      try { reply = await run(); } catch (err) { reply = { ok: false, error: String(err) }; }
      await new Promise((r) => setTimeout(r, 150));
      const got = await verify(reply);
      out({ name, ok: reply.ok === true && reply.value?.trusted === true && got === true && document.activeElement === mine,
        trusted: reply.value?.trusted, page: got, hostFocus: document.activeElement === mine, error: reply.error });
    };
    const seen = (what) => page(`seen.includes(${JSON.stringify(what)})`);

    await check("click", () => ask("click", { selector: "#go" }), () => seen("go"));
    const tree = await ask("observe", {});
    const id = (JSON.stringify(tree.value ?? "").match(/"(e\d+)"[^{}]*?"name":"Add"/) || [])[1]
      || (JSON.stringify(tree.value ?? "").match(/(e\d+)[^\n]{0,40}Add/) || [])[1];
    await check("click in an open shadow root (observe id " + id + ")", () => ask("click", { selector: id }), () => seen("add"));
    const inner = (JSON.stringify(tree.value ?? "").match(/(e\d+)[^\n]{0,40}Inner/) || [])[1];
    await check("click in a same-origin frame (observe id " + inner + ")", () => ask("click", { selector: inner }), () => seen("inner"));
    await check("dblclick", () => ask("dblclick", { selector: "#dbl" }), () => seen("dbl"));
    await check("hover", () => ask("hover", { selector: "#hov" }), () => seen("hov"));
    await check("type into a contenteditable", () => ask("type", { selector: "#ed", text: "Hello, wörld" }),
      async () => (await page("ed.textContent")) === "Hello, wörld");
    await check("press Control+a then Backspace", async () => {
      await page("ed.focus()");
      const a = await ask("press", { key: "Control+a" });
      return a.ok ? ask("press", { key: "Backspace" }) : a;
    }, async () => (await page("ed.textContent")) === "");
    await check("fill", () => ask("fill", { fields: { "#who": "Ada", "#mail": "ada@example.com" } }),
      async () => (await page("who.value + '|' + mail.value")) === "Ada|ada@example.com");
    /* The app's own chords, pressed by an agent: the page gets each one and
       nothing in the app is closed, opened or focused. */
    for (const key of ["Control+w", "Control+t", "Control+l", "Control+Shift+i"]) {
      const k = key.split("+").pop().toLowerCase();
      await check(`press ${key} reaches the page and not the app`, async () => {
        await page("ed.focus()");
        return ask("press", { key });
      }, async () => {
        const c = await ipcRenderer.invoke("chords");
        return (await seen("chord:" + k)) && c.marked.includes(k) && c.forwarded.length === 0;
      });
    }
    wv.style.visibility = "hidden";
    await page("seen.length = 0");
    await check("click on a hidden tab", () => ask("click", { selector: "#go" }), () => seen("go"));
  } catch (err) {
    out({ name: "harness", ok: false, error: String(err && err.stack || err) });
  }
  ipcRenderer.send("done");
});
