import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { qrMatrix, qrSvgPath } from "../lib/qr.ts";
import { fmtAgo } from "../lib/format.ts";
import type { DeviceScope, PairedDevice, PairRequest, PairState } from "../../../shared/types.ts";

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
export function PairPanel({ baseUrl }: { baseUrl: string }) {
  const [ticket, setTicket] = useState<{ id: string; code: string; expiresAt: number } | null>(null);
  const [state, setState] = useState<PairState>({ ticket: null, pending: [], devices: [] });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
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
    poll();
    const t = setInterval(poll, 2000);
    // A second timer only for the countdown, so the digits tick every second
    // without asking the server sixty times a minute.
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(t); clearInterval(c); };
  }, [poll]);

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

  return (
    <div className="flex flex-col gap-2.5">
      {insecure && (
        <div className="text-[10.5px] px-2.5 py-2 rounded-lg" style={{
          color: "var(--text2)",
          background: "color-mix(in srgb, var(--error) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--error) 35%, transparent)",
        }}>
          <span style={{ color: "var(--error)" }}>A phone cannot pair over this address.</span>{" "}
          Browsers give a page served over plain HTTP no WebCrypto, and pairing has to encrypt the
          credential to the device asking for it — so the handshake cannot start, however many times
          the phone tries.{" "}
          {tailnet
            ? <>You are on Tailscale already: run <span className="t-mono">tailscale cert</span> on this
                machine and pick the <span className="t-mono">https://…ts.net</span> name above.</>
            : <>Serve the cockpit over HTTPS, or forward the port so the phone reaches it as
                <span className="t-mono"> http://localhost</span>.</>}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-[10px] t-dim2 uppercase tracking-wider flex-1">Connect a phone</span>
        {ticket && (
          <button onClick={start} disabled={busy}
            className="text-[10px] px-2 py-0.5 rounded-md hover:opacity-80"
            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
            New code
          </button>
        )}
      </div>

      {/* Requests come before the invitation. Somebody standing with a phone in
          their hand waiting to be let in is more urgent than the code, and a
          decision buried under a QR is one that gets made late or not at all. */}
      {state.pending.map((req) => (
        <Request key={req.id} req={req} busy={busy} onDecide={decide} />
      ))}

      {!ticket ? (
        <button onClick={start} disabled={busy}
          className="tile w-full !flex-row !items-center !gap-3 text-left hover:bg-white/5 px-3 py-2.5">
          <span className="text-[15px]" aria-hidden>📱</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>
              {busy ? "Starting…" : "Show a pairing code"}
            </span>
            <span className="block text-[10.5px] t-dim2 mt-0.5">
              A QR code and six digits, good for two minutes and one device.
            </span>
          </span>
        </button>
      ) : (
        <div className="flex items-start gap-3.5">
          <div className="shrink-0 flex flex-col items-center gap-1.5">
            <Qr text={pairUrl} />
            <span className="text-[10px] t-dim2">Scan with the camera</span>
          </div>
          <div className="min-w-0 flex-1 flex flex-col gap-1.5">
            <span className="text-[10px] t-dim2 uppercase tracking-wider">Then type this on the phone</span>
            {/* The biggest thing in the pane. It is being read off this screen
                and copied onto another one, and every point of size is a
                mis-typed digit that costs one of five attempts. */}
            <div className="t-mono select-all" style={{
              fontSize: 30, letterSpacing: "0.24em", color: "var(--text)", lineHeight: 1.15,
            }}>
              {ticket.code}
            </div>
            <div className="text-[10.5px]" style={{ color: left <= 20 ? "var(--warning)" : "var(--text3)" }}>
              {left > 0 ? `Expires in ${left}s` : "Expired — start a new one"}
            </div>
            <div className="text-[10.5px] t-dim2">
              The code is not in the QR. Scanning it from a photo or a shared screen gets no further
              than asking for these six digits.
            </div>
          </div>
        </div>
      )}

      {err && <div className="text-[10.5px]" style={{ color: "var(--error)" }}>{err}</div>}

      <Paired devices={state.devices} busy={busy} onForget={forget} />
    </div>
  );
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
    <div className="flex flex-col gap-2 px-3 py-2.5 rounded-xl" style={{
      background: "color-mix(in srgb, var(--primary) 9%, transparent)",
      border: "1px solid color-mix(in srgb, var(--primary) 38%, transparent)",
    }}>
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium truncate" style={{ color: "var(--text)" }}>
            {req.label} wants to connect
          </span>
          <span className="block text-[10.5px] t-dim2 truncate">
            {req.agent ? `${req.agent.slice(0, 80)} · ` : ""}from {req.ip || "an unknown address"}
          </span>
        </span>
        <span className="t-mono shrink-0" style={{ fontSize: 17, letterSpacing: "0.16em", color: "var(--text)" }}>
          {req.code}
        </span>
      </div>

      <div className="text-[10.5px] t-dim2">
        Check those six digits are the ones on the phone. If they are not, this is not the device you
        are holding — decline it.
      </div>

      {/* Chosen here rather than assumed, because this is the one moment
          somebody is already thinking about what this device is for. The
          default is the narrow one: a phone that answers gates does not need a
          terminal, and a default of "everything" is how every device ends up
          with everything. */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] t-dim2 uppercase tracking-wider">Give it</span>
        {SCOPES.map((s) => (
          <label key={s.key} className="flex items-start gap-2 px-2 py-1.5 rounded-lg cursor-pointer" style={{
            background: scope === s.key ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent",
            border: `1px solid color-mix(in srgb, ${scope === s.key ? "var(--primary)" : "var(--border)"} ${scope === s.key ? 45 : 28}%, transparent)`,
          }}>
            <input type="radio" name={`scope-${req.id}`} checked={scope === s.key}
              onChange={() => setScope(s.key)} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-[11.5px]" style={{ color: "var(--text)" }}>{s.title}</span>
              <span className="block text-[10px] t-dim2">{s.what}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button onClick={() => onDecide(req, scope)} disabled={busy}
          className="text-[11.5px] px-3 py-1.5 rounded-lg font-medium"
          style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 44%, transparent)" }}>
          Accept
        </button>
        <button onClick={() => onDecide(req, null)} disabled={busy}
          className="text-[11.5px] px-3 py-1.5 rounded-lg hover:opacity-80"
          style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 38%, transparent)" }}>
          Decline
        </button>
      </div>
    </div>
  );
}

/** The three levels, in the words that say what changes rather than what the
 *  field is called. See server/src/devices.ts for why there are only three. */
const SCOPES: { key: DeviceScope; title: string; what: string }[] = [
  { key: "answer", title: "Answer things", what: "Everything below, plus approving gates and replying to a session that is already running. What a phone is for." },
  { key: "read", title: "Look only", what: "Sessions, costs, changes, pull requests. It cannot approve anything or send anything." },
  { key: "full", title: "Everything this machine can do", what: "A terminal, git write access, docker control, merging pull requests. Give this to a laptop you trust, not to a phone." },
];

const SCOPE_WORD: Record<DeviceScope, string> = {
  read: "Look only",
  answer: "Answers gates and replies",
  full: "Full access — terminal, git, docker",
};

/**
 * What is paired, and the button that ends one of them.
 *
 * The revoke that already existed rotates the machine's code, which kicks every
 * device including the desk. Right when you have lost the code; far too big for
 * "that tablet is in a drawer". Forgetting one device leaves the others alone,
 * which is the difference between a control people use and one they put off.
 */
function Paired({ devices, busy, onForget }: {
  devices: PairedDevice[]; busy: boolean; onForget: (d: PairedDevice) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  if (!devices.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] t-dim2 uppercase tracking-wider px-0.5">Paired devices</span>
      {devices.map((d) => (
        <div key={d.id} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg" style={{
          background: "color-mix(in srgb, var(--bg2) 60%, transparent)",
          border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
        }}>
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] truncate" style={{ color: "var(--text)" }}>{d.label}</div>
            <div className="text-[10px] t-dim2">
              {SCOPE_WORD[d.scope]} · {d.lastSeenAt ? `last used ${fmtAgo(d.lastSeenAt)}` : "not used yet"}
            </div>
          </div>
          {confirming === d.id ? (
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={() => { setConfirming(null); onForget(d); }} disabled={busy}
                className="text-[10.5px] px-2 py-1 rounded-md"
                style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)" }}>
                Forget it
              </button>
              <button onClick={() => setConfirming(null)}
                className="text-[10.5px] px-2 py-1 rounded-md hover:opacity-80"
                style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                Keep
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirming(d.id)}
              className="shrink-0 text-[10.5px] px-2 py-1 rounded-md hover:opacity-80"
              style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 32%, transparent)" }}>
              Forget
            </button>
          )}
        </div>
      ))}
      <div className="text-[10px] t-dim2 px-0.5">
        Forgetting a device revokes only its own credential and closes what it is holding. The others
        keep working.
      </div>
    </div>
  );
}

/** Drawn from the matrix rather than fetched: an image of the way in to this
 *  machine has no business being a request to a third party. */
function Qr({ text }: { text: string }) {
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
  return (
    <svg
      width={140} height={140} viewBox={`0 0 ${span} ${span}`} shapeRendering="crispEdges"
      role="img" aria-label="QR code for the pairing invitation"
      className="shrink-0 rounded-lg"
      style={{ background: "#fff", padding: 0 }}>
      <path d={path} transform={`translate(${quiet} ${quiet})`} fill="#000" />
    </svg>
  );
}
