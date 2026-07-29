import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { IS_DESKTOP, remoteAccessEnabled, setRemoteAccess, revokeRemoteAccess } from "../lib/desktop.ts";
import { qrMatrix, qrSvgPath } from "../lib/qr.ts";
import { fmtAgo } from "../lib/format.ts";
import { pickIndex, readPick, writePick, maskToken, type PickedAddress } from "../lib/remoteLink.ts";
import type { RemoteStatus, RemoteDevice } from "../../../shared/types.ts";

/**
 * Open the dashboard on your phone.
 *
 * Every piece of this already worked from a terminal — bind off loopback, trust
 * private origins, carry a token — and none of it was reachable from the app,
 * so in practice it existed for people who read the environment table. What
 * this pane adds is the three things a person actually needs:
 *
 *   1. one switch, because the sequence is three variables and a restart;
 *   2. a QR code, because the URL is an IP, a port and a 32-character secret,
 *      typed on glass, once per device;
 *   3. the truth about whether it worked. That last one is why the panel talks
 *      about devices rather than about settings: the server can be bound,
 *      trusted and tokenised, and a host firewall will still drop every packet
 *      silently — the phone shows a white page and nothing anywhere says why.
 *      So the panel waits to *see* a device, and until it does, it names the
 *      firewall on this machine and prints the command that opens the port.
 */
export function RemoteAccessPane({ open }: { open: boolean }) {
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // The chosen route, not its position in the list: see remotePick.ts for why
  // an index cannot survive a new DHCP lease or a tailnet that comes up late.
  const [chosen, setChosen] = useState<PickedAddress | null>(() => readPick());
  // Revoking cannot be undone and cannot be partially done, so it asks once.
  const [confirming, setConfirming] = useState(false);
  const [revokeNote, setRevokeNote] = useState<string | null>(null);
  // The access code is covered until asked for: this pane is the one that ends
  // up in screenshots. See maskToken.
  const [reveal, setReveal] = useState(false);

  const load = useCallback(() => {
    api.remoteStatus().then(setSt).catch(() => setSt(null));
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = () => {
      api.remoteStatus().then((r) => { if (live) setSt(r); }).catch(() => { if (live) setSt(null); });
    };
    load();
    remoteAccessEnabled().then((v) => { if (live) setEnabled(v); });
    // Polled while the pane is open, which is what turns "a device connected"
    // into something you watch happen with the phone in your hand.
    const t = setInterval(load, 3000);
    return () => { live = false; clearInterval(t); };
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
    // what to do instead, and what happens once it is done: with nothing in
    // the environment the app keeps its own code in ~/.config/agentglass/token
    // and this button starts working.
    if (ok === false) setRevokeNote("AGENTGLASS_TOKEN is set in the environment this app was started from, so rotating a file the server does not read would report a revoke that did not happen. Unset it where it is exported (a shell profile, or `tmux setenv -gu AGENTGLASS_TOKEN` if you start the app from tmux), then start agentglass again. The app will keep its own code from then on, and this button will rotate it.");
    else if (ok === null) setRevokeNote("This shell cannot rotate the access code.");
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text)
      .then(() => { setCopied(text); setTimeout(() => setCopied(null), 1600); })
      .catch(() => { /* no clipboard permission — the text is on screen anyway */ });
  };

  if (!st) return <Wrap><div className="px-3 py-2 text-[11px] t-dim2">Reading network state…</div></Wrap>;

  const urls = st.urls;
  const pick = pickIndex(st.addresses, chosen);
  const url = urls[Math.min(pick, urls.length - 1)] ?? "";
  const address = st.addresses[pick];
  const live = st.exposed && st.trustLan && urls.length > 0;

  return (
    <Wrap>
      <div className="px-3 py-2 flex flex-col gap-3">
        {/* The state of the feature, in the one row the eye lands on: what the
            server is doing, whether anything is attached to it at this
            instant, and the switch that changes it. The old pane opened with a
            paragraph and put the switch under it, which meant the answer to
            "is this on, and is anyone on it" was two reads away. */}
        {enabled === null ? (
          /* A browser tab cannot rebind the server it is talking to: only the
             process that spawned it can. Rather than a switch that would do
             nothing, this is the recipe — the same one the desktop toggle
             performs. */
          <Recipe port={st.port} />
        ) : (
          <button onClick={toggle} disabled={busy} role="switch" aria-checked={!!enabled}
            className="tile w-full !flex-row !items-center !gap-3 text-left hover:bg-white/5"
            style={{ borderColor: enabled ? "color-mix(in srgb, var(--primary) 34%, transparent)" : undefined }}>
            <StateDot on={!!enabled} live={st.clients.liveCount > 0} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium" style={{ color: "var(--text)" }}>
                {busy ? "Restarting the server…" : enabled ? "Listening on your network" : "Remote access is off"}
              </span>
              <span className="block text-[10.5px] t-dim2 mt-0.5">
                {enabled
                  ? "A phone or tablet can open the companion from the sofa: monitoring, sessions and gate approvals."
                  : "The server answers this machine only. Nothing off-box can reach it."}
              </span>
            </span>
            {/* Live count as a chip rather than a sentence: it changes every
                three seconds, and a number that moves inside prose is noise. */}
            {enabled && st.clients.liveCount > 0 && (
              <span className="chip shrink-0 t-mono" style={{
                color: "var(--success)",
                background: "color-mix(in srgb, var(--success) 12%, transparent)",
                borderColor: "color-mix(in srgb, var(--success) 34%, transparent)",
              }}>
                {st.clients.liveCount} connected
              </span>
            )}
            <span className="shrink-0 relative rounded-full transition-colors" style={{
              width: 34, height: 19, opacity: busy ? 0.5 : 1,
              background: enabled ? "color-mix(in srgb, var(--primary) 55%, transparent)" : "color-mix(in srgb, var(--border) 55%, transparent)",
            }}>
              <span className="absolute rounded-full transition-transform" style={{
                width: 15, height: 15, top: 2, left: 2,
                transform: enabled ? "translateX(15px)" : "translateX(0)",
                background: enabled ? "var(--primary-hover)" : "var(--text3)",
              }} />
            </span>
          </button>
        )}

        {live && (
          <>
            {/* The link, given the room it needs: the code beside the QR
                rather than under it, and the routes to this machine as a
                column of real choices instead of a row of small pills. At the
                old width all of this wrapped into a stack you had to scroll. */}
            <div className="flex items-start gap-3.5">
              <div className="shrink-0 flex flex-col items-center gap-1.5">
                <Qr text={url} />
                <span className="text-[10px] t-dim2">Scan with the camera</span>
              </div>

              <div className="min-w-0 flex-1 flex flex-col gap-2.5">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] t-dim2 uppercase tracking-wider flex-1">The link</span>
                    {/* The QR always carries the real code — a masked one would
                        not scan. This only covers the text a screenshot keeps. */}
                    {url.includes("token=") && (
                      <button onClick={(e) => { e.stopPropagation(); setReveal((v) => !v); }}
                        className="text-[10px] px-2 py-0.5 rounded-md hover:opacity-80"
                        style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                        {reveal ? "Hide code" : "Show code"}
                      </button>
                    )}
                  </div>
                  <button onClick={() => copy(url)}
                    className="t-mono text-[11px] text-left px-2.5 py-2 rounded-lg break-all hover:opacity-80"
                    style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}>
                    {reveal ? url : maskToken(url)}
                  </button>
                  <div className="text-[10px] t-dim2">
                    {copied === url
                      ? "Copied, code included"
                      : "Click to copy, code included. The phone needs it once and then remembers it."}
                  </div>
                </div>

                {/* More than one route to this machine is normal (wifi plus a
                    tailnet), and they are not equivalent — one crosses a café,
                    the other does not. Each says what it is rather than making
                    the user infer it from an address, and the choice is kept
                    (see remoteLink.ts) because the pane used to forget it. */}
                {st.addresses.length > 1 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[10px] t-dim2 uppercase tracking-wider">Reachable at</span>
                    <div className="flex flex-col gap-1">
                      {st.addresses.map((a, i) => {
                        const on = i === pick;
                        return (
                          <button key={a.address} onClick={() => { setChosen(a); writePick(a); }}
                            className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left hover:opacity-90"
                            style={{
                              background: on ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent",
                              border: `1px solid color-mix(in srgb, ${on ? "var(--primary)" : "var(--border)"} ${on ? 45 : 30}%, transparent)`,
                            }}>
                            <span className="shrink-0 rounded-full" aria-hidden style={{
                              width: 6, height: 6,
                              background: on ? "var(--primary-hover)" : "transparent",
                              border: on ? "none" : "1px solid var(--text4)",
                            }} />
                            <span className="min-w-0 flex-1">
                              <span className="block text-[11.5px]" style={{ color: on ? "var(--text)" : "var(--text2)" }}>
                                {a.tailnet ? "Tailscale" : a.iface}
                                <span className="t-mono text-[10.5px] t-dim2"> {a.address}</span>
                              </span>
                              <span className="block text-[10px] t-dim2">
                                {a.tailnet
                                  ? "Works from anywhere, for devices signed into your tailnet."
                                  : "Works for anything on this network, and only there."}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Turning it on is a real decision, so the consequence is stated
                in the words it deserves rather than as "advanced". The
                sentence follows the address the user actually chose: a tailnet
                link is reachable from anywhere and only by devices signed into
                their own Tailscale, and saying "anyone on this network" over
                the top of that would be false in the direction that teaches
                people to stop reading warnings. */}
            <div className="text-[10.5px] px-2.5 py-2 rounded-lg" style={{
              color: "var(--text2)",
              background: "color-mix(in srgb, var(--warning) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
            }}>
              {address?.tailnet
                ? <>Whoever holds this link gets a terminal, git write access and docker control on this
                    machine. Over Tailscale that is limited to devices signed into your tailnet, which is the
                    safer of the two links on offer. It is still a shell: treat the code like a house key.</>
                : <>Anyone on this network who has this link gets a terminal, git write access and docker
                    control on this machine. Fine at home. Not on café or airport wifi.</>}
            </div>

            <Devices st={st} onCopy={copy} copied={copied} onChanged={load} />

            {/* The toggle shuts the port; it does not take back the key. A
                phone that scanned the code once can still get in the next time
                remote access goes on — lent, lost, or forwarded in a chat.
                Rotating the code is the revoke that reaches devices you no
                longer have in your hand. */}
            {enabled !== null && st.tokenRequired && (
              <div className="flex flex-col gap-1.5 pt-1.5" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
                {!confirming ? (
                  <button onClick={() => { setConfirming(true); setRevokeNote(null); }} disabled={busy}
                    className="self-start text-[11px] px-2.5 py-1.5 rounded-lg hover:opacity-80"
                    style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 32%, transparent)", opacity: busy ? 0.5 : 1 }}>
                    Revoke this link
                  </button>
                ) : (
                  <div className="flex flex-col gap-1.5 px-2.5 py-2 rounded-lg" style={{
                    background: "color-mix(in srgb, var(--error) 8%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--error) 30%, transparent)",
                  }}>
                    <div className="text-[11px]" style={{ color: "var(--text)" }}>
                      Every device that has this link stops working, including the ones you cannot reach.
                      A new code is generated and the phones you still want will need to scan it again.
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={revoke} disabled={busy}
                        className="text-[11px] px-3 py-1.5 rounded-lg font-medium"
                        style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 44%, transparent)", opacity: busy ? 0.5 : 1 }}>
                        {busy ? "Revoking…" : "Revoke and make a new code"}
                      </button>
                      <button onClick={() => setConfirming(false)} disabled={busy}
                        className="text-[11px] px-3 py-1.5 rounded-lg hover:opacity-80"
                        style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                        Keep it
                      </button>
                    </div>
                  </div>
                )}
                {revokeNote && <div className="text-[10.5px]" style={{ color: "var(--warning)" }}>{revokeNote}</div>}
              </div>
            )}
          </>
        )}

        {/* Exposed, but the origin gate is shut: the page would load on the
            phone and every request inside it would 403. Worth its own line,
            because it looks like a broken app rather than a setting. */}
        {st.exposed && !st.trustLan && (
          <div className="text-[10.5px] px-2.5 py-2 rounded-lg" style={{
            color: "var(--warning)",
            background: "color-mix(in srgb, var(--warning) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
          }}>
            The server is bound to {st.bind} but private-network origins are not trusted, so a phone would
            load the page and then be refused by every request in it. Set <span className="t-mono">AGENTGLASS_TRUST_LAN=1</span> as well.
          </div>
        )}

        {!st.webUi && (
          <div className="text-[10.5px] t-dim2">
            This server has no dashboard build to serve, so the address above answers the API only. Run
            <span className="t-mono"> bun run build</span> in the checkout.
          </div>
        )}
      </div>
    </Wrap>
  );
}

/** Same shape as the other settings panes; kept local rather than exported from
 *  SettingsModal, which imports this file. */
function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-2">
      <div className="panel-eyebrow px-3 pb-1">Remote access</div>
      {children}
    </div>
  );
}

/**
 * Who is on this machine, one row each, and the button that ends it.
 *
 * This replaced a single green sentence that counted devices and gave their
 * age. Counting is the wrong shape for the question being asked: the thing on
 * the other end of that link holds a terminal, git write access and docker, so
 * what a person wants to know is which device, whether it is connected *now*,
 * and how to stop it without getting up. `live` answers the second one
 * honestly — it is sockets held open at this instant, not a timestamp that
 * says "4m" whether the phone is in your hand or in a taxi.
 */
function Devices({ st, onCopy, copied, onChanged }: {
  st: RemoteStatus; onCopy: (s: string) => void; copied: string | null; onChanged: () => void;
}) {
  const { devices, clients, firewall } = st;
  const [busy, setBusy] = useState<string | null>(null);

  const setBlocked = async (d: RemoteDevice, blocked: boolean) => {
    setBusy(d.address);
    await api.remoteDevice(d.address, blocked).catch(() => null);
    setBusy(null);
    onChanged();
  };

  if (devices.length > 0) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2 px-0.5">
          <span className="text-[10px] t-dim2 uppercase tracking-wider flex-1">Devices</span>
          {/* Counts exclude this machine, which is in the list but is not a
              device that reached us: "one device is connected" meaning the
              window you are reading it in is worse than no number at all. */}
          <span className="text-[10px]" style={{ color: clients.liveCount > 0 ? "var(--success)" : "var(--text4)" }}>
            {clients.liveCount > 0
              ? `${clients.liveCount === 1 ? "One device is" : `${clients.liveCount} devices are`} connected right now`
              : clients.count > 0
                ? `${clients.count === 1 ? "One device has" : `${clients.count} devices have`} connected before`
                : "Nothing else has connected yet"}
          </span>
        </div>
        {devices.map((d) => {
          const live = d.live > 0 && !d.blocked;
          // This machine, reaching its own server through a real address
          // instead of loopback. It is shown because a row that vanishes is
          // its own kind of confusing, but it is named for what it is and the
          // button is gone: cutting it off would black out this window.
          const self = !!d.self;
          const tint = d.blocked ? "var(--error)" : self ? "var(--text3)" : live ? "var(--success)" : "var(--text3)";
          return (
            <div key={d.address} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg" style={{
              background: live && !self ? "color-mix(in srgb, var(--success) 8%, transparent)" : "color-mix(in srgb, var(--bg2) 60%, transparent)",
              border: `1px solid color-mix(in srgb, ${d.blocked ? "var(--error)" : live && !self ? "var(--success)" : "var(--border)"} ${(live && !self) || d.blocked ? 30 : 40}%, transparent)`,
            }}>
              {/* Steady when a socket is open, hollow when the device is only
                  remembered. It is the fastest read in the row, so it carries
                  the one fact that decides everything else. */}
              <span className="shrink-0 rounded-full" aria-hidden style={{
                width: 7, height: 7, background: live && !self ? "var(--success)" : "transparent",
                border: live && !self ? "none" : `1px solid ${tint}`,
                boxShadow: live && !self ? "0 0 0 3px color-mix(in srgb, var(--success) 18%, transparent)" : "none",
              }} />
              <div className="min-w-0 flex-1">
                <div className="text-[11.5px] truncate flex items-center gap-1.5" style={{ color: "var(--text)" }}>
                  <span className="truncate">{d.label}</span>
                  <span className="t-mono text-[10px] t-dim2">{d.address}</span>
                  {self && <span className="chip shrink-0 t-dim2">This machine</span>}
                </div>
                <div className="text-[10px]" style={{ color: tint }}>
                  {self
                    ? "This machine, reaching its own server through one of its addresses rather than through localhost."
                    : d.blocked
                      ? "Disconnected. It is refused on every request until you let it back in."
                      : live
                        ? `Connected now · ${d.live === 1 ? "one open connection" : `${d.live} open connections`}`
                        : `Last seen ${fmtAgo(d.lastAt)} · ${d.hits === 1 ? "one request" : `${d.hits} requests`}`}
                </div>
              </div>
              {!self && (
                <button onClick={() => setBlocked(d, !d.blocked)} disabled={busy === d.address}
                  className="shrink-0 text-[10.5px] px-2 py-1 rounded-md hover:opacity-80"
                  style={{
                    color: d.blocked ? "var(--text2)" : "var(--error)",
                    background: d.blocked ? "transparent" : "color-mix(in srgb, var(--error) 10%, transparent)",
                    border: `1px solid color-mix(in srgb, ${d.blocked ? "var(--border)" : "var(--error)"} ${d.blocked ? 45 : 32}%, transparent)`,
                    opacity: busy === d.address ? 0.5 : 1,
                  }}>
                  {busy === d.address ? "Working…" : d.blocked ? "Let it back in" : "Disconnect"}
                </button>
              )}
            </div>
          );
        })}
        {/* Said once, under the list, rather than in every row: an address is
            not an identity. Cutting one off is immediate and it is not the
            same promise as rotating the code. */}
        <div className="text-[10px] t-dim2 px-0.5">
          Disconnecting closes what that device is holding and refuses it by address until this server
          restarts. A device that can take a new address on your network can come back, so revoke the link
          below when the answer needs to be permanent.
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-2 rounded-lg" style={{
      background: "color-mix(in srgb, var(--bg2) 60%, transparent)",
      border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
    }}>
      <div className="text-[11px]" style={{ color: "var(--text2)" }}>
        No device has connected yet. Scan the code; this turns green the moment one arrives.
      </div>
      {firewall && (
        <>
          {/* The failure this exists for: the port is open, the server is
              listening, and the firewall drops the packets without answering —
              so the phone hangs on a blank page and nothing on this machine
              looks wrong. */}
          <div className="text-[10.5px] t-dim2">
            If it stays blank, this machine's firewall ({firewall.tool}) is the likely reason. It drops
            the connection rather than refusing it, which is why the phone shows nothing at all rather
            than an error. Run this in a terminal to let your own network in:
          </div>
          <button onClick={() => onCopy(firewall.command)}
            className="t-mono text-[10px] text-left px-2 py-1.5 rounded-lg break-all hover:opacity-80"
            style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}>
            {firewall.command}
          </button>
          <div className="text-[10px] t-dim2">
            {copied === firewall.command ? "Copied" : "Tap to copy. agentglass will not run this for you: it needs root, and a dashboard should not have it."}
          </div>
        </>
      )}
    </div>
  );
}

/** The manual route, for a shell that cannot restart its own server. */
function Recipe({ port }: { port: number }) {
  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-2 rounded-lg" style={{
      background: "color-mix(in srgb, var(--bg2) 60%, transparent)",
      border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
    }}>
      <div className="text-[11px]" style={{ color: "var(--text2)" }}>
        Only the process that started the server can change what it listens on, and in a browser tab that
        is not this page. Start it like this instead:
      </div>
      <div className="t-mono text-[10px] px-2 py-1.5 rounded-lg whitespace-pre-wrap" style={{
        color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)",
        border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
      }}>
        {`AGENTGLASS_BIND=0.0.0.0 \\\n  AGENTGLASS_TRUST_LAN=1 \\\n  AGENTGLASS_TOKEN=$(openssl rand -base64 24) \\\n  bun run server   # port ${port}`}
      </div>
      <div className="text-[10px] t-dim2">
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

/** The code itself: one SVG path, on a light plate so a dark theme still scans. */
function Qr({ text }: { text: string }) {
  let path: string;
  let size: number;
  try {
    const m = qrMatrix(text);
    size = m.length;
    path = qrSvgPath(m);
  } catch {
    return null; // longer than version 9 holds; the copyable URL still works
  }
  const quiet = 4; // scanners need the margin, so it is part of the image
  const span = size + quiet * 2;
  return (
    <svg
      width={150} height={150} viewBox={`0 0 ${span} ${span}`} shapeRendering="crispEdges"
      role="img" aria-label={`QR code for ${text}`}
      className="shrink-0 rounded-lg"
      style={{ background: "#fff", padding: 0 }}>
      <path d={path} transform={`translate(${quiet} ${quiet})`} fill="#000" />
    </svg>
  );
}
