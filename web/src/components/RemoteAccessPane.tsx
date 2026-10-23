import { useCallback, useEffect, useRef, useState } from "react";
import { SettingRow, Switch } from "./SettingRow.tsx";
import { CommandLine, SELECT_BOX, EmptyState, ProblemNote, SettingsCard, StatusBadge } from "./SettingsKit.tsx";
import { useReportProblem, useReportSaving } from "./SettingsPageState.tsx";
import { problemChip } from "../lib/settingsStates.ts";
import { Select } from "./Select.tsx";
import { api } from "../lib/api.ts";
import { IS_DESKTOP, remoteAccessEnabled, setRemoteAccess, revokeRemoteAccess } from "../lib/desktop.ts";
import { fmtAgo } from "../lib/format.ts";
import { newlySecure, pickIndex, readPick, writePick, type PickedAddress } from "../lib/remoteLink.ts";
import { PairPanel } from "./PairPanel.tsx";
import { usePoll } from "../lib/usePoll.ts";
import type { RemoteStatus, RemoteDevice } from "../../../shared/types.ts";
import { Button } from "./workspace/Chrome.tsx";
import { PhoneIcon, ServerIcon, ShieldIcon } from "./settingsNavIcons.tsx";
import { ICON } from "../lib/iconSize.ts";

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
  /** The last read of the network state failed (the server did not answer), as against one that has not come back yet. */
  const [failed, setFailed] = useState(false);
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

  /* The last list of routes and whether a fresh tailnet look is worth asking
     for. Refs, because `load` runs from a timer and must not be rebuilt (and
     the interval with it) on every status. */
  const lastAddrs = useRef<RemoteStatus["addresses"] | null>(null);
  const wantFresh = useRef(false);
  const apply = useCallback((s: RemoteStatus | null) => {
    setSt(s);
    if (!s) return;
    // Fresh probes only while they can change the page: Tailscale is here and
    // there is no HTTPS route yet. The server caps how often it really asks.
    wantFresh.current = !!s.tailnet?.installed && !s.addresses.some((a) => a.secure);
    // An HTTPS route that shows up while the pane is open is the one the
    // person turned it on for: pick it, instead of leaving the old route.
    const fresh = newlySecure(lastAddrs.current, s.addresses);
    lastAddrs.current = s.addresses;
    if (fresh) { setChosen(fresh); writePick(fresh); }
  }, []);
  const load = useCallback(() => {
    api.remoteStatus(wantFresh.current).then((s) => { setFailed(false); apply(s); }).catch(() => { setSt(null); setFailed(true); });
  }, [apply]);
  useReportProblem("remote", failed ? { chip: problemChip(), title: "Could not read the network state." } : null, load);

  useEffect(() => {
    if (!open) return;
    load();
    remoteAccessEnabled().then(setEnabled);
  }, [open, load]);
  // Polled while the pane is open, which is what turns "a device connected"
  // into something you watch happen with the phone in your hand.
  usePoll(open, load, 3000);

  useEffect(() => {
    if (!open) { setStalled(false); return; }
    const t = setTimeout(() => setStalled(true), 90_000);
    return () => clearTimeout(t);
  }, [open]);

  useReportSaving("remote", busy);
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
    else if (ok === null) setRevokeNote("Nothing was changed: this shell cannot rotate the access code, or the server did not confirm that it had forgotten every paired device.");
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text)
      .then(() => { setCopied(text); setTimeout(() => setCopied(null), 1600); })
      .catch(() => { /* no clipboard permission — the text is on screen anyway */ });
  };

  if (!st) return (
    <SettingsCard title="Remote access" icon={<PhoneIcon size={ICON.sm} />} tone={failed ? "error" : "default"} desc="Reaching this machine from a phone, and what that phone is allowed to do.">
      {failed
        ? <ProblemNote title="Could not read the network state" action={<Button onClick={load}>Try again</Button>}>The local server did not answer. Whatever was paired stays paired; nothing here was changed.</ProblemNote>
        : <SettingRow label="Reading network state…" status={<StatusBadge tone="checking">Checking</StatusBadge>} />}
    </SettingsCard>
  );

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
    <>
      {/* Amber only for a real decision: the server listens but the gate would refuse every phone. */}
      <SettingsCard title="Remote access" icon={<PhoneIcon size={ICON.sm} />} tone={st.exposed && !st.trustLan ? "decision" : "default"} desc="Reaching this machine from a phone, and what that phone is allowed to do.">
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
            /* Live count as a badge rather than a sentence: it changes every
               three seconds, and a number that moves inside prose is noise. */
            status={enabled && st.clients.liveCount > 0
              ? <StatusBadge tone="ok">{st.clients.liveCount} connected</StatusBadge>
              : undefined}
            control={<Switch on={!!enabled} busy={busy} />}
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

        {/* Exposed, but the origin gate is shut: the page would load on the phone
            and every request inside it would 403. Open, not folded — it looks
            like a broken app rather than a setting. */}
        {st.exposed && !st.trustLan && (
          <SettingRow
            label="Private-network origins are not trusted"
            status={<StatusBadge tone="warn">Phone will be refused</StatusBadge>}
            hint={<>
              The server is bound to {st.bind} but private-network origins are not trusted, so a phone would
              load the page and then be refused by every request in it. Set{" "}
              <span className="t-mono">AGENTGLASS_TRUST_LAN=1</span> as well.
            </>} />
        )}

        {!st.webUi && (
          <SettingRow
            label="No dashboard build to serve"
            hint={<>
              This server has no dashboard build to serve, so the address above answers the API only. Run{" "}
              <span className="t-mono">bun run build</span> in the checkout.
            </>} />
        )}
      </SettingsCard>

      {live && (
        <>
          {/* Mounted in both faces so the paired list — the thing that decides
              which face — is never unmounted and re-fetched. */}
          <PairPanel baseUrl={url} variant={firstRun ? "hero" : "row"} onPaired={setPaired}
            canTurnOnHttps={!!st.tailnet?.installed && !st.addresses.some((a) => a.secure)} onStatus={apply} />

          <SettingsCard title="Address" icon={<ServerIcon size={ICON.sm} />}>
            <SettingRow
              label="Address"
              hint="Safe to share — it is an address, not a key. On a device that is not paired it opens a page and nothing else."
              below={<CommandLine command={url} shown={url.replace(/^https?:\/\//, "").replace(/\/$/, "")} />}
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
                  style={SELECT_BOX}
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
            <SettingRow
              label="What this exposes, and to whom"
              detail={{
                summary: address?.tailnet ? "How Tailscale protects this route" : "What crosses your network in the clear",
                body: address?.tailnet
                  ? <>Over Tailscale this is encrypted end to end and reaches only devices signed into your
                      tailnet, which makes it the safer of the two routes and the one to use on wifi you do
                      not own. Each paired device still gets exactly what you granted it, and nothing more —
                      forgetting one revokes only its own credential and closes what it is holding, and the
                      others keep working.</>
                  : <>Everything between a phone and this machine crosses your local network in the clear, so
                      anything else on that network can read it. Each paired device gets exactly what you
                      granted it and nothing more, but the link itself is not private. On wifi you do not own,
                      use a Tailscale route instead.</>,
              }}
            />

            {/* The failure this page exists for: the port is open, the server is
                listening, and the firewall drops the packets without answering,
                so the phone hangs on a blank page and nothing here looks wrong.
                Only after ninety seconds of nobody arriving — before that it is a
                diagnosis of a problem that is not happening yet. */}
            {stalled && seen.length === 0 && st.firewall && (
              <SettingRow
                label="Nothing has arrived yet"
                status={<StatusBadge tone="warn">No device after 90 s</StatusBadge>}
                hint={`If the phone shows a blank page, this machine's firewall (${st.firewall.tool}) is the likely reason.`}
                below={
                  <div className="flex flex-col gap-2">
                    <p className="m-0 text-[12px]" style={{ color: "var(--text2)" }}>
                      It drops the connection rather than refusing it, which is why the phone shows nothing at
                      all rather than an error. Run this in a terminal to let your own network in:
                    </p>
                    <CommandLine command={st.firewall.command} />
                    <p className="m-0 text-[12px] t-dim">
                      Copy it, then run it yourself. agentglass will not run this for you: it needs root, and a dashboard should not have it.
                    </p>
                  </div>
                }
              />
            )}
          </SettingsCard>

          {/* Addresses that have reached this server, which is a different list
              from the phones you paired — a paired phone can arrive from three
              addresses in a day. Its own card, because the list people manage is
              the paired one, and this is the one they audit. */}
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
        <SettingsCard title="Access code" icon={<ShieldIcon size={ICON.sm} />} tone="danger">
          <SettingRow
            label={<span style={{ color: "var(--error-ink)" }}>Revoke this link</span>}
            hint={confirming
              ? "Every paired device is forgotten, including the ones you cannot reach, and a new code is generated. The phones you still want will need to pair again."
              : "Forgets every paired device and rotates the access code. This is the revoke that reaches a device you no longer have in your hand."}
            actions={confirming ? (
              <>
                <Button tone="danger" onClick={revoke} disabled={busy}>{busy ? "Revoking…" : "Revoke"}</Button>
                <Button onClick={() => setConfirming(false)} disabled={busy}>Keep it</Button>
              </>
            ) : (
              <Button tone="danger" onClick={() => { setConfirming(true); setRevokeNote(null); }} disabled={busy}>Revoke</Button>
            )}
          />
          {revokeNote && (
            <SettingRow label="The link was not revoked" status={<StatusBadge tone="warn">Declined</StatusBadge>} hint={revokeNote} />
          )}
        </SettingsCard>
      )}
    </>
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
      label={t.dropped ? "Tailscale name dropped" : "Tailscale is not answering"}
      /* The count is the honest measure of "a blip" versus "it is down":
         one failed probe and forty look identical without it. */
      status={<StatusBadge tone={t.dropped ? "err" : "warn"}>
        {t.fails ?? 1} failed {t.fails === 1 ? "probe" : "probes"}
      </StatusBadge>}
      hint={<>
        <span className="block">{t.problem}.</span>
        <span className="block mt-1">
          {t.dropped
            ? "The name this machine answers to on your tailnet has been let go, so a phone connecting over it is now refused and will stop receiving alerts. It comes back on the first probe that works."
            : held
              ? `Still trusting ${held === 1 ? "the name" : `${held} names`} from the last successful look, so anything already connected over Tailscale keeps working. If tailscale stays silent, that trust is let go and the phone stops receiving alerts.`
              : "There is no tailnet name to fall back on, so a phone connecting over its MagicDNS name is refused until tailscale answers."}
        </span>
      </>}
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
    <SettingsCard
      icon={<PhoneIcon size={ICON.sm} />}
      title="Who has reached this machine"
      desc={clients.liveCount > 0
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
        return (
          <SettingRow key={d.address}
            label={<>{d.label} <span className="t-mono text-[11px] t-dim">{d.address}</span></>}
            status={self
              ? <StatusBadge tone="off">This machine</StatusBadge>
              : d.blocked
                ? <StatusBadge tone="err">Disconnected</StatusBadge>
                : live
                  ? <StatusBadge tone="ok">Connected</StatusBadge>
                  : <StatusBadge tone="off">Idle</StatusBadge>}
            hint={self
              ? "Reaching its own server through one of its addresses rather than through localhost."
              : d.blocked
                ? "Disconnected. Refused on every request until you let it back in."
                : live
                  ? `Connected now · ${d.live === 1 ? "one open connection" : `${d.live} open connections`}`
                  : `Last seen ${fmtAgo(d.lastAt)} · ${d.hits === 1 ? "one request" : `${d.hits} requests`}`}
            actions={!self ? (
              <Button tone={d.blocked ? undefined : "danger"} onClick={() => setBlocked(d, !d.blocked)} disabled={busy === d.address}>
                {busy === d.address ? "Working…" : d.blocked ? "Let it back in" : "Disconnect"}
              </Button>
            ) : undefined}
          />
        );
      })}
      <SettingRow
        label="What disconnecting does"
        hint="Disconnecting closes what that device is holding and refuses it by address until this server restarts. A device that can take a new address on your network can come back, so revoke the link when the answer needs to be permanent." />
    </SettingsCard>
  );
}

/** The manual route, for a shell that cannot restart its own server. */
function Recipe({ port }: { port: number }) {
  return (
    <SettingRow
      label="Start the server with the network open"
      hint={<>
        <span className="block">
          Only the process that started the server can change what it listens on, and in a browser tab that
          is not this page. Start it like this instead:
        </span>
        <span className="block mt-1">
          Run <span className="t-mono">bun run build</span> first, so the same port serves the dashboard as
          well as the API. The desktop app has this as a switch.
        </span>
      </>}
      below={<CommandLine command={`AGENTGLASS_BIND=0.0.0.0 \\\n  AGENTGLASS_TRUST_LAN=1 \\\n  AGENTGLASS_TOKEN=$(openssl rand -base64 24) \\\n  bun run server   # port ${port}`} />}
    />
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
