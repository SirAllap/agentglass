/** Decisions the Remote & devices page draws, kept out of the screen so they can be tested. */

export interface LinkInput {
  /** `null`: not read yet. */
  enabled: boolean | null;
  paired: number | null;
  live: number;
}
export interface LinkView { tone: "off" | "warn" | "ok"; label: string; line: boolean }

/** The strip between this machine and the phones: what it says, and whether the line is drawn. */
export function linkView(i: LinkInput): LinkView {
  if (i.enabled === false) return { tone: "off", label: "Remote access is off", line: false };
  if (i.live > 0) return { tone: "ok", label: i.live === 1 ? "1 phone connected" : `${i.live} phones connected`, line: true };
  return { tone: "warn", label: i.paired ? "Waiting for a phone" : "No phone paired yet", line: true };
}

/** The far end of the strip: a lone phone is named, any other count is a count. */
export function peerLabel(names: readonly string[]): { name: string; sub: string } {
  if (names.length === 1) return { name: names[0], sub: "paired" };
  if (names.length === 0) return { name: "Phones", sub: "none paired" };
  return { name: `${names.length} phones`, sub: "paired" };
}

/** The three levels, in one word set used everywhere: the device chip, the accept form and the capability table. */
export const SCOPE_CHIP = { read: "Look only", answer: "Answer things", full: "Full access" } as const;

export type ScopeKey = keyof typeof SCOPE_CHIP;

/** The accept form's choices, default first. See server/src/devices.ts for why there are only three. */
export const SCOPE_CHOICES: readonly { key: ScopeKey; title: string; what: string }[] = [
  { key: "answer", title: SCOPE_CHIP.answer, what: "Everything in Look only, plus approving gates. What a phone is for." },
  { key: "read", title: SCOPE_CHIP.read, what: "Sessions, costs, changes, pull requests. Cannot approve or send anything." },
  { key: "full", title: SCOPE_CHIP.full, what: "Terminal, git write, docker, merging pull requests. For a laptop you trust." },
];

/** The chip tone per scope: the default one is the accent, full access is a warning. */
export function scopeTone(scope: ScopeKey): "acc" | "warn" | "off" {
  return scope === "full" ? "warn" : scope === "answer" ? "acc" : "off";
}

/** What each level allows, grouped See / Answer / Operate. Each row is a route rule in server/src/auth.ts. */
export const CAPABILITIES: readonly { group: string; rows: readonly { what: string; read: boolean; answer: boolean; full: boolean }[] }[] = [
  { group: "See", rows: [
    { what: "Sessions, costs, changes and pull requests", read: true, answer: true, full: true },
    { what: "Hear alerts on the live connection", read: true, answer: true, full: true },
  ] },
  { group: "Answer", rows: [
    { what: "Approve or deny a gate an agent is stopped on", read: false, answer: true, full: true },
    { what: "Answer a settings request an agent is waiting on", read: false, answer: true, full: true },
    { what: "Mark something as read on every device", read: false, answer: true, full: true },
  ] },
  { group: "Operate", rows: [
    { what: "Open a terminal", read: false, answer: false, full: true },
    { what: "Git write, docker, merging pull requests", read: false, answer: false, full: true },
    { what: "Read imported browser history and plugin settings", read: false, answer: false, full: true },
  ] },
];

export type DeviceKind = "phone" | "tablet" | "laptop";

/** The glyph a paired device gets, from the name it gave itself. Anything unsure is a phone. */
export function deviceKind(label: string): DeviceKind {
  const l = label.toLowerCase();
  if (/\b(ipad|tablet|tab)\b|galaxy tab/.test(l)) return "tablet";
  // "Mac" and "Windows PC" are names guessName (lib/pairing.ts) gives a computer, so they must read as one.
  if (/\b(laptop|macbook|mac|imac|notebook|thinkpad|chromebook|desktop|pc|linux|windows|macos|firefox|chrome|safari)\b/.test(l)) return "laptop";
  return "phone";
}

/** A route's name when the server gives none: a tailnet is "Tailscale", a wireless card (wlan0, wlp2s0) is "Wi-Fi", anything else its interface. */
export function routeLabel(a: { iface: string; tailnet: boolean; label?: string }): string {
  if (a.label) return a.label;
  if (a.tailnet) return "Tailscale";
  return /^wl/i.test(a.iface) ? "Wi-Fi" : a.iface;
}

export interface RouteRow { address: string; label: string; iface: string; secure: boolean; pairing: string; on: boolean }

/** The route table: every address a phone can open, the picked one marked, and who can pair over it. */
export function routeRows(addrs: readonly { address: string; iface: string; tailnet: boolean; secure?: boolean; label?: string }[], pick: number): RouteRow[] {
  return addrs.map((a, i) => ({
    address: a.address,
    label: routeLabel(a),
    iface: a.iface,
    secure: !!a.secure,
    pairing: a.secure ? "HTTPS · app and browser" : "Plain HTTP · app only",
    on: i === pick,
  }));
}

/** The line under the switch: what the link is right now, in one sentence. */
export function accessSub(o: { enabled: boolean | null; busy: boolean; tailnet: boolean }): string {
  if (o.busy) return "Restarting the server…";
  if (o.enabled === false) return "Off: nothing listens beyond this machine.";
  return o.tailnet
    ? "Over Tailscale. The link is encrypted and reaches only devices on your tailnet."
    : "On, over your local network in the clear. On wifi you do not own, use a Tailscale route.";
}

export interface TailnetNote { tone: "warn" | "err" | "off"; title: string; body: string }

/**
 * The note under the routes. No Tailscale: say the local network is in the clear. Tailscale not
 * answering: the failed-probe count and whether its last name is still trusted. Healthy: nothing.
 */
export function tailnetNote(t: { installed: boolean; names: string[]; problem?: string; fails?: number; dropped?: boolean } | undefined, anyTailnetRoute: boolean): TailnetNote | null {
  if (!t || !t.installed) {
    if (anyTailnetRoute) return null;
    return { tone: "off", title: "No Tailscale route on this machine.", body: "Everything between a phone and this machine crosses your local network in the clear. On wifi you do not own, use a Tailscale route." };
  }
  if (!t.problem) return null;
  const fails = t.fails ?? 1;
  const count = `${fails} failed ${fails === 1 ? "probe" : "probes"}`;
  if (t.dropped) return { tone: "err", title: `Tailscale name dropped · ${count}.`, body: `${t.problem}. The name this machine answers to on your tailnet has been let go, so a phone connecting over it is now refused and will stop receiving alerts. It comes back on the first probe that works.` };
  const held = t.names.length;
  return { tone: "warn", title: `Tailscale is not answering · ${count}.`, body: held
    ? `${t.problem}. Still trusting ${held === 1 ? "the name" : `${held} names`} from the last successful look, so anything already connected over Tailscale keeps working. If tailscale stays silent, that trust is let go and the phone stops receiving alerts.`
    : `${t.problem}. There is no tailnet name to fall back on, so a phone connecting over its MagicDNS name is refused until tailscale answers.` };
}

/** The fold's heading after "Who has reached this machine". */
export function seenHead(live: number, count: number): string {
  if (live > 0) return `${live === 1 ? "One device is" : `${live} devices are`} connected right now`;
  if (count > 0) return `${count === 1 ? "One device has" : `${count} devices have`} connected before`;
  return "Nothing else has connected yet";
}

/** A paired phone's card, newest use first; forgotten ones are not cards. Any count, including 0 and 40. */
export function deviceCards<T extends { id: string; createdAt: number; lastSeenAt?: number; revokedAt?: number }>(devices: readonly T[]): T[] {
  return devices.filter((d) => !d.revokedAt)
    .sort((a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt));
}

/** A phone is "Active" while it asked for something in the last two minutes. */
export const ACTIVE_MS = 2 * 60_000;

export interface CardInput { label: string; scope: keyof typeof SCOPE_CHIP; lastSeenAt?: number }
export interface CardView { name: string; used: string; chip: string; active: boolean; kind: DeviceKind; tone: ReturnType<typeof scopeTone> }

/** What one paired-device card says. `ago` words a timestamp ("1 h ago"); `now` is passed in so this stays pure. */
export function cardView(d: CardInput, now: number, ago: (ts: number) => string): CardView {
  const active = !!d.lastSeenAt && now - d.lastSeenAt < ACTIVE_MS;
  return {
    name: d.label.trim() || "Unnamed phone",
    used: d.lastSeenAt ? `Used ${ago(d.lastSeenAt)}` : "Not used yet",
    chip: SCOPE_CHIP[d.scope] ?? SCOPE_CHIP.read,
    active,
    kind: deviceKind(d.label),
    tone: scopeTone(SCOPE_CHIP[d.scope] ? d.scope : "read"),
  };
}

/** The section's one-line intro: the count first, then what the section is for. */
export function devicesIntro(n: number): string {
  const tail = "Pair a phone with a code, and cut off one you no longer use.";
  return n === 0 ? `None paired. ${tail}` : `${n} paired. ${tail}`;
}

export interface PairButtonView { label: string; primary: boolean; disabled: boolean; /** Why it cannot be pressed, said beside it. */ hint?: string }

/** The one slot at the right of the Paired devices heading: "Pair a phone", or "New code" while a code is live. It never moves. */
export function pairButton(o: { off: boolean; pairing: boolean; busy: boolean }): PairButtonView {
  if (o.pairing) return { label: "New code", primary: false, disabled: o.busy };
  return { label: o.busy ? "Starting…" : "Pair a phone", primary: true, disabled: o.busy || o.off, ...(o.off ? { hint: "Turn on remote access first" } : {}) };
}

/** The pair button's width: wide enough for its longest label, so "Pair a phone" / "Starting…" / "New code" never move what is beside it (mockup .btn.w). */
export const PAIR_BUTTON_MIN_W = 112;

/** What the Paired devices section shows before it has a status: the same "can't reach" the Remote access section says, or a reading line. */
export function devicesWait(o: { failed: boolean; st: unknown }): "unreachable" | "reading" | null {
  if (o.st) return null;
  return o.failed ? "unreachable" : "reading";
}

export interface SeenFold { open: boolean; autoOpened: boolean }

/**
 * The "Who has reached this machine" fold. It opens by itself the first time a blocked address is
 * there, once per page visit, so "Let it back in" is not hidden. It never closes by itself: a fold
 * that shuts when the last block is lifted shuts under the mouse that lifted it.
 */
export function seenFold(s: SeenFold, anyBlocked: boolean): SeenFold {
  return anyBlocked && !s.autoOpened ? { open: true, autoOpened: true } : s;
}
