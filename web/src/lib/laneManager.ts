import { useEffect } from "react";
import type { BrowserAskFrame } from "../../../shared/types.ts";
import { api } from "./api.ts";
import { clientId, setLaneAskHandler } from "./browserBus.ts";
import { loadProfiles, type BrowserProfile } from "./browserProfiles.ts";
import { CAN_MAKE_LANES, closeLaneWindow, keepLaneWindows, openLaneWindow, vaultCall } from "./desktop.ts";

/**
 * The container slug a new lane's window is given: what `&p=` in its hash
 * says, and so which cookie jar its webview attaches on.
 *
 *   private    the lane's own id, so the jar is its alone (the app wipes it on close)
 *   shared     "", the person's own container
 *   named      the id of a container `profiles` lists, found by name
 *   ephemeral  no slug at all (S6): the lane's window builds an in-memory
 *              partition of its own, outside the persisted profile family
 *              entirely — see LaneHost.tsx.
 *
 * A name nobody made is an error and is not made here: minting a container is
 * the Browser panel's, and one written from behind its back would be
 * overwritten by the panel's next save.
 */
export function laneSlug(
  id: string, container: unknown, name: unknown, profiles: ReadonlyArray<{ id: string; name: string }>,
): { slug: string; ephemeral?: boolean } | { error: string } {
  if (container === "shared") return { slug: "" };
  if (container === "ephemeral") return { slug: "", ephemeral: true };
  if (container === "named") {
    /* Folded, as `mintAgentProfile` resolves the same question: a person who
       typed `Orbit` means the stored `orbit`, not a container that is missing. */
    const wanted = typeof name === "string" ? name.trim().toLowerCase() : "";
    const hit = wanted
      ? profiles.find((p) => p.name.trim().toLowerCase() === wanted || p.id.trim().toLowerCase() === wanted)
      : undefined;
    return hit && hit.id ? { slug: hit.id } : { error: `no container called ${String(name)} — \`profiles\` lists them` };
  }
  return { slug: id };
}

/** lane id -> the container slug its window attached on, while it is open.
 *  A full container list must not drop a jar a lane is using. */
const laneSlugs = new Map<string, string>();

/** The container ids lane windows are attached on now. */
export function laneContainers(): ReadonlySet<string> {
  return new Set([...laneSlugs.values()].filter(Boolean));
}

/** This window's list entry for a container id, if it holds one. */
function listed(id: string): BrowserProfile | undefined {
  let store: Storage | null = null;
  try { store = window.localStorage; } catch { /* blocked */ }
  return id ? loadProfiles(store).find((p) => p.id === id) : undefined;
}

async function serveLaneAsk(ask: BrowserAskFrame): Promise<void> {
  let reply: { ok: boolean; error?: string; value?: unknown };
  const pull = ask.args.vaultPull as { lane?: unknown; site?: unknown; agent?: unknown; vault?: unknown; onVisit?: unknown; budgetMs?: unknown; deadlineAt?: unknown; container?: unknown; held?: unknown } | undefined;
  const wipe = ask.args.vaultWipe as { container?: unknown; cookies?: unknown; site?: unknown; agent?: unknown; why?: unknown; sweep?: unknown } | undefined;
  if (pull && typeof pull === "object" && typeof pull.container === "string") {
    /* An agent's own container: only one this window's list holds, by id. */
    const r = listed(pull.container)?.agentMade === true
      ? await vaultCall("vaultPull", {
        lane: "", container: pull.container, site: String(pull.site ?? ""), agent: String(pull.agent ?? ""),
        ...(typeof pull.vault === "string" ? { vault: pull.vault } : {}),
        onVisit: pull.onVisit === true,
        /* The server's book: is the vault's sign-in still on record for this container + site. */
        held: pull.held === true,
        ...(typeof pull.budgetMs === "number" ? { budgetMs: pull.budgetMs } : {}),
        ...(typeof pull.deadlineAt === "number" ? { deadlineAt: pull.deadlineAt } : {}),
      })
      : { ok: false, code: "refused", error: "that container is not an agent's own in this window's list" };
    reply = { ok: true, value: r };
  } else if (wipe && typeof wipe === "object" && typeof wipe.container === "string") {
    /* A dropped container is not in the list any more, and main wipes by id.
       One in the list without the flag is the person's, made after the
       agent's was removed: it lands on the same id, and is never wiped. */
    const mine = listed(wipe.container);
    const r = mine && mine.agentMade !== true
      ? { ok: false, code: "not-agent", error: "that id is a person's container now; nothing was removed" }
      : await vaultCall("vaultWipe", {
        container: wipe.container, cookies: Array.isArray(wipe.cookies) ? wipe.cookies : [],
        ...(typeof wipe.site === "string" ? { site: wipe.site } : {}),
        ...(typeof wipe.agent === "string" ? { agent: wipe.agent } : {}),
        ...(typeof wipe.why === "string" ? { why: wipe.why } : {}),
        /* Without it main removes only the listed names and a rotated or host-only login survives. */
        ...(wipe.sweep === true ? { sweep: true } : {}),
      });
    reply = { ok: true, value: r };
  } else if (pull && typeof pull === "object") {
    /* Main's answer rides in `value` whole (counts and names only), so the
       server can read its `code` (ambiguous, no-ok, refused). A sensitive
       site is OKed by main's own dialog and main's report to the server:
       nothing here can say yes. */
    const r = await vaultCall("vaultPull", {
      lane: String(pull.lane ?? ""), site: String(pull.site ?? ""), agent: String(pull.agent ?? ""),
      ...(typeof pull.vault === "string" ? { vault: pull.vault } : {}),
      /* A sign-in on a first visit: main checks its own setting and deadline. */
      ...(pull.onVisit === true ? { onVisit: true, ...(typeof pull.budgetMs === "number" ? { budgetMs: pull.budgetMs } : {}) } : {}),
    });
    reply = { ok: true, value: r };
  } else if (typeof ask.args.make === "string") {
    let store: Storage | null = null;
    try { store = window.localStorage; } catch { /* blocked */ }
    const chosen = laneSlug(ask.args.make, ask.args.container, ask.args.name, loadProfiles(store));
    reply = "error" in chosen ? { ok: false, error: chosen.error } : await openLaneWindow(ask.args.make, chosen.slug, chosen.ephemeral === true);
    if (reply.ok && !("error" in chosen)) laneSlugs.set(ask.args.make, chosen.slug);
  } else if (typeof ask.args.drop === "string") {
    reply = await closeLaneWindow(ask.args.drop);
    laneSlugs.delete(ask.args.drop);
  } else {
    reply = { ok: false, error: "a lane ask names a lane to make or to drop" };
  }
  try { await api.browserResult({ client: clientId(), id: ask.id, ...reply }); } catch { /* the ask has already timed out */ }
}

/**
 * This window offers to make lane hosts, for as long as it is up. A heartbeat
 * with a TTL on the server, like a panel's: a window that dies without saying
 * goodbye stops being asked.
 */
export function useLaneManager(): void {
  useEffect(() => {
    if (!CAN_MAKE_LANES) return;
    setLaneAskHandler((ask) => { void serveLaneAsk(ask); });
    const me = clientId();
    const beat = () => {
      void api.browserManager(me, true).then((r) => { if (Array.isArray(r.lanes)) void keepLaneWindows(r.lanes); })
        .catch(() => { /* the server is restarting */ });
    };
    beat();
    // Liveness, not UI refresh: server/src/lanes.ts drops a lane whose host stops beating
    // after HOST_GONE_MS (60 s), so this must keep running while the window is hidden.
    const timer = setInterval(beat, 30_000);
    return () => {
      clearInterval(timer);
      setLaneAskHandler(null);
      void api.browserManager(me, false).catch(() => { /* leaving anyway */ });
    };
  }, []);
}
