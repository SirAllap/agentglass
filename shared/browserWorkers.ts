/*
 * Who may drive the built-in browser: which engines and which worker roles.
 *
 * The floor is the credential's, not this setting's (server/src/auth.ts,
 * server/src/browserdrive.ts): a worker's credential reaches its own container
 * (`agent:<name>`) and the relay refuses the person's. This setting decides
 * only whether a worker gets that credential at all, and it is all-on until the
 * person turns something off — a local worker drives the browser as it did
 * before this row existed.
 *
 * One list per dimension and no wildcard: a new engine or role is off until it
 * is added here, and a value that names one this app does not know is refused
 * by the door rather than stored (and, if one is already in the file, dropped
 * on read rather than read as all on).
 *
 * Three more rows, added after it was measured that a card tab (a launch
 * brief, no role) and the project's own orchestrator seat were both refused a
 * credential with `engines`/`roles` fully on: neither had a row of its own, so
 * the door fell back to "the engine alone decides" for them — correct for a
 * seat sat on an engine Settings cannot name, but silently wrong once the
 * refusal the caller actually hit was never about the engine at all. `seat`,
 * `cardTabs` and `flowRoles` give each its own on/off, read by
 * `browserOffReason`'s `ctx` (seat.ts's old two-argument call keeps its old
 * answer: ctx is opt-in, never implied by an empty role alone).
 */
import { ENGINE_IDS, agentProvider } from "./agentKinds.ts";
import { WORKER_ROLES, type RoleId } from "./workerRoles.ts";

export interface BrowserWorkers {
  engines: string[];
  roles: string[];
  /** The project's own orchestrator seat. Absent (an older stored value) reads
   *  as on: a seat always had the browser before this row existed, and this
   *  setting only ever narrows what used to be unconditional. */
  seat: boolean;
  /** A tab started with no role at all — a launch brief, a restored pane, the
   *  terminal panel's own buttons. Same parity default as `seat`. */
  cardTabs: boolean;
  /** A flow role's own switch, by the project's root and then the role's id.
   *  A root or id this override does not name falls back to the built-in role
   *  its `policyRole` maps to (`builder` when it names none) in `roles`. */
  flowRoles: Record<string, Record<string, boolean>>;
}

/** A flow's own role, as this module needs it: its id and the built-in it
 *  runs as, if any (shared/flow.ts FlowRole.policyRole). */
export interface FlowRoleRow {
  id: string;
  policyRole?: RoleId;
  /** The project whose flow carries it. A flow role's row in `roles` is named by this plus its id, because "ops" in one project is not "ops" in another. */
  root?: string;
}

/** The name a flow role goes by in `browser.workers.roles`: its project and its id. The four built-in roles stay bare. */
export const flowRoleKey = (f: FlowRoleRow): string => (f.root ? `${f.root}::${f.id}` : f.id);

/** The `roles` entry that decides this role for a worker: its flow row's key, or the bare id of a built-in. */
function roleKeyOf(role: string, flowRoles: readonly FlowRoleRow[]): string {
  const f = flowRoles.find((x) => x.id === role);
  return f ? flowRoleKey(f) : role;
}

/** A flow role never inherits the door through this base: scout reports and
 *  does not interact, so a flow role that runs as one stays off until it has
 *  a row of its own, whatever scout's own row says. */
const NO_FALLBACK_BASE: RoleId = "scout";

/** The row a flow role falls back to when it has none of its own, or null
 *  when it inherits nothing (no `policyRole`, or that base is `scout`). */
function fallbackRow(flow: FlowRoleRow | undefined): string | null {
  return flow?.policyRole && flow.policyRole !== NO_FALLBACK_BASE ? flow.policyRole : null;
}

/** The engines that can run a worker turn at all: one with no headless form
 *  (`headlessRefusal` in server/src/agents/headless.ts) is not a worker CLI, and
 *  offering its toggle would be a switch that changes nothing. */
export const BROWSER_ENGINES: readonly { id: string; title: string }[] =
  ENGINE_IDS.filter((id) => !!agentProvider(id)?.headless).map((id) => ({ id, title: agentProvider(id)?.title ?? id }));

/** The roles the orchestration policy knows. */
export const BROWSER_ROLES: readonly { id: string; title: string }[] =
  WORKER_ROLES.map((r) => ({ id: r.id, title: r.title }));

const ENGINE_IDS_KNOWN = BROWSER_ENGINES.map((e) => e.id);
const ROLE_IDS_KNOWN = BROWSER_ROLES.map((r) => r.id);

/** The exact labels the two simple rows carry in Settings ▸ Browser ▸ "Who may
 *  drive the browser", so a refusal can name the control that really exists
 *  instead of a sentence nobody can find in the UI. A flow role's own rows are
 *  grouped per project instead (`groupFlowRoleRows`): the project's name goes
 *  on the heading once, never baked into the role's own label too. */
export const SEAT_ROW_LABEL = "This project's seat";
export const CARD_TABS_ROW_LABEL = "Card tabs";

/** One role on one project's flow, as the "Who may drive it" card needs it:
 *  enough to label the row, save its switch, and say whether it is on the
 *  project's current path. */
export interface FlowRoleCardRow {
  root: string;
  project: string;
  id: string;
  title: string;
  base: string;
  onPath: boolean;
}

/** The same rows under one heading per project, the roles on the project's
 *  current path first and the rest after. A row's label is its own name,
 *  nothing appended: the project is said once, on the heading. Two rows
 *  naming the same project and role id (a template's and the project's own)
 *  collapse to the first — the id this app would actually save to is a single
 *  row, never two. */
export interface FlowRoleSection {
  root: string;
  project: string;
  onPath: FlowRoleCardRow[];
  offPath: FlowRoleCardRow[];
}

export function groupFlowRoleRows(rows: readonly FlowRoleCardRow[]): FlowRoleSection[] {
  const seen = new Set<string>();
  const sections = new Map<string, FlowRoleSection>();
  const order: string[] = [];
  for (const row of rows) {
    const key = flowRoleKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    let section = sections.get(row.root);
    if (!section) {
      section = { root: row.root, project: row.project, onPath: [], offPath: [] };
      sections.set(row.root, section);
      order.push(row.root);
    }
    (row.onPath ? section.onPath : section.offPath).push(row);
  }
  return order.map((root) => sections.get(root)!);
}

/** Everything on, which is what no stored value means. */
export function defaultBrowserWorkers(): BrowserWorkers {
  return { engines: [...ENGINE_IDS_KNOWN], roles: [...ROLE_IDS_KNOWN], seat: true, cardTabs: true, flowRoles: {} };
}

const engineTitle = (id: string): string => agentProvider(id)?.title ?? id;
const roleTitle = (id: string): string => BROWSER_ROLES.find((r) => r.id === id)?.title ?? id;

function knownList(raw: unknown, known: readonly string[], what: string): { value: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: `expected a list of ${what}` };
  const picked = new Set<string>();
  for (const x of raw) {
    if (typeof x !== "string" || !known.includes(x)) {
      return { error: `unknown ${what.replace(/s$/, "")} ${JSON.stringify(x)}: one of ${known.join(", ")}` };
    }
    picked.add(x);
  }
  // Canonical order, so the same set in another order is the same value: the
  // door's diff and its "unchanged" answer read the value, not the spelling.
  return { value: known.filter((k) => picked.has(k)) };
}

function cleanBool(raw: unknown, what: string): { value: boolean } | { error: string } {
  if (raw === undefined) return { value: true };
  if (typeof raw !== "boolean") return { error: `${what}: expected true or false` };
  return { value: raw };
}

function cleanFlowRoles(raw: unknown): { value: Record<string, Record<string, boolean>> } | { error: string } {
  if (raw === undefined) return { value: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "flowRoles: expected an object of {root: {roleId: true|false}}" };
  const out: Record<string, Record<string, boolean>> = {};
  for (const [root, byRole] of Object.entries(raw as Record<string, unknown>)) {
    if (!byRole || typeof byRole !== "object" || Array.isArray(byRole)) return { error: `flowRoles[${root}]: expected an object of {roleId: true|false}` };
    const row: Record<string, boolean> = {};
    for (const [id, on] of Object.entries(byRole as Record<string, unknown>)) {
      if (typeof on !== "boolean") return { error: `flowRoles[${root}][${id}]: expected true or false` };
      row[id] = on;
    }
    out[root] = row;
  }
  return { value: out };
}

function readFlowRoles(raw: unknown): Record<string, Record<string, boolean>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, boolean>> = {};
  for (const [root, byRole] of Object.entries(raw as Record<string, unknown>)) {
    if (!byRole || typeof byRole !== "object" || Array.isArray(byRole)) continue;
    const row: Record<string, boolean> = {};
    for (const [id, on] of Object.entries(byRole as Record<string, unknown>)) {
      if (typeof on === "boolean") row[id] = on;
    }
    out[root] = row;
  }
  return out;
}

/** A stored value as the setting holds it, or why it is refused. `flowRoles`
 *  widens "roles" to the flow role ids this server currently knows, on top of
 *  the built-ins — a name neither list has is still refused. */
export function cleanBrowserWorkers(raw: unknown, flowRoles: readonly FlowRoleRow[] = []): { value: BrowserWorkers } | { error: string } {
  const obj = raw as { engines?: unknown; roles?: unknown; seat?: unknown; cardTabs?: unknown; flowRoles?: unknown } | null;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { error: 'an object of {"engines": [...], "roles": [...]}' };
  const engines = knownList(obj.engines, ENGINE_IDS_KNOWN, "engines");
  if ("error" in engines) return engines;
  const roleIdsKnown = [...ROLE_IDS_KNOWN, ...flowRoles.map(flowRoleKey)];
  const roles = knownList(obj.roles, roleIdsKnown, "roles");
  if ("error" in roles) return roles;
  const seat = cleanBool(obj.seat, "seat");
  if ("error" in seat) return seat;
  const cardTabs = cleanBool(obj.cardTabs, "cardTabs");
  if ("error" in cardTabs) return cardTabs;
  const cleanedFlowRoles = cleanFlowRoles(obj.flowRoles);
  if ("error" in cleanedFlowRoles) return cleanedFlowRoles;
  return { value: { engines: engines.value, roles: roles.value, seat: seat.value, cardTabs: cardTabs.value, flowRoles: cleanedFlowRoles.value } };
}

/** Whether this worker's engine and role are on. A flow role with no row of
 *  its own (its id is not in `set.roles`) is read from its base role's row
 *  instead (`fallbackRow`); an explicit row always wins over the fallback,
 *  for that flow role alone — no other role's row moves with it. */
export function browserWorkerAllowed(set: BrowserWorkers, engine: string, role: string, flowRoles: readonly FlowRoleRow[] = []): boolean {
  if (!set.engines.includes(engine)) return false;
  if (set.roles.includes(roleKeyOf(role, flowRoles))) return true;
  const fallback = fallbackRow(flowRoles.find((f) => f.id === role));
  return fallback !== null && set.roles.includes(fallback);
}

/**
 * A stored value as the launch path reads it: the members it names that this
 * app knows, and nothing else. An unknown name is dropped rather than read as
 * "all on", and a list with nothing known left is empty, so a typo, a newer
 * build's value or a half hand-edit can only narrow. Absent entirely is what
 * no stored value means, and that is all-on. A key present but not a list — a
 * hand-edit with only `engines` — is nothing on, not all on: removing the whole
 * value is what turns everything back on.
 *
 * `seat` and `cardTabs` read as on (`true`) unless explicitly stored `false`:
 * the same all-on-until-narrowed rule as `engines`/`roles`, just for a single
 * flag instead of a list. `flowRoles` keeps only the boolean leaves a hand-edit
 * could have broken; an id or root this app does not know about today is kept
 * as stored; `flowRoleBrowserAllowed` is what decides whether that key is ever
 * read, so an unknown one here reads as nothing and costs nothing.
 */
export function readBrowserWorkers(raw: unknown, flowRoles: readonly FlowRoleRow[] = []): BrowserWorkers {
  const obj = raw as { engines?: unknown; roles?: unknown; seat?: unknown; cardTabs?: unknown; flowRoles?: unknown } | null;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return defaultBrowserWorkers();
  const roleIdsKnown = [...ROLE_IDS_KNOWN, ...flowRoles.map(flowRoleKey)];
  return {
    engines: keptMembers(obj.engines, ENGINE_IDS_KNOWN),
    roles: keptMembers(obj.roles, roleIdsKnown),
    seat: typeof obj.seat === "boolean" ? obj.seat : true,
    cardTabs: typeof obj.cardTabs === "boolean" ? obj.cardTabs : true,
    flowRoles: readFlowRoles(obj.flowRoles),
  };
}

function keptMembers(raw: unknown, known: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const picked = new Set(raw.filter((x): x is string => typeof x === "string" && known.includes(x)));
  return known.filter((k) => picked.has(k));
}

/**
 * The new value only takes members away from both lists, and only turns the
 * three new rows off, never on: an agent's own change applies at once in that
 * direction, and widening any of the five waits for the person. A `flowRoles`
 * cell is a widen the moment it names `true` where the previous value did not
 * — never resolved against its base role's current setting here, because an
 * agent's own narrowing of `roles` in the SAME call must not retroactively
 * excuse a flow-role cell that still reads `true`.
 */
export function browserWorkersNarrow(prev: unknown, next: unknown): boolean {
  const a = prev as BrowserWorkers | null, b = next as BrowserWorkers | null;
  if (!a || !b || !Array.isArray(a.engines) || !Array.isArray(a.roles) || !Array.isArray(b.engines) || !Array.isArray(b.roles)) return false;
  if (!b.engines.every((x) => a.engines.includes(x)) || !b.roles.every((x) => a.roles.includes(x))) return false;
  if ((b.seat !== false) && (a.seat === false)) return false;
  if ((b.cardTabs !== false) && (a.cardTabs === false)) return false;
  const bFlow = b.flowRoles ?? {};
  const aFlow = a.flowRoles ?? {};
  for (const [root, byRole] of Object.entries(bFlow)) {
    for (const [id, on] of Object.entries(byRole)) {
      if (on === true && aFlow[root]?.[id] !== true) return false;
    }
  }
  // A key `prev` had explicit off and `next` drops: the fallback it reverts to
  // may be on, so a dropped off-key is itself a loosening, not a narrowing.
  for (const [root, byRole] of Object.entries(aFlow)) {
    for (const [id, on] of Object.entries(byRole)) {
      if (on === false && bFlow[root]?.[id] !== false) return false;
    }
  }
  return true;
}

/** Whether the project's own orchestrator seat is on. */
export const seatBrowserAllowed = (set: BrowserWorkers): boolean => set.seat !== false;

/** Whether a tab started with no role at all is on. */
export const cardTabBrowserAllowed = (set: BrowserWorkers): boolean => set.cardTabs !== false;

/** Whether a flow role's own row is on: its project's explicit override when
 *  there is one, else the built-in role it falls back to (`base`, its
 *  `policyRole`). A role with no base ("") is never allowed. */
export function flowRoleBrowserAllowed(set: BrowserWorkers, root: string, roleId: string, base: string): boolean {
  if (!base) return false; // no base role: no browser, whatever a stale row says
  const override = set.flowRoles?.[root]?.[roleId];
  return override !== undefined ? override : set.roles.includes(base);
}

/**
 * What kind of tab is asking, for `browserOffReason` — never guessed from an
 * empty role: `seat.ts`'s own two-argument calls (role `""`, no `ctx`) keep
 * reading as "no role to turn off, only the engine can" exactly as before this
 * existed, and every call this file's own door makes (`agentWindowEnv`) passes
 * one of these explicitly instead.
 */
export interface BrowserAskContext {
  /** The project's own orchestrator seat. */
  seat?: boolean;
  /** A tab with no role at all: a launch brief, a restored pane, a terminal
   *  panel button. */
  cardTab?: boolean;
  /** A flow role's own row. `title` is what the row and the refusal both say;
   *  `base` is the built-in role it falls back to with no override. */
  flowRole?: { root: string; id: string; title: string; base: string };
}

/**
 * Why this window has no credential, as one clause naming a control that
 * really exists in Settings ▸ Browser, or null when it has one.
 *
 * `ctx` picks which row decides, ahead of the built-in engine/role pair this
 * function always checked: a seat or a card tab is still refused when its
 * ENGINE is off (that row still means what it always did), but is no longer
 * folded into "no role, so only the engine can say no" once it has a row of
 * its own. A flow role is refused by its OWN row (explicit, or its base
 * role's), never by the "step Settings cannot turn on" sentence that fit it
 * only because it had no row at all.
 *
 * With no `ctx` (the default), the function is exactly what it was before
 * these three rows existed: an empty role reads as "a tab with no role —
 * only the engine can turn it off", unchanged for every caller — `seat.ts`'s
 * own brief line among them — that has not been moved onto a `ctx` of its own.
 * `flowRoles` is the universe this server knows of (for the no-`ctx` fallback
 * below, unused once a caller passes its own `ctx`): a role neither a built-in
 * nor a step of a flow this server has seen is off by name, with no row a
 * person could turn on either.
 */
export function browserOffReason(set: BrowserWorkers, engine: string, role: string, ctx: BrowserAskContext = {}, flowRoles: readonly FlowRoleRow[] = []): string | null {
  if (!engine) return "Settings ▸ Browser cannot tell which engine this tab runs, so it has no credential for the built-in browser";
  const engineKnown = BROWSER_ENGINES.some((e) => e.id === engine);
  const engineOff = () =>
    `${engineTitle(engine)} workers are off in Settings ▸ Browser ▸ Who may drive the browser, so this tab has no credential for the built-in browser and cannot drive it`;
  const rowOff = (label: string) =>
    `"${label}" is off in Settings ▸ Browser ▸ Who may drive the browser, so this tab has no credential for the built-in browser and cannot drive it`;

  if (ctx.seat) {
    if (engineKnown && !set.engines.includes(engine)) return engineOff();
    if (!seatBrowserAllowed(set)) return rowOff(SEAT_ROW_LABEL);
    return null;
  }
  if (ctx.cardTab) {
    if (engineKnown && !set.engines.includes(engine)) return engineOff();
    if (!cardTabBrowserAllowed(set)) return rowOff(CARD_TABS_ROW_LABEL);
    return null;
  }
  if (ctx.flowRole) {
    if (!engineKnown) return `the ${engineTitle(engine)} engine cannot run a worker turn, so this ${ctx.flowRole.title} worker has no credential for the built-in browser and cannot drive it`;
    if (!set.engines.includes(engine)) return engineOff();
    if (!flowRoleBrowserAllowed(set, ctx.flowRole.root, ctx.flowRole.id, ctx.flowRole.base)) return rowOff(ctx.flowRole.title);
    return null;
  }

  /* An empty role is a tab with no worker role — the project's seat, a named
     agent, a pane a restore brought back — and only the engine can turn it
     off: there is no role row to be missing. Unchanged: this is the path
     every caller used before `ctx` existed, and still the one `seat.ts`'s own
     brief line takes.
   *
   * An engine Settings ▸ Browser cannot name is not turned off by it, but that
   * holds only for a tab with NO role. The list holds only the engines that can
   * run a worker turn (`BROWSER_ENGINES`), and a chair may sit on one of the
   * others; reading "no row" as "off" is what would hand that chair the marker
   * nobody turned on. A named role on such an engine is refused — it cannot run
   * a worker turn — and the role list is still what decides one that can. A
   * known engine missing from the stored list is off, which is the direction
   * this setting only ever moves.
   *
   * A role this app does not know (a step of the flow) is off by name: there is
   * no row a person could turn on either.
   */
  if (!role) {
    if (!engineKnown || set.engines.includes(engine)) return null;
    return `the ${engineTitle(engine)} engine is off in Settings ▸ Browser, so this tab has no credential for the built-in browser and cannot drive it`;
  }
  const flow = flowRoles.find((f) => f.id === role);
  if (!BROWSER_ROLES.some((r) => r.id === role) && !flow)
    return `the "${role}" step is not one of the roles Settings ▸ Browser can turn on, so this worker has no credential for the built-in browser`;
  if (!engineKnown)
    return `the ${engineTitle(engine)} engine cannot run a worker turn, so this ${roleTitle(role)} worker has no credential for the built-in browser and cannot drive it`;
  if (browserWorkerAllowed(set, engine, role, flowRoles)) return null;
  const engineOffList = !set.engines.includes(engine);
  const roleOff = !set.roles.includes(roleKeyOf(role, flowRoles)) && !(fallbackRow(flow) !== null && set.roles.includes(fallbackRow(flow)!));
  const what = engineOffList && roleOff
    ? `${engineTitle(engine)} workers in the ${roleTitle(role)} role are`
    : engineOffList
      ? `${engineTitle(engine)} workers are`
      : `the ${roleTitle(role)} role is`;
  return `${what} off in Settings ▸ Browser, so this worker has no credential for the built-in browser and cannot drive it`;
}
