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
import { useState, useSyncExternalStore } from "react";
import { settingsRequests, settingsRefusals, answerSettingsRequest, answerAllSettingsRequests, type SettingRefusal } from "../lib/settingsRequests.ts";
import { AGENT_BTN, AGENT_CARD } from "./AgentOffers.tsx";
import { HIT } from "../lib/iconSize.ts";
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

export function useSettingsRefusals(): readonly SettingRefusal[] {
  return useSyncExternalStore(settingsRefusals.subscribe, settingsRefusals.list, () => []);
}

/** What the server said when it refused an answer whose card is already gone. Stays until dismissed. */
function RefusalCard({ x }: { x: SettingRefusal }) {
  return (
    <div className="rounded-xl text-left" data-settings-refusal={x.id} role="alert" style={{ ...AGENT_CARD, padding: "12px 14px" }}>
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
  return (
    <>
      {refused.map((x) => <RefusalCard key={x.id} x={x} />)}
      {requests.length > 1 && <ApproveAll requests={requests} />}
      {requests.slice(0, max).map((r) => <RequestCard key={r.id} r={r} />)}
      {more > 0 && <div className="text-[12px] rounded-xl" style={{ ...AGENT_CARD, padding: "8px 14px", color: "var(--text3)" }}>{more} more {more === 1 ? "request waits" : "requests wait"} behind these</div>}
    </>
  );
}
