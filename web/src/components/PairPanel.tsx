import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { SettingRow } from "./settings/shell/SettingRow.tsx";
import { CommandLine, SettingsForm, StatusBadge } from "./SettingsKit.tsx";
import { api } from "../lib/api.ts";
import { usePoll } from "../lib/usePoll.ts";
import { qrMatrix, qrSvgPath } from "../lib/qr.ts";
import { fmtAgo } from "../lib/format.ts";
import { cardView, deviceCards, pairButton, PAIR_BUTTON_MIN_W, SCOPE_CHOICES } from "../lib/remoteView.ts";
import { rowId } from "../lib/settingsIndex.ts";
import { ICON } from "../lib/iconSize.ts";
import { PhoneIcon } from "./settingsNavIcons.tsx";
import { DeviceIcon } from "./deviceIcons.tsx";
import type { DeviceScope, PairedDevice, PairRequest, PairState, RemoteStatus, ServeResult } from "../../../shared/types.ts";
import { Button, LINE } from "./workspace/Chrome.tsx";
import { useVisibleInterval } from "../lib/visibleInterval.ts";

/**
 * Adding a phone, from the machine's side.
 *
 * This replaced a QR code that *was* the credential. Scanning it handed over
 * `AGENTGLASS_TOKEN` — the machine's own secret, with no expiry, no identity
 * and no way to take it back from one device — which meant a photograph of
 * this pane, a screenshot in a chat or a shared window in a call was a working
 * key to a terminal. There was no way to scan it carefully; being able to see
 * it was the whole authorisation.
 *
 * The QR now carries an invitation, and an invitation is worth nothing on its
 * own. Between it and a credential are the two steps this panel exists to
 * make visible:
 *
 *   * **six digits that are only on this screen.** They are not in the QR, so
 *     scanning it from a picture gets you a form asking for something the
 *     picture does not contain.
 *   * **a person here saying yes.** The request arrives named, with the
 *     address it came from and the same code, and waits.
 *
 * The full protocol, and what it does and does not defend against, is in
 * server/src/pairing.ts.
 */
export function PairPanel({ baseUrl, variant = "hero", onPaired, canTurnOnHttps = false, onStatus, off = false, frame, active = true }: {
  /** The page that holds it is on screen. Settings stays mounted when closed, and a
   *  2 s status read for a closed modal is 30 requests a minute for nobody. */
  active?: boolean;
  /** Where the section-wide "Pair a phone" button goes. The Settings page puts it at the right of
   *  its section heading; without a frame it is the first row. */
  frame?: (action: ReactNode, body: ReactNode) => ReactElement;
  /** Remote access is off: the cards stay, dim, and nothing can be started. */
  off?: boolean;
  baseUrl: string;
  /** Tailscale is on this machine and no HTTPS route exists yet: offer the
   *  button that runs `tailscale serve` instead of a command to paste. */
  canTurnOnHttps?: boolean;
  /** The fresh status that came back with the button, so the new route is in
   *  the page before the next poll. */
  onStatus?: (s: RemoteStatus) => void;
  /**
   * `hero` is the first-run face: the code fills the pane, because there is
   * nothing else to do on it yet. `row` is every visit after that, where
   * pairing another phone is one line among the others and the code appears
   * under it when asked for.
   */
  variant?: "hero" | "row";
  /** How many devices are actually paired, told upward — the page above uses it
   *  to decide which of those two faces to wear, and only this component talks
   *  to the pairing endpoint. */
  /** How many phones are paired, and the names of the ones not forgotten (the strip above names those, not raw connections). */
  onPaired?: (n: number, names: string[]) => void;
}) {
  const [ticket, setTicket] = useState<{ id: string; code: string; expiresAt: number } | null>(null);
  const [state, setState] = useState<PairState>({ ticket: null, pending: [], devices: [] });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [serving, setServing] = useState(false);
  const [serveFail, setServeFail] = useState<ServeResult | null>(null);
  const turnOnHttps = async () => {
    setServing(true);
    setServeFail(null);
    const r = await api.remoteServe().catch(() => null);
    setServing(false);
    if (r?.status) onStatus?.(r.status);
    if (!r?.ok) setServeFail(r ?? { ok: false, reason: "failed", message: "Could not reach the server." });
  };
  /**
   * Which invitation is open, as a ref rather than only as state.
   *
   * Two things read it outside a render, and both were wrong when it was
   * derived from `ticket` alone. The unmount cleanup has to cancel whatever is
   * open *at that moment*, not what was open when the effect ran. And the poll
   * that `start` fires immediately runs before React has re-rendered, so it
   * read `null`, asked the server about no ticket, was told there is none, and
   * cleared the invitation it had just minted — a button that visibly did
   * nothing. Writing the id here the moment it exists is what makes both
   * readers see the same answer as the render does.
   */
  const live = useRef<string | null>(null);
  live.current = ticket?.id ?? null;

  const poll = useCallback(async (id?: string) => {
    const want = id ?? live.current ?? "";
    try {
      const s = await api.pairState(want);
      setState(s);
      // The server is the authority on whether the invitation is still open —
      // it expires there. Following its answer is what makes the QR disappear
      // when the code behind it stops working, instead of leaving one on
      // screen that leads to "this invitation has expired".
      setTicket(s.ticket);
    } catch { /* the sidecar restarts when remote access is toggled */ }
  }, []);

  useEffect(() => {
    if (active) poll();
  }, [poll, active]);
  // A second timer only for the countdown, so the digits tick every second
  // without asking the server sixty times a minute.
  useVisibleInterval(() => setNow(Date.now()), 1000, active);
  usePoll(active, poll, 2000);

  // Closing the pane closes the invitation. A QR left live because a window was
  // shut is exactly the code somebody scans off a screenshot later.
  useEffect(() => () => { if (live.current) void api.pairCancel(live.current); }, []);

  const start = async () => {
    setBusy(true);
    setErr(null);
    if (live.current) await api.pairCancel(live.current).catch(() => null);
    const r = await api.pairTicket().catch(() => null);
    setBusy(false);
    if (!r?.ok || !r.id || !r.code) { setErr(r?.error ?? "Could not start an invitation."); return; }
    live.current = r.id; // before anything can poll for it — see the ref above
    setTicket({ id: r.id, code: r.code, expiresAt: r.expiresAt ?? Date.now() });
    poll(r.id);
  };

  const decide = async (req: PairRequest, scope: DeviceScope | null) => {
    setBusy(true);
    if (scope) await api.pairAccept(req.id, scope).catch(() => null);
    else await api.pairReject(req.id).catch(() => null);
    setBusy(false);
    poll();
  };

  const forget = async (d: PairedDevice) => {
    setBusy(true);
    await api.pairForget(d.id).catch(() => null);
    setBusy(false);
    poll();
  };

  const left = ticket ? Math.max(0, Math.round((ticket.expiresAt - now) / 1000)) : 0;
  const pairUrl = ticket ? `${baseUrl.replace(/\/$/, "")}/?pair=${encodeURIComponent(ticket.id)}` : "";
  /*
   * An address a phone cannot pair over, said here rather than there.
   *
   * `crypto.subtle` exists only in a secure context — HTTPS or localhost — so a
   * QR pointing at `http://100.64.1.2:4000` sends somebody to a page whose
   * handshake is impossible before it starts. The phone now says so instead of
   * failing quietly, but the phone is the wrong place to learn it: by then they
   * have walked over, scanned, and typed a name. This is the screen where the
   * address is chosen, so this is where it belongs.
   */
  const insecure = /^http:\/\//i.test(baseUrl) && !/^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)([:/]|$)/i.test(baseUrl);
  const tailnet = /^https?:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(baseUrl);
  const port = baseUrl.match(/:(\d{2,5})(?:\/|$)/)?.[1] ?? "4000";
  const hero = variant === "hero";
  /* Told upward from an effect, not from a render. The page above uses this to
     choose between its two faces, and setting a parent's state while a child is
     rendering is the one thing React will not have. One frame late is right
     here: the frame it is late by is the one before the first paint. */
  const pairedNames = state.devices.filter((d) => !d.revokedAt).map((d) => d.label);
  const namesKey = pairedNames.join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- namesKey stands for pairedNames
  useEffect(() => { onPaired?.(state.devices.length, pairedNames); }, [state.devices.length, namesKey, onPaired]);

  const btn = pairButton({ off, pairing: !!ticket, busy });
  const action = <Button tone={btn.primary ? "primary" : undefined} onClick={start} disabled={btn.disabled} style={{ minWidth: PAIR_BUTTON_MIN_W }}>{btn.label}</Button>;
  const cards = deviceCards(state.devices);
  const host = baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const body = (
    <>
      <>
        {!off && insecure && (
          <Block>
            {/* Whose limitation this is, said in the first clause. It used to be
               phrased as something the PHONE could not do, which was a fact
               about the browser wearing the phone's clothes — and it stopped
               being true the moment there was an app, which does not ask a page
               for its primitives. Getting that wrong is not cosmetic here: this
               sits directly above the QR, so it talks somebody out of the
               address that would have worked for them.

               "The companion" is gone from the sentence with the companion
               itself: the limitation was never about which application the page
               mounts, it is about what a plain-HTTP origin is allowed to do, so
               the cockpit inherits it unchanged. The subject stays "… in a
               browser", which is what pair-secure-context.test.ts pins — the
               clause that keeps this from sliding back to blaming the phone. */}
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium" style={{ color: "var(--error-ink)" }}>The cockpit in a browser cannot pair over this address.</span>
              <StatusBadge tone="err">Plain HTTP</StatusBadge>
            </div>
            <div className="text-[12px]" style={{ color: "var(--text2)" }}>A plain-HTTP page gets no WebCrypto, so a browser cannot start the handshake. The app pairs over it anyway.</div>
            <details>
              <summary className="cursor-pointer t-dim text-[12px]">Why, and what to do</summary>
              <div className="mt-1 text-[12px]" style={{ color: "var(--text2)" }}>
                Pairing has to encrypt the credential to the phone, and a plain-HTTP page has no primitives for
                that. The agentglass app makes its own key. The traffic is still readable by anything else on this network.
                {!tailnet && <span className="block mt-1">Serve the cockpit over HTTPS, or forward the port so the phone reaches it as <span className="t-mono">http://localhost</span>.</span>}
              </div>
            </details>
            {(canTurnOnHttps || tailnet) && (
              <div className="flex flex-col gap-2 text-[12px]" style={{ color: "var(--text2)" }}>
                {canTurnOnHttps && (
                  <div className="flex flex-col gap-1.5">
                    <SettingRow kind="control" settingId="remote.serve"
                      label="Publish this machine to your tailnet"
                      help="Gives this machine an HTTPS address a browser can pair over."
                      control={<Button tone="primary" onClick={turnOnHttps} disabled={serving}>{serving ? "Turning on…" : "Turn on HTTPS"}</Button>} />
                    {serveFail && (
                      <div className="flex flex-col gap-1" style={{ color: "var(--error-ink)" }}>
                        <div>{serveFail.message}</div>
                        {serveFail.url && <a href={serveFail.url} target="_blank" rel="noreferrer" className="t-mono break-all underline">{serveFail.url}</a>}
                        {serveFail.command && <CommandLine command={serveFail.command} />}
                      </div>
                    )}
                  </div>
                )}
                <details>
                <summary className="cursor-pointer t-dim">Or do it by hand</summary>
                <div className="flex flex-col gap-2 mt-2">
                <div>Put Tailscale's HTTPS in front of agentglass. Run this on the machine:</div>
                <CommandLine command={`tailscale serve --bg ${port}`} />
                <div className="t-dim">The first run may stop for one of these. Do it, then run the command again:</div>
                <div className="flex flex-col gap-1.5 t-dim">
                  <div>• <b>“Serve is not enabled”</b> — it prints a one-click link; open it (as your tailnet admin) to turn Serve on.</div>
                  <div>• <b>“Access denied”</b> — grant permission once (or just prefix <span className="t-mono">sudo</span>):</div>
                  <CommandLine command="sudo tailscale set --operator=$USER" />
                  <div>• <b>a certificate / HTTPS error</b> — Tailscale admin console → <b>DNS</b> → enable <b>HTTPS Certificates</b>.</div>
                </div>
                <div>When it prints <span className="t-mono">https://…ts.net/</span>, a <b>Tailscale (HTTPS)</b> address shows up in the list below — pick it and scan its QR.</div>
                <div className="t-dim">Undo any time:</div>
                <CommandLine command="tailscale serve reset" />
                </div>
                </details>
              </div>
            )}
          </Block>
        )}

        {/* Requests come before the invitation. Somebody standing with a phone in
            their hand waiting to be let in is more urgent than the code, and a
            decision buried under a QR is one that gets made late or not at all. */}
        {state.pending.map((req) => (
          <Request key={req.id} req={req} busy={busy} onDecide={decide} />
        ))}

        {off ? null : !ticket ? (
          /* The code is still not minted until it is asked for — opening
             Settings should not burn a two-minute invitation. With nothing
             paired the card says how it goes; afterwards the button says it. */
          !cards.length && <FirstPair hero={hero} />
        ) : (
          /* Centred and large on first run, because it is the only thing to do;
             beside the words afterwards, because by then it is one task among
             several and the page has other rows to keep its shape. */
          <Block>
              <div className={`flex gap-5 ${hero ? "flex-col items-center text-center" : "items-start flex-wrap"}`}>
                <div className="shrink-0"><Qr text={pairUrl} big={hero} /></div>
                <div className={`min-w-0 flex flex-col gap-1 ${hero ? "items-center" : ""}`}>
                  <div className="text-[13px] font-medium" style={{ color: "var(--text)" }}>Scan with the camera, then type the code on the phone</div>
                  <div className="text-[12px] mb-1.5" style={{ color: "var(--text2)" }}>The code is not in the QR, so a photo of it is not enough.</div>
                  {/* The biggest thing on the page. It is being read off this
                      screen and copied onto another one, and every point of
                      size is a mis-typed digit that costs one of five attempts. */}
                  <div className="t-mono select-all" style={{
                    fontSize: hero ? 38 : 30, letterSpacing: "0.24em", color: "var(--text)", lineHeight: 1.15,
                  }}>
                    {ticket.code}
                  </div>
                  <div aria-hidden className="mt-1 h-1 w-full max-w-[220px] overflow-hidden rounded-full" style={{ background: "var(--surface-inset)" }}>
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, (left / 120) * 100)}%`, background: left <= 20 ? "var(--warning)" : "var(--primary)" }} />
                  </div>
                  <div className="text-[12px]" style={{ color: left <= 20 ? "var(--warning-ink)" : "var(--text3)" }}>
                    {left > 0 ? <>Expires in {left}s · one device{host && <> · over <span className="t-mono">{host}</span></>}</> : "Expired — start a new one"}
                  </div>
                </div>
              </div>
          </Block>
        )}

        {!off && err && <Block alert><span className="text-[13px] font-medium">Could not start an invitation</span><span className="text-[12px]" style={{ color: "var(--error-ink)" }}>{err}</span></Block>}
      </>

      <Paired devices={state.devices} busy={busy} onForget={forget} off={off} />
    </>
  );
  /* In a heading the button is still the "Pair a phone" row search jumps to, so it carries that
     row's anchor. Off, it stays in its place, disabled, with the reason beside it. */
  if (frame) return frame(
    <span data-row={rowId("Pair a phone")} className="flex items-center gap-2">
      {btn.hint && <span className="text-[12px]" style={{ color: "var(--text3)" }}>{btn.hint}</span>}
      {action}
    </span>, body);
  return (
    <>
      {!off && <SettingRow kind="control" agentExempt label="Pair a phone" help="Show a code, scan it, say yes here." control={action} />}
      {body}
    </>
  );
}

/** Nothing paired yet and no code open: what pairing is, in three steps. The button is in the heading. */
function FirstPair({ hero }: { hero: boolean }) {
  return (
    <div className="flex items-start gap-3.5 px-3.5 py-4" style={{ borderTop: LINE }}>
      <span aria-hidden className="grid shrink-0 place-items-center rounded-xl" style={{ width: 48, height: 48, background: "var(--surface-inset)", color: "var(--primary)" }}>
        <PhoneIcon size={ICON.rail} />
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium" style={{ color: "var(--text)" }}>Pair your first phone</div>
        <p className="m-0 mt-0.5 text-[12px]" style={{ color: "var(--text2)" }}>
          {hero ? "You get a QR code and six digits. Good for two minutes and one device." : "A QR code and six digits, good for two minutes and one device."}
        </p>
        <ol className="m-0 mt-2.5 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0 text-[12px]" style={{ color: "var(--text2)" }}>
          {["Scan the QR", "Type the six digits", "Say yes here"].map((t, i) => (
            <li key={t} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="grid place-items-center rounded-full text-[11px] font-semibold" style={{ width: 18, height: 18, background: "var(--surface-inset)", color: "var(--text)" }}>{i + 1}</span>{t}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** A block of a section that is a form or a read-out, not one label and one control. */
function Block({ children, alert }: { children: React.ReactNode; alert?: boolean }) {
  return <div {...(alert ? { role: "alert" } : null)} className="px-3 py-2.5 flex flex-col gap-2" style={{ borderTop: LINE }}>{children}</div>;
}

/**
 * A phone asking to be let in.
 *
 * Everything known about it is on the card, because the decision is "is this
 * mine" and nothing else can answer that: the name it gave, the address it
 * came from, and the code — so the person here can check the six digits on the
 * screen in their hand match the six on this one, which is what makes this a
 * confirmation rather than a button that says yes.
 */
function Request({ req, busy, onDecide }: {
  req: PairRequest; busy: boolean; onDecide: (r: PairRequest, s: DeviceScope | null) => void;
}) {
  const [scope, setScope] = useState<DeviceScope>("answer");
  return (
    <Block>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium" style={{ color: "var(--text)" }}>{req.label} wants to connect</span>
        <span className="t-mono" style={{ fontSize: 17, letterSpacing: "0.16em", color: "var(--text)" }}>{req.code}</span>
      </div>
      <div className="text-[12px]" style={{ color: "var(--text2)" }}>
        <span className="block">{req.agent ? `${req.agent.slice(0, 80)} · ` : ""}from {req.ip || "an unknown address"}</span>
        <span className="block mt-1">Check those six digits are the ones on the phone. If they are not, decline it.</span>
      </div>
        {/* Chosen here rather than assumed, because this is the one moment
           somebody is already thinking about what this device is for. The
           default is the narrow one: a phone that answers gates does not need a
           terminal, and a default of "everything" is how every device ends up
           with everything. */}
        <SettingsForm label={`Let ${req.label} in`} onSubmit={() => onDecide(req, scope)}>
          <div role="radiogroup" aria-label="Give it" className="flex flex-col gap-1">
            <span className="agx-field-l">Give it</span>
            {SCOPE_CHOICES.map((s) => (
              <label key={s.key} className="flex items-start gap-2 px-2 py-1.5 rounded-lg cursor-pointer" style={{
                background: scope === s.key ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent",
              }}>
                <input type="radio" name={`scope-${req.id}`} checked={scope === s.key}
                  onChange={() => setScope(s.key)} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>{s.title}</span>
                  <span className="block text-[11.5px] t-dim">{s.what}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" tone="ok" disabled={busy}>Accept</Button>
            <Button tone="danger" disabled={busy} onClick={() => onDecide(req, null)}>Decline</Button>
          </div>
        </SettingsForm>
    </Block>
  );
}

/**
 * What is paired, and the button that ends one of them.
 *
 * The revoke that already existed rotates the machine's code, which kicks every
 * device including the desk. Right when you have lost the code; far too big for
 * "that tablet is in a drawer". Forgetting one device leaves the others alone,
 * which is the difference between a control people use and one they put off.
 */
function Paired({ devices, busy, onForget, off }: {
  devices: PairedDevice[]; busy: boolean; onForget: (d: PairedDevice) => void; off: boolean;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const cards = deviceCards(devices);
  if (!cards.length) return null;
  /* One table: device, access, status, and an action column of fixed width so "Forget" and its
     "Forget it / Keep" confirm sit in the same place on every row. */
  const cols = "52px minmax(0, 1fr) auto 84px 156px";
  const head = "px-2 py-1.5 text-[11px] font-medium";
  return (
    <div role="table" aria-label="Paired devices" className="grid items-center" style={{ gridTemplateColumns: cols, borderTop: LINE, opacity: off ? 0.55 : 1 }}>
      <div role="row" className="contents">
        <span role="columnheader" className={head} />
        <span role="columnheader" className={head} style={{ color: "var(--text3)" }}>Device</span>
        <span role="columnheader" className={head} style={{ color: "var(--text3)" }}>Access</span>
        <span role="columnheader" className={head} style={{ color: "var(--text3)" }}>Status</span>
        <span role="columnheader" className={head}><span className="sr-only">Action</span></span>
      </div>
      {cards.map((d) => {
        const v = cardView(d, Date.now(), fmtAgo);
        const cell = { borderTop: LINE } as const;
        return (
          <div key={d.id} role="row" data-device={d.id} className="contents">
            <span role="cell" className="flex h-full items-center py-2.5 pl-3" style={cell}>
              <span aria-hidden className="relative grid place-items-center rounded-lg" style={{ width: 34, height: 34, background: "var(--surface-inset)", color: "var(--primary)" }}>
                <DeviceIcon kind={v.kind} size={ICON.xl} />
                <span className="absolute rounded-full" style={{ right: -2, bottom: -2, width: 9, height: 9, background: v.active ? "var(--success)" : "var(--text4)", boxShadow: "0 0 0 2px var(--surface-card)" }} />
              </span>
            </span>
            <span role="cell" className="flex h-full min-w-0 flex-col justify-center px-2 py-2.5" style={cell}>
              <span className="block break-words text-[13px] font-medium" style={{ color: v.name === "Unnamed phone" ? "var(--text3)" : "var(--text)" }}>{v.name}</span>
              <span className="block break-words text-[12px]" style={{ color: "var(--text2)" }}>{v.used}</span>
            </span>
            <span role="cell" className="flex h-full items-center px-2 py-2.5" style={cell}><ScopeChip tone={v.tone}>{v.chip}</ScopeChip></span>
            <span role="cell" className="flex h-full items-center px-2 py-2.5" style={cell}>
              <StatusBadge tone={v.active ? "ok" : "off"}>{v.active ? "Active" : "Idle"}</StatusBadge>
            </span>
            <span role="cell" className="flex h-full items-center justify-end gap-1.5 py-2.5 pr-3" style={cell}>
              {confirming === d.id ? (
                <>
                  <Button tone="danger" onClick={() => { setConfirming(null); onForget(d); }} disabled={busy}>Forget it</Button>
                  <Button onClick={() => setConfirming(null)}>Keep</Button>
                </>
              ) : (
                <Button onClick={() => setConfirming(d.id)} aria-label={`Forget ${v.name}`}>Forget</Button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A scope as a chip: the default level in the accent, full access as a warning, look only plain. */
export function ScopeChip({ tone, children }: { tone: "acc" | "warn" | "off"; children: ReactNode }) {
  const hue = tone === "acc" ? "var(--primary)" : tone === "warn" ? "var(--warning)" : null;
  return (
    <span className="t-mono inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold" style={hue
      ? { background: `color-mix(in srgb, ${hue} 14%, transparent)`, color: tone === "acc" ? "color-mix(in srgb, var(--primary) 78%, var(--text))" : "var(--warning-ink)" }
      : { background: "var(--surface-inset)", color: "var(--text2)" }}>{children}</span>
  );
}

/** Drawn from the matrix rather than fetched: an image of the way in to this
 *  machine has no business being a request to a third party. */
function Qr({ text, big }: { text: string; big?: boolean }) {
  let path: string;
  let size: number;
  try {
    const m = qrMatrix(text);
    size = m.length;
    path = qrSvgPath(m);
  } catch {
    return null; // longer than version 9 holds
  }
  const quiet = 4; // scanners need the margin, so it is part of the image
  const span = size + quiet * 2;
  const px = big ? 184 : 140;
  return (
    <svg
      width={px} height={px} viewBox={`0 0 ${span} ${span}`} shapeRendering="crispEdges"
      role="img" aria-label="QR code for the pairing invitation"
      className="shrink-0 rounded-lg"
      style={{ background: "#fff", padding: 0 }}>
      <path d={path} transform={`translate(${quiet} ${quiet})`} fill="#000" />
    </svg>
  );
}
