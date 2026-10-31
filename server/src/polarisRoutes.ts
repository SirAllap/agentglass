/*
 * The HTTP side of Polaris. Reading is open to any caller; a write is the person's
 * (index.ts decides who that is). An agent changes a door through the settings door, not here.
 * Every effect beyond the settings file goes through executeAction.
 */
import { PRESETS, validateStoredPolaris, withEnabled, withPreset, type PresetId, type StoredPolaris } from "../../shared/polaris.ts";
import { readPolaris, readStoredPolaris, writePolaris } from "./config.ts";
import { executeAction, polarisItems, type ActionArgs } from "./polaris.ts";

export interface PolarisReply { status: number; body: Record<string, unknown> }
const bad = (error: string, status = 400): PolarisReply => ({ status, body: { ok: false, error } });
const absRoot = (v: unknown): string | undefined | null =>
  v === undefined || v === null || v === "" ? undefined : typeof v !== "string" || v.includes("\0") || !v.startsWith("/") || v.length > 500 ? null : v;

const settingsView = (root?: string) => {
  const r = readPolaris(root);
  return { ok: true, ...(root ? { root } : {}), ...r.settings, layers: r.layers, enabledLayer: r.enabledLayer, presetLayer: r.presetLayer };
};

/** One route, or null when the path is not Polaris's. `person` is whether the caller may change settings. */
export async function polarisRoute(method: string, pathname: string, query: URLSearchParams, body: Record<string, unknown>, person: boolean): Promise<PolarisReply | null> {
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
  if (!person) return bad("only the person changes Polaris here; an agent uses the settings door (agentglass-ui settings set polaris.*)", 403);

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

  const m = /^\/polaris\/items\/(\d+)\/(action|beacon\/(?:send|edit|discard))$/.exec(pathname);
  if (m && method === "POST") {
    const root = absRoot(body.root);
    if (!root) return bad("root: an absolute path is needed");
    const args: ActionArgs = {
      root, number: Number(m[1]), ...(typeof body.reason === "string" ? { reason: body.reason } : {}), ...(typeof body.text === "string" ? { text: body.text } : {}),
      ...(typeof body.paneId === "string" ? { paneId: body.paneId } : {}),
      ...(typeof body.headSha === "string" ? { headSha: body.headSha } : {}), ...(typeof body.baseSha === "string" ? { baseSha: body.baseSha } : {}), ...(body.door === "course" || body.door === "cleanup" ? { door: body.door } : {}),
    };
    // A click names what it does; the relaunch is the sweep's, never a click here.
    const type = ({ "beacon/send": "beacon-send-on-click", "beacon/edit": "beacon-edit", "beacon/discard": "beacon-discard" } as Record<string, string>)[m[2]!] ?? String(body.type);
    if (!["beacon-draft", "beacon-edit", "beacon-discard", "dock", "ignore", "propose", "sync", "beacon-send-on-click"].includes(type)) return bad("type: beacon-draft, beacon-edit, beacon-discard, dock, ignore, propose or sync");
    const r = await executeAction(type, args);
    return { status: r.ok ? 200 : 409, body: { ...r } };
  }
  return null;
}
