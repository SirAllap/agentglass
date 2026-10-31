// The whole filter as a plain sentence, in the words a person would use:
// "Show PRs with passing checks, by mara or jules. Hide any whose title
// contains BETA, and conflicted ones." One verb phrase per field, not a
// restatement of the rule table.
import { isGroup, type FilterGroup, type FilterNode, type FilterRule, type LaneFilter } from "../../../shared/prFilter.ts";
import { fieldLabel, opWord } from "./prFilterView.ts";

export type Seg = { k: "text" | "show" | "hide" | "b"; t: string };
type Lane = "show" | "hide";

const t = (s: string): Seg => ({ k: "text", t: s });
const b = (s: string): Seg => ({ k: "b", t: s });

/** a, b or c — the values of one rule, bold, joined the way the sentence reads. */
function vals(vs: string[], word = "or"): Seg[] {
  const out: Seg[] = [];
  vs.forEach((v, i) => { if (i) out.push(t(i === vs.length - 1 ? ` ${word} ` : ", ")); out.push(b(v)); });
  return out.length ? out : [b("…")];
}

const CHECKS: Record<string, string> = { green: "passing", red: "failing", pending: "running" };
const REVIEW: Record<string, string> = { approved: "approved", "changes-requested": "changes-requested", required: "awaiting review", none: "unreviewed" };

/** One rule as a phrase that follows "PRs" (show) or "any" (hide). */
export function rulePhrase(r: FilterRule, lane: Lane): Seg[] {
  const neg = r.op === "not" || r.op === "unset";
  const v = r.values;
  const f = r.field;
  if (f === "conflict") return lane === "hide" ? [t(neg ? "ones without conflicts" : "conflicted ones")] : [t(neg ? "without conflicts" : "with conflicts")];
  if (r.op === "set" || r.op === "unset") {
    const none = r.op === "unset";
    if (f === "card") return [t(none ? "with no card" : "with a card")];
    if (f === "assignee") return [t(none ? "with no assignee" : "with an assignee")];
    if (f === "label") return [t(none ? "with no label" : "with a label")];
    if (f === "milestone") return [t(none ? "with no milestone" : "on a milestone")];
    return [t(none ? `with no ${fieldLabel(f).toLowerCase()}` : `with a ${fieldLabel(f).toLowerCase()}`)];
  }
  if (f === "text") {
    if (r.op === "matches") return [t("whose title matches "), ...vals(v.map((x) => `/${x}/`))];
    return [t(r.op === "is" ? "whose title is exactly " : r.op === "not" ? "whose title is not " : "whose title contains "), ...vals(v)];
  }
  if (f === "updated") return r.op === "lt" ? [t("updated in the last "), b(v[0] ?? "…"), t(" days")] : [t("untouched for over "), b(v[0] ?? "…"), t(" days")];
  if (f === "number") return [t(neg ? "other than " : "numbered "), ...vals(v.map((x) => `#${x}`))];
  if (f === "card") return [t(neg ? "not linked to card " : "linked to card "), ...vals(v)];
  if (f === "author") return [t(neg ? "not by " : "by "), ...vals(v)];
  if (f === "assignee") return [t(neg ? "not assigned to " : "assigned to "), ...vals(v)];
  if (f === "label") return [t(neg ? "not labelled " : "labelled "), ...vals(v)];
  if (f === "base") return [t(neg ? "that do not target " : "that target "), ...vals(v)];
  if (f === "milestone") return [t(neg ? "not in milestone " : "in milestone "), ...vals(v)];
  if (f === "cardstatus") return [t(neg ? "whose card is not in " : "whose card is in "), ...vals(v)];
  if (f === "cardassignee") return [t(neg ? "whose card is not on " : "whose card is on "), ...vals(v)];
  if (f === "checks") return neg
    ? [t("with checks that are not "), ...vals(v.map((x) => CHECKS[x] ?? x))]
    : [t("with "), ...vals(v.map((x) => CHECKS[x] ?? x)), t(" checks")];
  if (f === "review") return [t(neg ? "whose review is not " : "whose review is "), ...vals(v.map((x) => REVIEW[x] ?? x))];
  if (f === "is") return [t(neg ? "that are not " : "that are "), ...vals(v)];
  return [t(`whose ${fieldLabel(f).toLowerCase()} ${opWord(r.op, f)} `), ...vals(v)];
}

/** Next to each other and alike (same field, plain `is`/`not`) rules say their values once: "by mara or jules". */
function merged(children: FilterNode[], join: "and" | "or"): FilterNode[] {
  if (join !== "or") return children;
  const out: FilterNode[] = [];
  for (const c of children) {
    const prev = out[out.length - 1];
    if (prev && !isGroup(prev) && !isGroup(c) && prev.field === c.field && prev.op === c.op && (c.op === "is" || c.op === "not")) {
      out[out.length - 1] = { ...prev, values: [...prev.values, ...c.values] };
    } else out.push(c);
  }
  return out;
}

function nodeSegs(n: FilterNode, lane: Lane, bare: boolean): Seg[] {
  if (!isGroup(n)) return rulePhrase(n, lane);
  const kids = merged(n.children, n.join);
  const sep = n.join === "or" ? " or " : ", ";
  const out: Seg[] = [];
  kids.forEach((c, i) => { if (i) out.push(t(sep)); out.push(...nodeSegs(c, lane, false)); });
  return kids.length > 1 && !bare ? [t("("), ...out, t(")")] : out;
}

function laneSegs(g: FilterGroup, lane: Lane): Seg[] {
  const kids = merged(g.children, g.join);
  if (!kids.length) return [];
  const out: Seg[] = lane === "show" ? [{ k: "show", t: "Show" }, t(" PRs ")] : [{ k: "hide", t: "Hide" }, t(" any ")];
  kids.forEach((c, i) => {
    if (i) {
      const last = i === kids.length - 1;
      out.push(t(lane === "show" ? (g.join === "or" ? " or " : ", ") : g.join === "and" ? " and " : last ? ", and " : ", "));
    }
    /* A closing "or" group of an all-of list reads as part of the sentence: "…, by mara or jules". */
    const bare = i === kids.length - 1 && g.join === "and" && isGroup(c) && c.join === "or";
    out.push(...nodeSegs(c, lane, bare));
  });
  out.push(t("."));
  return out;
}

export function sentence(f: LaneFilter): Seg[] {
  const show = laneSegs(f.show, "show");
  const hide = laneSegs(f.hide, "hide");
  return show.length && hide.length ? [...show, t(" "), ...hide] : [...show, ...hide];
}
