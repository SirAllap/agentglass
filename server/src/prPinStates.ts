// The state of the pull requests in the pinned-PR menu, in ONE GitHub request.
//
// Pins are `owner/name#number` and most belong to repositories with no
// checkout, so the answer cannot come from a local read. The menu asks when it
// opens, never on a timer: one request covers every listed pin (a GraphQL alias
// per repository, a nested alias per number), and the answer is kept for a
// minute per set of pins.
//
// The ceiling: 50 pins per ask, and a pin merged inside the minute shows its
// previous state until the next ask after it.
import { ghGraphql } from "./prs.ts";
import { ttlRead } from "./ttlread.ts";

export type PinState = "open" | "draft" | "merged" | "closed";
export const PIN_STATES_MAX = 50;
const TTL_MS = 60_000;
const PIN = /^([\w.-]+)\/([\w.-]+)#(\d{1,9})$/;

type Graphql = (query: string) => Promise<{ data?: Record<string, Record<string, any> | null> } | null>;
const live: Graphql = (query) => ghGraphql(query, {});

/** Validated pins grouped by repository; whatever is not `owner/name#n` is dropped. */
export function groupPins(pinsIn: unknown): Map<string, number[]> {
  const raw = Array.isArray(pinsIn) ? pinsIn : String(pinsIn ?? "").split(",");
  const by = new Map<string, number[]>();
  for (const p of [...new Set(raw.map(String))].slice(0, PIN_STATES_MAX)) {
    const m = PIN.exec(p);
    if (!m) continue;
    const list = by.get(`${m[1]}/${m[2]}`) ?? [];
    list.push(Number(m[3]));
    by.set(`${m[1]}/${m[2]}`, list);
  }
  return by;
}

export function pinStateOf(node: any): PinState | null {
  if (node?.state === "MERGED") return "merged";
  if (node?.state === "CLOSED") return "closed";
  if (node?.state === "OPEN") return node.isDraft === true ? "draft" : "open";
  return null;
}

export async function prPinStates(pinsIn: unknown, io: Graphql = live): Promise<{ ok: boolean; states: Record<string, PinState> }> {
  const by = groupPins(pinsIn);
  if (!by.size) return { ok: true, states: {} };
  const repos = [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const key = `pin-states:${repos.map(([r, ns]) => `${r}#${[...ns].sort((a, b) => a - b).join(".")}`).join(",")}`;
  return ttlRead(key, TTL_MS, async () => {
    // Owner, name and numbers are matched by PIN above: no quote can reach the query.
    const body = repos.map(([r, ns], i) => {
      const [owner, name] = r.split("/");
      return `r${i}: repository(owner: "${owner}", name: "${name}") { ${ns.map((n) => `p${n}: pullRequest(number: ${n}) { state isDraft }`).join(" ")} }`;
    }).join("\n");
    const res = await io(`query { ${body} }`);
    if (!res?.data) return { ok: false, states: {} };
    const states: Record<string, PinState> = {};
    repos.forEach(([r, ns], i) => {
      for (const n of ns) {
        const s = pinStateOf(res.data?.[`r${i}`]?.[`p${n}`]);
        if (s) states[`${r}#${n}`] = s;
      }
    });
    return { ok: true, states };
  }, { keep: (v) => v.ok });
}
