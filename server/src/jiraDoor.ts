/*
 * The agent's door to a Jira card: read it, list its moves and steps, run a
 * configured step, link a pull request.
 *
 * It is not a second implementation. Each verb calls the function the matching
 * route calls (`detailStored`, `movesStored`, `runStepBody`, `linkPullRequestStored`),
 * so the write switch, the per-card lock, the stamp check and the host guard on
 * a pull request address are the ones the screen already has, and a sentence
 * that refuses here is the sentence the screen shows. What this file adds is
 * the shape of the answer, and the shape is the point: `state` holds what the
 * app or the site minted (ids, counts, the stamp), `untrusted` holds every
 * string a person typed on the site (a title, a description, a comment, a
 * status name a team chose), so an agent can read the second as data and never
 * as an instruction. `error` is a sentence of ours and Jira's own error text
 * never reaches an answer (see jira.ts); what a refusal can still carry is a
 * name the site holds (a status, a field a move asks for), so it is read as
 * what happened and not as something to do.
 *
 * Ceiling: a card's description and comments are cut to fit UNTRUSTED_MAX_BYTES
 * between them, newest comments kept, and the short fields (title, labels,
 * people) are as long as the site made them;
 * a file is named and sized but its bytes are not here (an agent has no use for a file it cannot open), and the
 * change history is not here yet. The lists a card carries (subtasks, linked cards, files, Details) are cut to
 * ROWS_MAX rows each, with the count of the rest in `state`.
 */
import type { ProviderTask, TaskDetail } from "../../shared/providers.ts";
import { UNTRUSTED_MAX_BYTES } from "../../shared/uiActions.ts";
import { ISSUE_KEY, linkPullRequestStored, movesStored, jiraWriteEnabled, remoteLinksAllStored } from "./jira.ts";
import { ACTIVITY_KINDS, activityStored, type ActivityKind } from "./jiraActivity.ts";
import { detailStored } from "./jiraComments.ts";
import { jiraSteps, runStepBody, STEP_KEYS } from "./jiraSteps.ts";
import { rememberOwnMove } from "./jirawatch.ts";

export const DOOR_VERBS = ["card", "moves", "links", "activity", "steps", "step", "link"] as const;
export type DoorVerb = (typeof DOOR_VERBS)[number];
/** The verbs that change the site. The rest read. */
export const DOOR_ACTING: readonly DoorVerb[] = ["step", "link"];
export const isActing = (v: string): boolean => (DOOR_ACTING as readonly string[]).includes(v);

/**
 * Why an acting verb is refused at this control level, or null when it may go on to the Jira write switch.
 *
 * A change on a Jira site leaves the app, and what leaves the app is level 3 everywhere else in the agent's reach.
 * Level 2, the level a server starts with, is a local setting with an undo: held there, the switch a person turns on
 * to use the Jira screen themselves also let every holder of the machine token move their cards. So the door asks
 * for both, the level first. Like `levelRefusal`, the sentence names what is missing and whose it is, and not the
 * variable: a limit spelled as a recipe is one an agent with a shell walks around.
 *
 * Ceiling: at level 3 these two verbs perform, where a `/control` door of that level stages a dialog and waits for
 * a click. Staging a step is the next thing after this and is not here.
 */
export const DOOR_ACTING_LEVEL = 3;
export function actingRefusal(verb: string, level: number, readonly: boolean): string | null {
  if (level >= DOOR_ACTING_LEVEL) return null;
  const held = readonly ? "the owner has made this server read-only (opens and reads only)" : `this server allows up to level ${level}`;
  return `${verb} changes a card on a Jira site, which the agent door does only at control level ${DOOR_ACTING_LEVEL} with writing to Jira switched on, and ${held}. Both are the owner's settings, the level made when the server starts; ask the person who runs agentglass if you need it, and do not try to change them.`;
}

export interface DoorAnswer { status: number; body: Record<string, unknown> }
const refuse = (error: string, status = 400): DoorAnswer => ({ status, body: { ok: false, error } });

/**
 * Cut a string to a byte budget on a character boundary, saying so when it was cut. The answer is never
 * longer than `bytes`: a budget with no room for the three dots is the empty string, since the loop below
 * would otherwise wait for an empty string to get shorter.
 */
export function clip(s: string, bytes: number): string {
  if (Buffer.byteLength(s) <= bytes) return s;
  if (bytes < 3) return "";
  let out = s.slice(0, bytes - 3);
  while (out && Buffer.byteLength(out) > bytes - 3) out = out.slice(0, -1);
  // Half of a pair is not a character: an emoji cut in two would travel as a replacement mark.
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return `${out}...`;
}

/** The comments that fit in `left` bytes, from the newest back, in the order they were written. */
export function newestComments(all: { who: string; text: string }[], left: number): { who: string; text: string }[] {
  const kept: { who: string; text: string }[] = [];
  for (const c of [...all].reverse()) {
    const who = clip(c.who, 80);
    // What a comment costs besides its words (its author and the JSON around both) comes off first: cut to
    // all that is left, the oldest comment that fits was always one author too long and was dropped instead.
    const room = left - Buffer.byteLength(who) - 32;
    const text = clip(c.text, Math.min(room, 4096));
    if (room < 0 || (c.text && !text)) break;
    left = room - Buffer.byteLength(text);
    kept.unshift({ who, text });
  }
  return kept;
}

/** What one card is, split into what is safe to act on and what is somebody's words. */
export function cardParts(t: ProviderTask): { state: Record<string, unknown>; untrusted: Record<string, unknown> } {
  const keys = (v: string[] | undefined): string[] => (v ?? []).filter((k) => ISSUE_KEY.test(k));
  return {
    state: {
      statusKind: t.statusKind,
      ...(t.statusId ? { statusId: t.statusId } : null),
      // The stamp a step is checked against: a run is refused when the card moved since this was read.
      updated: t.updated,
      ...(t.priority ? { priority: t.priority } : null),
      ...(t.due ? { due: t.due } : null),
      ...(typeof t.points === "number" ? { points: t.points } : null),
      ...(typeof t.comments === "number" ? { comments: t.comments } : null),
      ...(typeof t.subtasks === "number" ? { subtasks: t.subtasks } : null),
      ...(keys(t.waitsOn).length ? { waitsOn: keys(t.waitsOn) } : null),
      ...(keys(t.blocks).length ? { blocks: keys(t.blocks) } : null),
    },
    untrusted: {
      title: t.title,
      status: t.status,
      ...(t.assignees?.length ? { assignees: t.assignees } : null),
      ...(t.sprint ? { sprint: t.sprint } : null),
      ...(t.tags?.length ? { tags: t.tags } : null),
      ...(t.parent ? { parent: t.parent.title } : null),
    },
  };
}

/** The most rows of each list a card answer carries; the count of those left out is in `state`. */
const ROWS_MAX = 40;

/** What the pane draws beside the words, as an agent reads it: ids and counts in `state`, every string a person or a team typed in `untrusted`. */
function listsOf(d: TaskDetail): { state: Record<string, unknown>; untrusted: Record<string, unknown> } {
  const row = (t: ProviderTask) => ({ key: t.customId ?? t.id, title: clip(t.title, 160), status: t.status, ...(t.issueType ? { type: t.issueType } : null) });
  const done = d.subtasks.filter((t) => t.statusKind === "done").length;
  const linked = d.linked ?? [];
  const files = d.attachments ?? [];
  const facts = d.facts ?? [];
  const left = (n: number) => (n > ROWS_MAX ? { notShown: n - ROWS_MAX } : null);
  return {
    state: {
      subtasksDone: done, subtasksTotal: d.subtasks.length,
      linkedCount: linked.length, attachmentCount: files.length,
      ...(left(d.subtasks.length) ? { subtasksNotShown: d.subtasks.length - ROWS_MAX } : null),
      ...(left(linked.length) ? { linkedNotShown: linked.length - ROWS_MAX } : null),
      ...(left(files.length) ? { attachmentsNotShown: files.length - ROWS_MAX } : null),
      ...(facts.some((f) => f.tone === "flag") ? { flagged: true } : null),
    },
    untrusted: {
      ...(d.subtasks.length ? { subtasks: d.subtasks.slice(0, ROWS_MAX).map(row) } : null),
      ...(linked.length ? { linked: linked.slice(0, ROWS_MAX).map((l) => ({ phrase: clip(l.phrase, 60), ...row(l.task) })) } : null),
      ...(files.length ? { attachments: files.slice(0, ROWS_MAX).map((a) => ({ name: clip(a.title, 160), size: a.size, ...(a.who ? { by: clip(a.who, 80) } : null) })) } : null),
      ...(facts.length ? { details: facts.map((f) => ({ label: f.label, value: clip(f.value, 200) })) } : null),
    },
  };
}

/** The whole card for a read: the task, its description and its comments, newest kept when the budget runs out. */
async function readCard(key: string): Promise<DoorAnswer> {
  const r = await detailStored(key);
  if (!r.ok || !r.data) return { status: 200, body: { ok: false, error: r.error ?? "Jira did not answer", ...(r.throttled ? { throttled: true } : null) } };
  const { detail, more } = r.data;
  const { state, untrusted } = cardParts(detail.task);
  const lists = listsOf(detail);
  // The head of the budget goes to the description, the rest to the comments from the newest back.
  const half = Math.floor(UNTRUSTED_MAX_BYTES / 2);
  const description = clip(detail.description ?? "", half);
  const comments = newestComments(detail.comments, UNTRUSTED_MAX_BYTES - Buffer.byteLength(description) - Buffer.byteLength(JSON.stringify({ ...untrusted, ...lists.untrusted })));
  return {
    status: 200,
    body: {
      ok: true, key: key.toUpperCase(),
      state: { ...state, ...lists.state, commentsShown: comments.length, ...(more ? { commentsNotShown: more } : null), writes: jiraWriteEnabled() },
      untrusted: { ...untrusted, ...lists.untrusted, description, comments },
    },
  };
}

/** Every remote link of the card, the pull requests among them: one request, as the pane's Web links section reads. */
async function readLinks(key: string): Promise<DoorAnswer> {
  const r = await remoteLinksAllStored(key);
  if (!r.ok || !r.data) return { status: 200, body: { ok: false, error: r.error ?? "Jira did not answer", ...(r.throttled ? { throttled: true } : null) } };
  const web = r.data.web;
  return {
    status: 200,
    body: {
      ok: true, key: key.toUpperCase(),
      state: { linkCount: web.length, pullRequests: web.filter((w) => w.pr).length, ...(web.length > ROWS_MAX ? { notShown: web.length - ROWS_MAX } : null) },
      untrusted: { links: web.slice(0, ROWS_MAX).map((w) => ({ title: clip(w.title, 160), url: clip(w.url, 300), ...(w.pr ? { pullRequest: true } : null) })) },
    },
  };
}

/** One page of what happened on the card: its history (default), its work log, or the comments past the card read. Nothing here is part of `card`, as it is not part of opening one. */
async function readActivity(key: string, kindRaw: unknown, startRaw: unknown): Promise<DoorAnswer> {
  const kind = typeof kindRaw === "string" && kindRaw ? kindRaw : "history";
  if (!(ACTIVITY_KINDS as readonly string[]).includes(kind)) return refuse(`kind is one of ${ACTIVITY_KINDS.join(", ")}`);
  const start = typeof startRaw === "number" && Number.isFinite(startRaw) && startRaw >= 0 ? Math.floor(startRaw) : 0;
  const r = await activityStored(kind as ActivityKind, key, start);
  if (!r.ok || !r.data) return { status: 200, body: { ok: false, error: r.error ?? "Jira did not answer", ...(r.throttled ? { throttled: true } : null) } };
  const d = r.data;
  return {
    status: 200,
    body: {
      ok: true, key: key.toUpperCase(),
      state: { kind, total: d.total, shown: (d.events ?? d.comments ?? []).length, ...(d.next !== undefined ? { next: d.next } : null) },
      untrusted: {
        ...(d.events ? { events: d.events.slice(0, ROWS_MAX * 3).map((e) => ({ at: e.at, who: clip(e.who ?? "", 80), text: clip(e.text ?? "", 300) })) } : null),
        ...(d.comments ? { comments: newestComments(d.comments, Math.floor(UNTRUSTED_MAX_BYTES / 2)) } : null),
      },
    },
  };
}

async function readMoves(key: string): Promise<DoorAnswer> {
  const r = await movesStored(key);
  if (!r.ok || !r.data) return { status: 200, body: { ok: false, error: r.error ?? "Jira did not answer", ...(r.throttled ? { throttled: true } : null) } };
  const options = r.data.options;
  return {
    status: 200,
    body: {
      ok: true, key: key.toUpperCase(),
      state: { writes: jiraWriteEnabled(), moves: options.map((m) => ({ id: m.id, ...(m.toId ? { toId: m.toId } : null), toKind: m.toKind, needsFields: (m.needs ?? []).length })) },
      untrusted: {
        moves: options.map((m) => ({ id: m.id, name: m.name, toStatus: m.toStatus, ...(m.needs?.length ? { needs: m.needs } : null) })),
        ...(r.data.cannot ? { cannot: r.data.cannot } : null),
      },
    },
  };
}

/** The three steps as the owner configured them, by whether they are on; their blocks name statuses a team chose. */
function readSteps(): DoorAnswer {
  const { steps } = jiraSteps();
  return {
    status: 200,
    body: {
      ok: true,
      state: { writes: jiraWriteEnabled(), steps: Object.fromEntries(STEP_KEYS.map((k) => [k, { enabled: steps[k].enabled }])) },
      untrusted: { steps: Object.fromEntries(STEP_KEYS.map((k) => [k, steps[k]])) },
    },
  };
}

/**
 * One verb. `b` is the caller's body, untrusted: the key is checked by the site
 * functions themselves (every one of them refuses what is not a card id, with the
 * same sentence), and nothing here builds a request out of it.
 */
export async function runDoor(verb: string, b: Record<string, unknown>): Promise<DoorAnswer> {
  const key = typeof b.key === "string" ? b.key.trim() : "";
  switch (verb) {
    case "card":
      return ISSUE_KEY.test(key) ? readCard(key) : refuse("That is not a Jira card id");
    case "moves":
      return ISSUE_KEY.test(key) ? readMoves(key) : refuse("That is not a Jira card id");
    case "links":
      return ISSUE_KEY.test(key) ? readLinks(key) : refuse("That is not a Jira card id");
    case "activity":
      return ISSUE_KEY.test(key) ? readActivity(key, b.kind, b.start) : refuse("That is not a Jira card id");
    case "steps":
      return readSteps();
    case "step": {
      const r = await runStepBody({ ...b, key });
      // The watch must not announce the move an agent made as news, the same as for the person's own.
      if (r.ok && r.was !== undefined && (r.task || r.moved)) rememberOwnMove({ ...(r.task ?? r.moved!), status: r.was }, r.task?.status ?? r.moved!.status);
      const after = r.task ?? r.moved;
      const { state, untrusted } = after ? cardParts(after) : { state: {}, untrusted: {} };
      return {
        status: r.ok ? 200 : r.conflict ? 409 : 400,
        body: {
          ok: r.ok, ...(r.error ? { error: r.error } : null), ...(r.conflict ? { conflict: true } : null), ...(r.unauthorised ? { unauthorised: true } : null),
          // A step that landed short of the whole is `ok` with a sentence saying what did not land: the screen shows it, and
          // an agent told only `ok` reports a comment that was never posted. The sentence names people and statuses of the site.
          ...(r.ok ? {
            state: { ...state, moved: r.was !== undefined, ...(r.partial ? { partial: true } : null) },
            untrusted: { ...untrusted, ...(r.was !== undefined ? { was: r.was } : null), ...(r.partial ? { partial: r.partial } : null) },
          } : null),
        },
      };
    }
    case "link": {
      const r = await linkPullRequestStored(key, typeof b.url === "string" ? b.url : "", typeof b.title === "string" ? b.title : "");
      return { status: r.ok ? 200 : 400, body: r.ok ? { ok: true, state: { linked: r.linked, url: r.url } } : { ok: false, error: r.error } };
    }
    default:
      return refuse(`That is not a card verb: ${DOOR_VERBS.join(", ")}`);
  }
}
