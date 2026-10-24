/*
 * Steps for Jira: what a person set up to happen when they press a button on a
 * pull request, kept in `jira-settings.json` and run by the server.
 *
 * Steps are global to the site and resolve by status NAME, as ClickUp's do: a
 * move block holds an ordered list of names, and at run time the first name
 * that a transition from the card's current status leads to wins. Two statuses
 * with one name in one workflow cannot be told apart (Jira's own screens have
 * the same limit).
 *
 * A step is run here and not composed by the client, which ClickUp's is: Jira
 * needs several writes whose order matters and whose `updated` stamp changes
 * between them, and the hand-off already solved that on the server. The stamp
 * is checked once, before anything is written; every later write has its own
 * precondition.
 *
 *   1. read `updated`, status, assignee: a stamp that moved is a conflict, no write
 *   2. resolve the move from the card's own transitions: none reachable, or one
 *      whose screen asks for a field, is refused before any write
 *   3. the move; the assignee change goes INSIDE it when its screen has the
 *      assignee on it (one atomic POST), else after it, and only if the
 *      assignee is still who step 1 saw
 *   4. the comment, then the link
 *
 * What lands short of the whole is `ok` with `partial`, one sentence naming what
 * did not land. Nothing after the move retries the move, and the comment is
 * never sent twice: a second POST is a second comment.
 *
 * Ceiling: one block of each kind per step, and a person is named by the key a
 * write takes (Cloud's account id, Data Center's login).
 */
import { NO_ASSIGN, fillTemplate, planOf, type StepTrigger } from "../../shared/stepBlocks.ts";
import type { HandoffUnassign, JiraBlockOutcome, JiraHandoffRule, JiraStep, JiraSteps, StepBlock } from "../../shared/providers.ts";
import { prAddress } from "../../shared/taskref.ts";
import {
  ISSUE_KEY, NOT_ACCEPTED, NOT_CONNECTED, WRITE_OFF, apiOf, assigneeBody, assignRefusal, badPerson, epoch, handoffMoves, handoffRules, isObj, jiraCall,
  jiraWriteEnabled, linkPullRequest, movesPath, personId, personName, projectKey, readBefore, readIssue, readSettingsFile, stale, unreadable, storedCreds, str, writeRefusal, writeSettingsKey,
  type HandoffMove, type HandoffOutcome, type JiraCreds, type JiraResult, type JiraWriteKind,
} from "./jira.ts";
import { commentOn } from "./jiraComments.ts";
import { bad, isObj as isObject, settle, type Res, type StepGroup } from "./stepSettings.ts";

/** Where a step shows, by the key it has in the settings file. */
export const STEP_KEYS = ["handoff", "review", "merge"] as const;
export type StepKey = (typeof STEP_KEYS)[number];
const TRIGGER: Record<StepKey, StepTrigger> = { handoff: "move", review: "menu", merge: "merge" };

const off = (): JiraStep => ({ enabled: false, blocks: [] });
export const defaultSteps = (): JiraSteps => ({ handoff: off(), review: off(), merge: off() });

// --- the settings -----------------------------------------------------------

/**
 * Apply a partial update over `base`. A key that is not a setting is refused
 * rather than dropped (a typo that is silently ignored looks exactly like a
 * setting that was saved), and nothing is returned half-applied.
 */
export function applySteps(base: JiraSteps, input: unknown): Res<JiraSteps> {
  if (!isObject(input)) return bad("steps must be an object");
  const out = structuredClone(base);
  for (const k of Object.keys(input)) if (!(STEP_KEYS as readonly string[]).includes(k)) return bad(`steps.${k} is not a setting`);
  for (const key of STEP_KEYS) {
    if (!(key in input)) continue;
    const g = input[key];
    if (!isObject(g)) return bad(`steps.${key} must be an object`);
    for (const k of Object.keys(g)) if (k !== "enabled" && k !== "blocks") return bad(`steps.${key}.${k} is not a setting`);
    if ("enabled" in g) {
      if (typeof g.enabled !== "boolean") return bad(`steps.${key}.enabled must be true or false`);
      out[key].enabled = g.enabled;
    }
    const shim: StepGroup = { enabled: out[key].enabled, statusNames: [], assign: NO_ASSIGN, blocks: out[key].blocks };
    const s = settle(`steps.${key}`, TRIGGER[key], g, shim, { ...shim, blocks: base[key].blocks }, "jira");
    if (!s.ok) return s;
    out[key].blocks = shim.blocks ?? [];
  }
  return { ok: true, value: out };
}

/**
 * The hand-off step an older file means: every project's rule read into one
 * step. The destination names go in order, `clear` becomes "take the assignee
 * off", `askTo` and `askClear` become "ask when it runs". A project whose rule
 * would resolve differently under the merged step (another destination first, or
 * another flag) is an override: its own rule keeps winning until the person
 * saves the step.
 */
export function stepFromRules(rules: Record<string, JiraHandoffRule>): { step: JiraStep; overrides: string[] } {
  const keys = Object.keys(rules).sort();
  if (!keys.length) return { step: off(), overrides: [] };
  const all = keys.map((k) => rules[k]!);
  const names: string[] = [];
  for (const r of all) if (r.to && !names.includes(r.to.name)) names.push(r.to.name);
  const askMove = all.some((r) => r.askTo);
  const clear = all.some((r) => r.clear);
  const askClear = all.some((r) => r.askClear);
  const blocks: StepBlock[] = [];
  if (names.length || askMove) blocks.push({ type: "move", statusNames: names, ...(askMove ? { ask: true as const } : null) });
  if (clear || askClear) blocks.push({ type: "unassign", who: clear ? "all" : "none", ...(askClear ? { ask: true as const } : null) });
  const overrides = keys.filter((k) => {
    const r = rules[k]!;
    return (r.to?.name ?? null) !== (names[0] ?? null) || r.askTo !== askMove || r.clear !== clear || r.askClear !== askClear;
  });
  return { step: { enabled: true, blocks }, overrides };
}

/** The steps as they are in effect: the file's own, and for the hand-off, the older per-project rules while the file has none. */
export function jiraSteps(): { steps: JiraSteps; overrides: string[] } {
  const raw = readSettingsFile().steps;
  let steps = defaultSteps();
  if (isObject(raw)) {
    // A key that no longer validates (a hand edit) keeps its default; the rest still apply.
    for (const k of STEP_KEYS) {
      if (!(k in raw)) continue;
      const r = applySteps(steps, { [k]: raw[k] });
      if (r.ok) steps = r.value;
    }
  }
  if (isObject(raw) && "handoff" in raw) return { steps, overrides: [] };
  const old = stepFromRules(handoffRules());
  steps.handoff = old.step;
  return { steps, overrides: old.overrides };
}

/** Validate, merge and write. Nothing is written when anything is refused. */
export function setJiraSteps(input: unknown): { ok: true; steps: JiraSteps; overrides: string[] } | { ok: false; error: string } {
  const now = jiraSteps();
  const r = applySteps(now.steps, input);
  if (!r.ok) return r;
  // Only the steps in the input are the person's edit. The hand-off that was merely read from the older rules stays out of the
  // file unless it was saved itself, or the older per-project rules would stop winning on the first unrelated save.
  const file = readSettingsFile().steps;
  const next: Record<string, unknown> = isObject(file) ? { ...file } : {};
  for (const k of Object.keys(input as object)) next[k] = r.value[k as StepKey];
  const written = applySteps(defaultSteps(), next);
  if (!written.ok) return written;
  try { writeSettingsKey("steps", next); } catch (e) { return { ok: false, error: `could not save the settings: ${(e as Error).message}` }; }
  const effective = jiraSteps();
  return { ok: true, steps: effective.steps, overrides: effective.overrides };
}

// --- the run ----------------------------------------------------------------

/** What a person chose when the step asked: all optional, a block that asks falls back to where its question starts. */
export interface StepChoice {
  /** The status to move to, by name. */
  to?: string;
  /** Take the assignee off. */
  clear?: boolean;
  /** Who ends up on the card, by the key a write takes; `null` is nobody. */
  assign?: string | null;
  /** The comment, as edited. */
  comment?: string;
  /** Leave the card in its status: the step's move is skipped, and what else it does (comment, link, people) still runs. */
  stay?: boolean;
}
export interface StepPr { url: string; title?: string; number?: number; author?: string }

const NAME_MAX = 120;
const COMMENT_MAX = 2000;
const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

interface Myself { id: string; key: string; name: string }
async function myself(creds: JiraCreds): Promise<JiraResult<Myself>> {
  const r = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/myself`, { fresh: true });
  if (!r.ok) return { ...r, data: undefined };
  const id = personId(r.data);
  const key = apiOf(creds) === 3 ? str(isObj(r.data) ? r.data.accountId : "") : str(isObj(r.data) ? r.data.name : "");
  if (!id || !key) return { ok: false, error: "Jira answered without an account" };
  return { ok: true, data: { id, key, name: personName(r.data) } };
}

/** Whether the card's assignee is the person a write put there: Data Center's card people carry another key than a write takes. */
async function isWanted(creds: JiraCreds, key: string, want: string): Promise<boolean> {
  if (apiOf(creds) === 3) return false;
  const r = await jiraCall<unknown>(creds, `/rest/api/2/issue/${encodeURIComponent(key)}?fields=assignee`, { fresh: true });
  const a = r.ok && isObj(r.data) && isObj(r.data.fields) ? r.data.fields.assignee : null;
  return isObj(a) && str(a.name) === want;
}

/** The transition to take: the first of `names` (in order) that a free move reaches, or why none does. */
function pickMove(moves: HandoffMove[], names: string[], toId: string | null, statusName: string): { move: HandoffMove } | { here: true } | { error: string } {
  // A card already in one of the names is where the step wants it: the list is synonyms across projects, not a ladder to climb.
  if (names.some((n) => sameName(n, statusName))) return { here: true };
  let blocked: HandoffMove | undefined;
  for (const name of names) {
    const into = moves.filter((m) => (toId ? m.toId === toId : sameName(m.toName, name)));
    const free = into.filter((m) => !m.needs.length);
    if (free.length) return { move: free[0]! };
    blocked ??= into[0];
    if (toId) break;
  }
  if (blocked) return { error: `That move needs ${blocked.needs.join(", ")}, which cannot be filled in here yet` };
  return { error: `That card cannot go to ${names.join(" or ")} from ${statusName || "where it is"}` };
}

/**
 * Run one step on one card, as ONE request from the client.
 *
 * The step's blocks come from the settings; `choice` answers the blocks that
 * ask when they run; `pr` fills the comment and is what the link block links.
 * Refused before any write: writes off, a bad input, a stamp that is not the one
 * the person saw, a move nobody can make from here, a move whose screen asks for
 * a field, a comment naming something this place cannot fill, a link with no
 * pull request.
 */
export async function runStep(creds: JiraCreds, key: string, updated: number, which: unknown, choice: StepChoice = {}, pr?: StepPr): Promise<HandoffOutcome> {
  if (!jiraWriteEnabled() || !ISSUE_KEY.test(key)) return runStepOnce(creds, key, updated, which, choice, pr);
  // The stamp is read, not written conditionally, so two runs begun before either writes would both pass it and post the
  // comment twice. One run per card at a time, held here on the server; the second is refused before it reads anything.
  const lock = `${apiOf(creds)}:${key.toUpperCase()}`;
  if (running.has(lock)) return { ok: false, error: `A step is already running on ${key.toUpperCase()}: wait for it to finish` };
  running.add(lock);
  try { return await runStepOnce(creds, key, updated, which, choice, pr); } finally { running.delete(lock); }
}
const running = new Set<string>();

async function runStepOnce(creds: JiraCreds, key: string, updated: number, which: unknown, choice: StepChoice, pr?: StepPr): Promise<HandoffOutcome> {
  if (!jiraWriteEnabled()) return { ok: false, error: WRITE_OFF };
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  if (!Number.isFinite(updated) || updated <= 0) return { ok: false, error: "Nothing was changed: reload the card and try again" };
  if (typeof which !== "string" || !(STEP_KEYS as readonly string[]).includes(which)) return { ok: false, error: "That is not one of the steps" };
  const stepKey = which as StepKey;
  if (choice.to !== undefined && (typeof choice.to !== "string" || !choice.to.trim() || choice.to.length > NAME_MAX)) return { ok: false, error: "That is not one of the project's statuses" };
  if (choice.assign !== undefined) { const why = badPerson(choice.assign); if (why) return { ok: false, error: why }; }
  if (choice.comment !== undefined && (typeof choice.comment !== "string" || choice.comment.length > COMMENT_MAX)) return { ok: false, error: "That comment is too long for a step" };
  const K = key.toUpperCase();
  const v = apiOf(creds);

  const { steps, overrides } = jiraSteps();
  const step = steps[stepKey];
  if (!step.enabled) return { ok: false, error: "That step is switched off: turn it on in Settings" };
  const plan = planOf<string | number>(TRIGGER[stepKey], { enabled: true, statusNames: [], assign: NO_ASSIGN, blocks: step.blocks });
  // A step is refused whole when a kind it uses is switched off: half a hand-off (moved, then not commented) is the thing to avoid.
  const KIND_OF: Record<string, JiraWriteKind | undefined> = { move: "move", assign: "assign", unassign: "assign", comment: "comment", link: "link" };
  for (const t of new Set(step.blocks.map((b) => KIND_OF[b.type]))) {
    const off = t ? writeRefusal(t) : null;
    if (off) return { ok: false, error: `${off}, and this step uses it` };
  }
  const wantsLink = step.blocks.some((b) => b.type === "link");
  if (wantsLink && !pr?.url) return { ok: false, error: "This step links a pull request, and none was given" };
  // A step's comment quotes the address (`{pr_url}`) and only the link block parsed it, so a step with a comment and
  // no link block posted whatever address came in. Parsed here, once, for every caller and before anything is asked
  // of the site; the number is the one in the address, so a comment cannot name one pull request and point at another.
  if (pr) {
    const at = prAddress(pr.url);
    if (!at) return { ok: false, error: "That is not a pull request address" };
    pr = { ...pr, url: at.url, number: at.number };
  }

  // 1. Nothing is written until the stamp is the one the person saw.
  const before = await readBefore(creds, key, "updated,status,assignee,project");
  if ("stop" in before) return before.stop;
  const f = before.f;
  const now = epoch(f.updated);
  if (!now) return unreadable();
  if (now !== updated) return stale();
  const status = isObj(f.status) ? f.status : {};
  const statusName = str(status.name);
  const project = isObj(f.project) ? str(f.project.key) : K.slice(0, K.lastIndexOf("-"));
  const was = personId(f.assignee);
  // `was` is the id a card's people carry; a write takes another key on Data Center (the login), and a stored person is that one.
  const wasKey = str(isObj(f.assignee) ? (v === 3 ? f.assignee.accountId : f.assignee.name) : "");
  const wasName = personName(f.assignee);

  // The hand-off an older file defined per project keeps its own rule for a project that resolves differently.
  const rule = stepKey === "handoff" && overrides.includes(project) && projectKey(project) ? handoffRules()[project] : undefined;
  const move = choice.stay ? null : rule
    ? (rule.to || rule.askTo ? { names: rule.to ? [rule.to.name] : [], ask: rule.askTo } : null)
    : plan.move ? { names: plan.move.names, ask: plan.move.ask } : null;
  const ruleToId = rule?.to && !choice.to ? rule.to.id : null;
  const askClear = rule ? rule.askClear : plan.askUnassign !== null;
  const fixedUnassign: HandoffUnassign = rule ? (rule.clear ? "all" : "none") : plan.unassign;

  // 2. The move, resolved from the card's own transitions.
  let chosen: HandoffMove | null = null;
  let destName = "";
  if (move) {
    const names = choice.to && move.ask ? [choice.to] : move.names;
    if (!names.length) return { ok: false, error: "No status is set for this step: choose where it goes in Settings" };
    const listed = await jiraCall<unknown>(creds, movesPath(creds, key), { fresh: true });
    if (!listed.ok) return { ok: false, unauthorised: listed.unauthorised, error: `Nothing was changed: could not read the card's moves. ${listed.error ?? "Jira did not answer"}` };
    const picked = pickMove(handoffMoves(listed.data), names, ruleToId, statusName);
    if ("error" in picked) return { ok: false, error: picked.error.replace("That card", K) };
    if ("move" in picked) { chosen = picked.move; destName = picked.move.toName || names[0]!; }
    else destName = statusName;
  }
  // What each block did, in the order it ran. The sentences are ours: nothing the site said goes into one.
  const blocks: JiraBlockOutcome[] = [];
  if (move && !chosen) blocks.push({ block: "move", state: "skipped", why: `already in ${destName}` });

  // Who ends up on the card: `want` is undefined to leave it, null to take the assignee off.
  const give = rule ? null : plan.askAssign ?? (plan.assign.who !== "none" ? plan.assign : null);
  const takeOff = rule ? null : plan.askUnassign ?? (plan.takeOff.length ? { who: "people" as const, people: plan.takeOff } : null);
  let me: Myself | null = null;
  if (give?.who === "me" || fixedUnassign === "me" || takeOff?.who === "me" || (plan.comment?.text ?? "").includes("{me}")) {
    const m = await myself(creds);
    if (!m.ok || !m.data) return { ok: false, unauthorised: m.unauthorised, error: `Nothing was changed: could not tell who you are. ${m.error ?? "Jira did not answer"}` };
    me = m.data;
  }
  const takes = (who: HandoffUnassign | "people", people: { id: string | number }[] = []): boolean =>
    who === "all" || (who === "me" && !!me && was === me.id) || (who === "people" && people.some((p) => String(p.id) === wasKey));
  let want: string | null | undefined;
  if (plan.askAssign && choice.assign !== undefined) want = choice.assign;
  else if (give?.who === "me") want = me!.key;
  else if (give?.who === "person" && give.person) want = String(give.person.id);
  const takenOff = takes(takeOff?.who ?? fixedUnassign, takeOff && "people" in takeOff ? takeOff.people : []);
  const clear = askClear ? choice.clear ?? takenOff : takenOff;
  if (want === undefined && clear && was) want = null;
  // Already the person asked for, or already nobody: nothing to write.
  if (want === null ? !was : want !== undefined && (want === wasKey || (!!me && want === me.key && was === me.id))) want = undefined;

  // The comment's words, before anything is written: a template this place cannot fill is refused, not posted with a hole in it.
  let comment: string | null = null;
  if (plan.comment) {
    const ctx = { ...(pr ? { pr: `${pr.number ? `#${pr.number} ` : ""}${pr.title ?? ""}`.trim(), pr_url: pr.url } : null), ...(pr?.author ? { author: pr.author } : null), ...(destName ? { status: destName } : statusName ? { status: statusName } : null), ...(me ? { me: me.name } : null) };
    const filled = fillTemplate(plan.comment.text, ctx);
    if (choice.comment !== undefined && plan.comment.ask) comment = choice.comment;
    else if (filled.missing.length) return { ok: false, error: `The comment names ${filled.missing.map((m) => `{${m}}`).join(", ")}, which this place cannot fill in` };
    else comment = filled.text;
  }

  const transitionsAt = `/rest/api/${v}/issue/${encodeURIComponent(key)}/transitions`;
  const failed = (r: JiraResult<unknown>): HandoffOutcome =>
    r.status === 409 ? { ok: false, conflict: true, error: "Somebody changed this card while you were moving it, reloaded" }
      : r.status === 400 ? { ok: false, error: NOT_ACCEPTED }
        : { ok: false, unauthorised: r.unauthorised, error: r.error };
  const partials: string[] = [];
  let wrote = false;
  let moved = false;
  let assigneeDone = want === undefined;

  // 3. The move, with the assignee inside it when its screen has the field.
  if (chosen) {
    const inside = want !== undefined && chosen.takesAssignee;
    const post = await jiraCall<unknown>(creds, transitionsAt, {
      method: "POST",
      body: { transition: { id: chosen.id }, ...(inside ? { fields: { assignee: want ? assigneeBody(creds, want) : null } } : null) },
    });
    if (!post.ok) return failed(post);
    wrote = true; moved = true;
    blocks.push({ block: "move", state: "done" });
    if (inside) assigneeDone = true;
  }
  // Does the step have a say in who is on the card at all? Then it reports a row for it, done or not needed.
  const touchesAssignee = rule ? (rule.clear || rule.askClear) : (give !== null || takeOff !== null || fixedUnassign !== "none" || askClear);
  if (touchesAssignee && want === undefined) blocks.push({ block: "assignee", state: "skipped", why: "nothing to change on who is on it" });
  else if (touchesAssignee && assigneeDone) blocks.push({ block: "assignee", state: "done" });

  // The assignee, after the move when the screen did not carry it. The stamp is not checked again: the move changed it.
  // The precondition is that the assignee is still who step 1 saw.
  if (!assigneeDone && want !== undefined) {
    const label = want === null ? `${wasName} is still assigned` : "the card was not given to the person chosen";
    const after = moved ? await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(key)}?fields=assignee,updated`, { fresh: true }) : null;
    const af = after && after.ok && isObj(after.data) && isObj(after.data.fields) ? after.data.fields : null;
    if (after && !after.ok) { partials.push(`who is on it could not be checked, so ${label}`); blocks.push({ block: "assignee", state: "failed", why: "Jira would not say who is on the card, so nobody was changed" }); }
    else if (af && personId(af.assignee) !== was) { partials.push(`${personId(af.assignee) ? `${personName(af.assignee)} was put on it meanwhile, so nobody was changed` : "the assignee changed meanwhile, so nobody was changed"}`); blocks.push({ block: "assignee", state: "skipped", why: "somebody else was put on the card meanwhile, so nobody was changed" }); }
    else {
      const put = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(key)}/assignee`, { method: "PUT", body: assigneeBody(creds, want) });
      if (!put.ok) {
        if (!moved) return assignRefusal(put);
        partials.push(`${label}: ${assignRefusal(put).error ?? "Jira refused"}`);
        blocks.push({ block: "assignee", state: "failed", why: "Jira did not accept the change of who is on the card" });
      } else { wrote = true; blocks.push({ block: "assignee", state: "done" }); }
    }
  }

  // 4. The comment, then the link. Neither is retried and neither undoes what landed before it.
  if (comment !== null) {
    const r = await commentOn(creds, key, comment, []);
    if (r.ok) { wrote = true; blocks.push({ block: "comment", state: "done" }); }
    else if (!wrote) return { ok: false, unauthorised: r.unauthorised, error: r.error };
    else { partials.push(`the comment was not posted: ${r.error ?? "Jira refused"}`); blocks.push({ block: "comment", state: "failed", why: "Jira did not accept the comment" }); }
  }
  if (wantsLink && pr) {
    const r = await linkPullRequest(creds, key, pr.url, pr.title ?? "");
    // Already linked is the answer the person wanted, so it is not "nothing to do".
    if (r.ok) { wrote = true; blocks.push(r.linked ? { block: "link", state: "done" } : { block: "link", state: "skipped", why: "already on the card" }); }
    else if (!wrote) return { ok: false, unauthorised: r.unauthorised, error: r.error };
    else { partials.push(`the pull request was not linked: ${r.error}`); blocks.push({ block: "link", state: "failed", why: "Jira did not accept the link" }); }
  }

  if (!wrote && !partials.length) {
    return { ok: false, error: chosen === null && move && destName ? `${K} is already in ${destName}` : `Nothing to do for ${K}` };
  }

  const back = await readIssue(creds, key, { fresh: true });
  const readable = back.ok && !!back.data;
  // A workflow that puts somebody on the card on the way in runs after the screen, so what was read back is what counts.
  const on = readable ? back.data!.people?.[0] : undefined;
  if (want === null && on && on.key === was) partials.unshift(`${on.name} is still assigned: Jira did not take them off`);
  else if (typeof want === "string" && on && on.key !== was && on.key !== want && !(me && on.key === me.id) && !(await isWanted(creds, key, want))) partials.unshift(`${on.name} was put on it by the workflow`);
  if (!readable) partials.push("the card could not be read back: reload it");
  const body = partials.join("; ");
  const partial = !body ? undefined : moved ? `Moved to ${destName}, but ${body}` : body.charAt(0).toUpperCase() + body.slice(1);
  if (!readable) {
    // Enough of the card for the watch to know the move was ours.
    const gone = { id: before.id || K, customId: K, title: "", status: destName } as NonNullable<HandoffOutcome["moved"]>;
    return { ok: true, ...(moved ? { was: statusName, moved: gone } : null), ...(partial ? { partial } : null), blocks };
  }
  return { ok: true, task: back.data!, ...(moved ? { was: statusName } : null), ...(partial ? { partial } : null), blocks };
}

export async function runStepStored(key: string, updated: number, which: unknown, choice: StepChoice = {}, pr?: StepPr): Promise<HandoffOutcome> {
  const c = storedCreds();
  return c ? runStep(c, key, updated, which, choice, pr) : { ok: false, error: NOT_CONNECTED };
}

/**
 * One step from the body a caller posts: the route and the agent door both parse it here, so the two
 * cannot read a choice differently. Anything that is not the shape is left out, never guessed.
 */
export function runStepBody(b: Record<string, unknown>): Promise<HandoffOutcome> {
  const asObject = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null);
  const c = asObject(b.choice) ?? {};
  const p = asObject(b.pr);
  return runStepStored(String(b.key ?? ""), typeof b.updated === "number" ? b.updated : 0, b.trigger, {
    ...(typeof c.to === "string" ? { to: c.to } : null),
    ...(typeof c.clear === "boolean" ? { clear: c.clear } : null),
    ...(typeof c.assign === "string" || c.assign === null ? { assign: c.assign } : null),
    ...(typeof c.comment === "string" ? { comment: c.comment } : null),
    ...(c.stay === true ? { stay: true } : null),
  }, p && typeof p.url === "string" ? {
    url: p.url,
    ...(typeof p.title === "string" ? { title: p.title } : null),
    ...(typeof p.number === "number" ? { number: p.number } : null),
    ...(typeof p.author === "string" ? { author: p.author } : null),
  } : undefined);
}
