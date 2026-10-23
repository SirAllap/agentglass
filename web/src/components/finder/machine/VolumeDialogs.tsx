// The two dialogs a device asks for: the passphrase of a locked volume, and
// what went wrong. Strata's wording (browser/location.rs, window.rs).
//
// The passphrase lives in this component's state and nowhere else: not in a
// ref a parent holds, not in storage, not in the URL, not in a log line. It is
// handed to `onSubmit` once and the field is emptied the same moment, so a
// refused attempt starts blank, as Strata's does.
import { useEffect, useRef, useState } from "react";
import { HIT } from "../../../lib/iconSize.ts";
import { WRONG_PASSPHRASE } from "../../../lib/finderVolumes.ts";
import { EDGE, INPUT, INPUT_STYLE } from "../../workspace/Chrome.tsx";
import type { RemoteStep } from "../../../../../shared/types.ts";
import { StrataIcon } from "./StrataIcon.tsx";

const SCRIM = { background: "color-mix(in srgb, var(--bg) 70%, transparent)", zIndex: 9 } as const;
const CARD = { background: "var(--surface-card)", border: EDGE, width: 400, maxWidth: "100%" } as const;

export function PassphraseDialog({ name, wrong, busy, onSubmit, onCancel }: { name: string; wrong: boolean; busy: boolean; onSubmit: (passphrase: string) => void; onCancel: () => void }) {
  const [pass, setPass] = useState("");
  const [peek, setPeek] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (wrong) { setPass(""); field.current?.focus(); } }, [wrong]);
  const submit = () => { if (!pass || busy) return; const p = pass; setPass(""); onSubmit(p); };
  return (
    <div role="dialog" aria-modal="true" aria-label="Passphrase required" className="absolute inset-0 grid place-items-center p-4" style={SCRIM}
      onClick={onCancel} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onCancel(); }}>
      <div className="rounded-xl p-4 text-[12px]" style={CARD} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <StrataIcon set="act" name="key" />
          <b className="flex-1 text-[13px]">Passphrase required</b>
          <button type="button" aria-label="Close" className="agx-btn rounded-md flex items-center justify-center" style={{ width: HIT, height: HIT }} onClick={onCancel}><StrataIcon set="act" name="x" /></button>
        </div>
        <p className="m-0 mb-3" style={{ color: "var(--text3)" }}>Authenticate to access this volume or location</p>
        <p className="m-0 mb-1">Enter a passphrase to unlock the volume</p>
        <p className="m-0 mb-3" style={{ color: "var(--text3)" }}>The passphrase is needed to access encrypted data on {name}.</p>
        {wrong && <p role="alert" className="m-0 mb-3" style={{ color: "var(--warning-ink)" }}>{WRONG_PASSPHRASE}</p>}
        <label className="block mb-1" style={{ color: "var(--text3)" }} htmlFor="finder-passphrase">Passphrase</label>
        <div className="flex items-center gap-1 mb-3">
          <input id="finder-passphrase" ref={field} autoFocus type={peek ? "text" : "password"} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" spellCheck={false} data-1p-ignore
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }} className={`${INPUT} flex-1 min-w-0`} style={INPUT_STYLE} />
          <button type="button" aria-label={peek ? "Hide passphrase" : "Show passphrase"} aria-pressed={peek} className="agx-btn rounded-md flex items-center justify-center" style={{ width: HIT, height: HIT, border: EDGE }} onClick={() => setPeek((v) => !v)}>
            <StrataIcon set="act" name={peek ? "eye-off" : "eye"} />
          </button>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={onCancel}>Cancel</button>
          <button type="button" disabled={!pass || busy} className="agx-btn rounded-md px-3" style={{ minHeight: HIT, background: "var(--text)", color: "var(--bg)", opacity: !pass || busy ? 0.5 : 1 }} onClick={submit}>Connect</button>
        </div>
      </div>
    </div>
  );
}

export function ErrorDialog({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  return (
    <div role="alertdialog" aria-modal="true" aria-label={title} className="absolute inset-0 grid place-items-center p-4" style={SCRIM}
      onClick={onClose} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape" || e.key === "Enter") onClose(); }}>
      <div className="rounded-xl p-4 text-[12px]" style={CARD} onClick={(e) => e.stopPropagation()}>
        <b className="block text-[13px] mb-1">{title}</b>
        <p className="m-0 mb-3" style={{ color: "var(--text3)" }}>{message}</p>
        <div className="flex justify-end"><button type="button" autoFocus className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/** The Network row: what gio finds on the network, and an address to type. An empty list is said, not hidden; a missing backend is Strata's sentence. */
export function NetworkDialog({ entries, error, onPick, onClose }: { entries: { name: string; uri: string }[]; error?: string; onPick: (uri: string) => void; onClose: () => void }) {
  const [addr, setAddr] = useState("");
  return (
    <div role="dialog" aria-modal="true" aria-label="Network" className="absolute inset-0 grid place-items-center p-4" style={SCRIM}
      onClick={onClose} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onClose(); }}>
      <div className="rounded-xl p-4 text-[12px] flex flex-col min-h-0 max-h-full" style={CARD} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-2"><StrataIcon set="act" name="network" /><b className="flex-1 text-[13px]">Network</b>
          <button type="button" aria-label="Close" className="agx-btn rounded-md flex items-center justify-center" style={{ width: HIT, height: HIT }} onClick={onClose}><StrataIcon set="act" name="x" /></button></div>
        <div className="agx-scroll overflow-y-auto min-h-0 mb-3">
          {error ? <p role="alert" className="m-0" style={{ color: "var(--text3)" }}>{error}</p>
            : entries.length === 0 ? <p className="m-0" style={{ color: "var(--text3)" }}>No servers found on the network</p>
            : entries.map((e) => (
              <button key={e.uri} type="button" className="agx-btn w-full flex items-center gap-2 px-2.5 rounded-md text-left" style={{ minHeight: 26 }} onClick={() => onPick(e.uri)}>
                <StrataIcon set="act" name="network" /><span className="truncate">{e.name}</span>
              </button>))}
        </div>
        <label className="block mb-1" style={{ color: "var(--text3)" }} htmlFor="finder-server">Server address</label>
        <div className="flex gap-2">
          <input id="finder-server" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="smb://host/share or sftp://host/" spellCheck={false} autoComplete="off"
            onKeyDown={(e) => { if (e.key === "Enter" && addr.trim()) onPick(addr.trim()); }} className={`${INPUT} flex-1 min-w-0`} style={INPUT_STYLE} />
          <button type="button" disabled={!addr.trim()} className="agx-btn rounded-md px-3" style={{ minHeight: HIT, background: "var(--text)", color: "var(--bg)", opacity: addr.trim() ? 1 : 0.5 }} onClick={() => onPick(addr.trim())}>Connect</button>
        </div>
      </div>
    </div>
  );
}

/** One step of a connection. Credentials live in this component's state until Connect, then are handed over and emptied; a host key shows gio's own message, fingerprint and all, and offers only gio's own choices. */
export function ConnectDialog({ step, busy, onAnswer, onCancel }: { step: Extract<RemoteStep, { state: "password" | "question" }>; busy: boolean; onAnswer: (a: { answers?: Record<string, string>; choice?: number }) => void; onCancel: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(step.state === "password" ? { ...step.defaults } : {});
  const [peek, setPeek] = useState(false);
  const send = () => { if (busy) return; const answers = vals; setVals({}); onAnswer({ answers }); };
  const q = step.state === "question";
  return (
    <div role="dialog" aria-modal="true" aria-label={q ? "Verify the server" : "Authentication required"} className="absolute inset-0 grid place-items-center p-4" style={SCRIM}
      onClick={onCancel} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onCancel(); }}>
      <div className="rounded-xl p-4 text-[12px]" style={CARD} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1"><StrataIcon set="act" name="key" /><b className="flex-1 text-[13px]">{q ? "Verify the server" : "Authentication required"}</b></div>
        <p className="m-0 mb-3 whitespace-pre-wrap break-words" style={{ color: "var(--text3)" }}>{step.message}</p>
        {step.state === "password" && step.fields.map((f, i) => (
          <div key={f} className="mb-2">
            <label className="block mb-1" style={{ color: "var(--text3)" }} htmlFor={`finder-cred-${f}`}>{f === "Password" ? "Password" : f}</label>
            <div className="flex items-center gap-1">
              <input id={`finder-cred-${f}`} autoFocus={i === 0} type={f === "Password" && !peek ? "password" : "text"} value={vals[f] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [f]: e.target.value }))} autoComplete="off" spellCheck={false} data-1p-ignore
                onKeyDown={(e) => { if (e.key === "Enter") send(); }} className={`${INPUT} flex-1 min-w-0`} style={INPUT_STYLE} />
              {f === "Password" && <button type="button" aria-label={peek ? "Hide password" : "Show password"} aria-pressed={peek} className="agx-btn rounded-md flex items-center justify-center" style={{ width: HIT, height: HIT, border: EDGE }} onClick={() => setPeek((v) => !v)}><StrataIcon set="act" name={peek ? "eye-off" : "eye"} /></button>}
            </div>
          </div>))}
        <div className="flex justify-end gap-2 mt-3">
          {!q && <button type="button" className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={onCancel}>Cancel</button>}
          {step.state === "question"
            ? step.choices.map((c, i) => <button key={c} type="button" autoFocus={i === step.choices.length - 1} disabled={busy} className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={() => onAnswer({ choice: i + 1 })}>{c}</button>)
            : <button type="button" disabled={busy} className="agx-btn rounded-md px-3" style={{ minHeight: HIT, background: "var(--text)", color: "var(--bg)" }} onClick={send}>Connect</button>}
        </div>
      </div>
    </div>
  );
}
