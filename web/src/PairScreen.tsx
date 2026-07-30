import { useCallback, useEffect, useRef, useState } from "react";
import { SERVER } from "./lib/api.ts";
import { claim, collectOnce, guessName, makeKeys, type PairKeys } from "./lib/pairing.ts";

/**
 * Connecting this phone, on the phone.
 *
 * The whole screen exists to make two things unmissable, because they are the
 * two the old flow did not have:
 *
 *   * **you have to be looking at the computer.** The six digits are only on
 *     that screen. Scanning the QR from a photograph, a shared window or across
 *     a room gets you this form and no further.
 *   * **somebody there has to agree.** After the code there is a wait, and what
 *     it is waiting for is a person — named, with the request in front of them.
 *
 * It is deliberately the only thing on the display. A pairing handshake folded
 * into a settings pane is one people click through; this asks for two actions
 * and then gets out of the way.
 */
export function PairScreen({ ticket, onPaired }: { ticket: string; onPaired: (token: string) => void }) {
  type Stage = "checking" | "form" | "waiting" | "expired" | "rejected" | "failed";
  const [stage, setStage] = useState<Stage>("checking");
  const [name, setName] = useState(() => guessName());
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef<PairKeys | null>(null);
  const secret = useRef<string>("");

  // Generated while the person is still typing their device name, so the wait
  // for key generation lands in a moment nobody is watching rather than between
  // the last digit and the answer.
  useEffect(() => {
    let live = true;
    makeKeys()
      .then((k) => { if (live) keys.current = k; })
      .catch(() => { if (live) { setStage("failed"); setErr("This browser cannot generate the key this connection needs. It has to be a recent Safari, Chrome or Firefox, over the address the QR code pointed at."); } });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    fetch(`${SERVER}/pair/info?ticket=${encodeURIComponent(ticket)}`)
      .then((r) => r.json())
      .then((j: { ok?: boolean }) => { if (live) setStage(j.ok ? "form" : "expired"); })
      .catch(() => { if (live) { setStage("failed"); setErr(`Could not reach ${SERVER}. Check the phone is on the same network as the computer.`); } });
    return () => { live = false; };
  }, [ticket]);

  const send = useCallback(async () => {
    if (busy || code.length !== 6) return;
    const k = keys.current;
    if (!k) { setErr("Still preparing the connection — try again in a second."); return; }
    setBusy(true);
    setErr(null);
    const r = await claim(ticket, code, name.trim() || guessName(), k.pub);
    setBusy(false);
    if (!r.ok) {
      setErr(r.error);
      // A dead invitation is not a typo. Sending people back to the computer is
      // the only thing that can work, so the form goes away rather than sitting
      // there inviting a seventh attempt at a ticket that no longer exists.
      if (r.fatal) setStage("expired");
      else setCode("");
      return;
    }
    secret.current = r.secret;
    setStage("waiting");
  }, [busy, code, name, ticket]);

  // Polling, because what it is waiting for is somebody walking to a desk. Two
  // seconds is fast enough to feel immediate when they are already sitting
  // there and slow enough not to be a load on anything.
  useEffect(() => {
    if (stage !== "waiting") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const k = keys.current;
      if (!k || !live) return;
      const r = await collectOnce(ticket, secret.current, k.priv);
      if (!live) return;
      if (r.state === "accepted") { onPaired(r.token); return; }
      if (r.state === "rejected") { setStage("rejected"); return; }
      if (r.state === "unknown") { setStage("expired"); return; }
      timer = setTimeout(tick, 2000);
    };
    timer = setTimeout(tick, 700);
    return () => { live = false; clearTimeout(timer); };
  }, [stage, ticket, onPaired]);

  return (
    <div className="pair-wrap">
      <div className="pair-card">
        <div className="pair-mark" aria-hidden>🛰</div>
        <h1 className="pair-h1">Connect this device</h1>

        {stage === "checking" && <p className="pair-p">Checking the invitation…</p>}

        {stage === "form" && (
          <>
            <p className="pair-p">
              The computer is showing a six-digit code. Type it here — it is what proves you are
              standing in front of that screen.
            </p>
            <label className="pair-label" htmlFor="pair-name">Call this device</label>
            <input id="pair-name" className="pair-input" value={name} maxLength={60}
              onChange={(e) => setName(e.target.value)} placeholder="iPhone" autoComplete="off" />
            <div className="pair-hint">This is the name you will see when you want to disconnect it.</div>

            <label className="pair-label" htmlFor="pair-code">Code on the computer</label>
            <input id="pair-code" className="pair-input pair-code" value={code}
              // Numeric keypad, no autocorrect, no capitalisation: it is six
              // digits, and a phone keyboard that guesses at it is a keyboard
              // fighting the only input on the screen.
              inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6}
              placeholder="000000"
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
              onKeyDown={(e) => { if (e.key === "Enter") void send(); }} />

            {err && <div className="pair-err">{err}</div>}

            <button className="pair-go" disabled={busy || code.length !== 6} onClick={() => void send()}>
              {busy ? "Sending…" : "Ask to connect"}
            </button>
            <div className="pair-hint">
              Nothing is granted yet. Someone at the computer sees this request and has to accept it.
            </div>
          </>
        )}

        {stage === "waiting" && (
          <>
            <div className="pair-spin" aria-hidden />
            <p className="pair-p">
              <strong>Waiting for someone at the computer.</strong> The request is on screen there,
              showing this device’s name and the same code you typed. It has to be accepted before
              this phone gets access to anything.
            </p>
          </>
        )}

        {stage === "rejected" && (
          <>
            <p className="pair-p pair-bad">The request was declined at the computer.</p>
            <p className="pair-hint">Nothing was granted. If that was a mistake, start a new invitation there and scan again.</p>
          </>
        )}

        {stage === "expired" && (
          <>
            <p className="pair-p pair-bad">{err ?? "This invitation is no longer open."}</p>
            <p className="pair-hint">
              Invitations last two minutes and are good for one device. On the computer, open
              Settings ▸ Remote access and start a new one.
            </p>
          </>
        )}

        {stage === "failed" && <p className="pair-p pair-bad">{err}</p>}
      </div>
    </div>
  );
}
