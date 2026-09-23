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
