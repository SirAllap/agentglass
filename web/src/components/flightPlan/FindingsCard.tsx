import { ICON } from "../../lib/iconSize.ts";
import { INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { useState } from "react";
import { api } from "../../lib/api.ts";
import { AUTO_RUNS_MAX, bySeverity, capStop, filesWord, findingsOf, isOpen, openCount, usd, type Finding, type FindingAction, type Plan, type Run } from "../../lib/flightPlan.ts";
import { handledChip, type Pilot } from "../../lib/flightPilot.ts";
import { AskIcon, CrossIcon, EyeIcon, ScaleIcon, WrenchIcon } from "./fpIcons.tsx";

const ACTS: { k: FindingAction; label: string; css: string; Icon: typeof WrenchIcon; tip: string }[] = [
  { k: "fix", label: "Fix", css: "fix", Icon: WrenchIcon, tip: "The author fixes the plan" },
  { k: "contest", label: "Contest with evidence", css: "contest", Icon: ScaleIcon, tip: "Kept as written, with the evidence" },
  { k: "ask", label: "Ask me", css: "askme", Icon: AskIcon, tip: "Waits for your answer" },
  { k: "dismiss", label: "Dismiss", css: "dismiss", Icon: CrossIcon, tip: "Not acted on" },
];
const SEV = { blocker: ["b", "Blocker"], major: ["m", "Major"], nit: ["n", "Nit"] } as const;
/** Contest and dismiss say why; the other two need no words. */
const NEEDS_NOTE: FindingAction[] = ["contest", "dismiss"];
const NOTE_HINT: Partial<Record<FindingAction, string>> = { contest: "The evidence, in one line", dismiss: "Why it is not worth acting on, in one line" };

/** `ro`: the coordinator answers this one; it is shown, not offered. */
function FindingRow({ f, runId, onChanged, ro }: { f: Finding; runId: string; onChanged: () => void; ro?: boolean }) {
  const [noting, setNoting] = useState<FindingAction | null>(null);
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const done = f.action !== null && f.action !== "ask";
  const [sc, sw] = SEV[f.severity];

  const save = async (action: FindingAction | null, note = "") => {
    setBusy(true); setErr("");
    const r = await api.flightFinding(runId, f.id, action, note).catch(() => ({ ok: false, error: "could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "not saved"); return; }
    setNoting(null); setText(""); setAnswer("");
    onChanged();
  };
  const press = (k: FindingAction) => {
    if (f.action === k) { void save(null); return; }
    if (NEEDS_NOTE.includes(k)) { setNoting(k); setText(f.note ?? ""); return; }
    void save(k);
  };

  return (
    <div className={`f${done ? " done" : ""}`} id={`fp-${f.id}`} data-ro={ro ? "" : undefined}>
      <span className={`sev ${sc}`} aria-hidden="true">{sw[0]}</span>
      <div>
        <div className="h"><span className="sevw">{sw}</span><b>{f.title}</b></div>
        {!done && <><blockquote>{f.quote}</blockquote><div className="ev">{f.evidence}</div></>}
      </div>
      {done && f.note && <div className="resolved"><span style={{ color: "var(--text3)" }}>Answer ·</span><span>{f.note}</span></div>}
      {f.action === "ask" && !ro && (
        <>
          <div className="resolved"><span className="chip warn"><AskIcon size={ICON.xs} />Asked you</span><span>{f.note || f.title}</span></div>
          <form className="note-in" onSubmit={(e) => { e.preventDefault(); if (answer.trim()) void save("fix", answer.trim()); }}>
            <input className={INPUT} style={INPUT_STYLE} aria-label="Your answer" placeholder="Answer in one line — it goes to the author" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <button type="submit" className="btn sm primary" disabled={busy || !answer.trim()}>Answer</button>
          </form>
        </>
      )}
      {!ro && <div className="acts" role="group" aria-label={`Resolve: ${f.title}`}>
        {ACTS.map(({ k, label, css, Icon, tip }) => (
          <button key={k} type="button" className={`act ${css}`} aria-pressed={f.action === k} title={tip} disabled={busy} onClick={() => press(k)}><Icon size={13} />{label}</button>
        ))}
      </div>}
      {noting && (
        <form className="note-in" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void save(noting, text.trim()); }}>
          <input className={INPUT} style={INPUT_STYLE} autoFocus aria-label={noting === "contest" ? "Evidence" : "Reason"} placeholder={NOTE_HINT[noting]} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setNoting(null); }} />
          <button type="submit" className="btn sm" disabled={busy || !text.trim()}>Save</button>
        </form>
      )}
      {err && <div className="resolved" role="alert" style={{ color: "var(--error)" }}>{err}</div>}
    </div>
  );
}

/** What the card says before there is anything to resolve. */
function Waiting({ plan, run, preflightOn, cap, onChanged, onSettings }: {
  plan: Plan; run: Run | null; preflightOn: boolean; cap: number; onChanged: () => void; onSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [cancelled, setCancelled] = useState<string | null>(null);
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true); setErr("");
    const r = await fn().catch(() => ({ ok: false, error: "could not reach the server" }));
    setBusy(false);
    if (!r.ok) setErr(r.error ?? "not started"); else onChanged();
  };
  /* The person's own press is the go that "Ask me" waits for: request the review, then start it. */
  const runNow = async (capUsd?: number) => {
    const r = await api.flightPlanPreflight(plan.id, capUsd);
    if (r.ok && r.run?.state === "awaiting-go") return api.flightRunGo(r.run.id);
    return r;
  };
  const files = run?.input.files?.length ?? 0;
  const stop = capStop(run, cap);
  if (run?.state === "running") {
    return (
      <>
        <div className="csub">Reading {filesWord(files + plan.mockups.length + 1)}. The cap is {usd(cap)}.</div>
        <div className="skels"><div className="skel" style={{ width: "70%", marginTop: 10 }} /><div className="skel" style={{ width: "90%" }} /><div className="skel" style={{ width: "55%" }} /></div>
      </>
    );
  }
  /* Cancel only closes the note: the stopped run stays in History, and the card offers a fresh run. */
  if (stop && run && cancelled !== run.id) {
    return (
      <div style={{ padding: "0 18px 16px" }}>
        <div className="err-note" role="alert">
          <span className="sev b" aria-hidden="true">!</span>
          <div>
            <b>Preflight stopped at {stop.spent !== null ? `${usd(stop.spent)} of the ${usd(stop.cap)} cap` : `the ${usd(stop.cap)} cap`}.</b><br />
            It was reading the plan{stop.files > 0 ? ` and ${stop.files} ${stop.files === 1 ? "file" : "files"}` : ""} when it reached the cap.
            {" "}A partial review is never saved, so there are no findings yet.
            <div className="row">
              {stop.once > stop.cap && <button type="button" className="btn sm" disabled={busy} onClick={() => void act(() => runNow(stop.once))}>Run once with {usd(stop.once)}</button>}
              <button type="button" className="btn sm" onClick={onSettings}>Change the default cap</button>
              <button type="button" className="btn sm" onClick={() => setCancelled(run.id)}>Cancel</button>
            </div>
          </div>
        </div>
        {err && <div className="say bad" role="alert">{err}</div>}
      </div>
    );
  }
  if ((run?.state === "failed" && !stop) || run?.state === "declined") {
    return (
      <div style={{ padding: "0 18px 16px" }}>
        <div className="err-note" role="alert">
          <span className="sev b" aria-hidden="true">!</span>
          <div>
            <b>{run.state === "declined" ? "Preflight was declined." : "Preflight stopped."}</b><br />
            {run.error ? run.error.replace(/[.\s]*$/, ". ") : run.state === "declined" ? "It was never started. " : ""}
            <div className="row">
              <button type="button" className="btn sm" disabled={busy} onClick={() => void act(() => runNow())}>Run again</button>
            </div>
          </div>
        </div>
        {err && <div className="say bad" role="alert">{err}</div>}
      </div>
    );
  }
  if (run?.state === "awaiting-go") {
    return (
      <div className="say" style={{ paddingTop: 2 }}>
        Preflight asks for your go before it reads anything. It will spend up to {usd(cap)}.
        <div style={{ marginTop: 8 }}><button type="button" className="btn sm primary" disabled={busy} onClick={() => void act(() => api.flightRunGo(run.id))}>Start Preflight</button></div>
        {err && <div className="say bad" role="alert" style={{ padding: "6px 0 0" }}>{err}</div>}
      </div>
    );
  }
  return (
    <div className="say" style={{ paddingTop: 2 }}>
      {preflightOn
        ? <>No reviewer has read this plan yet.<div style={{ marginTop: 8 }}><button type="button" className="btn sm primary" disabled={busy || !plan.planMd.trim()} onClick={() => void act(() => runNow())}>Run Preflight</button></div></>
        : <>Preflight is off for this project, so nothing is reviewed and nothing waits. <button type="button" className="btn sm" onClick={onSettings}>Change it in Settings</button></>}
      {err && <div className="say bad" role="alert" style={{ padding: "6px 0 0" }}>{err}</div>}
    </div>
  );
}

/** What the coordinator already did with the findings, as a count that opens read-only. The four answers are the person's only after Take over. */
function Handled({ fs, run, onTakeOver, onChanged }: { fs: Finding[]; run: Run; onTakeOver: () => void; onChanged: () => void }) {
  const [shown, setShown] = useState(false);
  const mine = fs.filter((f) => !isOpen(f));
  const count = (a: FindingAction) => mine.filter((f) => f.action === a).length;
  const pending = fs.length - mine.length;
  return (
    <>
      <div className="pv-handledbar">
        <button type="button" className="pv-handled" aria-expanded={shown} aria-controls={`fp-h-${run.id}`} onClick={() => setShown((v) => !v)}>
          {fs.length ? `${handledChip({ fixed: count("fix"), contested: count("contest"), dismissed: count("dismiss") })}${pending ? ` · ${pending} open` : ""}` : "0 findings"}
        </button>
        {pending > 0 && <span>The orchestrator is answering the rest.</span>}
        <button type="button" className="btn sm" style={{ marginLeft: "auto" }} onClick={onTakeOver}>Take over this plan</button>
      </div>
      {shown && <div id={`fp-h-${run.id}`}>{fs.map((f) => <FindingRow key={`${run.id}:${f.id}:${f.action}:${f.note}`} f={f} runId={run.id} onChanged={onChanged} ro />)}</div>}
    </>
  );
}

export function FindingsCard({ plan, run, preflightOn, cap, onChanged, onSettings, now, pilot, onTakeOver }: {
  plan: Plan; run: Run | null; preflightOn: boolean; cap: number; onChanged: () => void; onSettings: () => void; now: number;
  /** Who answers the findings of this plan: Manual (or after Take over) is the person; the others, the coordinator. */
  pilot: Pilot; onTakeOver: () => void;
}) {
  const fs = findingsOf(run);
  const open = openCount(run);
  const sev = bySeverity(run);
  const ran = run?.state === "done" && !!run.certificate;
  return (
    <div className="card" id="fp-findings">
      <div className="ch">
        <span className="ci"><EyeIcon /></span><h5>Preflight findings</h5>
        {ran && (open ? <span className="chip warn"><i />{open} open</span> : fs.length ? <span className="chip ok"><i />all resolved</span> : <span className="chip ok"><i />no findings</span>)}
        {run?.state === "running" && <span className="chip space"><i />reading · {Math.max(1, Math.round((now - run.createdAt) / 1000))} s</span>}
      </div>
      {ran ? (
        <>
          <div className="csub">A reviewer that never saw the conversation read the plan and the mockup. {pilot === "manual" ? "Each finding gets one of four answers; only Fix reaches the author as work." : "The orchestrator answers every finding; open the count to read them, or take the plan over to answer them yourself."}</div>
          {fs.length > 0 && (
            <div className="fsum">
              {sev.blocker > 0 && <span className="chip err">{sev.blocker} blocker</span>}
              {sev.major > 0 && <span className="chip warn">{sev.major} major</span>}
              {sev.nit > 0 && <span className="chip off">{sev.nit} nit</span>}
            </div>
          )}
          {fs.length === 0 && <div className="say">The reviewer found nothing to report.</div>}
          {pilot !== "manual" && fs.length > 0 && <Handled fs={fs} run={run!} onTakeOver={onTakeOver} onChanged={onChanged} />}
          {pilot === "manual" && fs.map((f) => <FindingRow key={`${run!.id}:${f.id}:${f.action}:${f.note}`} f={f} runId={run!.id} onChanged={onChanged} />)}
          {plan.autoRuns >= AUTO_RUNS_MAX && <ReReview plan={plan} onChanged={onChanged} />}
        </>
      ) : <Waiting plan={plan} run={run} preflightOn={preflightOn} cap={cap} onChanged={onChanged} onSettings={onSettings} />}
    </div>
  );
}


/** The server stops re-reviewing on its own after AUTO_RUNS_MAX runs; a new review is the person's press. */
function ReReview({ plan, onChanged }: { plan: Plan; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="say" style={{ paddingTop: 2 }}>
      Re-review on request.{" "}
      <button type="button" className="btn sm" disabled={busy} onClick={async () => {
        setBusy(true);
        const r = await api.flightPlanPreflight(plan.id).catch(() => ({ ok: false as const }));
        if (r.ok && (r as { run?: { id: string; state: string } }).run?.state === "awaiting-go") await api.flightRunGo((r as { run: { id: string } }).run.id);
        setBusy(false); onChanged();
      }}>Run Preflight</button>
    </div>
  );
}
