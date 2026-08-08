import { useCallback, useEffect, useState } from "react";
import { Fold, SettingRow } from "./SettingRow.tsx";
import { Select } from "./Select.tsx";
import { api } from "../lib/api.ts";
import { IS_DESKTOP, remoteAccessEnabled, setRemoteAccess, revokeRemoteAccess } from "../lib/desktop.ts";
import { fmtAgo } from "../lib/format.ts";
import { pickIndex, readPick, writePick, type PickedAddress } from "../lib/remoteLink.ts";
import { PairPanel } from "./PairPanel.tsx";
import type { RemoteStatus, RemoteDevice } from "../../../shared/types.ts";

/**
 * Open the dashboard on your phone.
 *
 * Every piece of this already worked from a terminal — bind off loopback, trust
 * private origins, carry a token — and none of it was reachable from the app,
 * so in practice it existed for people who read the environment table. What
 * this pane adds is one switch, a code to scan, and the truth about whether it
 * worked; that last one is why it talks about devices rather than settings.
 *
 * ── Why it looks like this ────────────────────────────────────────────────
 *
 * It used to say all of that at once: nine stacked boxes and about two hundred
 * and sixty words, of which two were actions. Every sentence was true and each
 * one had earned its place by being the answer to some real confusion, and
 * together they were a wall — the page answers ONE question, "how do I get this
 * on my phone", and it answered it last.
 *
 * Two decisions fix it, and neither deletes a word.
 *
 * The page is ROWS, the same grid as the other twenty pages in Settings, so it
 * inherits their left edge, their control column and their search for free. A
 * page that draws its own boxes is a page that drifts.
 *
 * And the explanations FOLD. Why a Tailscale route is safe is read once, ever;
 * what to do when the phone shows a blank page is read only when the phone
 * shows a blank page. Folded they cost one line each. The exceptions are the
 * two that are not explanations but blockers — a plain-HTTP route cannot pair
 * a BROWSER (the app is fine: it makes its own key), and an untrusted origin
 * 403s every request — and those stay open, because a warning you have to
 * click to see is a warning you have not given.
 *
 * The first run is the exception to the rows: with nothing paired yet there is
 * exactly one thing to do, so the code takes the pane. See `firstRun`.
 */
export function RemoteAccessPane({ open }: { open: boolean }) {
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // The chosen route, not its position in the list: see remoteLink.ts for why
  // an index cannot survive a new DHCP lease or a tailnet that comes up late.
  const [chosen, setChosen] = useState<PickedAddress | null>(() => readPick());
  // Revoking cannot be undone and cannot be partially done, so it asks once.
  const [confirming, setConfirming] = useState(false);
  const [revokeNote, setRevokeNote] = useState<string | null>(null);
  /** How many phones are paired. Owned by PairPanel, which is the only thing
   *  that talks to the pairing endpoint; used here to pick a layout. */
  const [paired, setPaired] = useState<number | null>(null);
  /**
   * Long enough with nobody arriving that something is probably wrong.
   *
   * The firewall advice used to be on screen from the first second, which made
   * a normal first run look like a diagnosis. It is the right words at the
   * ninety-second mark and noise before it.
   */
  const [stalled, setStalled] = useState(false);

  const load = useCallback(() => {
    api.remoteStatus().then(setSt).catch(() => setSt(null));
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const tick = () => {
      api.remoteStatus().then((r) => { if (live) setSt(r); }).catch(() => { if (live) setSt(null); });
    };
    tick();
    remoteAccessEnabled().then((v) => { if (live) setEnabled(v); });
    // Polled while the pane is open, which is what turns "a device connected"
    // into something you watch happen with the phone in your hand.
    const t = setInterval(tick, 3000);
    return () => { live = false; clearInterval(t); };
  }, [open]);

  useEffect(() => {
    if (!open) { setStalled(false); return; }
    const t = setTimeout(() => setStalled(true), 90_000);
    return () => clearTimeout(t);
  }, [open]);

  const toggle = async () => {
    setBusy(true);
    // The shell restarts the sidecar and hands the page its new origin and
    // token; nothing reloads, so this has to refresh its own state afterwards.
    const next = await setRemoteAccess(!enabled);
    setBusy(false);
    if (next !== null) setEnabled(next);
    load();
  };

  const revoke = async () => {
    setBusy(true);
    const ok = await revokeRemoteAccess();
    setBusy(false);
    setConfirming(false);
    // The new code is already on its way to this page over the bridge; asking
    // the server again is what puts it in the QR.
    if (ok) load();
    // The messages below are for the two cases where the shell declines.
    // "Change it where it is set" was true and useless: the variable is
    // inherited, so the place it is set is somewhere the person has to go
    // looking — a shell profile, a tmux server's environment, a launcher. Say
    // what to do instead, and what happens once it is done.
    if (ok === false) setRevokeNote("AGENTGLASS_TOKEN is set in the environment this app was started from, so rotating a file the server does not read would report a revoke that did not happen. Unset it where it is exported (a shell profile, or `tmux setenv -gu AGENTGLASS_TOKEN` if you start the app from tmux), then start agentglass again. The app will keep its own code from then on, and this button will rotate it.");
    else if (ok === null) setRevokeNote("This shell cannot rotate the access code.");
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text)
      .then(() => { setCopied(text); setTimeout(() => setCopied(null), 1600); })
      .catch(() => { /* no clipboard permission — the text is on screen anyway */ });
  };

  if (!st) return <Wrap><div className="py-2 text-[12px] t-dim">Reading network state…</div></Wrap>;

  /*
   * Every address here pairs the app, and that is the change.
   *
   * This screen used to offer the HTTPS address alone and fold the plain-HTTP
   * ones away under "a phone can't pair over these". That was true, and it was
   * a fact about the BROWSER: `crypto.subtle` exists only in a secure context,
   * so a page served from http://192.168.1.20:4000 cannot generate the key the
   * handshake is built on — see the diagnosis in web/src/lib/pairing.ts.
   *
   * The app is not a page. @noble does P-256 on Hermes with no secure context,
   * so the LAN address pairs it — and that address is the one that needs no
   * software on the phone and no tailnet to be up.
   *
   * Keeping the old ranking had a cost that showed up the first time somebody
   * used it: the QR carried a tailnet address while the phone was signed out of
   * the tailnet, which fails as "nothing answered at …" with the address that
   * would have worked hidden behind a disclosure triangle. So the list is flat,
   * ordered as it arrives (no-extra-software first), and each row says what it
   * costs rather than whether it is allowed.
   */
  const pairAddrs = st.addresses;
  const pairUrls = st.urls;
  const pick = Math.min(pickIndex(pairAddrs, chosen), Math.max(0, pairAddrs.length - 1));
  const url = pairUrls[pick] ?? "";
  const address = pairAddrs[pick];
  const live = st.exposed && st.trustLan && pairUrls.length > 0;
  const seen = st.devices.filter((d) => !d.self);
  /*
   * Nothing has ever connected AND nothing is paired: there is exactly one
   * thing to do on this page, so it gets the page. `paired === null` means
   * PairPanel has not answered yet, and the rows are the safer guess — a page
   * that opens as a hero and collapses into a list a moment later is worse
   * than one that never was a hero.
   */
  const firstRun = live && paired === 0 && seen.length === 0;

  return (
    <Wrap>
      {/* Always first, always the same row: what the server is doing, whether
          anything is attached to it at this instant, and the switch. */}
      {enabled === null ? (
        /* A browser tab cannot rebind the server it is talking to: only the
           process that spawned it can. Rather than a switch that would do
           nothing, this is the recipe — the same one the desktop toggle
           performs. */
        <Recipe port={st.port} />
      ) : (
        <SettingRow
          onClick={busy ? undefined : toggle}
          role="switch"
          ariaChecked={!!enabled}
          label={<span className="flex items-center gap-2.5">
            <StateDot on={!!enabled} live={st.clients.liveCount > 0} />
            {busy ? "Restarting the server…" : enabled ? "Listening on your network" : "Remote access is off"}
          </span>}
          hint={
            /* This promised "the companion" — a phone-shaped web app that is
               deleted. What answers on a phone now is the agentglass app, and
               the browser that opens one of these addresses gets the cockpit,
               so the sentence names the app rather than a page. */
            enabled
              ? "The agentglass app can reach this machine from the sofa: monitoring, sessions and gate approvals."
              : "The server answers this machine only. Nothing off-box can reach it."}
          control={<span className="flex items-center gap-2.5">

            {/* Live count as a chip rather than a sentence: it changes every
                three seconds, and a number that moves inside prose is noise. */}
            {enabled && st.clients.liveCount > 0 && (
              <span className="chip t-mono whitespace-nowrap" style={{
                color: "var(--success)",
                background: "color-mix(in srgb, var(--success) 12%, transparent)",
                borderColor: "color-mix(in srgb, var(--success) 34%, transparent)",
              }}>
                {st.clients.liveCount} connected
              </span>
            )}
            <Switch on={!!enabled} busy={busy} />
          </span>}
        />
      )}

      {/* The plain-HTTP blocker is NOT said here. PairPanel already says it, in
          more detail and with the one-command Tailscale recipe attached, and it
          says it right above the button it disables. Saying it twice in two
          wordings was the first thing measuring this page caught: two red boxes
          eleven lines apart making the same claim, which reads as two problems. */}

      {/* OUTSIDE `live`, and above everything, because it is about the route
          silently stopping rather than about setting one up. See TailnetTrouble. */}
      <TailnetTrouble st={st} />

      {live && (
        <>
          {firstRun && <div className="panel-eyebrow pt-3 pb-1">Connect your phone</div>}
          {/* Mounted in both faces so the paired list — the thing that decides
              which face — is never unmounted and re-fetched. */}
          <PairPanel baseUrl={url} variant={firstRun ? "hero" : "row"} onPaired={setPaired} />

          <SettingRow
            label="Address"
            hint={copied === url
              ? "Copied."
              : "Safe to share — it is an address, not a key. On a device that is not paired it opens a page and nothing else."}
            control={<span className="flex items-center gap-2 min-w-0">
              <span className="t-mono text-[11px] truncate" style={{ color: "var(--text2)", maxWidth: 260 }}>
                {url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
              </span>
              <button onClick={() => copy(url)}
                className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
                style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                {copied === url ? "Copied" : "Copy"}
              </button>
            </span>}
          />

          {/* More than one route to this machine is normal (wifi plus a
              tailnet), and they are not equivalent — one crosses a café, the
              other does not. A stack of tall option cards is how that fact
              used to be told; a select says it in one line, and the choice is
              kept (see remoteLink.ts) because the pane used to forget it. */}
          {pairAddrs.length > 1 && (
            <SettingRow
              label="Route"
              hint={
                /* "a phone can pair over" was the old claim and it is false now:
                   the app makes its own key and pairs over plain HTTP fine. What
                   a plain-HTTP origin denies is WebCrypto, so it is the BROWSER
                   that cannot — see PairPanel, which states it once. */
                address?.secure
                  ? "Served over HTTPS, so this is the one a browser can pair over."
                  : "Reachable, but not a secure context — the app pairs over it anyway."}
              control={<Select
                align="right"
                value={address?.address ?? ""}
                onChange={(v) => {
                  const a = pairAddrs.find((x) => x.address === v);
                  if (a) { setChosen(a); writePick(a); }
                }}
                options={pairAddrs.map((a) => ({
                  value: a.address,
                  label: `${a.label ?? (a.tailnet ? "Tailscale" : a.iface)}${a.secure ? " · HTTPS" : ""}`,
                  hint: a.address,
                }))}
              />}
            />
          )}

          {/* A second list of addresses "a phone can't pair over" stood here
              and is gone with the bucket that fed it. `otherIdx` split the
              addresses in two because pairing needed a secure context; the app
              makes its own key, so every address pairs it and `pairAddrs` is
              now simply `st.addresses`. Keeping the fold would have hidden the
              LAN address — the one needing no tailnet — behind a disclosure
              triangle labelled "you cannot use these". */}

          {/* Read once, ever — so it costs one line until somebody wants it.
              It follows the route actually chosen: a tailnet link is reachable
              from anywhere and only by devices signed into their own Tailscale,
              and saying "anyone on this network" over the top of that would be
              false in the direction that teaches people to stop reading. */}
          <Fold label="What this exposes, and to whom">
            {address?.tailnet
              ? <>Over Tailscale this is encrypted end to end and reaches only devices signed into your
                  tailnet, which makes it the safer of the two routes and the one to use on wifi you do
                  not own. Each paired device still gets exactly what you granted it, and nothing more —
                  forgetting one revokes only its own credential and closes what it is holding, and the
                  others keep working.</>
              : <>Everything between a phone and this machine crosses your local network in the clear, so
                  anything else on that network can read it. Each paired device gets exactly what you
                  granted it and nothing more, but the link itself is not private. On wifi you do not own,
                  use a Tailscale route instead.</>}
          </Fold>

          {/* The failure this page exists for: the port is open, the server is
              listening, and the firewall drops the packets without answering,
              so the phone hangs on a blank page and nothing here looks wrong.
              Only after ninety seconds of nobody arriving — before that it is a
              diagnosis of a problem that is not happening yet. */}
          {stalled && seen.length === 0 && st.firewall && (
            <Fold defaultOpen label="Nothing has arrived yet"
              hint={`If the phone shows a blank page, this machine's firewall (${st.firewall.tool}) is the likely reason.`}>
              <p className="m-0 mb-2">
                It drops the connection rather than refusing it, which is why the phone shows nothing at
                all rather than an error. Run this in a terminal to let your own network in:
              </p>
              <button onClick={() => copy(st.firewall!.command)}
                className="t-mono text-[11px] text-left px-2.5 py-1.5 rounded-lg break-all hover:opacity-80 w-full"
                style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}>
                {st.firewall.command}
              </button>
              <p className="m-0 mt-1.5 text-[11.5px] t-dim">
                {copied === st.firewall.command
                  ? "Copied."
                  : "Tap to copy. agentglass will not run this for you: it needs root, and a dashboard should not have it."}
              </p>
            </Fold>
          )}

          {/* Addresses that have reached this server, which is a different list
              from the phones you paired — a paired phone can arrive from three
              addresses in a day. Folded, because the list people manage is the
              paired one, and this is the one they audit. */}
          {seen.length > 0 && <Seen st={st} onChanged={load} />}
        </>
      )}

      {/* OUTSIDE the `live` branch, and that is the fix rather than the layout.
          This sat inside it, so the only way to reach revoke was to have remote
          access ON — and turning it off is the first thing somebody does when
          they think a code has leaked. The toggle shuts the port; it does not
          take back the key, and since the desktop app began requiring a token
          on loopback too, the code still guards something with the switch off. */}
      {enabled !== null && st.tokenRequired && (
        <SettingRow
          align={confirming ? "start" : "center"}
          label={<span style={{ color: "var(--error)" }}>Revoke this link</span>}
          hint={confirming
            ? "Every device that has this link stops working, including the ones you cannot reach. A new code is generated and the phones you still want will need to scan it again."
            : "Rotates the access code. This is the revoke that reaches a device you no longer have in your hand."}
          control={confirming ? (
            <span className="flex items-center gap-2">
              <button onClick={revoke} disabled={busy}
                className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap font-medium"
                style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 44%, transparent)", opacity: busy ? 0.5 : 1 }}>
                {busy ? "Revoking…" : "Revoke"}
              </button>
              <button onClick={() => setConfirming(false)} disabled={busy}
                className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
                style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                Keep it
              </button>
            </span>
          ) : (
            <button onClick={() => { setConfirming(true); setRevokeNote(null); }} disabled={busy}
              className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
              style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 32%, transparent)", opacity: busy ? 0.5 : 1 }}>
              Revoke
            </button>
          )}
        />
      )}
      {revokeNote && <Alert tone="warning">{revokeNote}</Alert>}

      {/* Exposed, but the origin gate is shut: the page would load on the phone
          and every request inside it would 403. Open, not folded — it looks
          like a broken app rather than a setting. */}
      {st.exposed && !st.trustLan && (
        <Alert tone="warning">
          The server is bound to {st.bind} but private-network origins are not trusted, so a phone would
          load the page and then be refused by every request in it. Set{" "}
          <span className="t-mono">AGENTGLASS_TRUST_LAN=1</span> as well.
        </Alert>
      )}

      {!st.webUi && (
        <div className="py-2 text-[12px] t-dim">
          This server has no dashboard build to serve, so the address above answers the API only. Run{" "}
          <span className="t-mono">bun run build</span> in the checkout.
        </div>
      )}
    </Wrap>
  );
}

/** Same shape as the other settings panes; kept local rather than exported from
 *  SettingsModal, which imports this file. */
function Wrap({ children }: { children: React.ReactNode }) {
  return (
    /* The same shape as SettingsModal's own Section — an eyebrow and a rows
       box — so the column's one padding rule reaches this page too. Written
       out rather than imported because SettingsModal imports THIS file, and
       the other way round is a cycle. */
    <div className="pb-5 agx-settings-section">
      <div className="panel-eyebrow pb-1">Remote access</div>
      <div className="agx-settings-rows">{children}</div>
    </div>
  );
}

/** The one shape a warning takes on this page, so three of them cannot be three
 *  different objects. Sized to the column, not to its own words. */
function Alert({ tone, children }: { tone: "warning" | "error"; children: React.ReactNode }) {
  const c = tone === "error" ? "var(--error)" : "var(--warning)";
  return (
    <div className="my-1.5 px-3 py-2 rounded-lg text-[12px] leading-relaxed" style={{
      color: "var(--text2)",
      background: `color-mix(in srgb, ${c} 9%, transparent)`,
      border: `1px solid color-mix(in srgb, ${c} 32%, transparent)`,
    }}>
      {children}
    </div>
  );
}

/** The switch itself, so the three places that draw one draw the same one. */
function Switch({ on, busy }: { on: boolean; busy?: boolean }) {
  return (
    <span className="shrink-0 relative rounded-full transition-colors" style={{
      width: 34, height: 19, opacity: busy ? 0.5 : 1,
      background: on ? "color-mix(in srgb, var(--primary) 55%, transparent)" : "color-mix(in srgb, var(--border) 55%, transparent)",
    }}>
      <span className="absolute rounded-full transition-transform" style={{
        width: 15, height: 15, top: 2, left: 2,
        transform: on ? "translateX(15px)" : "translateX(0)",
        background: on ? "var(--primary-hover)" : "var(--text3)",
      }} />
    </span>
  );
}

/**
 * The tailnet name could not be confirmed — said out loud, because the failure
 * it stands for is invisible from everywhere else (T26).
 *
 * `tailscale status` failing used to empty the server's trusted-name set, and
 * that set guards the WebSocket upgrade. The phone, which states its MagicDNS
 * origin on purpose (mobile/src/lib/live.ts), stopped being upgraded and stopped
 * receiving alerts — while its REST poll kept working, so the app looked alive
 * and had quietly stopped buzzing. The server now HOLDS the last good name and
 * says here that it is holding it, which is the only place the difference
 * between "no tailnet" and "could not ask tailscale" is visible.
 *
 * Nothing is drawn while the probe is answering, and nothing is drawn on a
 * machine with no Tailscale on it — an explanation of a route you do not use is
 * noise on the one page that must stay about your phone.
 */
function TailnetTrouble({ st }: { st: RemoteStatus }) {
  const t = st.tailnet;
  if (!t || !t.installed || !t.problem) return null;
  const held = t.names.length;
  return (
    <SettingRow
      align="start"
      label={<span style={{ color: t.dropped ? "var(--error)" : "var(--warning)" }}>
        {t.dropped ? "Tailscale name dropped" : "Tailscale is not answering"}
      </span>}
      hint={<>
        <span className="block">{t.problem}.</span>
        <span className="block mt-0.5">
          {t.dropped
            ? "The name this machine answers to on your tailnet has been let go, so a phone connecting over it is now refused and will stop receiving alerts. It comes back on the first probe that works."
            : held
              ? `Still trusting ${held === 1 ? "the name" : `${held} names`} from the last successful look, so anything already connected over Tailscale keeps working. If tailscale stays silent, that trust is let go and the phone stops receiving alerts.`
              : "There is no tailnet name to fall back on, so a phone connecting over its MagicDNS name is refused until tailscale answers."}
        </span>
      </>}
      control={<span className="chip t-mono whitespace-nowrap" style={{
        color: t.dropped ? "var(--error)" : "var(--warning)",
        background: `color-mix(in srgb, ${t.dropped ? "var(--error)" : "var(--warning)"} 12%, transparent)`,
        borderColor: `color-mix(in srgb, ${t.dropped ? "var(--error)" : "var(--warning)"} 34%, transparent)`,
      }}>
        {/* The count is the honest measure of "a blip" versus "it is down":
            one failed probe and forty look identical without it. */}
        {t.fails ?? 1} failed {t.fails === 1 ? "probe" : "probes"}
      </span>}
    />
  );
}

/**
 * Which addresses have reached this machine, and the button that cuts one off.
 *
 * A different list from the paired phones, and the difference matters: a phone
 * you paired once can arrive from three addresses in a day, and an address is
 * not an identity. So this is the audit list — folded, because the list people
 * manage is the other one — and its button is honest about being temporary.
 */
function Seen({ st, onChanged }: { st: RemoteStatus; onChanged: () => void }) {
  const { devices, clients } = st;
  const [busy, setBusy] = useState<string | null>(null);

  const setBlocked = async (d: RemoteDevice, blocked: boolean) => {
    setBusy(d.address);
    await api.remoteDevice(d.address, blocked).catch(() => null);
    setBusy(null);
    onChanged();
  };

  return (
    <Fold
      label="Who has reached this machine"
      hint={clients.liveCount > 0
        ? `${clients.liveCount === 1 ? "One device is" : `${clients.liveCount} devices are`} connected right now`
        : clients.count > 0
          ? `${clients.count === 1 ? "One device has" : `${clients.count} devices have`} connected before`
          : "Nothing else has connected yet"}
    >
      {devices.map((d) => {
        const live = d.live > 0 && !d.blocked;
        // This machine, reaching its own server through a real address instead
        // of loopback. Shown because a row that vanishes is its own kind of
        // confusing, but named for what it is and with no button: cutting it
        // off would black out this window.
        const self = !!d.self;
        const tint = d.blocked ? "var(--error)" : self ? "var(--text3)" : live ? "var(--success)" : "var(--text3)";
        return (
          <div key={d.address} className="flex items-center gap-2.5 py-1.5">
            <span className="shrink-0 rounded-full" aria-hidden style={{
              width: 7, height: 7, background: live && !self ? "var(--success)" : "transparent",
              border: live && !self ? "none" : `1px solid ${tint}`,
            }} />
            <span className="min-w-0 flex-1">
              <span className="block truncate" style={{ color: "var(--text)" }}>
                {d.label}
                <span className="t-mono text-[11px] t-dim"> {d.address}</span>
                {self && <span className="chip ml-1.5 text-[10px] t-dim">this machine</span>}
              </span>
              <span className="block text-[11.5px]" style={{ color: tint }}>
                {self
                  ? "Reaching its own server through one of its addresses rather than through localhost."
                  : d.blocked
                    ? "Disconnected. Refused on every request until you let it back in."
                    : live
                      ? `Connected now · ${d.live === 1 ? "one open connection" : `${d.live} open connections`}`
                      : `Last seen ${fmtAgo(d.lastAt)} · ${d.hits === 1 ? "one request" : `${d.hits} requests`}`}
              </span>
            </span>
            {!self && (
              <button onClick={() => setBlocked(d, !d.blocked)} disabled={busy === d.address}
                className="shrink-0 text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
                style={{
                  color: d.blocked ? "var(--text2)" : "var(--error)",
                  border: `1px solid color-mix(in srgb, ${d.blocked ? "var(--border)" : "var(--error)"} ${d.blocked ? 45 : 32}%, transparent)`,
                  opacity: busy === d.address ? 0.5 : 1,
                }}>
                {busy === d.address ? "Working…" : d.blocked ? "Let it back in" : "Disconnect"}
              </button>
            )}
          </div>
        );
      })}
      <p className="m-0 mt-1.5 text-[11.5px] t-dim">
        Disconnecting closes what that device is holding and refuses it by address until this server
        restarts. A device that can take a new address on your network can come back, so revoke the
        link when the answer needs to be permanent.
      </p>
    </Fold>
  );
}

/** The manual route, for a shell that cannot restart its own server. */
function Recipe({ port }: { port: number }) {
  return (
    <div className="py-2 flex flex-col gap-1.5">
      <div className="text-[12.5px]" style={{ color: "var(--text2)" }}>
        Only the process that started the server can change what it listens on, and in a browser tab that
        is not this page. Start it like this instead:
      </div>
      <div className="t-mono text-[11px] px-2.5 py-2 rounded-lg whitespace-pre-wrap" style={{
        color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)",
        border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
      }}>
        {`AGENTGLASS_BIND=0.0.0.0 \\\n  AGENTGLASS_TRUST_LAN=1 \\\n  AGENTGLASS_TOKEN=$(openssl rand -base64 24) \\\n  bun run server   # port ${port}`}
      </div>
      <div className="text-[12px] t-dim">
        Run <span className="t-mono">bun run build</span> first, so the same port serves the dashboard as
        well as the API. The desktop app has this as a switch.
      </div>
    </div>
  );
}

/**
 * On, off, and on-with-someone-attached, as one mark.
 *
 * Three states rather than two: "listening" and "listening while a phone holds
 * a socket" are different facts about your machine, and the second is the one
 * worth noticing from across the room.
 */
function StateDot({ on, live }: { on: boolean; live: boolean }) {
  const tint = !on ? "var(--text4)" : live ? "var(--success)" : "var(--primary-hover)";
  return (
    <span className="shrink-0 rounded-full" aria-hidden style={{
      width: 9, height: 9,
      background: on ? tint : "transparent",
      border: on ? "none" : `1px solid ${tint}`,
      boxShadow: live ? `0 0 0 4px color-mix(in srgb, ${tint} 16%, transparent)` : "none",
    }} />
  );
}
