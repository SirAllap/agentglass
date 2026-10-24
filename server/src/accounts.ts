/**
 * The accounts a plugin says a provider has, held in memory.
 *
 * A plugin posts the whole list for a provider over its own token
 * (`POST /plugin/self/accounts`) and this module keeps the latest; the usage
 * popover reads it (`GET /usage/accounts`) and the person's press of a chip is
 * sent back to the plugin as an event. The app never reads or writes a
 * credential for any of it: the plugin is the only thing that knows how an
 * account is switched. Memory is enough, as for inbox annotations: a plugin is
 * a process that starts with the server and posts again, and a stopped plugin
 * leaves nothing behind (`forgetPlugin`), so a chip is never shown for a
 * plugin that is not there to switch it.
 */
import {
  accountOut, isAccountProvider, validateAccounts, ACCOUNT_ID_RE, ACCOUNT_MANAGERS,
  type AccountManager, type AccountProvider, type AccountsInput, type AccountsOut,
} from "../../shared/pluginAccounts.ts";
import type { Contributes } from "../../shared/pluginUi.ts";
import { clearUsageCache } from "./usage.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Whether Swapkin is on this machine: `swapkin` on the server's PATH or its data
 * folder. Existence only, nothing in the folder is read. This is what lets a
 * plugin that is not named `swapkin` ask to be shown as managed by it
 * (`deferTo`) without the app taking its word for it. Asked when the list
 * arrives, so a Swapkin installed later is picked up by the plugin's next post.
 */
export function swapkinPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  const data = env.SWAPKIN_DIR || join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "swapkin");
  return !!Bun.which("swapkin", { PATH: env.PATH ?? "" }) || existsSync(data);
}

const store = new Map<string, Map<AccountProvider, AccountsInput>>();

/** Replace the whole list for one provider. The provider must be one this plugin declared. */
export function setAccounts(
  plugin: string,
  c: Contributes,
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; kept: number } | { ok: false; error: string } {
  const v = validateAccounts(raw);
  if (!v.ok) return v;
  const { provider } = v.value;
  if (!c.accounts?.includes(provider)) return { ok: false, error: `accounts for ${provider} are not declared in this plugin's manifest` };
  // One list per provider: with two, the chips would show both and a press would
  // go to whichever posted first. enablePlugin and the resume refuse a second
  // holder; this is the same rule where a list actually arrives.
  for (const [other, theirs] of store) {
    if (other !== plugin && theirs.has(provider)) return { ok: false, error: `"${other}" already keeps the ${provider} accounts` };
  }
  const mine = store.get(plugin) ?? new Map<AccountProvider, AccountsInput>();
  // Where the credentials live in the keyring (macOS) the file's mtime never moves
  // on a switch, so the plugin saying the active login changed is the only signal
  // that the cached reading is for another account. A first post is not a change.
  const was = mine.get(provider)?.accounts.find((a) => a.active)?.id;
  const now = v.value.accounts.find((a) => a.active)?.id;
  if (provider === "anthropic" && was !== undefined && was !== now) clearUsageCache();
  // Decided here, never from a claim in the body: by the name the plugin is
  // installed under or by its `deferTo`, and either only once the app has found
  // that manager on this machine itself. Any manifest can take the name, so the
  // name alone would put "Managed by" on the chips and lock them.
  const { deferTo, ...rest } = v.value;
  const named = (ACCOUNT_MANAGERS as readonly string[]).includes(plugin) ? (plugin as AccountManager) : deferTo;
  const managedBy = named && swapkinPresent(env) ? named : undefined;
  mine.set(provider, { ...rest, ...(managedBy ? { managedBy } : {}) });
  store.set(plugin, mine);
  return { ok: true, kept: v.value.accounts.length };
}

export function forgetAccounts(plugin: string): void {
  store.delete(plugin);
}

/** Who is asking: the person's window (and the agents it serves), a paired device, or a plugin. */
export type AccountsViewer = "person" | "device" | { plugin: string };
/** What a paired device is given: how a chip reads, never an id, a colour, where it is stored or which plugin keeps it. */
export interface AccountsForDevice { provider: AccountProvider; managedBy?: AccountsInput["managedBy"]; accounts: Array<{ label: string; plan: string; active: boolean }> }

/**
 * One entry per provider that has a list. The phone shows the chips read-only
 * (its usage rows carry the same three fields) and presses nothing, so it has
 * no use for an id; a plugin has no business with another plugin's list.
 */
export function accountsList(viewer: "person"): AccountsOut[];
export function accountsList(viewer: "device"): AccountsForDevice[];
export function accountsList(viewer?: AccountsViewer): AccountsOut[] | AccountsForDevice[];
export function accountsList(viewer: AccountsViewer = "person"): AccountsOut[] | AccountsForDevice[] {
  const out: AccountsOut[] = [];
  for (const [plugin, mine] of store) {
    if (typeof viewer === "object" && viewer.plugin !== plugin) continue;
    for (const [provider, a] of mine) {
      out.push({ provider, plugin, ...(a.managedBy ? { managedBy: a.managedBy } : {}), accounts: a.accounts.map(accountOut) });
    }
  }
  out.sort((x, y) => x.provider.localeCompare(y.provider));
  if (viewer !== "device") return out;
  return out.map(({ provider, managedBy, accounts }) => ({
    provider, ...(managedBy ? { managedBy } : {}),
    accounts: accounts.map(({ label, plan, active }) => ({ label, plan, active })),
  }));
}

/** The plugin keeping a provider's list, with the list. Server side only: it carries readings. */
/** The list each provider's usage rows are split by, for one viewer: a plugin is given only the lists it keeps itself,
 *  the same rule as accountsList. Every login of a list becomes a row with its label (see providerusage withAccounts). */
export function accountsFor(viewer: AccountsViewer): (provider: string) => AccountsInput | undefined {
  return (p) => {
    const h = holderOf(p);
    return h && (typeof viewer !== "object" || viewer.plugin === h.plugin) ? h.list : undefined;
  };
}

export function holderOf(provider: string): { plugin: string; list: AccountsInput } | null {
  if (!isAccountProvider(provider)) return null;
  for (const [plugin, mine] of store) {
    const list = mine.get(provider);
    if (list) return { plugin, list };
  }
  return null;
}

/**
 * Whether a press of a chip may go to the holder, and if not, a sentence. Used
 * by the switch route and again by the agent door that stages one, so the two
 * cannot disagree about what a valid account is.
 */
export function switchRefusal(provider: unknown, id: unknown): string | null {
  if (typeof provider !== "string" || !isAccountProvider(provider)) return "unknown provider";
  if (typeof id !== "string" || !ACCOUNT_ID_RE.test(id)) return "unknown account";
  const h = holderOf(provider);
  if (!h) return `no plugin keeps the ${provider} accounts right now`;
  if (h.list.managedBy) return `the ${provider} accounts are managed by ${h.list.managedBy}, which switches them itself`;
  const a = h.list.accounts.find((x) => x.id === id);
  if (!a) return "unknown account";
  if (a.active) return "that account is already the active one";
  return null;
}

/** The same for opening the holder's own page: there has to be a holder, and it must not manage itself. */
export function manageRefusal(provider: unknown): string | null {
  if (typeof provider !== "string" || !isAccountProvider(provider)) return "unknown provider";
  const h = holderOf(provider);
  if (!h) return `no plugin keeps the ${provider} accounts right now`;
  if (h.list.managedBy) return `the ${provider} accounts are managed by ${h.list.managedBy}`;
  return null;
}

/**
 * Who may press a chip. The person, in the desktop window, and nobody the
 * desktop app has not vouched for with its key: an Origin is a header any
 * process on this machine can write, and here the effect is spending another
 * login's quota, so (like the disk clean) a server whose desk nobody holds, as
 * a hand-started one is, refuses it. Not a plugin, not a paired device (the
 * phone shows accounts, it does not switch them), and not a seat or an
 * understudy, whose tokens are machine-kind but belong to an agent.
 */
export function personMayPress(caller: { kind: string; principal?: string } | null, desktopOrigin: boolean, deskHeld: boolean, deskKeyOk: boolean): boolean {
  if (caller && (caller.kind !== "machine" || caller.principal)) return false;
  return desktopOrigin && deskHeld && deskKeyOk;
}
