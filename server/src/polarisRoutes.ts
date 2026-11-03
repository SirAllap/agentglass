/*
 * The HTTP side of Polaris. Reading is open to any caller; settings are the person's (index.ts
 * decides who is calling). An agent changes a door through the settings door, not here, but it may
 * act on a pull request: what stays inside the app it does directly, what leaves the app (a sync,
 * a send into a session) becomes a request the person answers (polaris.ts askAction).
 * Every effect beyond the settings file goes through executeAction.
 */
import { PRESETS, validateStoredPolaris, withEnabled, withPreset, type PresetId, type StoredPolaris } from "../../shared/polaris.ts";
import { readPolaris, readStoredPolaris, writePolaris } from "./config.ts";
import { askAction, executeAction, polarisItems, type ActionArgs, type PolarisIo, type PolarisWho } from "./polaris.ts";
import type { PolarisAsk } from "../../shared/polaris.ts";
export type { PolarisWho };

export interface PolarisReply { status: number; body: Record<string, unknown> }
const bad = (error: string, status = 400): PolarisReply => ({ status, body: { ok: false, error } });
const absRoot = (v: unknown): string | undefined | null =>
  v === undefined || v === null || v === "" ? undefined : typeof v !== "string" || v.includes("\0") || !v.startsWith("/") || v.length > 500 ? null : v;

const settingsView = (root?: string) => {
  const r = readPolaris(root);
  // A project's answer carries the global layer as stored: the view reads what a dropped door falls back to.
  return { ok: true, ...(root ? { root, below: readStoredPolaris() } : {}), ...r.settings, layers: r.layers, enabledLayer: r.enabledLayer, presetLayer: r.presetLayer };
};

const CLICK_TYPES = ["beacon-draft", "beacon-edit", "beacon-discard", "dock", "ignore", "propose", "sync", "beacon-send-on-click"];
const MAX_AGENT_TEXT = 2000;

/** One route, or null when the path is not Polaris's. `who` is the caller: the person, a paired phone, or an agent (by name). */
export async function polarisRoute(method: string, pathname: string, query: URLSearchParams, body: Record<string, unknown>, who: PolarisWho, io?: PolarisIo): Promise<PolarisReply | null> {
  if (!pathname.startsWith("/polaris/")) return null;
  if (pathname === "/polaris/settings" && method === "GET") {
    const root = absRoot(query.get("root"));
    return root === null ? bad("root: has to be an absolute path") : { status: 200, body: settingsView(root) };
  }
  if (pathname === "/polaris/items" && method === "GET") {
    const root = absRoot(query.get("root"));
    return root ? { status: 200, body: { ...(await polarisItems(root)) } } : bad("root: an absolute path is needed");
  }
  if (method !== "PUT" && method !== "POST") return null;
  const m = /^\/polaris\/items\/(\d+)\/(action|beacon\/(?:send|edit|discard))$/.exec(pathname);
  // An agent acts on pull requests (below) but never writes settings; a phone does neither.
  if (who.kind !== "person" && !(who.kind === "agent" && m && method === "POST")) {
    return bad("only the person changes Polaris settings here; an agent uses the settings door (agentglass-ui settings set polaris.*)", 403);
  }

  if (pathname === "/polaris/settings" && method === "PUT") {
    const root = absRoot(body.root);
    if (root === null) return bad("root: has to be an absolute path");
    const cur = readStoredPolaris(root);
    let next: StoredPolaris | null;
    if (typeof body.preset === "string") {
      if (!(body.preset in PRESETS)) return bad(`preset: one of ${Object.keys(PRESETS).join(", ")}`);
      next = withPreset(cur, body.preset as PresetId);
    } else if (typeof body.enabled === "boolean" && !("settings" in body)) {
      next = withEnabled(cur, body.enabled);
    } else if (body.settings === null && root) {
      next = null;
    } else {
      const v = validateStoredPolaris(body.settings);
      if (!v.ok) return bad(v.error);
      next = v.value;
    }
    const w = writePolaris(root, next);
    return w.ok ? { status: 200, body: settingsView(root) } : bad(w.error ?? "could not save it", 500);
  }

  if (m && method === "POST") {
    if (who.kind === "agent" && typeof body.text === "string" && body.text.length > MAX_AGENT_TEXT) return bad(`text: at most ${MAX_AGENT_TEXT} characters`);
    const root = absRoot(body.root);
    if (!root) return bad("root: an absolute path is needed");
    const args: ActionArgs = {
      root, number: Number(m[1]), ...(typeof body.reason === "string" ? { reason: body.reason } : {}), ...(typeof body.text === "string" ? { text: body.text } : {}),
      ...(typeof body.paneId === "string" ? { paneId: body.paneId } : {}),
      ...(typeof body.headSha === "string" ? { headSha: body.headSha } : {}), ...(typeof body.baseSha === "string" ? { baseSha: body.baseSha } : {}), ...(body.door === "course" || body.door === "cleanup" ? { door: body.door } : {}),
    };
    // A click names what it does; the relaunch is the sweep's, never a click here.
    const type = ({ "beacon/send": "beacon-send-on-click", "beacon/edit": "beacon-edit", "beacon/discard": "beacon-discard" } as Record<string, string>)[m[2]!] ?? String(body.type);
    if (!CLICK_TYPES.includes(type)) return bad(`type: one of ${CLICK_TYPES.join(", ")}`);
    if (who.kind === "agent") {
      if (type === "dock") return bad("dock writes the project's Polaris settings: use the settings door (agentglass-ui settings set polaris.dock)", 403);
      if (type === "sync" || type === "beacon-send-on-click") {
        const r = await askAction(type as PolarisAsk, args, who.name, io, Date.now(), who.askerName ?? who.name);
        if (r.request) return { status: 202, body: { ok: true, pending: true, request: r.request } };
        return { status: r.ok ? 200 : r.status ?? 409, body: { ok: r.ok, ...(r.outcome ? { outcome: r.outcome } : {}), ...(r.error ? { error: r.error } : {}), ...(r.note ? { note: r.note } : {}) } };
      }
    }
    const r = await executeAction(type, args, io, who.kind === "agent" ? { asker: who.name } : undefined);
    return { status: r.ok ? 200 : 409, body: { ...r } };
  }
  return null;
}
