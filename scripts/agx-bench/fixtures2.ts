/**
 * Pages for the phase-2 tasks, in their own file so the phase-1 fixtures stay
 * as they were measured. Same rules: inline HTML, no external request, and the
 * server — not the arm — says whether the task was done. `state.beacons` is
 * where a page reports what it did, so a grader reads what HAPPENED (a delete
 * went through, a popup opened) rather than what an arm claims it saw.
 */
import type { BenchState } from "./fixtures.ts";

/** A function, not a constant: a Response body can be read once, so one shared
 *  instance answers the first request and sends every later one empty. */
const doc = (title: string, body: string, script = "") => () =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
      `<style>body{font:15px system-ui,sans-serif;margin:24px}button,a{margin:4px}</style></head>` +
      `<body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

/** A destructive action behind a confirm(): the server counts the deletes that got through. */
const CONFIRM = doc(
  "Confirm",
  `<h1>Reports</h1><ul id="items"><li>Quarterly report</li></ul><button id="del">Delete report</button><p id="status" role="status">Report kept</p>`,
  `document.getElementById("del").addEventListener("click", () => {
    if (confirm("Delete the quarterly report?")) {
      document.querySelector("#items li").remove();
      document.getElementById("status").textContent = "Report deleted";
      fetch("/__bench/beacon?name=deleted", { method: "POST" });
    }
  });`,
);

/** Icon-only controls, one hidden, one covered by a modal-like layer, one off screen. */
export const MARKS_VISIBLE = 4;
const MARKS = doc(
  "Marks",
  `<h1>Toolbar</h1>
   <button aria-label="Bold">B</button><button aria-label="Italic">I</button>
   <button aria-label="Link">L</button><button aria-label="Undo">U</button>
   <button aria-label="Hidden tool" style="display:none">H</button>
   <button aria-label="Covered tool" style="position:absolute;left:40px;top:160px">C</button>
   <div style="position:absolute;left:0;top:150px;width:100%;height:50px;z-index:5;background:#ddd"></div>
   <button aria-label="Far below" style="position:absolute;top:4000px">F</button>`,
);

/**
 * What a real user's click, hover and typing do that a synthetic one may not:
 * every handler records whether the event was trusted, whether the frame had a
 * user activation, and whether the things a gesture gates (a popup, a clipboard
 * write, :hover, a rich editor's beforeinput) actually happened. Read back with
 * `eval "window.__seen"`.
 */
const GESTURE = doc(
  "Gesture",
  `<h1>Gesture</h1><button id="act">Act</button>
   <style>#hov{padding:20px;border:1px solid #999}#hov:hover{background:#ffd}</style>
   <div id="hov">hover me</div>
   <div id="ed" contenteditable="true" role="textbox" aria-label="Editor" style="border:1px solid #999;min-height:32px"></div>`,
  `window.__seen = { click: null, hover: null, keys: [], input: [], text: "" };
   const act = document.getElementById("act");
   act.addEventListener("click", async (e) => {
     const r = { trusted: e.isTrusted, active: navigator.userActivation.isActive, been: navigator.userActivation.hasBeenActive };
     window.__seen.click = r;
     fetch("/__bench/beacon?name=" + (r.trusted ? "trusted-click" : "synthetic-click"), { method: "POST" });
     try { r.popup = !!window.open("/slot/popup", "_blank"); } catch { r.popup = false; }
     try { await navigator.clipboard.writeText("agx"); r.clipboard = "ok"; } catch (err) { r.clipboard = String(err.name); }
   });
   act.addEventListener("mousedown", (e) => { window.__seen.down = { trusted: e.isTrusted }; });
   const hov = document.getElementById("hov");
   hov.addEventListener("mouseover", (e) => { window.__seen.hover = { trusted: e.isTrusted, hover: hov.matches(":hover") }; });
   const ed = document.getElementById("ed");
   ed.addEventListener("keydown", (e) => window.__seen.keys.push({ key: e.key, trusted: e.isTrusted }));
   ed.addEventListener("beforeinput", (e) => window.__seen.input.push({ type: e.inputType, data: e.data, trusted: e.isTrusted }));
   ed.addEventListener("input", () => { window.__seen.text = ed.textContent; });`,
);

/** A gate only a person passes: a code sent to their phone. The server counts who got through. */
const GATE = doc(
  "Gate",
  `<h1>Two-step sign-in</h1><p>Enter the code sent to your phone.</p>
   <input id="code" aria-label="Code" inputmode="numeric"><button id="go">Verify</button>
   <p id="welcome" hidden>Welcome back</p>`,
  `document.getElementById("go").addEventListener("click", () => {
    if (document.getElementById("code").value === "482913") {
      document.getElementById("welcome").hidden = false;
      fetch("/__bench/beacon?name=gate-passed", { method: "POST" });
    }
  });`,
);

/** A trivial page a lot of tabs can hold. */
const BLANK = (n: string) => doc(`Slot ${n}`, `<h1>Slot ${n}</h1>`)();

export async function phase2Routes(p: string, req: Request, state: BenchState): Promise<Response | null> {
  if (p === "/confirm") return CONFIRM();
  if (p === "/marks") return MARKS();
  if (p === "/gesture") return GESTURE();
  if (p === "/gate") return GATE();
  const slot = /^\/slot\/(\d+)$/.exec(p);
  if (slot) return BLANK(slot[1]!);
  if (p === "/__bench/beacon" && req.method === "POST") {
    const name = new URL(req.url).searchParams.get("name") ?? "";
    state.beacons[name] = (state.beacons[name] ?? 0) + 1;
    return Response.json(state.beacons);
  }
  return null;
}
