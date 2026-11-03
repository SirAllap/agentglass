/*
 * The window an agent's request opens: what changes in plain words, before and
 * after, how much it needs a second look, and an answer that cannot happen by
 * accident. Approve and Decline answer on a one-second hold, never on a click or
 * a key tap; a high-risk change also needs the tick first.
 *
 * Every word that names something is the server's: who asked, the label, and the
 * diff it computed from the value it validated (server/src/settingsDoor.ts). The
 * risk, the plain-English line and what it lets the agent do come from
 * lib/approveCard.ts, keyed by setting; a setting with no row shows the change
 * and says nothing it cannot know.
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKey, type PointerEvent as ReactPointer } from "react";
import type { SettingRequestView } from "../../../shared/settingClass.ts";
import { isPolarisAsk } from "../../../shared/settingClass.ts";
import { approveReady, approveRow, changesOf, lineDiff, RISK_LABEL, riskOfChanges, timeLeft } from "../lib/approveCard.ts";
import { createHold, holdKey, HOLD_MS, type Hold } from "../lib/holdToAnswer.ts";
import { EyeIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { SlidersIcon } from "./settingsNavIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import "./approveCard.css";

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const RISK_ICON = { low: EyeIcon, medium: SlidersIcon, high: WarningIcon } as const;

export function ApproveCard({ r, busy, error, onAnswer }: {
  r: SettingRequestView;
  busy: boolean;
  error: string | null;
  onAnswer: (approve: boolean) => void;
}) {
  const [acked, setAcked] = useState(false);
  const [open, setOpen] = useState<readonly number[]>([]);
  const [holding, setHolding] = useState<"approve" | "decline" | null>(null);

  // The hold lives across renders; the answer it calls is this render's.
  const answer = useRef(onAnswer);
  useEffect(() => { answer.current = onAnswer; }, [onAnswer]);
  const [holds] = useState<{ approve: Hold; decline: Hold }>(() => ({
    approve: createHold({ onAnswer: () => answer.current(true), onChange: (h) => setHolding(h ? "approve" : null) }),
    decline: createHold({ onAnswer: () => answer.current(false), onChange: (h) => setHolding(h ? "decline" : null) }),
  }));

  const row = approveRow(r.setting);
  const { changes, notes } = changesOf(r.diff);
  const risk = riskOfChanges(r.setting, changes);
  const title = row?.title ?? (isPolarisAsk(r) ? r.label : r.setting);
  const Icon = RISK_ICON[risk];
  const ok = approveReady(risk, acked, busy);
  const left = timeLeft(r, Date.now());

  const holdProps = (which: "approve" | "decline") => {
    const hold = holds[which];
    return {
      onPointerDown: (e: ReactPointer) => { if (e.button === 0) hold.press(); },
      onPointerUp: () => hold.release(),
      onPointerLeave: () => hold.release(),
      onPointerCancel: () => hold.release(),
      onBlur: () => hold.release(),
      onKeyDown: (e: ReactKey) => {
        const a = holdKey(e.key, "down", e.repeat);
        if (!a) return;
        e.preventDefault();
        if (a === "press") hold.press(); else hold.release();
      },
      onKeyUp: (e: ReactKey) => { if (holdKey(e.key, "up")) hold.release(); },
      "data-go": holding === which ? "" : undefined,
    };
  };

  return (
    <div className="agx-ac" data-settings-request={r.setting} role="alertdialog" aria-label={`${r.who} asks to change ${r.label}`}>
      <div className="agx-ac-band" data-risk={risk} />
      <div className="agx-ac-head">
        <span className="agx-ac-tile" data-risk={risk}><Icon size={ICON.lg} /></span>
        <div className="agx-ac-what">
          <div className="agx-ac-who">
            Asked by <b>{r.who}</b>{r.root ? <> · project <b>{r.root}</b></> : null} · {clock(r.at)}
          </div>
          <div className="agx-ac-title">{title}</div>
        </div>
        <span className="agx-ac-badge" data-risk={risk}>{RISK_LABEL[risk]}</span>
      </div>
      {row && <div className="agx-ac-short"><b>In short.</b> {row.short}</div>}
      <div className="agx-ac-body">
        <div className="agx-ac-sec">{changes.length === 1 ? "Change" : `${changes.length} changes`}</div>
        <div className="agx-ac-chg">
          {changes.map((c, i) => (
            <div key={`${c.name}:${i}`} className="agx-ac-row">
              <div className="agx-ac-rk"><b>{changes.length === 1 && c.name === "value" ? (row?.title ?? r.label) : c.name}</b></div>
              <div className="agx-ac-ba">
                <div className={c.long ? "agx-ac-v old clamp" : "agx-ac-v old"}>{c.before}</div>
                <div className="agx-ac-ar">→</div>
                <div className={c.long ? "agx-ac-v new clamp" : "agx-ac-v new"}>{c.after}</div>
              </div>
              {c.long && (
                <button type="button" className="agx-ac-link"
                  onClick={() => setOpen(open.includes(i) ? open.filter((x) => x !== i) : [...open, i])}>
                  {open.includes(i) ? "Hide" : "Show full"}
                </button>
              )}
              {c.long && open.includes(i) && (
                <div className="agx-ac-full">
                  {lineDiff(c.before, c.after).map((l, k) => <span key={k} className={l.kind}>{l.text}</span>)}
                </div>
              )}
            </div>
          ))}
          {notes.map((n, i) => <div key={`note:${i}`} className="agx-ac-note">{n}</div>)}
        </div>
        {row && (
          <>
            <div className="agx-ac-sec">This lets the agent</div>
            <ul className="agx-ac-allow">{row.allows.map((a) => <li key={a}>{a}</li>)}</ul>
          </>
        )}
        {risk === "high" && (
          <label className="agx-ac-ack">
            <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} data-ack="" />
            <span>I understand this gives an agent more power on this machine.</span>
          </label>
        )}
        {error && <div className="agx-ac-error" role="alert">{error}</div>}
      </div>
      <div className="agx-ac-foot">
        <div className="agx-ac-bar" role="img" aria-label="Time left to answer"
          style={{ "--from": `${left.fraction * 100}%`, "--left": `${Math.max(0, r.expires - Date.now())}ms` } as CSSProperties}>
          <i />
        </div>
        <div className="agx-ac-act">
          <button type="button" className="agx-ac-btn primary agx-ac-hold" disabled={!ok} data-answer="approve" {...holdProps("approve")}>
            <i className="agx-ac-fill" style={{ transitionDuration: `${HOLD_MS}ms` }} />
            <span className="agx-ac-t">Approve</span>
          </button>
          <button type="button" className="agx-ac-btn agx-ac-hold" disabled={busy} data-answer="decline" {...holdProps("decline")}>
            <i className="agx-ac-fill" style={{ transitionDuration: `${HOLD_MS}ms` }} />
            <span className="agx-ac-t">Decline</span>
          </button>
          <div className="agx-ac-sub">No answer in <b>{left.minutes} min</b> = declined</div>
        </div>
        <div className="agx-ac-hint">
          Hold a button for 1 second to answer. A click or a key tap alone does nothing
          {risk === "high" && !acked ? "; tick the box first" : ""}.
        </div>
      </div>
    </div>
  );
}
