/*
 * What each outside service is doing, in one answer.
 *
 * Composed rather than probed: `deps.ts` already knows whether a binary is
 * there, `prs.ts` already knows whether `gh` is logged in, and `tasks.ts`
 * already knows whether Taskwarrior is configured. Re-asking any of those here
 * would be a second implementation of a question that already has an answer,
 * and the two would drift — which is how a Settings page ends up disagreeing
 * with the panel it is meant to describe.
 *
 * The one genuinely new probe is the credential one, because until now no
 * provider had a secret we hold.
 */
import { PROVIDERS, type ProviderId, type ProviderStatus, type ProviderState, type SavedView, type ViewTasksResponse } from "../../shared/providers.ts";
import { savedViews, addView, cachedFor, putCache } from "./clickupviews.ts";
import { ghCapability } from "./prs.ts";
import { taskCapability } from "./tasks.ts";
import { hasCredential, redacted, setCredential, clearCredential } from "./credentials.ts";
import { whoAmI, workspaces, clickupTasks, __reset } from "./clickup.ts";

const found = (bin: string): boolean => !!Bun.which(bin);

/**
 * Every provider, answered.
 *
 * Never throws and never rejects: this is the page somebody opens when
 * something is already wrong, and a Settings pane that fails to load because
 * one service is unreachable is the least useful possible outcome.
 */
export async function providerStatuses(): Promise<ProviderStatus[]> {
  const out: ProviderStatus[] = [];
  for (const p of PROVIDERS) {
    try {
      out.push(await statusOf(p.id));
    } catch {
      out.push({ id: p.id, state: "error", detail: "Could not check this one" });
    }
  }
  return out;
}

async function statusOf(id: ProviderId): Promise<ProviderStatus> {
  switch (id) {
    case "github": {
      if (!found("gh")) return { id, state: "missing-tool", detail: "The `gh` CLI is not on PATH" };
      const cap = await ghCapability();
      // A CLI that is present but logged out is the interesting middle state,
      // and the one a boolean would flatten into "broken".
      return cap.authed
        ? { id, state: "connected", detail: cap.login ? `Signed in as ${cap.login}` : "Signed in" }
        : { id, state: "needs-auth", detail: cap.reason || "Run `gh auth login`" };
    }
    case "gitlab": {
      return found("glab")
        ? { id, state: "connected", detail: "`glab` is installed — reading merge requests is not built yet" }
        : { id, state: "missing-tool", detail: "The `glab` CLI is not on PATH" };
    }
    case "taskwarrior": {
      const cap = await taskCapability();
      if (!cap.available) return { id, state: "missing-tool", detail: cap.reason };
      if (!cap.configured) return { id, state: "needs-auth", detail: cap.reason };
      return { id, state: "connected", detail: cap.reason || "Reading your local store" };
    }
    case "clickup": {
      if (!hasCredential("clickup")) return { id, state: "needs-auth", detail: "No token yet" };
      const known = redacted("clickup");
      // Read from the cache the panel reads, deliberately. Asking ClickUp again
      // on every render of a Settings page is how a 100-per-minute budget gets
      // spent on nothing.
      const snap = await clickupTasks();
      if (snap.unauthorised) return { id, state: "error", detail: "ClickUp refused this token — connect again" };
      if (snap.error) {
        return {
          id, state: "error", at: snap.at,
          detail: `${snap.error}${known?.account ? ` · last known as ${known.account}` : ""}`,
        };
      }
      const who = [known?.account, known?.workspace].filter(Boolean).join(" · ");
      return {
        id, state: "connected", at: snap.at,
        detail: `${who || "Connected"} · ${snap.tasks.length} task${snap.tasks.length === 1 ? "" : "s"} assigned to you`,
      };
    }
  }
}

export interface ConnectResult {
  ok: boolean;
  error?: string;
  status?: ProviderStatus;
}

/**
 * Store a token, but only one the service has already accepted.
 *
 * The order is the whole point. A token written first and checked later gives a
 * "Connected" badge that becomes a lie on the next poll, and the person who
 * pasted it has already moved on. Here it is checked, and only then written —
 * so the badge means what it says from the first second.
 */
export async function connectProvider(id: ProviderId, token: string): Promise<ConnectResult> {
  if (id !== "clickup") return { ok: false, error: "That provider is not connected with a token" };
  const t = token.trim();
  if (!t) return { ok: false, error: "Paste a token first" };
  // Length only, never a shape. ClickUp's own tokens start `pk_`, but rejecting
  // anything else here would mean this app decides what a valid token looks
  // like — and be wrong the day that changes.
  if (t.length > 512) return { ok: false, error: "That does not look like a token" };

  const me = await whoAmI(t);
  if (!me.ok || !me.data) {
    return { ok: false, error: me.unauthorised ? "ClickUp refused that token" : (me.error ?? "Could not reach ClickUp") };
  }
  const ws = await workspaces(t);
  const first = ws.data?.[0];
  setCredential(id, {
    token: t,
    account: me.data.name,
    accountId: me.data.id,
    workspace: first?.name,
    workspaceId: first?.id,
    verifiedAt: Date.now(),
  });
  /*
   * Drop the cached list before reporting the new status.
   *
   * The tab has almost certainly been looked at already — that is where the
   * button to get here lives — so a snapshot saying "ClickUp is not connected"
   * is sitting in a sixty-second cache. Without this, connecting succeeds and
   * the card immediately reports the cached failure back: "not connected · last
   * known as David", which is both wrong and baffling, since the name could
   * only have come from the credential that was just written.
   *
   * Disconnect already did this for the mirror-image reason. Connect needs it
   * more: the failure is silent and looks like a broken token.
   */
  __reset();
  return { ok: true, status: await statusOf(id) };
}

export async function disconnectProvider(id: ProviderId): Promise<ConnectResult> {
  clearCredential(id);
  // The cached list goes too. Leaving it would show somebody else's tasks after
  // a disconnect, which is the one thing a disconnect must not do.
  if (id === "clickup") __reset();
  return { ok: true, status: await statusOf(id) };
}

/** Which workspaces this token can see, for the picker. Never includes the
 *  token in what it returns. */
export async function providerWorkspaces(id: ProviderId): Promise<{ ok: boolean; workspaces?: { id: string; name: string }[]; error?: string }> {
  if (id !== "clickup") return { ok: false, error: "That provider has no workspaces" };
  const { secretFor } = await import("./credentials.ts");
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const r = await workspaces(token);
  return r.ok ? { ok: true, workspaces: r.data } : { ok: false, error: r.error };
}

/** Point an existing credential at a different workspace. */
export async function chooseWorkspace(id: ProviderId, workspaceId: string, name: string): Promise<ConnectResult> {
  if (id !== "clickup") return { ok: false, error: "That provider has no workspaces" };
  const { annotate } = await import("./credentials.ts");
  annotate("clickup", { workspaceId, workspace: name });
  __reset();
  return { ok: true, status: await statusOf(id) };
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

/**
 * Save a board by pasting its address.
 *
 * Resolved against ClickUp before it is stored, for the same reason a token is:
 * a saved view that turns out not to exist is a row that fails every time it is
 * opened, and the moment to find that out is while the person is still looking
 * at the address they pasted.
 */
export async function addViewByUrl(url: string): Promise<{ ok: boolean; error?: string; view?: SavedView }> {
  const { parseViewUrl, viewMeta, listMeta } = await import("./clickup.ts");
  const { secretFor } = await import("./credentials.ts");
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "Connect ClickUp first" };

  const parsed = parseViewUrl(url);
  if (!parsed?.viewId && !parsed?.listId) {
    return { ok: false, error: "That does not look like a ClickUp board address" };
  }
  // A pasted LIST address has no view behind it; the list is the thing.
  if (!parsed.viewId && parsed.listId) {
    const l = await listMeta(token, parsed.listId);
    if (!l.ok || !l.data) return { ok: false, error: l.error ?? "ClickUp did not recognise that list" };
    const view: SavedView = {
      id: `list:${parsed.listId}`, name: l.data.name || "List",
      listId: parsed.listId, listName: l.data.name, url, addedAt: Date.now(),
    };
    addView(view);
    return { ok: true, view };
  }

  const meta = await viewMeta(token, parsed.viewId!);
  if (!meta.ok || !meta.data) return { ok: false, error: meta.error ?? "ClickUp did not recognise that view" };
  let listName: string | undefined;
  if (parsed.listId) {
    const l = await listMeta(token, parsed.listId);
    listName = l.data?.name;
  }
  const view: SavedView = {
    id: parsed.viewId!, name: meta.data.name,
    listId: parsed.listId, listName, url, addedAt: Date.now(),
  };
  addView(view);
  return { ok: true, view };
}

/**
 * One board's tasks, from cache first and the network second.
 *
 * `force` is what the Refresh button sends. Everything else is served from the
 * last read if it is under a minute old, and from the network otherwise — but
 * a network failure NEVER empties the board: what was last seen stays on
 * screen with the failure named above it.
 */
export async function readView(viewId: string, force = false): Promise<ViewTasksResponse> {
  const { viewTasks, listMeta } = await import("./clickup.ts");
  const { secretFor, redacted } = await import("./credentials.ts");
  const view = savedViews().find((v) => v.id === viewId);
  if (!view) return { tasks: [], statuses: [], fields: [], at: 0, error: "That board is not saved any more" };

  const held = cachedFor(viewId);
  if (!force && held && Date.now() - held.at < 60_000) {
    return { tasks: held.tasks, statuses: held.statuses, fields: held.fields, view, at: held.at };
  }
  const token = secretFor("clickup");
  if (!token) {
    return { tasks: held?.tasks ?? [], statuses: held?.statuses ?? [], fields: held?.fields ?? [], view, at: held?.at ?? 0, error: "ClickUp is not connected" };
  }
  const me = redacted("clickup")?.accountId;

  // The statuses and fields come from the LIST and change about never, so they
  // are only re-read when we have none.
  let statuses = held?.statuses ?? [];
  let fields = held?.fields ?? [];
  if (view.listId && (!statuses.length || force)) {
    const l = await listMeta(token, view.listId);
    if (l.ok && l.data) { statuses = l.data.statuses; fields = l.data.fields; }
  }

  const r = view.id.startsWith("list:")
    ? await listTasksOf(token, view.listId!, me)
    : await viewTasks(token, view.id, me);

  if (!r.ok || !r.data) {
    return {
      tasks: held?.tasks ?? [], statuses, fields, view, at: held?.at ?? 0,
      error: r.error, unauthorised: r.unauthorised,
    };
  }
  const entry = { view, tasks: r.data.tasks, statuses, fields, at: Date.now(), truncated: r.data.truncated };
  putCache(entry);
  return { tasks: entry.tasks, statuses, fields, view, at: entry.at };
}

/** A bare list, for an address that named one directly. */
async function listTasksOf(token: string, listId: string, me?: string) {
  const { rawListTasks } = await import("./clickup.ts");
  return rawListTasks(token, listId, me);
}
