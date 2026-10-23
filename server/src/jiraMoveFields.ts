/**
 * A move's screen, read from what Jira sends with `expand=transitions.fields`,
 * and the request body a filled-in form becomes. Both are pure: the reading
 * drops nothing silently (a field it cannot fill is kept as `unsupported`, so
 * the form can say so), and the body is built only from a check that passed.
 *
 * Shapes, from the published API and not yet seen on every site: a field has
 * `required`, `name`, `schema` (`type`, `system` or `custom`, `items`) and, for
 * a choice, `allowedValues`. A comment is not a field to set but an update to
 * add (`update.comment[0].add.body`), in ADF on Cloud's v3 and wiki markup on
 * Data Center's v2. A choice is sent by id.
 */
import { markdownToAdf, markdownToWiki } from "./jiraAdf.ts";
import { checkMoveFields, type JiraFieldChoice, type JiraFieldKind, type JiraMoveField, type MoveFieldsCheck } from "../../shared/jiraMoveFields.ts";

const KEY = /^[A-Za-z0-9_.-]{1,64}$/;
/** More than this on one screen is not a form somebody fills in; the rest are not read. */
const MAX_FIELDS = 24;
const MAX_CHOICES = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const idOf = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function choicesOf(raw: unknown): JiraFieldChoice[] {
  const out: JiraFieldChoice[] = [];
  for (const a of Array.isArray(raw) ? raw.slice(0, MAX_CHOICES) : []) {
    if (!isObj(a)) continue;
    const id = idOf(a.id);
    const name = text(a.name) || text(a.value);
    if (id && name) out.push({ id, name });
  }
  return out;
}

/** The kind of one field, from its schema. Anything not listed here is `unsupported`, with the site's word for it. */
function kindOf(key: string, f: Record<string, unknown>, choices: JiraFieldChoice[]): { kind: JiraFieldKind; type?: string } {
  const schema = isObj(f.schema) ? f.schema : {};
  const type = text(schema.type);
  const system = text(schema.system);
  const custom = text(schema.custom);
  const word = custom.split(":").pop() || system || type || key;
  if (key === "comment" || system === "comment") return { kind: "comment" };
  if (Array.isArray(f.allowedValues)) {
    // A choice with nothing to choose from, or choices with no id, cannot be sent.
    if (!choices.length) return { kind: "unsupported", type: word };
    if (type === "array") return { kind: "options" };
    if (type === "option" || type === "priority" || type === "resolution" || type === "issuetype" || type === "version" || type === "component") return { kind: "option" };
    return { kind: "unsupported", type: word };
  }
  if (type === "string") {
    if (system === "description" || system === "environment" || custom.endsWith(":textarea")) return { kind: "longtext" };
    if (!custom || custom.endsWith(":textfield") || custom.endsWith(":url")) return { kind: "text" };
  }
  if (type === "number" && (!custom || custom.endsWith(":float"))) return { kind: "number" };
  if (type === "date") return { kind: "date" };
  return { kind: "unsupported", type: word };
}

/** The screen a move asks for. Entries that are not readable as a field are skipped; none that are readable are. */
export function screenOf(raw: unknown): JiraMoveField[] {
  if (!isObj(raw)) return [];
  const out: JiraMoveField[] = [];
  for (const [key, f] of Object.entries(raw)) {
    if (out.length >= MAX_FIELDS) break;
    if (!isObj(f) || !KEY.test(key)) continue;
    const choices = choicesOf(f.allowedValues);
    const { kind, type } = kindOf(key, f, choices);
    out.push({
      key,
      name: text(f.name) || key,
      required: f.required === true,
      kind,
      ...(kind === "option" || kind === "options" ? { choices } : null),
      ...(type ? { type } : null),
    });
  }
  // The order a person reads a form in: what must be filled first.
  return out.sort((a, b) => Number(b.required) - Number(a.required));
}

export interface MoveBody { transition: { id: string }; fields?: Record<string, unknown>; update?: Record<string, unknown> }

/**
 * The POST body for a move with what was typed, or the sentence for why not.
 * `v` is the site's API version: it decides how a comment and a long text are
 * written. Nothing here sends a field the screen does not have.
 */
export function moveBody(transitionId: string, screen: readonly JiraMoveField[] | undefined, given: unknown, v: 2 | 3): { ok: true; body: MoveBody } | { ok: false; error: string } {
  // Something that is not a table of values is a mistake to name, not a form left blank.
  if (given !== undefined && given !== null && (typeof given !== "object" || Array.isArray(given))) return { ok: false, error: "fields must be an object of values by field key" };
  const checked: MoveFieldsCheck = checkMoveFields(screen ?? [], given);
  if (!checked.ok) return { ok: false, error: checked.error };
  const body: MoveBody = { transition: { id: transitionId } };
  const fields: Record<string, unknown> = {};
  const rich = (md: string): unknown => (v === 3 ? markdownToAdf(md, []) : markdownToWiki(md, []));
  for (const f of screen ?? []) {
    const val = checked.values[f.key];
    if (val === undefined) continue;
    switch (f.kind) {
      case "comment": body.update = { comment: [{ add: { body: rich(val as string) } }] }; break;
      case "option": fields[f.key] = { id: val }; break;
      case "options": fields[f.key] = (val as string[]).map((id) => ({ id })); break;
      case "text": fields[f.key] = val; break;
      case "longtext": fields[f.key] = rich(val as string); break;
      case "number": fields[f.key] = Number(val); break;
      case "date": fields[f.key] = val; break;
      case "unsupported": break;
    }
  }
  if (Object.keys(fields).length) body.fields = fields;
  return { ok: true, body };
}
