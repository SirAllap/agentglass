/*
 * "An agent asks to change a setting": the person's answer, Approve or Decline,
 * each held for a second so a click or a key tap cannot answer by accident.
 *
 * Drawn in the corner every agent chip shares (AgentChangeChip.tsx), as the
 * approve card (ApproveCard.tsx). Every word that names something is the
 * server's: who asked as the server knows them, the setting's label, and the
 * diff it computed from the value it validated (server/src/settingsDoor.ts).
 * Approve applies that diff and grants nothing for next time. A request nobody
 * answers is declined when it expires, and the card goes when the server says so.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { settingsRequests, settingsRefusals, answerSettingsRequest, answerAllSettingsRequests, liveRefusals, REFUSAL_MS, type SettingRefusal } from "../lib/settingsRequests.ts";
import { AGENT_BTN, AGENT_CARD } from "./AgentOffers.tsx";
import { HIT } from "../lib/iconSize.ts";
import { CloseButton } from "./CloseButton.tsx";
import { cleanupCardView } from "../lib/cleanupCard.ts";
import { CleanupAskCard } from "./CleanupAskCard.tsx";
import { ApproveCard } from "./ApproveCard.tsx";
import { isPolarisSend, type SettingRequestView } from "../../../shared/settingClass.ts";

function RequestCard({ r }: { r: SettingRequestView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (approve: boolean) => {
    setBusy(true);
    setError(await answerSettingsRequest(r.id, approve, { who: r.who, title: r.diff[0] ?? r.setting }));
    setBusy(false);
  };
  const ask = cleanupCardView(r, Date.now());
  if (ask) return <CleanupAskCard corner r={r} view={ask} busy={busy} error={error} onAnswer={(a) => void answer(a)} />;
  return <ApproveCard r={r} busy={busy} error={error} onAnswer={(a) => void answer(a)} />;
}

/** The refusals still inside their REFUSAL_MS, re-read when the oldest one runs out. */
export function useSettingsRefusals(): readonly SettingRefusal[] {
  const all = useSyncExternalStore(settingsRefusals.subscribe, settingsRefusals.list, () => []);
  const [now, setNow] = useState(() => Date.now());
  const next = all.length ? Math.min(...all.map((x) => x.at + REFUSAL_MS)) : 0;
  useEffect(() => {
    if (!next) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [all, next]);
  return liveRefusals(all, now);
}

/** What the server said when it refused an answer whose card is already gone. Leaves by
 *  itself (REFUSAL_MS), and a cross, because a card nobody can close is how it was found. */
function RefusalCard({ x }: { x: SettingRefusal }) {
  return (
    <div className="relative rounded-xl text-left" data-settings-refusal={x.id} role="alert" style={AGENT_CARD}>
      <CloseButton onClick={() => settingsRefusals.dismiss(x.id)} title="Dismiss" hit={22} style={{ top: 6, right: 7, color: "var(--text4)" }} className="absolute rounded" />
      <div className="text-[13.5px] font-semibold" style={{ color: "var(--error-ink)" }}>{x.approve ? "Not applied" : "Not declined"}</div>
      {x.title && <div className="text-[12px] mt-1" style={{ color: "var(--text2)", overflowWrap: "anywhere" }}>{x.who ? `${x.who}: ` : ""}{x.title}</div>}
      <div className="text-[12px] mt-1" style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{x.error}</div>
      <button onClick={() => settingsRefusals.dismiss(x.id)} className="agx-btn text-[12px] mt-2 px-2.5 rounded-lg" style={{ minHeight: HIT, color: "var(--text2)" }}>Dismiss</button>
    </div>
  );
}

export function useSettingsRequests(): readonly SettingRequestView[] {
  return useSyncExternalStore(settingsRequests.subscribe, settingsRequests.list, () => []);
}

/** Every waiting request in one click: twenty cards already climb off the screen, so
 *  answering them one by one is the same errand repeated. */
function ApproveAll({ requests: all }: { requests: readonly SettingRequestView[] }) {
  const [busy, setBusy] = useState(false);
  // A send types into a live session: it is approved on its own card, never here.
  const requests = all.filter((r) => !isPolarisSend(r));
  if (requests.length < 2) return null;
  return (
    <div className="rounded-xl flex items-center gap-2" style={{ ...AGENT_CARD, padding: "8px 10px" }}>
      <span className="text-[12px] min-w-0" style={{ color: "var(--text2)" }}>
        {requests.length} requests wait: {requests.map((r) => r.label).join(", ")}
      </span>
      <button
        disabled={busy}
        onClick={() => { setBusy(true); void answerAllSettingsRequests(requests).then(() => setBusy(false)); }}
        className="agx-btn text-[12px] px-2.5 rounded-lg font-medium ml-auto" style={AGENT_BTN}
      >Approve all ({requests.length})</button>
    </div>
  );
}

/** The oldest few, and a line for the rest: twenty cards would climb off the screen.
 *  Answering one brings the next up. */
export function SettingsRequestsList({ requests, max }: { requests: readonly SettingRequestView[]; max: number }) {
  const more = requests.length - max;
  const refused = useSettingsRefusals();
  // Esc is the way out that does not ask the person to find a small button under a pile.
  useEffect(() => {
    if (!refused.length) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") for (const x of refused) settingsRefusals.dismiss(x.id); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refused]);
  return (
    <>
      {requests.length > 1 && <ApproveAll requests={requests} />}
      {requests.slice(0, max).map((r) => <RequestCard key={r.id} r={r} />)}
      {more > 0 && <div className="text-[12px] rounded-xl" style={{ ...AGENT_CARD, padding: "8px 14px", color: "var(--text3)" }}>{more} more {more === 1 ? "request waits" : "requests wait"} behind these</div>}
      {/* Nearest the corner, below the waiting cards: a refusal is news about an ask that is
          already over, and drawn first it was pushed off the top of the window by tall cards. */}
      {refused.map((x) => <RefusalCard key={x.id} x={x} />)}
    </>
  );
}
