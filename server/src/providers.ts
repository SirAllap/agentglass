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
import { PROVIDERS, ASSIGNED_VIEW_ID, type ProviderId, type ProviderStatus, type ProviderState, type SavedView, type SavedFolder, type ViewTasksResponse } from "../../shared/providers.ts";
import { savedViews, addView, removeView, cachedFor, putCache, setCurrent as setCurrentView, addFolder, savedFolders } from "./clickupviews.ts";
import { ghCapability } from "./prs.ts";
import { taskCapability } from "./tasks.ts";
import { hasCredential, redacted, setCredential, clearCredential } from "./credentials.ts";
import { whoAmI, workspaces, clickupTasks, clickupCached, __reset, applyCommentCounts as applyCounts, seedCommentCounts as seedCounts } from "./clickup.ts";
import { cardWatchTrouble } from "./clickupwatch.ts";

const found = (bin: string): boolean => !!Bun.which(bin);

/**
 * Every provider, answered.
 *
 * Never throws and never rejects: this is the page somebody opens when
 * something is already wrong, and a Settings pane that fails to load because
 * one service is unreachable is the least useful possible outcome.
 */
export async function providerStatuses(): Promise<ProviderStatus[]> {
  /*
   * All at once. These four have nothing to say to each other, and asking them
   * in a loop made the page cost the SUM of their answers — measured at 10.7s
   * on a real machine, of which 10.3 was ClickUp and 0.4 was everything else.
   * In parallel the page costs the slowest one instead of all of them.
   */
  return Promise.all(PROVIDERS.map(async (p) => {
    try {
      return await statusOf(p.id);
    } catch {
      return { id: p.id, state: "error", detail: "Could not check this one" } as ProviderStatus;
    }
  }));
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
      /*
       * The card watch, which fails on its own schedule and used to fail in
       * private.
       *
       * ClickUp is two features behind one token: the task LIST, cached below,
       * and the card BELL, polled every three minutes by clickupwatch.ts. They
       * fail independently and the list is the one with a cache in front of it,
       * so the row could — and did — read "Connected · 13 tasks assigned to
       * you" from a snapshot taken before the token was rotated, while every
       * notification since had been a silent 401. Whatever the list says, an
       * unauthorised watch is the token being refused, so it takes the verdict.
       */
      const watch = cardWatchTrouble();
      if (watch?.unauthorised) {
        return {
          id, state: "error", at: watch.at,
          detail: "ClickUp refused this token — connect again",
          notice: `Card notifications have been failing since ${clock(watch.since)}. Nothing is lost: they resume from where they stopped once the token works.`,
        };
      }
      const notice = watch
        ? `Card notifications are not getting through — ${watch.error} (since ${clock(watch.since)}). The task list below may still be fine.`
        : undefined;
      /*
       * The cache, and only ever the cache.
       *
       * This used to `await clickupTasks()`, which fetches when the cache is
       * cold — and ClickUp's floor for that query is ten seconds. So opening
       * Settings more than a minute after the last poll sat on a spinner for
       * ten seconds to answer a question the task count is not even part of:
       * does this token work. The count is a nice detail, not the point, so it
       * appears when it is already known and is skipped when it is not.
       */
      const snap = clickupCached();
      if (!snap) {
        const who = [known?.account, known?.workspace].filter(Boolean).join(" · ");
        return { id, state: "connected", pending: true, notice, detail: `${who || "Connected"} · counting your tasks…` };
      }
      if (snap.unauthorised) return { id, state: "error", notice, detail: "ClickUp refused this token — connect again" };
      if (snap.error) {
        return {
          id, state: "error", at: snap.at, notice,
          detail: `${snap.error}${known?.account ? ` · last known as ${known.account}` : ""}`,
        };
      }
      const who = [known?.account, known?.workspace].filter(Boolean).join(" · ");
      return {
        id, state: "connected", at: snap.at, notice,
        detail: `${who || "Connected"} · ${snap.tasks.length} task${snap.tasks.length === 1 ? "" : "s"} assigned to you`,
      };
    }
  }
}

/** A wall-clock time for a notice — "since 14:32" is something a person can
 *  place in their day; an epoch or a duration in minutes is not. */
const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

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
   * known as Ada", which is both wrong and baffling, since the name could
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
  /*
   * The My Work page, pasted.
   *
   * There is nothing to resolve and nothing to save — that board is already on
   * the bar — so this selects it and says so. Refusing it would be technically
   * defensible and useless: somebody who pastes the address of the tasks
   * assigned to them wants the tasks assigned to them, and telling them it "does
   * not look like a board address" answers a question they did not ask.
   */
  if (parsed?.kind === "assigned") {
    const view = savedViews().find((v) => v.id === ASSIGNED_VIEW_ID)!;
    setCurrentView(view.id);
    return { ok: true, view };
  }
  if (!parsed?.viewId && !parsed?.listId) {
    return { ok: false, error: "That does not look like a ClickUp board address" };
  }
  /* What to say when the address parses but ClickUp does not know it. "ClickUp
     answered 404" is true and useless: it names the protocol, not the mistake,
     and the mistake is nearly always a hand-assembled address rather than the
     one the board is sitting at. */
  /*
   * A board that does not exist answers 401, not 404 — the same thing findCard
   * documents about a card, verified there against a real workspace. Reported
   * as "ClickUp refused this token" it sends somebody to Settings to reconnect
   * a connection that was never broken, over a typo.
   *
   * There is no way to tell the two apart from here, so this says both, in the
   * order they are likely: an address stitched together by hand is common, a
   * revoked token is not — and the token has its own status pill elsewhere,
   * which stays honest either way.
   */
  const lost = "No board at that address — open it in ClickUp and copy the address out of your browser's bar. (If that IS the address, this token may not be allowed to see it.)";
  const notFound = (r: { error?: string; unauthorised?: boolean }): boolean =>
    !!r.unauthorised || /40[0-4]/.test(r.error ?? "");
  // A pasted LIST address has no view behind it; the list is the thing.
  if (!parsed.viewId && parsed.listId) {
    const l = await listMeta(token, parsed.listId);
    if (!l.ok || !l.data) return { ok: false, error: notFound(l) ? lost : (l.error ?? "ClickUp did not recognise that list") };
    const view: SavedView = {
      id: `list:${parsed.listId}`, name: l.data.name || "List",
      listId: parsed.listId, listName: l.data.name, url, addedAt: Date.now(),
      ...(l.data.color ? { color: l.data.color } : {}),
    };
    addView(view);
    return { ok: true, view };
  }

  const meta = await viewMeta(token, parsed.viewId!);
  if (!meta.ok || !meta.data) return { ok: false, error: notFound(meta) ? lost : (meta.error ?? "ClickUp did not recognise that view") };
  /* The list this view hangs off — from the address when it was there, and
     otherwise from the view itself. The slug form of a view id carries no list
     inside it, so without asking, a pasted view had no list at all: no
     statuses, no custom fields, no colour. */
  const listId = parsed.listId || meta.data.listId;
  let listName: string | undefined;
  let colour: string | undefined;
  if (listId) {
    const l = await listMeta(token, listId);
    listName = l.data?.name;
    colour = l.data?.color;
  }
  const view: SavedView = {
    id: parsed.viewId!, name: meta.data.name,
    listId, listName, url, addedAt: Date.now(),
    ...(colour ? { color: colour } : {}),
  };
  addView(view);
  return { ok: true, view };
}

/**
 * Point an existing board at a different address.
 *
 * Not an edit, and that is the whole reason this is a function rather than a
 * field somebody types over: a board IS its ClickUp view, so a new address is a
 * different board. Saving one over the other would have left two rows on the
 * bar — the old one still there, still stale, still clicked by accident.
 *
 * The order matters and is the same order `connectProvider` uses for a token:
 * resolve the new one first, and only remove the old one once ClickUp has
 * agreed the new one exists. A failed change leaves you exactly where you were
 * rather than with nothing.
 */
/**
 * Add a whole folder to the sidebar.
 *
 * Resolved before it is stored, like every other add here: the id has to come
 * back from ClickUp with a name and its lists, or nothing is written. What IS
 * written is the folder — the lists ride along as a cache so the sidebar has a
 * tree to draw on the next cold start, and are replaced by whatever ClickUp
 * says the next time it is read.
 */
export async function addClickupFolder(folderId: string, spaceName = ""): Promise<{ ok: boolean; error?: string; folder?: SavedFolder }> {
  const { clickupFolderLists } = await import("./clickup.ts");
  const { secretFor } = await import("./credentials.ts");
  if (!secretFor("clickup")) return { ok: false, error: "Connect ClickUp first" };
  const id = String(folderId || "").trim();
  if (!/^[0-9]+$/.test(id)) return { ok: false, error: "That is not a folder id" };

  const r = await clickupFolderLists(id);
  if (!r.ok || !r.data) return { ok: false, error: r.error || "ClickUp did not answer for that folder" };
  const me = (await import("./credentials.ts")).redacted("clickup");
  const folder: SavedFolder = {
    id,
    name: r.data.name || `Folder ${id}`,
    ...(me?.workspaceId ? { workspaceId: String(me.workspaceId) } : {}),
    // The space is what the picker knew; ClickUp's folder endpoint does not
    // repeat it, and a second call to learn a heading is not worth a request.
    spaceId: "",
    spaceName,
    addedAt: Date.now(),
    lists: r.data.lists,
    listsAt: Date.now(),
  };
  addFolder(folder);
  return { ok: true, folder };
}

/**
 * Read a saved folder's lists again.
 *
 * The point of storing a folder rather than its contents: this is what notices
 * the list somebody created this morning. Failure is not an error worth showing
 * — the sidebar keeps the tree it has, which is the last thing ClickUp agreed
 * to, and tries again next time.
 */
export async function refreshClickupFolders(): Promise<void> {
  const { clickupFolderLists } = await import("./clickup.ts");
  const { secretFor } = await import("./credentials.ts");
  if (!secretFor("clickup")) return;
  for (const f of savedFolders()) {
    const r = await clickupFolderLists(f.id);
    if (!r.ok || !r.data) continue;
    addFolder({ ...f, name: r.data.name || f.name, lists: r.data.lists, listsAt: Date.now() });
  }
}

/**
 * The fuse on that refresh, and why it is here rather than on a timer.
 *
 * Ten minutes, and only when somebody is looking: the sidebar asks for its
 * boards whenever the Tasks view is open, so this rides that. A folder costs
 * one request; three folders on a ten-minute floor is at most eighteen an hour
 * against a ten-thousand budget, and a machine with the app open on another
 * view spends nothing at all.
 */
const FOLDER_TTL_MS = 10 * 60_000;
let foldersRunning = false;
export async function refreshFoldersIfStale(): Promise<void> {
  if (foldersRunning) return;
  const stale = savedFolders().some((f) => !f.listsAt || Date.now() - f.listsAt > FOLDER_TTL_MS);
  if (!stale) return;
  foldersRunning = true;
  try { await refreshClickupFolders(); } finally { foldersRunning = false; }
}

export async function replaceViewUrl(oldId: string, url: string): Promise<{ ok: boolean; error?: string; view?: SavedView }> {
  const before = savedViews().find((v) => v.id === oldId);
  if (!before) return { ok: false, error: "That board is not saved any more" };
  if (before.builtin) return { ok: false, error: "That board has no address to change" };
  const added = await addViewByUrl(url);
  if (!added.ok || !added.view) return added;
  // Same board, re-resolved: nothing to remove, and removing would delete what
  // was just added.
  if (added.view.id !== oldId) removeView(oldId);
  return added;
}

/*
 * How long an answer stands before it is worth asking again.
 *
 * Priced by what asking COSTS, not by how fast the data could conceivably
 * change. A view answers in about a second because it is already scoped; the
 * built-in board asks an entire workspace and takes twelve. Neither turns over
 * inside its window often enough to be worth the difference.
 *
 * This is the real rate limiter, and it lives here rather than in the browser
 * on purpose: a client can ask as often as it likes — a phone, a second window,
 * a poll — and the number of requests that reach ClickUp is decided in one
 * place, by the process that holds the token.
 */
const TTL_VIEW = 60_000;
const TTL_ASSIGNED = 300_000;
const ttlFor = (v: SavedView): number => (v.builtin ? TTL_ASSIGNED : TTL_VIEW);

interface RefreshOutcome { ok: boolean; error?: string; unauthorised?: boolean }

/** One refresh per board at a time, however many callers arrive. Two windows
 *  opening the same board must not become two workspace-wide queries. */
/* The read in the air for a board, and whether a PERSON asked for it. Both,
   because "one at a time per board" and "Refresh must actually try" are
   different promises and the second one was quietly losing to the first. */
const inFlight = new Map<string, { p: Promise<RefreshOutcome>; forced: boolean }>();

/**
 * What to do after a board fails to read.
 *
 * Without this, a revoked token or a service having a bad morning turns into a
 * request every time anybody looks at the panel — which is the exact shape of
 * behaviour that gets an integration blocked, and it happens precisely when the
 * service is least able to take it. So a failure buys quiet, doubling from one
 * minute to five, and any success clears it.
 */
const cooling = new Map<string, { until: number; tries: number; error?: string; unauthorised?: boolean }>();
const COOL_MIN = 60_000;
const COOL_MAX = 300_000;

export function __resetViewCache(): void { inFlight.clear(); cooling.clear(); }

/**
 * One board's tasks: what we have now, corrected behind you.
 *
 * Stale-while-revalidate, which is the whole point. The old rule was
 * all-or-nothing — under a minute old, serve it; a second past that, block the
 * panel on a network read — so coming back to a board after a few minutes meant
 * watching a spinner for something we already had on disk. Now anything we hold
 * is shown immediately, whatever its age, and a refresh runs behind it when it
 * is past its window. `revalidating` says so, so the panel can murmur rather
 * than block.
 *
 * Two cases still wait: a board we have never read (there is nothing to show),
 * and `force`, which is a person pressing Refresh and expecting the answer.
 *
 * A failure NEVER empties a board. What was last seen stays, with the reason
 * named above it.
 */
/*
 * The views the sidebar has offered, by id.
 *
 * Filled when the panel asks a list for its views and read when one of them is
 * opened. Memory only and deliberately: it is a lookup table for this session's
 * clicks, not a thing to remember — the file holds what somebody chose to keep.
 */
const ephemeralViews = new Map<string, string>();
const ephemeralNames = new Map<string, string>();
/*
 * The address of a file this server has already handed out.
 *
 * `/clickup/file` proxies attachments so a browser will play them, and a proxy
 * that fetches whatever URL a caller sends is a hole with the app's own
 * network position behind it. So the id is looked up in the attachments we
 * cached for a card: if we never offered it, there is nothing to fetch.
 */
const filesOffered = new Map<string, string>();
export function rememberFiles(files: { id: string; url: string }[]): void {
  for (const f of files) if (f.id && f.url) filesOffered.set(f.id, f.url);
}
export const attachmentUrl = (id: string): string | undefined => filesOffered.get(id);

export function rememberListViews(listId: string, views: { id: string; name: string }[]): void {
  for (const v of views) { ephemeralViews.set(v.id, listId); ephemeralNames.set(v.id, v.name); }
}

export async function readView(viewId: string, force = false): Promise<ViewTasksResponse> {
  const { secretFor } = await import("./credentials.ts");
  /*
   * A saved board, or one of a saved list's own views.
   *
   * The second kind is not in the file and should not be: the sidebar hangs a
   * list's ClickUp views under it — `Blue Eng list view`, `Frontend` — and
   * those come and go with the list. Refusing them ("that board is not saved
   * any more") is what a row that opens nothing looks like, and saving them on
   * first click would quietly fill somebody's sidebar with every tab they ever
   * glanced at.
   *
   * So they are read as themselves: the id is enough for the API, the name
   * comes back with it, and everything downstream — the cache, the statuses,
   * the breadcrumb — works on a `SavedView` shape it never has to know is
   * borrowed.
   */
  let view = savedViews().find((v) => v.id === viewId);
  if (!view) {
    const owner = savedViews().find((v) => v.listId && ephemeralViews.get(viewId) === v.listId);
    const listId = owner?.listId ?? ephemeralViews.get(viewId);
    if (!listId) return { tasks: [], statuses: [], fields: [], at: 0, error: "That board is not saved any more" };
    view = { id: viewId, name: ephemeralNames.get(viewId) ?? "View", listId, listName: owner?.listName, url: "", addedAt: 0 };
  }

  /** Whatever we hold, dressed as an answer. */
  const shown = (extra: Partial<ViewTasksResponse> = {}): ViewTasksResponse => {
    const c = cachedFor(viewId);
    return {
      tasks: c?.tasks ?? [], statuses: c?.statuses ?? [], fields: c?.fields ?? [],
      place: c?.place, description: c?.description, view: c?.view ?? view, at: c?.at ?? 0, truncated: c?.truncated, ...extra,
    };
  };

  const token = secretFor("clickup");
  if (!token) return shown({ error: "ClickUp is not connected" });

  const held = cachedFor(viewId);
  const age = held ? Date.now() - held.at : Number.POSITIVE_INFINITY;
  /* A cache from before the blurb existed is not fresh, however young it is:
     otherwise the field only appears for whoever happens to have an empty cache
     and reads as broken for everyone else. `""` is a known answer — see
     `listMeta` — so this fires once per board and never again. */
  const missingBlurb = !!view.listId && held?.description === undefined;
  if (!force && age < ttlFor(view) && !missingBlurb) return shown();

  const rest = cooling.get(view.id);
  const resting = !force && !!rest && Date.now() < rest.until;

  /*
   * The case this rewrite exists for: we have something, so show it NOW and
   * mend it behind. No spinner, no wait, no empty list — the panel paints from
   * disk in single-digit milliseconds and swaps in the fresh rows when they
   * land.
   */
  if (held?.tasks.length && !force) {
    if (!resting) void refresh(view, token).catch(() => { /* reported through the cache */ });
    // While resting, say WHY it is not updating rather than looking merely old.
    return shown(resting ? { error: rest?.error, unauthorised: rest?.unauthorised } : { revalidating: true });
  }

  // Nothing to show, or somebody pressed Refresh. This one waits.
  const r = await refresh(view, token, force);
  return r.ok ? shown() : shown({ error: r.error, unauthorised: r.unauthorised });
}

/**
 * Put the freshly counted comments onto the rows already cached.
 *
 * The counting runs behind the request that triggered it, so by the time it
 * finishes the board has already been cached without the numbers. Rewriting the
 * cached rows in place is what makes them appear on the next READ rather than
 * the next refresh — on a five-minute timer that is the difference between
 * five minutes and ten.
 *
 * A no-op if the board has moved on: whatever replaced it was fetched later and
 * has its own counts.
 */
function recount(viewId: string): void {
  const c = cachedFor(viewId);
  if (!c) return;
  putCache({ ...c, tasks: applyCounts(c.tasks) });
}

/** The network half, deduplicated. Never throws: every failure comes back as an
 *  outcome, because the caller's job is to keep showing the old rows. */
function refresh(view: SavedView, token: string, force = false): Promise<RefreshOutcome> {
  const running = inFlight.get(view.id);
  /*
   * Join what is already running — EXCEPT a forced read joining an unforced
   * one.
   *
   * Refresh exists to get past a failure, and handing it a background read
   * that is already in the air makes it inherit that read's answer: you press
   * it, you wait the full twelve seconds, and you are told exactly what was
   * already on the screen. Reported as a board that "never updates".
   *
   * There is nearly always one in the air to inherit on the built-in board:
   * its read takes twelve seconds and the settle loop behind the panel asks
   * every one and a half, so any stale board has a revalidation running
   * essentially all the time.
   *
   * A second forced press still joins the first — that one is already the
   * fresh attempt this one wanted.
   */
  if (running && (running.forced || !force)) return running.p;
  const p = doRefresh(view, token, force)
    .then((r) => {
      if (r.ok) cooling.delete(view.id);
      else {
        const was = cooling.get(view.id)?.tries ?? 0;
        const tries = was + 1;
        cooling.set(view.id, {
          tries, until: Date.now() + Math.min(COOL_MIN * 2 ** (tries - 1), COOL_MAX),
          error: r.error, unauthorised: r.unauthorised,
        });
      }
      return r;
    })
    .catch((e): RefreshOutcome => ({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 160) }))
    /* Only if it is still OURS: a forced read can now start while an unforced
       one is finishing, and the loser must not delete the winner's entry. */
    .finally(() => { if (inFlight.get(view.id)?.p === p) inFlight.delete(view.id); });
  inFlight.set(view.id, { p, forced: force });
  return p;
}

async function doRefresh(view: SavedView, token: string, force: boolean): Promise<RefreshOutcome> {
  const { viewTasks, listMeta } = await import("./clickup.ts");
  const { redacted } = await import("./credentials.ts");
  const held = cachedFor(view.id);
  const me = redacted("clickup")?.accountId;
  // What the last run counted, taken back off the board it wrote. Without this
  // the first sweep after a restart blanks a column that was already right.
  if (held?.tasks.length) seedCounts(held.tasks);

  /*
   * The built-in board asks the workspace instead of a view, and brings its own
   * statuses back with the rows.
   *
   * It has no list behind it — the rows come from a dozen of them — so there is
   * nothing to call `listMeta` on, and the statuses it reports are the ones its
   * own rows are in. Enough to group and filter by, deliberately not enough to
   * move a card with: that picker asks the card's own list. See TaskPage.statuses.
   */
  if (view.id === ASSIGNED_VIEW_ID) {
    const { assignedTasks, identity } = await import("./clickup.ts");
    // The same resolution the poll uses, which writes what it worked out back
    // onto the credential — so a token stored before we kept the workspace on it
    // heals itself here rather than reporting a dead end.
    const { workspaceId, userId } = await identity(token);
    if (!workspaceId || !userId) {
      return { ok: false, error: "Could not work out which ClickUp workspace to read" };
    }
    const a = await assignedTasks(token, workspaceId, userId);
    if (!a.ok || !a.data) return { ok: false, error: a.error, unauthorised: a.unauthorised };
    /*
     * Where this board lives in a browser, derived rather than written down.
     *
     * The built-in board has no pasted address, and it needs one so it can be
     * opened in ClickUp like any other. The host comes from the tasks' OWN urls
     * rather than from a constant, for the reason `parseViewUrl` already gives:
     * ClickUp serves the same app from more than one hostname and has changed
     * which one it prefers, and a host baked in here would be wrong the day it
     * changes again. No tasks means no link, which is honest — with nothing
     * read, there is nothing to say about where it came from.
     */
    /*
     * The built-in board gets the comment counts too, and forgetting it is why
     * they never appeared: this branch returns before the shared one below, and
     * "Assigned to me" is the board most people are looking at. Two exits, one
     * enrichment, applied to whichever ran — the sort of thing a second
     * `putCache` in a function will do to you.
     */
    const { applyCommentCounts: applyA, refreshCommentCounts: refreshA } = await import("./clickup.ts");
    // Re-applied to the cache when the counting finishes, so the numbers show
    // on the NEXT read rather than the next refresh. Without this the first
    // sweep only seeds the map and a board on a five-minute timer takes ten
    // minutes to show a column it already knows the contents of.
    void refreshA(a.data.tasks, token)
      .then(() => recount(view.id))
      .catch(() => { /* a count is not worth a log line */ });
    const withUrl = { ...view, url: myWorkUrl(a.data.tasks, workspaceId) };
    putCache({ view: withUrl, tasks: applyA(a.data.tasks), statuses: a.data.statuses, fields: [], at: Date.now(), truncated: a.data.truncated });
    return { ok: true };
  }

  // The statuses, fields and breadcrumb all come from the LIST and change about
  // never, so they are only re-read when we have none.
  let statuses = held?.statuses ?? [];
  let fields = held?.fields ?? [];
  let place = held?.place;
  let description = held?.description;
  /* `description === undefined` is in here for a reason: it was added after
     these caches were written, so every board held one of them and the blurb
     never appeared until something else forced a re-read. A field that only
     shows up for people with an empty cache is a field that looks broken. */
  if (view.listId && (!statuses.length || !place || description === undefined || force)) {
    const l = await listMeta(token, view.listId);
    if (l.ok && l.data) {
      statuses = l.data.statuses; fields = l.data.fields; place = l.data.place;
      // Assigned rather than merged: a blurb that was deleted in ClickUp has to
      // be able to disappear here too.
      description = l.data.description ?? "";
    }
  }

  const r = view.id.startsWith("list:")
    ? await listTasksOf(token, view.listId!, me)
    : await viewTasks(token, view.id, me);

  if (!r.ok || !r.data) return { ok: false, error: r.error, unauthorised: r.unauthorised };
  /*
   * Comment counts, applied from what has already been counted and refreshed
   * behind this call rather than in front of it.
   *
   * Here rather than in either fetcher, because a board is a view OR a list and
   * the count belongs to both — the first version enriched `viewTasks` only,
   * so a board that was a list (the common one) showed an empty column and
   * looked broken.
   *
   * Never awaited: this board already reports "did not answer in time" when the
   * workspace is slow, and putting twenty calls in front of it is how a column
   * of small numbers takes the whole panel down.
   */
  const { applyCommentCounts, refreshCommentCounts } = await import("./clickup.ts");
  const tasks = applyCommentCounts(r.data.tasks);
  void refreshCommentCounts(r.data.tasks, token)
    .then(() => recount(view.id))
    .catch(() => { /* a count is not worth a log line */ });
  putCache({ view, tasks, statuses, fields, place, description, at: Date.now(), truncated: r.data.truncated });
  return { ok: true };
}

/**
 * The My Work page for this workspace, on whichever host answered.
 *
 * Taken from a task's own url — `https://<host>/t/<id>` — because that is the
 * one place the service tells us where it lives. Only the origin is reused; the
 * path is the one the browser uses for My Work.
 */
function myWorkUrl(tasks: { url?: string }[], workspaceId: string): string {
  for (const t of tasks) {
    try {
      const u = new URL(t.url ?? "");
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      return `${u.origin}/${encodeURIComponent(workspaceId)}/my-work/tasks`;
    } catch { /* a task with no url tells us nothing; try the next */ }
  }
  return "";
}

/**
 * A list, read the way ClickUp itself shows one.
 *
 * `/list/{id}/task` is the obvious endpoint and it answers a different question
 * from the one on screen. Measured on a real list of a couple of hundred cards:
 *
 *   - it returns only the tasks whose HOME list is this one. A card added to
 *     the list through "Tasks in Multiple Lists" — which is most of them there
 *     — is simply absent: its home is some other list, this one is a location
 *     it appears in, and the list endpoint has never heard of it. Neither had
 *     this app.
 *   - it ignores the view's filter and its sort. What the list opens on is a
 *     VIEW, with a filter on a custom field and `sorting: priority`.
 *
 * The view endpoint answers the question on screen: of its 105 tasks, 63 have
 * another list as their home. So: resolve the list's default view once, read
 * that, and only fall back to the raw list when the workspace will not name one
 * (a permission, an older workspace) — where the old behaviour is still better
 * than nothing.
 */
async function listTasksOf(token: string, listId: string, me?: string) {
  const { rawListTasks, defaultViewOf, viewTasks } = await import("./clickup.ts");
  const viewId = await defaultViewOf(token, listId);
  if (viewId) {
    const r = await viewTasks(token, viewId, me);
    /*
     * An EMPTY view is not the same as an empty list, and this is measured
     * rather than guessed: on one list the default view answers 105 tasks, and
     * on another — a list with a hundred cards, twelve of them on screen in the
     * browser — the same endpoint answers zero while the list's other views
     * answer thirty each. Whatever ClickUp is doing there (a filter its API
     * evaluates differently, a view the web client fills in another way), a
     * board that draws "nothing here" over a hundred cards is the worst of the
     * available answers.
     *
     * So an empty view is checked against the list before it is believed. It
     * costs one extra call in exactly two cases: a list that really is empty,
     * and this one.
     */
    /*
     * BOTH, MERGED — because each one is missing something the other has.
     *
     * The view answers the question on screen and reaches cards whose home is
     * another list. What it also does is apply the view's own FILTER, and a
     * list's default view usually has one: measured on a real list, the view
     * answered 105 cards across nine statuses while the list holds 252 across
     * fourteen. Everything in TO DO, IN STAGING, IN PRODUCTION, WON'T FIX and
     * COMPLETED was invisible — not collapsed, absent, with no way to ask for
     * it. "I need every status to show up in the lists… otherwise, what is
     * the point."
     *
     * The raw list is the other half: it has no filter and it reaches the
     * closed ones, and it misses the cards this list only borrows. So both are
     * read and merged by id, and the board finally holds what ClickUp's own
     * page holds.
     *
     * One extra call per board read. That is the price of the answer being
     * right, and it is paid once per read rather than per card.
     */
    const raw = await rawListTasks(token, listId, me);
    const merged = mergeById(r.data?.tasks, raw.data?.tasks);
    if (merged.length) {
      return {
        ok: true as const,
        error: undefined,
        unauthorised: undefined,
        data: {
          tasks: merged,
          /* Truncated if EITHER half was: a board that dropped a page is
             partial whichever half dropped it. */
          truncated: !!(r.data?.truncated || raw.data?.truncated),
        },
      };
    }
    if (r.ok) return r;
    return raw;
  }
  return rawListTasks(token, listId, me);
}

/**
 * Two answers about the same list, as one list of cards.
 *
 * The view's order is kept — that is the sort a person set on it — and anything
 * only the raw list knows about is appended. Keyed by id, because the same card
 * legitimately appears in both and must appear once here.
 */
function mergeById(a?: ViewTasksResponse["tasks"], b?: ViewTasksResponse["tasks"]): ViewTasksResponse["tasks"] {
  const seen = new Set<string>();
  const out: ViewTasksResponse["tasks"] = [];
  for (const t of a ?? []) { if (t?.id && !seen.has(t.id)) { seen.add(t.id); out.push(t); } }
  for (const t of b ?? []) { if (t?.id && !seen.has(t.id)) { seen.add(t.id); out.push(t); } }
  return out;
}
