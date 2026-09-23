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

/** A trivial page a lot of tabs can hold. */
const BLANK = (n: string) => doc(`Slot ${n}`, `<h1>Slot ${n}</h1>`)();

export async function phase2Routes(p: string, req: Request, state: BenchState): Promise<Response | null> {
  if (p === "/confirm") return CONFIRM();
  if (p === "/marks") return MARKS();
  const slot = /^\/slot\/(\d+)$/.exec(p);
  if (slot) return BLANK(slot[1]!);
  if (p === "/__bench/beacon" && req.method === "POST") {
    const name = new URL(req.url).searchParams.get("name") ?? "";
    state.beacons[name] = (state.beacons[name] ?? 0) + 1;
    return Response.json(state.beacons);
  }
  return null;
}
