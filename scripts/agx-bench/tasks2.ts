/**
 * Phase-2 tasks. One per item, in the same shape as tasks.ts: a `baseline` arm
 * that does what an agent could do before the item, a `phase2` arm that uses
 * it, and one grader for both. A baseline that FAILS is the point of a task
 * about something the old code could not do; it says so where it fails.
 *
 * These are scripted arms, so they prove the MECHANISM — the answer is right,
 * the bytes are what they are, the server saw the effect. Whether a model does
 * better with it is a question for the per-model A/B runs, not for this file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepFailed, type Node, type Session, type Task } from "./bench.ts";
import { MARKS_VISIBLE } from "./fixtures2.ts";
import { MARKS_ID, MARKS_SCRIPT } from "../../web/src/lib/browserMarks.ts";

const observeTree = async (s: Session): Promise<Node[]> => {
  const o = (await s.cli("observe")).json;
  if (!o || !Array.isArray(o.tree)) throw new StepFailed("observe did not return a tree");
  return o.tree as Node[];
};

/** The text an MCP tool answered, parsed when it is JSON. */
const mcpValue = (reply: any): any => {
  const text = reply?.result?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return text; }
};
const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

export const PHASE2_TASKS: Task[] = [
  {
    id: "p2-dialog-cancel",
    family: "phase2",
    title: "Item 6, dialog: cancel a delete that asks \"are you sure?\" — the report must still be there",
    arms: {
      // Before: every confirm() is answered yes, so the cancel path cannot be taken.
      async baseline(s) {
        await s.cli("open", [s.url("/confirm")]);
        await s.cli("click", ['role=button[name="Delete report"]']);
        return { status: (await s.cli("text", ["role=status"])).stdout.trim() };
      },
      async phase2(s) {
        await s.cli("open", [s.url("/confirm")]);
        await s.cli("dialog", ["--dismiss"]);
        await s.cli("click", ['role=button[name="Delete report"]']);
        const seen = (await s.cli("dialog")).json;
        return { status: (await s.cli("text", ["role=status"])).stdout.trim(), asked: seen?.last?.message };
      },
    },
    grade: (a, state) =>
      (state.beacons.deleted ?? 0) > 0 ? `the delete went through (${state.beacons.deleted}x): the confirm was answered yes`
        : a?.status !== "Report kept" ? `status was ${JSON.stringify(a?.status)}` : null,
  },
  {
    id: "p2-shot-marks",
    family: "phase2",
    title: "Item 6, shot --marks: the picture carries the same ids observe gives — visible, uncovered controls only",
    arms: {
      // Before: a picture has no ids on it; all an arm can hand back is what the tree says.
      async baseline(s) {
        await s.cli("open", [s.url("/marks")]);
        const tree = await observeTree(s);
        const ids = tree.filter((n: any) => n.role === "button" && !n.hidden && !n.covered && n.at?.[1] < 600).map((n) => n.e);
        return { ids, marks: [] as string[] };
      },
      async phase2(s) {
        await s.cli("open", [s.url("/marks")]);
        const tree = await observeTree(s);
        const ids = tree.filter((n: any) => n.role === "button" && !n.hidden && !n.covered && n.at?.[1] < 600).map((n) => n.e);
        // The overlay's own script, run in the real page: which controls it
        // labels, with which ids. Then the real verb, whose capture step needs
        // a pane somebody is looking at — the hidden workspace this bench runs
        // in paints no frames — so it is tried and its outcome recorded, not
        // required.
        const drawn = (await s.cli("eval", [MARKS_SCRIPT])).json?.value;
        await s.cli("eval", [`document.getElementById(${JSON.stringify(MARKS_ID)}).remove()`]);
        const dir = mkdtempSync(join(tmpdir(), "agx-marks-"));
        try {
          const shot = await s.cli("shot", [join(dir, "marked.png"), "--marks"], { allowFail: true });
          const line = shot.stdout.split("\n").find((l) => l.startsWith("marks: "));
          return {
            ids, marks: Array.isArray(drawn) ? drawn : [],
            pictured: shot.exit === 0 && line !== undefined,
            pictureMarks: line ? line.slice("marks: ".length).split(" ").filter(Boolean) : null,
          };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    grade: (a) => {
      const marks = new Set<string>(a?.marks ?? []);
      const ids = new Set<string>(a?.ids ?? []);
      if (ids.size !== MARKS_VISIBLE) return `observe found ${ids.size} usable controls, the fixture has ${MARKS_VISIBLE}`;
      if (!marks.size) return "nothing labelled on the picture";
      const same = marks.size === ids.size && [...ids].every((i) => marks.has(i));
      if (a.pictureMarks && a.pictureMarks.join(" ") !== [...marks].join(" ")) return `the real shot labelled ${a.pictureMarks.join(" ")}`;
      return same ? null : `the picture says ${[...marks].join(" ")}, the tree says ${[...ids].join(" ")}`;
    },
  },
  {
    id: "p2-real-input",
    family: "phase2",
    title: "Item 7, input a page can tell from nothing: a click with user activation (clipboard), a real :hover, a rich editor",
    arms: {
      // Before: what an agent could do was script the page — a synthetic click
      // (no activation), a synthetic mouseover (no :hover), a value assignment.
      async baseline(s) {
        await s.cli("open", [s.url("/gesture")]);
        await s.cli("eval", [`(() => { document.getElementById("act").click(); document.getElementById("hov").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); return 1; })()`]);
        return seen(s);
      },
      async phase2(s) {
        await s.cli("open", [s.url("/gesture")]);
        await s.cli("click", ['role=button[name="Act"]']);
        await s.cli("hover", ["#hov"]);
        await s.cli("type", ['role=textbox[name="Editor"]', "hello"]);
        await s.cli("type", ['role=textbox[name="Editor"]', "bye"]);
        return seen(s);
      },
    },
    grade: (a) => {
      const missing: string[] = [];
      if (!a?.click?.active) missing.push("user activation on the click");
      if (a?.click?.clipboard !== "ok") missing.push(`clipboard write (${a?.click?.clipboard})`);
      if (a?.hover?.hover !== true) missing.push(":hover");
      if (a?.text !== "bye") missing.push(`editor text (${JSON.stringify(a?.text)})`);
      return missing.length ? `missing ${missing.join(", ")}` : null;
    },
  },
  {
    id: "p2-handoff",
    family: "phase2",
    title: "Item 11, handoff: a code only the person has — the agent hands the tab over and carries on when they are done",
    arms: {
      // Before: nothing to do but try and stop. The agent has no code.
      async baseline(s) {
        await s.cli("open", [s.url("/gate")]);
        await s.cli("click", ["#go"]);
        return { state: "stuck" };
      },
      async phase2(s) {
        await s.cli("open", [s.url("/gate")]);
        const waiting = s.cli("handoff", ["Enter the code from your phone", "--until", "#welcome", "--timeout", "60"], { allowFail: true });
        // The person, played by a script: reads the code off their phone and types it in.
        await Bun.sleep(2500);
        await s.cli("eval", [`(() => { const c = document.getElementById("code"); c.value = "482913"; document.getElementById("go").click(); return 1; })()`]);
        const r = await waiting;
        return { state: r.json?.state ?? `exit ${r.exit}: ${r.stderr.slice(0, 80)}` };
      },
    },
    grade: (a, state) =>
      !(state.beacons["gate-passed"] > 0) ? `the gate was never passed (${a?.state})`
        : a?.state !== "condition" && a?.state !== "done" ? `the handoff ended as ${JSON.stringify(a?.state)}` : null,
  },
  {
    id: "p2-audit",
    family: "phase2",
    title: "Item 13, vitals and a11y: a measurement answered as data — the faults of a page, with ids, and an honest verdict",
    arms: {
      // Before: checkup's advice lines (unlabelled controls, images without alt) — no heading
      // outline, no lang, no rated vitals.
      async baseline(s) {
        await s.cli("open", [s.url("/audit")]);
        await Bun.sleep(600);
        const c = (await s.cli("checkup", ["--no-shot"])).json;
        return { a11y: c?.a11y ?? {}, vitals: null };
      },
      async phase2(s) {
        await s.cli("open", [s.url("/audit")]);
        await Bun.sleep(600);
        const a = (await s.cli("a11y")).json;
        const v = (await s.cli("vitals")).json;
        return { a11y: a?.problems ?? {}, vitals: v };
      },
    },
    grade: (a) => {
      const p = a?.a11y ?? {};
      const missing: string[] = [];
      if (!(p.unlabelled?.n >= 1 || p.unlabelled >= 1)) missing.push("the unlabelled button");
      if (!(p.imgNoAlt?.n >= 1 || p.imgNoAlt >= 1)) missing.push("the image without alt");
      if (!(p.headingSkips?.n >= 1)) missing.push("the heading jump");
      if (!p.noLang) missing.push("the missing lang");
      const v = a?.vitals;
      if (!v || typeof v.verdict !== "string") missing.push("a vitals verdict");
      // A page that never painted (this bench's hidden pane) must say so, not claim "good".
      else if (v.vitals?.lcpMs === undefined && v.verdict === "good") missing.push("an honest verdict for an unpainted page");
      return missing.length ? `missing ${missing.join(", ")}` : null;
    },
  },
  {
    id: "p2-clean-html",
    family: "phase2",
    title: "Item 9, html --clean: the page's markup without what a model cannot use, and with ids it can act on",
    arms: {
      async baseline(s) {
        await s.cli("open", [s.url("/audit")]);
        const raw = (await s.cli("html", ["body"])).json;
        return { html: String(raw?.html ?? ""), rawLength: String(raw?.html ?? "").length };
      },
      async phase2(s) {
        await s.cli("open", [s.url("/audit")]);
        const raw = (await s.cli("html", ["body"])).json;
        const clean = (await s.cli("html", ["body", "--clean"])).json;
        return { html: String(clean?.html ?? ""), rawLength: String(raw?.html ?? "").length };
      },
    },
    grade: (a) => {
      const h: string = a?.html ?? "";
      if (/<script|<style|<svg[^>]*><path/i.test(h)) return "scripts, styles or svg paths are still in the markup";
      if (!/<button[^>]*data-agx-e="e\d+"/.test(h)) return "the button carries no observe id";
      return h.length < a.rawLength * 0.85 ? null : `${h.length} B is not smaller than the raw ${a.rawLength} B`;
    },
  },
  {
    id: "p2-wait-slot",
    family: "phase2",
    title: "Item 6, --wait-slot: with every slot taken, a new tab queues for the one that frees up",
    arms: {
      async baseline(s) {
        const held = await fill(s);
        try {
          const r = await s.cli("newtab", [s.url("/slot/x")], { allowFail: true });
          return { gotTab: r.exit === 0, waitedMs: 0, refusedBy: r.stderr.trim().slice(0, 80) };
        } finally {
          await release(s, held);
        }
      },
      async phase2(s) {
        const held = await fill(s);
        try {
          const t0 = performance.now();
          const waiting = s.cli("newtab", [s.url("/slot/x"), "--wait-slot", "30"], { allowFail: true });
          await Bun.sleep(2500);
          if (held.length) await s.cli("closetab", [held.pop()!], { allowFail: true });
          const r = await waiting;
          if (r.json?.id) held.push(String(r.json.id));
          return { gotTab: r.exit === 0, waitedMs: Math.round(performance.now() - t0), refusedBy: r.stderr.trim().slice(0, 80) };
        } finally {
          await release(s, held);
        }
      },
    },
    grade: (a) => (a?.gotTab ? (a.waitedMs >= 2000 ? null : `got a tab in ${a.waitedMs} ms without waiting for a slot`) : `no tab: ${a?.refusedBy}`),
  },
  {
    id: "p2-mcp-core",
    family: "phase2",
    title: "Item 5, MCP diet: the same three-step task through the full tool list and through core + the generic tool",
    arms: {
      async baseline(s) {
        const { replies } = await s.mcp("full", [
          LIST,
          call(2, "browser_open", { url: s.url("/spa/") }),
          call(3, "browser_click", { selector: 'role=link[name="Items"]' }),
          call(4, "browser_reload", {}),
          call(5, "browser_observe", {}),
        ]);
        return summarize(replies);
      },
      async phase2(s) {
        const { replies } = await s.mcp("core", [
          LIST,
          call(2, "browser_open", { url: s.url("/spa/") }),
          call(3, "browser_click", { selector: 'role=link[name="Items"]' }),
          // Not a core tool: reached through the one generic one.
          call(4, "browser", { verb: "reload", args: {} }),
          call(5, "browser_observe", {}),
        ]);
        return summarize(replies);
      },
    },
    grade: (a) => (a?.error ? a.error : a?.heading === "Items" ? null : `ended on ${JSON.stringify(a?.heading)}`),
  },
];

async function seen(s: Session) {
  await Bun.sleep(400);
  const v = (await s.cli("eval", ["JSON.stringify(window.__seen)"])).json?.value;
  return typeof v === "string" ? JSON.parse(v) : {};
}

function summarize(replies: any[]) {
  const bad = replies.slice(1).find((r) => r?.result?.isError || r?.error);
  if (bad) return { error: `a call failed: ${JSON.stringify(bad).slice(0, 200)}` };
  const listBytes = JSON.stringify(replies[0]?.result?.tools ?? []).length;
  const obs = mcpValue(replies[replies.length - 1]);
  const heading = (obs?.tree ?? []).find((n: Node) => n.role === "h1")?.name;
  return { heading, listBytes, tools: replies[0]?.result?.tools?.length };
}

/** Open tabs until the panel says it is full; return their ids so they can be closed. */
async function fill(s: Session): Promise<string[]> {
  const held: string[] = [];
  for (let i = 0; i < 16; i++) {
    const r = await s.cli("newtab", [s.url(`/slot/${i}`)], { allowFail: true });
    if (r.exit !== 0) {
      if (!r.stderr.includes("pages awake at once")) throw new StepFailed(`newtab failed for another reason: ${r.stderr.slice(0, 200)}`);
      return held;
    }
    if (r.json?.id) held.push(String(r.json.id));
  }
  throw new StepFailed("the panel never said it was full");
}

async function release(s: Session, held: string[]) {
  for (const id of held) await s.cli("closetab", [id], { allowFail: true });
}
